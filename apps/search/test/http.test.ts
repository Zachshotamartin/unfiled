import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  type EncryptedUserSearchInvocation,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";
import type { DecryptOnlyIntermediateKeyCustodian } from "@unfiled/key-management";

import type { SearchConfig, SearchTrustedSource } from "../src/config.js";
import { SearchServiceError } from "../src/errors.js";
import type { SearchKeyAuthority, SearchKeyManagementAdapter } from "../src/key-management.js";
import type { SearchLogEvent, SearchLogger } from "../src/logging.js";
import { encryptedUserSearchRequestDigest } from "../src/material.js";
import type { SearchQueryPort } from "../src/query.js";

const mocks = vi.hoisted(() => ({
  createCustodian: vi.fn(),
  createTransport: vi.fn(),
  verifyOidc: vi.fn()
}));

vi.mock("@unfiled/key-management", () => ({
  createAwsKmsEnvelopeCustodian: mocks.createCustodian,
  createVercelOidcKmsTransport: mocks.createTransport
}));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: mocks.verifyOidc }));

const { createSearchApp } = await import("../src/http.js");
const { createSearchKeyManagementAdapter } = await import("../src/key-management.js");

const SEARCH_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_SECRET = "A".repeat(43);
const GENERATION_ID = "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const GENERATION_ATTESTATION_DIGEST = "d".repeat(64);
const SOURCE_TOKEN = "source.header.signature";
const WORKLOAD_TOKEN = "workload.header.signature";

function source(): SearchTrustedSource {
  return {
    audience: "https://vercel.com/team-example",
    environment: "production",
    expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
    issuer: "https://oidc.vercel.com/team-example",
    ownerId: "team_owner123",
    projectId: "prj_webexample",
    projectName: "unfiled-web",
    teamSlug: "team-example"
  };
}

function config(changes: Partial<SearchConfig> = {}): SearchConfig {
  return Object.freeze({
    invocation: Object.freeze({ kind: "trusted-source" as const, source: source() }),
    keyBoundary: Object.freeze({
      activeObjectWrapKeyArn:
        "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555",
      expectedOidcSubject: "owner:team-example:project:unfiled-search:environment:production",
      kind: "aws-oidc" as const,
      region: "us-west-2",
      retiredObjectWrapKeyArns: Object.freeze([]),
      roleArn: "arn:aws:iam::123456789012:role/unfiled-search-production",
      vercelProjectId: "prj_searchexample"
    }),
    maxRequestBytes: 16_384,
    pipeline: Object.freeze({ kind: "disabled" as const }),
    port: 8_791,
    requestTimeoutMs: 500,
    runtime: "production" as const,
    ...changes
  });
}

function material(query = "Roosevelt method"): EncryptedUserSearchInvocation["material"] {
  return {
    requestVersion: "encrypted-user-search-request-v1",
    hybridRankingVersion: "encrypted-hybrid-rank-v1",
    filters: {
      archive: "exclude" as const,
      privacy: "ai_assisted" as const,
      space: { id: null, mode: "any" as const },
      tagIds: [],
      type: null,
      updatedFrom: null,
      updatedTo: null
    },
    pageLimit: 30,
    maxResults: 8,
    continuation: null,
    query
  };
}

function invocation(query = "Roosevelt method"): EncryptedUserSearchInvocation {
  const requestMaterial = material(query);
  return Object.freeze({
    claimSecret: CLAIM_SECRET,
    material: requestMaterial,
    requestDigest: encryptedUserSearchRequestDigest(requestMaterial),
    searchId: SEARCH_ID
  });
}

const RESULT: EncryptedUserSearchResult = Object.freeze({
  generationAttestationDigest: GENERATION_ATTESTATION_DIGEST,
  generationId: GENERATION_ID,
  generationRevisionToken: "12",
  items: [],
  rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
  scannedNoteCount: 0,
  searchId: SEARCH_ID
});

function verifiedOidc(overrides: Readonly<Record<string, unknown>> = {}) {
  const trusted = source();
  const now = Math.floor(Date.now() / 1_000);
  return {
    payload: {
      aud: trusted.audience,
      environment: trusted.environment,
      exp: now + 300,
      iat: now,
      iss: trusted.issuer,
      nbf: now,
      owner: trusted.teamSlug,
      owner_id: trusted.ownerId,
      project: trusted.projectName,
      project_id: trusted.projectId,
      sub: trusted.expectedSubject,
      ...overrides
    },
    protectedHeader: { alg: "RS256" }
  };
}

function request(
  options: Readonly<{
    body?: BodyInit | null;
    headers?: HeadersInit;
    method?: string;
    path?: string;
    signal?: AbortSignal;
  }> = {}
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "x-vercel-oidc-token": WORKLOAD_TOKEN,
    "x-vercel-trusted-oidc-idp-token": SOURCE_TOKEN,
    ...Object.fromEntries(new Headers(options.headers).entries())
  });
  return new Request(`https://search.example${options.path ?? "/internal/query"}`, {
    body: options.body === undefined ? JSON.stringify(invocation()) : options.body,
    headers,
    method: options.method ?? "POST",
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

function recorder(): Readonly<{ events: SearchLogEvent[]; logger: SearchLogger }> {
  const events: SearchLogEvent[] = [];
  return Object.freeze({
    events,
    logger: Object.freeze({ log: (event: SearchLogEvent) => events.push(event) })
  });
}

function queryPort(
  implementation: SearchQueryPort["query"] = () => Promise.resolve(RESULT)
): Readonly<{ query: ReturnType<typeof vi.fn<SearchQueryPort["query"]>>; port: SearchQueryPort }> {
  const query = vi.fn<SearchQueryPort["query"]>(implementation);
  return Object.freeze({ query, port: Object.freeze({ query }) });
}

async function body(response: Response): Promise<Readonly<Record<string, unknown>>> {
  return (await response.json()) as Readonly<Record<string, unknown>>;
}

beforeEach(() => {
  mocks.createCustodian.mockReset().mockReturnValue(
    Object.freeze({
      withUnwrappedIntermediateKey: () => Promise.reject(new Error("not used"))
    }) satisfies DecryptOnlyIntermediateKeyCustodian
  );
  mocks.createTransport.mockReset().mockResolvedValue({ destroy: vi.fn() });
  mocks.verifyOidc.mockReset().mockResolvedValue(verifiedOidc());
});

describe("search HTTP boundary", () => {
  it("serves only GET/HEAD health without invoking identity, KMS, or query", async () => {
    const query = queryPort();
    const logs = recorder();
    const app = createSearchApp({
      config: config(),
      keyManagement: createSearchKeyManagementAdapter(),
      logger: logs.logger,
      query: query.port
    });

    const get = await app(new Request("https://search.example/health"));
    expect(get.status).toBe(200);
    expect(await body(get)).toEqual({ service: "unfiled-search", status: "ok" });
    expect(get.headers.get("allow")).toBeNull();
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("x-frame-options")).toBe("DENY");
    expect(get.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);

    const head = await app(new Request("https://search.example/api/health", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const invalid = await app(new Request("https://search.example/health?private=query"));
    expect(invalid.status).toBe(400);
    expect(await body(invalid)).toMatchObject({ code: "validation_failed" });
    expect(query.query).not.toHaveBeenCalled();
    expect(mocks.verifyOidc).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(logs.events.map((event) => event.route)).toEqual(["health", "health", "health"]);
  });

  it("rejects unsupported methods and unknown routes before privileged work", async () => {
    const app = createSearchApp({ config: config() });
    const healthPost = await app(new Request("https://search.example/health", { method: "POST" }));
    expect(healthPost.status).toBe(405);
    expect(healthPost.headers.get("allow")).toBe("GET, HEAD");
    expect(await body(healthPost)).toMatchObject({ code: "method_not_allowed" });

    const queryGet = await app(new Request("https://search.example/internal/query"));
    expect(queryGet.status).toBe(405);
    expect(queryGet.headers.get("allow")).toBe("POST");
    const unknown = await app(new Request("https://search.example/private"));
    expect(unknown.status).toBe(404);
    expect(mocks.verifyOidc).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("accepts an exact body digest and both identities, then emits content-free logs", async () => {
    const canary = "PRIVATE-QUERY-CANARY";
    const query = queryPort();
    const logs = recorder();
    const app = createSearchApp({
      config: config(),
      keyManagement: createSearchKeyManagementAdapter(),
      logger: logs.logger,
      query: query.port
    });

    const response = await app(request({ body: JSON.stringify(invocation(canary)) }));

    expect(mocks.verifyOidc).toHaveBeenCalledOnce();
    expect(mocks.createTransport).toHaveBeenCalledOnce();
    expect(mocks.createCustodian).toHaveBeenCalledOnce();
    expect(query.query).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(RESULT);
    expect(query.query.mock.calls[0]?.[0].invocation.material.query).toBe(canary);
    expect(query.query.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(mocks.verifyOidc).toHaveBeenCalledWith(SOURCE_TOKEN, expect.any(Object));
    expect(mocks.createTransport).toHaveBeenCalledWith({
      maxAttempts: 2,
      region: "us-west-2",
      roleArn: "arn:aws:iam::123456789012:role/unfiled-search-production",
      workload: "search_worker"
    });
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      event: "request.completed",
      level: "info",
      method: "POST",
      outcome: "ok",
      route: "internal_query",
      runtime: "production",
      status: 200
    });
    const serializedLogs = JSON.stringify(logs.events);
    expect(serializedLogs).not.toContain(canary);
    expect(serializedLogs).not.toContain(SOURCE_TOKEN);
    expect(serializedLogs).not.toContain(WORKLOAD_TOKEN);
    expect(serializedLogs).not.toContain(CLAIM_SECRET);
  });

  it.each([
    ["cookie", { cookie: "session=forbidden" }],
    ["authorization", { authorization: "Bearer forbidden" }],
    ["deployment bypass", { "x-vercel-protection-bypass": "forbidden" }],
    ["missing source identity", { "x-vercel-trusted-oidc-idp-token": "" }]
  ])("rejects %s before KMS and query", async (_name, changedHeaders) => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-vercel-oidc-token": WORKLOAD_TOKEN,
      "x-vercel-trusted-oidc-idp-token": SOURCE_TOKEN
    });
    for (const [name, value] of Object.entries(changedHeaders)) {
      if (value === "") headers.delete(name);
      else headers.set(name, value);
    }
    const query = queryPort();
    const response = await createSearchApp({ config: config(), query: query.port })(
      new Request("https://search.example/internal/query", {
        body: JSON.stringify(invocation()),
        headers,
        method: "POST"
      })
    );
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({ code: "unauthorized" });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(query.query).not.toHaveBeenCalled();
  });

  it("rejects signed source-claim drift without exposing the reason", async () => {
    mocks.verifyOidc.mockResolvedValue(verifiedOidc({ project_id: "prj_attacker" }));
    const logs = recorder();
    const query = queryPort();
    const response = await createSearchApp({
      config: config(),
      logger: logs.logger,
      query: query.port
    })(request());
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({
      code: "unauthorized",
      message: "This search request is not authorized."
    });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(query.query).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.events)).not.toContain("prj_attacker");
  });

  it.each([
    ["missing content type", {}, JSON.stringify(invocation()), 400, "validation_failed"],
    [
      "wrong content type",
      { "content-type": "text/plain" },
      JSON.stringify(invocation()),
      400,
      "validation_failed"
    ],
    ["empty body", { "content-type": "application/json" }, "", 400, "validation_failed"],
    [
      "invalid JSON",
      { "content-type": "application/json" },
      "PRIVATE-INVALID-JSON",
      400,
      "validation_failed"
    ],
    ["invalid schema", { "content-type": "application/json" }, "{}", 401, "unauthorized"]
  ] as const)(
    "rejects %s after caller authentication",
    async (_name, contentHeaders, requestBody, status, code) => {
      const headers = new Headers({
        "x-vercel-oidc-token": WORKLOAD_TOKEN,
        "x-vercel-trusted-oidc-idp-token": SOURCE_TOKEN,
        ...contentHeaders
      });
      const query = queryPort();
      const logs = recorder();
      const response = await createSearchApp({
        config: config(),
        keyManagement: createSearchKeyManagementAdapter(),
        logger: logs.logger,
        query: query.port
      })(
        new Request("https://search.example/internal/query", {
          body: requestBody,
          headers,
          method: "POST"
        })
      );
      expect(response.status).toBe(status);
      expect(await body(response)).toMatchObject({ code });
      expect(query.query).not.toHaveBeenCalled();
      expect(mocks.createTransport).not.toHaveBeenCalled();
      expect(JSON.stringify(logs.events)).not.toContain("PRIVATE-INVALID-JSON");
    }
  );

  it("rejects material drift even when every public field is well formed", async () => {
    const changed = invocation();
    const forged = {
      ...changed,
      material: { ...changed.material, query: "changed after digest" }
    };
    const query = queryPort();
    const response = await createSearchApp({ config: config(), query: query.port })(
      request({ body: JSON.stringify(forged) })
    );
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({ code: "unauthorized" });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(query.query).not.toHaveBeenCalled();
  });

  it.each([
    ["oversized declaration", String(16_385), 413, "request_too_large"],
    ["invalid declaration", "invalid", 400, "validation_failed"]
  ])("rejects an %s without consuming or decrypting", async (_name, length, status, code) => {
    const query = queryPort();
    const response = await createSearchApp({ config: config(), query: query.port })(
      request({ headers: { "content-length": length } })
    );
    expect(response.status).toBe(status);
    expect(await body(response)).toMatchObject({ code });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(query.query).not.toHaveBeenCalled();
  });

  it("bounds an undeclared stream and scrubs the rejected body chunk", async () => {
    const bytes = new Uint8Array(1_025).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    const rawInit: RequestInit & { duplex: "half" } = {
      body: stream,
      duplex: "half",
      headers: {
        "content-type": "application/json",
        "x-vercel-oidc-token": WORKLOAD_TOKEN,
        "x-vercel-trusted-oidc-idp-token": SOURCE_TOKEN
      },
      method: "POST"
    };
    const query = queryPort();
    const response = await createSearchApp({
      config: config({ maxRequestBytes: 1_024 }),
      query: query.port
    })(new Request("https://search.example/internal/query", rawInit));
    expect(response.status).toBe(413);
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(query.query).not.toHaveBeenCalled();
  });

  it("requires workload OIDC after digest verification and rejects a forged key authority", async () => {
    const query = queryPort();
    const missingHeaders = new Headers({
      "content-type": "application/json",
      "x-vercel-trusted-oidc-idp-token": SOURCE_TOKEN
    });
    const app = createSearchApp({ config: config(), query: query.port });
    const missing = await app(
      new Request("https://search.example/internal/query", {
        body: JSON.stringify(invocation()),
        headers: missingHeaders,
        method: "POST"
      })
    );
    expect(missing.status).toBe(503);
    expect(mocks.createTransport).not.toHaveBeenCalled();

    const forgedKeyManagement: SearchKeyManagementAdapter = Object.freeze({
      withAiAssistedSearchAuthority(_boundary, _proof, _signal, use) {
        return use(Object.freeze({}) as SearchKeyAuthority);
      }
    });
    const forged = await createSearchApp({
      config: config(),
      keyManagement: forgedKeyManagement,
      query: query.port
    })(request());
    expect(forged.status).toBe(503);
    expect(query.query).not.toHaveBeenCalled();
  });

  it.each(["kms", "query", "result"] as const)(
    "redacts a private %s failure from response and structured logs",
    async (stage) => {
      if (stage === "kms") {
        mocks.createTransport.mockRejectedValue(new Error("PRIVATE-KMS-CANARY"));
      }
      const query = queryPort(() => {
        if (stage === "query") return Promise.reject(new Error("PRIVATE-QUERY-CANARY"));
        if (stage === "result") {
          return Promise.resolve({ ...RESULT, searchId: "invalid" });
        }
        return Promise.resolve(RESULT);
      });
      const logs = recorder();
      const response = await createSearchApp({
        config: config(),
        keyManagement: createSearchKeyManagementAdapter(),
        logger: logs.logger,
        query: query.port
      })(request());
      const serialized = JSON.stringify(await body(response));
      expect(response.status).toBe(503);
      expect(serialized).toContain("Search is temporarily unavailable.");
      expect(serialized).not.toContain("CANARY");
      expect(JSON.stringify(logs.events)).not.toContain("CANARY");
      expect(response.headers.get("retry-after")).toBe("5");
    }
  );

  it("rejects legacy display plaintext at the query response boundary", async () => {
    const canary = "PRIVATE-DISPLAY-PLAINTEXT-CANARY";
    const query = queryPort(() =>
      Promise.resolve({
        ...RESULT,
        items: [
          {
            indexedRevision: 7,
            noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA",
            score: 0.9,
            snippet: canary,
            spaceId: null,
            title: canary,
            type: "principle",
            updatedAt: "2026-09-01T12:00:00.000Z"
          }
        ]
      })
    );
    const logs = recorder();
    const response = await createSearchApp({
      config: config(),
      keyManagement: createSearchKeyManagementAdapter(),
      logger: logs.logger,
      query: query.port
    })(request());

    expect(response.status).toBe(503);
    expect(query.query).toHaveBeenCalledOnce();
    expect(JSON.stringify(await body(response))).not.toContain(canary);
    expect(JSON.stringify(logs.events)).not.toContain(canary);
  });

  it("enforces one deadline even when the query ignores cancellation", async () => {
    const query = queryPort(() => new Promise(() => undefined));
    const response = await createSearchApp({
      config: config({ requestTimeoutMs: 10 }),
      keyManagement: createSearchKeyManagementAdapter(),
      query: query.port
    })(request());
    expect(response.status).toBe(504);
    expect(await body(response)).toMatchObject({ code: "request_timeout" });
    expect(query.query).toHaveBeenCalledOnce();
    expect(query.query.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("fails closed when query or key-management composition is omitted", async () => {
    const noQuery = await createSearchApp({ config: config() })(request());
    expect(noQuery.status).toBe(503);

    const noKey = await createSearchApp({
      config: config(),
      query: queryPort().port,
      keyManagement: Object.freeze({
        withAiAssistedSearchAuthority() {
          return Promise.reject(
            new SearchServiceError(503, "provider_unavailable", { retryable: true })
          );
        }
      })
    })(request());
    expect(noKey.status).toBe(503);
  });
});
