import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchConfig } from "../src/config.js";
import type { EncryptedUserSearchRepository, SearchDatabaseExecutor } from "../src/database.js";
import type { SearchEmbeddingProvider } from "../src/embedding-provider.js";
import type { SearchApp } from "../src/http.js";
import type { SearchInvocationAuth } from "../src/invocation-auth.js";
import type { SearchKeyManagementAdapter } from "../src/key-management.js";
import type { PostgresSearchExecutor } from "../src/postgres.js";
import type { SearchQueryPort } from "../src/query.js";

const mocks = vi.hoisted(() => ({
  app: vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
  closePostgres: vi.fn(() => Promise.resolve()),
  createApp: vi.fn(),
  createAuth: vi.fn(),
  createKeyManagement: vi.fn(),
  keyParser: vi.fn(() => (value: unknown) => value),
  createPostgres: vi.fn(),
  createLocalProvider: vi.fn(),
  createProvider: vi.fn(),
  createQuery: vi.fn(),
  createRepository: vi.fn()
}));

vi.mock("../src/database.js", () => ({
  createEncryptedUserSearchRepository: mocks.createRepository
}));
vi.mock("../src/embedding-provider.js", () => ({
  createLocalHashSearchEmbeddingProvider: mocks.createLocalProvider,
  createOpenAISearchEmbeddingProvider: mocks.createProvider
}));
vi.mock("../src/http.js", () => ({ createSearchApp: mocks.createApp }));
vi.mock("../src/invocation-auth.js", () => ({ createSearchInvocationAuth: mocks.createAuth }));
vi.mock("../src/key-management.js", () => ({
  createSearchKeyManagementAdapter: mocks.createKeyManagement,
  managedKeyRecordParserForSearchBoundary: mocks.keyParser
}));
vi.mock("../src/postgres.js", () => ({ createPostgresSearchExecutor: mocks.createPostgres }));
vi.mock("../src/query.js", () => ({ createEncryptedUserSearchQuery: mocks.createQuery }));

const { createSearchComposition } = await import("../src/composition.js");

const app: SearchApp = () => Promise.resolve(new Response(null, { status: 200 }));
const auth: SearchInvocationAuth = Object.freeze({
  authorize: () => Promise.reject(new Error("unused auth fixture"))
});
const keyManagement: SearchKeyManagementAdapter = Object.freeze({
  withAiAssistedSearchAuthority: () => Promise.reject(new Error("unused key fixture"))
});
const executor: SearchDatabaseExecutor = Object.freeze({
  query: () => Promise.reject(new Error("unused database fixture"))
});
const postgres: PostgresSearchExecutor = Object.freeze({
  close: () => mocks.closePostgres(),
  executor
});
const provider: SearchEmbeddingProvider = Object.freeze({
  embed: () => Promise.reject(new Error("unused provider fixture"))
});
const repository: EncryptedUserSearchRepository = Object.freeze({
  claim: () => Promise.reject(new Error("unused claim fixture")),
  complete: () => Promise.reject(new Error("unused complete fixture")),
  fail: () => Promise.reject(new Error("unused fail fixture")),
  page: () => Promise.reject(new Error("unused page fixture")),
  verify: () => Promise.reject(new Error("unused verify fixture"))
});
const query: SearchQueryPort = Object.freeze({
  query: () => Promise.reject(new Error("unused query fixture"))
});

const trustedSource = Object.freeze({
  audience: "https://vercel.com/team-example",
  environment: "production" as const,
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_webexample",
  projectName: "unfiled-web",
  teamSlug: "team-example"
});

function baseConfig(): Omit<SearchConfig, "invocation" | "pipeline"> {
  return {
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
    port: 8_791,
    releaseIdentity: {
      commit: "d".repeat(40),
      deployment: `sha256:${"e".repeat(64)}`,
      environment: "production"
    },
    requestTimeoutMs: 25_000,
    runtime: "production"
  };
}

function disabledConfig(): SearchConfig {
  return Object.freeze({
    ...baseConfig(),
    invocation: Object.freeze({ kind: "trusted-source" as const, source: trustedSource }),
    pipeline: Object.freeze({ kind: "disabled" as const })
  });
}

function enabledConfig(): SearchConfig {
  return Object.freeze({
    ...baseConfig(),
    invocation: Object.freeze({ kind: "trusted-source" as const, source: trustedSource }),
    pipeline: Object.freeze({
      database: Object.freeze({
        caPem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
        connectTimeoutMs: 3_000,
        expectedHost: "aws-0-us-west-2.pooler.supabase.com",
        projectRef: "abcdefghijklmnopqrst",
        statementTimeoutMs: 2_000,
        url: "postgresql://dedicated"
      }),
      embedding: Object.freeze({
        apiKey: "sk-dedicated-search-provider-key",
        dimensions: 1_536 as const,
        kind: "openai" as const,
        modelId: "text-embedding-3-small" as const
      }),
      kind: "enabled" as const
    })
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.createApp.mockReturnValue(app);
  mocks.createAuth.mockReturnValue(auth);
  mocks.createKeyManagement.mockReturnValue(keyManagement);
  mocks.createPostgres.mockReturnValue(postgres);
  mocks.createLocalProvider.mockReturnValue(provider);
  mocks.createProvider.mockReturnValue(provider);
  mocks.createRepository.mockReturnValue(repository);
  mocks.createQuery.mockReturnValue(query);
});

describe("search service composition", () => {
  it("keeps the disabled pipeline health-only and opens no provider or database", async () => {
    const config = disabledConfig();
    const composition = createSearchComposition(config);

    expect(composition.app).toBe(app);
    expect(mocks.createKeyManagement).toHaveBeenCalledOnce();
    expect(mocks.createAuth).toHaveBeenCalledWith(trustedSource);
    expect(mocks.createApp).toHaveBeenCalledWith({
      config,
      keyManagement,
      productionInvocationAuth: auth
    });
    expect(mocks.createPostgres).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.createRepository).not.toHaveBeenCalled();
    expect(mocks.createQuery).not.toHaveBeenCalled();
    await expect(composition.close()).resolves.toBeUndefined();
    expect(mocks.closePostgres).not.toHaveBeenCalled();
  });

  it("wires the dedicated database, provider key, repository, query, and close lifecycle", async () => {
    const config = enabledConfig();
    const composition = createSearchComposition(config);
    if (config.pipeline.kind !== "enabled") throw new Error("expected enabled fixture");

    expect(mocks.createPostgres).toHaveBeenCalledWith(config.pipeline.database);
    expect(mocks.createRepository).toHaveBeenCalledWith(
      postgres.executor,
      expect.any(Function),
      config.pipeline.embedding
    );
    expect(mocks.createProvider).toHaveBeenCalledWith({
      apiKey: config.pipeline.embedding.kind === "openai" ? config.pipeline.embedding.apiKey : ""
    });
    expect(mocks.createQuery).toHaveBeenCalledWith({ embeddingProvider: provider, repository });
    expect(mocks.createApp).toHaveBeenCalledWith({
      config,
      keyManagement,
      productionInvocationAuth: auth,
      query
    });
    await expect(composition.close()).resolves.toBeUndefined();
    expect(mocks.closePostgres).toHaveBeenCalledOnce();
  });

  it("wires the local hash provider without an OpenAI credential", () => {
    const base = enabledConfig();
    if (base.pipeline.kind !== "enabled") throw new Error("expected enabled fixture");
    const config: SearchConfig = Object.freeze({
      ...base,
      pipeline: Object.freeze({
        ...base.pipeline,
        embedding: Object.freeze({
          dimensions: 512,
          kind: "local-hash-v1" as const,
          modelId: "unfiled-local-hash-v1" as const
        })
      })
    });

    createSearchComposition(config);
    if (config.pipeline.kind !== "enabled") throw new Error("expected enabled fixture");

    expect(mocks.createLocalProvider).toHaveBeenCalledOnce();
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.createRepository).toHaveBeenCalledWith(
      postgres.executor,
      expect.any(Function),
      config.pipeline.embedding
    );
  });

  it("does not create trusted-source auth for local bearer composition", () => {
    const config: SearchConfig = Object.freeze({
      invocation: Object.freeze({
        kind: "local-bearer" as const,
        secret: "local-search-secret-with-at-least-32-characters"
      }),
      keyBoundary: Object.freeze({ kind: "local-disabled" as const }),
      maxRequestBytes: 16_384,
      pipeline: Object.freeze({ kind: "disabled" as const }),
      port: 8_791,
      releaseIdentity: null,
      requestTimeoutMs: 25_000,
      runtime: "local" as const
    });

    createSearchComposition(config);

    expect(mocks.createAuth).not.toHaveBeenCalled();
    expect(mocks.createApp).toHaveBeenCalledWith({
      config,
      keyManagement
    });
  });
});
