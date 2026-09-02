import { verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";

import { hasValidSearchBearerCredential } from "./auth.js";
import type { SearchRuntime, SearchTrustedSource } from "./config.js";
import { SearchServiceError, unavailable } from "./errors.js";

const MAX_TOKEN_LENGTH = 16_384;
const CLOCK_TOLERANCE_SECONDS = 5;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
declare const verifiedSearchInvocationBrand: unique symbol;

export type VerifiedSearchInvocation = Readonly<{ [verifiedSearchInvocationBrand]: true }>;
type InvocationMetadata = Readonly<{ requestId: string; runtime: SearchRuntime }>;
const issued = new WeakMap<object, InvocationMetadata>();

function issue(metadata: InvocationMetadata): VerifiedSearchInvocation {
  const value = Object.freeze(Object.create(null)) as VerifiedSearchInvocation;
  issued.set(value, metadata);
  return value;
}

export function isVerifiedSearchInvocation(
  value: unknown,
  expected: InvocationMetadata
): value is VerifiedSearchInvocation {
  if (value === null || typeof value !== "object") return false;
  const metadata = issued.get(value);
  return metadata?.requestId === expected.requestId && metadata.runtime === expected.runtime;
}

export function authorizeLocalSearchInvocation(
  input: Readonly<{
    authorizationHeader: string | null;
    requestId: string;
    secret: string;
  }>
): VerifiedSearchInvocation {
  if (!hasValidSearchBearerCredential(input.authorizationHeader, input.secret)) {
    throw new SearchServiceError(401, "unauthorized");
  }
  return issue({ requestId: input.requestId, runtime: "local" });
}

type TrustedPayload = VercelOidcPayload & Readonly<{ owner: string; project: string }>;
type VerifiedToken = Readonly<{
  payload: TrustedPayload;
  protectedHeader: Readonly<{ alg?: string }>;
}>;

export type SearchInvocationAuth = Readonly<{
  authorize(
    input: Readonly<{
      authorizationHeader: string | null;
      protectionBypassHeader: string | null;
      requestId: string;
      trustedSourceToken: string | null;
    }>,
    signal: AbortSignal
  ): Promise<VerifiedSearchInvocation>;
}>;

function unauthorized(): never {
  throw new SearchServiceError(401, "unauthorized");
}

function exactClaims(result: VerifiedToken, trusted: SearchTrustedSource, now: number): boolean {
  const { payload, protectedHeader } = result;
  const { exp, iat, nbf } = payload;
  const lifetime =
    typeof exp === "number" &&
    typeof iat === "number" &&
    typeof nbf === "number" &&
    Number.isSafeInteger(exp) &&
    Number.isSafeInteger(iat) &&
    Number.isSafeInteger(nbf) &&
    exp > now - CLOCK_TOLERANCE_SECONDS &&
    iat <= now + CLOCK_TOLERANCE_SECONDS &&
    nbf <= now + CLOCK_TOLERANCE_SECONDS &&
    exp > iat &&
    nbf <= exp &&
    exp - iat <= 3_600 + CLOCK_TOLERANCE_SECONDS;
  return (
    protectedHeader.alg === "RS256" &&
    payload.iss === trusted.issuer &&
    payload.aud === trusted.audience &&
    payload.sub === trusted.expectedSubject &&
    payload.owner === trusted.teamSlug &&
    payload.owner_id === trusted.ownerId &&
    payload.project === trusted.projectName &&
    payload.project_id === trusted.projectId &&
    payload.environment === trusted.environment &&
    lifetime
  );
}

async function verifyWithAbort(
  token: string,
  trusted: SearchTrustedSource,
  signal: AbortSignal
): Promise<VerifiedToken> {
  if (signal.aborted) return unavailable();
  let rejectAbort: ((reason: SearchServiceError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void =>
    rejectAbort?.(new SearchServiceError(503, "provider_unavailable", { retryable: true }));
  signal.addEventListener("abort", onAbort, { once: true });
  const verification = verifyVercelOidcToken<TrustedPayload>(token, {
    algorithms: ["RS256"],
    audience: trusted.audience,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    environment: trusted.environment,
    issuer: trusted.issuer,
    ownerId: trusted.ownerId,
    projectId: trusted.projectId,
    subject: trusted.expectedSubject
  });
  void verification.catch(() => undefined);
  try {
    return await Promise.race([verification, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createSearchInvocationAuth(trusted: SearchTrustedSource): SearchInvocationAuth {
  return Object.freeze({
    async authorize(input, signal) {
      const token = input.trustedSourceToken;
      if (
        input.authorizationHeader !== null ||
        input.protectionBypassHeader !== null ||
        token === null ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH ||
        token.trim() !== token ||
        !JWT.test(token)
      ) {
        return unauthorized();
      }
      let result: VerifiedToken;
      try {
        result = await verifyWithAbort(token, trusted, signal);
      } catch (error: unknown) {
        if (error instanceof SearchServiceError && error.code === "provider_unavailable")
          throw error;
        return unauthorized();
      }
      if (signal.aborted) return unavailable();
      if (!exactClaims(result, trusted, Math.floor(Date.now() / 1_000))) return unauthorized();
      return issue({ requestId: input.requestId, runtime: trusted.environment });
    }
  });
}
