import {
  ApiErrorCodeSchema,
  CaptureProcessingStateSchema,
  CaptureSourceSchema,
  NoteLinkValueSchema,
  NoteStructuredDataSchema,
  NoteTypeSchema,
  PrivacyModeSchema,
  RoutingRuleMatchSnapshotSchema,
  UserOperationSchema,
  entityIdSchema,
  parseEntityId,
  type ApiErrorCodeValue,
  type CaptureProcessingState,
  type CaptureSource,
  type EntityId,
  type PrivacyMode,
  type RoutingRuleMatchSnapshot,
  CAPTURE_ATTACHMENT_MAX_BYTES,
  MAX_CAPTURE_ATTACHMENTS,
  MAX_CAPTURE_IMAGE_EDGE_PIXELS,
  MAX_CAPTURE_RECORDING_MS,
  type CaptureAttachmentKind,
  type CaptureAttachmentMediaType
} from "@unfiled/contracts";
import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import { stickyKeyClass } from "@unfiled/encrypted-aggregate";
import type {
  AggregateContentKind,
  EncryptedAggregateRecord,
  EncryptedFieldRpcValue,
  KeyedMacRecord,
  KeyedMacRpcValue
} from "@unfiled/encrypted-aggregate";
import type { KeyClass } from "@unfiled/key-management";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type {
  EncryptedNoteMutationCommand,
  EncryptedNoteRevisionCommand,
  EncryptedNoteState
} from "./encrypted-note-rpc-adapter";
import {
  encryptedOnlyMutationProjection,
  encryptedOnlyNoteState
} from "./encrypted-note-command-projection";

import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const DEVICE_ID_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._:-]{0,119})$/u;
const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,3})$/u;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]*$/u;
const ACTOR_PATTERN = /^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_CAPTURE_PAGE_SIZE = 100;
const MAX_GENERATED_BLOCK_BATCH = 100;
const MAX_CAPTURE_SOURCE_NOTES = 100;
const MAX_CAPTURE_UNDO_NOTES = 16;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

function captureProjectionDiagnostic(stage: string): void {
  if (process.env.UNFILED_E1_HTTP_DIAGNOSTICS === "1") {
    process.stderr.write(`[unfiled-e1-capture-projection] ${stage}\n`);
  }
}

const EncryptedCaptureUndoNoteStateSchema = z.strictObject({
  spaceId: entityIdSchema("spc").nullable(),
  type: NoteTypeSchema,
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(200_000),
  structuredData: NoteStructuredDataSchema,
  dailyDate: z.iso.date().nullable(),
  isOpen: z.boolean(),
  privacy: PrivacyModeSchema,
  pinnedAt: z.iso.datetime({ offset: true }).nullable(),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
  tagIds: z.array(entityIdSchema("tag")).max(100),
  links: z.array(NoteLinkValueSchema).max(100)
});

const EncryptedCaptureUndoOperationsSchema = z.array(UserOperationSchema).min(1).max(20);

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
  "reviewItemId",
  "kind",
  "state",
  "stateRevision",
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
  "routingRuleMatch",
  "expansionDisabled",
  "privateReceiptCipher",
  "privateReceiptVerificationMac",
  "attachmentIds"
] as const;

export const encryptedCaptureRpcFunctions = Object.freeze([
  "create_encrypted_capture_with_job",
  "list_encrypted_captures",
  "get_encrypted_capture_receipt",
  "get_encrypted_capture_detail",
  "get_encrypted_generated_blocks",
  "get_encrypted_capture_command_claim",
  "get_encrypted_capture_delete_context",
  "retry_encrypted_capture",
  "delete_encrypted_capture",
  "delete_encrypted_capture_with_undo",
  "create_encrypted_capture_attachment",
  "get_encrypted_capture_attachment",
  "list_encrypted_capture_attachments"
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
  reviewItemId: EntityId<"rvw"> | null;
  kind: "summary" | "interpretation" | "suggestion" | "label";
  state: "proposed" | "accepted" | "rejected";
  stateRevision: number;
  modelId: string;
  promptVersion: string;
  resolvedAt: string | null;
  createdAt: string;
  contentCipher: EncryptedAggregateRecord<"generated_block">;
}>;

export type EncryptedCaptureCommandScope = "retry_capture" | "delete_capture";

export type EncryptedCaptureCommandClaim = Readonly<{
  scope: EncryptedCaptureCommandScope;
  captureId: EntityId<"cap">;
  keyClass: KeyClass;
  requestMacKey: Readonly<{
    ownerId: string;
    keyClass: KeyClass;
    purpose: "content_mac";
    keyId: string;
    keyVersion: number;
  }>;
}>;

export type EncryptedCaptureDeleteContext = Readonly<{
  captureId: EntityId<"cap">;
  sourceNoteIds: readonly EntityId<"note">[];
}>;

export type StoredEncryptedFieldRpcValue<Kind extends AggregateContentKind> = Readonly<
  Pick<
    EncryptedAggregateRecord<Kind>,
    "envelope" | "keyId" | "keyClass" | "keyPurpose" | "keyVersion"
  >
>;

type EncryptedCaptureCommandMaterial = Readonly<{
  occurredAt: string;
  requestMac: KeyedMacRpcValue;
  responseCipher: EncryptedFieldRpcValue<"idempotency_response">;
  responseVerificationMac: KeyedMacRpcValue;
}>;

export type EncryptedCaptureUndoWriteCommand = Readonly<{
  noteId: EntityId<"note">;
  targetMutationId: EntityId<"mut">;
  expectedRevision: number;
  sourcePrivacy: PrivacyMode;
  expectedCurrentCipher: StoredEncryptedFieldRpcValue<"note_content">;
  expectedMutationCipher: StoredEncryptedFieldRpcValue<"note_mutation">;
  noteState: EncryptedNoteState;
  noteCipher: EncryptedFieldRpcValue<"note_content">;
  revision: EncryptedNoteRevisionCommand;
  mutation: EncryptedNoteMutationCommand;
  verification: Readonly<{
    noteContent: KeyedMacRpcValue;
    noteMutation: KeyedMacRpcValue;
  }>;
}>;

export type RetryEncryptedCaptureCommand = Readonly<{
  ownerId: string;
  captureId: EntityId<"cap">;
  privacy: PrivacyMode;
  idempotencyKey: string;
  command: EncryptedCaptureCommandMaterial | Readonly<{ requestMac: KeyedMacRpcValue }>;
}>;

export type DeleteEncryptedCaptureCommand = Readonly<{
  ownerId: string;
  captureId: EntityId<"cap">;
  privacy: PrivacyMode;
  idempotencyKey: string;
  command:
    | (EncryptedCaptureCommandMaterial &
        Readonly<{
          removeInsertedContent: false;
          sourceNoteIds: readonly EntityId<"note">[];
        }>)
    | (EncryptedCaptureCommandMaterial &
        Readonly<{
          removeInsertedContent: true;
          sourceNoteIds: readonly EntityId<"note">[];
          receipt: Readonly<{
            recordVersion: number;
            cipher: StoredEncryptedFieldRpcValue<"capture_receipt">;
          }>;
          undoWrites: readonly EncryptedCaptureUndoWriteCommand[];
        }>)
    | Readonly<{ requestMac: KeyedMacRpcValue }>;
}>;

export type RetryEncryptedCaptureResult = Readonly<{
  captureId: EntityId<"cap">;
  jobId: EntityId<"job">;
  encryptedResponse: EncryptedAggregateRecord<"idempotency_response">;
  replayed: boolean;
}>;

export type DeleteEncryptedCaptureResult = Readonly<{
  captureId: EntityId<"cap">;
  encryptedResponse: EncryptedAggregateRecord<"idempotency_response">;
  replayed: boolean;
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
    routingRuleMatch: RoutingRuleMatchSnapshot | null;
    expansionDisabled: boolean;
    privateReceiptCipher: EncryptedFieldRpcValue<"capture_receipt"> | null;
    privateReceiptVerificationMac: KeyedMacRpcValue | null;
    /** The uploads this capture claims. The database binds them in the same transaction. */
    attachmentIds: readonly EntityId<"att">[];
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

export type CreateEncryptedCaptureAttachmentCommand = Readonly<{
  ownerId: string;
  attachment: Readonly<{
    attachmentId: EntityId<"att">;
    captureId: EntityId<"cap">;
    kind: CaptureAttachmentKind;
    mediaType: CaptureAttachmentMediaType;
    byteLength: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    privacy: PrivacyMode;
    contentCipher: EncryptedFieldRpcValue<"capture_attachment">;
    contentMac: KeyedMacRpcValue;
  }>;
}>;

export type CreateEncryptedCaptureAttachmentResult = Readonly<{
  attachmentId: EntityId<"att">;
  createdAt: string;
  replayed: boolean;
}>;

export type EncryptedCaptureAttachmentRead = Readonly<{
  attachmentId: EntityId<"att">;
  captureId: EntityId<"cap">;
  kind: CaptureAttachmentKind;
  mediaType: CaptureAttachmentMediaType;
  byteLength: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  privacy: PrivacyMode;
  boundAt: string | null;
  createdAt: string;
  contentCipher: StoredEncryptedFieldRpcValue<"capture_attachment">;
  contentMac: KeyedMacRecord;
}>;

export type EncryptedCaptureRpcAdapter = Readonly<{
  createAttachment(
    input: CreateEncryptedCaptureAttachmentCommand
  ): Promise<CreateEncryptedCaptureAttachmentResult>;
  getAttachment(
    input: Readonly<{ ownerId: string; attachmentId: EntityId<"att"> }>
  ): Promise<EncryptedCaptureAttachmentRead | null>;
  listAttachments(
    input: Readonly<{ ownerId: string; captureId: EntityId<"cap"> }>
  ): Promise<readonly EncryptedCaptureAttachmentRead[]>;
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
  getCommandClaim(
    input: Readonly<{
      ownerId: string;
      scope: EncryptedCaptureCommandScope;
      idempotencyKey: string;
    }>
  ): Promise<EncryptedCaptureCommandClaim | null>;
  getDeleteContext(
    input: Readonly<{
      ownerId: string;
      captureId: EntityId<"cap">;
    }>
  ): Promise<EncryptedCaptureDeleteContext>;
  retryCapture(input: RetryEncryptedCaptureCommand): Promise<RetryEncryptedCaptureResult>;
  deleteCapture(input: DeleteEncryptedCaptureCommand): Promise<DeleteEncryptedCaptureResult>;
  deleteCaptureWithUndo(
    input: DeleteEncryptedCaptureCommand
  ): Promise<DeleteEncryptedCaptureResult>;
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

function entityId<
  Kind extends "att" | "blk" | "cap" | "dec" | "job" | "mut" | "note" | "rev" | "rvw"
>(value: unknown, kind: Kind, failure: Failure): EntityId<Kind> {
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

function storedCipherForCommand<Kind extends AggregateContentKind>(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
    keyClass?: KeyClass;
  }>,
  failure: Failure
): StoredEncryptedFieldRpcValue<Kind> {
  const raw = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const parsedClass = privacy(raw.keyClass, failure);
  if (expected.keyClass !== undefined && parsedClass !== expected.keyClass) return failure();
  const parsed = parseStoredCipher(raw, { ...expected, keyClass: parsedClass }, failure);
  return Object.freeze({
    envelope: parsed.envelope,
    keyId: parsed.keyId,
    keyClass: parsed.keyClass,
    keyPurpose: parsed.keyPurpose,
    keyVersion: parsed.keyVersion
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
  const stateRevision = positiveInteger(row.stateRevision, MAX_DATABASE_INTEGER, failure);
  const resolvedAt = nullableTimestamp(row.resolvedAt, failure);
  const createdAt = timestamp(row.createdAt, failure);
  if (
    (row.state === "proposed" && (stateRevision !== 1 || resolvedAt !== null)) ||
    (row.state !== "proposed" && (stateRevision < 2 || resolvedAt === null)) ||
    (resolvedAt !== null &&
      encryptedCaptureTimestampMicros(resolvedAt, failure) <
        encryptedCaptureTimestampMicros(createdAt, failure))
  ) {
    return failure();
  }
  return Object.freeze({
    blockId,
    recordVersion: 1,
    noteId: entityId(row.noteId, "note", failure),
    decisionId: entityId(row.decisionId, "dec", failure),
    reviewItemId: nullableEntityId(row.reviewItemId, "rvw", failure),
    kind: row.kind,
    state: row.state,
    stateRevision,
    modelId: boundedString(row.modelId, 1, 120, failure),
    promptVersion: boundedString(row.promptVersion, 1, 120, failure),
    resolvedAt,
    createdAt,
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

const ATTACHMENT_COMMAND_KEYS = [
  "attachmentId",
  "captureId",
  "kind",
  "mediaType",
  "byteLength",
  "width",
  "height",
  "durationMs",
  "privacy",
  "contentCipher",
  "contentMac"
] as const;

const ATTACHMENT_READ_KEYS = [...ATTACHMENT_COMMAND_KEYS, "boundAt", "createdAt"] as const;

function attachmentKind(value: unknown, failure: Failure): CaptureAttachmentKind {
  return value === "image" || value === "audio" ? value : failure();
}

function attachmentMediaType(value: unknown, failure: Failure): CaptureAttachmentMediaType {
  return value === "image/jpeg" || value === "audio/mp4" ? value : failure();
}

function nullableBoundedInteger(value: unknown, maximum: number, failure: Failure): number | null {
  return value === null ? null : positiveInteger(value, maximum, failure);
}

/// Photos carry width and height and no duration; recordings the reverse.
function attachmentMeasurementsFit(
  kind: CaptureAttachmentKind,
  mediaType: CaptureAttachmentMediaType,
  width: number | null,
  height: number | null,
  durationMs: number | null
): boolean {
  const image = kind === "image";
  if (image !== (mediaType === "image/jpeg")) return false;
  return image
    ? width !== null && height !== null && durationMs === null
    : durationMs !== null && width === null && height === null;
}

type AttachmentDescription = Readonly<{
  attachmentId: EntityId<"att">;
  captureId: EntityId<"cap">;
  kind: CaptureAttachmentKind;
  mediaType: CaptureAttachmentMediaType;
  byteLength: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  privacy: PrivacyMode;
}>;

function parseAttachmentDescription(row: UnknownRecord, failure: Failure): AttachmentDescription {
  const attachmentId = entityId(row.attachmentId, "att", failure);
  const captureId = entityId(row.captureId, "cap", failure);
  const kind = attachmentKind(row.kind, failure);
  const mediaType = attachmentMediaType(row.mediaType, failure);
  const byteLength = positiveInteger(row.byteLength, CAPTURE_ATTACHMENT_MAX_BYTES, failure);
  const width = nullableBoundedInteger(row.width, MAX_CAPTURE_IMAGE_EDGE_PIXELS, failure);
  const height = nullableBoundedInteger(row.height, MAX_CAPTURE_IMAGE_EDGE_PIXELS, failure);
  const durationMs = nullableBoundedInteger(row.durationMs, MAX_CAPTURE_RECORDING_MS, failure);
  if (!attachmentMeasurementsFit(kind, mediaType, width, height, durationMs)) return failure();
  return Object.freeze({
    attachmentId,
    captureId,
    kind,
    mediaType,
    byteLength,
    width,
    height,
    durationMs,
    privacy: privacy(row.privacy, failure)
  });
}

function parseAttachmentCommand(
  input: CreateEncryptedCaptureAttachmentCommand
): CreateEncryptedCaptureAttachmentCommand {
  const outer = exactRecord(input, ["ownerId", "attachment"], inputFailure);
  const ownerId = canonicalOwnerId(outer.ownerId, inputFailure);
  const row = exactRecord(outer.attachment, ATTACHMENT_COMMAND_KEYS, inputFailure);
  const description = parseAttachmentDescription(row, inputFailure);
  const contentCipher = parseSealedCipher(
    row.contentCipher,
    {
      ownerId,
      resourceId: description.attachmentId,
      recordVersion: 1,
      kind: "capture_attachment",
      keyClass: description.privacy
    },
    inputFailure
  );
  const contentMac = parseMacForRpc(row.contentMac, description.privacy, inputFailure);
  return Object.freeze({
    ownerId,
    attachment: Object.freeze({ ...description, contentCipher, contentMac })
  });
}

function parseAttachmentRead(
  value: unknown,
  ownerId: string,
  failure: Failure
): EncryptedCaptureAttachmentRead {
  const row = exactRecord(value, ATTACHMENT_READ_KEYS, failure);
  const description = parseAttachmentDescription(row, failure);
  const contentCipher = parseStoredCipher(
    row.contentCipher,
    {
      ownerId,
      resourceId: description.attachmentId,
      recordVersion: 1,
      kind: "capture_attachment",
      keyClass: description.privacy
    },
    failure
  );
  return Object.freeze({
    ...description,
    boundAt: nullableTimestamp(row.boundAt, failure),
    createdAt: timestamp(row.createdAt, failure),
    contentCipher,
    contentMac: parseMac(row.contentMac, description.privacy, failure)
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
  const explicitDestinationNoteId = nullableEntityId(
    row.explicitDestinationNoteId,
    "note",
    inputFailure
  );
  const parsedRoutingRuleMatch =
    row.routingRuleMatch === null
      ? null
      : RoutingRuleMatchSnapshotSchema.safeParse(row.routingRuleMatch);
  if (
    parsedRoutingRuleMatch !== null &&
    (!parsedRoutingRuleMatch.success ||
      parsedPrivacy !== "ai_assisted" ||
      explicitDestinationNoteId !== null)
  ) {
    return inputFailure();
  }
  const routingRuleMatch = parsedRoutingRuleMatch === null ? null : parsedRoutingRuleMatch.data;
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
      explicitDestinationNoteId,
      routingRuleMatch,
      expansionDisabled: row.expansionDisabled,
      privateReceiptCipher: receiptCipher,
      privateReceiptVerificationMac: receiptMac,
      attachmentIds: parseAttachmentIds(row.attachmentIds)
    })
  });
}

/** The uploads a capture claims, bound by the same transaction that stores the capture. */
function parseAttachmentIds(value: unknown): readonly EntityId<"att">[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_ATTACHMENTS) return inputFailure();
  const ids = value.map((item) => entityId(item, "att", inputFailure));
  if (new Set(ids).size !== ids.length) return inputFailure();
  return Object.freeze(ids);
}

function idempotencyKey(value: unknown, failure: Failure): string {
  const parsed = boundedString(value, 1, 80, failure);
  return IDEMPOTENCY_KEY_PATTERN.test(parsed) ? parsed : failure();
}

function commandScope(value: unknown, failure: Failure): EncryptedCaptureCommandScope {
  return value === "retry_capture" || value === "delete_capture" ? value : failure();
}

function sourceNoteIds(value: unknown, failure: Failure): readonly EntityId<"note">[] {
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_SOURCE_NOTES) return failure();
  const parsed = Object.freeze(value.map((entry) => entityId(entry, "note", failure)));
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1];
    const current = parsed[index];
    if (previous === undefined || current === undefined || previous >= current) return failure();
  }
  return parsed;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requestMacKey(
  value: unknown,
  ownerId: string,
  expectedClass: KeyClass,
  failure: Failure
): EncryptedCaptureCommandClaim["requestMacKey"] {
  const record = exactRecord(value, ["keyId", "keyClass", "keyPurpose", "keyVersion"], failure);
  const parsedKeyId = boundedString(record.keyId, 1, 128, failure);
  if (
    !KEY_ID_PATTERN.test(parsedKeyId) ||
    record.keyClass !== expectedClass ||
    record.keyPurpose !== "content_mac"
  )
    return failure();
  return Object.freeze({
    ownerId,
    keyClass: expectedClass,
    purpose: "content_mac" as const,
    keyId: parsedKeyId,
    keyVersion: positiveInteger(record.keyVersion, MAX_DATABASE_INTEGER, failure)
  });
}

function parseCommandMaterial(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    idempotencyKey: string;
    keyClass: KeyClass;
  }>,
  keys: readonly string[],
  failure: Failure
): EncryptedCaptureCommandMaterial & UnknownRecord {
  const command = exactRecord(value, keys, failure);
  const occurredAt = timestamp(command.occurredAt, failure);
  if (encryptedCaptureTimestampMicros(occurredAt, failure) % 1_000n !== 0n) return failure();
  return Object.freeze({
    ...command,
    occurredAt,
    requestMac: parseMacForRpc(command.requestMac, expected.keyClass, failure),
    responseCipher: parseSealedCipher(
      command.responseCipher,
      {
        ownerId: expected.ownerId,
        resourceId: `idempotency:${expected.idempotencyKey}`,
        recordVersion: 1,
        kind: "idempotency_response",
        keyClass: expected.keyClass
      },
      failure
    ),
    responseVerificationMac: parseMacForRpc(
      command.responseVerificationMac,
      expected.keyClass,
      failure
    )
  });
}

function parseReplayCommand(
  value: unknown,
  expectedClass: KeyClass,
  failure: Failure
): Readonly<{ requestMac: KeyedMacRpcValue }> | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("requestMac" in value)) return null;
  return Object.freeze({ requestMac: parseMacForRpc(value.requestMac, expectedClass, failure) });
}

function parseRetryCommand(input: RetryEncryptedCaptureCommand): RetryEncryptedCaptureCommand {
  const outer = exactRecord(
    input,
    ["ownerId", "captureId", "privacy", "idempotencyKey", "command"],
    inputFailure
  );
  const ownerId = canonicalOwnerId(outer.ownerId, inputFailure);
  const captureId = entityId(outer.captureId, "cap", inputFailure);
  const parsedPrivacy = privacy(outer.privacy, inputFailure);
  const parsedKey = idempotencyKey(outer.idempotencyKey, inputFailure);
  const replay = parseReplayCommand(outer.command, parsedPrivacy, inputFailure);
  const command =
    replay ??
    parseCommandMaterial(
      outer.command,
      { ownerId, idempotencyKey: parsedKey, keyClass: parsedPrivacy },
      ["occurredAt", "requestMac", "responseCipher", "responseVerificationMac"],
      inputFailure
    );
  return Object.freeze({
    ownerId,
    captureId,
    privacy: parsedPrivacy,
    idempotencyKey: parsedKey,
    command
  });
}

function parseUndoNoteState(
  value: unknown,
  noteId: EntityId<"note">,
  failure: Failure
): EncryptedNoteState {
  const parsed = EncryptedCaptureUndoNoteStateSchema.safeParse(value);
  if (!parsed.success) return failure();
  if (new Set(parsed.data.tagIds).size !== parsed.data.tagIds.length) return failure();
  const linkIdentities = parsed.data.links.map((link) => `${link.toNoteId}:${link.linkType}`);
  if (
    parsed.data.links.some((link) => link.toNoteId === noteId) ||
    new Set(linkIdentities).size !== linkIdentities.length
  ) {
    return failure();
  }
  return Object.freeze({
    ...parsed.data,
    tagIds: Object.freeze(parsed.data.tagIds),
    links: Object.freeze(parsed.data.links)
  });
}

function parseUndoWrite(
  value: unknown,
  ownerId: string,
  failure: Failure
): EncryptedCaptureUndoWriteCommand {
  const row = exactRecord(
    value,
    [
      "noteId",
      "targetMutationId",
      "expectedRevision",
      "sourcePrivacy",
      "expectedCurrentCipher",
      "expectedMutationCipher",
      "noteState",
      "noteCipher",
      "revision",
      "mutation",
      "verification"
    ],
    failure
  );
  const noteId = entityId(row.noteId, "note", failure);
  const targetMutationId = entityId(row.targetMutationId, "mut", failure);
  const expectedRevision = positiveInteger(row.expectedRevision, MAX_DATABASE_INTEGER - 1, failure);
  const sourcePrivacy = privacy(row.sourcePrivacy, failure);
  const noteState = parseUndoNoteState(row.noteState, noteId, failure);
  const historyClass = stickyKeyClass({ before: sourcePrivacy, after: noteState.privacy });
  const revision = exactRecord(row.revision, ["id", "source", "actor", "cipher", "mac"], failure);
  const mutation = exactRecord(
    row.mutation,
    ["id", "decisionId", "undoTargetMutationId", "operations", "inverse", "cipher"],
    failure
  );
  const verification = exactRecord(row.verification, ["noteContent", "noteMutation"], failure);
  const revisionId = entityId(revision.id, "rev", failure);
  const mutationId = entityId(mutation.id, "mut", failure);
  if (
    revision.source !== "undo" ||
    typeof revision.actor !== "string" ||
    revision.actor.length > 200 ||
    !ACTOR_PATTERN.test(revision.actor) ||
    mutation.decisionId !== null ||
    mutation.undoTargetMutationId !== targetMutationId ||
    mutationId === targetMutationId
  ) {
    return failure();
  }
  const operations = EncryptedCaptureUndoOperationsSchema.safeParse(mutation.operations);
  const inverse = EncryptedCaptureUndoOperationsSchema.safeParse(mutation.inverse);
  if (!operations.success || !inverse.success) return failure();
  const expectedMutationProjection = encryptedOnlyMutationProjection(noteState.privacy);
  if (
    !isDeepStrictEqual(noteState, encryptedOnlyNoteState(noteId, noteState)) ||
    !isDeepStrictEqual(operations.data, expectedMutationProjection.operations) ||
    !isDeepStrictEqual(inverse.data, expectedMutationProjection.inverse)
  ) {
    return failure();
  }
  return Object.freeze({
    noteId,
    targetMutationId,
    expectedRevision,
    sourcePrivacy,
    expectedCurrentCipher: storedCipherForCommand(
      row.expectedCurrentCipher,
      {
        ownerId,
        resourceId: noteId,
        recordVersion: expectedRevision,
        kind: "note_content",
        keyClass: sourcePrivacy
      },
      failure
    ),
    expectedMutationCipher: storedCipherForCommand(
      row.expectedMutationCipher,
      {
        ownerId,
        resourceId: targetMutationId,
        recordVersion: expectedRevision,
        kind: "note_mutation"
      },
      failure
    ),
    noteState,
    noteCipher: parseSealedCipher(
      row.noteCipher,
      {
        ownerId,
        resourceId: noteId,
        recordVersion: expectedRevision + 1,
        kind: "note_content",
        keyClass: noteState.privacy
      },
      failure
    ),
    revision: Object.freeze({
      id: revisionId,
      source: "undo" as const,
      actor: revision.actor,
      cipher: parseSealedCipher(
        revision.cipher,
        {
          ownerId,
          resourceId: revisionId,
          recordVersion: expectedRevision + 1,
          kind: "note_revision",
          keyClass: historyClass
        },
        failure
      ),
      mac: parseMacForRpc(revision.mac, historyClass, failure)
    }),
    mutation: Object.freeze({
      id: mutationId,
      decisionId: null,
      undoTargetMutationId: targetMutationId,
      operations: Object.freeze(operations.data),
      inverse: Object.freeze(inverse.data),
      cipher: parseSealedCipher(
        mutation.cipher,
        {
          ownerId,
          resourceId: mutationId,
          recordVersion: expectedRevision + 1,
          kind: "note_mutation",
          keyClass: historyClass
        },
        failure
      )
    }),
    verification: Object.freeze({
      noteContent: parseMacForRpc(verification.noteContent, noteState.privacy, failure),
      noteMutation: parseMacForRpc(verification.noteMutation, historyClass, failure)
    })
  });
}

function parseDeleteCommand(input: DeleteEncryptedCaptureCommand): DeleteEncryptedCaptureCommand {
  const outer = exactRecord(
    input,
    ["ownerId", "captureId", "privacy", "idempotencyKey", "command"],
    inputFailure
  );
  const ownerId = canonicalOwnerId(outer.ownerId, inputFailure);
  const captureId = entityId(outer.captureId, "cap", inputFailure);
  const parsedPrivacy = privacy(outer.privacy, inputFailure);
  const parsedKey = idempotencyKey(outer.idempotencyKey, inputFailure);
  const replay = parseReplayCommand(outer.command, parsedPrivacy, inputFailure);
  if (replay !== null) {
    return Object.freeze({
      ownerId,
      captureId,
      privacy: parsedPrivacy,
      idempotencyKey: parsedKey,
      command: replay
    });
  }
  if (!isRecord(outer.command) || typeof outer.command.removeInsertedContent !== "boolean") {
    return inputFailure();
  }
  const removeInsertedContent = outer.command.removeInsertedContent;
  const material = parseCommandMaterial(
    outer.command,
    { ownerId, idempotencyKey: parsedKey, keyClass: parsedPrivacy },
    removeInsertedContent
      ? [
          "occurredAt",
          "removeInsertedContent",
          "requestMac",
          "responseCipher",
          "responseVerificationMac",
          "sourceNoteIds",
          "receipt",
          "undoWrites"
        ]
      : [
          "occurredAt",
          "removeInsertedContent",
          "requestMac",
          "responseCipher",
          "responseVerificationMac",
          "sourceNoteIds"
        ],
    inputFailure
  );
  const parsedSourceNoteIds = sourceNoteIds(material.sourceNoteIds, inputFailure);
  if (!removeInsertedContent) {
    return Object.freeze({
      ownerId,
      captureId,
      privacy: parsedPrivacy,
      idempotencyKey: parsedKey,
      command: Object.freeze({
        occurredAt: material.occurredAt,
        removeInsertedContent: false as const,
        requestMac: material.requestMac,
        responseCipher: material.responseCipher,
        responseVerificationMac: material.responseVerificationMac,
        sourceNoteIds: parsedSourceNoteIds
      })
    });
  }
  const receipt = exactRecord(material.receipt, ["recordVersion", "cipher"], inputFailure);
  const receiptRecordVersion = positiveInteger(
    receipt.recordVersion,
    MAX_DATABASE_INTEGER,
    inputFailure
  );
  if (!Array.isArray(material.undoWrites) || material.undoWrites.length < 1) {
    return inputFailure();
  }
  if (material.undoWrites.length > MAX_CAPTURE_UNDO_NOTES) return inputFailure();
  const undoWrites = Object.freeze(
    material.undoWrites.map((write) => parseUndoWrite(write, ownerId, inputFailure))
  );
  const noteIds = undoWrites.map((write) => write.noteId);
  const targetMutationIds = undoWrites.map((write) => write.targetMutationId);
  const newMutationIds = undoWrites.map((write) => write.mutation.id);
  const newRevisionIds = undoWrites.map((write) => write.revision.id);
  const reservationIds = [
    material.responseCipher.reservationId,
    ...undoWrites.flatMap((write) => [
      write.noteCipher.reservationId,
      write.revision.cipher.reservationId,
      write.mutation.cipher.reservationId
    ])
  ];
  if (
    !sameStringArray(parsedSourceNoteIds, noteIds) ||
    new Set(noteIds).size !== noteIds.length ||
    new Set(targetMutationIds).size !== targetMutationIds.length ||
    new Set(newMutationIds).size !== newMutationIds.length ||
    new Set(newRevisionIds).size !== newRevisionIds.length ||
    new Set(reservationIds).size !== reservationIds.length
  ) {
    return inputFailure();
  }
  for (let index = 1; index < noteIds.length; index += 1) {
    const previous = noteIds[index - 1];
    const current = noteIds[index];
    if (previous === undefined || current === undefined || previous >= current) {
      return inputFailure();
    }
  }
  return Object.freeze({
    ownerId,
    captureId,
    privacy: parsedPrivacy,
    idempotencyKey: parsedKey,
    command: Object.freeze({
      occurredAt: material.occurredAt,
      removeInsertedContent: true as const,
      requestMac: material.requestMac,
      responseCipher: material.responseCipher,
      responseVerificationMac: material.responseVerificationMac,
      sourceNoteIds: parsedSourceNoteIds,
      receipt: Object.freeze({
        recordVersion: receiptRecordVersion,
        cipher: storedCipherForCommand(
          receipt.cipher,
          {
            ownerId,
            resourceId: captureId,
            recordVersion: receiptRecordVersion,
            kind: "capture_receipt",
            keyClass: parsedPrivacy
          },
          inputFailure
        )
      }),
      undoWrites
    })
  });
}

function parseCommandResponseCipher(
  value: unknown,
  ownerId: string,
  idempotencyKeyValue: string,
  keyClass: KeyClass,
  failure: Failure
): EncryptedAggregateRecord<"idempotency_response"> {
  return parseStoredCipher(
    value,
    {
      ownerId,
      resourceId: `idempotency:${idempotencyKeyValue}`,
      recordVersion: 1,
      kind: "idempotency_response",
      keyClass
    },
    failure
  );
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

    async createAttachment(input) {
      const parsed = parseAttachmentCommand(input);
      const value = exactRecord(
        await client.rpc("create_encrypted_capture_attachment", {
          p_owner_id: parsed.ownerId,
          p_attachment: parsed.attachment
        }),
        ["attachmentId", "createdAt", "replayed"],
        projectionFailure
      );
      const attachmentId = entityId(value.attachmentId, "att", projectionFailure);
      if (attachmentId !== parsed.attachment.attachmentId || typeof value.replayed !== "boolean")
        return projectionFailure();
      return Object.freeze({
        attachmentId,
        createdAt: timestamp(value.createdAt, projectionFailure),
        replayed: value.replayed
      });
    },

    async getAttachment(input) {
      const parsedInput = exactRecord(input, ["ownerId", "attachmentId"], inputFailure);
      const ownerId = canonicalOwnerId(parsedInput.ownerId, inputFailure);
      const attachmentId = entityId(parsedInput.attachmentId, "att", inputFailure);
      const value = await client.rpc("get_encrypted_capture_attachment", {
        p_owner_id: ownerId,
        p_attachment_id: attachmentId
      });
      if (value === null) return null;
      const read = parseAttachmentRead(value, ownerId, projectionFailure);
      return read.attachmentId === attachmentId ? read : projectionFailure();
    },

    async listAttachments(input) {
      const parsedInput = exactRecord(input, ["ownerId", "captureId"], inputFailure);
      const ownerId = canonicalOwnerId(parsedInput.ownerId, inputFailure);
      const captureId = entityId(parsedInput.captureId, "cap", inputFailure);
      const value = await client.rpc("list_encrypted_capture_attachments", {
        p_owner_id: ownerId,
        p_capture_id: captureId
      });
      if (!Array.isArray(value) || value.length > 5) return projectionFailure();
      return Object.freeze(
        value.map((item) => {
          const read = parseAttachmentRead(item, ownerId, projectionFailure);
          return read.captureId === captureId ? read : projectionFailure();
        })
      );
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
      captureProjectionDiagnostic("receipt.input");
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
      captureProjectionDiagnostic("receipt.rpc-returned");
      const receipt = parseReceipt(response.receipt, ownerId, captureId, projectionFailure);
      captureProjectionDiagnostic("receipt.parsed");
      return receipt;
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
    },

    async getCommandClaim(input) {
      const parsedInput = exactRecord(input, ["ownerId", "scope", "idempotencyKey"], inputFailure);
      const ownerId = canonicalOwnerId(parsedInput.ownerId, inputFailure);
      const scope = commandScope(parsedInput.scope, inputFailure);
      const parsedKey = idempotencyKey(parsedInput.idempotencyKey, inputFailure);
      const response = exactRecord(
        await client.rpc("get_encrypted_capture_command_claim", {
          p_owner_id: ownerId,
          p_scope: scope,
          p_idempotency_key: parsedKey
        }),
        ["claim", "found"],
        projectionFailure
      );
      if (typeof response.found !== "boolean") return projectionFailure();
      if (!response.found) {
        if (response.claim !== null) return projectionFailure();
        return null;
      }
      const claim = exactRecord(
        response.claim,
        ["captureId", "keyClass", "requestMacKey", "scope"],
        projectionFailure
      );
      const claimScope = commandScope(claim.scope, projectionFailure);
      const keyClass = privacy(claim.keyClass, projectionFailure);
      return Object.freeze({
        scope: claimScope,
        captureId: entityId(claim.captureId, "cap", projectionFailure),
        keyClass,
        requestMacKey: requestMacKey(claim.requestMacKey, ownerId, keyClass, projectionFailure)
      });
    },

    async getDeleteContext(input) {
      const parsedInput = exactRecord(input, ["ownerId", "captureId"], inputFailure);
      const ownerId = canonicalOwnerId(parsedInput.ownerId, inputFailure);
      const captureId = entityId(parsedInput.captureId, "cap", inputFailure);
      const response = exactRecord(
        await client.rpc("get_encrypted_capture_delete_context", {
          p_owner_id: ownerId,
          p_capture_id: captureId
        }),
        ["captureId", "sourceNoteIds"],
        projectionFailure
      );
      const projectedCaptureId = entityId(response.captureId, "cap", projectionFailure);
      if (projectedCaptureId !== captureId) return projectionFailure();
      return Object.freeze({
        captureId,
        sourceNoteIds: sourceNoteIds(response.sourceNoteIds, projectionFailure)
      });
    },

    async retryCapture(input) {
      const parsed = parseRetryCommand(input);
      const response = exactRecord(
        await client.rpc("retry_encrypted_capture", {
          p_owner_id: parsed.ownerId,
          p_capture_id: parsed.captureId,
          p_idempotency_key: parsed.idempotencyKey,
          p_command: parsed.command
        }),
        ["captureId", "encryptedResponse", "jobId", "replayed"],
        projectionFailure
      );
      const captureId = entityId(response.captureId, "cap", projectionFailure);
      if (captureId !== parsed.captureId || typeof response.replayed !== "boolean") {
        return projectionFailure();
      }
      return Object.freeze({
        captureId,
        jobId: entityId(response.jobId, "job", projectionFailure),
        encryptedResponse: parseCommandResponseCipher(
          response.encryptedResponse,
          parsed.ownerId,
          parsed.idempotencyKey,
          parsed.privacy,
          projectionFailure
        ),
        replayed: response.replayed
      });
    },

    async deleteCapture(input) {
      const parsed = parseDeleteCommand(input);
      if ("removeInsertedContent" in parsed.command && parsed.command.removeInsertedContent) {
        return inputFailure();
      }
      const response = exactRecord(
        await client.rpc("delete_encrypted_capture", {
          p_owner_id: parsed.ownerId,
          p_capture_id: parsed.captureId,
          p_idempotency_key: parsed.idempotencyKey,
          p_command: parsed.command
        }),
        ["captureId", "encryptedResponse", "replayed"],
        projectionFailure
      );
      const captureId = entityId(response.captureId, "cap", projectionFailure);
      if (captureId !== parsed.captureId || typeof response.replayed !== "boolean") {
        return projectionFailure();
      }
      return Object.freeze({
        captureId,
        encryptedResponse: parseCommandResponseCipher(
          response.encryptedResponse,
          parsed.ownerId,
          parsed.idempotencyKey,
          parsed.privacy,
          projectionFailure
        ),
        replayed: response.replayed
      });
    },

    async deleteCaptureWithUndo(input) {
      const parsed = parseDeleteCommand(input);
      if ("removeInsertedContent" in parsed.command && !parsed.command.removeInsertedContent) {
        return inputFailure();
      }
      const response = exactRecord(
        await client.rpc("delete_encrypted_capture_with_undo", {
          p_owner_id: parsed.ownerId,
          p_capture_id: parsed.captureId,
          p_idempotency_key: parsed.idempotencyKey,
          p_command: parsed.command
        }),
        ["captureId", "encryptedResponse", "replayed"],
        projectionFailure
      );
      const captureId = entityId(response.captureId, "cap", projectionFailure);
      if (captureId !== parsed.captureId || typeof response.replayed !== "boolean") {
        return projectionFailure();
      }
      return Object.freeze({
        captureId,
        encryptedResponse: parseCommandResponseCipher(
          response.encryptedResponse,
          parsed.ownerId,
          parsed.idempotencyKey,
          parsed.privacy,
          projectionFailure
        ),
        replayed: response.replayed
      });
    }
  });
}
