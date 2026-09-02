import { createHash, timingSafeEqual } from "node:crypto";

const MAX_HEADER_LENGTH = 2_048;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function hasValidSearchBearerCredential(header: string | null, secret: string): boolean {
  const actual = header ?? "";
  const bounded = actual.length <= MAX_HEADER_LENGTH ? actual : "header-too-long";
  return (
    timingSafeEqual(digest(bounded), digest(`Bearer ${secret}`)) &&
    actual.length <= MAX_HEADER_LENGTH
  );
}
