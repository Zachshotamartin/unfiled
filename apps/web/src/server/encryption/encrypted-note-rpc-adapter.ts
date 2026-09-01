import {
  parseContentEnvelope,
  serializeContentEnvelope,
  type ContentEnvelopeV1
} from "@unfiled/content-crypto";
import {
  IdempotencyKeySchema,
  ListStructuredDataSchema,
  LogStructuredDataSchema,
  NoteLinkValueSchema,
  NoteTypeSchema,
  PlainStructuredDataSchema,
  PrivacyModeSchema,
  ProjectStructuredDataSchema,
  RevisionSourceSchema,
  UserOperationSchema,
  parseEntityId,
  type EntityId,
  type NoteLinkValue,
  type NoteStructuredData,
  type NoteType,
  type PrivacyMode,
  type RevisionSource,
  type UserOperation
} from "@unfiled/contracts";
import type {
  AggregateContentKind,
  EncryptedFieldRpcValue,
  KeyedMacRpcValue
} from "@unfiled/encrypted-aggregate";
import type { KeyClass } from "@unfiled/key-management";

import { canonicalUtcTimestampFromMicros } from "./canonical-rpc-timestamp";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACTOR_PATTERN = /^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const OFFSET_DATETIME_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;
const DATE_PATTERN = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:[0-2][0-9]|3[01])$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_KEY_VERSION = 999_999_999;
const CREATE_NOTE_OPERATIONS = Object.freeze([
  Object.freeze({ type: "create_note" as const })
] as const);
const CREATE_NOTE_INVERSE = Object.freeze({ type: "soft_delete_created_note" as const });

const CLAIM_KEYS = [
  "scope",
  "noteId",
  "expectedRevision",
  "sourcePrivacy",
  "targetPrivacy",
  "historyKeyClass",
  "revisionId",
  "mutationId",
  "occurredAt",
  "commandProjection",
  "requestMacKey",
  "completed",
  "encryptedResponse"
] as const;

const NORMALIZED_CLAIM_KEYS = ["ownerId", "idempotencyKey", ...CLAIM_KEYS] as const;

export const encryptedNoteWriteRpcFunctions = Object.freeze([
  "get_encrypted_note_write_claim",
  "prepare_encrypted_note_write",
  "create_encrypted_note",
  "apply_encrypted_note_mutation"
] as const);

export type EncryptedNoteWriteRpcFunction = (typeof encryptedNoteWriteRpcFunctions)[number];
export type EncryptedNoteWriteScope = "create_encrypted_note" | "apply_encrypted_note_mutation";
export type EncryptedNoteCommandProjection = "legacy" | "encrypted_only";

export type EncryptedNoteContentMacKey = Readonly<{
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "content_mac";
  keyVersion: number;
}>;

export type EncryptedNoteResponseCipher = Readonly<{
  envelope: ContentEnvelopeV1;
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "object_wrap";
  keyVersion: number;
}>;

type EncryptedNoteWriteClaimFields = Readonly<{
  ownerId: string;
  idempotencyKey: string;
  scope: EncryptedNoteWriteScope;
  noteId: EntityId<"note">;
  expectedRevision: number;
  sourcePrivacy: PrivacyMode | null;
  targetPrivacy: PrivacyMode;
  historyKeyClass: KeyClass;
  revisionId: EntityId<"rev">;
  mutationId: EntityId<"mut">;
  occurredAt: string;
  commandProjection: EncryptedNoteCommandProjection;
  requestMacKey: EncryptedNoteContentMacKey;
}>;

export type IncompleteEncryptedNoteWriteClaim = EncryptedNoteWriteClaimFields &
  Readonly<{
    completed: false;
    encryptedResponse: null;
  }>;

export type CompletedEncryptedNoteWriteClaim = EncryptedNoteWriteClaimFields &
  Readonly<{
    completed: true;
    encryptedResponse: EncryptedNoteResponseCipher;
  }>;

export type EncryptedNoteWriteClaim =
  IncompleteEncryptedNoteWriteClaim | CompletedEncryptedNoteWriteClaim;

export type PrepareEncryptedNoteWriteResult = Readonly<{
  claim: EncryptedNoteWriteClaim;
  replayed: boolean;
}>;

type EncryptedNoteWriteRequestFields = Readonly<{
  ownerId: string;
  idempotencyKey: string;
  targetPrivacy: PrivacyMode;
  requestMac: KeyedMacRpcValue;
}>;

export type PrepareEncryptedNoteCreateRequest = EncryptedNoteWriteRequestFields &
  Readonly<{
    scope: "create_encrypted_note";
    noteId: null;
    expectedRevision: 0;
  }>;

export type PrepareEncryptedNoteMutationRequest = EncryptedNoteWriteRequestFields &
  Readonly<{
    scope: "apply_encrypted_note_mutation";
    noteId: EntityId<"note">;
    expectedRevision: number;
  }>;

/**
 * The coordinator proves the scope/note/revision correlation at runtime before
 * assembling this request. The adapter repeats that proof at its trust boundary
 * in `parseRequest`; the two narrower aliases above remain available to callers
 * that already have a statically narrowed scope.
 */
export type EncryptedNoteWriteRequest = EncryptedNoteWriteRequestFields &
  Readonly<{
    scope: EncryptedNoteWriteScope;
    noteId: EntityId<"note"> | null;
    expectedRevision: number;
  }>;

export type GetEncryptedNoteWriteClaimInput = Readonly<{
  ownerId: string;
  scope: EncryptedNoteWriteScope;
  idempotencyKey: string;
}>;

export type EncryptedNoteState = Readonly<{
  spaceId: EntityId<"spc"> | null;
  type: NoteType;
  title: string;
  bodyMarkdown: string;
  structuredData: NoteStructuredData;
  dailyDate: string | null;
  isOpen: boolean;
  privacy: PrivacyMode;
  pinnedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  tagIds: readonly EntityId<"tag">[];
  links: readonly NoteLinkValue[];
}>;

export type EncryptedNoteRevisionCommand = Readonly<{
  id: EntityId<"rev">;
  source: RevisionSource;
  actor: string;
  cipher: EncryptedFieldRpcValue<"note_revision">;
  mac: KeyedMacRpcValue;
}>;

export type EncryptedNoteMutationCommand = Readonly<{
  id: EntityId<"mut">;
  decisionId: EntityId<"dec"> | null;
  undoTargetMutationId: EntityId<"mut"> | null;
  operations: readonly UserOperation[] | readonly [Readonly<{ type: "create_note" }>];
  inverse: readonly UserOperation[] | Readonly<{ type: "soft_delete_created_note" }>;
  cipher: EncryptedFieldRpcValue<"note_mutation">;
}>;

export type EncryptedNoteWriteCommand = Readonly<{
  occurredAt: string;
  noteState: EncryptedNoteState;
  noteCipher: EncryptedFieldRpcValue<"note_content">;
  revision: EncryptedNoteRevisionCommand;
  mutation: EncryptedNoteMutationCommand;
  requestMac: KeyedMacRpcValue;
  responseCipher: EncryptedFieldRpcValue<"idempotency_response">;
  verification: Readonly<{
    noteContent: KeyedMacRpcValue;
    noteMutation: KeyedMacRpcValue;
    idempotencyResponse: KeyedMacRpcValue;
  }>;
}>;

export type SubmitEncryptedNoteWriteInput = Readonly<{
  claim: IncompleteEncryptedNoteWriteClaim;
  command: EncryptedNoteWriteCommand;
}>;

export type EncryptedNoteWriteResult = Readonly<{
  noteId: EntityId<"note">;
  mutationId: EntityId<"mut">;
  currentRevision: number;
  encryptedResponse: EncryptedNoteResponseCipher;
  replayed: boolean;
  indexJobCount?: number;
}>;

export type EncryptedNoteRpcAdapter = Readonly<{
  getWriteClaim(input: GetEncryptedNoteWriteClaimInput): Promise<EncryptedNoteWriteClaim | null>;
  prepareWrite(input: EncryptedNoteWriteRequest): Promise<PrepareEncryptedNoteWriteResult>;
  createNote(input: SubmitEncryptedNoteWriteInput): Promise<EncryptedNoteWriteResult>;
  applyMutation(input: SubmitEncryptedNoteWriteInput): Promise<EncryptedNoteWriteResult>;
}>;

type Failure = () => never;

type CipherExpectation<Kind extends AggregateContentKind> = Readonly<{
  ownerId: string;
  resourceId: string;
  recordVersion: number;
  kind: Kind;
  keyClass: KeyClass;
}>;

function inputFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function projectionFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function keyClass(value: unknown, failure: Failure): KeyClass {
  if (value !== "ai_assisted" && value !== "private_manual") return failure();
  return value;
}

function positiveInteger(value: unknown, maximum: number, failure: Failure): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return failure();
  }
  return value;
}

function nonnegativeInteger(value: unknown, maximum: number, failure: Failure): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return failure();
  }
  return value;
}

function entityId<Kind extends "dec" | "mut" | "note" | "rev" | "spc" | "tag">(
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

function ownerId(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failure();
  return value;
}

function idempotencyKey(value: unknown, failure: Failure): string {
  const parsed = IdempotencyKeySchema.safeParse(value);
  if (!parsed.success) return failure();
  return parsed.data;
}

function privacy(value: unknown, failure: Failure): PrivacyMode {
  const parsed = PrivacyModeSchema.safeParse(value);
  if (!parsed.success) return failure();
  return parsed.data;
}

function envelope(value: unknown, failure: Failure): ContentEnvelopeV1 {
  try {
    return parseContentEnvelope(serializeContentEnvelope(value));
  } catch {
    return failure();
  }
}

function parseMac(
  value: unknown,
  expectedClass: KeyClass | null,
  failure: Failure
): KeyedMacRpcValue {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["mac", "keyId", "keyClass", "keyPurpose", "keyVersion"]) ||
    typeof value.mac !== "string" ||
    !MAC_PATTERN.test(value.mac) ||
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    value.keyPurpose !== "content_mac"
  ) {
    return failure();
  }
  const parsedClass = keyClass(value.keyClass, failure);
  if (expectedClass !== null && parsedClass !== expectedClass) return failure();
  return Object.freeze({
    mac: value.mac,
    keyId: value.keyId,
    keyClass: parsedClass,
    keyPurpose: "content_mac",
    keyVersion: positiveInteger(value.keyVersion, MAX_KEY_VERSION, failure)
  });
}

function parseMacKey(
  value: unknown,
  expectedClass: KeyClass,
  failure: Failure
): EncryptedNoteContentMacKey {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["keyId", "keyClass", "keyPurpose", "keyVersion"]) ||
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    value.keyClass !== expectedClass ||
    value.keyPurpose !== "content_mac"
  ) {
    return failure();
  }
  return Object.freeze({
    keyId: value.keyId,
    keyClass: expectedClass,
    keyPurpose: "content_mac",
    keyVersion: positiveInteger(value.keyVersion, MAX_KEY_VERSION, failure)
  });
}

function parseCipherFields<Kind extends AggregateContentKind>(
  value: Readonly<Record<string, unknown>>,
  expected: CipherExpectation<Kind>,
  failure: Failure
): EncryptedNoteResponseCipher {
  if (
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    value.keyClass !== expected.keyClass ||
    value.keyPurpose !== "object_wrap"
  ) {
    return failure();
  }
  const parsedEnvelope = envelope(value.envelope, failure);
  const parsedVersion = positiveInteger(value.keyVersion, MAX_KEY_VERSION, failure);
  if (
    parsedEnvelope.keyId !== value.keyId ||
    parsedEnvelope.context.tenantId !== expected.ownerId ||
    parsedEnvelope.context.resourceId !== expected.resourceId ||
    parsedEnvelope.context.recordVersion !== expected.recordVersion ||
    parsedEnvelope.context.kind !== expected.kind
  ) {
    return failure();
  }
  return Object.freeze({
    envelope: parsedEnvelope,
    keyId: value.keyId,
    keyClass: expected.keyClass,
    keyPurpose: "object_wrap",
    keyVersion: parsedVersion
  });
}

function parseResponseCipher<Kind extends AggregateContentKind>(
  value: unknown,
  expected: CipherExpectation<Kind>,
  failure: Failure
): EncryptedNoteResponseCipher {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"])
  ) {
    return failure();
  }
  return parseCipherFields(value, expected, failure);
}

function parseWriteCipher<Kind extends AggregateContentKind>(
  value: unknown,
  expected: CipherExpectation<Kind>,
  failure: Failure
): EncryptedFieldRpcValue<Kind> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "envelope",
      "keyId",
      "keyClass",
      "keyPurpose",
      "keyVersion",
      "reservationId"
    ]) ||
    typeof value.reservationId !== "string" ||
    !UUID_PATTERN.test(value.reservationId)
  ) {
    return failure();
  }
  const parsed = parseCipherFields(value, expected, failure);
  return Object.freeze({ ...parsed, reservationId: value.reservationId });
}

function sameMacKey(left: EncryptedNoteContentMacKey, right: KeyedMacRpcValue): boolean {
  return (
    left.keyId === right.keyId &&
    left.keyClass === right.keyClass &&
    left.keyVersion === right.keyVersion
  );
}

function parseRequest(value: unknown): EncryptedNoteWriteRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ownerId",
      "scope",
      "idempotencyKey",
      "noteId",
      "expectedRevision",
      "targetPrivacy",
      "requestMac"
    ]) ||
    (value.scope !== "create_encrypted_note" && value.scope !== "apply_encrypted_note_mutation")
  ) {
    return inputFailure();
  }
  const parsedOwnerId = ownerId(value.ownerId, inputFailure);
  const parsedIdempotencyKey = idempotencyKey(value.idempotencyKey, inputFailure);
  const targetPrivacy = privacy(value.targetPrivacy, inputFailure);
  const requestMac = parseMac(value.requestMac, null, inputFailure);

  if (value.scope === "create_encrypted_note") {
    if (
      value.noteId !== null ||
      value.expectedRevision !== 0 ||
      requestMac.keyClass !== targetPrivacy
    ) {
      return inputFailure();
    }
    return Object.freeze({
      ownerId: parsedOwnerId,
      scope: value.scope,
      idempotencyKey: parsedIdempotencyKey,
      noteId: null,
      expectedRevision: 0,
      targetPrivacy,
      requestMac
    });
  }

  const parsedNoteId = entityId(value.noteId, "note", inputFailure);
  const expectedRevision = positiveInteger(
    value.expectedRevision,
    MAX_DATABASE_INTEGER - 1,
    inputFailure
  );
  if (targetPrivacy === "private_manual" && requestMac.keyClass !== "private_manual") {
    return inputFailure();
  }
  return Object.freeze({
    ownerId: parsedOwnerId,
    scope: value.scope,
    idempotencyKey: parsedIdempotencyKey,
    noteId: parsedNoteId,
    expectedRevision,
    targetPrivacy,
    requestMac
  });
}

function parseClaimLookupInput(value: unknown): GetEncryptedNoteWriteClaimInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ownerId", "scope", "idempotencyKey"]) ||
    (value.scope !== "create_encrypted_note" && value.scope !== "apply_encrypted_note_mutation")
  ) {
    return inputFailure();
  }
  return Object.freeze({
    ownerId: ownerId(value.ownerId, inputFailure),
    scope: value.scope,
    idempotencyKey: idempotencyKey(value.idempotencyKey, inputFailure)
  });
}

function claimExpectation(request: EncryptedNoteWriteRequest): Readonly<{
  ownerId: string;
  idempotencyKey: string;
  scope: EncryptedNoteWriteScope;
  noteId: EntityId<"note"> | null;
  expectedRevision: number;
  targetPrivacy: PrivacyMode;
  requestMac: KeyedMacRpcValue;
}> {
  return request;
}

function parseClaimProjection(
  value: unknown,
  expected: ReturnType<typeof claimExpectation>,
  failure: Failure
): EncryptedNoteWriteClaim {
  if (!isRecord(value) || !hasExactKeys(value, CLAIM_KEYS)) return failure();
  if (
    value.scope !== expected.scope ||
    value.expectedRevision !== expected.expectedRevision ||
    value.targetPrivacy !== expected.targetPrivacy ||
    (value.commandProjection !== "legacy" && value.commandProjection !== "encrypted_only") ||
    typeof value.completed !== "boolean"
  ) {
    return failure();
  }
  const parsedNoteId = entityId(value.noteId, "note", failure);
  if (expected.noteId !== null && parsedNoteId !== expected.noteId) return failure();
  const sourcePrivacy = value.sourcePrivacy === null ? null : privacy(value.sourcePrivacy, failure);
  const historyKeyClass = keyClass(value.historyKeyClass, failure);
  if (
    historyKeyClass !== expected.requestMac.keyClass ||
    (expected.scope === "create_encrypted_note" &&
      (sourcePrivacy !== null || historyKeyClass !== expected.targetPrivacy)) ||
    (expected.scope === "apply_encrypted_note_mutation" &&
      (sourcePrivacy === null ||
        historyKeyClass !==
          (sourcePrivacy === "private_manual" || expected.targetPrivacy === "private_manual"
            ? "private_manual"
            : "ai_assisted")))
  ) {
    return failure();
  }
  const requestMacKey = parseMacKey(value.requestMacKey, historyKeyClass, failure);
  if (!sameMacKey(requestMacKey, expected.requestMac)) return failure();

  const base = Object.freeze({
    ownerId: expected.ownerId,
    idempotencyKey: expected.idempotencyKey,
    scope: expected.scope,
    noteId: parsedNoteId,
    expectedRevision: expected.expectedRevision,
    sourcePrivacy,
    targetPrivacy: expected.targetPrivacy,
    historyKeyClass,
    revisionId: entityId(value.revisionId, "rev", failure),
    mutationId: entityId(value.mutationId, "mut", failure),
    occurredAt: rpcOffsetDateTime(value.occurredAt, failure),
    commandProjection: value.commandProjection,
    requestMacKey
  });

  if (!value.completed) {
    if (value.encryptedResponse !== null) return failure();
    return Object.freeze({ ...base, completed: false, encryptedResponse: null });
  }
  if (value.encryptedResponse === null) return failure();
  const encryptedResponse = parseResponseCipher(
    value.encryptedResponse,
    {
      ownerId: expected.ownerId,
      resourceId: `idempotency:${expected.idempotencyKey}`,
      recordVersion: 1,
      kind: "idempotency_response",
      keyClass: historyKeyClass
    },
    failure
  );
  return Object.freeze({ ...base, completed: true, encryptedResponse });
}

function parseNormalizedClaim(
  value: unknown,
  requiredScope: EncryptedNoteWriteScope,
  failure: Failure
): EncryptedNoteWriteClaim {
  if (!isRecord(value) || !hasExactKeys(value, NORMALIZED_CLAIM_KEYS)) return failure();
  const parsedOwnerId = ownerId(value.ownerId, failure);
  const parsedIdempotencyKey = idempotencyKey(value.idempotencyKey, failure);
  if (value.scope !== requiredScope) return failure();
  const sourcePrivacy = value.sourcePrivacy === null ? null : privacy(value.sourcePrivacy, failure);
  const targetPrivacy = privacy(value.targetPrivacy, failure);
  const historyKeyClass = keyClass(value.historyKeyClass, failure);
  if (value.commandProjection !== "legacy" && value.commandProjection !== "encrypted_only") {
    return failure();
  }
  const requestMacKey = parseMacKey(value.requestMacKey, historyKeyClass, failure);
  const expectedRevision =
    requiredScope === "create_encrypted_note"
      ? value.expectedRevision === 0
        ? 0
        : failure()
      : positiveInteger(value.expectedRevision, MAX_DATABASE_INTEGER - 1, failure);
  if (
    (requiredScope === "create_encrypted_note" &&
      (sourcePrivacy !== null || historyKeyClass !== targetPrivacy)) ||
    (requiredScope === "apply_encrypted_note_mutation" &&
      (sourcePrivacy === null ||
        historyKeyClass !==
          (sourcePrivacy === "private_manual" || targetPrivacy === "private_manual"
            ? "private_manual"
            : "ai_assisted"))) ||
    typeof value.completed !== "boolean"
  ) {
    return failure();
  }
  const noteId = entityId(value.noteId, "note", failure);
  const base = Object.freeze({
    ownerId: parsedOwnerId,
    idempotencyKey: parsedIdempotencyKey,
    scope: requiredScope,
    noteId,
    expectedRevision,
    sourcePrivacy,
    targetPrivacy,
    historyKeyClass,
    revisionId: entityId(value.revisionId, "rev", failure),
    mutationId: entityId(value.mutationId, "mut", failure),
    occurredAt: rpcOffsetDateTime(value.occurredAt, failure),
    commandProjection: value.commandProjection,
    requestMacKey
  });
  if (!value.completed) {
    if (value.encryptedResponse !== null) return failure();
    return Object.freeze({ ...base, completed: false, encryptedResponse: null });
  }
  if (value.encryptedResponse === null) return failure();
  return Object.freeze({
    ...base,
    completed: true,
    encryptedResponse: parseResponseCipher(
      value.encryptedResponse,
      {
        ownerId: parsedOwnerId,
        resourceId: `idempotency:${parsedIdempotencyKey}`,
        recordVersion: 1,
        kind: "idempotency_response",
        keyClass: historyKeyClass
      },
      failure
    )
  });
}

function offsetDateTimeMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = OFFSET_DATETIME_PATTERN.exec(value);
  if (match === null) return null;
  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
    fraction,
    zone,
    sign,
    zoneHourValue,
    zoneMinuteValue
  ] = match;
  if (
    yearValue === undefined ||
    monthValue === undefined ||
    dayValue === undefined ||
    hourValue === undefined ||
    minuteValue === undefined ||
    secondValue === undefined ||
    zone === undefined
  ) {
    return null;
  }
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
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
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (zone !== "Z") {
    if (sign === undefined || zoneHourValue === undefined || zoneMinuteValue === undefined) {
      return null;
    }
    offsetMinutes =
      (Number(zoneHourValue) * 60 + Number(zoneMinuteValue)) * (sign === "+" ? 1 : -1);
  }
  return (
    BigInt(local.valueOf() - offsetMinutes * 60_000) * 1_000n +
    BigInt((fraction ?? "").padEnd(6, "0"))
  );
}

function validOffsetDateTime(value: unknown): value is string {
  return offsetDateTimeMicros(value) !== null;
}

function offsetDateTime(value: unknown, failure: Failure): string {
  if (!validOffsetDateTime(value)) return failure();
  return value;
}

function rpcOffsetDateTime(value: unknown, failure: Failure): string {
  const micros = offsetDateTimeMicros(value);
  return micros === null ? failure() : canonicalUtcTimestampFromMicros(micros, failure);
}

function nullableOffsetDateTime(value: unknown, failure: Failure): string | null {
  if (value === null) return null;
  return offsetDateTime(value, failure);
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === value;
}

function structuredData(value: unknown, noteType: NoteType, failure: Failure): NoteStructuredData {
  const schema =
    noteType === "list"
      ? ListStructuredDataSchema
      : noteType === "log"
        ? LogStructuredDataSchema
        : noteType === "project"
          ? ProjectStructuredDataSchema
          : PlainStructuredDataSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) return failure();
  if (noteType !== "generic" && noteType !== "principle") {
    if (!isRecord(value)) return failure();
    const memberKey =
      noteType === "list" ? "items" : noteType === "log" ? "entries" : "checklistItems";
    const members = value[memberKey];
    if (!Array.isArray(members)) return failure();
    const memberIds = members.map((member) =>
      isRecord(member) && typeof member.id === "string" ? member.id : failure()
    );
    if (new Set(memberIds).size !== memberIds.length) return failure();
  }
  return parsed.data;
}

function parseNoteState(
  value: unknown,
  noteId: EntityId<"note">,
  expectedPrivacy: PrivacyMode,
  failure: Failure
): EncryptedNoteState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "spaceId",
      "type",
      "title",
      "bodyMarkdown",
      "structuredData",
      "dailyDate",
      "isOpen",
      "privacy",
      "pinnedAt",
      "archivedAt",
      "deletedAt",
      "tagIds",
      "links"
    ]) ||
    (value.spaceId !== null && typeof value.spaceId !== "string") ||
    typeof value.title !== "string" ||
    value.title.trim().length < 1 ||
    value.title.length > 200 ||
    typeof value.bodyMarkdown !== "string" ||
    value.bodyMarkdown.length > 200_000 ||
    typeof value.isOpen !== "boolean" ||
    !Array.isArray(value.tagIds) ||
    value.tagIds.length > 100 ||
    !Array.isArray(value.links) ||
    value.links.length > 100
  ) {
    return failure();
  }
  const parsedType = NoteTypeSchema.safeParse(value.type);
  if (!parsedType.success) return failure();
  const parsedPrivacy = privacy(value.privacy, failure);
  if (parsedPrivacy !== expectedPrivacy) return failure();
  const spaceId = value.spaceId === null ? null : entityId(value.spaceId, "spc", failure);
  const dailyDate =
    value.dailyDate === null
      ? null
      : typeof value.dailyDate === "string" && validDate(value.dailyDate)
        ? value.dailyDate
        : failure();
  const tagIds = value.tagIds.map((id) => entityId(id, "tag", failure));
  if (new Set(tagIds).size !== tagIds.length) return failure();
  const links = value.links.map((link) => {
    const parsed = NoteLinkValueSchema.safeParse(link);
    if (!parsed.success || parsed.data.toNoteId === noteId) return failure();
    return parsed.data;
  });
  const linkIdentities = links.map((link) => `${link.toNoteId}:${link.linkType}`);
  if (new Set(linkIdentities).size !== linkIdentities.length) return failure();
  return Object.freeze({
    spaceId,
    type: parsedType.data,
    title: value.title,
    bodyMarkdown: value.bodyMarkdown,
    structuredData: structuredData(value.structuredData, parsedType.data, failure),
    dailyDate,
    isOpen: value.isOpen,
    privacy: parsedPrivacy,
    pinnedAt: nullableOffsetDateTime(value.pinnedAt, failure),
    archivedAt: nullableOffsetDateTime(value.archivedAt, failure),
    deletedAt: nullableOffsetDateTime(value.deletedAt, failure),
    tagIds: Object.freeze(tagIds),
    links: Object.freeze(links)
  });
}

function parseUserOperations(value: unknown, failure: Failure): readonly UserOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return failure();
  return Object.freeze(
    value.map((operation) => {
      const parsed = UserOperationSchema.safeParse(operation);
      if (!parsed.success) return failure();
      return parsed.data;
    })
  );
}

function parseEncryptedOnlyMutationProjection(
  value: unknown,
  privacyValue: PrivacyMode,
  failure: Failure
): readonly UserOperation[] {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    !hasExactKeys(value[0], ["type", "privacy"]) ||
    value[0].type !== "set_privacy" ||
    value[0].privacy !== privacyValue
  ) {
    return failure();
  }
  return Object.freeze([Object.freeze({ type: "set_privacy" as const, privacy: privacyValue })]);
}

function parseCommand(
  value: unknown,
  claim: IncompleteEncryptedNoteWriteClaim,
  failure: Failure
): EncryptedNoteWriteCommand {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "noteState",
      "noteCipher",
      "revision",
      "mutation",
      "requestMac",
      "responseCipher",
      "occurredAt",
      "verification"
    ]) ||
    !isRecord(value.revision) ||
    !hasExactKeys(value.revision, ["id", "source", "actor", "cipher", "mac"]) ||
    !isRecord(value.mutation) ||
    !hasExactKeys(value.mutation, [
      "id",
      "decisionId",
      "undoTargetMutationId",
      "operations",
      "inverse",
      "cipher"
    ]) ||
    !isRecord(value.verification) ||
    !hasExactKeys(value.verification, ["noteContent", "noteMutation", "idempotencyResponse"])
  ) {
    return failure();
  }
  const afterRevision = claim.expectedRevision + 1;
  const noteState = parseNoteState(value.noteState, claim.noteId, claim.targetPrivacy, failure);
  const revisionId = entityId(value.revision.id, "rev", failure);
  const mutationId = entityId(value.mutation.id, "mut", failure);
  const occurredAt = offsetDateTime(value.occurredAt, failure);
  if (
    revisionId !== claim.revisionId ||
    mutationId !== claim.mutationId ||
    offsetDateTimeMicros(occurredAt) !== offsetDateTimeMicros(claim.occurredAt)
  ) {
    return failure();
  }
  const source = RevisionSourceSchema.safeParse(value.revision.source);
  if (
    !source.success ||
    typeof value.revision.actor !== "string" ||
    value.revision.actor.length > 200 ||
    !ACTOR_PATTERN.test(value.revision.actor)
  ) {
    return failure();
  }
  const requestMac = parseMac(value.requestMac, claim.historyKeyClass, failure);
  if (!sameMacKey(claim.requestMacKey, requestMac)) return failure();
  const revisionMac = parseMac(value.revision.mac, claim.historyKeyClass, failure);

  let decisionId: EntityId<"dec"> | null;
  let undoTargetMutationId: EntityId<"mut"> | null;
  let operations: EncryptedNoteMutationCommand["operations"];
  let inverse: EncryptedNoteMutationCommand["inverse"];
  if (claim.scope === "create_encrypted_note") {
    if (
      value.mutation.decisionId !== null ||
      value.mutation.undoTargetMutationId !== null ||
      source.data === "undo"
    ) {
      return failure();
    }
    decisionId = null;
    undoTargetMutationId = null;
    if (
      !Array.isArray(value.mutation.operations) ||
      value.mutation.operations.length !== 1 ||
      !isRecord(value.mutation.operations[0]) ||
      !hasExactKeys(value.mutation.operations[0], ["type"]) ||
      value.mutation.operations[0].type !== "create_note" ||
      !isRecord(value.mutation.inverse) ||
      !hasExactKeys(value.mutation.inverse, ["type"]) ||
      value.mutation.inverse.type !== "soft_delete_created_note"
    ) {
      return failure();
    }
    operations = CREATE_NOTE_OPERATIONS;
    inverse = CREATE_NOTE_INVERSE;
  } else {
    decisionId =
      value.mutation.decisionId === null
        ? null
        : entityId(value.mutation.decisionId, "dec", failure);
    undoTargetMutationId =
      value.mutation.undoTargetMutationId === null
        ? null
        : entityId(value.mutation.undoTargetMutationId, "mut", failure);
    if (
      (source.data === "undo") !== (undoTargetMutationId !== null) ||
      undoTargetMutationId === mutationId
    ) {
      return failure();
    }
    operations =
      claim.commandProjection === "encrypted_only"
        ? parseEncryptedOnlyMutationProjection(
            value.mutation.operations,
            claim.targetPrivacy,
            failure
          )
        : parseUserOperations(value.mutation.operations, failure);
    inverse =
      claim.commandProjection === "encrypted_only"
        ? parseEncryptedOnlyMutationProjection(value.mutation.inverse, claim.targetPrivacy, failure)
        : parseUserOperations(value.mutation.inverse, failure);
  }

  return Object.freeze({
    occurredAt,
    noteState,
    noteCipher: parseWriteCipher(
      value.noteCipher,
      {
        ownerId: claim.ownerId,
        resourceId: claim.noteId,
        recordVersion: afterRevision,
        kind: "note_content",
        keyClass: claim.targetPrivacy
      },
      failure
    ),
    revision: Object.freeze({
      id: revisionId,
      source: source.data,
      actor: value.revision.actor,
      cipher: parseWriteCipher(
        value.revision.cipher,
        {
          ownerId: claim.ownerId,
          resourceId: claim.revisionId,
          recordVersion: afterRevision,
          kind: "note_revision",
          keyClass: claim.historyKeyClass
        },
        failure
      ),
      mac: revisionMac
    }),
    mutation: Object.freeze({
      id: mutationId,
      decisionId,
      undoTargetMutationId,
      operations,
      inverse,
      cipher: parseWriteCipher(
        value.mutation.cipher,
        {
          ownerId: claim.ownerId,
          resourceId: claim.mutationId,
          recordVersion: afterRevision,
          kind: "note_mutation",
          keyClass: claim.historyKeyClass
        },
        failure
      )
    }),
    requestMac,
    responseCipher: parseWriteCipher(
      value.responseCipher,
      {
        ownerId: claim.ownerId,
        resourceId: `idempotency:${claim.idempotencyKey}`,
        recordVersion: 1,
        kind: "idempotency_response",
        keyClass: claim.historyKeyClass
      },
      failure
    ),
    verification: Object.freeze({
      noteContent: parseMac(value.verification.noteContent, claim.targetPrivacy, failure),
      noteMutation: parseMac(value.verification.noteMutation, claim.historyKeyClass, failure),
      idempotencyResponse: parseMac(
        value.verification.idempotencyResponse,
        claim.historyKeyClass,
        failure
      )
    })
  });
}

function parseSubmitInput(
  value: unknown,
  requiredScope: EncryptedNoteWriteScope
): Readonly<{
  claim: IncompleteEncryptedNoteWriteClaim;
  command: EncryptedNoteWriteCommand;
}> {
  if (!isRecord(value) || !hasExactKeys(value, ["claim", "command"])) return inputFailure();
  const claim = parseNormalizedClaim(value.claim, requiredScope, inputFailure);
  if (claim.completed) return inputFailure();
  return Object.freeze({ claim, command: parseCommand(value.command, claim, inputFailure) });
}

function sameEnvelope(left: ContentEnvelopeV1, right: ContentEnvelopeV1): boolean {
  return serializeContentEnvelope(left) === serializeContentEnvelope(right);
}

function parseWriteResult(
  value: unknown,
  claim: IncompleteEncryptedNoteWriteClaim,
  command: EncryptedNoteWriteCommand
): EncryptedNoteWriteResult {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, [
      "noteId",
      "mutationId",
      "currentRevision",
      "encryptedResponse",
      "replayed"
    ]) &&
      !hasExactKeys(value, [
        "noteId",
        "mutationId",
        "currentRevision",
        "encryptedResponse",
        "replayed",
        "indexJobCount"
      ])) ||
    value.noteId !== claim.noteId ||
    value.mutationId !== claim.mutationId ||
    value.currentRevision !== claim.expectedRevision + 1 ||
    typeof value.replayed !== "boolean" ||
    (value.replayed && "indexJobCount" in value)
  ) {
    return projectionFailure();
  }
  const encryptedResponse = parseResponseCipher(
    value.encryptedResponse,
    {
      ownerId: claim.ownerId,
      resourceId: `idempotency:${claim.idempotencyKey}`,
      recordVersion: 1,
      kind: "idempotency_response",
      keyClass: claim.historyKeyClass
    },
    projectionFailure
  );
  if (
    !value.replayed &&
    (encryptedResponse.keyId !== command.responseCipher.keyId ||
      encryptedResponse.keyVersion !== command.responseCipher.keyVersion ||
      !sameEnvelope(encryptedResponse.envelope, command.responseCipher.envelope))
  ) {
    return projectionFailure();
  }
  const result = {
    noteId: claim.noteId,
    mutationId: claim.mutationId,
    currentRevision: claim.expectedRevision + 1,
    encryptedResponse,
    replayed: value.replayed
  };
  if (!("indexJobCount" in value)) return Object.freeze(result);
  return Object.freeze({
    ...result,
    indexJobCount: nonnegativeInteger(value.indexJobCount, MAX_DATABASE_INTEGER, projectionFailure)
  });
}

export function createEncryptedNoteRpcAdapter(client: ServiceRpcClient): EncryptedNoteRpcAdapter {
  return Object.freeze({
    async getWriteClaim(
      input: GetEncryptedNoteWriteClaimInput
    ): Promise<EncryptedNoteWriteClaim | null> {
      const request = parseClaimLookupInput(input);
      const value = await client.rpc("get_encrypted_note_write_claim", {
        p_owner_id: request.ownerId,
        p_scope: request.scope,
        p_idempotency_key: request.idempotencyKey
      });
      if (!isRecord(value) || typeof value.found !== "boolean") return projectionFailure();
      if (!value.found) {
        if (!hasExactKeys(value, ["found"])) return projectionFailure();
        return null;
      }
      if (!hasExactKeys(value, ["found", ...CLAIM_KEYS])) return projectionFailure();
      const claimValue = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "found")
      );
      return parseNormalizedClaim(
        {
          ownerId: request.ownerId,
          idempotencyKey: request.idempotencyKey,
          ...claimValue
        },
        request.scope,
        projectionFailure
      );
    },

    async prepareWrite(input: EncryptedNoteWriteRequest): Promise<PrepareEncryptedNoteWriteResult> {
      const request = parseRequest(input);
      const value = await client.rpc("prepare_encrypted_note_write", {
        p_owner_id: request.ownerId,
        p_scope: request.scope,
        p_idempotency_key: request.idempotencyKey,
        p_note_id: request.noteId,
        p_expected_revision: request.expectedRevision,
        p_target_privacy: request.targetPrivacy,
        p_request_mac: request.requestMac
      });
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [...CLAIM_KEYS, "replayed"]) ||
        typeof value.replayed !== "boolean"
      ) {
        return projectionFailure();
      }
      const { replayed, ...claimValue } = value;
      const claim = parseClaimProjection(claimValue, claimExpectation(request), projectionFailure);
      if (claim.completed && !replayed) return projectionFailure();
      return Object.freeze({ claim, replayed });
    },

    async createNote(input: SubmitEncryptedNoteWriteInput): Promise<EncryptedNoteWriteResult> {
      const { claim, command } = parseSubmitInput(input, "create_encrypted_note");
      return parseWriteResult(
        await client.rpc("create_encrypted_note", {
          p_owner_id: claim.ownerId,
          p_note_id: claim.noteId,
          p_idempotency_key: claim.idempotencyKey,
          p_command: command
        }),
        claim,
        command
      );
    },

    async applyMutation(input: SubmitEncryptedNoteWriteInput): Promise<EncryptedNoteWriteResult> {
      const { claim, command } = parseSubmitInput(input, "apply_encrypted_note_mutation");
      return parseWriteResult(
        await client.rpc("apply_encrypted_note_mutation", {
          p_owner_id: claim.ownerId,
          p_note_id: claim.noteId,
          p_expected_revision: claim.expectedRevision,
          p_idempotency_key: claim.idempotencyKey,
          p_command: command
        }),
        claim,
        command
      );
    }
  });
}
