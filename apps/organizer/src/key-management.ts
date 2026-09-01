import {
  assertAiAssistedKmsReadiness,
  createAwsKmsEnvelopeCustodian,
  createVercelOidcKmsTransport,
  type AwsKmsTransport,
  type DecryptDataKeyResponse,
  type GenerateDataKeyResponse,
  type IntermediateKeyCustodian,
  type ReEncryptDataKeyResponse
} from "@unfiled/key-management";

import type { AwsOrganizerKeyBoundary, OrganizerConfig, OrganizerRuntime } from "./config.js";
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
  custodian?: IntermediateKeyCustodian;
  custody: "aws-kms" | "local-synthetic";
  requestId: string;
  runtime: OrganizerRuntime;
}>;
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
): IntermediateKeyCustodian {
  const metadata = authorities.get(authority);
  if (metadata?.custody !== "aws-kms" || metadata.custodian === undefined)
    throw new OrganizerUnavailableError();
  return metadata.custodian;
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
    custodian: IntermediateKeyCustodian;
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
    return Object.freeze({ close: () => transport?.destroy(), custodian });
  } catch {
    transport?.destroy();
    throw new OrganizerUnavailableError();
  }
}

function revocableCustodian(
  authority: OrganizerKeyAuthority,
  underlying: IntermediateKeyCustodian,
  requestSignal: AbortSignal
): Readonly<{ custodian: IntermediateKeyCustodian; revoke(): void }> {
  let open = true;
  const revoked = new AbortController();
  const signal = AbortSignal.any([requestSignal, revoked.signal]);
  const assertOpen = (): void => {
    if (!open || requestSignal.aborted || authorities.get(authority)?.custodian !== facade)
      throw new OrganizerUnavailableError();
  };
  const facade: IntermediateKeyCustodian = Object.freeze({
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
        if (proof.runtime === "production" || proof.oidcToken !== undefined)
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
      if (proof.runtime !== "production" || proof.oidcToken === undefined)
        throw new OrganizerUnavailableError();
      const session = await openAwsSession(boundary, signal);
      const authority = issue({
        custody: "aws-kms",
        requestId: proof.requestId,
        runtime: proof.runtime
      });
      const lease = revocableCustodian(authority, session.custodian, signal);
      authorities.set(authority, {
        custody: "aws-kms",
        custodian: lease.custodian,
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
