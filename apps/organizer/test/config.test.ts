import { describe, expect, it } from "vitest";

import {
  loadOrganizerConfig,
  ORGANIZER_CAPABILITIES,
  type OrganizerEnvironment
} from "../src/config.js";

const objectArn = "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555";
const macArn = "arn:aws:kms:us-west-2:123456789012:key/66666666-7777-4888-8999-000000000000";
const retiredObjectArn =
  "arn:aws:kms:us-west-2:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const pem = "-----BEGIN CERTIFICATE-----\n" + "A".repeat(80) + "\n-----END CERTIFICATE-----\n";
const providerKey = "a".repeat(32);

function local(overrides: OrganizerEnvironment = {}): OrganizerEnvironment {
  return {
    UNFILED_ORGANIZER_ENV: "local",
    UNFILED_ORGANIZER_DRAIN_SECRET: "local-secret-at-least-thirty-two-characters",
    ...overrides
  };
}
function production(overrides: OrganizerEnvironment = {}): OrganizerEnvironment {
  return {
    UNFILED_ORGANIZER_ENV: "production",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: "prj_organizer123",
    UNFILED_AWS_REGION: "us-west-2",
    UNFILED_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/unfiled-organizer-production",
    UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN: objectArn,
    UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN: macArn,
    UNFILED_ORGANIZER_EXPECTED_OIDC_SUBJECT:
      "owner:team-example:project:unfiled-organizer:environment:production",
    UNFILED_ORGANIZER_PROJECT_ID: "prj_organizer123",
    UNFILED_TRUSTED_SOURCE_TEAM_SLUG: "team-example",
    UNFILED_TRUSTED_SOURCE_OWNER_ID: "team_owner123",
    UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID: "prj_web123",
    UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME: "unfiled-web",
    UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT:
      "owner:team-example:project:unfiled-web:environment:production",
    UNFILED_ORGANIZER_DATABASE_URL:
      "postgresql://unfiled_organizer_worker.abcdefghijklmnopqrst:a-secure-database-password@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=verify-full",
    UNFILED_ORGANIZER_DATABASE_EXPECTED_HOST: "aws-0-us-west-2.pooler.supabase.com",
    UNFILED_ORGANIZER_DATABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    UNFILED_ORGANIZER_DATABASE_CA_PEM_BASE64: Buffer.from(pem).toString("base64"),
    UNFILED_ORGANIZER_OPENAI_API_KEY: providerKey,
    ...overrides
  };
}

describe("organizer configuration", () => {
  it("loads a least-privilege local configuration", () => {
    expect(loadOrganizerConfig(local())).toEqual(
      expect.objectContaining({
        runtime: "local",
        port: 8790,
        requestTimeoutMs: 49_000,
        maxRequestBytes: 1_024,
        pipeline: { kind: "disabled" },
        planner: { kind: "disabled" },
        keyBoundary: { kind: "local-synthetic", keyClass: "ai_assisted" }
      })
    );
    expect(ORGANIZER_CAPABILITIES).toEqual(
      expect.objectContaining({
        acceptsUserSessions: false,
        productionPlannerConfigured: true,
        decryptKeyClasses: ["ai_assisted"]
      })
    );
  });
  it("loads an exact production trust boundary", () => {
    const config = loadOrganizerConfig(
      production({
        UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: JSON.stringify([retiredObjectArn])
      })
    );
    expect(config.runtime).toBe("production");
    expect(config.invocationAuth).toMatchObject({
      kind: "production-trusted-source",
      trustedSource: { projectId: "prj_web123", teamSlug: "team-example" }
    });
    expect(config.keyBoundary).toMatchObject({
      kind: "aws-oidc",
      aiObjectWrapKmsKeyArn: objectArn,
      aiContentMacKmsKeyArn: macArn,
      retiredRoots: { ai_assisted: { object_wrap: [retiredObjectArn], content_mac: [] } }
    });
    expect(config.pipeline).toMatchObject({
      kind: "enabled",
      claimLimit: 2,
      concurrency: 2,
      leaseSeconds: 120
    });
    expect(config.planner).toMatchObject({ kind: "openai-responses" });
  });
  it.each([
    ["missing runtime", {}, ["UNFILED_ORGANIZER_ENV"]],
    ["invalid runtime", { UNFILED_ORGANIZER_ENV: "staging" }, ["UNFILED_ORGANIZER_ENV"]],
    [
      "short local secret",
      local({ UNFILED_ORGANIZER_DRAIN_SECRET: "short" }),
      ["UNFILED_ORGANIZER_DRAIN_SECRET"]
    ],
    ["cron secret", local({ CRON_SECRET: "present" }), ["CRON_SECRET"]],
    [
      "production local secret",
      production({ UNFILED_ORGANIZER_DRAIN_SECRET: "x".repeat(32) }),
      ["UNFILED_ORGANIZER_DRAIN_SECRET"]
    ],
    ["static AWS", local({ AWS_ACCESS_KEY_ID: "present" }), ["AWS_ACCESS_KEY_ID"]],
    [
      "private key",
      local({ UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN: objectArn }),
      ["UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN"]
    ],
    ["user session", local({ AUTH_SECRET: "present" }), ["AUTH_SECRET"]],
    ["provider key", local({ OPENAI_API_KEY: "present" }), ["OPENAI_API_KEY"]],
    ["generic BYOK key", local({ UNFILED_BYOK_API_KEY: "present" }), ["UNFILED_BYOK_API_KEY"]],
    ["user BYOK key", local({ USER_BYOK_KEY: "present" }), ["USER_BYOK_KEY"]],
    ["lowercase BYOK key", local({ user_byok_key: "present" }), ["user_byok_key"]],
    [
      "dedicated provider key outside production",
      local({ UNFILED_ORGANIZER_OPENAI_API_KEY: providerKey }),
      ["UNFILED_ORGANIZER_OPENAI_API_KEY"]
    ],
    [
      "provider model override",
      local({ UNFILED_ORGANIZER_OPENAI_MODEL: "gpt-latest" }),
      ["UNFILED_ORGANIZER_OPENAI_MODEL"]
    ],
    ["ambient database", local({ DATABASE_URL: "present" }), ["DATABASE_URL"]],
    [
      "Supabase secret",
      local({ SUPABASE_SERVICE_ROLE_KEY: "present" }),
      ["SUPABASE_SERVICE_ROLE_KEY"]
    ],
    [
      "local database",
      local({ UNFILED_ORGANIZER_DATABASE_URL: "present" }),
      ["UNFILED_ORGANIZER_DATABASE_URL"]
    ]
  ])("rejects %s", (_label, environment, expected) => {
    expect(() => loadOrganizerConfig(environment)).toThrow(expected[0]);
  });
  it("rejects Vercel runtime mismatches", () => {
    expect(() => loadOrganizerConfig(local({ VERCEL_ENV: "preview" }))).toThrow("VERCEL_ENV");
    expect(() => loadOrganizerConfig(production({ VERCEL_ENV: "preview" }))).toThrow("VERCEL_ENV");
  });
  it.each([
    [{ UNFILED_ORGANIZER_OPENAI_API_KEY: undefined }, "UNFILED_ORGANIZER_OPENAI_API_KEY"],
    [{ UNFILED_ORGANIZER_OPENAI_API_KEY: "short" }, "UNFILED_ORGANIZER_OPENAI_API_KEY"],
    [{ UNFILED_ORGANIZER_OPENAI_API_KEY: ` ${providerKey}` }, "UNFILED_ORGANIZER_OPENAI_API_KEY"],
    [{ UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN: objectArn }, "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN"],
    [{ UNFILED_AWS_REGION: "invalid" }, "UNFILED_AWS_REGION"],
    [{ UNFILED_AWS_ROLE_ARN: "arn:invalid" }, "UNFILED_AWS_ROLE_ARN"],
    [{ UNFILED_ORGANIZER_PROJECT_ID: "prj_wrong" }, "UNFILED_ORGANIZER_PROJECT_ID"],
    [
      { UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID: "prj_organizer123" },
      "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID"
    ],
    [
      { UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT: "wrong" },
      "UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT"
    ],
    [
      { UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: "not-json" },
      "UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON"
    ],
    [
      { UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: JSON.stringify([objectArn]) },
      "UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON"
    ],
    [
      { UNFILED_ORGANIZER_DATABASE_CA_PEM_BASE64: "bad" },
      "UNFILED_ORGANIZER_DATABASE_CA_PEM_BASE64"
    ],
    [
      { UNFILED_ORGANIZER_CONCURRENCY: "3", UNFILED_ORGANIZER_CLAIM_LIMIT: "2" },
      "UNFILED_ORGANIZER_CONCURRENCY"
    ],
    [{ UNFILED_ORGANIZER_TIMEOUT_MS: "50000" }, "UNFILED_ORGANIZER_TIMEOUT_MS"]
  ])("rejects malformed production boundary %#", (overrides, variable) => {
    expect(() => loadOrganizerConfig(production(overrides))).toThrow(variable);
  });
  it("validates bounded integer syntax", () => {
    expect(() => loadOrganizerConfig(local({ PORT: "0" }))).toThrow("PORT");
    expect(() => loadOrganizerConfig(local({ PORT: "1.5" }))).toThrow("PORT");
    expect(
      loadOrganizerConfig(local({ PORT: "9000", UNFILED_ORGANIZER_MAX_REQUEST_BYTES: "2048" }))
    ).toMatchObject({ port: 9000, maxRequestBytes: 2048 });
  });
});
