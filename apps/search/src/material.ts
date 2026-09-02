import { createHash, timingSafeEqual } from "node:crypto";

import {
  serializeEncryptedUserSearchMaterial,
  type EncryptedUserSearchInvocation,
  type EncryptedUserSearchMaterial
} from "@unfiled/contracts";

export function encryptedUserSearchRequestDigest(material: EncryptedUserSearchMaterial): string {
  return createHash("sha256")
    .update(serializeEncryptedUserSearchMaterial(material), "utf8")
    .digest("hex");
}

export function hasValidEncryptedUserSearchDigest(
  invocation: EncryptedUserSearchInvocation
): boolean {
  const actual = Buffer.from(invocation.requestDigest, "hex");
  const expected = Buffer.from(encryptedUserSearchRequestDigest(invocation.material), "hex");
  try {
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}
