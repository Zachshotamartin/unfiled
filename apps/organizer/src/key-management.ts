import {
  assertAiAssistedKmsReadiness,
  createAwsKmsEnvelopeCustodian,
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  createVercelSensitiveEnvironmentKmsTransport,
  createVercelOidcKmsTransport,
  type AwsKmsTransport,
  type CreateIntermediateKeyRequest,
  type DecryptDataKeyResponse,
  type GenerateDataKeyResponse,
  type IntermediateKeyCustodian,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser,
  type ManagedKeyRecordV1,
  type ManagedKeyRecordV2,
  parseManagedKeyRecordV1,
  parseManagedKeyRecordV2,
  type ReEncryptDataKeyResponse
} from "@unfiled/key-management";

import type {
  AwsOrganizerKeyBoundary,
  OrganizerConfig,
  OrganizerRuntime,
  VercelSensitiveEnvironmentOrganizerKeyBoundary
} from "./config.js";
import { OrganizerUnavailableError } from "./errors.js";
import {
  isVerifiedOrganizerInvocation,
  type VerifiedOrganizerInvocation
} from "./invocation-auth.js";

const MAX_OIDC_TOKEN_LENGTH = 16_384;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
declare const organizerAuthorityBrand: unique symbol;
export type OrganizerKeyAuthority = Readonly<{ [organizerAuthorityBrand]: true }>;
type AuthorityMetadata = Readonly<{
  custodian?: OrganizerIntermediateKeyCustodian;
  custody: "aws-kms" | "local-synthetic" | "vercel-sensitive-env-v1";
  parseRecord?: OrganizerManagedKeyRecordParser;
  requestId: string;
  runtime: OrganizerRuntime;
}>;
export type OrganizerManagedKeyRecord = ManagedKeyRecordV1 | ManagedKeyRecordV2;
export type OrganizerManagedKeyRecordParser = ManagedKeyRecordParser<OrganizerManagedKeyRecord>;
export type OrganizerIntermediateKeyCustodian = IntermediateKeyCustodian<OrganizerManagedKeyRecord>;
const authorities = new WeakMap<object, AuthorityMetadata>();
type OrganizerKmsResponse =
  DecryptDataKeyResponse | GenerateDataKeyResponse | ReEncryptDataKeyResponse;

function wipeKmsResponse(response: OrganizerKmsResponse): void {
  if ("Plaintext" in response) response.Plaintext.fill(0);
  if ("CiphertextBlob" in response) response.CiphertextBlob.fill(0);
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createAbortBoundOrganizerKmsTransport(
  transport: AwsKmsTransport,
  requestSignal: AbortSignal
): AwsKmsTransport {
  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    transport.destroy();
  };
  async function call<Result extends OrganizerKmsResponse>(
    operation: () => Promise<Result>,
    operationSignal?: AbortSignal
  ): Promise<Result> {
    const signal =
      operationSignal === undefined
        ? requestSignal
        : AbortSignal.any([requestSignal, operationSignal]);
    if (isAborted(signal) || destroyed) {
      destroy();
      throw new OrganizerUnavailableError();
    }
    let aborted = false;
    let rejectAbort!: (error: OrganizerUnavailableError) => void;
    const abort = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = (): void => {
      aborted = true;
      destroy();
      rejectAbort(new OrganizerUnavailableError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (isAborted(signal)) {
      onAbort();
      return await abort;
    }
    try {
      const guarded = Promise.resolve()
        .then(operation)
        .then((response) => {
          if (aborted || isAborted(signal) || destroyed) {
            wipeKmsResponse(response);
            throw new OrganizerUnavailableError();
          }
          return response;
        });
      void guarded.catch(() => undefined);
      return await Promise.race([guarded, abort]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  return Object.freeze({
    decryptDataKey(input, options) {
      return call(() => transport.decryptDataKey(input, options), options?.abortSignal);
    },
    destroy,
    generateDataKey(input, options) {
      return call(() => transport.generateDataKey(input, options), options?.abortSignal);
    },
    reEncryptDataKey(input, options) {
      return call(() => transport.reEncryptDataKey(input, options), options?.abortSignal);
    }
  });
}

async function createAbortBoundTransport(
  boundary: AwsOrganizerKeyBoundary,
  signal: AbortSignal
): Promise<AwsKmsTransport> {
  if (isAborted(signal)) throw new OrganizerUnavailableError();
  let aborted = false;
  let rejectAbort!: (error: OrganizerUnavailableError) => void;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    aborted = true;
    rejectAbort(new OrganizerUnavailableError());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (isAborted(signal)) {
    onAbort();
    return await abort;
  }
  try {
    const pending = createVercelOidcKmsTransport({
      maxAttempts: 2,
      region: boundary.region,
      roleArn: boundary.roleArn,
      workload: "organization_worker"
    });
    void pending.then(
      (transport) => {
        if (aborted || isAborted(signal)) transport.destroy();
      },
      () => undefined
    );
    const transport = await Promise.race([pending, abort]);
    if (isAborted(signal)) {
      transport.destroy();
      throw new OrganizerUnavailableError();
    }
    return createAbortBoundOrganizerKmsTransport(transport, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function issue(metadata: AuthorityMetadata): OrganizerKeyAuthority {
  const authority = Object.freeze(Object.create(null)) as OrganizerKeyAuthority;
  authorities.set(authority, metadata);
  return authority;
}

export function isOrganizerKeyAuthority(
  value: unknown,
  expected?: Readonly<{ requestId: string; runtime: OrganizerRuntime }>
): value is OrganizerKeyAuthority {
  if (value === null || typeof value !== "object") return false;
  const metadata = authorities.get(value);
  return (
    metadata !== undefined &&
    (expected === undefined ||
      (metadata.requestId === expected.requestId && metadata.runtime === expected.runtime))
  );
}

export function custodianForOrganizerAuthority(
  authority: OrganizerKeyAuthority
): OrganizerIntermediateKeyCustodian {
  const metadata = authorities.get(authority);
  if (
    (metadata?.custody !== "aws-kms" && metadata?.custody !== "vercel-sensitive-env-v1") ||
    metadata.custodian === undefined
  )
    throw new OrganizerUnavailableError();
  return metadata.custodian;
}

export function managedKeyRecordParserForOrganizerAuthority(
  authority: OrganizerKeyAuthority
): OrganizerManagedKeyRecordParser {
  const parser = authorities.get(authority)?.parseRecord;
  if (parser === undefined) throw new OrganizerUnavailableError();
  return parser;
}

export function managedKeyRecordParserForOrganizerBoundary(
  boundary: OrganizerConfig["keyBoundary"]
): OrganizerManagedKeyRecordParser {
  return boundary.kind === "vercel-sensitive-env-v1"
    ? parseManagedKeyRecordV2
    : parseManagedKeyRecordV1;
}

export function oidcTokenFromRequest(
  request: Request,
  boundary: OrganizerConfig["keyBoundary"]
): string | undefined {
  if (boundary.kind !== "aws-oidc") return undefined;
  const token = request.headers.get("x-vercel-oidc-token")?.trim();
  if (
    token === undefined ||
    token.length === 0 ||
    token.length > MAX_OIDC_TOKEN_LENGTH ||
    !JWT_PATTERN.test(token)
  ) {
    throw new OrganizerUnavailableError();
  }
  return token;
}

export type OrganizerIdentityProof = Readonly<{
  invocation: VerifiedOrganizerInvocation;
  oidcToken: string | undefined;
  requestId: string;
  runtime: OrganizerRuntime;
}>;
export type OrganizerKeyManagementAdapter = Readonly<{
  withAiAssistedAuthority<Result>(
    boundary: OrganizerConfig["keyBoundary"],
    proof: OrganizerIdentityProof,
    signal: AbortSignal,
    use: (authority: OrganizerKeyAuthority) => Promise<Result>
  ): Promise<Result>;
}>;

async function openAwsSession(
  boundary: AwsOrganizerKeyBoundary,
  signal: AbortSignal
): Promise<
  Readonly<{
    close(): void;
    custodian: OrganizerIntermediateKeyCustodian;
    custody: "aws-kms" | "vercel-sensitive-env-v1";
    parseRecord: OrganizerManagedKeyRecordParser;
  }>
> {
  let transport: Awaited<ReturnType<typeof createVercelOidcKmsTransport>> | undefined;
  try {
    transport = await createAbortBoundTransport(boundary, signal);
    const activeRoots = {
      ai_assisted: {
        content_mac: boundary.aiContentMacKmsKeyArn,
        object_wrap: boundary.aiObjectWrapKmsKeyArn
      }
    } as const;
    await assertAiAssistedKmsReadiness({ activeRoots, signal, transport });
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots,
      retiredRoots: boundary.retiredRoots,
      transport,
      workload: "organization_worker"
    });
    return Object.freeze({
      close: () => transport?.destroy(),
      custodian: widenCustodian(custodian),
      custody: "aws-kms" as const,
      parseRecord: parseManagedKeyRecordV1
    });
  } catch {
    transport?.destroy();
    throw new OrganizerUnavailableError();
  }
}

function widenCustodian<Record extends ManagedKeyRecord>(
  custodian: IntermediateKeyCustodian<Record>
): OrganizerIntermediateKeyCustodian {
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

async function assertSensitiveRootReady(
  custodian: IntermediateKeyCustodian<ManagedKeyRecordV2>,
  request: CreateIntermediateKeyRequest,
  signal: AbortSignal
): Promise<void> {
  await custodian.withGeneratedIntermediateKey(
    request,
    (generated, record) =>
      custodian.withUnwrappedIntermediateKey(
        record,
        (unwrapped) => {
          if (
            generated.byteLength !== unwrapped.byteLength ||
            generated.some((byte, index) => byte !== unwrapped[index])
          ) {
            throw new OrganizerUnavailableError();
          }
          return Promise.resolve();
        },
        { signal }
      ),
    { signal }
  );
}

async function openSensitiveSession(
  boundary: VercelSensitiveEnvironmentOrganizerKeyBoundary,
  signal: AbortSignal
): Promise<
  Readonly<{
    close(): void;
    custodian: OrganizerIntermediateKeyCustodian;
    custody: "vercel-sensitive-env-v1";
    parseRecord: OrganizerManagedKeyRecordParser;
  }>
> {
  let transport: AwsKmsTransport | undefined;
  try {
    transport = await createVercelSensitiveEnvironmentKmsTransport({
      expectedRootKeyIds: [
        boundary.aiObjectWrapRootKeyId,
        boundary.aiContentMacRootKeyId,
        ...boundary.retiredRoots.ai_assisted.object_wrap,
        ...boundary.retiredRoots.ai_assisted.content_mac
      ]
    });
    if (signal.aborted) throw new OrganizerUnavailableError();
    transport = createAbortBoundOrganizerKmsTransport(transport, signal);
    const activeRoots = {
      ai_assisted: {
        content_mac: boundary.aiContentMacRootKeyId,
        object_wrap: boundary.aiObjectWrapRootKeyId
      }
    } as const;
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots,
      deploymentEnvironment: boundary.deploymentEnvironment,
      retiredRoots: boundary.retiredRoots,
      transport,
      workload: "organization_worker"
    });
    const base = {
      createdAt: "2026-01-01T00:00:00.000Z",
      keyClass: "ai_assisted" as const,
      keyVersion: 1,
      ownerId: "00000000-0000-4000-8000-000000000001",
      predecessorKeyId: null
    };
    await assertSensitiveRootReady(
      custodian,
      { ...base, keyId: "readiness.ai.object-wrap.v2", purpose: "object_wrap" },
      signal
    );
    await assertSensitiveRootReady(
      custodian,
      { ...base, keyId: "readiness.ai.content-mac.v2", purpose: "content_mac" },
      signal
    );
    return Object.freeze({
      close: () => transport?.destroy(),
      custodian: widenCustodian(custodian),
      custody: "vercel-sensitive-env-v1" as const,
      parseRecord: parseManagedKeyRecordV2
    });
  } catch {
    transport?.destroy();
    throw new OrganizerUnavailableError();
  }
}

function revocableCustodian(
  authority: OrganizerKeyAuthority,
  underlying: OrganizerIntermediateKeyCustodian,
  requestSignal: AbortSignal
): Readonly<{ custodian: OrganizerIntermediateKeyCustodian; revoke(): void }> {
  let open = true;
  const revoked = new AbortController();
  const signal = AbortSignal.any([requestSignal, revoked.signal]);
  const assertOpen = (): void => {
    if (!open || requestSignal.aborted || authorities.get(authority)?.custodian !== facade)
      throw new OrganizerUnavailableError();
  };
  const facade: OrganizerIntermediateKeyCustodian = Object.freeze({
    async withGeneratedIntermediateKey(request, use) {
      assertOpen();
      return underlying.withGeneratedIntermediateKey(
        request,
        async (bytes, record) => {
          assertOpen();
          return use(bytes, record);
        },
        { signal }
      );
    },
    async withUnwrappedIntermediateKey(record, use) {
      assertOpen();
      return underlying.withUnwrappedIntermediateKey(
        record,
        async (bytes, parsed) => {
          assertOpen();
          return use(bytes, parsed);
        },
        { signal }
      );
    }
  });
  return Object.freeze({
    custodian: facade,
    revoke() {
      if (!open) return;
      open = false;
      revoked.abort();
    }
  });
}

export function createOrganizerKeyManagementAdapter(): OrganizerKeyManagementAdapter {
  return Object.freeze({
    async withAiAssistedAuthority(boundary, proof, signal, use) {
      if (
        !isVerifiedOrganizerInvocation(proof.invocation, {
          requestId: proof.requestId,
          runtime: proof.runtime
        }) ||
        signal.aborted
      )
        throw new OrganizerUnavailableError();
      if (boundary.kind === "local-synthetic") {
        if (proof.runtime !== "local" || proof.oidcToken !== undefined)
          throw new OrganizerUnavailableError();
        const authority = issue({
          custody: "local-synthetic",
          requestId: proof.requestId,
          runtime: proof.runtime
        });
        try {
          return await use(authority);
        } finally {
          authorities.delete(authority);
        }
      }
      if (proof.runtime === "local") throw new OrganizerUnavailableError();
      const session =
        boundary.kind === "aws-oidc"
          ? await (async () => {
              const boundaryEnvironment =
                /^owner:[^:]+:project:[^:]+:environment:(preview|production)$/u.exec(
                  boundary.expectedOidcSubject
                )?.[1];
              if (proof.oidcToken === undefined || boundaryEnvironment !== proof.runtime)
                throw new OrganizerUnavailableError();
              return openAwsSession(boundary, signal);
            })()
          : await (async () => {
              if (proof.oidcToken !== undefined || boundary.deploymentEnvironment !== proof.runtime)
                throw new OrganizerUnavailableError();
              return openSensitiveSession(boundary, signal);
            })();
      const authority = issue({
        custody: session.custody,
        parseRecord: session.parseRecord,
        requestId: proof.requestId,
        runtime: proof.runtime
      });
      const lease = revocableCustodian(authority, session.custodian, signal);
      authorities.set(authority, {
        custody: session.custody,
        custodian: lease.custodian,
        parseRecord: session.parseRecord,
        requestId: proof.requestId,
        runtime: proof.runtime
      });
      const close = (): void => {
        lease.revoke();
        authorities.delete(authority);
        session.close();
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        if (isAborted(signal)) throw new OrganizerUnavailableError();
        return await use(authority);
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    }
  });
}

export const unconfiguredKeyManagementAdapter: OrganizerKeyManagementAdapter = Object.freeze({
  withAiAssistedAuthority() {
    return Promise.reject(new OrganizerUnavailableError());
  }
});
