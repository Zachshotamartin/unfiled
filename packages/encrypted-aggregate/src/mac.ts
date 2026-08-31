import type {
  KeyClass,
  ManagedContentMacKey,
  OwnerBoundKeyResolver
} from "@unfiled/key-management";

import { canonicalPayloadBytes } from "./canonical.js";
import {
  EncryptedAggregateError,
  EncryptedAggregateErrorCode,
  aggregateFailure
} from "./errors.js";
import type { ContentMacKeyReference, KeyedMacRecord } from "./types.js";
import { exactKeyReference } from "./validation.js";

const PASSTHROUGH_CODEC = Object.freeze({ parse: (value: unknown): unknown => value });
const HEX_PATTERN = /^[0-9a-f]{64}$/u;

function runtimeCrypto(provided?: Crypto): Crypto {
  const implementation =
    (provided as Partial<Crypto> | undefined) ??
    (globalThis as unknown as { crypto?: Partial<Crypto> }).crypto;
  if (implementation?.subtle === undefined) {
    aggregateFailure(
      EncryptedAggregateErrorCode.UNSUPPORTED_RUNTIME,
      "A Web Crypto implementation is required"
    );
  }
  return implementation as Crypto;
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function assertHmacKey(key: CryptoKey, usage: "sign" | "verify"): void {
  const algorithm = key.algorithm;
  const hash = "hash" in algorithm ? algorithm.hash : undefined;
  const hashName =
    typeof hash === "string"
      ? hash
      : typeof hash === "object" && hash !== null && "name" in hash && typeof hash.name === "string"
        ? hash.name
        : undefined;
  if (
    algorithm.name !== "HMAC" ||
    !("length" in algorithm) ||
    algorithm.length !== 256 ||
    hashName !== "SHA-256" ||
    key.extractable ||
    !key.usages.includes(usage)
  ) {
    aggregateFailure(EncryptedAggregateErrorCode.KEY_UNAVAILABLE, "Content MAC key is unavailable");
  }
}

function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function fromHex(value: string): Uint8Array {
  if (!HEX_PATTERN.test(value)) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Keyed MAC record is invalid");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function macRecord(key: ManagedContentMacKey, value: string): KeyedMacRecord {
  return Object.freeze({
    value,
    keyId: key.reference.keyId,
    keyClass: key.reference.keyClass,
    keyPurpose: "content_mac" as const,
    keyVersion: key.reference.keyVersion
  });
}

function assertResolvedMacKey(
  resolved: ManagedContentMacKey,
  expected: Readonly<{
    ownerId: string;
    keyClass: KeyClass;
    keyId?: string;
    keyVersion?: number;
  }>,
  usage: "sign" | "verify"
): void {
  if (
    !exactKeyReference(resolved.reference, {
      ...expected,
      purpose: "content_mac"
    })
  ) {
    aggregateFailure(EncryptedAggregateErrorCode.KEY_UNAVAILABLE, "Content MAC key is unavailable");
  }
  assertHmacKey(resolved.key, usage);
}

export async function createKeyedMac(
  keyResolver: OwnerBoundKeyResolver,
  ownerId: string,
  keyClass: KeyClass,
  message: unknown,
  cryptoImplementation?: Crypto,
  keyReference?: ContentMacKeyReference
): Promise<KeyedMacRecord> {
  let key: ManagedContentMacKey;
  if (keyReference === undefined) {
    try {
      key = await keyResolver.activeContentMacKey({ ownerId, keyClass });
    } catch {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Content MAC key is unavailable"
      );
    }
    assertResolvedMacKey(key, { ownerId, keyClass }, "sign");
  } else {
    if (
      !exactKeyReference(keyReference, {
        ownerId,
        keyClass,
        purpose: "content_mac",
        keyId: keyReference.keyId,
        keyVersion: keyReference.keyVersion
      })
    ) {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Content MAC key is unavailable"
      );
    }
    let resolved: ManagedContentMacKey | null;
    try {
      resolved = await keyResolver.resolveContentMacKey({
        ownerId,
        keyClass,
        keyId: keyReference.keyId
      });
    } catch {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Content MAC key is unavailable"
      );
    }
    if (resolved === null) {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Content MAC key is unavailable"
      );
    }
    key = resolved;
    assertResolvedMacKey(
      key,
      {
        ownerId,
        keyClass,
        keyId: keyReference.keyId,
        keyVersion: keyReference.keyVersion
      },
      "sign"
    );
  }
  const implementation = runtimeCrypto(cryptoImplementation);
  const encoded = canonicalPayloadBytes(PASSTHROUGH_CODEC, message).bytes;
  const encodedBuffer = copiedBuffer(encoded);
  let signature: Uint8Array | undefined;
  try {
    signature = new Uint8Array(await implementation.subtle.sign("HMAC", key.key, encodedBuffer));
    if (signature.length !== 32) {
      aggregateFailure(EncryptedAggregateErrorCode.INTEGRITY_CHECK_FAILED, "MAC creation failed");
    }
    return macRecord(key, toHex(signature));
  } catch (error: unknown) {
    if (error instanceof EncryptedAggregateError) throw error;
    return aggregateFailure(
      EncryptedAggregateErrorCode.INTEGRITY_CHECK_FAILED,
      "MAC creation failed"
    );
  } finally {
    encoded.fill(0);
    new Uint8Array(encodedBuffer).fill(0);
    signature?.fill(0);
  }
}

export async function verifyKeyedMac(
  keyResolver: OwnerBoundKeyResolver,
  ownerId: string,
  record: KeyedMacRecord,
  message: unknown,
  cryptoImplementation?: Crypto
): Promise<boolean> {
  let resolved: ManagedContentMacKey | null;
  try {
    resolved = await keyResolver.resolveContentMacKey({
      ownerId,
      keyClass: record.keyClass,
      keyId: record.keyId
    });
  } catch {
    aggregateFailure(EncryptedAggregateErrorCode.KEY_UNAVAILABLE, "Content MAC key is unavailable");
  }
  if (resolved === null) {
    aggregateFailure(EncryptedAggregateErrorCode.KEY_UNAVAILABLE, "Content MAC key is unavailable");
  }
  assertResolvedMacKey(
    resolved,
    {
      ownerId,
      keyClass: record.keyClass,
      keyId: record.keyId,
      keyVersion: record.keyVersion
    },
    "verify"
  );
  const implementation = runtimeCrypto(cryptoImplementation);
  const encoded = canonicalPayloadBytes(PASSTHROUGH_CODEC, message).bytes;
  const signature = fromHex(record.value);
  const encodedBuffer = copiedBuffer(encoded);
  const signatureBuffer = copiedBuffer(signature);
  try {
    return await implementation.subtle.verify("HMAC", resolved.key, signatureBuffer, encodedBuffer);
  } catch {
    aggregateFailure(EncryptedAggregateErrorCode.INTEGRITY_CHECK_FAILED, "MAC verification failed");
  } finally {
    encoded.fill(0);
    signature.fill(0);
    new Uint8Array(encodedBuffer).fill(0);
    new Uint8Array(signatureBuffer).fill(0);
  }
}
