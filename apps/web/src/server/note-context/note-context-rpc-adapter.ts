import {
  CaptureSourceSchema,
  PrivacyModeSchema,
  parseEntityId,
  type CaptureSource,
  type EntityId,
  type PrivacyMode
} from "@unfiled/contracts";

import { canonicalUtcTimestampFromMicros } from "@/server/encryption/canonical-rpc-timestamp";
import {
  parseStoredCipher,
  parseStoredMac
} from "@/server/encryption/encrypted-note-read-rpc-adapter";
import {
  ServiceRpcError,
  ServiceRpcErrorCode,
  type ServiceRpcClient
} from "@/server/encryption/service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_SOURCE_PAGE_SIZE = 101;
const MAX_BACKLINK_PAGE_SIZE = 5;

export const noteContextRpcFunctions = Object.freeze([
  "list_encrypted_note_sources",
  "list_encrypted_note_backlinks"
] as const);

export type NoteSourcePageCursor = Readonly<{
  captureId: EntityId<"cap">;
  createdAt: string;
  mutationId: EntityId<"mut">;
}>;

export type NoteBacklinkPageCursor = Readonly<{
  createdAt: string;
  linkId: EntityId<"lnk">;
}>;

export type EncryptedNoteSourceRow = Readonly<{
  captureId: EntityId<"cap">;
  clientCreatedAt: string;
  contentCipher: unknown;
  contentLength: number;
  contentMac: unknown;
  createdAt: string;
  insertedItemIds: readonly (EntityId<"itm"> | EntityId<"ent">)[];
  mutationId: EntityId<"mut">;
  privacy: PrivacyMode;
  relation: "routed" | "source_removed";
  source: CaptureSource;
}>;

export type EncryptedNoteBacklinkRow = Readonly<{
  createdAt: string;
  fromContentCipher: unknown;
  fromNoteId: EntityId<"note">;
  fromNoteRevision: number;
  fromPrivacy: PrivacyMode;
  linkId: EntityId<"lnk">;
  linkType: "reference" | "related";
}>;

export type EncryptedNoteSourcesPage = Readonly<{
  currentRevision: number;
  items: readonly EncryptedNoteSourceRow[];
  noteId: EntityId<"note">;
}>;

export type EncryptedNoteBacklinksPage = Readonly<{
  currentRevision: number;
  items: readonly EncryptedNoteBacklinkRow[];
  noteId: EntityId<"note">;
}>;

type ListSourcesInput = Readonly<{
  after?: NoteSourcePageCursor | null;
  expectedNoteRevision?: number | null;
  limit: number;
  noteId: EntityId<"note">;
  ownerId: string;
}>;

type ListBacklinksInput = Readonly<{
  after?: NoteBacklinkPageCursor | null;
  expectedNoteRevision?: number | null;
  limit: number;
  noteId: EntityId<"note">;
  ownerId: string;
}>;

export type NoteContextRpcAdapter = Readonly<{
  listBacklinks(input: ListBacklinksInput): Promise<EncryptedNoteBacklinksPage>;
  listSources(input: ListSourcesInput): Promise<EncryptedNoteSourcesPage>;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;
type Failure = () => never;

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

function entityId<Kind extends "cap" | "ent" | "itm" | "lnk" | "mut" | "note">(
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

function ownerId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalidInput();
  return value.toLowerCase();
}

function positiveInteger(value: unknown, maximum: number, failure: Failure): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > maximum) {
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
  return (
    BigInt(local.valueOf() - offsetMinutes * 60_000) * 1_000n +
    BigInt((fraction ?? "").padEnd(6, "0"))
  );
}

function timestamp(value: unknown, failure: Failure): string {
  return canonicalUtcTimestampFromMicros(timestampMicros(value, failure), failure);
}

function privacy(value: unknown, failure: Failure): PrivacyMode {
  const parsed = PrivacyModeSchema.safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function source(value: unknown, failure: Failure): CaptureSource {
  const parsed = CaptureSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function relation(value: unknown, failure: Failure): "routed" | "source_removed" {
  return value === "routed" || value === "source_removed" ? value : failure();
}

function linkType(value: unknown, failure: Failure): "reference" | "related" {
  return value === "reference" || value === "related" ? value : failure();
}

function insertedItemIds(
  value: unknown,
  failure: Failure
): readonly (EntityId<"itm"> | EntityId<"ent">)[] {
  if (!Array.isArray(value) || value.length > 500) return failure();
  const ids = value.map((candidate) => {
    if (typeof candidate !== "string") return failure();
    try {
      parseEntityId(candidate, "itm");
      return candidate as EntityId<"itm">;
    } catch {
      try {
        parseEntityId(candidate, "ent");
        return candidate as EntityId<"ent">;
      } catch {
        return failure();
      }
    }
  });
  return Object.freeze(ids);
}

function parseSourceRow(value: unknown, expectedOwnerId: string): EncryptedNoteSourceRow {
  const row = exactRecord(
    value,
    [
      "captureId",
      "mutationId",
      "relation",
      "insertedItemIds",
      "createdAt",
      "source",
      "clientCreatedAt",
      "contentLength",
      "privacy",
      "contentCipher",
      "contentMac"
    ],
    invalidProjection
  );
  const captureId = entityId(row.captureId, "cap", invalidProjection);
  const parsedPrivacy = privacy(row.privacy, invalidProjection);
  return Object.freeze({
    captureId,
    mutationId: entityId(row.mutationId, "mut", invalidProjection),
    relation: relation(row.relation, invalidProjection),
    insertedItemIds: insertedItemIds(row.insertedItemIds, invalidProjection),
    createdAt: timestamp(row.createdAt, invalidProjection),
    source: source(row.source, invalidProjection),
    clientCreatedAt: timestamp(row.clientCreatedAt, invalidProjection),
    contentLength: positiveInteger(row.contentLength, 10_000, invalidProjection),
    privacy: parsedPrivacy,
    contentCipher: parseStoredCipher(
      row.contentCipher,
      {
        ownerId: expectedOwnerId,
        resourceId: captureId,
        recordVersion: 1,
        kind: "capture",
        keyClass: parsedPrivacy
      },
      invalidProjection
    ),
    contentMac: parseStoredMac(row.contentMac, parsedPrivacy, invalidProjection)
  });
}

function parseBacklinkRow(value: unknown, expectedOwnerId: string): EncryptedNoteBacklinkRow {
  const row = exactRecord(
    value,
    [
      "linkId",
      "fromNoteId",
      "fromNoteRevision",
      "linkType",
      "createdAt",
      "fromPrivacy",
      "fromContentCipher"
    ],
    invalidProjection
  );
  const fromNoteId = entityId(row.fromNoteId, "note", invalidProjection);
  const fromNoteRevision = positiveInteger(
    row.fromNoteRevision,
    MAX_DATABASE_INTEGER,
    invalidProjection
  );
  const fromPrivacy = privacy(row.fromPrivacy, invalidProjection);
  return Object.freeze({
    linkId: entityId(row.linkId, "lnk", invalidProjection),
    fromNoteId,
    fromNoteRevision,
    linkType: linkType(row.linkType, invalidProjection),
    createdAt: timestamp(row.createdAt, invalidProjection),
    fromPrivacy,
    fromContentCipher: parseStoredCipher(
      row.fromContentCipher,
      {
        ownerId: expectedOwnerId,
        resourceId: fromNoteId,
        recordVersion: fromNoteRevision,
        kind: "note_content",
        keyClass: fromPrivacy
      },
      invalidProjection
    )
  });
}

type SourcePosition = Pick<EncryptedNoteSourceRow, "captureId" | "createdAt" | "mutationId">;
type BacklinkPosition = Pick<EncryptedNoteBacklinkRow, "createdAt" | "linkId">;

function compareSources(left: SourcePosition, right: SourcePosition): number {
  const time =
    timestampMicros(right.createdAt, invalidProjection) -
    timestampMicros(left.createdAt, invalidProjection);
  if (time !== 0n) return time > 0n ? 1 : -1;
  if (left.captureId !== right.captureId) return left.captureId > right.captureId ? -1 : 1;
  return left.mutationId === right.mutationId ? 0 : left.mutationId > right.mutationId ? -1 : 1;
}

function compareBacklinks(left: BacklinkPosition, right: BacklinkPosition): number {
  const time =
    timestampMicros(right.createdAt, invalidProjection) -
    timestampMicros(left.createdAt, invalidProjection);
  if (time !== 0n) return time > 0n ? 1 : -1;
  return left.linkId === right.linkId ? 0 : left.linkId > right.linkId ? -1 : 1;
}

function validateCommonInput(
  input: {
    expectedNoteRevision?: number | null;
    limit: number;
    noteId: EntityId<"note">;
    ownerId: string;
  },
  maximumPageSize: number
) {
  return Object.freeze({
    ownerId: ownerId(input.ownerId),
    noteId: entityId(input.noteId, "note", invalidInput),
    expectedNoteRevision:
      input.expectedNoteRevision === null || input.expectedNoteRevision === undefined
        ? null
        : positiveInteger(input.expectedNoteRevision, MAX_DATABASE_INTEGER, invalidInput),
    limit: positiveInteger(input.limit, maximumPageSize, invalidInput)
  });
}

function parsePage<Row>(
  value: unknown,
  expected: ReturnType<typeof validateCommonInput>,
  parseRow: (row: unknown) => Row,
  compare: (left: Row, right: Row) => number
): Readonly<{ currentRevision: number; items: readonly Row[]; noteId: EntityId<"note"> }> {
  const page = exactRecord(value, ["noteId", "currentRevision", "items"], invalidProjection);
  const noteId = entityId(page.noteId, "note", invalidProjection);
  const currentRevision = positiveInteger(
    page.currentRevision,
    MAX_DATABASE_INTEGER,
    invalidProjection
  );
  if (
    noteId !== expected.noteId ||
    (expected.expectedNoteRevision !== null && currentRevision !== expected.expectedNoteRevision) ||
    !Array.isArray(page.items) ||
    page.items.length > expected.limit
  ) {
    return invalidProjection();
  }
  const items = Object.freeze(page.items.map(parseRow));
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous === undefined || current === undefined || compare(previous, current) >= 0) {
      return invalidProjection();
    }
  }
  return Object.freeze({ noteId, currentRevision, items });
}

export function createNoteContextRpcAdapter(client: ServiceRpcClient): NoteContextRpcAdapter {
  return Object.freeze({
    async listSources(input) {
      const request = validateCommonInput(input, MAX_SOURCE_PAGE_SIZE);
      const after = input.after ?? null;
      if (after !== null) {
        entityId(after.captureId, "cap", invalidInput);
        entityId(after.mutationId, "mut", invalidInput);
        timestamp(after.createdAt, invalidInput);
        if (request.expectedNoteRevision === null) return invalidInput();
      }
      const page = parsePage(
        await client.rpc("list_encrypted_note_sources", {
          p_owner_id: request.ownerId,
          p_note_id: request.noteId,
          p_expected_note_revision: request.expectedNoteRevision,
          p_after_created_at: after?.createdAt ?? null,
          p_after_capture_id: after?.captureId ?? null,
          p_after_mutation_id: after?.mutationId ?? null,
          p_limit: request.limit
        }),
        request,
        (row) => parseSourceRow(row, request.ownerId),
        compareSources
      );
      const first = page.items[0];
      if (after !== null && first !== undefined && compareSources(after, first) >= 0) {
        return invalidProjection();
      }
      return page;
    },

    async listBacklinks(input) {
      const request = validateCommonInput(input, MAX_BACKLINK_PAGE_SIZE);
      const after = input.after ?? null;
      if (after !== null) {
        entityId(after.linkId, "lnk", invalidInput);
        timestamp(after.createdAt, invalidInput);
        if (request.expectedNoteRevision === null) return invalidInput();
      }
      const page = parsePage(
        await client.rpc("list_encrypted_note_backlinks", {
          p_owner_id: request.ownerId,
          p_note_id: request.noteId,
          p_expected_note_revision: request.expectedNoteRevision,
          p_after_created_at: after?.createdAt ?? null,
          p_after_link_id: after?.linkId ?? null,
          p_limit: request.limit
        }),
        request,
        (row) => parseBacklinkRow(row, request.ownerId),
        compareBacklinks
      );
      const first = page.items[0];
      if (after !== null && first !== undefined && compareBacklinks(after, first) >= 0) {
        return invalidProjection();
      }
      return page;
    }
  });
}
