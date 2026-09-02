import { describe, expect, it } from "vitest";

import {
  RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS,
  RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
} from "@unfiled/contracts";

import {
  RAG_VERIFICATION_DATABASE_CONNECTION_ATTEMPTS,
  RAG_VERIFICATION_MAX_PAGES,
  RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET,
  RAG_VERIFICATION_PAGE_LIMIT
} from "../src/capacity";
import {
  loadVerifierConfig,
  VERIFIER_CAPABILITIES,
  VERIFIER_REQUEST_DEFAULT_TIMEOUT_MS,
  VERIFIER_REQUEST_MAX_TIMEOUT_MS,
  verifierCapacityProcessingBudgetMs,
  verifierMinimumRequestBudgetMs
} from "../src/config";

const ACTIVE_ROOT = "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555";
const RETIRED_ROOT = "arn:aws:kms:us-west-2:123456789012:key/66666666-7777-4888-9999-aaaaaaaaaaaa";
const PROJECT_REF = "abcdefghijklmnopqrst";
const HOST = "aws-0-us-west-2.pooler.supabase.com";
const SENSITIVE_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-2222-4333-8444-555555555555";

function certificate(): string {
  return `-----BEGIN CERTIFICATE-----\n${"A".repeat(80)}\n-----END CERTIFICATE-----\n`;
}

function productionEnvironment(): Record<string, string> {
  return {
    UNFILED_KEY_CUSTODIAN: "aws-kms",
    UNFILED_VERIFIER_ENV: "production",
    VERCEL: "1",
    VERCEL_DEPLOYMENT_ID: "dpl_verifierproduction123",
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    VERCEL_PROJECT_ID: "prj_verifier123",
    UNFILED_AWS_REGION: "us-west-2",
    UNFILED_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/unfiled-verifier-production",
    UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN: ACTIVE_ROOT,
    UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: JSON.stringify([RETIRED_ROOT]),
    UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT:
      "owner:team-example:project:unfiled-verifier:environment:production",
    UNFILED_VERIFIER_PROJECT_ID: "prj_verifier123",
    UNFILED_TRUSTED_SOURCE_TEAM_SLUG: "team-example",
    UNFILED_TRUSTED_SOURCE_OWNER_ID: "team_owner123",
    UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID: "prj_web123",
    UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME: "unfiled-web",
    UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT:
      "owner:team-example:project:unfiled-web:environment:production",
    UNFILED_VERIFIER_DATABASE_URL: `postgresql://unfiled_rag_verifier.${PROJECT_REF}:dedicated-verifier-password@${HOST}:6543/postgres?sslmode=verify-full`,
    UNFILED_VERIFIER_DATABASE_EXPECTED_HOST: HOST,
    UNFILED_VERIFIER_DATABASE_PROJECT_REF: PROJECT_REF,
    UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64: Buffer.from(certificate()).toString("base64")
  };
}

function previewEnvironment(): Record<string, string> {
  return {
    ...productionEnvironment(),
    UNFILED_VERIFIER_ENV: "preview",
    UNFILED_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/unfiled-verifier-preview",
    UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN:
      "arn:aws:kms:us-west-2:123456789012:key/22222222-3333-4444-8555-666666666666",
    UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: JSON.stringify([
      "arn:aws:kms:us-west-2:123456789012:key/77777777-8888-4999-8aaa-bbbbbbbbbbbb"
    ]),
    UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT:
      "owner:team-example:project:unfiled-verifier:environment:preview",
    UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT:
      "owner:team-example:project:unfiled-web:environment:preview",
    VERCEL_DEPLOYMENT_ID: "dpl_verifierpreview123",
    VERCEL_ENV: "preview"
  };
}

describe("verifier configuration", () => {
  it("keeps only local execution disabled without accepting cloud capabilities", () => {
    expect(loadVerifierConfig({ UNFILED_VERIFIER_ENV: "local" })).toMatchObject({
      maxRequestBytes: 1_024,
      port: 8_789,
      releaseIdentity: null,
      requestTimeoutMs: 49_000,
      runtime: "local",
      verification: { kind: "disabled" }
    });
    expect(VERIFIER_CAPABILITIES).toEqual({
      acceptsUserSessions: false,
      decryptKeyClasses: ["ai_assisted"],
      decryptKeyPurposes: ["object_wrap"],
      generatesDataKeys: false,
      mutatesIndexRows: false,
      rendersUserInterface: false
    });
  });

  it("loads Preview through its exact managed database, caller, and KMS boundary", () => {
    const config = loadVerifierConfig(previewEnvironment());
    expect(config).toMatchObject({
      runtime: "preview",
      releaseIdentity: { environment: "preview" },
      verification: {
        kind: "enabled",
        invocation: {
          environment: "preview",
          expectedSubject: "owner:team-example:project:unfiled-web:environment:preview"
        },
        kms: {
          expectedOidcSubject: "owner:team-example:project:unfiled-verifier:environment:preview",
          roleArn: "arn:aws:iam::123456789012:role/unfiled-verifier-preview"
        }
      }
    });
  });

  it("loads the exact production database, caller, and decrypt-only KMS boundary", () => {
    const config = loadVerifierConfig(productionEnvironment());
    expect(config.runtime).toBe("production");
    expect(config.releaseIdentity).toEqual({
      commit: "c".repeat(40),
      deployment: "sha256:0755a0999c296cb44007caf77f542d1262b5ba86b3b1ab42d3bd46909ac3ede1",
      environment: "production"
    });
    expect(config.verification).toMatchObject({
      kind: "enabled",
      decryptConcurrency: 8,
      database: {
        connectTimeoutMs: 2_000,
        expectedHost: HOST,
        projectRef: PROJECT_REF,
        statementTimeoutMs: 250
      },
      invocation: {
        audience: "https://vercel.com/team-example",
        issuer: "https://oidc.vercel.com/team-example",
        projectId: "prj_web123"
      },
      kms: {
        activeObjectWrapRootArn: ACTIVE_ROOT,
        oidcAudience: "sts.amazonaws.com",
        retiredObjectWrapRootArns: [RETIRED_ROOT],
        timeoutMs: 2_000,
        vercelProjectId: "prj_verifier123"
      }
    });
    if (config.verification.kind !== "enabled") throw new Error("expected enabled config");
    expect(config.verification.database.caPem).toBe(certificate());
    expect(config.verification.kms.maxKeyRecords).toBe(
      RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS
    );
    expect(RAG_VERIFICATION_MAX_PAGES).toBe(33);
    expect(RAG_VERIFICATION_DATABASE_CONNECTION_ATTEMPTS).toBe(2);
    expect(
      RAG_VERIFICATION_MAX_PAGES *
        Math.floor(RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET / 262_160)
    ).toBeGreaterThanOrEqual(RAG_GENERATION_VERIFICATION_NOTE_CAPACITY);
    expect(RAG_GENERATION_VERIFICATION_NOTE_CAPACITY).toBe(1_000);
    expect(RAG_VERIFICATION_PAGE_LIMIT).toBe(50);
  });

  it("loads decrypt-only Vercel sensitive-environment custody without AWS identity", () => {
    const environment: Record<string, string | undefined> = productionEnvironment();
    environment.UNFILED_KEY_CUSTODIAN = "vercel-sensitive-env-v1";
    environment.UNFILED_AWS_REGION = undefined;
    environment.UNFILED_AWS_ROLE_ARN = undefined;
    environment.UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN = undefined;
    environment.UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON = undefined;
    environment.UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT = undefined;
    environment.UNFILED_VERIFIER_AI_OBJECT_WRAP_ROOT_KEY_ID = SENSITIVE_ROOT;
    environment.UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1 = '{"version":1}';

    expect(loadVerifierConfig(environment)).toMatchObject({
      verification: {
        kind: "enabled",
        kms: {
          activeObjectWrapRootKeyId: SENSITIVE_ROOT,
          deploymentEnvironment: "production",
          kind: "vercel-sensitive-env-v1",
          retiredObjectWrapRootKeyIds: []
        }
      }
    });
  });

  it.each([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AUTH_SECRET",
    "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN",
    "UNFILED_OPENAI_EMBEDDING_API_KEY",
    "UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN",
    "UNFILED_WORKER_DATABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DATABASE_URL",
    "PGPASSWORD"
  ])("rejects forbidden ambient capability %s", (name) => {
    expect(() => loadVerifierConfig({ UNFILED_VERIFIER_ENV: "local", [name]: "canary" })).toThrow(
      name
    );
  });

  it.each([
    "UNFILED_VERIFIER_MAX_PAGES",
    "UNFILED_VERIFIER_PAGE_LIMIT",
    "UNFILED_VERIFIER_PAGE_CIPHERTEXT_BYTE_BUDGET"
  ])("rejects capacity override %s in every runtime", (name) => {
    expect(() => loadVerifierConfig({ UNFILED_VERIFIER_ENV: "local", [name]: "1" })).toThrow(name);
    expect(() => loadVerifierConfig({ ...productionEnvironment(), [name]: "1" })).toThrow(name);
  });

  it("rejects an incomplete Preview cloud boundary instead of falling back", () => {
    expect(() =>
      loadVerifierConfig({
        ...previewEnvironment(),
        UNFILED_VERIFIER_DATABASE_URL: undefined
      })
    ).toThrow("UNFILED_VERIFIER_DATABASE_URL");
  });

  it("rejects missing Vercel identity and cross-environment Preview subjects", () => {
    expect(() => loadVerifierConfig({ ...previewEnvironment(), VERCEL: undefined })).toThrow(
      "VERCEL_ENV"
    );
    expect(() =>
      loadVerifierConfig({ ...previewEnvironment(), VERCEL_DEPLOYMENT_ID: undefined })
    ).toThrow("VERCEL_DEPLOYMENT_ID");
    expect(() =>
      loadVerifierConfig({ ...previewEnvironment(), VERCEL_GIT_COMMIT_SHA: "C".repeat(40) })
    ).toThrow("VERCEL_GIT_COMMIT_SHA");
    expect(() =>
      loadVerifierConfig({ ...previewEnvironment(), VERCEL_DEPLOYMENT_ID: "unsafe/value" })
    ).toThrow("VERCEL_DEPLOYMENT_ID");
    expect(() =>
      loadVerifierConfig({
        ...previewEnvironment(),
        UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT:
          "owner:team-example:project:unfiled-verifier:environment:production"
      })
    ).toThrow("UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT");
  });

  it.each([
    [{}, "UNFILED_VERIFIER_ENV"],
    [{ UNFILED_VERIFIER_ENV: "invalid" }, "UNFILED_VERIFIER_ENV"],
    [{ UNFILED_VERIFIER_ENV: "production", VERCEL_ENV: "preview" }, "UNFILED_VERIFIER_ENV"],
    [{ UNFILED_VERIFIER_ENV: "local", VERCEL: "1" }, "VERCEL_ENV"],
    [
      { UNFILED_VERIFIER_ENV: "local", VERCEL_DEPLOYMENT_ID: "dpl_localmustnotexist" },
      "VERCEL_DEPLOYMENT_ID"
    ],
    [{ UNFILED_VERIFIER_ENV: "local", VERCEL_ENV: "production" }, "VERCEL_ENV"],
    [
      { UNFILED_VERIFIER_ENV: "local", UNFILED_VERIFIER_TIMEOUT_MS: "999" },
      "UNFILED_VERIFIER_TIMEOUT_MS"
    ],
    [
      { UNFILED_VERIFIER_ENV: "local", UNFILED_VERIFIER_MAX_REQUEST_BYTES: "bad" },
      "UNFILED_VERIFIER_MAX_REQUEST_BYTES"
    ]
  ])("rejects invalid base runtime config", (environment, variable) => {
    expect(() => loadVerifierConfig(environment)).toThrow(variable);
  });

  it.each([
    ["UNFILED_AWS_REGION", "moon-1", "UNFILED_AWS_REGION"],
    ["UNFILED_AWS_ROLE_ARN", "bad-role", "UNFILED_AWS_ROLE_ARN"],
    ["UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN", "alias/key", "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN"],
    [
      "UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT",
      "owner:other:project:x:environment:preview",
      "UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT"
    ],
    ["UNFILED_VERIFIER_PROJECT_ID", "prj_wrong", "UNFILED_VERIFIER_PROJECT_ID"],
    ["UNFILED_TRUSTED_SOURCE_TEAM_SLUG", "other-team", "UNFILED_TRUSTED_SOURCE_TEAM_SLUG"],
    ["UNFILED_TRUSTED_SOURCE_OWNER_ID", "owner", "UNFILED_TRUSTED_SOURCE_OWNER_ID"],
    [
      "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID",
      "prj_verifier123",
      "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID"
    ],
    [
      "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME",
      "unfiled-verifier",
      "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME"
    ],
    [
      "UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT",
      "owner:team-example:project:wrong:environment:production",
      "UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT"
    ],
    [
      "UNFILED_VERIFIER_DATABASE_EXPECTED_HOST",
      "bad host",
      "UNFILED_VERIFIER_DATABASE_EXPECTED_HOST"
    ],
    ["UNFILED_VERIFIER_DATABASE_PROJECT_REF", "short", "UNFILED_VERIFIER_DATABASE_PROJECT_REF"]
  ])("rejects invalid production variable %s", (name, value, expected) => {
    const environment = productionEnvironment();
    environment[name] = value;
    expect(() => loadVerifierConfig(environment)).toThrow(expected);
  });

  it("rejects malformed, duplicate, active, cross-account, and excessive retired roots", () => {
    const values: unknown[] = [
      "not-json",
      {},
      [ACTIVE_ROOT],
      [RETIRED_ROOT, RETIRED_ROOT],
      [RETIRED_ROOT.replace("123456789012", "999999999999")],
      Array.from({ length: 21 }, (_, index) =>
        RETIRED_ROOT.replace("66666666", String(index).padStart(8, "0"))
      )
    ];
    for (const value of values) {
      const environment = productionEnvironment();
      environment.UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON =
        typeof value === "string" ? value : JSON.stringify(value);
      expect(() => loadVerifierConfig(environment)).toThrow(
        "UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON"
      );
    }
  });

  it("rejects invalid CA and database URL bounds", () => {
    const invalidCa = productionEnvironment();
    invalidCa.UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64 = "not-base64!";
    expect(() => loadVerifierConfig(invalidCa)).toThrow("UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64");

    const shortCa = productionEnvironment();
    shortCa.UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64 = Buffer.from("small").toString("base64");
    expect(() => loadVerifierConfig(shortCa)).toThrow("UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64");

    const longUrl = productionEnvironment();
    longUrl.UNFILED_VERIFIER_DATABASE_URL = "x".repeat(4_097);
    expect(() => loadVerifierConfig(longUrl)).toThrow("UNFILED_VERIFIER_DATABASE_URL");
  });

  it("rejects timeout compositions that cannot finish their bounded work", () => {
    const environment = productionEnvironment();
    Object.assign(environment, {
      UNFILED_VERIFIER_TIMEOUT_MS: "10000",
      UNFILED_VERIFIER_DATABASE_STATEMENT_TIMEOUT_MS: "5000",
      UNFILED_VERIFIER_KMS_TIMEOUT_MS: "5000",
      UNFILED_VERIFIER_DECRYPT_CONCURRENCY: "1"
    });
    expect(() => loadVerifierConfig(environment)).toThrow("UNFILED_VERIFIER_TIMEOUT_MS");
  });

  it("budgets the fixed maximum of four serial KMS decrypts", () => {
    expect(verifierCapacityProcessingBudgetMs(8)).toBe(18_000);
    expect(verifierCapacityProcessingBudgetMs(4)).toBe(36_000);
    expect(
      verifierMinimumRequestBudgetMs({
        connectTimeoutMs: 2_000,
        decryptConcurrency: 8,
        kmsTimeoutMs: 2_000,
        statementTimeoutMs: 250
      })
    ).toBe(49_000);

    const belowWorstCase = productionEnvironment();
    belowWorstCase.UNFILED_VERIFIER_TIMEOUT_MS = "48999";
    expect(() => loadVerifierConfig(belowWorstCase)).toThrow("UNFILED_VERIFIER_TIMEOUT_MS");

    const exactWorstCase = productionEnvironment();
    exactWorstCase.UNFILED_VERIFIER_TIMEOUT_MS = "49000";
    expect(loadVerifierConfig(exactWorstCase).requestTimeoutMs).toBe(49_000);
    expect(VERIFIER_REQUEST_DEFAULT_TIMEOUT_MS).toBe(49_000);
    expect(VERIFIER_REQUEST_MAX_TIMEOUT_MS).toBe(49_000);

    const aboveServerCeiling = productionEnvironment();
    aboveServerCeiling.UNFILED_VERIFIER_TIMEOUT_MS = "49001";
    expect(() => loadVerifierConfig(aboveServerCeiling)).toThrow("UNFILED_VERIFIER_TIMEOUT_MS");
    expect(() => verifierCapacityProcessingBudgetMs(0)).toThrow(
      "UNFILED_VERIFIER_DECRYPT_CONCURRENCY"
    );
  });

  it("rejects a Trusted Source subject whose team or project disagrees with its parts", () => {
    const teamMismatch = productionEnvironment();
    teamMismatch.UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT =
      "owner:other-team:project:unfiled-web:environment:production";
    expect(() => loadVerifierConfig(teamMismatch)).toThrow("UNFILED_TRUSTED_SOURCE_TEAM_SLUG");

    const projectMismatch = productionEnvironment();
    projectMismatch.UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT =
      "owner:team-example:project:other-web:environment:production";
    expect(() => loadVerifierConfig(projectMismatch)).toThrow(
      "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME"
    );
  });

  it("rejects ambiguous, malformed, or cross-environment Vercel sensitive-environment custody", () => {
    const previewRoot =
      "urn:unfiled:key-root:vercel-sensitive-env-v1:preview:22222222-2222-4222-8222-222222222222";
    const retiredRoot =
      "urn:unfiled:key-root:vercel-sensitive-env-v1:production:33333333-3333-4333-8333-333333333333";
    const retiredVariable = "UNFILED_VERIFIER_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON";
    type Environment = Record<string, string | undefined>;
    const sensitive = (overrides: Environment = {}): Environment => ({
      ...productionEnvironment(),
      UNFILED_KEY_CUSTODIAN: "vercel-sensitive-env-v1",
      UNFILED_AWS_REGION: undefined,
      UNFILED_AWS_ROLE_ARN: undefined,
      UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN: undefined,
      UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: undefined,
      UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT: undefined,
      UNFILED_VERIFIER_AI_OBJECT_WRAP_ROOT_KEY_ID: SENSITIVE_ROOT,
      UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: '{"version":1}',
      ...overrides
    });

    expect(
      loadVerifierConfig(sensitive({ [retiredVariable]: JSON.stringify([retiredRoot]) }))
    ).toMatchObject({
      verification: { kms: { retiredObjectWrapRootKeyIds: [retiredRoot] } }
    });

    const rejected: readonly (readonly [string, Environment])[] = [
      ["UNFILED_KEY_CUSTODIAN", { UNFILED_KEY_CUSTODIAN: "local" }],
      ["UNFILED_KEY_CUSTODIAN", { UNFILED_KEY_CUSTODIAN: " vercel-sensitive-env-v1" }],
      ["UNFILED_AWS_REGION", { UNFILED_AWS_REGION: "us-west-2" }],
      ["UNFILED_VERIFIER_PROJECT_ID", { VERCEL_PROJECT_ID: "prj_other" }],
      ["UNFILED_VERIFIER_PROJECT_ID", { UNFILED_VERIFIER_PROJECT_ID: "prj_verifier123 " }],
      [
        "UNFILED_VERIFIER_AI_OBJECT_WRAP_ROOT_KEY_ID",
        { UNFILED_VERIFIER_AI_OBJECT_WRAP_ROOT_KEY_ID: previewRoot }
      ],
      [
        "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1",
        { UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: "x".repeat(32_769) }
      ],
      [
        "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1",
        { UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: undefined }
      ],
      [retiredVariable, { [retiredVariable]: " []" }],
      [retiredVariable, { [retiredVariable]: "[" }],
      [retiredVariable, { [retiredVariable]: "{}" }],
      [retiredVariable, { [retiredVariable]: "[ ]" }],
      [retiredVariable, { [retiredVariable]: "[1]" }],
      [retiredVariable, { [retiredVariable]: JSON.stringify([SENSITIVE_ROOT]) }],
      [retiredVariable, { [retiredVariable]: JSON.stringify([previewRoot]) }],
      [retiredVariable, { [retiredVariable]: JSON.stringify([retiredRoot, retiredRoot]) }]
    ];
    for (const [name, overrides] of rejected) {
      expect(() => loadVerifierConfig(sensitive(overrides))).toThrow(name);
    }

    expect(() =>
      loadVerifierConfig({
        ...productionEnvironment(),
        UNFILED_VERIFIER_AI_OBJECT_WRAP_ROOT_KEY_ID: SENSITIVE_ROOT
      })
    ).toThrow("UNFILED_VERIFIER_AI_OBJECT_WRAP_ROOT_KEY_ID");
  });
});
