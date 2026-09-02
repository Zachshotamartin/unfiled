import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  createVercelSensitiveEnvironmentKmsTransport,
  parseManagedKeyRecordV2,
  type CreateIntermediateKeyRequest,
  type ManagedKeyRecordV2
} from "@unfiled/key-management";

import type {
  VercelSensitiveEnvironmentWorkerKeyBoundary,
  VercelTrustedSource
} from "../src/config";
import { WorkerUnavailableError } from "../src/errors";
import { createVercelTrustedSourcesInvocationAuth } from "../src/invocation-auth-adapter";
import {
  createWorkerKeyManagementAdapter,
  custodianForAiAssistedAuthority,
  isAiAssistedKeyAuthority,
  managedKeyRecordParserForAiAssistedAuthority,
  managedKeyRecordParserForWorkerBoundary,
  oidcTokenFromRequest,
  type AiAssistedKeyAuthority,
  type WorkerIdentityProof,
  type WorkerIntermediateKeyCustodian
} from "../src/key-management-adapter";

const oidcMocks = vi.hoisted(() => ({ verifyOidc: vi.fn() }));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: oidcMocks.verifyOidc }));

const PROJECT_ID = "prj_workerbeta123";
const OWNER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RING_VARIABLE = "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1";
const ACTIVE_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-1111-4111-8111-111111111111";
const RETIRED_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:22222222-2222-4222-8222-222222222222";
const PREVIEW_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:preview:33333333-3333-4333-8333-333333333333";
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

type RootEntry = Readonly<{ keyMaterial: string; rootKeyId: string }>;
type RingOptions = Readonly<{
  deploymentEnvironment?: "preview" | "production";
  projectId?: string;
  roots?: readonly RootEntry[];
}>;
type Environment = Readonly<Record<string, string>>;

const trustedSource: VercelTrustedSource = {
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

function boundary(
  overrides: Partial<VercelSensitiveEnvironmentWorkerKeyBoundary> = {}
): VercelSensitiveEnvironmentWorkerKeyBoundary {
  return {
    aiObjectWrapRootKeyId: ACTIVE_ROOT,
    deploymentEnvironment: "production",
    kind: "vercel-sensitive-env-v1",
    keyClass: "ai_assisted",
    retiredRoots: { ai_assisted: { object_wrap: [RETIRED_ROOT] } },
    vercelProjectId: PROJECT_ID,
    ...overrides
  };
}

function request(keyId: string): CreateIntermediateKeyRequest {
  return {
    createdAt: "2026-08-30T12:00:00.000Z",
    keyClass: "ai_assisted",
    keyId,
    keyVersion: 1,
    ownerId: OWNER_ID,
    predecessorKeyId: null,
    purpose: "object_wrap"
  };
}

async function trustedInvocation() {
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
  return createVercelTrustedSourcesInvocationAuth({ trustedSource }).authorize(
    {
      authorizationHeader: null,
      protectionBypassHeader: null,
      requestId: "request-1",
      trustedSourceToken: "source.header.signature"
    },
    new AbortController().signal
  );
}

async function proof(overrides: Partial<WorkerIdentityProof> = {}): Promise<WorkerIdentityProof> {
  return {
    invocation: await trustedInvocation(),
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
    return await custodian.withGeneratedIntermediateKey(request(keyId), (bytes, record) =>
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

describe("worker Vercel sensitive-environment custody composition", () => {
  it("opens the exact project-bound production ring, proves generate and decrypt, and issues generate-capable authority", async () => {
    stubDeployment();
    const retired = await activatedRecord(RETIRED_ROOT, "ai.object-wrap.retired");
    let released:
      | Readonly<{ authority: AiAssistedKeyAuthority; custodian: WorkerIntermediateKeyCustodian }>
      | undefined;

    expect(managedKeyRecordParserForWorkerBoundary(boundary())).toBe(parseManagedKeyRecordV2);
    const result = await createWorkerKeyManagementAdapter().withAiAssistedAuthority(
      boundary(),
      await proof(),
      new AbortController().signal,
      async (authority) => {
        expect(
          isAiAssistedKeyAuthority(authority, { requestId: "request-1", runtime: "production" })
        ).toBe(true);
        expect(managedKeyRecordParserForAiAssistedAuthority(authority)).toBe(
          parseManagedKeyRecordV2
        );
        const custodian = custodianForAiAssistedAuthority(authority);
        released = { authority, custodian };

        const generated = await custodian.withGeneratedIntermediateKey(
          request("ai.object-wrap.v2"),
          (bytes, record) => Promise.resolve({ bytes: new Uint8Array(bytes), record })
        );
        expect(generated.bytes).toHaveLength(32);
        expect(generated.record).toMatchObject({
          custodyProvider: "vercel_sensitive_environment_v1",
          rootKeyId: ACTIVE_ROOT,
          schemaVersion: 2,
          status: "pending"
        });

        const reopened = await custodian.withUnwrappedIntermediateKey(
          { ...generated.record, activatedAt: generated.record.createdAt, status: "active" },
          (bytes) => Promise.resolve(new Uint8Array(bytes))
        );
        expect(reopened).toEqual(generated.bytes);

        const retiredBytes = await custodian.withUnwrappedIntermediateKey(retired.record, (bytes) =>
          Promise.resolve(new Uint8Array(bytes))
        );
        expect(retiredBytes).toEqual(retired.bytes);
        return "opened";
      }
    );

    expect(result).toBe("opened");
    if (released === undefined) throw new Error("Expected the authority callback to run");
    const { authority: releasedAuthority, custodian: releasedCustodian } = released;
    expect(isAiAssistedKeyAuthority(releasedAuthority)).toBe(false);
    expect(() => custodianForAiAssistedAuthority(releasedAuthority)).toThrow(
      WorkerUnavailableError
    );
    await expect(
      releasedCustodian.withUnwrappedIntermediateKey(retired.record, () => Promise.resolve("late"))
    ).rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it("rejects a workload OIDC token or cross-environment proof before opening the ring", async () => {
    stubDeployment();
    const use = vi.fn(() => Promise.resolve("never"));
    const adapter = createWorkerKeyManagementAdapter();

    await expect(
      adapter.withAiAssistedAuthority(
        boundary(),
        await proof({ oidcToken: "workload.header.signature" }),
        new AbortController().signal,
        use
      )
    ).rejects.toBeInstanceOf(WorkerUnavailableError);
    await expect(
      adapter.withAiAssistedAuthority(
        boundary({ deploymentEnvironment: "preview" }),
        await proof(),
        new AbortController().signal,
        use
      )
    ).rejects.toBeInstanceOf(WorkerUnavailableError);

    expect(use).not.toHaveBeenCalled();
    expect(
      oidcTokenFromRequest(
        new Request("https://worker.example/internal/drain", {
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
      "a preview root",
      {},
      ring({
        roots: [
          { keyMaterial: ACTIVE_MATERIAL, rootKeyId: ACTIVE_ROOT },
          { keyMaterial: RETIRED_MATERIAL, rootKeyId: PREVIEW_ROOT }
        ]
      })
    ],
    [
      "a missing retired root",
      {},
      ring({ roots: [{ keyMaterial: ACTIVE_MATERIAL, rootKeyId: ACTIVE_ROOT }] })
    ],
    [
      "malformed root material",
      {},
      ring({
        roots: [
          { keyMaterial: "short", rootKeyId: ACTIVE_ROOT },
          { keyMaterial: RETIRED_MATERIAL, rootKeyId: RETIRED_ROOT }
        ]
      })
    ]
  ] as const)("rejects a ring bound to %s", async (_name, overrides, serializedRing) => {
    stubDeployment(overrides, serializedRing);
    const use = vi.fn(() => Promise.resolve("never"));

    await expect(
      createWorkerKeyManagementAdapter().withAiAssistedAuthority(
        boundary(),
        await proof(),
        new AbortController().signal,
        use
      )
    ).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(use).not.toHaveBeenCalled();
  });

  it.each([
    ["AWS_ACCESS_KEY_ID", "static-aws-credential-present"],
    ["AWS_SESSION_TOKEN", "static-session-token"],
    ["UNFILED_WORKER_AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/unfiled-worker-production"],
    ["UNFILED_LOCAL_KEY_RING_V1", "{}"],
    ["NEXT_PUBLIC_ROOT_KEY_RING", "leaked"],
    ["UNFILED_KEY_CUSTODIAN", "aws-kms"],
    ["VERCEL_ENV", "preview"],
    ["NODE_ENV", "development"]
  ])("rejects colocated or ambiguous custody variable %s", async (name, value) => {
    stubDeployment({ [name]: value });
    const use = vi.fn(() => Promise.resolve("never"));

    await expect(
      createWorkerKeyManagementAdapter().withAiAssistedAuthority(
        boundary(),
        await proof(),
        new AbortController().signal,
        use
      )
    ).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(use).not.toHaveBeenCalled();
  });
});
