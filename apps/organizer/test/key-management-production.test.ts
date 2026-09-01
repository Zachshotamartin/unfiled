import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateIntermediateKeyRequest,
  IntermediateKeyCustodian,
  KeyCustodyOperationOptions,
  ManagedKeyRecordV1
} from "@unfiled/key-management";

import type { AwsOrganizerKeyBoundary, VercelTrustedSource } from "../src/config.js";
import { OrganizerUnavailableError } from "../src/errors.js";
import { createVercelTrustedSourcesInvocationAuth } from "../src/invocation-auth.js";

const keyMocks = vi.hoisted(() => ({
  assertReadiness: vi.fn((input?: unknown) => {
    void input;
    return Promise.resolve();
  }),
  createCustodian: vi.fn((input?: unknown) => {
    void input;
    return Object.freeze({});
  }),
  createTransport: vi.fn((input?: unknown) => {
    void input;
    return Promise.resolve({ destroy: vi.fn() });
  }),
  verifyOidc: vi.fn()
}));

vi.mock("@unfiled/key-management", () => ({
  assertAiAssistedKmsReadiness: keyMocks.assertReadiness,
  createAwsKmsEnvelopeCustodian: keyMocks.createCustodian,
  createVercelOidcKmsTransport: keyMocks.createTransport
}));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: keyMocks.verifyOidc }));

const {
  createOrganizerKeyManagementAdapter,
  custodianForOrganizerAuthority,
  isOrganizerKeyAuthority
} = await import("../src/key-management.js");

const objectRoot = "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555";
const contentMacRoot =
  "arn:aws:kms:us-west-2:123456789012:key/66666666-7777-4888-8999-000000000000";
const awsBoundary: AwsOrganizerKeyBoundary = Object.freeze({
  aiContentMacKmsKeyArn: contentMacRoot,
  aiObjectWrapKmsKeyArn: objectRoot,
  expectedOidcSubject: "owner:team-example:project:unfiled-organizer:environment:production",
  kind: "aws-oidc",
  keyClass: "ai_assisted",
  oidcAudience: "sts.amazonaws.com",
  region: "us-west-2",
  retiredRoots: {
    ai_assisted: {
      content_mac: [],
      object_wrap: []
    }
  },
  roleArn: "arn:aws:iam::123456789012:role/unfiled-organizer-production",
  vercelProjectId: "prj_organizerexample"
});
const trustedSource: VercelTrustedSource = Object.freeze({
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_webexample",
  projectName: "unfiled-web",
  teamSlug: "team-example"
});
const keyRequest: CreateIntermediateKeyRequest = Object.freeze({
  createdAt: "2026-08-31T12:00:00.000Z",
  keyClass: "ai_assisted",
  keyId: "11111111-2222-4333-8444-555555555555",
  keyVersion: 1,
  ownerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  predecessorKeyId: null,
  purpose: "object_wrap"
});

function recordingCustodian(calls: {
  generatedSignals: (AbortSignal | undefined)[];
  unwrappedSignals: (AbortSignal | undefined)[];
}): IntermediateKeyCustodian {
  const record = Object.freeze({}) as ManagedKeyRecordV1;
  return Object.freeze({
    withGeneratedIntermediateKey<Result>(
      _request: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, generated: ManagedKeyRecordV1) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      calls.generatedSignals.push(options?.signal);
      return use(new Uint8Array(32), record);
    },
    withUnwrappedIntermediateKey<Result>(
      _record: unknown,
      use: (keyBytes: Uint8Array, parsed: ManagedKeyRecordV1) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      calls.unwrappedSignals.push(options?.signal);
      return use(new Uint8Array(32), record);
    }
  });
}

async function productionInvocation() {
  const now = Math.floor(Date.now() / 1_000);
  keyMocks.verifyOidc.mockResolvedValue({
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

describe("production organizer key-management composition", () => {
  beforeEach(() => {
    keyMocks.assertReadiness.mockReset().mockResolvedValue(undefined);
    keyMocks.createCustodian.mockReset().mockReturnValue(Object.freeze({}));
    keyMocks.createTransport.mockReset().mockResolvedValue({ destroy: vi.fn() });
    keyMocks.verifyOidc.mockReset();
  });

  it("opens only the organizer KMS roots and revokes the request-scoped custodian", async () => {
    let retainedAuthority: Parameters<typeof custodianForOrganizerAuthority>[0] | undefined;
    let retainedFacade: IntermediateKeyCustodian | undefined;
    const closeSawRevoked: boolean[] = [];
    const transport = {
      destroy: vi.fn(() => {
        closeSawRevoked.push(
          retainedAuthority !== undefined && !isOrganizerKeyAuthority(retainedAuthority)
        );
      })
    };
    const calls = {
      generatedSignals: [] as (AbortSignal | undefined)[],
      unwrappedSignals: [] as (AbortSignal | undefined)[]
    };
    const custodian = recordingCustodian(calls);
    keyMocks.createTransport.mockResolvedValueOnce(transport);
    keyMocks.createCustodian.mockReturnValueOnce(custodian);
    const signal = new AbortController().signal;

    const result = await createOrganizerKeyManagementAdapter().withAiAssistedAuthority(
      awsBoundary,
      {
        invocation: await productionInvocation(),
        oidcToken: "workload.header.signature",
        requestId: "request-1",
        runtime: "production"
      },
      signal,
      async (authority) => {
        retainedAuthority = authority;
        retainedFacade = custodianForOrganizerAuthority(authority);
        expect(retainedFacade).not.toBe(custodian);
        await retainedFacade.withGeneratedIntermediateKey(keyRequest, () =>
          Promise.resolve("generated")
        );
        await retainedFacade.withUnwrappedIntermediateKey({}, () => Promise.resolve("unwrapped"));
        return "complete";
      }
    );

    expect(result).toBe("complete");
    expect(keyMocks.createTransport).toHaveBeenCalledWith({
      maxAttempts: 2,
      region: "us-west-2",
      roleArn: awsBoundary.roleArn,
      workload: "organization_worker"
    });
    expect(keyMocks.assertReadiness).toHaveBeenCalledOnce();
    const readinessInput: unknown = keyMocks.assertReadiness.mock.calls[0]?.[0];
    expect(readinessInput).toMatchObject({
      activeRoots: {
        ai_assisted: { content_mac: contentMacRoot, object_wrap: objectRoot }
      },
      signal
    });
    expect(keyMocks.createCustodian).toHaveBeenCalledOnce();
    const custodianInput: unknown = keyMocks.createCustodian.mock.calls[0]?.[0];
    expect(custodianInput).toMatchObject({
      activeRoots: {
        ai_assisted: { content_mac: contentMacRoot, object_wrap: objectRoot }
      },
      retiredRoots: awsBoundary.retiredRoots,
      workload: "organization_worker"
    });
    expect(calls.generatedSignals).toHaveLength(1);
    expect(calls.unwrappedSignals).toHaveLength(1);
    expect(calls.generatedSignals[0]).toBe(calls.unwrappedSignals[0]);
    expect(calls.generatedSignals[0]?.aborted).toBe(true);
    expect(transport.destroy).toHaveBeenCalledOnce();
    expect(closeSawRevoked).toEqual([true]);
    if (retainedAuthority === undefined || retainedFacade === undefined) {
      throw new Error("Expected organizer authority callback to run");
    }
    const releasedAuthority = retainedAuthority;
    expect(() => custodianForOrganizerAuthority(releasedAuthority)).toThrow("not ready");
    await expect(
      retainedFacade.withGeneratedIntermediateKey(keyRequest, () => Promise.resolve("late"))
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
  });

  it("destroys a late transport when request identity expires during credential setup", async () => {
    const lateTransport = { destroy: vi.fn() };
    let resolveTransport!: (value: typeof lateTransport) => void;
    const transportPending = new Promise<typeof lateTransport>((resolve) => {
      resolveTransport = resolve;
    });
    keyMocks.createTransport.mockReturnValueOnce(transportPending);
    const controller = new AbortController();
    const pending = createOrganizerKeyManagementAdapter().withAiAssistedAuthority(
      awsBoundary,
      {
        invocation: await productionInvocation(),
        oidcToken: "workload.header.signature",
        requestId: "request-1",
        runtime: "production"
      },
      controller.signal,
      () => Promise.resolve("must-not-run")
    );
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(OrganizerUnavailableError);
    resolveTransport(lateTransport);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateTransport.destroy).toHaveBeenCalledOnce();
    expect(keyMocks.assertReadiness).not.toHaveBeenCalled();
  });

  it("destroys the transport and withholds authority when readiness fails", async () => {
    const transport = { destroy: vi.fn() };
    const use = vi.fn(() => Promise.resolve());
    keyMocks.createTransport.mockResolvedValueOnce(transport);
    keyMocks.assertReadiness.mockRejectedValueOnce(new Error("provider detail"));

    await expect(
      createOrganizerKeyManagementAdapter().withAiAssistedAuthority(
        awsBoundary,
        {
          invocation: await productionInvocation(),
          oidcToken: "workload.header.signature",
          requestId: "request-1",
          runtime: "production"
        },
        new AbortController().signal,
        use
      )
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
    expect(use).not.toHaveBeenCalled();
    expect(transport.destroy).toHaveBeenCalledOnce();
  });

  it("rejects missing workload OIDC before opening a KMS session", async () => {
    await expect(
      createOrganizerKeyManagementAdapter().withAiAssistedAuthority(
        awsBoundary,
        {
          invocation: await productionInvocation(),
          oidcToken: undefined,
          requestId: "request-1",
          runtime: "production"
        },
        new AbortController().signal,
        () => Promise.resolve()
      )
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
    expect(keyMocks.createTransport).not.toHaveBeenCalled();
  });
});
