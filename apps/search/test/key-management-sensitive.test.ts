import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  createVercelSensitiveEnvironmentKmsTransport,
  parseManagedKeyRecordV2,
  type ManagedKeyRecordV2
} from "@unfiled/key-management";

const oidcMocks = vi.hoisted(() => ({ verifyOidc: vi.fn() }));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: oidcMocks.verifyOidc }));

import type { SearchConfig, SearchTrustedSource } from "../src/config.js";
import { createSearchInvocationAuth } from "../src/invocation-auth.js";
import {
  createSearchKeyManagementAdapter,
  custodianForSearchAuthority,
  isSearchKeyAuthority,
  managedKeyRecordParserForSearchAuthority,
  managedKeyRecordParserForSearchBoundary,
  oidcTokenFromRequest,
  type SearchDecryptOnlyCustodian,
  type SearchIdentityProof,
  type SearchKeyAuthority
} from "../src/key-management.js";

const PROJECT_ID = "prj_searchbeta123";
const OWNER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RING_VARIABLE = "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1";
const ACTIVE_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-1111-4111-8111-111111111111";
const RETIRED_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:22222222-2222-4222-8222-222222222222";
// Synthetic 32-byte root materials minted for this test process only.
const ACTIVE_MATERIAL = randomBytes(32).toString("base64url");
const RETIRED_MATERIAL = randomBytes(32).toString("base64url");
const HERMETIC_EMPTY_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE",
  "UNFILED_LOCAL_KEY_RING_V1"
] as const;
const UNAVAILABLE = Object.freeze({ code: "provider_unavailable", status: 503 });

type SensitiveBoundary = Extract<
  SearchConfig["keyBoundary"],
  Readonly<{ kind: "vercel-sensitive-env-v1" }>
>;
type RootEntry = Readonly<{ keyMaterial: string; rootKeyId: string }>;
type RingOptions = Readonly<{
  deploymentEnvironment?: "preview" | "production";
  projectId?: string;
  roots?: readonly RootEntry[];
}>;
type Environment = Readonly<Record<string, string>>;

const trustedSource: SearchTrustedSource = {
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_webexample",
  projectName: "unfiled-web",
  teamSlug: "team-example"
};

function ring(options: RingOptions = {}): string {
  return JSON.stringify({
    deploymentEnvironment: options.deploymentEnvironment ?? "production",
    projectId: options.projectId ?? PROJECT_ID,
    roots: options.roots ?? [
      { keyMaterial: ACTIVE_MATERIAL, rootKeyId: ACTIVE_ROOT },
      { keyMaterial: RETIRED_MATERIAL, rootKeyId: RETIRED_ROOT }
    ],
    version: 1
  });
}

function deployment(overrides: Environment = {}, serializedRing = ring()): Environment {
  return {
    NODE_ENV: "production",
    UNFILED_KEY_CUSTODIAN: "vercel-sensitive-env-v1",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: PROJECT_ID,
    [RING_VARIABLE]: serializedRing,
    ...overrides
  };
}

/** The adapter reads process.env, so the deployment identity is stubbed there. */
function stubDeployment(overrides: Environment = {}, serializedRing = ring()): void {
  for (const name of HERMETIC_EMPTY_VARIABLES) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(deployment(overrides, serializedRing))) {
    vi.stubEnv(name, value);
  }
}

function boundary(overrides: Partial<SensitiveBoundary> = {}): SensitiveBoundary {
  return {
    activeObjectWrapRootKeyId: ACTIVE_ROOT,
    deploymentEnvironment: "production",
    kind: "vercel-sensitive-env-v1",
    retiredObjectWrapRootKeyIds: [RETIRED_ROOT],
    vercelProjectId: PROJECT_ID,
    ...overrides
  };
}

async function invocation() {
  const now = Math.floor(Date.now() / 1_000);
  oidcMocks.verifyOidc.mockResolvedValue({
    payload: {
      aud: trustedSource.audience,
      environment: trustedSource.environment,
      exp: now + 300,
      iat: now,
      iss: trustedSource.issuer,
      nbf: now,
      owner: trustedSource.teamSlug,
      owner_id: trustedSource.ownerId,
      project: trustedSource.projectName,
      project_id: trustedSource.projectId,
      sub: trustedSource.expectedSubject
    },
    protectedHeader: { alg: "RS256" }
  });
  return await createSearchInvocationAuth(trustedSource).authorize(
    {
      authorizationHeader: null,
      protectionBypassHeader: null,
      requestId: "request-1",
      trustedSourceToken: "source.header.signature"
    },
    new AbortController().signal
  );
}

async function proof(overrides: Partial<SearchIdentityProof> = {}): Promise<SearchIdentityProof> {
  return {
    invocation: await invocation(),
    oidcToken: undefined,
    requestId: "request-1",
    runtime: "production",
    ...overrides
  };
}

/** Wraps a fresh intermediate key under one ring root and activates it in memory. */
async function activatedRecord(
  rootKeyId: string,
  keyId: string
): Promise<Readonly<{ bytes: Uint8Array; record: ManagedKeyRecordV2 }>> {
  const transport = await createVercelSensitiveEnvironmentKmsTransport({
    environment: deployment(),
    expectedRootKeyIds: [ACTIVE_ROOT, RETIRED_ROOT]
  });
  try {
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: { ai_assisted: { object_wrap: rootKeyId } },
      deploymentEnvironment: "production",
      transport,
      workload: "index_worker"
    });
    return await custodian.withGeneratedIntermediateKey(
      {
        createdAt: "2026-08-30T12:00:00.000Z",
        keyClass: "ai_assisted",
        keyId,
        keyVersion: 1,
        ownerId: OWNER_ID,
        predecessorKeyId: null,
        purpose: "object_wrap"
      },
      (bytes, record) =>
        Promise.resolve({
          bytes: new Uint8Array(bytes),
          record: parseManagedKeyRecordV2({
            ...record,
            activatedAt: record.createdAt,
            status: "active"
          })
        })
    );
  } finally {
    transport.destroy();
  }
}

beforeEach(() => {
  oidcMocks.verifyOidc.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("decrypt-only search Vercel sensitive-environment custody", () => {
  it("opens the exact project-bound ring, unwraps active and retired roots, and exposes no generate capability", async () => {
    stubDeployment();
    const active = await activatedRecord(ACTIVE_ROOT, "ai.object-wrap.v2");
    const retired = await activatedRecord(RETIRED_ROOT, "ai.object-wrap.v1");
    let released:
      | Readonly<{ authority: SearchKeyAuthority; custodian: SearchDecryptOnlyCustodian }>
      | undefined;

    expect(managedKeyRecordParserForSearchBoundary(boundary())).toBe(parseManagedKeyRecordV2);
    const result = await createSearchKeyManagementAdapter().withAiAssistedSearchAuthority(
      boundary(),
      await proof(),
      new AbortController().signal,
      async (authority) => {
        expect(
          isSearchKeyAuthority(authority, { requestId: "request-1", runtime: "production" })
        ).toBe(true);
        expect(managedKeyRecordParserForSearchAuthority(authority)).toBe(parseManagedKeyRecordV2);
        const custodian = custodianForSearchAuthority(authority);
        released = { authority, custodian };
        expect(Object.keys(custodian)).toEqual(["withUnwrappedIntermediateKey"]);
        expect("withGeneratedIntermediateKey" in custodian).toBe(false);

        const activeBytes = await custodian.withUnwrappedIntermediateKey(active.record, (bytes) =>
          Promise.resolve(new Uint8Array(bytes))
        );
        expect(activeBytes).toEqual(active.bytes);
        const retiredBytes = await custodian.withUnwrappedIntermediateKey(retired.record, (bytes) =>
          Promise.resolve(new Uint8Array(bytes))
        );
        expect(retiredBytes).toEqual(retired.bytes);
        await expect(
          custodian.withUnwrappedIntermediateKey(
            { ...active.record, activatedAt: null, status: "pending" },
            () => Promise.resolve("pending")
          )
        ).rejects.toMatchObject({ code: "key_state_invalid" });
        return "opened";
      }
    );

    expect(result).toBe("opened");
    if (released === undefined) throw new Error("Expected the authority callback to run");
    const { authority: releasedAuthority, custodian: releasedCustodian } = released;
    expect(isSearchKeyAuthority(releasedAuthority)).toBe(false);
    expect(() => custodianForSearchAuthority(releasedAuthority)).toThrow();
    await expect(
      releasedCustodian.withUnwrappedIntermediateKey(active.record, () => Promise.resolve("late"))
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it("rejects a workload OIDC token or cross-environment proof before opening the ring", async () => {
    stubDeployment();
    const use = vi.fn(() => Promise.resolve("never"));
    const adapter = createSearchKeyManagementAdapter();

    await expect(
      adapter.withAiAssistedSearchAuthority(
        boundary(),
        await proof({ oidcToken: "workload.header.signature" }),
        new AbortController().signal,
        use
      )
    ).rejects.toMatchObject(UNAVAILABLE);
    await expect(
      adapter.withAiAssistedSearchAuthority(
        boundary({ deploymentEnvironment: "preview" }),
        await proof(),
        new AbortController().signal,
        use
      )
    ).rejects.toMatchObject(UNAVAILABLE);
    expect(use).not.toHaveBeenCalled();
    expect(
      oidcTokenFromRequest(
        new Request("https://search.example/internal/query", {
          headers: { "x-vercel-oidc-token": "header.payload.signature" }
        }),
        boundary()
      )
    ).toBeUndefined();
  });

  it.each([
    ["another project", {}, ring({ projectId: "prj_otherproject123" })],
    ["another Vercel project ID", { VERCEL_PROJECT_ID: "prj_otherproject123" }, ring()],
    ["the preview environment", {}, ring({ deploymentEnvironment: "preview" })],
    [
      "a missing retired root",
      {},
      ring({ roots: [{ keyMaterial: ACTIVE_MATERIAL, rootKeyId: ACTIVE_ROOT }] })
    ],
    ["a static AWS credential", { AWS_SECRET_ACCESS_KEY: "static-secret-access-key" }, ring()],
    [
      "an AWS workload role",
      { UNFILED_SEARCH_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/unfiled-search" },
      ring()
    ],
    ["a local key ring", { UNFILED_LOCAL_KEY_RING_V1: "{}" }, ring()],
    ["public key material", { NEXT_PUBLIC_KEY_MATERIAL: "leaked" }, ring()],
    ["the AWS custodian mode", { UNFILED_KEY_CUSTODIAN: "aws-kms" }, ring()]
  ] as const)("rejects a ring colocated with %s", async (_name, overrides, serializedRing) => {
    stubDeployment(overrides, serializedRing);
    const use = vi.fn(() => Promise.resolve("never"));

    await expect(
      createSearchKeyManagementAdapter().withAiAssistedSearchAuthority(
        boundary(),
        await proof(),
        new AbortController().signal,
        use
      )
    ).rejects.toMatchObject(UNAVAILABLE);
    expect(use).not.toHaveBeenCalled();
  });
});
