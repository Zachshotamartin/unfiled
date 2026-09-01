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

function certificate(): string {
  return `-----BEGIN CERTIFICATE-----\n${"A".repeat(80)}\n-----END CERTIFICATE-----\n`;
}

function productionEnvironment(): Record<string, string> {
  return {
    UNFILED_VERIFIER_ENV: "production",
    VERCEL_ENV: "production",
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

describe("verifier configuration", () => {
  it("keeps local and preview execution disabled without accepting production capabilities", () => {
    expect(loadVerifierConfig({ UNFILED_VERIFIER_ENV: "local" })).toMatchObject({
      maxRequestBytes: 1_024,
      port: 8_789,
      requestTimeoutMs: 49_000,
      runtime: "local",
      verification: { kind: "disabled" }
    });
    expect(
      loadVerifierConfig({
        UNFILED_VERIFIER_ENV: "preview",
        VERCEL_ENV: "preview",
        PORT: "9000",
        UNFILED_VERIFIER_MAX_REQUEST_BYTES: "2048",
        UNFILED_VERIFIER_TIMEOUT_MS: "49000"
      })
    ).toMatchObject({ port: 9_000, runtime: "preview", requestTimeoutMs: 49_000 });
    expect(VERIFIER_CAPABILITIES).toEqual({
      acceptsUserSessions: false,
      decryptKeyClasses: ["ai_assisted"],
      decryptKeyPurposes: ["object_wrap"],
      generatesDataKeys: false,
      mutatesIndexRows: false,
      rendersUserInterface: false
    });
  });

  it("loads the exact production database, caller, and decrypt-only KMS boundary", () => {
    const config = loadVerifierConfig(productionEnvironment());
    expect(config.runtime).toBe("production");
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

  it("rejects production material in a non-production runtime", () => {
    expect(() =>
      loadVerifierConfig({
        UNFILED_VERIFIER_ENV: "preview",
        VERCEL_ENV: "preview",
        UNFILED_VERIFIER_DATABASE_URL: "not-allowed"
      })
    ).toThrow("UNFILED_VERIFIER_DATABASE_URL");
  });

  it.each([
    [{}, "UNFILED_VERIFIER_ENV"],
    [{ UNFILED_VERIFIER_ENV: "invalid" }, "UNFILED_VERIFIER_ENV"],
    [{ UNFILED_VERIFIER_ENV: "production", VERCEL_ENV: "preview" }, "UNFILED_VERIFIER_ENV"],
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
  });
});
