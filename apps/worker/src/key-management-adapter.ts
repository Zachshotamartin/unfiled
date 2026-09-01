import {
  assertIndexWorkerKmsReadiness,
  createAwsKmsEnvelopeCustodian,
  createVercelOidcKmsTransport,
  type CreateIntermediateKeyRequest,
  type IntermediateKeyCustodian,
  type ManagedKeyRecordV1
} from "@unfiled/key-management";

import type { AwsWorkerKeyBoundary, WorkerConfig, WorkerRuntime } from "./config.js";
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
  custody: "aws-kms" | "local-synthetic";
  custodian?: IntermediateKeyCustodian;
  requestId: string;
  runtime: WorkerRuntime;
}>;

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
  custodian: IntermediateKeyCustodian;
  revoke(): void;
}>;

function createRevocableCustodian(
  authority: AiAssistedKeyAuthority,
  underlying: IntermediateKeyCustodian,
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
      metadata?.custody !== "aws-kms" ||
      metadata.custodian !== facade
    ) {
      throw new WorkerUnavailableError();
    }
  };

  const facade: IntermediateKeyCustodian = Object.freeze({
    async withGeneratedIntermediateKey<Result>(
      request: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>
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
      use: (keyBytes: Uint8Array, parsedRecord: ManagedKeyRecordV1) => Promise<Result>
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
): IntermediateKeyCustodian {
  const metadata = issuedAuthorities.get(authority);
  if (metadata?.custody !== "aws-kms" || metadata.custodian === undefined) {
    throw new WorkerUnavailableError();
  }
  return metadata.custodian;
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
  custodian: IntermediateKeyCustodian;
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
      custodian
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
        if (proof.runtime === "production" || proof.oidcToken !== undefined) {
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

      if (proof.runtime !== "production" || proof.oidcToken === undefined) {
        throw new WorkerUnavailableError();
      }
      let session: AwsReadinessSession;
      try {
        session = await openAwsReadinessSession(
          boundary,
          { oidcToken: proof.oidcToken, requestId: proof.requestId },
          signal
        );
      } catch {
        throw new WorkerUnavailableError();
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
          custody: "aws-kms",
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
