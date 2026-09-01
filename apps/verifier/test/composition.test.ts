import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: vi.fn(),
  close: vi.fn(),
  createApp: vi.fn(),
  createAuth: vi.fn(),
  createKms: vi.fn(),
  createPostgres: vi.fn(),
  createRepository: vi.fn(),
  createVerifier: vi.fn()
}));

vi.mock("../src/database", () => ({
  createGenerationVerificationRepository: mocks.createRepository
}));
vi.mock("../src/http", () => ({ createVerifierApp: mocks.createApp }));
vi.mock("../src/invocation-auth", () => ({
  createProductionInvocationAuth: mocks.createAuth
}));
vi.mock("../src/kms", () => ({ createVerifierKmsAdapter: mocks.createKms }));
vi.mock("../src/postgres", () => ({
  createPostgresVerifierExecutor: mocks.createPostgres
}));
vi.mock("../src/verifier", () => ({ createGenerationVerifier: mocks.createVerifier }));

import type { VerifierConfig } from "../src/config";
import { createVerifierComposition } from "../src/composition";

const postgresExecutor = Object.freeze({ query: vi.fn() });
const repository = Object.freeze({
  attest: vi.fn(),
  preflight: vi.fn(),
  release: vi.fn(),
  readBuildingPage: vi.fn()
});
const verifier = Object.freeze({ verify: vi.fn() });
const invocationAuth = Object.freeze({ authorize: vi.fn() });
const kms = Object.freeze({ withKeySession: vi.fn() });

const disabled: VerifierConfig = {
  maxRequestBytes: 1_024,
  port: 8_789,
  requestTimeoutMs: 50_000,
  runtime: "local",
  verification: { kind: "disabled" }
};

const enabled: VerifierConfig = {
  ...disabled,
  runtime: "production",
  verification: {
    database: {
      caPem: "test-ca",
      connectTimeoutMs: 2_000,
      expectedHost: "db.example.com",
      projectRef: "abcdefghijklmnopqrst",
      statementTimeoutMs: 250,
      url: "redacted-url"
    },
    decryptConcurrency: 8,
    invocation: {
      audience: "https://vercel.com/team-example",
      environment: "production",
      expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
      issuer: "https://oidc.vercel.com/team-example",
      ownerId: "team_owner123",
      projectId: "prj_web123",
      projectName: "unfiled-web",
      teamSlug: "team-example"
    },
    kind: "enabled",
    kms: {
      activeObjectWrapRootArn:
        "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555",
      expectedOidcSubject: "owner:team-example:project:unfiled-verifier:environment:production",
      maxKeyRecords: 4,
      oidcAudience: "sts.amazonaws.com",
      region: "us-west-2",
      retiredObjectWrapRootArns: [],
      roleArn: "arn:aws:iam::123456789012:role/unfiled-verifier-production",
      timeoutMs: 2_000,
      vercelProjectId: "prj_verifier123"
    }
  }
};

describe("verifier production composition", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.createApp.mockReturnValue(mocks.app);
    mocks.createAuth.mockReturnValue(invocationAuth);
    mocks.createKms.mockReturnValue(kms);
    mocks.createPostgres.mockReturnValue({ close: mocks.close, executor: postgresExecutor });
    mocks.createRepository.mockReturnValue(repository);
    mocks.createVerifier.mockReturnValue(verifier);
    mocks.close.mockResolvedValue(undefined);
  });

  it("keeps non-production health composition free of database and KMS capabilities", async () => {
    const composition = createVerifierComposition(disabled);
    expect(composition.app).toBe(mocks.app);
    expect(mocks.createApp).toHaveBeenCalledWith({ config: disabled });
    expect(mocks.createPostgres).not.toHaveBeenCalled();
    expect(mocks.createKms).not.toHaveBeenCalled();
    await expect(composition.close()).resolves.toBeUndefined();
  });

  it("wires only the dedicated repository, strict verifier, caller auth, and decrypt adapter", async () => {
    const composition = createVerifierComposition(enabled);
    if (enabled.verification.kind !== "enabled") throw new Error("expected enabled fixture");
    expect(mocks.createPostgres).toHaveBeenCalledWith(enabled.verification.database);
    expect(mocks.createRepository).toHaveBeenCalledWith(postgresExecutor);
    expect(mocks.createVerifier).toHaveBeenCalledWith({
      decryptConcurrency: 8,
      repository
    });
    expect(mocks.createAuth).toHaveBeenCalledWith(enabled.verification.invocation);
    expect(mocks.createKms).toHaveBeenCalledOnce();
    expect(mocks.createApp).toHaveBeenCalledWith({
      config: enabled,
      kms,
      productionInvocationAuth: invocationAuth,
      verifier
    });
    await composition.close();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
