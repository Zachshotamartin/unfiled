import { createHmac, timingSafeEqual } from "node:crypto";

import { ApiErrorCode, parseEntityId, type EntityId } from "@unfiled/contracts";

import { ConfigurationError, HttpError } from "@/server/api/errors";

import type { NoteBacklinkPageCursor, NoteSourcePageCursor } from "./note-context-rpc-adapter";

const CURSOR_DOMAIN = "unfiled/note-context-cursor/hmac-sha256/v1";
const CURSOR_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,420}\.[A-Za-z0-9_-]{43}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/u;

export type NoteContextCursorSurface = "backlinks" | "sources";

type CursorPayload = Readonly<{
  createdAt: string;
  noteId: EntityId<"note">;
  primaryId: string;
  revision: number;
  secondaryId: string | null;
  surface: NoteContextCursorSurface;
  version: 1;
}>;

export type DecodedNoteContextCursor = Readonly<{
  after: NoteBacklinkPageCursor | NoteSourcePageCursor;
  expectedNoteRevision: number;
}>;

function invalidCursor(): never {
  throw new HttpError(
    400,
    ApiErrorCode.VALIDATION_FAILED,
    "That page cursor is invalid or no longer matches this note."
  );
}

export function noteContextCursorKey(value: string | undefined): Buffer {
  if (value === undefined || !CURSOR_KEY_PATTERN.test(value)) throw new ConfigurationError();
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value) {
    key.fill(0);
    throw new ConfigurationError();
  }
  return key;
}

function mac(key: Buffer, ownerId: string, payload: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(CURSOR_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(ownerId, "utf8")
    .update("\0", "utf8")
    .update(payload)
    .digest();
}

function cursorPayload(
  surface: NoteContextCursorSurface,
  noteId: EntityId<"note">,
  revision: number,
  after: NoteBacklinkPageCursor | NoteSourcePageCursor
): CursorPayload {
  if (surface === "sources") {
    const source = after as NoteSourcePageCursor;
    return {
      version: 1,
      surface,
      noteId,
      revision,
      createdAt: source.createdAt,
      primaryId: source.captureId,
      secondaryId: source.mutationId
    };
  }
  const backlink = after as NoteBacklinkPageCursor;
  return {
    version: 1,
    surface,
    noteId,
    revision,
    createdAt: backlink.createdAt,
    primaryId: backlink.linkId,
    secondaryId: null
  };
}

export function encodeNoteContextCursor(input: {
  after: NoteBacklinkPageCursor | NoteSourcePageCursor;
  key: Buffer;
  noteId: EntityId<"note">;
  ownerId: string;
  revision: number;
  surface: NoteContextCursorSurface;
}): string {
  const serialized = Buffer.from(
    JSON.stringify(cursorPayload(input.surface, input.noteId, input.revision, input.after)),
    "utf8"
  );
  const tag = mac(input.key, input.ownerId, serialized);
  try {
    return `${serialized.toString("base64url")}.${tag.toString("base64url")}`;
  } finally {
    serialized.fill(0);
    tag.fill(0);
  }
}

function payloadFromUnknown(value: unknown): CursorPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidCursor();
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [
    "createdAt",
    "noteId",
    "primaryId",
    "revision",
    "secondaryId",
    "surface",
    "version"
  ].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return invalidCursor();
  }
  if (
    record.version !== 1 ||
    (record.surface !== "sources" && record.surface !== "backlinks") ||
    typeof record.noteId !== "string" ||
    typeof record.primaryId !== "string" ||
    (record.secondaryId !== null && typeof record.secondaryId !== "string") ||
    typeof record.createdAt !== "string" ||
    !TIMESTAMP_PATTERN.test(record.createdAt) ||
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    record.revision > 2_147_483_647
  ) {
    return invalidCursor();
  }
  try {
    parseEntityId(record.noteId, "note");
  } catch {
    return invalidCursor();
  }
  return record as CursorPayload;
}

export function decodeNoteContextCursor(input: {
  cursor: string;
  key: Buffer;
  noteId: EntityId<"note">;
  ownerId: string;
  surface: NoteContextCursorSurface;
}): DecodedNoteContextCursor {
  if (!CURSOR_PATTERN.test(input.cursor) || input.cursor.length > 512) return invalidCursor();
  const [encodedPayload, encodedTag, extra] = input.cursor.split(".");
  if (encodedPayload === undefined || encodedTag === undefined || extra !== undefined) {
    return invalidCursor();
  }
  const payloadBytes = Buffer.from(encodedPayload, "base64url");
  const suppliedTag = Buffer.from(encodedTag, "base64url");
  const expectedTag = mac(input.key, input.ownerId, payloadBytes);
  try {
    if (
      payloadBytes.toString("base64url") !== encodedPayload ||
      suppliedTag.toString("base64url") !== encodedTag ||
      suppliedTag.byteLength !== expectedTag.byteLength ||
      !timingSafeEqual(suppliedTag, expectedTag)
    ) {
      return invalidCursor();
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
    } catch {
      return invalidCursor();
    }
    const payload = payloadFromUnknown(decoded);
    if (payload.surface !== input.surface || payload.noteId !== input.noteId) {
      return invalidCursor();
    }
    if (payload.surface === "sources") {
      if (payload.secondaryId === null) return invalidCursor();
      try {
        parseEntityId(payload.primaryId, "cap");
        parseEntityId(payload.secondaryId, "mut");
      } catch {
        return invalidCursor();
      }
      return Object.freeze({
        expectedNoteRevision: payload.revision,
        after: Object.freeze({
          captureId: payload.primaryId as EntityId<"cap">,
          mutationId: payload.secondaryId as EntityId<"mut">,
          createdAt: payload.createdAt
        })
      });
    }
    if (payload.secondaryId !== null) return invalidCursor();
    try {
      parseEntityId(payload.primaryId, "lnk");
    } catch {
      return invalidCursor();
    }
    return Object.freeze({
      expectedNoteRevision: payload.revision,
      after: Object.freeze({
        linkId: payload.primaryId as EntityId<"lnk">,
        createdAt: payload.createdAt
      })
    });
  } finally {
    payloadBytes.fill(0);
    suppliedTag.fill(0);
    expectedTag.fill(0);
  }
}
