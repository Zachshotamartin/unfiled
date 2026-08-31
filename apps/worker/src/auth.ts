import { createHash, timingSafeEqual } from "node:crypto";

const MAX_AUTHORIZATION_HEADER_LENGTH = 2_048;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compares fixed-length digests so secret length is not exposed through the
 * comparison primitive. Authorization syntax is exact and accepts no padding.
 */
export function hasValidBearerCredential(
  authorizationHeader: string | null,
  secret: string
): boolean {
  const actual = authorizationHeader ?? "";
  const boundedActual =
    actual.length <= MAX_AUTHORIZATION_HEADER_LENGTH ? actual : "authorization-header-too-long";
  const matches = timingSafeEqual(digest(boundedActual), digest(`Bearer ${secret}`));
  return actual.length <= MAX_AUTHORIZATION_HEADER_LENGTH && matches;
}
