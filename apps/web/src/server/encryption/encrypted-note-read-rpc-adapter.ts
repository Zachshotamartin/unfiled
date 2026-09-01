import {
  NoteTypeSchema,
  PrivacyModeSchema,
  RevisionSourceSchema,
  parseEntityId,
  type EntityId,
  type NoteType,
  type PrivacyMode,
  type RevisionSource
} from "@unfiled/contracts";
import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import type {
  AggregateContentKind,
  EncryptedAggregateRecord,
  KeyedMacRecord
} from "@unfiled/encrypted-aggregate";
import type { KeyClass } from "@unfiled/key-management";

import { canonicalUtcTimestampFromMicros } from "./canonical-rpc-timestamp";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ACTOR_PATTERN = /^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const ORGANIZER_CREATE_IDEMPOTENCY_PATTERN = /^organizer:job_[0-9A-HJKMNP-TV-Z]{26}$/u;
const OWNER_INTERACTION_CREATE_IDEMPOTENCY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}:member:(?:[0-9]|1[0-5])$/u;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

const NOTE_KEYS = [
  "noteId",
  "currentRevision",
  "spaceId",
  "type",
  "dailyDate",
  "isOpen",
  "pinnedAt",
  "privacy",
  "archivedAt",
  "deletedAt",
  "createdAt",
  "updatedAt",
  "contentCipher"
] as const;

const NOTE_DETAIL_KEYS = [...NOTE_KEYS, "space", "tags", "links"] as const;

export const encryptedNoteReadRpcFunctions = Object.freeze([
  "list_encrypted_notes",
  "get_encrypted_note",
  "list_encrypted_note_revisions",
  "get_encrypted_note_mutation"
] as const);

export type EncryptedNoteReadRpcFunction = (typeof encryptedNoteReadRpcFunctions)[number];
export type EncryptedNoteReadTimestamp = string;

export type EncryptedNoteListCursor = Readonly<{
  updatedAt: EncryptedNoteReadTimestamp;
  noteId: EntityId<"note">;
}>;

export type EncryptedNoteReadSummary = Readonly<{
  noteId: EntityId<"note">;
  currentRevision: number;
  spaceId: EntityId<"spc"> | null;
  type: NoteType;
  dailyDate: string | null;
  isOpen: boolean;
  pinnedAt: EncryptedNoteReadTimestamp | null;
  privacy: PrivacyMode;
  archivedAt: EncryptedNoteReadTimestamp | null;
  deletedAt: EncryptedNoteReadTimestamp | null;
  createdAt: EncryptedNoteReadTimestamp;
  updatedAt: EncryptedNoteReadTimestamp;
  contentCipher: EncryptedAggregateRecord<"note_content">;
}>;

export type EncryptedNoteSpaceParent = Readonly<{
  spaceId: EntityId<"spc">;
  currentRevision: number;
  displayCipher: EncryptedAggregateRecord<"space_display">;
  displayMac: KeyedMacRecord;
}>;

export type EncryptedNoteSpace = Readonly<{
  spaceId: EntityId<"spc">;
  currentRevision: number;
  parentId: EntityId<"spc"> | null;
  displayCipher: EncryptedAggregateRecord<"space_display">;
  displayMac: KeyedMacRecord;
  parent: EncryptedNoteSpaceParent | null;
}>;

export type EncryptedNoteTag = Readonly<{
  tagId: EntityId<"tag">;
  currentRevision: number;
  createdAt: EncryptedNoteReadTimestamp;
  displayCipher: EncryptedAggregateRecord<"tag_display">;
  displayMac: KeyedMacRecord;
}>;

export type EncryptedNoteLink = Readonly<{
  linkId: EntityId<"lnk">;
  toNoteId: EntityId<"note">;
  linkType: "reference" | "related";
  source: "manual" | "organization";
  targetType: NoteType;
  targetPrivacy: PrivacyMode;
  targetRevision: number;
  targetContentCipher: EncryptedAggregateRecord<"note_content">;
}>;

export type EncryptedNoteRead = EncryptedNoteReadSummary &
  Readonly<{
    space: EncryptedNoteSpace | null;
    tags: readonly EncryptedNoteTag[];
    links: readonly EncryptedNoteLink[];
  }>;

export type EncryptedNoteListPage = Readonly<{
  notes: readonly EncryptedNoteReadSummary[];
  nextCursor: EncryptedNoteListCursor | null;
}>;

export type EncryptedNoteRevisionRead = Readonly<{
  revisionId: EntityId<"rev">;
  noteId: EntityId<"note">;
  revision: number;
  source: RevisionSource;
  spaceId: EntityId<"spc"> | null;
  type: NoteType;
  isOpen: boolean;
  pinnedAt: EncryptedNoteReadTimestamp | null;
  privacy: PrivacyMode;
  archivedAt: EncryptedNoteReadTimestamp | null;
  deletedAt: EncryptedNoteReadTimestamp | null;
  actor: string;
  mutationId: EntityId<"mut"> | null;
  createdAt: EncryptedNoteReadTimestamp;
  snapshotCipher: EncryptedAggregateRecord<"note_revision">;
  snapshotMac: KeyedMacRecord;
}>;

export type EncryptedNoteRevisionPage = Readonly<{
  revisions: readonly EncryptedNoteRevisionRead[];
  nextRevision: number | null;
}>;

export type EncryptedNoteMutationSnapshot = Readonly<{
  revisionId: EntityId<"rev">;
  revision: number;
  privacy: PrivacyMode;
  snapshotCipher: EncryptedAggregateRecord<"note_revision">;
  snapshotMac: KeyedMacRecord;
}>;

export type EncryptedNoteMutationRead = Readonly<{
  mutationId: EntityId<"mut">;
  noteId: EntityId<"note">;
  decisionId: EntityId<"dec"> | null;
  idempotencyKey: string;
  beforeRevision: number;
  afterRevision: number;
  undoneAt: EncryptedNoteReadTimestamp | null;
  createdAt: EncryptedNoteReadTimestamp;
  mutationCipher: EncryptedAggregateRecord<"note_mutation">;
  currentNote: EncryptedNoteRead;
  beforeSnapshot: EncryptedNoteMutationSnapshot | null;
  afterSnapshot: EncryptedNoteMutationSnapshot;
}>;

export type ListEncryptedNotesInput = Readonly<{
  ownerId: string;
  cursor?: EncryptedNoteListCursor | null;
  limit?: number;
}>;

export type GetEncryptedNoteInput = Readonly<{
  ownerId: string;
  noteId: EntityId<"note">;
}>;

export type ListEncryptedNoteRevisionsInput = Readonly<{
  ownerId: string;
  noteId: EntityId<"note">;
  afterRevision?: number | null;
  limit?: number;
}>;

export type GetEncryptedNoteMutationInput = Readonly<{
  ownerId: string;
  mutationId: EntityId<"mut">;
}>;

export type EncryptedNoteReadRpcAdapter = Readonly<{
  listNotes(input: ListEncryptedNotesInput): Promise<EncryptedNoteListPage>;
  getNote(input: GetEncryptedNoteInput): Promise<EncryptedNoteRead>;
  listRevisions(input: ListEncryptedNoteRevisionsInput): Promise<EncryptedNoteRevisionPage>;
  getMutation(input: GetEncryptedNoteMutationInput): Promise<EncryptedNoteMutationRead>;
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

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.includes(key))
  );
}

function exactRecord(value: unknown, keys: readonly string[], failure: Failure): UnknownRecord {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return failure();
  return value;
}

function canonicalOwnerId(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failure();
  return value.toLowerCase();
}

function entityId<Kind extends "dec" | "lnk" | "mut" | "note" | "rev" | "spc" | "tag">(
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

function nullableEntityId<Kind extends "dec" | "mut" | "spc">(
  value: unknown,
  kind: Kind,
  failure: Failure
): EntityId<Kind> | null {
  return value === null ? null : entityId(value, kind, failure);
}

function positiveInteger(value: unknown, failure: Failure): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_DATABASE_INTEGER
  ) {
    return failure();
  }
  return value;
}

function nonnegativeInteger(value: unknown, failure: Failure): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_DATABASE_INTEGER - 1
  ) {
    return failure();
  }
  return value;
}

function pageSize(value: unknown, failure: Failure): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_SIZE
  ) {
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

function timestampMicros(value: unknown, failure: Failure): bigint {
  if (typeof value !== "string" || value.length > 40) return failure();
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) return failure();
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
    return failure();
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
    return failure();
  }
  let offsetMinutes = 0;
  if (zone !== "Z") {
    if (sign === undefined || zoneHourValue === undefined || zoneMinuteValue === undefined) {
      return failure();
    }
    offsetMinutes =
      (Number(zoneHourValue) * 60 + Number(zoneMinuteValue)) * (sign === "+" ? 1 : -1);
  }
  const fractionalMicros = BigInt((fraction ?? "").padEnd(6, "0"));
  return BigInt(local.valueOf() - offsetMinutes * 60_000) * 1_000n + fractionalMicros;
}

function timestamp(value: unknown, failure: Failure): EncryptedNoteReadTimestamp {
  return canonicalUtcTimestampFromMicros(timestampMicros(value, failure), failure);
}

function nullableTimestamp(value: unknown, failure: Failure): EncryptedNoteReadTimestamp | null {
  return value === null ? null : timestamp(value, failure);
}

function date(value: unknown, failure: Failure): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return failure();
  const match = DATE_PATTERN.exec(value);
  if (match === null) return failure();
  const [, yearValue, monthValue, dayValue] = match;
  if (yearValue === undefined || monthValue === undefined || dayValue === undefined) {
    return failure();
  }
  const parsed = new Date(0);
  parsed.setUTCFullYear(Number(yearValue), Number(monthValue) - 1, Number(dayValue));
  parsed.setUTCHours(0, 0, 0, 0);
  if (parsed.toISOString().slice(0, 10) !== value) return failure();
  return value;
}

function privacy(value: unknown, failure: Failure): PrivacyMode {
  const parsed = PrivacyModeSchema.safeParse(value);
  if (!parsed.success) return failure();
  return parsed.data;
}

function noteType(value: unknown, failure: Failure): NoteType {
  const parsed = NoteTypeSchema.safeParse(value);
  if (!parsed.success) return failure();
  return parsed.data;
}

function revisionSource(value: unknown, failure: Failure): RevisionSource {
  const parsed = RevisionSourceSchema.safeParse(value);
  if (!parsed.success) return failure();
  return parsed.data;
}

function keyClass(value: unknown, failure: Failure): KeyClass {
  if (value !== "ai_assisted" && value !== "private_manual") return failure();
  return value;
}

function parseStoredCipher<Kind extends AggregateContentKind>(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
    keyClass?: KeyClass;
  }>,
  failure: Failure
): EncryptedAggregateRecord<Kind> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const parsedKeyId = boundedString(record.keyId, 1, 128, failure);
  if (!KEY_ID_PATTERN.test(parsedKeyId) || record.keyPurpose !== "object_wrap") return failure();
  const parsedClass = keyClass(record.keyClass, failure);
  if (expected.keyClass !== undefined && parsedClass !== expected.keyClass) return failure();
  const parsedVersion = positiveInteger(record.keyVersion, failure);
  let envelope;
  try {
    envelope = parseContentEnvelope(serializeContentEnvelope(record.envelope));
  } catch {
    return failure();
  }
  if (
    envelope.keyId !== parsedKeyId ||
    envelope.context.tenantId !== expected.ownerId ||
    envelope.context.resourceId !== expected.resourceId ||
    envelope.context.recordVersion !== expected.recordVersion ||
    envelope.context.kind !== expected.kind
  ) {
    return failure();
  }
  return Object.freeze({
    ownerId: expected.ownerId,
    resourceId: expected.resourceId,
    recordVersion: expected.recordVersion,
    kind: expected.kind,
    envelope,
    keyId: parsedKeyId,
    keyClass: parsedClass,
    keyPurpose: "object_wrap",
    keyVersion: parsedVersion
  });
}

function parseStoredMac(value: unknown, expectedClass: KeyClass, failure: Failure): KeyedMacRecord {
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
  ) {
    return failure();
  }
  return Object.freeze({
    value: record.mac,
    keyId: parsedKeyId,
    keyClass: expectedClass,
    keyPurpose: "content_mac",
    keyVersion: positiveInteger(record.keyVersion, failure)
  });
}

function parseNoteFields(
  record: UnknownRecord,
  ownerId: string,
  expectedNoteId: EntityId<"note"> | null,
  failure: Failure
): EncryptedNoteReadSummary {
  const noteId = entityId(record.noteId, "note", failure);
  if (expectedNoteId !== null && noteId !== expectedNoteId) return failure();
  const currentRevision = positiveInteger(record.currentRevision, failure);
  const parsedPrivacy = privacy(record.privacy, failure);
  if (typeof record.isOpen !== "boolean") return failure();
  const createdAt = timestamp(record.createdAt, failure);
  const updatedAt = timestamp(record.updatedAt, failure);
  if (timestampMicros(updatedAt, failure) < timestampMicros(createdAt, failure)) return failure();
  return Object.freeze({
    noteId,
    currentRevision,
    spaceId: record.spaceId === null ? null : entityId(record.spaceId, "spc", failure),
    type: noteType(record.type, failure),
    dailyDate: date(record.dailyDate, failure),
    isOpen: record.isOpen,
    pinnedAt: nullableTimestamp(record.pinnedAt, failure),
    privacy: parsedPrivacy,
    archivedAt: nullableTimestamp(record.archivedAt, failure),
    deletedAt: nullableTimestamp(record.deletedAt, failure),
    createdAt,
    updatedAt,
    contentCipher: parseStoredCipher(
      record.contentCipher,
      {
        ownerId,
        resourceId: noteId,
        recordVersion: currentRevision,
        kind: "note_content",
        keyClass: parsedPrivacy
      },
      failure
    )
  });
}

function parseNoteSummary(
  value: unknown,
  ownerId: string,
  expectedNoteId: EntityId<"note"> | null,
  failure: Failure
): EncryptedNoteReadSummary {
  return parseNoteFields(exactRecord(value, NOTE_KEYS, failure), ownerId, expectedNoteId, failure);
}

function parseSpace(
  value: unknown,
  ownerId: string,
  expectedSpaceId: EntityId<"spc"> | null,
  failure: Failure
): EncryptedNoteSpace | null {
  if (expectedSpaceId === null) {
    if (value !== null) return failure();
    return null;
  }
  const record = exactRecord(
    value,
    ["spaceId", "currentRevision", "parentId", "displayCipher", "displayMac", "parent"],
    failure
  );
  const spaceId = entityId(record.spaceId, "spc", failure);
  if (spaceId !== expectedSpaceId) return failure();
  const currentRevision = positiveInteger(record.currentRevision, failure);
  const parentId = record.parentId === null ? null : entityId(record.parentId, "spc", failure);
  if (parentId === spaceId) return failure();
  let parent: EncryptedNoteSpaceParent | null;
  if (parentId === null) {
    if (record.parent !== null) return failure();
    parent = null;
  } else {
    const parentRecord = exactRecord(
      record.parent,
      ["spaceId", "currentRevision", "displayCipher", "displayMac"],
      failure
    );
    const parsedParentId = entityId(parentRecord.spaceId, "spc", failure);
    if (parsedParentId !== parentId) return failure();
    const parentRevision = positiveInteger(parentRecord.currentRevision, failure);
    const displayCipher = parseStoredCipher(
      parentRecord.displayCipher,
      {
        ownerId,
        resourceId: parsedParentId,
        recordVersion: parentRevision,
        kind: "space_display",
        keyClass: "private_manual"
      },
      failure
    );
    parent = Object.freeze({
      spaceId: parsedParentId,
      currentRevision: parentRevision,
      displayCipher,
      displayMac: parseStoredMac(parentRecord.displayMac, displayCipher.keyClass, failure)
    });
  }
  const displayCipher = parseStoredCipher(
    record.displayCipher,
    {
      ownerId,
      resourceId: spaceId,
      recordVersion: currentRevision,
      kind: "space_display",
      keyClass: "private_manual"
    },
    failure
  );
  return Object.freeze({
    spaceId,
    currentRevision,
    parentId,
    displayCipher,
    displayMac: parseStoredMac(record.displayMac, displayCipher.keyClass, failure),
    parent
  });
}

function parseTags(value: unknown, ownerId: string, failure: Failure): readonly EncryptedNoteTag[] {
  if (!Array.isArray(value) || value.length > 100) return failure();
  let previousId: string | null = null;
  return Object.freeze(
    value.map((item) => {
      const record = exactRecord(
        item,
        ["tagId", "currentRevision", "createdAt", "displayCipher", "displayMac"],
        failure
      );
      const tagId = entityId(record.tagId, "tag", failure);
      if (previousId !== null && previousId >= tagId) return failure();
      previousId = tagId;
      const currentRevision = positiveInteger(record.currentRevision, failure);
      const displayCipher = parseStoredCipher(
        record.displayCipher,
        {
          ownerId,
          resourceId: tagId,
          recordVersion: currentRevision,
          kind: "tag_display",
          keyClass: "private_manual"
        },
        failure
      );
      return Object.freeze({
        tagId,
        currentRevision,
        createdAt: timestamp(record.createdAt, failure),
        displayCipher,
        displayMac: parseStoredMac(record.displayMac, displayCipher.keyClass, failure)
      });
    })
  );
}

function parseLinks(
  value: unknown,
  ownerId: string,
  fromNoteId: EntityId<"note">,
  failure: Failure
): readonly EncryptedNoteLink[] {
  if (!Array.isArray(value) || value.length > 100) return failure();
  let previousId: string | null = null;
  const identities = new Set<string>();
  return Object.freeze(
    value.map((item) => {
      const record = exactRecord(
        item,
        [
          "linkId",
          "toNoteId",
          "linkType",
          "source",
          "targetType",
          "targetPrivacy",
          "targetRevision",
          "targetContentCipher"
        ],
        failure
      );
      const linkId = entityId(record.linkId, "lnk", failure);
      if (previousId !== null && previousId >= linkId) return failure();
      previousId = linkId;
      const toNoteId = entityId(record.toNoteId, "note", failure);
      if (toNoteId === fromNoteId) return failure();
      if (record.linkType !== "reference" && record.linkType !== "related") return failure();
      if (record.source !== "manual" && record.source !== "organization") return failure();
      const identity = `${toNoteId}:${record.linkType}`;
      if (identities.has(identity)) return failure();
      identities.add(identity);
      const targetPrivacy = privacy(record.targetPrivacy, failure);
      const targetRevision = positiveInteger(record.targetRevision, failure);
      return Object.freeze({
        linkId,
        toNoteId,
        linkType: record.linkType,
        source: record.source,
        targetType: noteType(record.targetType, failure),
        targetPrivacy,
        targetRevision,
        targetContentCipher: parseStoredCipher(
          record.targetContentCipher,
          {
            ownerId,
            resourceId: toNoteId,
            recordVersion: targetRevision,
            kind: "note_content",
            keyClass: targetPrivacy
          },
          failure
        )
      });
    })
  );
}

function parseNoteDetail(
  value: unknown,
  ownerId: string,
  expectedNoteId: EntityId<"note">,
  failure: Failure
): EncryptedNoteRead {
  const record = exactRecord(value, NOTE_DETAIL_KEYS, failure);
  const summary = parseNoteFields(record, ownerId, expectedNoteId, failure);
  return Object.freeze({
    ...summary,
    space: parseSpace(record.space, ownerId, summary.spaceId, failure),
    tags: parseTags(record.tags, ownerId, failure),
    links: parseLinks(record.links, ownerId, summary.noteId, failure)
  });
}

function parseListCursor(value: unknown, failure: Failure): EncryptedNoteListCursor {
  const record = exactRecord(value, ["updatedAt", "noteId"], failure);
  return Object.freeze({
    updatedAt: timestamp(record.updatedAt, failure),
    noteId: entityId(record.noteId, "note", failure)
  });
}

function isBeforeCursor(
  item: EncryptedNoteListCursor,
  cursor: EncryptedNoteListCursor,
  failure: Failure
): boolean {
  const itemTime = timestampMicros(item.updatedAt, failure);
  const cursorTime = timestampMicros(cursor.updatedAt, failure);
  return itemTime < cursorTime || (itemTime === cursorTime && item.noteId < cursor.noteId);
}

function parseListNotesInput(value: unknown): Readonly<{
  ownerId: string;
  cursor: EncryptedNoteListCursor | null;
  limit: number;
}> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["ownerId", "cursor", "limit"], ["ownerId"])) {
    return inputFailure();
  }
  return Object.freeze({
    ownerId: canonicalOwnerId(value.ownerId, inputFailure),
    cursor:
      "cursor" in value && value.cursor !== null
        ? parseListCursor(value.cursor, inputFailure)
        : null,
    limit: "limit" in value ? pageSize(value.limit, inputFailure) : DEFAULT_PAGE_SIZE
  });
}

function parseListNotesResult(
  value: unknown,
  request: ReturnType<typeof parseListNotesInput>
): EncryptedNoteListPage {
  const record = exactRecord(value, ["notes", "nextCursor"], projectionFailure);
  if (!Array.isArray(record.notes) || record.notes.length > request.limit) {
    return projectionFailure();
  }
  const notes: EncryptedNoteReadSummary[] = [];
  const noteIds = new Set<string>();
  let previous: EncryptedNoteListCursor | null = null;
  for (const item of record.notes) {
    const note = parseNoteSummary(item, request.ownerId, null, projectionFailure);
    const position = { updatedAt: note.updatedAt, noteId: note.noteId };
    if (
      noteIds.has(note.noteId) ||
      (request.cursor !== null && !isBeforeCursor(position, request.cursor, projectionFailure)) ||
      (previous !== null && !isBeforeCursor(position, previous, projectionFailure))
    ) {
      return projectionFailure();
    }
    noteIds.add(note.noteId);
    previous = position;
    notes.push(note);
  }
  const nextCursor =
    record.nextCursor === null ? null : parseListCursor(record.nextCursor, projectionFailure);
  if (
    (notes.length === 0 && nextCursor !== null) ||
    (notes.length > 0 &&
      (nextCursor === null ||
        nextCursor.updatedAt !== notes.at(-1)?.updatedAt ||
        nextCursor.noteId !== notes.at(-1)?.noteId))
  ) {
    return projectionFailure();
  }
  return Object.freeze({ notes: Object.freeze(notes), nextCursor });
}

function parseRevision(
  value: unknown,
  ownerId: string,
  expectedNoteId: EntityId<"note">,
  failure: Failure
): EncryptedNoteRevisionRead {
  const record = exactRecord(
    value,
    [
      "revisionId",
      "noteId",
      "revision",
      "source",
      "spaceId",
      "type",
      "isOpen",
      "pinnedAt",
      "privacy",
      "archivedAt",
      "deletedAt",
      "actor",
      "mutationId",
      "createdAt",
      "snapshotCipher",
      "snapshotMac"
    ],
    failure
  );
  const noteId = entityId(record.noteId, "note", failure);
  if (noteId !== expectedNoteId || typeof record.isOpen !== "boolean") return failure();
  const revisionId = entityId(record.revisionId, "rev", failure);
  const revision = positiveInteger(record.revision, failure);
  const parsedPrivacy = privacy(record.privacy, failure);
  const actor = boundedString(record.actor, 3, 200, failure);
  if (!SAFE_ACTOR_PATTERN.test(actor)) return failure();
  const snapshotCipher = parseStoredCipher(
    record.snapshotCipher,
    { ownerId, resourceId: revisionId, recordVersion: revision, kind: "note_revision" },
    failure
  );
  if (parsedPrivacy === "private_manual" && snapshotCipher.keyClass !== "private_manual") {
    return failure();
  }
  return Object.freeze({
    revisionId,
    noteId,
    revision,
    source: revisionSource(record.source, failure),
    spaceId: record.spaceId === null ? null : entityId(record.spaceId, "spc", failure),
    type: noteType(record.type, failure),
    isOpen: record.isOpen,
    pinnedAt: nullableTimestamp(record.pinnedAt, failure),
    privacy: parsedPrivacy,
    archivedAt: nullableTimestamp(record.archivedAt, failure),
    deletedAt: nullableTimestamp(record.deletedAt, failure),
    actor,
    mutationId: nullableEntityId(record.mutationId, "mut", failure),
    createdAt: timestamp(record.createdAt, failure),
    snapshotCipher,
    snapshotMac: parseStoredMac(record.snapshotMac, snapshotCipher.keyClass, failure)
  });
}

function parseListRevisionsInput(value: unknown): Readonly<{
  ownerId: string;
  noteId: EntityId<"note">;
  afterRevision: number | null;
  limit: number;
}> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["ownerId", "noteId", "afterRevision", "limit"], ["ownerId", "noteId"])
  ) {
    return inputFailure();
  }
  return Object.freeze({
    ownerId: canonicalOwnerId(value.ownerId, inputFailure),
    noteId: entityId(value.noteId, "note", inputFailure),
    afterRevision:
      "afterRevision" in value && value.afterRevision !== null
        ? positiveInteger(value.afterRevision, inputFailure)
        : null,
    limit: "limit" in value ? pageSize(value.limit, inputFailure) : DEFAULT_PAGE_SIZE
  });
}

function parseListRevisionsResult(
  value: unknown,
  request: ReturnType<typeof parseListRevisionsInput>
): EncryptedNoteRevisionPage {
  const record = exactRecord(value, ["revisions", "nextRevision"], projectionFailure);
  if (!Array.isArray(record.revisions) || record.revisions.length > request.limit) {
    return projectionFailure();
  }
  const revisions: EncryptedNoteRevisionRead[] = [];
  const revisionIds = new Set<string>();
  let previousRevision: number | null = null;
  for (const item of record.revisions) {
    const revision = parseRevision(item, request.ownerId, request.noteId, projectionFailure);
    if (
      revisionIds.has(revision.revisionId) ||
      (request.afterRevision !== null && revision.revision >= request.afterRevision) ||
      (previousRevision !== null && revision.revision >= previousRevision)
    ) {
      return projectionFailure();
    }
    revisionIds.add(revision.revisionId);
    previousRevision = revision.revision;
    revisions.push(revision);
  }
  const nextRevision =
    record.nextRevision === null ? null : positiveInteger(record.nextRevision, projectionFailure);
  if (
    (revisions.length === 0 && nextRevision !== null) ||
    (revisions.length > 0 && nextRevision !== revisions.at(-1)?.revision)
  ) {
    return projectionFailure();
  }
  return Object.freeze({ revisions: Object.freeze(revisions), nextRevision });
}

function parseMutationSnapshot(
  value: unknown,
  ownerId: string,
  expectedRevision: number,
  failure: Failure
): EncryptedNoteMutationSnapshot {
  const record = exactRecord(
    value,
    ["revisionId", "revision", "privacy", "snapshotCipher", "snapshotMac"],
    failure
  );
  const revisionId = entityId(record.revisionId, "rev", failure);
  const revision = positiveInteger(record.revision, failure);
  if (revision !== expectedRevision) return failure();
  const parsedPrivacy = privacy(record.privacy, failure);
  const snapshotCipher = parseStoredCipher(
    record.snapshotCipher,
    { ownerId, resourceId: revisionId, recordVersion: revision, kind: "note_revision" },
    failure
  );
  if (parsedPrivacy === "private_manual" && snapshotCipher.keyClass !== "private_manual") {
    return failure();
  }
  return Object.freeze({
    revisionId,
    revision,
    privacy: parsedPrivacy,
    snapshotCipher,
    snapshotMac: parseStoredMac(record.snapshotMac, snapshotCipher.keyClass, failure)
  });
}

function parseMutationResult(
  value: unknown,
  ownerId: string,
  expectedMutationId: EntityId<"mut">
): EncryptedNoteMutationRead {
  const record = exactRecord(
    value,
    [
      "mutationId",
      "noteId",
      "decisionId",
      "idempotencyKey",
      "beforeRevision",
      "afterRevision",
      "undoneAt",
      "createdAt",
      "mutationCipher",
      "currentNote",
      "beforeSnapshot",
      "afterSnapshot"
    ],
    projectionFailure
  );
  const mutationId = entityId(record.mutationId, "mut", projectionFailure);
  if (mutationId !== expectedMutationId) return projectionFailure();
  const noteId = entityId(record.noteId, "note", projectionFailure);
  const beforeRevision = nonnegativeInteger(record.beforeRevision, projectionFailure);
  const afterRevision = positiveInteger(record.afterRevision, projectionFailure);
  if (afterRevision !== beforeRevision + 1) return projectionFailure();
  const beforeSnapshot =
    beforeRevision === 0
      ? record.beforeSnapshot === null
        ? null
        : projectionFailure()
      : parseMutationSnapshot(record.beforeSnapshot, ownerId, beforeRevision, projectionFailure);
  const afterSnapshot = parseMutationSnapshot(
    record.afterSnapshot,
    ownerId,
    afterRevision,
    projectionFailure
  );
  if (beforeSnapshot !== null && beforeSnapshot.revisionId === afterSnapshot.revisionId) {
    return projectionFailure();
  }
  const expectedClass: KeyClass =
    beforeSnapshot?.privacy === "private_manual" || afterSnapshot.privacy === "private_manual"
      ? "private_manual"
      : "ai_assisted";
  const mutationCipher = parseStoredCipher(
    record.mutationCipher,
    {
      ownerId,
      resourceId: mutationId,
      recordVersion: afterRevision,
      kind: "note_mutation",
      keyClass: expectedClass
    },
    projectionFailure
  );
  if (afterSnapshot.snapshotCipher.keyClass !== expectedClass) return projectionFailure();
  const currentNote = parseNoteDetail(record.currentNote, ownerId, noteId, projectionFailure);
  if (
    currentNote.currentRevision < afterRevision ||
    (currentNote.currentRevision === afterRevision && currentNote.privacy !== afterSnapshot.privacy)
  ) {
    return projectionFailure();
  }
  const decisionId = nullableEntityId(record.decisionId, "dec", projectionFailure);
  const parsedIdempotencyKey = boundedString(record.idempotencyKey, 1, 200, projectionFailure);
  if (
    beforeRevision === 0 &&
    decisionId !== null &&
    !ORGANIZER_CREATE_IDEMPOTENCY_PATTERN.test(parsedIdempotencyKey) &&
    !OWNER_INTERACTION_CREATE_IDEMPOTENCY_PATTERN.test(parsedIdempotencyKey)
  ) {
    return projectionFailure();
  }
  const createdAt = timestamp(record.createdAt, projectionFailure);
  const undoneAt = nullableTimestamp(record.undoneAt, projectionFailure);
  if (
    timestampMicros(currentNote.updatedAt, projectionFailure) <
      timestampMicros(createdAt, projectionFailure) ||
    (undoneAt !== null &&
      timestampMicros(undoneAt, projectionFailure) < timestampMicros(createdAt, projectionFailure))
  ) {
    return projectionFailure();
  }
  return Object.freeze({
    mutationId,
    noteId,
    decisionId,
    idempotencyKey: parsedIdempotencyKey,
    beforeRevision,
    afterRevision,
    undoneAt,
    createdAt,
    mutationCipher,
    currentNote,
    beforeSnapshot,
    afterSnapshot
  });
}

function parseGetNoteInput(value: unknown): Readonly<{
  ownerId: string;
  noteId: EntityId<"note">;
}> {
  const record = exactRecord(value, ["ownerId", "noteId"], inputFailure);
  return Object.freeze({
    ownerId: canonicalOwnerId(record.ownerId, inputFailure),
    noteId: entityId(record.noteId, "note", inputFailure)
  });
}

function parseGetMutationInput(value: unknown): Readonly<{
  ownerId: string;
  mutationId: EntityId<"mut">;
}> {
  const record = exactRecord(value, ["ownerId", "mutationId"], inputFailure);
  return Object.freeze({
    ownerId: canonicalOwnerId(record.ownerId, inputFailure),
    mutationId: entityId(record.mutationId, "mut", inputFailure)
  });
}

export function createEncryptedNoteReadRpcAdapter(
  client: ServiceRpcClient
): EncryptedNoteReadRpcAdapter {
  return Object.freeze({
    async listNotes(input: ListEncryptedNotesInput): Promise<EncryptedNoteListPage> {
      const request = parseListNotesInput(input);
      return parseListNotesResult(
        await client.rpc("list_encrypted_notes", {
          p_owner_id: request.ownerId,
          p_after_updated_at: request.cursor?.updatedAt ?? null,
          p_after_note_id: request.cursor?.noteId ?? null,
          p_limit: request.limit
        }),
        request
      );
    },

    async getNote(input: GetEncryptedNoteInput): Promise<EncryptedNoteRead> {
      const request = parseGetNoteInput(input);
      return parseNoteDetail(
        await client.rpc("get_encrypted_note", {
          p_owner_id: request.ownerId,
          p_note_id: request.noteId
        }),
        request.ownerId,
        request.noteId,
        projectionFailure
      );
    },

    async listRevisions(
      input: ListEncryptedNoteRevisionsInput
    ): Promise<EncryptedNoteRevisionPage> {
      const request = parseListRevisionsInput(input);
      return parseListRevisionsResult(
        await client.rpc("list_encrypted_note_revisions", {
          p_owner_id: request.ownerId,
          p_note_id: request.noteId,
          p_after_revision: request.afterRevision,
          p_limit: request.limit
        }),
        request
      );
    },

    async getMutation(input: GetEncryptedNoteMutationInput): Promise<EncryptedNoteMutationRead> {
      const request = parseGetMutationInput(input);
      return parseMutationResult(
        await client.rpc("get_encrypted_note_mutation", {
          p_owner_id: request.ownerId,
          p_mutation_id: request.mutationId
        }),
        request.ownerId,
        request.mutationId
      );
    }
  });
}
