import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: vi.fn(),
  close: vi.fn(),
  createCrypto: vi.fn(),
  createDrain: vi.fn(),
  createEmbedding: vi.fn(),
  createLocalEmbedding: vi.fn(),
  createInvocationAuth: vi.fn(),
  createKeyManagement: vi.fn(),
  keyParser: vi.fn(() => (value: unknown) => value),
  createPostgres: vi.fn(),
  createRepository: vi.fn(),
  createWorkerApp: vi.fn()
}));

vi.mock("../src/http", () => ({ createWorkerApp: mocks.createWorkerApp }));
vi.mock("../src/embedding-provider", () => ({
  createLocalHashEmbeddingProvider: mocks.createLocalEmbedding,
  createOpenAiEmbeddingProvider: mocks.createEmbedding
}));
vi.mock("../src/index-crypto", () => ({
  createManagedIndexCryptoFactory: mocks.createCrypto
}));
vi.mock("../src/index-database", () => ({ createNoteIndexRepository: mocks.createRepository }));
vi.mock("../src/index-drain", () => ({ createNoteIndexDrain: mocks.createDrain }));
vi.mock("../src/invocation-auth-adapter", () => ({
  createVercelTrustedSourcesInvocationAuth: mocks.createInvocationAuth
}));
vi.mock("../src/key-management-adapter", () => ({
  createWorkerKeyManagementAdapter: mocks.createKeyManagement,
  managedKeyRecordParserForWorkerBoundary: mocks.keyParser
}));
vi.mock("../src/postgres-index-executor", () => ({
  createPostgresIndexExecutor: mocks.createPostgres
}));

import type { WorkerConfig } from "../src/config";
import { createWorkerComposition } from "../src/composition";

const SECRET = "worker-only-drain-secret-with-adequate-length";

function config(indexing: WorkerConfig["indexing"]): WorkerConfig {
  return {
    indexing,
    invocationAuth: { kind: "bearer", secret: SECRET },
    keyBoundary: { keyClass: "ai_assisted", kind: "local-synthetic" },
    maxRequestBytes: 1_024,
    port: 8_788,
    releaseIdentity: null,
    requestTimeoutMs: 25_000,
    runtime: "local"
  };
}

describe("worker production composition", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.app.mockResolvedValue(new Response());
    mocks.close.mockResolvedValue(undefined);
    mocks.createWorkerApp.mockReturnValue(mocks.app);
    mocks.createKeyManagement.mockReturnValue({ key: true });
    mocks.createInvocationAuth.mockReturnValue({ auth: true });
    mocks.createEmbedding.mockReturnValue({ embed: vi.fn() });
    mocks.createLocalEmbedding.mockReturnValue({ embed: vi.fn() });
    mocks.createPostgres.mockReturnValue({ close: mocks.close, executor: { query: vi.fn() } });
    mocks.createRepository.mockReturnValue({ claim: vi.fn() });
    mocks.createDrain.mockReturnValue({ drain: vi.fn() });
  });

  it("wires the local hash embedder without an OpenAI credential", () => {
    const indexing: Extract<WorkerConfig["indexing"], { kind: "enabled" }> = {
      claimLimit: 1,
      concurrency: 1,
      database: {
        caPem: "test-ca",
        connectTimeoutMs: 5_000,
        expectedHost: "db.example.supabase.co",
        projectRef: "abcdefghijklmnopqrst",
        statementTimeoutMs: 5_000,
        url: "redacted-url"
      },
      embedding: {
        dimensions: 512,
        kind: "local-hash-v1",
        maxInputBytes: 24_576,
        modelId: "unfiled-local-hash-v1",
        timeoutMs: 5_000
      },
      kind: "enabled",
      leaseSeconds: 120,
      recoveryLimit: 100
    };

    createWorkerComposition({ ...config(indexing), runtime: "production" });

    expect(mocks.createLocalEmbedding).toHaveBeenCalledOnce();
    expect(mocks.createEmbedding).not.toHaveBeenCalled();
  });

  it("keeps local health available while drain remains fail closed when indexing is disabled", async () => {
    const configured = config({ kind: "disabled" });
    const composition = createWorkerComposition(configured);

    expect(composition.app).toBe(mocks.app);
    expect(mocks.createWorkerApp).toHaveBeenCalledWith({
      config: configured,
      keyManagement: { key: true }
    });
    expect(mocks.createPostgres).not.toHaveBeenCalled();
    await expect(composition.close()).resolves.toBeUndefined();
  });

  it("wires only the dedicated database, model-bound embedder, crypto, and bounded drain", async () => {
    const indexing: Extract<WorkerConfig["indexing"], { kind: "enabled" }> = {
      claimLimit: 4,
      concurrency: 2,
      database: {
        caPem: "test-ca",
        connectTimeoutMs: 5_000,
        expectedHost: "db.example.supabase.co",
        projectRef: "abcdefghijklmnopqrst",
        statementTimeoutMs: 15_000,
        url: "redacted-url"
      },
      embedding: {
        apiKey: "redacted-key",
        dimensions: 1_536,
        kind: "openai",
        maxInputBytes: 24_576,
        modelId: "text-embedding-3-small",
        timeoutMs: 15_000
      },
      kind: "enabled",
      leaseSeconds: 120,
      recoveryLimit: 100
    };
    const configured = { ...config(indexing), runtime: "production" as const };
    const composition = createWorkerComposition(configured);

    expect(mocks.createPostgres).toHaveBeenCalledWith(indexing.database);
    expect(mocks.createEmbedding).toHaveBeenCalledWith(indexing.embedding);
    const drainOptions: unknown = mocks.createDrain.mock.calls[0]?.[0];
    expect(drainOptions).toMatchObject({
      claimLimit: 4,
      concurrency: 2,
      cryptoForAuthority: mocks.createCrypto,
      embeddingDimensions: 1_536,
      embeddingMaxInputBytes: 24_576,
      embeddingModelId: "text-embedding-3-small",
      leaseSeconds: 120,
      recoveryLimit: 100
    });
    expect(drainOptions).toHaveProperty("workerId");
    if (drainOptions === null || typeof drainOptions !== "object") {
      throw new TypeError("Expected drain composition options");
    }
    expect((drainOptions as Record<string, unknown>).workerId).toMatch(/^index-[0-9a-f-]{36}$/u);
    const workerAppOptions: unknown = mocks.createWorkerApp.mock.calls[0]?.[0];
    expect(workerAppOptions).toMatchObject({ config: configured });
    expect(workerAppOptions).toHaveProperty("drain");
    await composition.close();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("rejects executable indexing with a synthetic non-production authority", () => {
    const indexing: Extract<WorkerConfig["indexing"], { kind: "enabled" }> = {
      claimLimit: 1,
      concurrency: 1,
      database: {
        caPem: "test-ca",
        connectTimeoutMs: 5_000,
        expectedHost: "db.example.supabase.co",
        projectRef: "abcdefghijklmnopqrst",
        statementTimeoutMs: 5_000,
        url: "redacted-url"
      },
      embedding: {
        apiKey: "redacted-key",
        dimensions: 1_536,
        kind: "openai",
        maxInputBytes: 24_576,
        modelId: "text-embedding-3-small",
        timeoutMs: 5_000
      },
      kind: "enabled",
      leaseSeconds: 120,
      recoveryLimit: 100
    };

    expect(() => createWorkerComposition(config(indexing))).toThrow("UNFILED_WORKER_ENV");
    expect(mocks.createPostgres).not.toHaveBeenCalled();
  });

  it("adds the exact production invocation verifier without changing indexing composition", () => {
    const trustedSource = {
      audience: "https://vercel.com/team-example",
      environment: "production" as const,
      expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
      issuer: "https://oidc.vercel.com/team-example",
      ownerId: "team_owner",
      projectId: "prj_web",
      projectName: "unfiled-web",
      teamSlug: "team-example"
    };
    const configured: WorkerConfig = {
      ...config({ kind: "disabled" }),
      invocationAuth: {
        kind: "production-verifier",
        trustedSource
      },
      runtime: "production"
    };
    createWorkerComposition(configured);
    expect(mocks.createInvocationAuth).toHaveBeenCalledWith({
      trustedSource
    });
    expect(mocks.createWorkerApp).toHaveBeenCalledWith(
      expect.objectContaining({ productionInvocationAuth: { auth: true } })
    );
  });
});
