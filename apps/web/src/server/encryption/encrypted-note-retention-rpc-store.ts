import {
  PrivacyModeSchema,
  parseEntityId,
  type EntityId,
  type PrivacyMode
} from "@unfiled/contracts";
import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import type { EncryptedFieldRpcValue, KeyedMacRpcValue } from "@unfiled/encrypted-aggregate";

import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_BATCH_SIZE = 25;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_RECEIPTS = 100;

export const encryptedNoteRetentionRpcFunctions = Object.freeze([
  "claim_encrypted_note_retention",
  "cancel_encrypted_note_retention_claim",
  "commit_encrypted_note_retention"
] as const);

export type EncryptedNoteRetentionReceiptContext = Readonly<{
  captureId: EntityId<"cap">;
  recordVersion: number;
  privacy: PrivacyMode;
}>;

export type EncryptedNoteRetentionClaim = Readonly<{
  claimId: string;
  ownerId: string;
  noteId: EntityId<"note">;
  deletedAt: string;
  contextDigest: string;
  receiptContexts: readonly EncryptedNoteRetentionReceiptContext[];
  replayed: boolean;
}>;

export type ClaimEncryptedNoteRetentionResult = Readonly<{
  runAt: string;
  cutoff: string;
  eligibleCount: number;
  executed: boolean;
  claimedCount: number;
  claims: readonly EncryptedNoteRetentionClaim[];
  replayed: boolean;
}>;

export type EncryptedNoteRetentionReceiptCommit = Readonly<{
  captureId: EntityId<"cap">;
  recordVersion: number;
  receiptCipher: EncryptedFieldRpcValue<"capture_receipt">;
  verificationMac: KeyedMacRpcValue;
  projection: Readonly<{
    mode: "preserve" | "inbox" | "routed";
    primary: Readonly<{
      noteId: EntityId<"note">;
      mutationId: EntityId<"mut">;
      expectedRevision: number;
      noteRecordVersion: number;
    }> | null;
  }>;
}>;

export type CommitEncryptedNoteRetentionResult = Readonly<{
  claimId: string;
  noteId: EntityId<"note">;
  purged: true;
  purgedCaptureCount: number;
  purgedReceiptCount: number;
  replayed: boolean;
}>;

export type CancelEncryptedNoteRetentionResult = Readonly<{
  claimId: string;
  state: "cancelled" | "committed";
  cancelled: boolean;
  replayed: boolean;
}>;

export type EncryptedNoteRetentionRpcStore = Readonly<{
  claim(
    input: Readonly<{
      runId: string;
      leaseToken: string;
      ownerId: string | null;
      now: string;
      batchSize: number;
      execute: boolean;
      leaseSeconds?: number;
    }>
  ): Promise<ClaimEncryptedNoteRetentionResult>;
  cancel(
    input: Readonly<{
      ownerId: string;
      runId: string;
      claimId: string;
      leaseToken: string;
    }>
  ): Promise<CancelEncryptedNoteRetentionResult>;
  commit(
    input: Readonly<{
      ownerId: string;
      runId: string;
      claimId: string;
      leaseToken: string;
      contextDigest: string;
      receipts: readonly EncryptedNoteRetentionReceiptCommit[];
    }>
  ): Promise<CommitEncryptedNoteRetentionResult>;
}>;

type Failure = () => never;
type UnknownRecord = Readonly<Record<string, unknown>>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function invalidProjection(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function exactRecord(value: unknown, keys: readonly string[], failure: Failure): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return failure();
  const record = value as UnknownRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return failure();
  }
  return record;
}

function uuid(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failure();
  return value.toLowerCase();
}

function entity<Kind extends "cap" | "note" | "mut">(
  value: unknown,
  kind: Kind,
  failure: Failure
): EntityId<Kind> {
  if (typeof value !== "string") return failure();
  try {
    parseEntityId(value, kind);
  } catch {
    return failure();
  }
  return value as EntityId<Kind>;
}

function writeCipher(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    captureId: EntityId<"cap">;
    recordVersion: number;
  }>
): EncryptedFieldRpcValue<"capture_receipt"> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion", "reservationId"],
    invalidInput
  );
  if (
    typeof record.keyId !== "string" ||
    !KEY_ID_PATTERN.test(record.keyId) ||
    (record.keyClass !== "ai_assisted" && record.keyClass !== "private_manual") ||
    record.keyPurpose !== "object_wrap"
  ) {
    return invalidInput();
  }
  let envelope: ReturnType<typeof parseContentEnvelope>;
  try {
    envelope = parseContentEnvelope(serializeContentEnvelope(record.envelope));
  } catch {
    return invalidInput();
  }
  if (
    envelope.keyId !== record.keyId ||
    envelope.context.tenantId !== expected.ownerId ||
    envelope.context.resourceId !== expected.captureId ||
    envelope.context.recordVersion !== expected.recordVersion ||
    envelope.context.kind !== "capture_receipt"
  ) {
    return invalidInput();
  }
  return Object.freeze({
    envelope,
    keyId: record.keyId,
    keyClass: record.keyClass,
    keyPurpose: "object_wrap",
    keyVersion: count(record.keyVersion, MAX_DATABASE_INTEGER, invalidInput) || invalidInput(),
    reservationId: uuid(record.reservationId, invalidInput)
  });
}

function writeMac(
  value: unknown,
  expectedClass: "ai_assisted" | "private_manual"
): KeyedMacRpcValue {
  const record = exactRecord(
    value,
    ["mac", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    invalidInput
  );
  if (
    typeof record.mac !== "string" ||
    !MAC_PATTERN.test(record.mac) ||
    typeof record.keyId !== "string" ||
    !KEY_ID_PATTERN.test(record.keyId) ||
    record.keyClass !== expectedClass ||
    record.keyPurpose !== "content_mac"
  ) {
    return invalidInput();
  }
  return Object.freeze({
    mac: record.mac,
    keyId: record.keyId,
    keyClass: expectedClass,
    keyPurpose: "content_mac",
    keyVersion: count(record.keyVersion, MAX_DATABASE_INTEGER, invalidInput) || invalidInput()
  });
}

function receiptCommit(value: unknown, ownerId: string): EncryptedNoteRetentionReceiptCommit {
  const record = exactRecord(
    value,
    ["captureId", "recordVersion", "receiptCipher", "verificationMac", "projection"],
    invalidInput
  );
  const projection = exactRecord(record.projection, ["mode", "primary"], invalidInput);
  if (
    projection.mode !== "preserve" &&
    projection.mode !== "inbox" &&
    projection.mode !== "routed"
  ) {
    return invalidInput();
  }
  const captureId = entity(record.captureId, "cap", invalidInput);
  const recordVersion =
    count(record.recordVersion, MAX_DATABASE_INTEGER, invalidInput) || invalidInput();
  const receiptCipher = writeCipher(record.receiptCipher, {
    ownerId,
    captureId,
    recordVersion
  });
  const verificationMac = writeMac(record.verificationMac, receiptCipher.keyClass);
  let primary: EncryptedNoteRetentionReceiptCommit["projection"]["primary"] = null;
  if (projection.mode === "routed") {
    const primaryRecord = exactRecord(
      projection.primary,
      ["noteId", "mutationId", "expectedRevision", "noteRecordVersion"],
      invalidInput
    );
    primary = Object.freeze({
      noteId: entity(primaryRecord.noteId, "note", invalidInput),
      mutationId: entity(primaryRecord.mutationId, "mut", invalidInput),
      expectedRevision:
        count(primaryRecord.expectedRevision, 2_147_483_647, invalidInput) || invalidInput(),
      noteRecordVersion:
        count(primaryRecord.noteRecordVersion, 2_147_483_647, invalidInput) || invalidInput()
    });
  } else if (projection.primary !== null) {
    return invalidInput();
  }
  return Object.freeze({
    captureId,
    recordVersion,
    receiptCipher,
    verificationMac,
    projection: Object.freeze({ mode: projection.mode, primary })
  });
}

function timestamp(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) {
    return failure();
  }
  return value;
}

function digest(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) return failure();
  return value;
}

function count(value: unknown, maximum: number, failure: Failure): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > maximum) {
    return failure();
  }
  return value;
}

function boolean(value: unknown, failure: Failure): boolean {
  if (typeof value !== "boolean") return failure();
  return value;
}

function receiptContext(value: unknown): EncryptedNoteRetentionReceiptContext {
  const record = exactRecord(value, ["captureId", "recordVersion", "privacy"], invalidProjection);
  const parsedPrivacy = PrivacyModeSchema.safeParse(record.privacy);
  if (!parsedPrivacy.success) return invalidProjection();
  return Object.freeze({
    captureId: entity(record.captureId, "cap", invalidProjection),
    recordVersion:
      count(record.recordVersion, 2_147_483_647, invalidProjection) || invalidProjection(),
    privacy: parsedPrivacy.data
  });
}

function claimProjection(value: unknown): EncryptedNoteRetentionClaim {
  const record = exactRecord(
    value,
    ["claimId", "ownerId", "noteId", "deletedAt", "contextDigest", "receiptContexts", "replayed"],
    invalidProjection
  );
  if (!Array.isArray(record.receiptContexts) || record.receiptContexts.length > MAX_RECEIPTS) {
    return invalidProjection();
  }
  const receiptContexts = Object.freeze(record.receiptContexts.map(receiptContext));
  const ids = receiptContexts.map((context) => context.captureId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => {
      const previous = ids[index - 1];
      return index > 0 && previous !== undefined && id <= previous;
    })
  ) {
    return invalidProjection();
  }
  return Object.freeze({
    claimId: uuid(record.claimId, invalidProjection),
    ownerId: uuid(record.ownerId, invalidProjection),
    noteId: entity(record.noteId, "note", invalidProjection),
    deletedAt: timestamp(record.deletedAt, invalidProjection),
    contextDigest: digest(record.contextDigest, invalidProjection),
    receiptContexts,
    replayed: boolean(record.replayed, invalidProjection)
  });
}

function claimResult(
  value: unknown,
  expected: Readonly<{ now: string; batchSize: number; execute: boolean }>
): ClaimEncryptedNoteRetentionResult {
  const record = exactRecord(
    value,
    ["runAt", "cutoff", "eligibleCount", "executed", "claimedCount", "claims", "replayed"],
    invalidProjection
  );
  if (!Array.isArray(record.claims) || record.claims.length > expected.batchSize) {
    return invalidProjection();
  }
  const claims = Object.freeze(record.claims.map(claimProjection));
  const claimedCount = count(record.claimedCount, expected.batchSize, invalidProjection);
  const runAt = timestamp(record.runAt, invalidProjection);
  const cutoff = timestamp(record.cutoff, invalidProjection);
  if (
    runAt !== expected.now ||
    boolean(record.executed, invalidProjection) !== expected.execute ||
    claimedCount !== claims.length ||
    (!expected.execute && (claimedCount !== 0 || claims.length !== 0)) ||
    Date.parse(runAt) - Date.parse(cutoff) !== 30 * 24 * 60 * 60 * 1_000
  ) {
    return invalidProjection();
  }
  return Object.freeze({
    runAt,
    cutoff,
    eligibleCount: count(record.eligibleCount, expected.batchSize, invalidProjection),
    executed: expected.execute,
    claimedCount,
    claims,
    replayed: boolean(record.replayed, invalidProjection)
  });
}

function claimInput(input: Parameters<EncryptedNoteRetentionRpcStore["claim"]>[0]) {
  const batchSize = count(input.batchSize, MAX_BATCH_SIZE, invalidInput);
  if (batchSize < 1 || typeof input.execute !== "boolean") return invalidInput();
  const leaseSeconds = input.leaseSeconds ?? 300;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
    return invalidInput();
  }
  const now = timestamp(input.now, invalidInput);
  if (new Date(now).toISOString() !== now) return invalidInput();
  return Object.freeze({
    runId: uuid(input.runId, invalidInput),
    leaseToken: uuid(input.leaseToken, invalidInput),
    ownerId: input.ownerId === null ? null : uuid(input.ownerId, invalidInput),
    now,
    batchSize,
    execute: input.execute,
    leaseSeconds
  });
}

export function createEncryptedNoteRetentionRpcStore(
  client: ServiceRpcClient
): EncryptedNoteRetentionRpcStore {
  return Object.freeze({
    async claim(input) {
      const parsed = claimInput(input);
      return claimResult(
        await client.rpc("claim_encrypted_note_retention", {
          p_run_id: parsed.runId,
          p_lease_token: parsed.leaseToken,
          p_owner_id: parsed.ownerId,
          p_now: parsed.now,
          p_batch_size: parsed.batchSize,
          p_execute: parsed.execute,
          p_lease_seconds: parsed.leaseSeconds
        }),
        parsed
      );
    },

    async cancel(input) {
      const claimId = uuid(input.claimId, invalidInput);
      const value = exactRecord(
        await client.rpc("cancel_encrypted_note_retention_claim", {
          p_owner_id: uuid(input.ownerId, invalidInput),
          p_run_id: uuid(input.runId, invalidInput),
          p_claim_id: claimId,
          p_lease_token: uuid(input.leaseToken, invalidInput)
        }),
        ["claimId", "state", "cancelled", "replayed"],
        invalidProjection
      );
      if (
        uuid(value.claimId, invalidProjection) !== claimId ||
        (value.state !== "cancelled" && value.state !== "committed") ||
        typeof value.cancelled !== "boolean" ||
        typeof value.replayed !== "boolean" ||
        (value.state === "cancelled") !== value.cancelled
      ) {
        return invalidProjection();
      }
      return Object.freeze({
        claimId,
        state: value.state,
        cancelled: value.cancelled,
        replayed: value.replayed
      });
    },

    async commit(input) {
      const ownerId = uuid(input.ownerId, invalidInput);
      const runId = uuid(input.runId, invalidInput);
      const claimId = uuid(input.claimId, invalidInput);
      const leaseToken = uuid(input.leaseToken, invalidInput);
      const contextDigest = digest(input.contextDigest, invalidInput);
      if (!Array.isArray(input.receipts) || input.receipts.length > MAX_RECEIPTS) invalidInput();
      const receipts = Object.freeze(
        input.receipts.map((receiptValue) => receiptCommit(receiptValue, ownerId))
      );
      const captureIds = receipts.map((receipt) => receipt.captureId);
      if (
        new Set(captureIds).size !== captureIds.length ||
        captureIds.some((captureId, index) => {
          const previous = captureIds[index - 1];
          return index > 0 && previous !== undefined && captureId <= previous;
        })
      ) {
        invalidInput();
      }
      const value = exactRecord(
        await client.rpc("commit_encrypted_note_retention", {
          p_owner_id: ownerId,
          p_run_id: runId,
          p_claim_id: claimId,
          p_lease_token: leaseToken,
          p_command: {
            contextDigest,
            receipts
          }
        }),
        ["claimId", "noteId", "purged", "purgedCaptureCount", "purgedReceiptCount", "replayed"],
        invalidProjection
      );
      const purgedReceiptCount = count(value.purgedReceiptCount, MAX_RECEIPTS, invalidProjection);
      if (
        uuid(value.claimId, invalidProjection) !== claimId ||
        value.purged !== true ||
        purgedReceiptCount !== receipts.length ||
        typeof value.replayed !== "boolean"
      ) {
        return invalidProjection();
      }
      return Object.freeze({
        claimId,
        noteId: entity(value.noteId, "note", invalidProjection),
        purged: true,
        purgedCaptureCount: count(value.purgedCaptureCount, MAX_RECEIPTS, invalidProjection),
        purgedReceiptCount,
        replayed: value.replayed
      });
    }
  });
}
