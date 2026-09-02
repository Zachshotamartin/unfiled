import {
  assertIndexWorkerKmsReadiness,
  createAwsKmsEnvelopeCustodian,
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  createVercelSensitiveEnvironmentKmsTransport,
  createVercelOidcKmsTransport,
  type CreateIntermediateKeyRequest,
  type IntermediateKeyCustodian,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser,
  type ManagedKeyRecordV1
} from "@unfiled/key-management";
import {
  parseManagedKeyRecordV1,
  parseManagedKeyRecordV2,
  type ManagedKeyRecordV2
} from "@unfiled/key-management";

import type {
  AwsWorkerKeyBoundary,
  VercelSensitiveEnvironmentWorkerKeyBoundary,
  WorkerConfig,
  WorkerRuntime
} from "./config.js";
import { WorkerUnavailableError } from "./errors.js";
import {
  isVerifiedWorkerInvocation,
  type VerifiedWorkerInvocation
} from "./invocation-auth-adapter.js";

const MAX_OIDC_TOKEN_LENGTH = 16_384;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

declare const aiAssistedAuthorityBrand: unique symbol;

/**
 * Request-scoped, non-serializable authority. Its acceptance depends on
 * WeakMap membership, not structural fields, so application code cannot mint
 * it with a matching object literal.
 */
export type AiAssistedKeyAuthority = Readonly<{
  [aiAssistedAuthorityBrand]: true;
}>;

type AuthorityMetadata = Readonly<{
  custody: "aws-kms" | "local-synthetic" | "vercel-sensitive-env-v1";
  custodian?: WorkerIntermediateKeyCustodian;
  parseRecord?: WorkerManagedKeyRecordParser;
  requestId: string;
  runtime: WorkerRuntime;
}>;

export type WorkerManagedKeyRecord = ManagedKeyRecordV1 | ManagedKeyRecordV2;
export type WorkerManagedKeyRecordParser = ManagedKeyRecordParser<WorkerManagedKeyRecord>;
export type WorkerIntermediateKeyCustodian = IntermediateKeyCustodian<WorkerManagedKeyRecord>;

const issuedAuthorities = new WeakMap<object, AuthorityMetadata>();

function assertSignalActive(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkerUnavailableError();
}

function issueAuthority(metadata: AuthorityMetadata): AiAssistedKeyAuthority {
  const authority = Object.freeze(Object.create(null)) as AiAssistedKeyAuthority;
  issuedAuthorities.set(authority, metadata);
  return authority;
}

type RevocableCustodianLease = Readonly<{
  custodian: WorkerIntermediateKeyCustodian;
  revoke(): void;
}>;

function widenCustodian<Record extends ManagedKeyRecord>(
  custodian: IntermediateKeyCustodian<Record>
): WorkerIntermediateKeyCustodian {
  return Object.freeze({
    withGeneratedIntermediateKey(request, use, options) {
      return custodian.withGeneratedIntermediateKey(
        request,
        (bytes, record) => use(bytes, record),
        options
      );
    },
    withUnwrappedIntermediateKey(record, use, options) {
      return custodian.withUnwrappedIntermediateKey(
        record,
        (bytes, parsed) => use(bytes, parsed),
        options
      );
    }
  });
}

function createRevocableCustodian(
  authority: AiAssistedKeyAuthority,
  underlying: WorkerIntermediateKeyCustodian,
  requestSignal: AbortSignal
): RevocableCustodianLease {
  let open = true;
  const revocation = new AbortController();
  const custodySignal = AbortSignal.any([requestSignal, revocation.signal]);
  const assertOpen = (): void => {
    const metadata = issuedAuthorities.get(authority);
    if (
      !open ||
      requestSignal.aborted ||
      (metadata?.custody !== "aws-kms" && metadata?.custody !== "vercel-sensitive-env-v1") ||
      metadata.custodian !== facade
    ) {
      throw new WorkerUnavailableError();
    }
  };

  const facade: WorkerIntermediateKeyCustodian = Object.freeze({
    async withGeneratedIntermediateKey<Result>(
      request: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, record: WorkerManagedKeyRecord) => Promise<Result>
    ): Promise<Result> {
      assertOpen();
      return underlying.withGeneratedIntermediateKey(
        request,
        async (keyBytes, record) => {
          assertOpen();
          return use(keyBytes, record);
        },
        { signal: custodySignal }
      );
    },
    async withUnwrappedIntermediateKey<Result>(
      record: unknown,
      use: (keyBytes: Uint8Array, parsedRecord: WorkerManagedKeyRecord) => Promise<Result>
    ): Promise<Result> {
      assertOpen();
      return underlying.withUnwrappedIntermediateKey(
        record,
        async (keyBytes, parsedRecord) => {
          assertOpen();
          return use(keyBytes, parsedRecord);
        },
        { signal: custodySignal }
      );
    }
  });

  return Object.freeze({
    custodian: facade,
    revoke(): void {
      if (!open) return;
      open = false;
      revocation.abort();
    }
  });
}

export function isAiAssistedKeyAuthority(
  value: unknown,
  expected?: Readonly<{ requestId: string; runtime: WorkerRuntime }>
): value is AiAssistedKeyAuthority {
  if (value === null || typeof value !== "object") return false;
  const metadata = issuedAuthorities.get(value);
  return (
    metadata !== undefined &&
    (expected === undefined ||
      (metadata.requestId === expected.requestId && metadata.runtime === expected.runtime))
  );
}

/** Available only while the adapter's authority callback is active. */
export function custodianForAiAssistedAuthority(
  authority: AiAssistedKeyAuthority
): WorkerIntermediateKeyCustodian {
  const metadata = issuedAuthorities.get(authority);
  if (
    (metadata?.custody !== "aws-kms" && metadata?.custody !== "vercel-sensitive-env-v1") ||
    metadata.custodian === undefined
  ) {
    throw new WorkerUnavailableError();
  }
  return metadata.custodian;
}

export function managedKeyRecordParserForAiAssistedAuthority(
  authority: AiAssistedKeyAuthority
): WorkerManagedKeyRecordParser {
  const metadata = issuedAuthorities.get(authority);
  if (metadata?.parseRecord === undefined) throw new WorkerUnavailableError();
  return metadata.parseRecord;
}

export function managedKeyRecordParserForWorkerBoundary(
  boundary: WorkerConfig["keyBoundary"]
): WorkerManagedKeyRecordParser {
  if (boundary.kind === "vercel-sensitive-env-v1") return parseManagedKeyRecordV2;
  return parseManagedKeyRecordV1;
}

export type WorkerIdentityProof = Readonly<{
  invocation: VerifiedWorkerInvocation;
  oidcToken: string | undefined;
  requestId: string;
  runtime: WorkerRuntime;
}>;

export type WorkerKeyManagementAdapter = Readonly<{
  withAiAssistedAuthority<Result>(
    boundary: WorkerConfig["keyBoundary"],
    proof: WorkerIdentityProof,
    signal: AbortSignal,
    use: (authority: AiAssistedKeyAuthority) => Promise<Result>
  ): Promise<Result>;
}>;

type AwsReadinessSession = Readonly<{
  close(): void;
  custodian: WorkerIntermediateKeyCustodian;
  custody: "aws-kms" | "vercel-sensitive-env-v1";
  parseRecord: WorkerManagedKeyRecordParser;
}>;

export function oidcTokenFromRequest(
  request: Request,
  boundary: WorkerConfig["keyBoundary"]
): string | undefined {
  if (boundary.kind !== "aws-oidc") return undefined;
  const value = request.headers.get("x-vercel-oidc-token")?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_OIDC_TOKEN_LENGTH ||
    !JWT_PATTERN.test(value)
  ) {
    throw new WorkerUnavailableError();
  }
  return value;
}

export function isAwsWorkerBoundary(
  boundary: WorkerConfig["keyBoundary"]
): boundary is AwsWorkerKeyBoundary {
  return boundary.kind === "aws-oidc";
}

/**
 * A successful readiness session proves STS exchange plus GenerateDataKey and
 * Decrypt on the active AI-assisted object-wrap root before authority is minted.
 */
async function openAwsReadinessSession(
  boundary: AwsWorkerKeyBoundary,
  _proof: Readonly<{ oidcToken: string; requestId: string }>,
  signal: AbortSignal
): Promise<AwsReadinessSession> {
  // `_proof.oidcToken` is deliberately only the bounded presence evidence
  // extracted by the route. The provider obtains the authoritative workload
  // token from Vercel request context; successful STS/KMS operations below are
  // the authorization proof. A deployed context/header probe is a cutover gate.
  let transport: Awaited<ReturnType<typeof createVercelOidcKmsTransport>> | undefined;
  try {
    transport = await createVercelOidcKmsTransport({
      region: boundary.region,
      roleArn: boundary.roleArn,
      workload: "index_worker"
    });
    const activeRoots = {
      ai_assisted: {
        object_wrap: boundary.aiObjectWrapKmsKeyArn
      }
    } as const;
    await assertIndexWorkerKmsReadiness({ activeRoots, signal, transport });
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots,
      retiredRoots: boundary.retiredRoots,
      transport,
      workload: "index_worker"
    });
    return Object.freeze({
      close: () => transport?.destroy(),
      custodian: widenCustodian(custodian),
      custody: "aws-kms" as const,
      parseRecord: parseManagedKeyRecordV1
    });
  } catch {
    transport?.destroy();
    throw new WorkerUnavailableError();
  }
}

async function openVercelSensitiveEnvironmentSession(
  boundary: VercelSensitiveEnvironmentWorkerKeyBoundary,
  signal: AbortSignal
): Promise<AwsReadinessSession> {
  let transport:
    Awaited<ReturnType<typeof createVercelSensitiveEnvironmentKmsTransport>> | undefined;
  const retired = boundary.retiredRoots.ai_assisted.object_wrap;
  try {
    transport = await createVercelSensitiveEnvironmentKmsTransport({
      expectedRootKeyIds: [boundary.aiObjectWrapRootKeyId, ...retired]
    });
    const activeRoots = {
      ai_assisted: { object_wrap: boundary.aiObjectWrapRootKeyId }
    } as const;
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots,
      deploymentEnvironment: boundary.deploymentEnvironment,
      retiredRoots: boundary.retiredRoots,
      transport,
      workload: "index_worker"
    });
    await custodian.withGeneratedIntermediateKey(
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        keyClass: "ai_assisted",
        keyId: "readiness.ai.object-wrap.v2",
        keyVersion: 1,
        ownerId: "00000000-0000-4000-8000-000000000001",
        predecessorKeyId: null,
        purpose: "object_wrap"
      },
      (generated, record) =>
        // The custodian only opens active/retired records, so the throwaway
        // readiness record is activated in memory; it is never persisted.
        custodian.withUnwrappedIntermediateKey(
          { ...record, activatedAt: record.createdAt, status: "active" },
          (unwrapped) => {
            if (
              generated.byteLength !== unwrapped.byteLength ||
              generated.some((byte, index) => byte !== unwrapped[index])
            ) {
              throw new WorkerUnavailableError();
            }
            return Promise.resolve();
          },
          { signal }
        ),
      { signal }
    );
    return Object.freeze({
      close: () => transport?.destroy(),
      custodian: widenCustodian(custodian),
      custody: "vercel-sensitive-env-v1" as const,
      parseRecord: parseManagedKeyRecordV2
    });
  } catch {
    transport?.destroy();
    throw new WorkerUnavailableError();
  }
}

export function createWorkerKeyManagementAdapter(): WorkerKeyManagementAdapter {
  return Object.freeze({
    async withAiAssistedAuthority<Result>(
      boundary: WorkerConfig["keyBoundary"],
      proof: WorkerIdentityProof,
      signal: AbortSignal,
      use: (authority: AiAssistedKeyAuthority) => Promise<Result>
    ): Promise<Result> {
      if (
        !isVerifiedWorkerInvocation(proof.invocation, {
          requestId: proof.requestId,
          runtime: proof.runtime
        }) ||
        signal.aborted
      ) {
        throw new WorkerUnavailableError();
      }

      if (boundary.kind === "local-synthetic") {
        if (proof.runtime !== "local" || proof.oidcToken !== undefined) {
          throw new WorkerUnavailableError();
        }
        const authority = issueAuthority({
          custody: "local-synthetic",
          requestId: proof.requestId,
          runtime: proof.runtime
        });
        try {
          return await use(authority);
        } finally {
          issuedAuthorities.delete(authority);
        }
      }

      if (proof.runtime === "local") throw new WorkerUnavailableError();
      let session: AwsReadinessSession;
      if (boundary.kind === "aws-oidc") {
        const boundaryEnvironment =
          /^owner:[^:]+:project:[^:]+:environment:(preview|production)$/u.exec(
            boundary.expectedOidcSubject
          )?.[1];
        if (proof.oidcToken === undefined || boundaryEnvironment !== proof.runtime) {
          throw new WorkerUnavailableError();
        }
        session = await openAwsReadinessSession(
          boundary,
          { oidcToken: proof.oidcToken, requestId: proof.requestId },
          signal
        );
      } else {
        if (proof.oidcToken !== undefined || boundary.deploymentEnvironment !== proof.runtime) {
          throw new WorkerUnavailableError();
        }
        session = await openVercelSensitiveEnvironmentSession(boundary, signal);
      }
      let closed = false;
      let authority: AiAssistedKeyAuthority | undefined;
      let custodianLease: RevocableCustodianLease | undefined;
      const close = (): void => {
        if (closed) return;
        closed = true;
        custodianLease?.revoke();
        if (authority !== undefined) issuedAuthorities.delete(authority);
        session.close();
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        assertSignalActive(signal);
        const authorityMetadata = {
          custody: session.custody,
          parseRecord: session.parseRecord,
          requestId: proof.requestId,
          runtime: proof.runtime
        } as const;
        authority = issueAuthority(authorityMetadata);
        custodianLease = createRevocableCustodian(authority, session.custodian, signal);
        issuedAuthorities.set(authority, {
          ...authorityMetadata,
          custodian: custodianLease.custodian
        });
        return await use(authority);
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    }
  });
}

/** Fail closed if the production composition is accidentally omitted. */
export const unconfiguredKeyManagementAdapter: WorkerKeyManagementAdapter = Object.freeze({
  withAiAssistedAuthority() {
    return Promise.reject(new WorkerUnavailableError());
  }
});
