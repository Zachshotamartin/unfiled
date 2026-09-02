import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  createVercelSensitiveEnvironmentKmsTransport,
  parseManagedKeyRecordV2,
  type ManagedKeyRecordV2
} from "@unfiled/key-management";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: mocks.verify }));

import type {
  VercelSensitiveEnvironmentVerifierKeyConfig,
  VercelTrustedSource
} from "../src/config";
import { GenerationVerificationError, VerifierUnavailableError } from "../src/errors";
import {
  createProductionInvocationAuth,
  type VerifiedVerifierInvocation
} from "../src/invocation-auth";
import {
  createVerifierKmsAdapter,
  managedKeyRecordParserForVerifierConfig,
  type VerifierKeySession
} from "../src/kms";
import { OWNER_ID, keyRecord } from "./fixtures";

const PROJECT_ID = "prj_verifierbeta123";
const RING_VARIABLE = "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1";
const ACTIVE_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-1111-4111-8111-111111111111";
const RETIRED_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:22222222-2222-4222-8222-222222222222";
const FOREIGN_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:33333333-3333-4333-8333-333333333333";
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
type Proof = Parameters<ReturnType<typeof createVerifierKmsAdapter>["withKeySession"]>[1];

const trustedSource: VercelTrustedSource = {
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_web123",
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

function config(
  overrides: Partial<VercelSensitiveEnvironmentVerifierKeyConfig> = {}
): VercelSensitiveEnvironmentVerifierKeyConfig {
  return {
    activeObjectWrapRootKeyId: ACTIVE_ROOT,
    deploymentEnvironment: "production",
    kind: "vercel-sensitive-env-v1",
    maxKeyRecords: 4,
    retiredObjectWrapRootKeyIds: [RETIRED_ROOT],
    timeoutMs: 2_000,
    vercelProjectId: PROJECT_ID,
    ...overrides
  };
}

async function invocation(): Promise<VerifiedVerifierInvocation> {
  const now = Math.floor(Date.now() / 1_000);
  mocks.verify.mockResolvedValue({
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
  return createProductionInvocationAuth(trustedSource).authorize(
    {
      authorizationHeader: null,
      protectionBypassHeader: null,
      requestId: "request-1",
      trustedSourceToken: "header.payload.signature"
    },
    new AbortController().signal
  );
}

async function proof(overrides: Partial<Proof> = {}): Promise<Proof> {
  return {
    invocation: await invocation(),
    requestId: "request-1",
    runtime: "production",
    ...overrides
  };
}

/** Wraps a fresh intermediate key under one ring root and activates it in memory. */
async function activatedRecord(rootKeyId: string, keyId: string): Promise<ManagedKeyRecordV2> {
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
      (_bytes, record) =>
        Promise.resolve(
          parseManagedKeyRecordV2({ ...record, activatedAt: record.createdAt, status: "active" })
        )
    );
  } finally {
    transport.destroy();
  }
}

function tamper(record: ManagedKeyRecordV2): ManagedKeyRecordV2 {
  const bytes = Buffer.from(record.encryptedKeyMaterial, "base64url");
  bytes[bytes.byteLength - 1] = (bytes[bytes.byteLength - 1] ?? 0) ^ 0x01;
  return { ...record, encryptedKeyMaterial: bytes.toString("base64url") };
}

beforeEach(() => {
  mocks.verify.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("decrypt-only verifier Vercel sensitive-environment session", () => {
  it("unwraps active- and retired-root V2 records, caches one key per identity, and closes with the request", async () => {
    stubDeployment();
    const active = await activatedRecord(ACTIVE_ROOT, "key-ai-object-wrap-v2");
    const retired = await activatedRecord(RETIRED_ROOT, "key-ai-object-wrap-v1");
    const signal = new AbortController().signal;
    let retained: VerifierKeySession | undefined;

    expect(managedKeyRecordParserForVerifierConfig(config())).toBe(parseManagedKeyRecordV2);
    await createVerifierKmsAdapter().withKeySession(
      config(),
      await proof(),
      new AbortController().signal,
      async (session) => {
        retained = session;
        expect(Object.keys(session)).toEqual(["keyFor"]);
        const first = session.keyFor(active, signal);
        const drifted = session.keyFor(
          { ...active, wrapOperations: active.wrapOperations + 1 },
          signal
        );
        expect(drifted).toBe(first);
        await expect(first).resolves.toBeDefined();
        await expect(session.keyFor(retired, signal)).resolves.toBeDefined();
      }
    );

    if (retained === undefined) throw new Error("Expected the session callback to run");
    await expect(retained.keyFor(active, signal)).rejects.toBeInstanceOf(VerifierUnavailableError);
    await expect(
      retained.keyFor(await activatedRecord(ACTIVE_ROOT, "key-ai-object-wrap-v3"), signal)
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
  });

  it("rejects records outside the configured roots, non-decryptable status, V1 shape, drift, and aborted operations", async () => {
    stubDeployment();
    const active = await activatedRecord(ACTIVE_ROOT, "key-ai-object-wrap-v2");
    const retired = await activatedRecord(RETIRED_ROOT, "key-ai-object-wrap-v1");
    const signal = new AbortController().signal;
    const aborted = new AbortController();
    aborted.abort();

    await createVerifierKmsAdapter().withKeySession(
      config(),
      await proof(),
      new AbortController().signal,
      async (session) => {
        await expect(
          session.keyFor({ ...active, rootKeyId: FOREIGN_ROOT }, signal)
        ).rejects.toBeInstanceOf(VerifierUnavailableError);
        await expect(
          session.keyFor({ ...active, activatedAt: null, status: "pending" }, signal)
        ).rejects.toBeInstanceOf(VerifierUnavailableError);
        await expect(session.keyFor(keyRecord(), signal)).rejects.toBeInstanceOf(
          VerifierUnavailableError
        );
        await expect(session.keyFor(active, aborted.signal)).rejects.toBeInstanceOf(
          VerifierUnavailableError
        );
        await expect(session.keyFor(active, signal)).resolves.toBeDefined();
        await expect(
          session.keyFor({ ...active, encryptedKeyMaterial: retired.encryptedKeyMaterial }, signal)
        ).rejects.toBeInstanceOf(VerifierUnavailableError);
      }
    );

    await expect(
      createVerifierKmsAdapter().withKeySession(
        config(),
        await proof(),
        new AbortController().signal,
        (session) => session.keyFor(tamper(active), signal)
      )
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
  });

  it("rejects a fifth logical key identity as a deterministic generation failure", async () => {
    stubDeployment();
    const admitted = await Promise.all(
      [1, 2, 3, 4].map((index) => activatedRecord(ACTIVE_ROOT, `key-ai-object-wrap-${index}`))
    );
    const fifth = await activatedRecord(ACTIVE_ROOT, "key-ai-object-wrap-5");
    const signal = new AbortController().signal;

    await createVerifierKmsAdapter().withKeySession(
      config(),
      await proof(),
      new AbortController().signal,
      async (session) => {
        for (const record of admitted) {
          await expect(session.keyFor(record, signal)).resolves.toBeDefined();
        }
        await expect(session.keyFor(fifth, signal)).rejects.toBeInstanceOf(
          GenerationVerificationError
        );
      }
    );
  });

  it("rejects forged, aborted, and cross-environment proof before opening the ring", async () => {
    stubDeployment();
    const use = vi.fn(() => Promise.resolve("never"));
    const adapter = createVerifierKmsAdapter();
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      adapter.withKeySession(config(), await proof(), aborted.signal, use)
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
    await expect(
      adapter.withKeySession(
        config({ deploymentEnvironment: "preview" }),
        await proof(),
        new AbortController().signal,
        use
      )
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
    await expect(
      adapter.withKeySession(
        config(),
        await proof({ invocation: {} as unknown as VerifiedVerifierInvocation }),
        new AbortController().signal,
        use
      )
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
    expect(use).not.toHaveBeenCalled();
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
    ["a static AWS credential", { AWS_ACCESS_KEY_ID: "static-aws-credential-present" }, ring()],
    [
      "an AWS workload role",
      { UNFILED_VERIFIER_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/unfiled-verifier" },
      ring()
    ],
    ["a local key ring", { UNFILED_LOCAL_KEY_RING_V1: "{}" }, ring()],
    ["the AWS custodian mode", { UNFILED_KEY_CUSTODIAN: "aws-kms" }, ring()],
    ["a non-production Node environment", { NODE_ENV: "development" }, ring()]
  ] as const)("rejects a ring colocated with %s", async (_name, overrides, serializedRing) => {
    stubDeployment(overrides, serializedRing);
    const use = vi.fn(() => Promise.resolve("never"));

    await expect(
      createVerifierKmsAdapter().withKeySession(
        config(),
        await proof(),
        new AbortController().signal,
        use
      )
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
    expect(use).not.toHaveBeenCalled();
  });
});
