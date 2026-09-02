import { describe, expect, it } from "vitest";

import { loadSearchConfig, type SearchEnvironment } from "../src/config.js";

const projectRef = "abcdefghijklmnopqrst";
const poolerHost = "aws-0-us-west-2.pooler.supabase.com";
const caPem = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";
const sensitiveRoot =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-2222-4333-8444-555555555555";

function production(overrides: SearchEnvironment = {}): SearchEnvironment {
  return {
    UNFILED_KEY_CUSTODIAN: "aws-kms",
    VERCEL: "1",
    VERCEL_DEPLOYMENT_ID: "dpl_searchproduction123",
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_SHA: "d".repeat(40),
    VERCEL_PROJECT_ID: "prj_SearchProject123",
    UNFILED_SEARCH_ENV: "production",
    UNFILED_SEARCH_PROJECT_TEAM_SLUG: "unfiled-team",
    UNFILED_SEARCH_PROJECT_NAME: "unfiled-search",
    UNFILED_SEARCH_PROJECT_ID: "prj_SearchProject123",
    UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT:
      "owner:unfiled-team:project:unfiled-search:environment:production",
    UNFILED_AWS_REGION: "us-west-2",
    UNFILED_SEARCH_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/unfiled-production-search",
    UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN:
      "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
    UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: JSON.stringify([
      "arn:aws:kms:us-west-2:123456789012:key/22222222-2222-4222-8222-222222222222"
    ]),
    UNFILED_SEARCH_TRUSTED_SOURCE_TEAM_SLUG: "unfiled-team",
    UNFILED_SEARCH_TRUSTED_SOURCE_OWNER_ID: "team_owner123",
    UNFILED_SEARCH_TRUSTED_SOURCE_WEB_PROJECT_ID: "prj_UnfiledWeb123",
    UNFILED_SEARCH_TRUSTED_SOURCE_WEB_PROJECT_NAME: "unfiled-web",
    UNFILED_SEARCH_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT:
      "owner:unfiled-team:project:unfiled-web:environment:production",
    UNFILED_SEARCH_EMBEDDING_PROVIDER: "openai",
    UNFILED_SEARCH_OPENAI_API_KEY: "sk-search-dedicated-example-key",
    UNFILED_SEARCH_DATABASE_PROJECT_REF: projectRef,
    UNFILED_SEARCH_DATABASE_EXPECTED_HOST: poolerHost,
    UNFILED_SEARCH_DATABASE_URL: `postgresql://unfiled_search_worker.${projectRef}:a-secure-database-password@${poolerHost}:6543/postgres?sslmode=verify-full`,
    UNFILED_SEARCH_DATABASE_CA_PEM_BASE64: Buffer.from(caPem).toString("base64"),
    ...overrides
  };
}

describe("search configuration", () => {
  it("loads only a disabled local health runtime", () => {
    expect(
      loadSearchConfig({
        UNFILED_SEARCH_ENV: "local",
        UNFILED_SEARCH_INVOCATION_SECRET: "a-local-search-secret-with-at-least-32-characters"
      })
    ).toMatchObject({
      invocation: { kind: "local-bearer" },
      keyBoundary: { kind: "local-disabled" },
      pipeline: { kind: "disabled" },
      port: 8791,
      releaseIdentity: null,
      requestTimeoutMs: 25_000,
      runtime: "local"
    });
  });

  it("loads an exact production identity, database, provider, and decrypt-only root set", () => {
    expect(loadSearchConfig(production())).toMatchObject({
      invocation: {
        kind: "trusted-source",
        source: {
          environment: "production",
          projectId: "prj_UnfiledWeb123",
          projectName: "unfiled-web"
        }
      },
      keyBoundary: {
        kind: "aws-oidc",
        region: "us-west-2",
        vercelProjectId: "prj_SearchProject123",
        retiredObjectWrapKeyArns: [
          "arn:aws:kms:us-west-2:123456789012:key/22222222-2222-4222-8222-222222222222"
        ]
      },
      pipeline: {
        kind: "enabled",
        database: { caPem, projectRef },
        embedding: {
          dimensions: 1_536,
          kind: "openai",
          modelId: "text-embedding-3-small"
        }
      },
      releaseIdentity: {
        commit: "d".repeat(40),
        deployment: "sha256:3c81c7797b2cf45cfadb5199a0ecde6c767be2f645f64b73f2e5e0a9b8df2781",
        environment: "production"
      },
      runtime: "production"
    });
  });

  it("loads the provider-free local hash profile without an OpenAI key", () => {
    expect(
      loadSearchConfig(
        production({
          UNFILED_SEARCH_EMBEDDING_PROVIDER: "local-hash-v1",
          UNFILED_SEARCH_OPENAI_API_KEY: undefined
        })
      )
    ).toMatchObject({
      pipeline: {
        embedding: {
          dimensions: 512,
          kind: "local-hash-v1",
          modelId: "unfiled-local-hash-v1"
        },
        kind: "enabled"
      }
    });
  });

  it("loads decrypt-only Vercel sensitive-environment custody without AWS identity", () => {
    expect(
      loadSearchConfig(
        production({
          UNFILED_KEY_CUSTODIAN: "vercel-sensitive-env-v1",
          UNFILED_AWS_REGION: undefined,
          UNFILED_SEARCH_AWS_ROLE_ARN: undefined,
          UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN: undefined,
          UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: undefined,
          UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT: undefined,
          UNFILED_SEARCH_PROJECT_TEAM_SLUG: undefined,
          UNFILED_SEARCH_PROJECT_NAME: undefined,
          UNFILED_SEARCH_AI_OBJECT_WRAP_ROOT_KEY_ID: sensitiveRoot,
          UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: '{"version":1}'
        })
      )
    ).toMatchObject({
      keyBoundary: {
        activeObjectWrapRootKeyId: sensitiveRoot,
        deploymentEnvironment: "production",
        kind: "vercel-sensitive-env-v1",
        retiredObjectWrapRootKeyIds: []
      }
    });
  });

  it("supports Preview only when every subject and runtime value matches Preview", () => {
    const environment = production({
      VERCEL_DEPLOYMENT_ID: "dpl_searchpreview123",
      VERCEL_ENV: "preview",
      UNFILED_SEARCH_ENV: "preview",
      UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT:
        "owner:unfiled-team:project:unfiled-search:environment:preview",
      UNFILED_SEARCH_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT:
        "owner:unfiled-team:project:unfiled-web:environment:preview"
    });
    expect(loadSearchConfig(environment)).toMatchObject({
      releaseIdentity: { environment: "preview" },
      runtime: "preview"
    });
  });

  it.each([
    ["ambient application OpenAI key", { OPENAI_API_KEY: "sk-forbidden-ambient-value" }],
    ["service role", { SUPABASE_SERVICE_ROLE_KEY: "forbidden" }],
    ["static AWS credentials", { AWS_ACCESS_KEY_ID: "forbidden" }],
    ["legacy AWS security token", { AWS_SECURITY_TOKEN: "forbidden" }],
    ["shared AWS credentials file", { AWS_SHARED_CREDENTIALS_FILE: "/forbidden" }],
    ["private root", { UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN: "forbidden" }],
    ["generic database", { DATABASE_URL: "postgresql://forbidden" }],
    ["project drift", { VERCEL_PROJECT_ID: "prj_DifferentProject" }],
    ["runtime drift", { VERCEL_ENV: "preview" }],
    ["missing deployment identity", { VERCEL_DEPLOYMENT_ID: undefined }],
    ["malformed deployment identity", { VERCEL_DEPLOYMENT_ID: "unsafe/value" }],
    ["noncanonical commit identity", { VERCEL_GIT_COMMIT_SHA: "D".repeat(40) }],
    ["source subject drift", { UNFILED_SEARCH_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT: "wrong" }],
    ["worker subject drift", { UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT: "wrong" }],
    ["account drift", { UNFILED_SEARCH_AWS_ROLE_ARN: "arn:aws:iam::999999999999:role/search" }],
    ["region drift", { UNFILED_AWS_REGION: "us-east-1" }],
    [
      "active root reused as retired",
      {
        UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: JSON.stringify([
          "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111"
        ])
      }
    ],
    ["malformed CA", { UNFILED_SEARCH_DATABASE_CA_PEM_BASE64: "not-base64!" }],
    ["unsafe provider secret", { UNFILED_SEARCH_OPENAI_API_KEY: "short" }],
    ["unknown embedding provider", { UNFILED_SEARCH_EMBEDDING_PROVIDER: "implicit" }],
    ["OpenAI key in local hash mode", { UNFILED_SEARCH_EMBEDDING_PROVIDER: "local-hash-v1" }],
    ["invalid team slug", { UNFILED_SEARCH_PROJECT_TEAM_SLUG: "Team:Unsafe" }]
  ])("rejects %s", (_name, override) => {
    expect(() => loadSearchConfig(production(override))).toThrow("not configured");
  });

  it("rejects local cloud leakage and unsafe local bounds", () => {
    const local = {
      UNFILED_SEARCH_ENV: "local",
      UNFILED_SEARCH_INVOCATION_SECRET: "a-local-search-secret-with-at-least-32-characters"
    };
    expect(() => loadSearchConfig({ ...local, VERCEL: "1" })).toThrow();
    expect(() =>
      loadSearchConfig({ ...local, VERCEL_DEPLOYMENT_ID: "dpl_localmustnotexist" })
    ).toThrow();
    expect(() => loadSearchConfig({ ...local, OPENAI_API_KEY: "forbidden" })).toThrow();
    expect(() => loadSearchConfig({ ...local, UNFILED_SEARCH_TIMEOUT_MS: "999" })).toThrow();
    expect(() =>
      loadSearchConfig({ ...local, UNFILED_SEARCH_INVOCATION_SECRET: "unsafe secret with spaces" })
    ).toThrow();
  });

  it("rejects ambiguous, malformed, or cross-environment Vercel sensitive-environment custody", () => {
    const previewRoot =
      "urn:unfiled:key-root:vercel-sensitive-env-v1:preview:22222222-2222-4222-8222-222222222222";
    const retiredRoot =
      "urn:unfiled:key-root:vercel-sensitive-env-v1:production:33333333-3333-4333-8333-333333333333";
    const retiredVariable = "UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON";
    const sensitive = (overrides: SearchEnvironment = {}): SearchEnvironment =>
      production({
        UNFILED_KEY_CUSTODIAN: "vercel-sensitive-env-v1",
        UNFILED_AWS_REGION: undefined,
        UNFILED_SEARCH_AWS_ROLE_ARN: undefined,
        UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN: undefined,
        UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON: undefined,
        UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT: undefined,
        UNFILED_SEARCH_PROJECT_TEAM_SLUG: undefined,
        UNFILED_SEARCH_PROJECT_NAME: undefined,
        UNFILED_SEARCH_AI_OBJECT_WRAP_ROOT_KEY_ID: sensitiveRoot,
        UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: '{"version":1}',
        ...overrides
      });

    expect(
      loadSearchConfig(sensitive({ [retiredVariable]: JSON.stringify([retiredRoot]) }))
    ).toMatchObject({ keyBoundary: { retiredObjectWrapRootKeyIds: [retiredRoot] } });

    const rejected: readonly SearchEnvironment[] = [
      { UNFILED_KEY_CUSTODIAN: "local" },
      { UNFILED_KEY_CUSTODIAN: " vercel-sensitive-env-v1" },
      { UNFILED_AWS_REGION: "us-west-2" },
      { VERCEL_PROJECT_ID: "prj_OtherProject1" },
      { UNFILED_SEARCH_PROJECT_ID: "prj_SearchProject123 " },
      { UNFILED_SEARCH_AI_OBJECT_WRAP_ROOT_KEY_ID: previewRoot },
      { UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: "x".repeat(32_769) },
      { UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: undefined },
      { [retiredVariable]: " []" },
      { [retiredVariable]: "[" },
      { [retiredVariable]: "{}" },
      { [retiredVariable]: "[ ]" },
      { [retiredVariable]: "[1]" },
      { [retiredVariable]: JSON.stringify([sensitiveRoot]) },
      { [retiredVariable]: JSON.stringify([previewRoot]) },
      { [retiredVariable]: JSON.stringify([retiredRoot, retiredRoot]) },
      { UNFILED_SEARCH_DATABASE_PROJECT_REF: "short" }
    ];
    for (const overrides of rejected) {
      expect(() => loadSearchConfig(sensitive(overrides))).toThrow("not configured");
    }

    expect(() =>
      loadSearchConfig(production({ UNFILED_SEARCH_AI_OBJECT_WRAP_ROOT_KEY_ID: sensitiveRoot }))
    ).toThrow("not configured");
  });
});
