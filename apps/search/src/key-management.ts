import {
  createAwsKmsEnvelopeCustodian,
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  createVercelSensitiveEnvironmentKmsTransport,
  createVercelOidcKmsTransport,
  type DecryptOnlyIntermediateKeyCustodian,
  type KeyCustodyOperationOptions,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser,
  type ManagedKeyRecordV1,
  type ManagedKeyRecordV2,
  parseManagedKeyRecordV1,
  parseManagedKeyRecordV2
} from "@unfiled/key-management";

import type { SearchConfig, SearchKeyBoundary, SearchRuntime } from "./config.js";
import { SearchServiceError, unavailable } from "./errors.js";
import { isVerifiedSearchInvocation, type VerifiedSearchInvocation } from "./invocation-auth.js";

const MAX_OIDC_TOKEN_LENGTH = 16_384;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

declare const searchKeyAuthorityBrand: unique symbol;

/** Opaque, request-scoped authority to open AI-assisted search-index envelopes. */
export type SearchKeyAuthority = Readonly<{ [searchKeyAuthorityBrand]: true }>;

type AuthorityMetadata = Readonly<{
  custodian: SearchDecryptOnlyCustodian;
  parseRecord: SearchManagedKeyRecordParser;
  requestId: string;
  runtime: Exclude<SearchRuntime, "local">;
}>;

export type SearchManagedKeyRecord = ManagedKeyRecordV1 | ManagedKeyRecordV2;
export type SearchManagedKeyRecordParser = ManagedKeyRecordParser<SearchManagedKeyRecord>;
export type SearchDecryptOnlyCustodian =
  DecryptOnlyIntermediateKeyCustodian<SearchManagedKeyRecord>;

const authorities = new WeakMap<object, AuthorityMetadata>();

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) unavailable();
}

function issue(metadata: AuthorityMetadata): SearchKeyAuthority {
  const authority = Object.freeze(Object.create(null)) as SearchKeyAuthority;
  authorities.set(authority, metadata);
  return authority;
}

export function isSearchKeyAuthority(
  value: unknown,
  expected?: Readonly<{ requestId: string; runtime: Exclude<SearchRuntime, "local"> }>
): value is SearchKeyAuthority {
  if (value === null || typeof value !== "object") return false;
  const metadata = authorities.get(value);
  return (
    metadata !== undefined &&
    (expected === undefined ||
      (metadata.requestId === expected.requestId && metadata.runtime === expected.runtime))
  );
}

/** Available only while the adapter's authority callback is active. */
export function custodianForSearchAuthority(
  authority: SearchKeyAuthority
): SearchDecryptOnlyCustodian {
  const metadata = authorities.get(authority);
  if (metadata === undefined) unavailable();
  return metadata.custodian;
}

export function managedKeyRecordParserForSearchAuthority(
  authority: SearchKeyAuthority
): SearchManagedKeyRecordParser {
  const metadata = authorities.get(authority);
  if (metadata === undefined) unavailable();
  return metadata.parseRecord;
}

export function managedKeyRecordParserForSearchBoundary(
  boundary: SearchConfig["keyBoundary"]
): SearchManagedKeyRecordParser {
  return boundary.kind === "vercel-sensitive-env-v1"
    ? parseManagedKeyRecordV2
    : parseManagedKeyRecordV1;
}

export function isAwsSearchBoundary(
  boundary: SearchKeyBoundary
): boundary is Extract<SearchKeyBoundary, Readonly<{ kind: "aws-oidc" }>> {
  return boundary.kind === "aws-oidc";
}

/**
 * Extracts bounded presence evidence for the workload token. AWS STS and the
 * role's exact-subject trust policy remain the authoritative verification.
 */
export function oidcTokenFromRequest(
  request: Request,
  boundary: SearchConfig["keyBoundary"]
): string | undefined {
  if (boundary.kind !== "aws-oidc") return undefined;
  const raw = request.headers.get("x-vercel-oidc-token");
  const token = raw?.trim();
  if (
    token === undefined ||
    token.length === 0 ||
    token.length > MAX_OIDC_TOKEN_LENGTH ||
    raw !== token ||
    !JWT_PATTERN.test(token)
  ) {
    unavailable();
  }
  return token;
}

export type SearchIdentityProof = Readonly<{
  invocation: VerifiedSearchInvocation;
  oidcToken: string | undefined;
  requestId: string;
  runtime: SearchRuntime;
}>;

export type SearchKeyManagementAdapter = Readonly<{
  withAiAssistedSearchAuthority<Result>(
    boundary: SearchConfig["keyBoundary"],
    proof: SearchIdentityProof,
    signal: AbortSignal,
    use: (authority: SearchKeyAuthority) => Promise<Result>
  ): Promise<Result>;
}>;

type SearchKeySession = Readonly<{
  close(): void;
  custodian: SearchDecryptOnlyCustodian;
  parseRecord: SearchManagedKeyRecordParser;
}>;

function widenCustodian<Record extends ManagedKeyRecord>(
  custodian: DecryptOnlyIntermediateKeyCustodian<Record>
): SearchDecryptOnlyCustodian {
  return Object.freeze({
    withUnwrappedIntermediateKey(record, use, options) {
      return custodian.withUnwrappedIntermediateKey(
        record,
        (bytes, parsed) => use(bytes, parsed),
        options
      );
    }
  });
}

async function openTransport(
  boundary: Extract<SearchKeyBoundary, Readonly<{ kind: "aws-oidc" }>>,
  signal: AbortSignal
): Promise<Awaited<ReturnType<typeof createVercelOidcKmsTransport>>> {
  assertActive(signal);
  let aborted = false;
  let rejectAbort: ((error: unknown) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    aborted = true;
    try {
      unavailable();
    } catch (error: unknown) {
      rejectAbort?.(error);
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const pending = createVercelOidcKmsTransport({
    maxAttempts: 2,
    region: boundary.region,
    roleArn: boundary.roleArn,
    workload: "search_worker"
  });
  void pending.then(
    (transport) => {
      if (aborted || signal.aborted) transport.destroy();
    },
    () => undefined
  );
  try {
    const transport = await Promise.race([pending, abort]);
    if (signal.aborted) {
      transport.destroy();
      unavailable();
    }
    return transport;
  } catch {
    unavailable();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function openAwsSession(
  boundary: Extract<SearchKeyBoundary, Readonly<{ kind: "aws-oidc" }>>,
  signal: AbortSignal
): Promise<SearchKeySession> {
  let transport: Awaited<ReturnType<typeof createVercelOidcKmsTransport>> | undefined;
  try {
    transport = await openTransport(boundary, signal);
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: {
        ai_assisted: { object_wrap: boundary.activeObjectWrapKeyArn }
      },
      retiredRoots: {
        ai_assisted: { object_wrap: boundary.retiredObjectWrapKeyArns }
      },
      transport,
      workload: "search_worker"
    });
    return Object.freeze({
      close(): void {
        transport?.destroy();
      },
      custodian: widenCustodian(custodian),
      parseRecord: parseManagedKeyRecordV1
    });
  } catch {
    transport?.destroy();
    unavailable();
  }
}

async function openSensitiveSession(
  boundary: Extract<SearchKeyBoundary, Readonly<{ kind: "vercel-sensitive-env-v1" }>>,
  signal: AbortSignal
): Promise<SearchKeySession> {
  let transport:
    Awaited<ReturnType<typeof createVercelSensitiveEnvironmentKmsTransport>> | undefined;
  try {
    assertActive(signal);
    transport = await createVercelSensitiveEnvironmentKmsTransport({
      expectedRootKeyIds: [
        boundary.activeObjectWrapRootKeyId,
        ...boundary.retiredObjectWrapRootKeyIds
      ]
    });
    assertActive(signal);
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: {
        ai_assisted: { object_wrap: boundary.activeObjectWrapRootKeyId }
      },
      deploymentEnvironment: boundary.deploymentEnvironment,
      retiredRoots: {
        ai_assisted: { object_wrap: boundary.retiredObjectWrapRootKeyIds }
      },
      transport,
      workload: "search_worker"
    });
    return Object.freeze({
      close(): void {
        transport?.destroy();
      },
      custodian: widenCustodian(custodian),
      parseRecord: parseManagedKeyRecordV2
    });
  } catch {
    transport?.destroy();
    unavailable();
  }
}

function revocableCustodian(
  authority: SearchKeyAuthority,
  underlying: SearchDecryptOnlyCustodian,
  requestSignal: AbortSignal
): Readonly<{ custodian: SearchDecryptOnlyCustodian; revoke(): void }> {
  let open = true;
  const revocation = new AbortController();
  const leaseSignal = AbortSignal.any([requestSignal, revocation.signal]);

  const assertOpen = (): void => {
    const metadata = authorities.get(authority);
    if (!open || leaseSignal.aborted || metadata?.custodian !== facade) unavailable();
  };

  const facade: SearchDecryptOnlyCustodian = Object.freeze({
    async withUnwrappedIntermediateKey<Result>(
      record: unknown,
      use: (keyBytes: Uint8Array, parsedRecord: SearchManagedKeyRecord) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      assertOpen();
      const signal =
        options?.signal === undefined
          ? leaseSignal
          : AbortSignal.any([leaseSignal, options.signal]);
      assertActive(signal);

      let rejectAbort: ((error: unknown) => void) | undefined;
      const abort = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = (): void => {
        try {
          unavailable();
        } catch (error: unknown) {
          rejectAbort?.(error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      const pending = underlying.withUnwrappedIntermediateKey(
        record,
        async (keyBytes, parsedRecord) => {
          assertOpen();
          return await use(keyBytes, parsedRecord);
        },
        { signal }
      );
      void pending.catch(() => undefined);
      try {
        return await Promise.race([pending, abort]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
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

export function createSearchKeyManagementAdapter(): SearchKeyManagementAdapter {
  return Object.freeze({
    async withAiAssistedSearchAuthority(boundary, proof, signal, use) {
      if (
        !isVerifiedSearchInvocation(proof.invocation, {
          requestId: proof.requestId,
          runtime: proof.runtime
        }) ||
        signal.aborted ||
        boundary.kind === "local-disabled" ||
        proof.runtime === "local"
      ) {
        unavailable();
      }

      const session =
        boundary.kind === "aws-oidc"
          ? (() => {
              if (
                !boundary.expectedOidcSubject.endsWith(`:environment:${proof.runtime}`) ||
                proof.oidcToken === undefined ||
                proof.oidcToken.length === 0 ||
                proof.oidcToken.length > MAX_OIDC_TOKEN_LENGTH ||
                !JWT_PATTERN.test(proof.oidcToken)
              ) {
                unavailable();
              }
              return openAwsSession(boundary, signal);
            })()
          : (() => {
              if (
                proof.oidcToken !== undefined ||
                boundary.deploymentEnvironment !== proof.runtime
              ) {
                unavailable();
              }
              return openSensitiveSession(boundary, signal);
            })();
      const openedSession = await session;
      const runtime = proof.runtime;
      const initialCustodian = openedSession.custodian;
      let authority: SearchKeyAuthority | undefined;
      let lease: ReturnType<typeof revocableCustodian> | undefined;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        lease?.revoke();
        if (authority !== undefined) authorities.delete(authority);
        openedSession.close();
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        assertActive(signal);
        authority = issue({
          custodian: initialCustodian,
          parseRecord: openedSession.parseRecord,
          requestId: proof.requestId,
          runtime
        });
        lease = revocableCustodian(authority, initialCustodian, signal);
        authorities.set(authority, {
          custodian: lease.custodian,
          parseRecord: openedSession.parseRecord,
          requestId: proof.requestId,
          runtime
        });
        return await use(authority);
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    }
  });
}

/** Fails closed when production composition is omitted. */
export const unconfiguredSearchKeyManagementAdapter: SearchKeyManagementAdapter = Object.freeze({
  withAiAssistedSearchAuthority() {
    return Promise.reject(new SearchServiceError(503, "provider_unavailable", { retryable: true }));
  }
});
