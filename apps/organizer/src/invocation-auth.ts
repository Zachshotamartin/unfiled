import { verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";

import { hasValidBearerCredential } from "./auth.js";
import type { OrganizerRuntime, VercelTrustedSource } from "./config.js";
import { OrganizerError, OrganizerUnavailableError } from "./errors.js";

const MAX_TOKEN_LENGTH = 16_384;
const CLOCK_TOLERANCE_SECONDS = 5;
/** Vercel issues runtime OIDC tokens that expire after 12 hours; anything longer is not a Vercel token. */
const MAX_TOKEN_LIFETIME_SECONDS = 12 * 3_600;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
declare const verifiedOrganizerInvocationBrand: unique symbol;

export type VerifiedOrganizerInvocation = Readonly<{
  [verifiedOrganizerInvocationBrand]: true;
}>;
type InvocationMetadata = Readonly<{ requestId: string; runtime: OrganizerRuntime }>;
const issued = new WeakMap<object, InvocationMetadata>();

function issue(metadata: InvocationMetadata): VerifiedOrganizerInvocation {
  const capability = Object.freeze(Object.create(null)) as VerifiedOrganizerInvocation;
  issued.set(capability, metadata);
  return capability;
}

export function isVerifiedOrganizerInvocation(
  value: unknown,
  expected: InvocationMetadata
): value is VerifiedOrganizerInvocation {
  if (value === null || typeof value !== "object") return false;
  const metadata = issued.get(value);
  return metadata?.requestId === expected.requestId && metadata.runtime === expected.runtime;
}

export function authorizeLocalOrganizerInvocation(
  input: Readonly<{
    authorizationHeader: string | null;
    requestId: string;
    runtime: "local";
    secret: string;
  }>
): VerifiedOrganizerInvocation {
  if (!hasValidBearerCredential(input.authorizationHeader, input.secret)) {
    throw new OrganizerError(401, "unauthorized", "Drain credential is invalid.");
  }
  return issue({ requestId: input.requestId, runtime: input.runtime });
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
  ): Promise<VerifiedOrganizerInvocation>;
}>;
type TrustedPayload = VercelOidcPayload & Readonly<{ owner: string; project: string }>;

/**
 * Server-side only. A rejected trusted-source call is otherwise invisible in
 * platform logs; the reason names the failing verification step or claim
 * names, never token material or claim values.
 */
function unauthorized(reason: string): OrganizerError {
  console.error(
    JSON.stringify({
      event: "organizer.trusted_source_rejected",
      service: "unfiled-organizer",
      reason
    })
  );
  return new OrganizerError(401, "unauthorized", "Trusted source identity is invalid.");
}

function verificationReason(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
    const claim = "claim" in error && typeof error.claim === "string" ? `:${error.claim}` : "";
    return `verification:${code.replaceAll(/[^A-Za-z0-9_]/gu, "_")}${claim.replaceAll(/[^A-Za-z0-9_:]/gu, "_")}`;
  }
  return "verification:unknown";
}

function claimMismatches(
  result: Readonly<{ payload: TrustedPayload; protectedHeader: Readonly<{ alg?: string }> }>,
  trusted: VercelTrustedSource,
  now: number
): readonly string[] {
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
    exp - iat <= MAX_TOKEN_LIFETIME_SECONDS + CLOCK_TOLERANCE_SECONDS;
  const checks: readonly (readonly [string, boolean])[] = [
    ["alg", protectedHeader.alg === "RS256"],
    ["iss", payload.iss === trusted.issuer],
    ["aud", payload.aud === trusted.audience],
    ["sub", payload.sub === trusted.expectedSubject],
    ["owner", payload.owner === trusted.teamSlug],
    ["owner_id", payload.owner_id === trusted.ownerId],
    ["project", payload.project === trusted.projectName],
    ["project_id", payload.project_id === trusted.projectId],
    ["environment", payload.environment === trusted.environment],
    ["lifetime", lifetime]
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

async function verifyWithAbort(
  token: string,
  trusted: VercelTrustedSource,
  signal: AbortSignal
): Promise<Readonly<{ payload: TrustedPayload; protectedHeader: Readonly<{ alg?: string }> }>> {
  if (signal.aborted) throw new OrganizerUnavailableError();
  let rejectAbort: ((reason: OrganizerUnavailableError) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(new OrganizerUnavailableError());
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
    return await Promise.race([verification, abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createVercelTrustedSourcesInvocationAuth(
  options: Readonly<{
    trustedSource: VercelTrustedSource;
  }>
): ProductionInvocationAuthAdapter {
  return Object.freeze({
    async authorize(proof, signal) {
      const token = proof.trustedSourceToken;
      if (
        proof.authorizationHeader !== null ||
        proof.protectionBypassHeader !== null ||
        token === null ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH ||
        token !== token.trim() ||
        !JWT_PATTERN.test(token)
      ) {
        throw unauthorized("proof_shape");
      }
      let result: Awaited<ReturnType<typeof verifyWithAbort>>;
      try {
        result = await verifyWithAbort(token, options.trustedSource, signal);
      } catch (error: unknown) {
        if (error instanceof OrganizerUnavailableError) throw error;
        throw unauthorized(verificationReason(error));
      }
      if (signal.aborted) throw new OrganizerUnavailableError();
      const mismatches = claimMismatches(
        result,
        options.trustedSource,
        Math.floor(Date.now() / 1_000)
      );
      if (mismatches.length > 0) throw unauthorized(`claims:${mismatches.join(",")}`);
      return issue({ requestId: proof.requestId, runtime: options.trustedSource.environment });
    }
  });
}

export const unconfiguredProductionInvocationAuth: ProductionInvocationAuthAdapter = Object.freeze({
  authorize() {
    return Promise.reject(new OrganizerUnavailableError());
  }
});
