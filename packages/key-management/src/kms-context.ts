import type { KmsEncryptionContext } from "./aws-transport.js";
import type { KeyReference } from "./types.js";
import { parseKeyReference } from "./validation.js";

export function keyEnvelopeContextForKey(value: KeyReference): KmsEncryptionContext {
  const reference = parseKeyReference({
    ownerId: value.ownerId,
    keyClass: value.keyClass,
    purpose: value.purpose,
    keyId: value.keyId,
    keyVersion: value.keyVersion
  });
  return Object.freeze({
    UnfiledOwnerId: reference.ownerId,
    UnfiledKeyClass: reference.keyClass,
    UnfiledKeyPurpose: reference.purpose,
    UnfiledKeyRecordId: reference.keyId
  });
}

/** Backwards-compatible AWS-facing name for the provider-neutral envelope AAD. */
export function kmsEncryptionContextForKey(value: KeyReference): KmsEncryptionContext {
  return keyEnvelopeContextForKey(value);
}
