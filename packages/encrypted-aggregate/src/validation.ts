import {
  parseContentEnvelope,
  serializeContentEnvelope,
  type ContentEnvelopeV1,
  type EncryptedContentKind
} from "@unfiled/content-crypto";
import {
  PrivacyModeSchema,
  parseEntityId,
  type EntityKind,
  type PrivacyMode
} from "@unfiled/contracts";
import type { KeyClass, KeyReference } from "@unfiled/key-management";

import { EncryptedAggregateErrorCode, aggregateFailure } from "./errors.js";
import type {
  AggregateContentKind,
  EncryptedAggregateRecord,
  KeyedMacRecord,
  PrivacyTransition
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const HEX_MAC_PATTERN = /^[0-9a-f]{64}$/u;
const RECORD_KEYS = [
  "ownerId",
  "resourceId",
  "recordVersion",
  "kind",
  "envelope",
  "keyId",
  "keyClass",
  "keyPurpose",
  "keyVersion"
] as const;
const SEALED_RECORD_KEYS = [...RECORD_KEYS, "reservationId"] as const;
const MAC_KEYS = ["value", "keyId", "keyClass", "keyPurpose", "keyVersion"] as const;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function assertIdentifier(value: string, label = "Identifier"): void {
  if (value.length === 0 || value.length > 128 || !IDENTIFIER_PATTERN.test(value)) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, `${label} is invalid`);
  }
}

export function assertEntityId(value: string, kind: EntityKind): void {
  try {
    parseEntityId(value, kind);
  } catch {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, "Resource identifier is invalid");
  }
}

export function assertRecordVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, "Record version is invalid");
  }
}

export function parsePrivacy(value: unknown): PrivacyMode {
  const result = PrivacyModeSchema.safeParse(value);
  if (!result.success) {
    aggregateFailure(
      EncryptedAggregateErrorCode.INVALID_INPUT,
      "Privacy classification is invalid"
    );
  }
  return result.data;
}

export function stickyKeyClass(transition: PrivacyTransition): KeyClass {
  const after = parsePrivacy(transition.after);
  const before = transition.before === null ? null : parsePrivacy(transition.before);
  return before === "private_manual" || after === "private_manual"
    ? "private_manual"
    : "ai_assisted";
}

export function exactKeyReference(
  actual: KeyReference,
  expected: Readonly<{
    ownerId: string;
    keyClass: KeyClass;
    purpose: "content_mac" | "object_wrap";
    keyId?: string;
    keyVersion?: number;
  }>
): boolean {
  return (
    actual.ownerId === expected.ownerId &&
    actual.keyClass === expected.keyClass &&
    actual.purpose === expected.purpose &&
    (expected.keyId === undefined || actual.keyId === expected.keyId) &&
    (expected.keyVersion === undefined || actual.keyVersion === expected.keyVersion) &&
    Number.isSafeInteger(actual.keyVersion) &&
    actual.keyVersion >= 1
  );
}

function parseEnvelope(value: unknown): ContentEnvelopeV1 {
  try {
    return parseContentEnvelope(serializeContentEnvelope(value));
  } catch {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
  }
}

export function parseEncryptedAggregateRecord<Kind extends AggregateContentKind>(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
    keyClass: KeyClass;
  }>
): EncryptedAggregateRecord<Kind> {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, RECORD_KEYS) && !hasExactKeys(value, SEALED_RECORD_KEYS))
  ) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
  }
  if ("reservationId" in value) {
    if (typeof value.reservationId !== "string") {
      aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
    }
    try {
      assertIdentifier(value.reservationId, "Reservation identifier");
    } catch {
      aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
    }
  }
  if (
    value.ownerId !== expected.ownerId ||
    value.resourceId !== expected.resourceId ||
    value.recordVersion !== expected.recordVersion ||
    value.kind !== expected.kind ||
    value.keyClass !== expected.keyClass ||
    value.keyPurpose !== "object_wrap" ||
    typeof value.keyId !== "string" ||
    typeof value.keyVersion !== "number"
  ) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
  }
  try {
    assertIdentifier(value.keyId, "Key identifier");
    assertRecordVersion(value.keyVersion);
  } catch {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
  }
  const envelope = parseEnvelope(value.envelope);
  if (
    envelope.keyId !== value.keyId ||
    envelope.context.tenantId !== expected.ownerId ||
    envelope.context.resourceId !== expected.resourceId ||
    envelope.context.recordVersion !== expected.recordVersion ||
    envelope.context.kind !== (expected.kind as EncryptedContentKind)
  ) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
  }
  return Object.freeze({
    ownerId: expected.ownerId,
    resourceId: expected.resourceId,
    recordVersion: expected.recordVersion,
    kind: expected.kind,
    envelope,
    keyId: value.keyId,
    keyClass: expected.keyClass,
    keyPurpose: "object_wrap",
    keyVersion: value.keyVersion
  });
}

export function parseKeyedMacRecord(value: unknown, expectedClass: KeyClass): KeyedMacRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, MAC_KEYS) ||
    typeof value.value !== "string" ||
    !HEX_MAC_PATTERN.test(value.value) ||
    typeof value.keyId !== "string" ||
    value.keyClass !== expectedClass ||
    value.keyPurpose !== "content_mac" ||
    typeof value.keyVersion !== "number"
  ) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Keyed MAC record is invalid");
  }
  try {
    assertIdentifier(value.keyId, "Key identifier");
    assertRecordVersion(value.keyVersion);
  } catch {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Keyed MAC record is invalid");
  }
  return Object.freeze({
    value: value.value,
    keyId: value.keyId,
    keyClass: expectedClass,
    keyPurpose: "content_mac",
    keyVersion: value.keyVersion
  });
}
