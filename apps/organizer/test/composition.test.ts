import { describe, expect, it } from "vitest";

import { createOrganizerComposition } from "../src/composition.js";
import { loadOrganizerConfig, type OrganizerEnvironment } from "../src/config.js";

const pem = "-----BEGIN CERTIFICATE-----\n" + "A".repeat(80) + "\n-----END CERTIFICATE-----\n";
const sensitiveObjectRoot =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-2222-4333-8444-555555555555";
const sensitiveMacRoot =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:66666666-7777-4888-8999-000000000000";

/** The free private-beta shape: Vercel-sensitive custody, local-hash retrieval, no operator key. */
function byokOnlyProduction(overrides: OrganizerEnvironment = {}): OrganizerEnvironment {
  return {
    UNFILED_KEY_CUSTODIAN: "vercel-sensitive-env-v1",
    UNFILED_ORGANIZER_ENV: "production",
    VERCEL: "1",
    VERCEL_DEPLOYMENT_ID: "dpl_organizerproduction123",
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
    VERCEL_PROJECT_ID: "prj_organizer123",
    UNFILED_ORGANIZER_PROJECT_ID: "prj_organizer123",
    UNFILED_ORGANIZER_AI_OBJECT_WRAP_ROOT_KEY_ID: sensitiveObjectRoot,
    UNFILED_ORGANIZER_AI_CONTENT_MAC_ROOT_KEY_ID: sensitiveMacRoot,
    UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: '{"version":1}',
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
    UNFILED_ORGANIZER_EMBEDDING_PROVIDER: "local-hash-v1",
    ...overrides
  };
}

describe("organizer composition", () => {
  it("builds and closes the fail-closed local deployment composition", async () => {
    const composition = createOrganizerComposition(
      loadOrganizerConfig({
        UNFILED_ORGANIZER_DRAIN_SECRET: "local-secret-at-least-thirty-two-characters",
        UNFILED_ORGANIZER_ENV: "local"
      })
    );
    const health = await composition.app(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ service: "unfiled-organizer", status: "ok" });
    await expect(composition.close()).resolves.toBeUndefined();
  });

  it("builds a BYOK-only managed composition without any operator-funded provider key", async () => {
    const config = loadOrganizerConfig(byokOnlyProduction());
    expect(config.planner).toEqual({
      appDefaultApiKeys: {},
      kind: "lease-bound-provider-registry-v2"
    });
    const composition = createOrganizerComposition(config);
    const health = await composition.app(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(health.headers.get("x-unfiled-environment")).toBe("production");
    await expect(health.text()).resolves.not.toMatch(/sk-|ANTHROPIC|OPENAI/u);
    await expect(composition.close()).resolves.toBeUndefined();
  });

  it("still accepts an optional operator OpenAI key for app-default routing", async () => {
    const composition = createOrganizerComposition(
      loadOrganizerConfig(byokOnlyProduction({ UNFILED_ORGANIZER_OPENAI_API_KEY: "a".repeat(32) }))
    );
    const health = await composition.app(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    await expect(health.text()).resolves.not.toContain("a".repeat(32));
    await expect(composition.close()).resolves.toBeUndefined();
  });
});
