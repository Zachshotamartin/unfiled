import { describe, expect, it, vi } from "vitest";

import {
  ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  USER_HYBRID_SEARCH_RANKING_VERSION,
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  type EncryptedUserSearchInvocation,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";

import { ConfigurationError } from "@/server/api/errors";

import { EncryptedUserSearchError } from "./errors";
import {
  createEncryptedUserSearchClient,
  createEnvironmentEncryptedUserSearchClient,
  ENCRYPTED_USER_SEARCH_DEFAULT_TIMEOUT_MS,
  ENCRYPTED_USER_SEARCH_MAX_RESPONSE_BYTES
} from "./search-client";

const TOKEN = `${"a".repeat(48)}.${"b".repeat(48)}.${"c".repeat(48)}`;
const ORIGIN = "https://unfiled-search.vercel.app";
const SEARCH_ID = "00000000-0000-4000-8000-000000000002";
const PRIVATE_QUERY = "private-query-canary";

function invocation(
  overrides: Partial<EncryptedUserSearchInvocation> = {}
): EncryptedUserSearchInvocation {
  return {
    searchId: SEARCH_ID,
    claimSecret: "s".repeat(43),
    requestDigest: "a".repeat(64),
    material: {
      requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
      hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
      query: PRIVATE_QUERY,
      filters: {
        archive: "exclude",
        privacy: "ai_assisted",
        type: null,
        space: { mode: "any", id: null },
        tagIds: [],
        updatedFrom: null,
        updatedTo: null
      },
      pageLimit: 30,
      maxResults: 8,
      continuation: null
    },
    ...overrides
  };
}

function result(overrides: Readonly<Record<string, unknown>> = {}): EncryptedUserSearchResult {
  return {
    searchId: SEARCH_ID,
    generationId: `igen_${"0".repeat(26)}`,
    generationAttestationDigest: "a".repeat(64),
    generationRevisionToken: "7",
    rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
    items: [
      {
        noteId: `note_${"0".repeat(26)}`,
        indexedRevision: 3,
        score: 0.8
      }
    ],
    scannedNoteCount: 1,
    ...overrides
  };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

describe("isolated encrypted user-search client", () => {
  it("sends only the strict invocation and short-lived trusted-source token", async () => {
    const request = vi.fn().mockResolvedValue(json(result()));
    const getOidcToken = vi.fn().mockResolvedValue(TOKEN);
    const client = createEncryptedUserSearchClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });
    const input = invocation();

    const output = await client.query(input);
    expect(output).toEqual(result());
    const [url, init] = request.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${ORIGIN}/internal/query`);
    expect(url.toString()).not.toContain(PRIVATE_QUERY);
    expect(init).toMatchObject({
      body: JSON.stringify(input),
      cache: "no-store",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        "x-unfiled-trusted-oidc-idp-token": TOKEN
      },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      "content-type",
      "x-unfiled-trusted-oidc-idp-token"
    ]);
    expect(init.body as string).not.toContain("ownerId");
    expect(init.body as string).not.toContain("Authorization");
    expect(getOidcToken).toHaveBeenCalledOnce();
    expect(Object.isFrozen(output)).toBe(true);
  });

  it("requires an exact path-free HTTPS Vercel origin and bounded deadline", () => {
    for (const origin of [
      "http://unfiled-search.vercel.app",
      "https://user:password@unfiled-search.vercel.app",
      "https://unfiled-search.vercel.app/path",
      "https://unfiled-search.vercel.app?query=private-query-canary",
      "https://unfiled-search.vercel.app#fragment",
      "https://unfiled-search.vercel.app:443",
      "https://vercel.app",
      "https://example.com",
      "not-a-url"
    ]) {
      expect(() => createEncryptedUserSearchClient({ origin })).toThrow(ConfigurationError);
    }
    expect(() => createEncryptedUserSearchClient({ origin: ORIGIN, timeoutMs: 999 })).toThrow(
      ConfigurationError
    );
    expect(() => createEncryptedUserSearchClient({ origin: ORIGIN, timeoutMs: 25_001 })).toThrow(
      ConfigurationError
    );
  });

  it("requires a matching Vercel Preview or Production search environment", async () => {
    const dependencies = {
      fetchImplementation: vi.fn().mockImplementation(() => Promise.resolve(json(result()))),
      getOidcToken: () => Promise.resolve(TOKEN)
    };
    for (const runtime of ["preview", "production"] as const) {
      const client = createEnvironmentEncryptedUserSearchClient(
        {
          UNFILED_SEARCH_ENV: runtime,
          UNFILED_SEARCH_ORIGIN: ORIGIN,
          VERCEL: "1",
          VERCEL_ENV: runtime,
          VERCEL_PROJECT_ID: "prj_web12345"
        },
        dependencies
      );
      await expect(client.query(invocation())).resolves.toEqual(result());
    }

    for (const environment of [
      {},
      {
        UNFILED_SEARCH_ENV: "production",
        UNFILED_SEARCH_ORIGIN: ORIGIN,
        VERCEL: "0",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_SEARCH_ENV: "production",
        UNFILED_SEARCH_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_SEARCH_ENV: "development",
        UNFILED_SEARCH_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "development",
        VERCEL_PROJECT_ID: "prj_web12345"
      },
      {
        UNFILED_SEARCH_ENV: "production",
        UNFILED_SEARCH_ORIGIN: ORIGIN,
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "invalid"
      }
    ]) {
      expect(() => createEnvironmentEncryptedUserSearchClient(environment)).toThrow(
        ConfigurationError
      );
    }
  });

  it("rejects extra input fields and oversized or malformed responses", async () => {
    const inputWithOwner = {
      ...invocation(),
      ownerId: "00000000-0000-4000-8000-000000000001"
    } as EncryptedUserSearchInvocation;
    const noRequest = vi.fn();
    await expect(
      createEncryptedUserSearchClient({
        fetchImplementation: noRequest,
        getOidcToken: () => Promise.resolve(TOKEN),
        origin: ORIGIN
      }).query(inputWithOwner)
    ).rejects.toBeInstanceOf(EncryptedUserSearchError);
    expect(noRequest).not.toHaveBeenCalled();

    const cases: readonly Response[] = [
      json({ ...result(), ownerId: "private-owner" }),
      json({
        ...result(),
        items: [{ ...result().items[0], title: "private-note-title-canary" }]
      }),
      json(result({ searchId: "00000000-0000-4000-8000-000000000003" })),
      json(result({ replayed: true })),
      new Response("private-query-canary", { status: 503 }),
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      new Response("x".repeat(ENCRYPTED_USER_SEARCH_MAX_RESPONSE_BYTES + 1), {
        headers: { "content-type": "application/json" }
      }),
      new Response("{}", {
        headers: {
          "content-length": String(ENCRYPTED_USER_SEARCH_MAX_RESPONSE_BYTES + 1),
          "content-type": "application/json"
        }
      })
    ];
    for (const response of cases) {
      const client = createEncryptedUserSearchClient({
        fetchImplementation: vi.fn().mockResolvedValue(response),
        getOidcToken: () => Promise.resolve(TOKEN),
        origin: ORIGIN
      });
      const reason = await client.query(invocation()).catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(EncryptedUserSearchError);
      expect(String(reason)).not.toContain(PRIVATE_QUERY);
      expect(String(reason)).not.toContain("private-owner");
    }
  });

  it("rejects oversized request material and malformed OIDC tokens before egress", async () => {
    const request = vi.fn();
    const invalidInput = invocation({
      material: { ...invocation().material, query: "q".repeat(201) }
    });
    const client = createEncryptedUserSearchClient({
      fetchImplementation: request,
      getOidcToken: () => Promise.resolve(TOKEN),
      origin: ORIGIN
    });
    await expect(client.query(invalidInput)).rejects.toBeInstanceOf(EncryptedUserSearchError);
    expect(request).not.toHaveBeenCalled();

    for (const token of ["not-a-jwt", "x".repeat(16_385)]) {
      const tokenRequest = vi.fn();
      const tokenClient = createEncryptedUserSearchClient({
        fetchImplementation: tokenRequest,
        getOidcToken: () => Promise.resolve(token),
        origin: ORIGIN
      });
      await expect(tokenClient.query(invocation())).rejects.toBeInstanceOf(
        EncryptedUserSearchError
      );
      expect(tokenRequest).not.toHaveBeenCalled();
    }
  });

  it("redacts response-stream and transport details", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"searchId":'));
        controller.error(new TypeError(`${PRIVATE_QUERY} stream failure`));
      }
    });
    for (const fetchImplementation of [
      vi
        .fn()
        .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } })),
      vi.fn().mockRejectedValue(new Error(`${PRIVATE_QUERY} fetch failure`))
    ]) {
      const client = createEncryptedUserSearchClient({
        fetchImplementation,
        getOidcToken: () => Promise.resolve(TOKEN),
        origin: ORIGIN
      });
      const reason = await client.query(invocation()).catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(EncryptedUserSearchError);
      expect(String(reason)).toBe(
        "EncryptedUserSearchError: Encrypted semantic search is unavailable."
      );
    }
  });

  it("does not mint or send a token for a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const getOidcToken = vi.fn();
    const request = vi.fn();
    const client = createEncryptedUserSearchClient({
      fetchImplementation: request,
      getOidcToken,
      origin: ORIGIN
    });

    await expect(client.query(invocation(), controller.signal)).rejects.toBeInstanceOf(
      EncryptedUserSearchError
    );
    expect(getOidcToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds token acquisition and consumes a late rejection after cancellation", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      let rejectToken: ((error: Error) => void) | undefined;
      const getOidcToken = vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectToken = reject;
          })
      );
      const request = vi.fn();
      const client = createEncryptedUserSearchClient({
        fetchImplementation: request,
        getOidcToken,
        origin: ORIGIN
      });
      const pending = client.query(invocation());
      const rejection = expect(pending).rejects.toBeInstanceOf(EncryptedUserSearchError);

      await vi.advanceTimersByTimeAsync(ENCRYPTED_USER_SEARCH_DEFAULT_TIMEOUT_MS);
      await rejection;
      expect(request).not.toHaveBeenCalled();
      rejectToken?.(new Error(`${PRIVATE_QUERY} late token failure`));
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
