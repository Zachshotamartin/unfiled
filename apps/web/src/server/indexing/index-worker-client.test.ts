import { describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/server/api/errors";

import {
  createEnvironmentIndexWorkerClient,
  createIndexWorkerClient,
  IndexWorkerInvocationError
} from "./index-worker-client";

const TOKEN = `${"a".repeat(48)}.${"b".repeat(48)}.${"c".repeat(48)}`;
const ORIGIN = "https://unfiled-worker.vercel.app";

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers
  });
}

function success() {
  return { claimed: 1, completed: 1, failed: 0, retryScheduled: 0 };
}

describe("encrypted index worker caller", () => {
  it("forwards only the content-free command and short-lived trusted-source token", async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(json(success())));
    const getOidcToken = vi.fn().mockResolvedValue(TOKEN);
    const client = createIndexWorkerClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });

    await expect(client.drain("schedule")).resolves.toEqual(success());
    expect(getOidcToken).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${ORIGIN}/internal/drain`);
    expect(init).toMatchObject({
      body: '{"trigger":"schedule"}',
      headers: {
        "content-type": "application/json",
        "x-unfiled-trusted-oidc-idp-token": TOKEN
      },
      method: "POST",
      redirect: "error"
    });
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      "content-type",
      "x-unfiled-trusted-oidc-idp-token"
    ]);
    expect(typeof init.body).toBe("string");
    expect(init.body as string).not.toContain("owner");
  });

  it("requires an unambiguous HTTPS Vercel origin", () => {
    for (const origin of [
      "http://unfiled-worker.vercel.app",
      "https://user:password@unfiled-worker.vercel.app",
      "https://unfiled-worker.vercel.app/path",
      "https://unfiled-worker.vercel.app?token=x",
      "https://unfiled-worker.vercel.app#fragment",
      "https://vercel.app",
      "https://example.com",
      "not-a-url"
    ]) {
      expect(() => createIndexWorkerClient({ origin })).toThrow(ConfigurationError);
    }
  });

  it("requires the exact egress origin in a matching managed-cloud runtime", async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(json(success())));
    const client = createEnvironmentIndexWorkerClient(
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        UNFILED_WORKER_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      { fetchImplementation: request, getOidcToken: () => Promise.resolve(TOKEN) }
    );
    await expect(client.drain("recovery")).resolves.toEqual(success());
    const previewClient = createEnvironmentIndexWorkerClient(
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        UNFILED_WORKER_ENV: "preview",
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      { fetchImplementation: request, getOidcToken: () => Promise.resolve(TOKEN) }
    );
    await expect(previewClient.drain("recovery")).resolves.toEqual(success());

    for (const environment of [
      {},
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        UNFILED_WORKER_ENV: "production",
        VERCEL: "0",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        UNFILED_WORKER_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        UNFILED_WORKER_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "invalid"
      }
    ]) {
      expect(() => createEnvironmentIndexWorkerClient(environment)).toThrow(ConfigurationError);
    }
  });

  it("does not pretend an unverified target project ID can bind a Vercel alias", async () => {
    const request = vi.fn().mockResolvedValue(json(success()));
    const client = createEnvironmentIndexWorkerClient(
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        // Legacy or ambient target-ID assertions are deliberately ignored. Vercel
        // exposes alias ownership only through its authenticated management plane,
        // so the reviewed exact origin is the runtime egress trust boundary.
        UNFILED_INDEX_WORKER_PROJECT_ID: "prj_unverifiedlegacyvalue",
        UNFILED_WORKER_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      { fetchImplementation: request, getOidcToken: () => Promise.resolve(TOKEN) }
    );

    await expect(client.drain("schedule")).resolves.toEqual(success());
    expect(request).toHaveBeenCalledOnce();
    expect((request.mock.calls[0] as [URL])[0].origin).toBe(ORIGIN);
  });

  it("rejects invalid tokens, responses, counts, and redirects without exposing bodies", async () => {
    const cases: readonly Readonly<{
      response?: Response;
      token?: string;
    }>[] = [
      { token: "not-a-jwt" },
      { response: json({ ...success(), extra: "private-canary" }) },
      { response: json({ claimed: 0, completed: 1, failed: 0, retryScheduled: 0 }) },
      { response: new Response("private-canary", { status: 503 }) },
      {
        response: new Response("x".repeat(4_097), {
          headers: { "content-type": "application/json" }
        })
      },
      { response: new Response("{}", { headers: { "content-type": "text/plain" } }) }
    ];
    for (const testCase of cases) {
      const client = createIndexWorkerClient({
        fetchImplementation: vi.fn().mockResolvedValue(testCase.response ?? json(success())),
        getOidcToken: () => Promise.resolve(testCase.token ?? TOKEN),
        origin: ORIGIN
      });
      const reason = await client.drain("manual").catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(IndexWorkerInvocationError);
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
    const client = createIndexWorkerClient({
      fetchImplementation: vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { "content-type": "application/json" }
        })
      ),
      getOidcToken: () => Promise.resolve(TOKEN),
      origin: ORIGIN
    });

    const reason = await client.drain("manual").catch((error: unknown) => error);
    expect(reason).toBeInstanceOf(IndexWorkerInvocationError);
    expect(String(reason)).not.toContain("private-canary");
  });

  it("honors pre-aborted requests without minting or sending a token", async () => {
    const controller = new AbortController();
    controller.abort();
    const getOidcToken = vi.fn();
    const request = vi.fn();
    const client = createIndexWorkerClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });

    await expect(client.drain("schedule", controller.signal)).rejects.toBeInstanceOf(
      IndexWorkerInvocationError
    );
    expect(getOidcToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("applies the caller timeout while a token provider remains pending", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const getOidcToken = vi.fn(() => new Promise<string>(() => undefined));
      const request = vi.fn();
      const client = createIndexWorkerClient({
        fetchImplementation: request,
        getOidcToken,
        origin: ORIGIN
      });
      let outcome: "pending" | "rejected" | "resolved" = "pending";
      const drain = client.drain("schedule").then(
        (value) => {
          outcome = "resolved";
          return value;
        },
        (error: unknown) => {
          outcome = "rejected";
          throw error;
        }
      );
      const rejection = expect(drain).rejects.toBeInstanceOf(IndexWorkerInvocationError);

      await vi.advanceTimersByTimeAsync(49_999);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);

      await rejection;
      expect(outcome).toBe("rejected");
      expect(timeout).toHaveBeenCalledWith(50_000);
      expect(getOidcToken).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("honors an external abort during token acquisition and handles a late token rejection", async () => {
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
      const client = createIndexWorkerClient({
        fetchImplementation: request,
        getOidcToken,
        origin: ORIGIN
      });
      const drain = client.drain("recovery", controller.signal);
      const rejection = expect(drain).rejects.toBeInstanceOf(IndexWorkerInvocationError);

      setTimeout(() => controller.abort(), 250);
      await vi.advanceTimersByTimeAsync(249);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await rejection;
      expect(timeout).toHaveBeenCalledWith(50_000);
      expect(getOidcToken).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
      rejectToken?.(new Error("late-private-token-error"));
      vi.runAllTicks();
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
