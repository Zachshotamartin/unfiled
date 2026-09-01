import { describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/server/api/errors";

import {
  createEnvironmentOrganizerClient,
  createOrganizerClient,
  OrganizerInvocationError
} from "./organizer-client";

const TOKEN = `${"a".repeat(48)}.${"b".repeat(48)}.${"c".repeat(48)}`;
const ORIGIN = "https://unfiled-organizer.vercel.app";

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function success() {
  return { claimed: 1, completed: 1, failed: 0, retryScheduled: 0 };
}

describe("isolated encrypted organizer caller", () => {
  it("forwards only a content-free command and the short-lived trusted-source token", async () => {
    const request = vi.fn().mockResolvedValue(json(success()));
    const getOidcToken = vi.fn().mockResolvedValue(TOKEN);
    const client = createOrganizerClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });

    await expect(client.drain("schedule")).resolves.toEqual(success());
    const [url, init] = request.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${ORIGIN}/internal/drain`);
    expect(init).toMatchObject({
      body: '{"trigger":"schedule"}',
      headers: {
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": TOKEN
      },
      method: "POST",
      redirect: "error"
    });
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      "content-type",
      "x-vercel-trusted-oidc-idp-token"
    ]);
    expect(init.body as string).not.toContain("owner");
    expect(getOidcToken).toHaveBeenCalledOnce();
  });

  it("requires an exact HTTPS Vercel origin and bounded timeout", () => {
    for (const origin of [
      "http://unfiled-organizer.vercel.app",
      "https://user:password@unfiled-organizer.vercel.app",
      "https://unfiled-organizer.vercel.app/path",
      "https://unfiled-organizer.vercel.app?token=x",
      "https://unfiled-organizer.vercel.app#fragment",
      "https://vercel.app",
      "https://example.com",
      "not-a-url"
    ]) {
      expect(() => createOrganizerClient({ origin })).toThrow(ConfigurationError);
    }
    expect(() => createOrganizerClient({ origin: ORIGIN, timeoutMs: 55_001 })).toThrow(
      ConfigurationError
    );
  });

  it("requires the production web runtime and exact organizer egress origin", async () => {
    const request = vi.fn().mockResolvedValue(json(success()));
    const dependencies = {
      fetchImplementation: request,
      getOidcToken: () => Promise.resolve(TOKEN)
    };
    const client = createEnvironmentOrganizerClient(
      {
        UNFILED_ORGANIZER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      dependencies
    );
    await expect(client.drain("recovery")).resolves.toEqual(success());

    for (const environment of [
      {},
      {
        UNFILED_ORGANIZER_ORIGIN: ORIGIN,
        VERCEL: "0",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_ORGANIZER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_ORGANIZER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "invalid"
      }
    ]) {
      expect(() => createEnvironmentOrganizerClient(environment)).toThrow(ConfigurationError);
    }
  });

  it("rejects malformed tokens, responses, counts, oversized bodies, and redirects", async () => {
    const cases: readonly Readonly<{ response?: Response; token?: string }>[] = [
      { token: "not-a-jwt" },
      { response: json({ ...success(), extra: "private-canary" }) },
      { response: json({ claimed: 0, completed: 1, failed: 0, retryScheduled: 0 }) },
      { response: json({ claimed: 5, completed: 0, failed: 0, retryScheduled: 0 }) },
      { response: new Response("private-canary", { status: 503 }) },
      {
        response: new Response("x".repeat(4_097), {
          headers: { "content-type": "application/json" }
        })
      },
      { response: new Response("{}", { headers: { "content-type": "text/plain" } }) }
    ];
    for (const testCase of cases) {
      const client = createOrganizerClient({
        fetchImplementation: vi.fn().mockResolvedValue(testCase.response ?? json(success())),
        getOidcToken: () => Promise.resolve(testCase.token ?? TOKEN),
        origin: ORIGIN
      });
      const reason = await client.drain("manual").catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(OrganizerInvocationError);
      expect(String(reason)).not.toContain("private-canary");
    }
  });

  it("redacts mid-body stream failures", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"claimed":'));
        controller.error(new TypeError("private-canary-stream-failure"));
      }
    });
    const client = createOrganizerClient({
      fetchImplementation: vi
        .fn()
        .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } })),
      getOidcToken: () => Promise.resolve(TOKEN),
      origin: ORIGIN
    });

    const reason = await client.drain("manual").catch((error: unknown) => error);
    expect(reason).toBeInstanceOf(OrganizerInvocationError);
    expect(String(reason)).not.toContain("private-canary");
  });

  it("does not mint or send a token for a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const getOidcToken = vi.fn();
    const request = vi.fn();
    const client = createOrganizerClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });

    await expect(client.drain("schedule", controller.signal)).rejects.toBeInstanceOf(
      OrganizerInvocationError
    );
    expect(getOidcToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds token acquisition and consumes a late rejection after external abort", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const controller = new AbortController();
      let rejectToken: ((error: Error) => void) | undefined;
      const getOidcToken = vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectToken = reject;
          })
      );
      const request = vi.fn();
      const client = createOrganizerClient({
        fetchImplementation: request,
        getOidcToken,
        origin: ORIGIN
      });
      const drain = client.drain("schedule", controller.signal);
      const rejection = expect(drain).rejects.toBeInstanceOf(OrganizerInvocationError);

      setTimeout(() => controller.abort(), 250);
      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(timeout).toHaveBeenCalledWith(54_000);
      expect(request).not.toHaveBeenCalled();
      rejectToken?.(new Error("late-private-token-error"));
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
