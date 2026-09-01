import { createHash, timingSafeEqual } from "node:crypto";

const MAX_AUTHORIZATION_HEADER_LENGTH = 2_048;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function hasValidBearerCredential(
  authorizationHeader: string | null,
  secret: string
): boolean {
  const actual = authorizationHeader ?? "";
  const bounded =
    actual.length <= MAX_AUTHORIZATION_HEADER_LENGTH ? actual : "authorization-header-too-long";
  const matches = timingSafeEqual(digest(bounded), digest(`Bearer ${secret}`));
  return actual.length <= MAX_AUTHORIZATION_HEADER_LENGTH && matches;
}
