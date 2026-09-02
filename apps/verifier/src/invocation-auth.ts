import { verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";

import type { VercelTrustedSource } from "./config.js";
import { VerifierError, VerifierUnavailableError } from "./errors.js";

const MAX_OIDC_TOKEN_LENGTH = 16_384;
const CLOCK_TOLERANCE_SECONDS = 5;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

declare const verifiedVerifierInvocationBrand: unique symbol;

export type VerifiedVerifierInvocation = Readonly<{
  [verifiedVerifierInvocationBrand]: true;
}>;

type InvocationMetadata = Readonly<{
  requestId: string;
  runtime: "preview" | "production";
}>;

const verifiedInvocations = new WeakMap<object, InvocationMetadata>();

function issueVerifiedInvocation(metadata: InvocationMetadata): VerifiedVerifierInvocation {
  const capability = Object.freeze(Object.create(null)) as VerifiedVerifierInvocation;
  verifiedInvocations.set(capability, metadata);
  return capability;
}

export function isVerifiedVerifierInvocation(
  value: unknown,
  expected: InvocationMetadata
): value is VerifiedVerifierInvocation {
  if (value === null || typeof value !== "object") return false;
  const metadata = verifiedInvocations.get(value);
  return metadata?.requestId === expected.requestId && metadata.runtime === expected.runtime;
}

export type ProductionInvocationProof = Readonly<{
  authorizationHeader: string | null;
  protectionBypassHeader: string | null;
  requestId: string;
  trustedSourceToken: string | null;
}>;

export type ProductionInvocationAuth = Readonly<{
  authorize(
    proof: ProductionInvocationProof,
    signal: AbortSignal
  ): Promise<VerifiedVerifierInvocation>;
}>;

type TrustedSourcesPayload = VercelOidcPayload &
  Readonly<{
    owner: string;
    project: string;
  }>;

type VerifiedTokenResult = Readonly<{
  payload: TrustedSourcesPayload;
  protectedHeader: Readonly<{ alg?: string }>;
}>;

function unauthorized(): VerifierError {
  return new VerifierError(401, "unauthorized", "Trusted source identity is invalid.");
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new VerifierUnavailableError();
}

function hasExactClaims(
  result: VerifiedTokenResult,
  trustedSource: VercelTrustedSource,
  nowEpochSeconds: number
): boolean {
  const { payload, protectedHeader } = result;
  const { exp, iat, nbf } = payload;
  const validLifetime =
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
    exp - iat <= 3_600 + CLOCK_TOLERANCE_SECONDS;
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
    validLifetime
  );
}

export function createProductionInvocationAuth(
  trustedSource: VercelTrustedSource
): ProductionInvocationAuth {
  return Object.freeze({
    async authorize(proof, signal): Promise<VerifiedVerifierInvocation> {
      const token = proof.trustedSourceToken;
      if (
        proof.authorizationHeader !== null ||
        proof.protectionBypassHeader !== null ||
        token === null ||
        token.length === 0 ||
        token.length > MAX_OIDC_TOKEN_LENGTH ||
        token !== token.trim() ||
        !JWT_PATTERN.test(token)
      ) {
        throw unauthorized();
      }
      assertActive(signal);
      let result: VerifiedTokenResult;
      try {
        result = await verifyVercelOidcToken<TrustedSourcesPayload>(token, {
          algorithms: ["RS256"],
          audience: trustedSource.audience,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          environment: trustedSource.environment,
          issuer: trustedSource.issuer,
          ownerId: trustedSource.ownerId,
          projectId: trustedSource.projectId,
          subject: trustedSource.expectedSubject
        });
      } catch {
        throw unauthorized();
      }
      assertActive(signal);
      if (!hasExactClaims(result, trustedSource, Math.floor(Date.now() / 1_000))) {
        throw unauthorized();
      }
      return issueVerifiedInvocation({
        requestId: proof.requestId,
        runtime: trustedSource.environment
      });
    }
  });
}

export const unconfiguredProductionInvocationAuth: ProductionInvocationAuth = Object.freeze({
  authorize(): Promise<never> {
    return Promise.reject(new VerifierUnavailableError());
  }
});

export function assertWorkloadOidcPresence(request: Request): void {
  const value = request.headers.get("x-vercel-oidc-token")?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_OIDC_TOKEN_LENGTH ||
    !JWT_PATTERN.test(value)
  ) {
    throw new VerifierUnavailableError();
  }
}
