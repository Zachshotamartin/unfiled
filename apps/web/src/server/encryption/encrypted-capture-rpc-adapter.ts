import {
  ApiErrorCodeSchema,
  CaptureProcessingStateSchema,
  CaptureSourceSchema,
  PrivacyModeSchema,
  parseEntityId,
  type ApiErrorCodeValue,
  type CaptureProcessingState,
  type CaptureSource,
  type EntityId,
  type PrivacyMode
} from "@unfiled/contracts";
import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import type {
  AggregateContentKind,
  EncryptedAggregateRecord,
  EncryptedFieldRpcValue,
  KeyedMacRecord,
  KeyedMacRpcValue
} from "@unfiled/encrypted-aggregate";
import type { KeyClass } from "@unfiled/key-management";

import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const DEVICE_ID_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._:-]{0,119})$/u;
const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,3})$/u;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]*$/u;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_CAPTURE_PAGE_SIZE = 100;
const MAX_GENERATED_BLOCK_BATCH = 100;

const CAPTURE_KEYS = [
  "captureId",
  "recordVersion",
  "jobId",
  "source",
  "deviceId",
  "contentLength",
  "privacy",
  "explicitDestinationNoteId",
  "expansionDisabled",
  "clientCreatedAt",
  "clientTimezone",
  "receivedAt",
  "status",
  "lastErrorCode",
  "contentCipher",
  "contentMac",
  "receiptAvailable"
] as const;

const RECEIPT_KEYS = [
  "captureId",
  "recordVersion",
  "privacy",
  "jobId",
  "decisionId",
  "reviewItemId",
  "mutationId",
  "outcome",
  "destinationNoteId",
  "reasonCodes",
  "createdAt",
  "receiptCipher"
] as const;

const GENERATED_BLOCK_KEYS = [
  "blockId",
  "recordVersion",
  "noteId",
  "decisionId",
  "kind",
  "state",
  "modelId",
  "promptVersion",
  "resolvedAt",
  "createdAt",
  "contentCipher"
] as const;

const JOB_KEYS = [
  "jobId",
  "state",
  "attempt",
  "startedAt",
  "completedAt",
  "errorCode",
  "createdAt",
  "updatedAt"
] as const;

const CREATE_CAPTURE_KEYS = [
  "clientCaptureId",
  "jobId",
  "occurredAt",
  "contentCipher",
  "contentMac",
  "contentLength",
  "source",
  "deviceId",
  "clientCreatedAt",
  "clientTimezone",
  "privacy",
  "explicitDestinationNoteId",
  "expansionDisabled",
  "privateReceiptCipher",
  "privateReceiptVerificationMac"
] as const;

export const encryptedCaptureRpcFunctions = Object.freeze([
  "create_encrypted_capture_with_job",
  "list_encrypted_captures",
  "get_encrypted_capture_receipt",
  "get_encrypted_capture_detail",
  "get_encrypted_generated_blocks"
] as const);

export type EncryptedCaptureRpcFunction = (typeof encryptedCaptureRpcFunctions)[number];

export type EncryptedCaptureCursor = Readonly<{
  receivedAt: string;
  captureId: EntityId<"cap">;
}>;

export type EncryptedCaptureRead = Readonly<{
  captureId: EntityId<"cap">;
  recordVersion: 1;
  jobId: EntityId<"job">;
  source: CaptureSource;
  deviceId: string;
  contentLength: number;
  privacy: PrivacyMode;
  explicitDestinationNoteId: EntityId<"note"> | null;
  expansionDisabled: boolean;
  clientCreatedAt: string;
  clientTimezone: string;
  receivedAt: string;
  status: CaptureProcessingState;
  lastErrorCode: ApiErrorCodeValue | null;
  contentCipher: EncryptedAggregateRecord<"capture">;
  contentMac: KeyedMacRecord;
  receiptAvailable: boolean;
}>;

export type EncryptedCaptureReceiptRead = Readonly<{
  captureId: EntityId<"cap">;
  recordVersion: number;
  privacy: PrivacyMode;
  jobId: EntityId<"job">;
  decisionId: EntityId<"dec"> | null;
  reviewItemId: EntityId<"rvw"> | null;
  mutationId: EntityId<"mut"> | null;
  outcome: "created_note" | "added_to_note" | "kept_in_inbox" | "needs_review" | "failed";
  destinationNoteId: EntityId<"note"> | null;
  reasonCodes: readonly string[];
  createdAt: string;
  receiptCipher: EncryptedAggregateRecord<"capture_receipt">;
}>;

export type EncryptedCaptureJobRead = Readonly<{
  jobId: EntityId<"job">;
  state: "created" | "running" | "awaiting_retry" | "succeeded" | "failed" | "dead_letter";
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: ApiErrorCodeValue | null;
  createdAt: string;
  updatedAt: string;
}>;

export type EncryptedCaptureDetailRead = EncryptedCaptureRead &
  Readonly<{
    job: EncryptedCaptureJobRead;
    receipt: EncryptedCaptureReceiptRead | null;
  }>;

export type EncryptedGeneratedBlockRead = Readonly<{
  blockId: EntityId<"blk">;
  recordVersion: 1;
  noteId: EntityId<"note">;
  decisionId: EntityId<"dec">;
  kind: "summary" | "interpretation" | "suggestion" | "label";
  state: "proposed" | "accepted" | "rejected";
  modelId: string;
  promptVersion: string;
  resolvedAt: string | null;
  createdAt: string;
  contentCipher: EncryptedAggregateRecord<"generated_block">;
}>;

export type CreateEncryptedCaptureCommand = Readonly<{
  ownerId: string;
  capture: Readonly<{
    clientCaptureId: EntityId<"cap">;
    jobId: EntityId<"job">;
    occurredAt: string;
    contentCipher: EncryptedFieldRpcValue<"capture">;
    contentMac: KeyedMacRpcValue;
    contentLength: number;
    source: CaptureSource;
    deviceId: string;
    clientCreatedAt: string;
    clientTimezone: string;
    privacy: PrivacyMode;
    explicitDestinationNoteId: EntityId<"note"> | null;
    expansionDisabled: boolean;
    privateReceiptCipher: EncryptedFieldRpcValue<"capture_receipt"> | null;
    privateReceiptVerificationMac: KeyedMacRpcValue | null;
  }>;
}>;

export type CreateEncryptedCaptureResult = Readonly<{
  captureId: EntityId<"cap">;
  jobId: EntityId<"job">;
  replayed: boolean;
}>;

export type EncryptedCaptureListPage = Readonly<{
  captures: readonly EncryptedCaptureRead[];
  nextCursor: EncryptedCaptureCursor | null;
}>;

export type EncryptedCaptureRpcAdapter = Readonly<{
  createCapture(input: CreateEncryptedCaptureCommand): Promise<CreateEncryptedCaptureResult>;
  listCaptures(
    input: Readonly<{
      ownerId: string;
      cursor?: EncryptedCaptureCursor | null;
      limit: number;
    }>
  ): Promise<EncryptedCaptureListPage>;
  getCaptureDetail(
    input: Readonly<{
      ownerId: string;
      captureId: EntityId<"cap">;
    }>
  ): Promise<EncryptedCaptureDetailRead>;
  getCaptureReceipt(
    input: Readonly<{
      ownerId: string;
      captureId: EntityId<"cap">;
    }>
  ): Promise<EncryptedCaptureReceiptRead>;
  getGeneratedBlocks(
    input: Readonly<{
      ownerId: string;
      blockIds: readonly EntityId<"blk">[];
    }>
  ): Promise<readonly EncryptedGeneratedBlockRead[]>;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;
type Failure = () => never;

function inputFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function projectionFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], failure: Failure): UnknownRecord {
  if (!isRecord(value)) return failure();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return failure();
  }
  return value;
}

function canonicalOwnerId(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failure();
  return value.toLowerCase();
}

function entityId<Kind extends "blk" | "cap" | "dec" | "job" | "mut" | "note" | "rvw">(
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

function nullableEntityId<Kind extends "dec" | "mut" | "note" | "rvw">(
  value: unknown,
  kind: Kind,
  failure: Failure
): EntityId<Kind> | null {
  return value === null ? null : entityId(value, kind, failure);
}

function positiveInteger(value: unknown, maximum: number, failure: Failure): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > maximum) {
    return failure();
  }
  return value;
}

function nonnegativeInteger(value: unknown, maximum: number, failure: Failure): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > maximum) {
    return failure();
  }
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, failure: Failure): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    return failure();
  }
  return value;
}

export function encryptedCaptureTimestampMicros(value: unknown, failure: Failure): bigint {
  if (typeof value !== "string" || value.length > 40) return failure();
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) return failure();
  const [
    ,
    yearRaw,
    monthRaw,
    dayRaw,
    hourRaw,
    minuteRaw,
    secondRaw,
    fraction,
    zone,
    sign,
    zoneHourRaw,
    zoneMinuteRaw
  ] = match;
  if (
    yearRaw === undefined ||
    monthRaw === undefined ||
    dayRaw === undefined ||
    hourRaw === undefined ||
    minuteRaw === undefined ||
    secondRaw === undefined ||
    zone === undefined
  )
    return failure();
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  )
    return failure();
  let offsetMinutes = 0;
  if (zone !== "Z") {
    if (sign === undefined || zoneHourRaw === undefined || zoneMinuteRaw === undefined) {
      return failure();
    }
    offsetMinutes = (Number(zoneHourRaw) * 60 + Number(zoneMinuteRaw)) * (sign === "+" ? 1 : -1);
  }
  return (
    BigInt(local.valueOf() - offsetMinutes * 60_000) * 1_000n +
    BigInt((fraction ?? "").padEnd(6, "0"))
  );
}

function timestamp(value: unknown, failure: Failure): string {
  encryptedCaptureTimestampMicros(value, failure);
  return value as string;
}

function nullableTimestamp(value: unknown, failure: Failure): string | null {
  return value === null ? null : timestamp(value, failure);
}

function privacy(value: unknown, failure: Failure): PrivacyMode {
  const parsed = PrivacyModeSchema.safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function source(value: unknown, failure: Failure): CaptureSource {
  const parsed = CaptureSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function status(value: unknown, failure: Failure): CaptureProcessingState {
  const parsed = CaptureProcessingStateSchema.safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function nullableErrorCode(value: unknown, failure: Failure): ApiErrorCodeValue | null {
  if (value === null) return null;
  const parsed = ApiErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function parseEnvelope(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: AggregateContentKind;
  }>,
  keyId: string,
  failure: Failure
) {
  try {
    const envelope = parseContentEnvelope(serializeContentEnvelope(value));
    if (
      envelope.keyId !== keyId ||
      envelope.context.tenantId !== expected.ownerId ||
      envelope.context.resourceId !== expected.resourceId ||
      envelope.context.recordVersion !== expected.recordVersion ||
      envelope.context.kind !== expected.kind
    )
      return failure();
    return envelope;
  } catch {
    return failure();
  }
}

function parseStoredCipher<Kind extends AggregateContentKind>(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
    keyClass: KeyClass;
  }>,
  failure: Failure
): EncryptedAggregateRecord<Kind> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const parsedKeyId = boundedString(record.keyId, 1, 128, failure);
  if (
    !KEY_ID_PATTERN.test(parsedKeyId) ||
    record.keyClass !== expected.keyClass ||
    record.keyPurpose !== "object_wrap"
  )
    return failure();
  const keyVersion = positiveInteger(record.keyVersion, MAX_DATABASE_INTEGER, failure);
  return Object.freeze({
    ownerId: expected.ownerId,
    resourceId: expected.resourceId,
    recordVersion: expected.recordVersion,
    kind: expected.kind,
    envelope: parseEnvelope(record.envelope, expected, parsedKeyId, failure),
    keyId: parsedKeyId,
    keyClass: expected.keyClass,
    keyPurpose: "object_wrap" as const,
    keyVersion
  });
}

function parseSealedCipher<Kind extends AggregateContentKind>(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
    keyClass: KeyClass;
  }>,
  failure: Failure
): EncryptedFieldRpcValue<Kind> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion", "reservationId"],
    failure
  );
  const parsedKeyId = boundedString(record.keyId, 1, 128, failure);
  const reservationId = boundedString(record.reservationId, 36, 36, failure);
  if (
    !KEY_ID_PATTERN.test(parsedKeyId) ||
    !UUID_PATTERN.test(reservationId) ||
    record.keyClass !== expected.keyClass ||
    record.keyPurpose !== "object_wrap"
  )
    return failure();
  return Object.freeze({
    envelope: parseEnvelope(record.envelope, expected, parsedKeyId, failure),
    keyId: parsedKeyId,
    keyClass: expected.keyClass,
    keyPurpose: "object_wrap" as const,
    keyVersion: positiveInteger(record.keyVersion, MAX_DATABASE_INTEGER, failure),
    reservationId
  });
}

function parseMac(value: unknown, expectedClass: KeyClass, failure: Failure): KeyedMacRecord {
  const record = exactRecord(
    value,
    ["mac", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const parsedKeyId = boundedString(record.keyId, 1, 128, failure);
  if (
    typeof record.mac !== "string" ||
    !MAC_PATTERN.test(record.mac) ||
    !KEY_ID_PATTERN.test(parsedKeyId) ||
    record.keyClass !== expectedClass ||
    record.keyPurpose !== "content_mac"
  )
    return failure();
  return Object.freeze({
    value: record.mac,
    keyId: parsedKeyId,
    keyClass: expectedClass,
    keyPurpose: "content_mac" as const,
    keyVersion: positiveInteger(record.keyVersion, MAX_DATABASE_INTEGER, failure)
  });
}

function parseMacForRpc(
  value: unknown,
  expectedClass: KeyClass,
  failure: Failure
): KeyedMacRpcValue {
  const parsed = parseMac(value, expectedClass, failure);
  return Object.freeze({
    mac: parsed.value,
    keyId: parsed.keyId,
    keyClass: parsed.keyClass,
    keyPurpose: parsed.keyPurpose,
    keyVersion: parsed.keyVersion
  });
}

function parseCapture(
  value: unknown,
  ownerId: string,
  expectedCaptureId: EntityId<"cap"> | null,
  failure: Failure
): EncryptedCaptureRead {
  const row = exactRecord(value, CAPTURE_KEYS, failure);
  const captureId = entityId(row.captureId, "cap", failure);
  if (expectedCaptureId !== null && captureId !== expectedCaptureId) return failure();
  if (
    row.recordVersion !== 1 ||
    typeof row.expansionDisabled !== "boolean" ||
    typeof row.receiptAvailable !== "boolean"
  )
    return failure();
  const parsedPrivacy = privacy(row.privacy, failure);
  const receivedAt = timestamp(row.receivedAt, failure);
  const clientCreatedAt = timestamp(row.clientCreatedAt, failure);
  const contentLength = positiveInteger(row.contentLength, 10_000, failure);
  const deviceId = boundedString(row.deviceId, 0, 120, failure);
  const timezone = boundedString(row.clientTimezone, 1, 64, failure);
  if (!DEVICE_ID_PATTERN.test(deviceId) || !TIMEZONE_PATTERN.test(timezone)) return failure();
  return Object.freeze({
    captureId,
    recordVersion: 1,
    jobId: entityId(row.jobId, "job", failure),
    source: source(row.source, failure),
    deviceId,
    contentLength,
    privacy: parsedPrivacy,
    explicitDestinationNoteId: nullableEntityId(row.explicitDestinationNoteId, "note", failure),
    expansionDisabled: row.expansionDisabled,
    clientCreatedAt,
    clientTimezone: timezone,
    receivedAt,
    status: status(row.status, failure),
    lastErrorCode: nullableErrorCode(row.lastErrorCode, failure),
    contentCipher: parseStoredCipher(
      row.contentCipher,
      {
        ownerId,
        resourceId: captureId,
        recordVersion: 1,
        kind: "capture",
        keyClass: parsedPrivacy
      },
      failure
    ),
    contentMac: parseMac(row.contentMac, parsedPrivacy, failure),
    receiptAvailable: row.receiptAvailable
  });
}

function receiptOutcome(value: unknown, failure: Failure): EncryptedCaptureReceiptRead["outcome"] {
  if (
    value === "created_note" ||
    value === "added_to_note" ||
    value === "kept_in_inbox" ||
    value === "needs_review" ||
    value === "failed"
  )
    return value;
  return failure();
}

function reasonCodes(value: unknown, failure: Failure): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) return failure();
  return Object.freeze(
    value.map((entry) => {
      const code = boundedString(entry, 1, 64, failure);
      return REASON_CODE_PATTERN.test(code) ? code : failure();
    })
  );
}

function parseReceipt(
  value: unknown,
  ownerId: string,
  expectedCaptureId: EntityId<"cap">,
  failure: Failure
): EncryptedCaptureReceiptRead {
  const row = exactRecord(value, RECEIPT_KEYS, failure);
  const captureId = entityId(row.captureId, "cap", failure);
  if (captureId !== expectedCaptureId) return failure();
  const recordVersion = positiveInteger(row.recordVersion, MAX_DATABASE_INTEGER, failure);
  const parsedPrivacy = privacy(row.privacy, failure);
  return Object.freeze({
    captureId,
    recordVersion,
    privacy: parsedPrivacy,
    jobId: entityId(row.jobId, "job", failure),
    decisionId: nullableEntityId(row.decisionId, "dec", failure),
    reviewItemId: nullableEntityId(row.reviewItemId, "rvw", failure),
    mutationId: nullableEntityId(row.mutationId, "mut", failure),
    outcome: receiptOutcome(row.outcome, failure),
    destinationNoteId: nullableEntityId(row.destinationNoteId, "note", failure),
    reasonCodes: reasonCodes(row.reasonCodes, failure),
    createdAt: timestamp(row.createdAt, failure),
    receiptCipher: parseStoredCipher(
      row.receiptCipher,
      {
        ownerId,
        resourceId: captureId,
        recordVersion,
        kind: "capture_receipt",
        keyClass: parsedPrivacy
      },
      failure
    )
  });
}

function parseJob(
  value: unknown,
  expectedJobId: EntityId<"job">,
  failure: Failure
): EncryptedCaptureJobRead {
  const row = exactRecord(value, JOB_KEYS, failure);
  const jobId = entityId(row.jobId, "job", failure);
  if (jobId !== expectedJobId) return failure();
  if (
    row.state !== "created" &&
    row.state !== "running" &&
    row.state !== "awaiting_retry" &&
    row.state !== "succeeded" &&
    row.state !== "failed" &&
    row.state !== "dead_letter"
  )
    return failure();
  const createdAt = timestamp(row.createdAt, failure);
  const updatedAt = timestamp(row.updatedAt, failure);
  if (
    encryptedCaptureTimestampMicros(updatedAt, failure) <
    encryptedCaptureTimestampMicros(createdAt, failure)
  ) {
    return failure();
  }
  return Object.freeze({
    jobId,
    state: row.state,
    attempt: nonnegativeInteger(row.attempt, 5, failure),
    startedAt: nullableTimestamp(row.startedAt, failure),
    completedAt: nullableTimestamp(row.completedAt, failure),
    errorCode: nullableErrorCode(row.errorCode, failure),
    createdAt,
    updatedAt
  });
}

function parseGeneratedBlock(
  value: unknown,
  ownerId: string,
  expectedBlockId: EntityId<"blk">,
  failure: Failure
): EncryptedGeneratedBlockRead {
  const row = exactRecord(value, GENERATED_BLOCK_KEYS, failure);
  const blockId = entityId(row.blockId, "blk", failure);
  if (blockId !== expectedBlockId || row.recordVersion !== 1) return failure();
  if (
    row.kind !== "summary" &&
    row.kind !== "interpretation" &&
    row.kind !== "suggestion" &&
    row.kind !== "label"
  )
    return failure();
  if (row.state !== "proposed" && row.state !== "accepted" && row.state !== "rejected")
    return failure();
  return Object.freeze({
    blockId,
    recordVersion: 1,
    noteId: entityId(row.noteId, "note", failure),
    decisionId: entityId(row.decisionId, "dec", failure),
    kind: row.kind,
    state: row.state,
    modelId: boundedString(row.modelId, 1, 200, failure),
    promptVersion: boundedString(row.promptVersion, 1, 100, failure),
    resolvedAt: nullableTimestamp(row.resolvedAt, failure),
    createdAt: timestamp(row.createdAt, failure),
    contentCipher: parseStoredCipher(
      row.contentCipher,
      {
        ownerId,
        resourceId: blockId,
        recordVersion: 1,
        kind: "generated_block",
        keyClass: "ai_assisted"
      },
      failure
    )
  });
}

function parseCreateCommand(input: CreateEncryptedCaptureCommand): CreateEncryptedCaptureCommand {
  const outer = exactRecord(input, ["ownerId", "capture"], inputFailure);
  const ownerId = canonicalOwnerId(outer.ownerId, inputFailure);
  const row = exactRecord(outer.capture, CREATE_CAPTURE_KEYS, inputFailure);
  const captureId = entityId(row.clientCaptureId, "cap", inputFailure);
  const jobId = entityId(row.jobId, "job", inputFailure);
  const occurredAt = timestamp(row.occurredAt, inputFailure);
  if (encryptedCaptureTimestampMicros(occurredAt, inputFailure) % 1_000n !== 0n)
    return inputFailure();
  const parsedPrivacy = privacy(row.privacy, inputFailure);
  const deviceId = boundedString(row.deviceId, 0, 120, inputFailure);
  const timezone = boundedString(row.clientTimezone, 1, 64, inputFailure);
  if (
    !DEVICE_ID_PATTERN.test(deviceId) ||
    !TIMEZONE_PATTERN.test(timezone) ||
    typeof row.expansionDisabled !== "boolean"
  )
    return inputFailure();
  const contentCipher = parseSealedCipher(
    row.contentCipher,
    {
      ownerId,
      resourceId: captureId,
      recordVersion: 1,
      kind: "capture",
      keyClass: parsedPrivacy
    },
    inputFailure
  );
  const contentMac = parseMacForRpc(row.contentMac, parsedPrivacy, inputFailure);
  let receiptCipher: EncryptedFieldRpcValue<"capture_receipt"> | null = null;
  let receiptMac: KeyedMacRpcValue | null = null;
  if (parsedPrivacy === "private_manual") {
    receiptCipher = parseSealedCipher(
      row.privateReceiptCipher,
      {
        ownerId,
        resourceId: captureId,
        recordVersion: 1,
        kind: "capture_receipt",
        keyClass: "private_manual"
      },
      inputFailure
    );
    receiptMac = parseMacForRpc(row.privateReceiptVerificationMac, "private_manual", inputFailure);
    if (receiptCipher.reservationId === contentCipher.reservationId) return inputFailure();
  } else if (row.privateReceiptCipher !== null || row.privateReceiptVerificationMac !== null) {
    return inputFailure();
  }
  return Object.freeze({
    ownerId,
    capture: Object.freeze({
      clientCaptureId: captureId,
      jobId,
      occurredAt,
      contentCipher,
      contentMac,
      contentLength: positiveInteger(row.contentLength, 10_000, inputFailure),
      source: source(row.source, inputFailure),
      deviceId,
      clientCreatedAt: timestamp(row.clientCreatedAt, inputFailure),
      clientTimezone: timezone,
      privacy: parsedPrivacy,
      explicitDestinationNoteId: nullableEntityId(
        row.explicitDestinationNoteId,
        "note",
        inputFailure
      ),
      expansionDisabled: row.expansionDisabled,
      privateReceiptCipher: receiptCipher,
      privateReceiptVerificationMac: receiptMac
    })
  });
}

export function createEncryptedCaptureRpcAdapter(
  client: ServiceRpcClient
): EncryptedCaptureRpcAdapter {
  return Object.freeze({
    async createCapture(input) {
      const parsed = parseCreateCommand(input);
      const value = exactRecord(
        await client.rpc("create_encrypted_capture_with_job", {
          p_owner_id: parsed.ownerId,
          p_capture: parsed.capture
        }),
        ["captureId", "jobId", "replayed"],
        projectionFailure
      );
      const captureId = entityId(value.captureId, "cap", projectionFailure);
      const jobId = entityId(value.jobId, "job", projectionFailure);
      if (
        captureId !== parsed.capture.clientCaptureId ||
        jobId !== parsed.capture.jobId ||
        typeof value.replayed !== "boolean"
      )
        return projectionFailure();
      return Object.freeze({ captureId, jobId, replayed: value.replayed });
    },

    async listCaptures(input) {
      const parsedInput = exactRecord(
        input,
        Object.prototype.hasOwnProperty.call(input, "cursor")
          ? ["ownerId", "cursor", "limit"]
          : ["ownerId", "limit"],
        inputFailure
      );
      const ownerId = canonicalOwnerId(parsedInput.ownerId, inputFailure);
      const limit = positiveInteger(parsedInput.limit, MAX_CAPTURE_PAGE_SIZE, inputFailure);
      const cursorValue = parsedInput.cursor ?? null;
      let cursor: EncryptedCaptureCursor | null = null;
      if (cursorValue !== null) {
        const cursorRecord = exactRecord(cursorValue, ["receivedAt", "captureId"], inputFailure);
        cursor = Object.freeze({
          receivedAt: timestamp(cursorRecord.receivedAt, inputFailure),
          captureId: entityId(cursorRecord.captureId, "cap", inputFailure)
        });
      }
      const response = exactRecord(
        await client.rpc("list_encrypted_captures", {
          p_owner_id: ownerId,
          p_after_received_at: cursor?.receivedAt ?? null,
          p_after_capture_id: cursor?.captureId ?? null,
          p_limit: limit
        }),
        ["captures", "nextCursor"],
        projectionFailure
      );
      if (!Array.isArray(response.captures) || response.captures.length > limit)
        return projectionFailure();
      const captures = Object.freeze(
        response.captures.map((value) => parseCapture(value, ownerId, null, projectionFailure))
      );
      for (let index = 1; index < captures.length; index += 1) {
        const previous = captures[index - 1];
        const current = captures[index];
        if (previous === undefined || current === undefined) return projectionFailure();
        const previousTime = encryptedCaptureTimestampMicros(
          previous.receivedAt,
          projectionFailure
        );
        const currentTime = encryptedCaptureTimestampMicros(current.receivedAt, projectionFailure);
        if (
          previousTime < currentTime ||
          (previousTime === currentTime && previous.captureId <= current.captureId)
        ) {
          return projectionFailure();
        }
      }
      const first = captures[0];
      if (cursor !== null && first !== undefined) {
        const cursorTime = encryptedCaptureTimestampMicros(cursor.receivedAt, projectionFailure);
        const firstTime = encryptedCaptureTimestampMicros(first.receivedAt, projectionFailure);
        if (
          firstTime > cursorTime ||
          (firstTime === cursorTime && first.captureId >= cursor.captureId)
        ) {
          return projectionFailure();
        }
      }
      let nextCursor: EncryptedCaptureCursor | null = null;
      if (response.nextCursor !== null) {
        const projected = exactRecord(
          response.nextCursor,
          ["receivedAt", "captureId"],
          projectionFailure
        );
        nextCursor = Object.freeze({
          receivedAt: timestamp(projected.receivedAt, projectionFailure),
          captureId: entityId(projected.captureId, "cap", projectionFailure)
        });
        const last = captures.at(-1);
        if (last?.captureId !== nextCursor.captureId) return projectionFailure();
        if (
          encryptedCaptureTimestampMicros(last.receivedAt, projectionFailure) !==
          encryptedCaptureTimestampMicros(nextCursor.receivedAt, projectionFailure)
        )
          return projectionFailure();
      } else if (captures.length > 0) {
        return projectionFailure();
      }
      return Object.freeze({ captures, nextCursor });
    },

    async getCaptureDetail(input) {
      const parsedInput = exactRecord(input, ["ownerId", "captureId"], inputFailure);
      const ownerId = canonicalOwnerId(parsedInput.ownerId, inputFailure);
      const captureId = entityId(parsedInput.captureId, "cap", inputFailure);
      const response = exactRecord(
        await client.rpc("get_encrypted_capture_detail", {
          p_owner_id: ownerId,
          p_capture_id: captureId
        }),
        ["capture"],
        projectionFailure
      );
      const detailKeys = [
        ...CAPTURE_KEYS.filter((key) => key !== "receiptAvailable"),
        "job",
        "receipt"
      ];
      const row = exactRecord(response.capture, detailKeys, projectionFailure);
      const receiptAvailable = row.receipt !== null;
      const capture = parseCapture(
        Object.fromEntries(
          CAPTURE_KEYS.map((key) => [key, key === "receiptAvailable" ? receiptAvailable : row[key]])
        ),
        ownerId,
        captureId,
        projectionFailure
      );
      const job = parseJob(row.job, capture.jobId, projectionFailure);
      const receipt =
        row.receipt === null
          ? null
          : parseReceipt(row.receipt, ownerId, captureId, projectionFailure);
      if (
        receipt !== null &&
        (receipt.jobId !== capture.jobId || receipt.privacy !== capture.privacy)
      ) {
        return projectionFailure();
      }
      return Object.freeze({ ...capture, job, receipt });
    },

    async getCaptureReceipt(input) {
      const parsedInput = exactRecord(input, ["ownerId", "captureId"], inputFailure);
      const ownerId = canonicalOwnerId(parsedInput.ownerId, inputFailure);
      const captureId = entityId(parsedInput.captureId, "cap", inputFailure);
      const response = exactRecord(
        await client.rpc("get_encrypted_capture_receipt", {
          p_owner_id: ownerId,
          p_capture_id: captureId
        }),
        ["receipt"],
        projectionFailure
      );
      return parseReceipt(response.receipt, ownerId, captureId, projectionFailure);
    },

    async getGeneratedBlocks(input) {
      const parsedInput = exactRecord(input, ["ownerId", "blockIds"], inputFailure);
      const ownerId = canonicalOwnerId(parsedInput.ownerId, inputFailure);
      if (
        !Array.isArray(parsedInput.blockIds) ||
        parsedInput.blockIds.length < 1 ||
        parsedInput.blockIds.length > MAX_GENERATED_BLOCK_BATCH
      )
        return inputFailure();
      const blockIds = Object.freeze(
        parsedInput.blockIds.map((id) => entityId(id, "blk", inputFailure))
      );
      if (new Set(blockIds).size !== blockIds.length) return inputFailure();
      const response = exactRecord(
        await client.rpc("get_encrypted_generated_blocks", {
          p_owner_id: ownerId,
          p_block_ids: blockIds
        }),
        ["blocks"],
        projectionFailure
      );
      if (!Array.isArray(response.blocks) || response.blocks.length !== blockIds.length) {
        return projectionFailure();
      }
      return Object.freeze(
        response.blocks.map((value, index) => {
          const expectedId = blockIds[index];
          return expectedId === undefined
            ? projectionFailure()
            : parseGeneratedBlock(value, ownerId, expectedId, projectionFailure);
        })
      );
    }
  });
}
