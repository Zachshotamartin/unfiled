import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateIntermediateKeyRequest,
  IntermediateKeyCustodian,
  KeyCustodyOperationOptions,
  ManagedKeyRecordV1
} from "@unfiled/key-management";

import type { VercelTrustedSource, WorkerConfig } from "../src/config";
import { createVercelTrustedSourcesInvocationAuth } from "../src/invocation-auth-adapter";
import type { WorkerIntermediateKeyCustodian } from "../src/key-management-adapter";

const keyMocks = vi.hoisted(() => ({
  assertReadiness: vi.fn(() => Promise.resolve()),
  createCustodian: vi.fn(() => Object.freeze({})),
  createTransport: vi.fn(() => Promise.resolve({ destroy: vi.fn() })),
  verifyOidc: vi.fn()
}));

vi.mock("@unfiled/key-management", () => ({
  assertIndexWorkerKmsReadiness: keyMocks.assertReadiness,
  createAwsKmsEnvelopeCustodian: keyMocks.createCustodian,
  createVercelOidcKmsTransport: keyMocks.createTransport,
  parseManagedKeyRecordV1: (value: unknown) => value,
  parseManagedKeyRecordV2: (value: unknown) => value
}));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: keyMocks.verifyOidc }));

const {
  createWorkerKeyManagementAdapter,
  custodianForAiAssistedAuthority,
  isAiAssistedKeyAuthority
} = await import("../src/key-management-adapter");

const awsBoundary: WorkerConfig["keyBoundary"] = {
  aiObjectWrapKmsKeyArn:
    "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555",
  expectedOidcSubject: "owner:team-example:project:unfiled-worker:environment:production",
  kind: "aws-oidc",
  keyClass: "ai_assisted",
  oidcAudience: "sts.amazonaws.com",
  region: "us-west-2",
  retiredRoots: {
    ai_assisted: {
      object_wrap: ["arn:aws:kms:us-west-2:123456789012:key/88888888-8888-4888-8888-888888888888"]
    }
  },
  roleArn: "arn:aws:iam::123456789012:role/unfiled-worker-production",
  vercelProjectId: "prj_example"
};

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

const keyRequest: CreateIntermediateKeyRequest = {
  createdAt: "2026-08-30T12:00:00.000Z",
  keyClass: "ai_assisted",
  keyId: "11111111-2222-4333-8444-555555555555",
  keyVersion: 1,
  ownerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  predecessorKeyId: null,
  purpose: "object_wrap"
};

function recordingCustodian(calls: {
  generatedSignals: (AbortSignal | undefined)[];
  unwrappedSignals: (AbortSignal | undefined)[];
}): IntermediateKeyCustodian {
  const record = Object.freeze({}) as ManagedKeyRecordV1;
  return Object.freeze({
    withGeneratedIntermediateKey<Result>(
      _request: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      calls.generatedSignals.push(options?.signal);
      return use(new Uint8Array(32), record);
    },
    withUnwrappedIntermediateKey<Result>(
      _record: unknown,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      calls.unwrappedSignals.push(options?.signal);
      return use(new Uint8Array(32), record);
    }
  });
}

async function trustedInvocation(source: VercelTrustedSource = trustedSource) {
  const now = Math.floor(Date.now() / 1_000);
  keyMocks.verifyOidc.mockResolvedValue({
    payload: {
      aud: source.audience,
      environment: source.environment,
      exp: now + 300,
      iat: now,
      iss: source.issuer,
      nbf: now,
      owner: source.teamSlug,
      owner_id: source.ownerId,
      project: source.projectName,
      project_id: source.projectId,
      sub: source.expectedSubject
    },
    protectedHeader: { alg: "RS256" }
  });
  return createVercelTrustedSourcesInvocationAuth({ trustedSource: source }).authorize(
    {
      authorizationHeader: null,
      protectionBypassHeader: null,
      requestId: "request-1",
      trustedSourceToken: "source.header.signature"
    },
    new AbortController().signal
  );
}

const productionInvocation = trustedInvocation;

describe("production key-management composition", () => {
  beforeEach(() => {
    keyMocks.assertReadiness.mockReset().mockResolvedValue(undefined);
    keyMocks.createCustodian.mockReset().mockReturnValue(Object.freeze({}));
    keyMocks.createTransport.mockReset().mockResolvedValue({ destroy: vi.fn() });
    keyMocks.verifyOidc.mockReset();
  });

  it("opens the separately configured Preview KMS boundary without synthetic fallback", async () => {
    const previewSource: VercelTrustedSource = {
      ...trustedSource,
      environment: "preview",
      expectedSubject: "owner:team-example:project:unfiled-web:environment:preview"
    };
    const previewBoundary: WorkerConfig["keyBoundary"] = {
      ...awsBoundary,
      expectedOidcSubject: "owner:team-example:project:unfiled-worker:environment:preview",
      roleArn: "arn:aws:iam::123456789012:role/unfiled-worker-preview"
    };

    await expect(
      createWorkerKeyManagementAdapter().withAiAssistedAuthority(
        previewBoundary,
        {
          invocation: await trustedInvocation(previewSource),
          oidcToken: "preview.workload.signature",
          requestId: "request-1",
          runtime: "preview"
        },
        new AbortController().signal,
        () => Promise.resolve("preview")
      )
    ).resolves.toBe("preview");

    expect(keyMocks.createTransport).toHaveBeenCalledWith({
      region: "us-west-2",
      roleArn: "arn:aws:iam::123456789012:role/unfiled-worker-preview",
      workload: "index_worker"
    });
  });

  it("rejects a cross-environment KMS boundary before opening AWS", async () => {
    const previewSource: VercelTrustedSource = {
      ...trustedSource,
      environment: "preview",
      expectedSubject: "owner:team-example:project:unfiled-web:environment:preview"
    };

    await expect(
      createWorkerKeyManagementAdapter().withAiAssistedAuthority(
        awsBoundary,
        {
          invocation: await trustedInvocation(previewSource),
          oidcToken: "preview.workload.signature",
          requestId: "request-1",
          runtime: "preview"
        },
        new AbortController().signal,
        () => Promise.resolve("must-not-run")
      )
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });

    expect(keyMocks.createTransport).not.toHaveBeenCalled();
  });

  it("uses the worker role and proves the exact AI object-wrap root before issuing authority", async () => {
    let retainedAuthority: Parameters<typeof custodianForAiAssistedAuthority>[0] | undefined;
    let retainedFacade: WorkerIntermediateKeyCustodian | undefined;
    const closeSawRevoked: boolean[] = [];
    const transport = {
      destroy: vi.fn(() => {
        closeSawRevoked.push(
          retainedAuthority !== undefined && !isAiAssistedKeyAuthority(retainedAuthority)
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
    const callerSignal = new AbortController().signal;

    const result = await createWorkerKeyManagementAdapter().withAiAssistedAuthority(
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
        const facade = custodianForAiAssistedAuthority(authority);
        retainedFacade = facade;
        expect(facade).not.toBe(custodian);
        expect("rewrapIntermediateKey" in facade).toBe(false);
        await facade.withGeneratedIntermediateKey(keyRequest, () => Promise.resolve("generated"), {
          signal: callerSignal
        });
        await facade.withUnwrappedIntermediateKey(Object.freeze({}), () =>
          Promise.resolve("unwrapped")
        );
        return "complete";
      }
    );

    expect(result).toBe("complete");
    expect(calls.generatedSignals).toHaveLength(1);
    expect(calls.unwrappedSignals).toHaveLength(1);
    expect(calls.generatedSignals[0]).toBe(calls.unwrappedSignals[0]);
    expect(calls.generatedSignals[0]).not.toBe(callerSignal);
    expect(calls.generatedSignals[0]?.aborted).toBe(true);
    expect(keyMocks.createTransport).toHaveBeenCalledWith({
      region: "us-west-2",
      roleArn: "arn:aws:iam::123456789012:role/unfiled-worker-production",
      workload: "index_worker"
    });
    expect(keyMocks.assertReadiness).toHaveBeenCalledWith({
      activeRoots: {
        ai_assisted: {
          object_wrap: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555"
        }
      },
      signal,
      transport
    });
    expect(keyMocks.createCustodian).toHaveBeenCalledWith({
      activeRoots: {
        ai_assisted: {
          object_wrap: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555"
        }
      },
      retiredRoots: awsBoundary.retiredRoots,
      transport,
      workload: "index_worker"
    });
    expect(
      JSON.stringify([
        keyMocks.createTransport.mock.calls,
        keyMocks.assertReadiness.mock.calls,
        keyMocks.createCustodian.mock.calls
      ])
    ).not.toContain("workload.header.signature");
    expect(transport.destroy).toHaveBeenCalledOnce();
    expect(closeSawRevoked).toEqual([true]);
    if (retainedFacade === undefined || retainedAuthority === undefined) {
      throw new Error("Expected the authority callback to run");
    }
    const releasedAuthority = retainedAuthority;
    await expect(
      retainedFacade.withGeneratedIntermediateKey(keyRequest, () => Promise.resolve("late"))
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(() => custodianForAiAssistedAuthority(releasedAuthority)).toThrow(/ready/u);
    expect(calls.generatedSignals).toHaveLength(1);
  });

  it("destroys the transport and issues nothing when either root readiness check fails", async () => {
    const canary = "kms-provider-secret-canary";
    const transport = { destroy: vi.fn() };
    keyMocks.createTransport.mockResolvedValueOnce(transport);
    keyMocks.assertReadiness.mockRejectedValueOnce(new Error(canary));
    const use = vi.fn();

    let captured: unknown;
    try {
      await createWorkerKeyManagementAdapter().withAiAssistedAuthority(
        awsBoundary,
        {
          invocation: await productionInvocation(),
          oidcToken: "workload.header.signature",
          requestId: "request-1",
          runtime: "production"
        },
        new AbortController().signal,
        use
      );
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(String(captured)).not.toContain(canary);
    expect(use).not.toHaveBeenCalled();
    expect(transport.destroy).toHaveBeenCalledOnce();
  });

  it("revokes an in-flight custody callback before it can release key bytes", async () => {
    const receivedSignals: (AbortSignal | undefined)[] = [];
    const closeSawOperationAborted: boolean[] = [];
    const rawCustodian: IntermediateKeyCustodian = Object.freeze({
      withGeneratedIntermediateKey<Result>(
        _request: CreateIntermediateKeyRequest,
        use: (keyBytes: Uint8Array, managedRecord: ManagedKeyRecordV1) => Promise<Result>,
        options?: KeyCustodyOperationOptions
      ): Promise<Result> {
        const operationSignal = options?.signal;
        receivedSignals.push(operationSignal);
        return new Promise<Result>((resolve, reject) => {
          const abort = (): void => reject(new Error("custody operation aborted"));
          if (operationSignal?.aborted === true) {
            abort();
            return;
          }
          operationSignal?.addEventListener("abort", abort, { once: true });
          // Keep the simulated KMS operation pending. A correct facade aborts
          // it when the request-scoped authority callback completes.
          void use;
          void resolve;
        });
      },
      withUnwrappedIntermediateKey<Result>(): Promise<Result> {
        return Promise.reject(new Error("not used"));
      }
    });
    const transport = {
      destroy: vi.fn(() => closeSawOperationAborted.push(receivedSignals[0]?.aborted === true))
    };
    const keyConsumer = vi.fn(() => Promise.resolve("should-not-run"));
    const pendingOperations: Promise<string>[] = [];
    const requestSignal = new AbortController().signal;
    keyMocks.createTransport.mockResolvedValueOnce(transport);
    keyMocks.createCustodian.mockReturnValueOnce(rawCustodian);

    const result = await createWorkerKeyManagementAdapter().withAiAssistedAuthority(
      awsBoundary,
      {
        invocation: await productionInvocation(),
        oidcToken: "workload.header.signature",
        requestId: "request-1",
        runtime: "production"
      },
      requestSignal,
      (authority) => {
        const pending = custodianForAiAssistedAuthority(authority).withGeneratedIntermediateKey(
          keyRequest,
          keyConsumer
        );
        // The drain callback cannot retain a still-running operation past the
        // request-scoped lease. Attach a handler now to avoid an unhandled
        // rejection while preserving the original promise for the assertion.
        void pending.catch(() => undefined);
        pendingOperations.push(pending);
        return Promise.resolve("complete");
      }
    );

    expect(result).toBe("complete");
    expect(transport.destroy).toHaveBeenCalledOnce();
    expect(closeSawOperationAborted).toEqual([true]);
    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]).not.toBe(requestSignal);
    expect(receivedSignals[0]?.aborted).toBe(true);
    const pending = pendingOperations[0];
    if (pending === undefined) throw new Error("Expected an in-flight custody operation");
    await expect(pending).rejects.toThrow("custody operation aborted");
    expect(keyConsumer).not.toHaveBeenCalled();
  });

  it("revokes retained custody immediately on request abort", async () => {
    const controller = new AbortController();
    const transport = { destroy: vi.fn() };
    const unwrappedSignals: (AbortSignal | undefined)[] = [];
    const keyConsumer = vi.fn(() => Promise.resolve("should-not-run"));
    const rawCustodian: IntermediateKeyCustodian = Object.freeze({
      withGeneratedIntermediateKey<Result>(): Promise<Result> {
        return Promise.reject(new Error("not used"));
      },
      withUnwrappedIntermediateKey<Result>(
        _record: unknown,
        _use: (keyBytes: Uint8Array, managedRecord: ManagedKeyRecordV1) => Promise<Result>,
        options?: KeyCustodyOperationOptions
      ): Promise<Result> {
        const operationSignal = options?.signal;
        unwrappedSignals.push(operationSignal);
        return new Promise<Result>((_resolve, reject) => {
          const abort = (): void => reject(new Error("custody operation aborted"));
          if (operationSignal?.aborted === true) {
            abort();
            return;
          }
          operationSignal?.addEventListener("abort", abort, { once: true });
        });
      }
    });
    keyMocks.createTransport.mockResolvedValueOnce(transport);
    keyMocks.createCustodian.mockReturnValueOnce(rawCustodian);

    await createWorkerKeyManagementAdapter().withAiAssistedAuthority(
      awsBoundary,
      {
        invocation: await productionInvocation(),
        oidcToken: "workload.header.signature",
        requestId: "request-1",
        runtime: "production"
      },
      controller.signal,
      async (authority) => {
        const facade = custodianForAiAssistedAuthority(authority);
        const pending = facade.withUnwrappedIntermediateKey({}, keyConsumer);
        void pending.catch(() => undefined);
        controller.abort();
        await expect(pending).rejects.toThrow("custody operation aborted");
        await expect(
          facade.withUnwrappedIntermediateKey({}, () => Promise.resolve("late"))
        ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
      }
    );

    expect(unwrappedSignals).toHaveLength(1);
    expect(unwrappedSignals[0]).not.toBe(controller.signal);
    expect(unwrappedSignals[0]?.aborted).toBe(true);
    expect(keyConsumer).not.toHaveBeenCalled();
    expect(transport.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a forged invocation before opening an AWS session", async () => {
    await expect(
      createWorkerKeyManagementAdapter().withAiAssistedAuthority(
        awsBoundary,
        {
          invocation: {} as never,
          oidcToken: "workload.header.signature",
          requestId: "request-1",
          runtime: "production"
        },
        new AbortController().signal,
        () => Promise.resolve()
      )
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(keyMocks.createTransport).not.toHaveBeenCalled();
  });
});
