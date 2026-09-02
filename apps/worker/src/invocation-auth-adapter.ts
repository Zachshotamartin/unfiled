import { verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";

import { hasValidBearerCredential } from "./auth.js";
import type { VercelTrustedSource, WorkerRuntime } from "./config.js";
import { WorkerError, WorkerUnavailableError } from "./errors.js";

const MAX_TRUSTED_SOURCE_TOKEN_LENGTH = 16_384;
const CLOCK_TOLERANCE_SECONDS = 5;
/** Vercel issues runtime OIDC tokens that expire after 12 hours; anything longer is not a Vercel token. */
const MAX_TOKEN_LIFETIME_SECONDS = 12 * 3_600;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

declare const verifiedWorkerInvocationBrand: unique symbol;

/**
 * Request-scoped, opaque evidence issued only by this module. Runtime
 * membership is held in a WeakMap, so a matching object shape or type cast
 * cannot manufacture an accepted invocation.
 */
export type VerifiedWorkerInvocation = Readonly<{
  [verifiedWorkerInvocationBrand]: true;
}>;

type InvocationMetadata = Readonly<{
  requestId: string;
  runtime: WorkerRuntime;
}>;

const verifiedInvocations = new WeakMap<object, InvocationMetadata>();

function issueVerifiedInvocation(metadata: InvocationMetadata): VerifiedWorkerInvocation {
  const capability = Object.freeze(Object.create(null)) as VerifiedWorkerInvocation;
  verifiedInvocations.set(capability, metadata);
  return capability;
}

export function isVerifiedWorkerInvocation(
  value: unknown,
  expected: InvocationMetadata
): value is VerifiedWorkerInvocation {
  if (value === null || typeof value !== "object") return false;
  const metadata = verifiedInvocations.get(value);
  return metadata?.requestId === expected.requestId && metadata.runtime === expected.runtime;
}

export function authorizeLocalWorkerInvocation(
  input: Readonly<{
    authorizationHeader: string | null;
    requestId: string;
    runtime: "local";
    secret: string;
  }>
): VerifiedWorkerInvocation {
  if (!hasValidBearerCredential(input.authorizationHeader, input.secret)) {
    throw new WorkerError(401, "unauthorized", "Drain credential is invalid.");
  }
  return issueVerifiedInvocation({ requestId: input.requestId, runtime: input.runtime });
}

export type ProductionInvocationProof = Readonly<{
  authorizationHeader: string | null;
  protectionBypassHeader: string | null;
  requestId: string;
  trustedSourceToken: string | null;
}>;

export type ProductionInvocationAuthAdapter = Readonly<{
  authorize(
    proof: ProductionInvocationProof,
    signal: AbortSignal
  ): Promise<VerifiedWorkerInvocation>;
}>;

type TrustedSourcesOidcPayload = VercelOidcPayload &
  Readonly<{
    owner: string;
    project: string;
  }>;

type VerifiedTokenResult = Readonly<{
  payload: TrustedSourcesOidcPayload;
  protectedHeader: Readonly<{ alg?: string }>;
}>;

function unauthorizedInvocation(): WorkerError {
  return new WorkerError(401, "unauthorized", "Trusted source identity is invalid.");
}

function assertSignalActive(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkerUnavailableError();
}

function exactVerifiedClaims(
  result: VerifiedTokenResult,
  trustedSource: VercelTrustedSource,
  nowEpochSeconds: number
): boolean {
  const { payload, protectedHeader } = result;
  const { exp, iat, nbf } = payload;
  const validProductionLifetime =
    typeof exp === "number" &&
    typeof iat === "number" &&
    typeof nbf === "number" &&
    Number.isSafeInteger(exp) &&
    Number.isSafeInteger(iat) &&
    Number.isSafeInteger(nbf) &&
    exp > nowEpochSeconds - CLOCK_TOLERANCE_SECONDS &&
    iat <= nowEpochSeconds + CLOCK_TOLERANCE_SECONDS &&
    nbf <= nowEpochSeconds + CLOCK_TOLERANCE_SECONDS &&
    exp > iat &&
    nbf <= exp &&
    exp - iat <= MAX_TOKEN_LIFETIME_SECONDS + CLOCK_TOLERANCE_SECONDS;

  return (
    protectedHeader.alg === "RS256" &&
    payload.iss === trustedSource.issuer &&
    payload.aud === trustedSource.audience &&
    payload.sub === trustedSource.expectedSubject &&
    payload.owner === trustedSource.teamSlug &&
    payload.owner_id === trustedSource.ownerId &&
    payload.project === trustedSource.projectName &&
    payload.project_id === trustedSource.projectId &&
    payload.environment === trustedSource.environment &&
    validProductionLifetime
  );
}

/**
 * Verifies the source web project's forwarded OIDC token in addition to
 * Vercel Deployment Protection's Trusted Sources check. This is deliberately
 * unrelated to the worker workload token used for AWS STS.
 */
export function createVercelTrustedSourcesInvocationAuth(
  options: Readonly<{
    trustedSource: VercelTrustedSource;
  }>
): ProductionInvocationAuthAdapter {
  return Object.freeze({
    async authorize(
      proof: ProductionInvocationProof,
      signal: AbortSignal
    ): Promise<VerifiedWorkerInvocation> {
      const token = proof.trustedSourceToken;
      if (
        proof.authorizationHeader !== null ||
        proof.protectionBypassHeader !== null ||
        token === null ||
        token.length === 0 ||
        token.length > MAX_TRUSTED_SOURCE_TOKEN_LENGTH ||
        token !== token.trim() ||
        !JWT_PATTERN.test(token)
      ) {
        throw unauthorizedInvocation();
      }
      assertSignalActive(signal);

      let result: VerifiedTokenResult;
      try {
        result = await verifyVercelOidcToken<TrustedSourcesOidcPayload>(token, {
          algorithms: ["RS256"],
          audience: options.trustedSource.audience,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          environment: options.trustedSource.environment,
          issuer: options.trustedSource.issuer,
          ownerId: options.trustedSource.ownerId,
          projectId: options.trustedSource.projectId,
          subject: options.trustedSource.expectedSubject
        });
      } catch {
        throw unauthorizedInvocation();
      }
      assertSignalActive(signal);
      if (!exactVerifiedClaims(result, options.trustedSource, Math.floor(Date.now() / 1_000))) {
        throw unauthorizedInvocation();
      }
      return issueVerifiedInvocation({
        requestId: proof.requestId,
        runtime: options.trustedSource.environment
      });
    }
  });
}

/** Production stays closed if composition is accidentally omitted. */
export const unconfiguredProductionInvocationAuth: ProductionInvocationAuthAdapter = Object.freeze({
  authorize() {
    return Promise.reject(new WorkerUnavailableError());
  }
});
