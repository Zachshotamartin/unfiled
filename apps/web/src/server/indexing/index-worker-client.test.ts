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
    const request = vi.fn().mockResolvedValue(json(success()));
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
        "x-vercel-trusted-oidc-idp-token": TOKEN
      },
      method: "POST",
      redirect: "error"
    });
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      "content-type",
      "x-vercel-trusted-oidc-idp-token"
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

  it("requires the exact egress origin in a Vercel production runtime", async () => {
    const request = vi.fn().mockResolvedValue(json(success()));
    const client = createEnvironmentIndexWorkerClient(
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      { fetchImplementation: request, getOidcToken: () => Promise.resolve(TOKEN) }
    );
    await expect(client.drain("recovery")).resolves.toEqual(success());

    for (const environment of [
      {},
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        VERCEL: "0",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
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
});
