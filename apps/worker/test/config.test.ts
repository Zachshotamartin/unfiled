import { describe, expect, it } from "vitest";

import { loadWorkerConfig, WORKER_CAPABILITIES, type WorkerEnvironment } from "../src/config";

const SECRET = "worker-only-drain-secret-with-adequate-length";
const PROJECT_REF = "abcdefghijklmnopqrst";
const DATABASE_HOST = "aws-0-us-west-2.pooler.supabase.com";
const DATABASE_CA = `-----BEGIN CERTIFICATE-----
VGhpcyBpcyBhIHN0cmljdCB0ZXN0LW9ubHkgQ0EgZml4dHVyZSB0aGF0IGlzIG5vdCBhIHJlYWwg
Y2VydGlmaWNhdGUu
-----END CERTIFICATE-----
`;

function local(overrides: WorkerEnvironment = {}): WorkerEnvironment {
  return {
    UNFILED_WORKER_DRAIN_SECRET: SECRET,
    UNFILED_WORKER_ENV: "local",
    ...overrides
  };
}

function production(overrides: WorkerEnvironment = {}): WorkerEnvironment {
  return {
    UNFILED_AWS_REGION: "us-west-2",
    UNFILED_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/unfiled-worker-production",
    UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN:
      "arn:aws:kms:us-west-2:123456789012:key/66666666-7777-4888-9999-aaaaaaaaaaaa",
    UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN:
      "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555",
    UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT:
      "owner:team-example:project:unfiled-web:environment:production",
    UNFILED_TRUSTED_SOURCE_OWNER_ID: "team_owner123",
    UNFILED_TRUSTED_SOURCE_TEAM_SLUG: "team-example",
    UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID: "prj_webexample",
    UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME: "unfiled-web",
    UNFILED_EMBEDDING_DIMENSIONS: "1536",
    UNFILED_EMBEDDING_MODEL_ID: "text-embedding-3-small",
    UNFILED_OPENAI_EMBEDDING_API_KEY: "sk-test-production-key-with-sufficient-length",
    UNFILED_WORKER_DATABASE_CA_PEM_BASE64: Buffer.from(DATABASE_CA).toString("base64"),
    UNFILED_WORKER_DATABASE_EXPECTED_HOST: DATABASE_HOST,
    UNFILED_WORKER_DATABASE_PROJECT_REF: PROJECT_REF,
    UNFILED_WORKER_DATABASE_URL: `postgresql://unfiled_index_worker.${PROJECT_REF}:dedicated-capability@${DATABASE_HOST}:6543/postgres?sslmode=verify-full`,
    UNFILED_WORKER_ENV: "production",
    UNFILED_WORKER_EXPECTED_OIDC_SUBJECT:
      "owner:team-example:project:unfiled-worker:environment:production",
    UNFILED_WORKER_PROJECT_ID: "prj_example",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: "prj_example",
    ...overrides
  };
}

describe("worker environment validation", () => {
  it("loads a bounded local configuration with an AI-only capability", () => {
    expect(loadWorkerConfig(local())).toEqual({
      indexing: { kind: "disabled" },
      invocationAuth: { kind: "bearer", secret: SECRET },
      keyBoundary: { kind: "local-synthetic", keyClass: "ai_assisted" },
      maxRequestBytes: 1_024,
      port: 8_788,
      requestTimeoutMs: 45_000,
      runtime: "local"
    });
    expect(WORKER_CAPABILITIES).toEqual({
      acceptsUserSessions: false,
      decryptKeyClasses: ["ai_assisted"],
      rendersUserInterface: false
    });
  });

  it("loads only an exact production AWS/OIDC boundary", () => {
    const config = loadWorkerConfig(production());

    expect(config.runtime).toBe("production");
    expect(config.indexing).toMatchObject({
      claimLimit: 2,
      concurrency: 2,
      database: {
        connectTimeoutMs: 3_000,
        expectedHost: DATABASE_HOST,
        projectRef: PROJECT_REF,
        statementTimeoutMs: 500
      },
      embedding: {
        dimensions: 1536,
        modelId: "text-embedding-3-small",
        timeoutMs: 10_000
      },
      kind: "enabled",
      leaseSeconds: 120,
      recoveryLimit: 100
    });
    expect(config.invocationAuth).toEqual({
      kind: "production-verifier",
      trustedSource: {
        audience: "https://vercel.com/team-example",
        environment: "production",
        expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
        issuer: "https://oidc.vercel.com/team-example",
        ownerId: "team_owner123",
        projectId: "prj_webexample",
        projectName: "unfiled-web",
        teamSlug: "team-example"
      }
    });
    expect(config.keyBoundary).toEqual({
      aiContentMacKmsKeyArn:
        "arn:aws:kms:us-west-2:123456789012:key/66666666-7777-4888-9999-aaaaaaaaaaaa",
      aiObjectWrapKmsKeyArn:
        "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555",
      expectedOidcSubject: "owner:team-example:project:unfiled-worker:environment:production",
      kind: "aws-oidc",
      keyClass: "ai_assisted",
      oidcAudience: "sts.amazonaws.com",
      region: "us-west-2",
      retiredRoots: { ai_assisted: { content_mac: [], object_wrap: [] } },
      roleArn: "arn:aws:iam::123456789012:role/unfiled-worker-production",
      vercelProjectId: "prj_example"
    });
  });

  it("rejects static AWS credentials, private keys, and user-session capability", () => {
    for (const forbidden of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SECURITY_TOKEN",
      "AWS_PROFILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_SESSION_TOKEN",
      "UNFILED_AI_KMS_KEY_ID",
      "UNFILED_PRIVATE_CONTENT_MAC_KMS_KEY_ARN",
      "UNFILED_PRIVATE_KMS_KEY_ID",
      "UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN",
      "UNFILED_PRIVATE_MANUAL_KMS_KEY_ARN",
      "UNFILED_PRIVATE_KMS_KEY_ARN",
      "UNFILED_PRIVATE_MANUAL_KEK_B64URL",
      "AUTH_SECRET",
      "NEXTAUTH_SECRET",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SERVICE_KEY",
      "SUPABASE_SECRET_KEY",
      "SUPABASE_JWT_SECRET",
      "SUPABASE_DB_PASSWORD",
      "SUPABASE_DATABASE_URL",
      "SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
      "VITE_SUPABASE_SECRET_API_KEY",
      "UNFILED_SUPABASE_SERVICE_ROLE_JWT",
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "DATABASE_URI",
      "POSTGRES_URL",
      "POSTGRES_PRISMA_URL",
      "POSTGRES_URL_NON_POOLING",
      "POSTGRES_PASSWORD",
      "PGPASSWORD",
      "PGHOST_UNPOOLED"
    ]) {
      const canary = "secret-plaintext-canary";
      expect(() => loadWorkerConfig(local({ [forbidden]: canary }))).toThrow(forbidden);
      try {
        loadWorkerConfig(local({ [forbidden]: canary }));
      } catch (error: unknown) {
        expect(String(error)).not.toContain(canary);
      }
    }
  });

  it("enables indexing only with the complete dedicated database and provider boundary", () => {
    expect(() =>
      loadWorkerConfig(
        local({
          UNFILED_WORKER_DATABASE_URL:
            "postgresql://unfiled_organization_worker:capability@db.invalid/unfiled"
        })
      )
    ).toThrow("UNFILED_WORKER_DATABASE_URL");
    expect(loadWorkerConfig(production()).indexing).toMatchObject({ kind: "enabled" });
  });

  it("requires an exact lowercase Supabase project reference for database tenant binding", () => {
    for (const projectRef of ["", "too-short", "ABCDEFGHIJKLMNOPQRST", "abcdefghijklmnopqrs-"]) {
      expect(() =>
        loadWorkerConfig(production({ UNFILED_WORKER_DATABASE_PROJECT_REF: projectRef }))
      ).toThrow("UNFILED_WORKER_DATABASE_PROJECT_REF");
    }
  });

  it("rejects unsafe index tuning and redacts database/provider secrets", () => {
    expect(() => loadWorkerConfig(production({ UNFILED_INDEX_CONCURRENCY: "5" }))).toThrow(
      "UNFILED_INDEX_CONCURRENCY"
    );
    expect(() =>
      loadWorkerConfig(
        production({ UNFILED_INDEX_CLAIM_LIMIT: "1", UNFILED_INDEX_CONCURRENCY: "2" })
      )
    ).toThrow("UNFILED_INDEX_CLAIM_LIMIT");
    expect(() =>
      loadWorkerConfig(
        production({
          UNFILED_WORKER_DATABASE_STATEMENT_TIMEOUT_MS: "1000"
        })
      )
    ).toThrow("UNFILED_WORKER_TIMEOUT_MS");
    expect(() => loadWorkerConfig(production({ UNFILED_WORKER_TIMEOUT_MS: "43249" }))).toThrow(
      "UNFILED_WORKER_TIMEOUT_MS"
    );
    expect(
      loadWorkerConfig(production({ UNFILED_WORKER_TIMEOUT_MS: "43250" })).requestTimeoutMs
    ).toBe(43_250);
    expect(
      loadWorkerConfig(
        production({
          UNFILED_EMBEDDING_TIMEOUT_MS: "8000",
          UNFILED_INDEX_CLAIM_LIMIT: "4",
          UNFILED_INDEX_CONCURRENCY: "4",
          UNFILED_WORKER_DATABASE_CONNECT_TIMEOUT_MS: "500",
          UNFILED_WORKER_DATABASE_STATEMENT_TIMEOUT_MS: "250",
          UNFILED_WORKER_TIMEOUT_MS: "45000"
        })
      ).indexing
    ).toMatchObject({ claimLimit: 4, concurrency: 4 });
    expect(() => loadWorkerConfig(production({ UNFILED_INDEX_LEASE_SECONDS: "30" }))).toThrow(
      "UNFILED_INDEX_LEASE_SECONDS"
    );
    expect(
      loadWorkerConfig(production({ UNFILED_INDEX_LEASE_SECONDS: "50" })).indexing
    ).toMatchObject({ leaseSeconds: 50 });
    const secretCanary = "private-provider-secret-canary";
    try {
      loadWorkerConfig(production({ UNFILED_OPENAI_EMBEDDING_API_KEY: secretCanary }));
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secretCanary);
    }
  });

  it("requires environment-specific secrets and a matching Vercel environment", () => {
    expect(() => loadWorkerConfig(local({ CRON_SECRET: SECRET }))).toThrow("CRON_SECRET");
    expect(() => loadWorkerConfig(production({ UNFILED_WORKER_DRAIN_SECRET: SECRET }))).toThrow(
      "UNFILED_WORKER_DRAIN_SECRET"
    );
    expect(() => loadWorkerConfig(production({ VERCEL_ENV: "preview" }))).toThrow("VERCEL_ENV");
    expect(() => loadWorkerConfig({ UNFILED_WORKER_ENV: "staging" })).toThrow("UNFILED_WORKER_ENV");
  });

  it("rejects database/provider indexing capabilities outside production", () => {
    const productionIndexing = production();
    const localIndexing: Record<string, string | undefined> = { ...productionIndexing };
    delete localIndexing.VERCEL_ENV;
    delete localIndexing.VERCEL_PROJECT_ID;
    localIndexing.UNFILED_WORKER_ENV = "local";
    localIndexing.UNFILED_WORKER_DRAIN_SECRET = SECRET;

    expect(() => loadWorkerConfig(localIndexing)).toThrow("UNFILED_WORKER_DATABASE_URL");
  });

  it("rejects weak or out-of-range local controls", () => {
    expect(() => loadWorkerConfig(local({ UNFILED_WORKER_DRAIN_SECRET: "short" }))).toThrow(
      "UNFILED_WORKER_DRAIN_SECRET"
    );
    expect(() => loadWorkerConfig(local({ UNFILED_WORKER_MAX_REQUEST_BYTES: "0" }))).toThrow(
      "UNFILED_WORKER_MAX_REQUEST_BYTES"
    );
    expect(() => loadWorkerConfig(local({ UNFILED_WORKER_TIMEOUT_MS: "not-a-number" }))).toThrow(
      "UNFILED_WORKER_TIMEOUT_MS"
    );
    expect(() => loadWorkerConfig(local({ PORT: "65536" }))).toThrow("PORT");
  });

  it("rejects mismatched AWS partition, account, region, role, subject, and project identity", () => {
    const invalidCases: readonly WorkerEnvironment[] = [
      { UNFILED_AWS_ROLE_ARN: "not-an-arn" },
      {
        UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN:
          "arn:aws-cn:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555"
      },
      {
        UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN:
          "arn:aws:kms:us-west-2:999999999999:key/11111111-2222-4333-8444-555555555555"
      },
      {
        UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN:
          "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      },
      {
        UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN: "alias/unfiled/ai-assisted/content-mac"
      },
      { UNFILED_WORKER_EXPECTED_OIDC_SUBJECT: "owner:team_example:environment:preview" },
      {
        UNFILED_WORKER_EXPECTED_OIDC_SUBJECT:
          "owner:team_example:project:prj_example:environment:production"
      },
      { VERCEL_PROJECT_ID: "prj_somewhere_else" },
      {
        UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN:
          "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555"
      }
    ];

    for (const invalid of invalidCases) {
      expect(() => loadWorkerConfig(production(invalid))).toThrow();
    }
  });

  it("pins the production Trusted Source to a separate exact web identity", () => {
    const invalidCases: readonly WorkerEnvironment[] = [
      { UNFILED_TRUSTED_SOURCE_TEAM_SLUG: "../team" },
      { UNFILED_TRUSTED_SOURCE_OWNER_ID: "user_owner123" },
      { UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID: "prj_example" },
      { UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME: "unfiled-worker" },
      {
        UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT:
          "owner:team_example:project:another-project:environment:production"
      }
    ];

    for (const invalid of invalidCases) {
      expect(() => loadWorkerConfig(production(invalid))).toThrow();
    }

    expect(
      loadWorkerConfig(
        production({
          UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT:
            "owner:team-example:project:unfiled_web:environment:production",
          UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME: "unfiled_web"
        })
      ).invocationAuth
    ).toMatchObject({
      trustedSource: { projectName: "unfiled_web" }
    });
  });

  it("requires two full KMS key ARNs rather than aliases or raw IDs", () => {
    expect(() =>
      loadWorkerConfig(
        production({ UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN: "alias/unfiled/ai-assisted/object-wrap" })
      )
    ).toThrow("UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
    expect(() =>
      loadWorkerConfig(
        production({
          UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN: "66666666-7777-4888-9999-aaaaaaaaaaaa"
        })
      )
    ).toThrow("UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN");
  });

  it("accepts UUID-shaped AWS KMS key IDs without RFC version or variant constraints", () => {
    const documentedShape =
      "arn:aws:kms:us-west-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab";
    const nonRfcVersionAndVariant =
      "arn:aws:kms:us-west-2:123456789012:key/abcdef12-3456-f890-1234-567890abcdef";

    expect(
      loadWorkerConfig(
        production({
          UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN: nonRfcVersionAndVariant,
          UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN: documentedShape
        })
      ).keyBoundary
    ).toMatchObject({
      aiContentMacKmsKeyArn: nonRfcVersionAndVariant,
      aiObjectWrapKmsKeyArn: documentedShape
    });
  });

  it("accepts only bounded, exact AI-assisted retired-root registry records", () => {
    const retiredObjectWrap =
      "arn:aws:kms:us-west-2:123456789012:key/77777777-7777-4777-8777-777777777777";
    const retiredContentMac =
      "arn:aws:kms:us-west-2:123456789012:key/88888888-8888-4888-8888-888888888888";
    const registry = [
      {
        arn: retiredObjectWrap,
        keyClass: "ai_assisted",
        purpose: "object_wrap",
        status: "retired"
      },
      {
        arn: retiredContentMac,
        keyClass: "ai_assisted",
        purpose: "content_mac",
        status: "retired"
      }
    ];

    expect(
      loadWorkerConfig(
        production({ UNFILED_RETIRED_AI_ROOT_REGISTRY_JSON: JSON.stringify(registry) })
      ).keyBoundary
    ).toMatchObject({
      retiredRoots: {
        ai_assisted: {
          content_mac: [retiredContentMac],
          object_wrap: [retiredObjectWrap]
        }
      }
    });

    const activeObjectWrap = production().UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN;
    const tooMany = Array.from({ length: 21 }, (_value, index) => ({
      arn: `arn:aws:kms:us-west-2:123456789012:key/${String(index + 1).padStart(8, "0")}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      keyClass: "ai_assisted",
      purpose: "object_wrap",
      status: "retired"
    }));
    const invalidRegistries: readonly unknown[] = [
      "not-json",
      {},
      [{ ...registry[0], extra: "not-allowed" }],
      [{ ...registry[0], keyClass: "private_manual" }],
      [{ ...registry[0], status: "staged" }],
      [{ ...registry[0], purpose: "private" }],
      [{ ...registry[0], arn: activeObjectWrap }],
      [{ ...registry[0], arn: retiredContentMac }, { ...registry[1] }],
      [
        {
          ...registry[0],
          arn: "arn:aws:kms:us-east-1:123456789012:key/77777777-7777-4777-8777-777777777777"
        }
      ],
      [
        {
          ...registry[0],
          arn: "arn:aws:kms:us-west-2:999999999999:key/77777777-7777-4777-8777-777777777777"
        }
      ],
      [
        {
          ...registry[0],
          arn: "arn:aws-cn:kms:us-west-2:123456789012:key/77777777-7777-4777-8777-777777777777"
        }
      ],
      tooMany
    ];

    for (const invalid of invalidRegistries) {
      const raw = typeof invalid === "string" ? invalid : JSON.stringify(invalid);
      expect(() =>
        loadWorkerConfig(production({ UNFILED_RETIRED_AI_ROOT_REGISTRY_JSON: raw }))
      ).toThrow("UNFILED_RETIRED_AI_ROOT_REGISTRY_JSON");
    }
  });
});
