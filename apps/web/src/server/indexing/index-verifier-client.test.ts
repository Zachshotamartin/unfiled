import { describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/server/api/errors";

import {
  createEnvironmentIndexVerifierClient,
  createIndexVerifierClient,
  INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS,
  INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS,
  INDEX_VERIFIER_CLIENT_MIN_TIMEOUT_MS,
  INDEX_VERIFIER_SERVER_TIMEOUT_MS,
  IndexVerifierGenerationInvalidError,
  IndexVerifierInvocationError,
  type IndexVerificationTarget
} from "./index-verifier-client";

const TOKEN = `${"a".repeat(48)}.${"b".repeat(48)}.${"c".repeat(48)}`;
const ORIGIN = "https://unfiled-verifier.vercel.app";
const ERROR_REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const TARGET: IndexVerificationTarget = Object.freeze({
  ownerId: "a1111111-b111-4111-8111-111111111111",
  generationId: "igen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  revisionToken: "9223372036854775807"
});

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function success(target: IndexVerificationTarget = TARGET) {
  return {
    generationId: target.generationId,
    revisionToken: target.revisionToken,
    verifiedNoteCount: 7,
    verified: true
  };
}

describe("encrypted index verifier caller", () => {
  it("sends only the exact target and short-lived trusted-source token", async () => {
    const request = vi.fn().mockResolvedValue(json(success()));
    const getOidcToken = vi.fn().mockResolvedValue(TOKEN);
    const client = createIndexVerifierClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });

    await expect(client.verify(TARGET)).resolves.toEqual(success());
    expect(getOidcToken).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${ORIGIN}/internal/verify`);
    expect(init).toMatchObject({
      body: JSON.stringify(TARGET),
      cache: "no-store",
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
  });

  it("requires exact target identifiers and canonical int64 revision tokens", async () => {
    const request = vi.fn().mockResolvedValue(json(success()));
    const getOidcToken = vi.fn().mockResolvedValue(TOKEN);
    const client = createIndexVerifierClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });
    const invalidTargets = [
      { ...TARGET, ownerId: TARGET.ownerId.toUpperCase() },
      { ...TARGET, generationId: "igen_bad" },
      { ...TARGET, revisionToken: "01" },
      { ...TARGET, revisionToken: "9223372036854775808" },
      { ...TARGET, revisionToken: "-1" }
    ];
    for (const target of invalidTargets) {
      await expect(client.verify(target)).rejects.toBeInstanceOf(IndexVerifierInvocationError);
    }
    expect(getOidcToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("requires an unambiguous HTTPS Vercel origin", () => {
    for (const origin of [
      "http://unfiled-verifier.vercel.app",
      "https://user:password@unfiled-verifier.vercel.app",
      "https://unfiled-verifier.vercel.app/path",
      "https://unfiled-verifier.vercel.app?token=x",
      "https://unfiled-verifier.vercel.app#fragment",
      "https://vercel.app",
      "https://example.com",
      "not-a-url"
    ]) {
      expect(() => createIndexVerifierClient({ origin })).toThrow(ConfigurationError);
    }
  });

  it("keeps every accepted caller timeout strictly above the verifier deadline", () => {
    expect(INDEX_VERIFIER_SERVER_TIMEOUT_MS).toBe(49_000);
    expect(INDEX_VERIFIER_CLIENT_MIN_TIMEOUT_MS).toBe(49_001);
    expect(INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS).toBe(54_000);
    expect(INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS).toBe(54_000);
    expect(INDEX_VERIFIER_SERVER_TIMEOUT_MS).toBeLessThan(INDEX_VERIFIER_CLIENT_MIN_TIMEOUT_MS);
    expect(() =>
      createIndexVerifierClient({ origin: ORIGIN, timeoutMs: INDEX_VERIFIER_SERVER_TIMEOUT_MS })
    ).toThrow(ConfigurationError);
    expect(() =>
      createIndexVerifierClient({ origin: ORIGIN, timeoutMs: INDEX_VERIFIER_CLIENT_MIN_TIMEOUT_MS })
    ).not.toThrow();
    expect(() =>
      createIndexVerifierClient({ origin: ORIGIN, timeoutMs: INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS })
    ).not.toThrow();
    expect(() =>
      createIndexVerifierClient({
        origin: ORIGIN,
        timeoutMs: INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS + 1
      })
    ).toThrow(ConfigurationError);
  });

  it("requires an independent exact verifier origin in Vercel production", async () => {
    const request = vi.fn().mockResolvedValue(json(success()));
    const client = createEnvironmentIndexVerifierClient(
      {
        UNFILED_INDEX_WORKER_ORIGIN: "https://unfiled-worker.vercel.app",
        UNFILED_RAG_VERIFIER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      { fetchImplementation: request, getOidcToken: () => Promise.resolve(TOKEN) }
    );
    await expect(client.verify(TARGET)).resolves.toEqual(success());

    for (const environment of [
      {},
      {
        UNFILED_RAG_VERIFIER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_INDEX_WORKER_ORIGIN: ORIGIN,
        UNFILED_RAG_VERIFIER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_RAG_VERIFIER_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "invalid"
      }
    ]) {
      expect(() => createEnvironmentIndexVerifierClient(environment)).toThrow(ConfigurationError);
    }
  });

  it("rejects mismatched, extra, unsafe, oversized, and non-JSON responses", async () => {
    const cases: readonly Response[] = [
      json({ ...success(), generationId: "igen_01ARZ3NDEKTSV4RRFFQ69G5FAW" }),
      json({ ...success(), revisionToken: "0" }),
      json({ ...success(), verified: false }),
      json({ ...success(), extra: "private-canary" }),
      new Response("private-canary", { status: 503 }),
      new Response("x".repeat(4_097), { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "text/plain" } })
    ];
    for (const response of cases) {
      const client = createIndexVerifierClient({
        fetchImplementation: vi.fn().mockResolvedValue(response),
        getOidcToken: () => Promise.resolve(TOKEN),
        origin: ORIGIN
      });
      const reason = await client.verify(TARGET).catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(IndexVerifierInvocationError);
      expect(String(reason)).not.toContain("private-canary");
    }
  });

  it("redacts mid-body stream failures and aborts response consumption", async () => {
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"verified":'));
        controller.error(new TypeError("private-canary-stream-failure"));
      }
    });
    const failingClient = createIndexVerifierClient({
      fetchImplementation: vi.fn().mockResolvedValue(
        new Response(failingBody, {
          headers: { "content-type": "application/json" }
        })
      ),
      getOidcToken: () => Promise.resolve(TOKEN),
      origin: ORIGIN
    });
    const streamReason = await failingClient.verify(TARGET).catch((error: unknown) => error);
    expect(streamReason).toBeInstanceOf(IndexVerifierInvocationError);
    expect(String(streamReason)).not.toContain("private-canary");

    let cancelled = false;
    const pendingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"verified":'));
      },
      cancel() {
        cancelled = true;
      }
    });
    const controller = new AbortController();
    const pendingClient = createIndexVerifierClient({
      fetchImplementation: vi.fn().mockResolvedValue(
        new Response(pendingBody, {
          headers: { "content-type": "application/json" }
        })
      ),
      getOidcToken: () => Promise.resolve(TOKEN),
      origin: ORIGIN
    });
    const verification = pendingClient.verify(TARGET, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(verification).rejects.toBeInstanceOf(IndexVerifierInvocationError);
    expect(cancelled).toBe(true);
  });

  it("classifies only the verifier's exact non-retryable generation-invalid contract", async () => {
    const response = json(
      {
        code: "generation_invalid",
        message: "That encrypted generation could not be verified.",
        requestId: ERROR_REQUEST_ID
      },
      { status: 409, headers: { "x-request-id": ERROR_REQUEST_ID } }
    );
    const client = createIndexVerifierClient({
      fetchImplementation: vi.fn().mockResolvedValue(response),
      getOidcToken: () => Promise.resolve(TOKEN),
      origin: ORIGIN
    });

    await expect(client.verify(TARGET)).rejects.toBeInstanceOf(IndexVerifierGenerationInvalidError);

    const malformed = [
      json(
        {
          code: "provider_unavailable",
          message: "That encrypted generation could not be verified.",
          requestId: ERROR_REQUEST_ID
        },
        { status: 409, headers: { "x-request-id": ERROR_REQUEST_ID } }
      ),
      json(
        {
          code: "generation_invalid",
          message: "private-canary",
          requestId: ERROR_REQUEST_ID
        },
        { status: 409, headers: { "x-request-id": ERROR_REQUEST_ID } }
      ),
      json(
        {
          code: "generation_invalid",
          message: "That encrypted generation could not be verified.",
          requestId: ERROR_REQUEST_ID,
          extra: "private-canary"
        },
        { status: 409, headers: { "x-request-id": ERROR_REQUEST_ID } }
      ),
      json(
        {
          code: "generation_invalid",
          message: "That encrypted generation could not be verified.",
          requestId: ERROR_REQUEST_ID
        },
        { status: 409, headers: { "x-request-id": "44444444-4444-4444-8444-444444444444" } }
      ),
      json(
        {
          code: "generation_invalid",
          message: "That encrypted generation could not be verified.",
          requestId: ERROR_REQUEST_ID
        },
        {
          status: 409,
          headers: { "retry-after": "5", "x-request-id": ERROR_REQUEST_ID }
        }
      )
    ];
    for (const invalid of malformed) {
      const invalidClient = createIndexVerifierClient({
        fetchImplementation: vi.fn().mockResolvedValue(invalid),
        getOidcToken: () => Promise.resolve(TOKEN),
        origin: ORIGIN
      });
      const reason = await invalidClient.verify(TARGET).catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(IndexVerifierInvocationError);
      expect(reason).not.toBeInstanceOf(IndexVerifierGenerationInvalidError);
      expect(String(reason)).not.toContain("private-canary");
    }
  });

  it("honors pre-aborted requests before minting a token", async () => {
    const controller = new AbortController();
    controller.abort();
    const getOidcToken = vi.fn();
    const request = vi.fn();
    const client = createIndexVerifierClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });

    await expect(client.verify(TARGET, controller.signal)).rejects.toBeInstanceOf(
      IndexVerifierInvocationError
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
      const client = createIndexVerifierClient({
        fetchImplementation: request,
        getOidcToken,
        origin: ORIGIN
      });
      let outcome: "pending" | "rejected" | "resolved" = "pending";
      const verification = client.verify(TARGET).then(
        (value) => {
          outcome = "resolved";
          return value;
        },
        (error: unknown) => {
          outcome = "rejected";
          throw error;
        }
      );
      const rejection = expect(verification).rejects.toBeInstanceOf(IndexVerifierInvocationError);

      await vi.advanceTimersByTimeAsync(INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS - 1);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);

      await rejection;
      expect(outcome).toBe("rejected");
      expect(timeout).toHaveBeenCalledWith(INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS);
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
      const client = createIndexVerifierClient({
        fetchImplementation: request,
        getOidcToken,
        origin: ORIGIN
      });
      const verification = client.verify(TARGET, controller.signal);
      const rejection = expect(verification).rejects.toBeInstanceOf(IndexVerifierInvocationError);

      setTimeout(() => controller.abort(), 250);
      await vi.advanceTimersByTimeAsync(249);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await rejection;
      expect(timeout).toHaveBeenCalledWith(INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS);
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
