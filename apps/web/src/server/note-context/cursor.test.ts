import type { EntityId } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import { ConfigurationError, HttpError } from "@/server/api/errors";

import { decodeNoteContextCursor, encodeNoteContextCursor, noteContextCursorKey } from "./cursor";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"note">;
const OTHER_NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as EntityId<"note">;
const CAPTURE = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"cap">;
const MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"mut">;
const SECRET = Buffer.alloc(32, 7).toString("base64url");

describe("note-context cursor", () => {
  it("round-trips an owner, note, surface, revision, and source keyset bound cursor", () => {
    const key = noteContextCursorKey(SECRET);
    const cursor = encodeNoteContextCursor({
      ownerId: OWNER,
      noteId: NOTE,
      revision: 9,
      surface: "sources",
      key,
      after: {
        captureId: CAPTURE,
        mutationId: MUTATION,
        createdAt: "2026-09-01T20:00:00.000Z"
      }
    });

    expect(
      decodeNoteContextCursor({ cursor, ownerId: OWNER, noteId: NOTE, surface: "sources", key })
    ).toEqual({
      expectedNoteRevision: 9,
      after: {
        captureId: CAPTURE,
        mutationId: MUTATION,
        createdAt: "2026-09-01T20:00:00.000Z"
      }
    });
    key.fill(0);
  });

  it("rejects tampering and reuse across owners, notes, or context surfaces", () => {
    const key = noteContextCursorKey(SECRET);
    const cursor = encodeNoteContextCursor({
      ownerId: OWNER,
      noteId: NOTE,
      revision: 2,
      surface: "sources",
      key,
      after: {
        captureId: CAPTURE,
        mutationId: MUTATION,
        createdAt: "2026-09-01T20:00:00.000Z"
      }
    });
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    const cases = [
      { cursor: tampered, ownerId: OWNER, noteId: NOTE, surface: "sources" as const, key },
      { cursor, ownerId: OTHER_OWNER, noteId: NOTE, surface: "sources" as const, key },
      { cursor, ownerId: OWNER, noteId: OTHER_NOTE, surface: "sources" as const, key },
      { cursor, ownerId: OWNER, noteId: NOTE, surface: "backlinks" as const, key }
    ];
    for (const input of cases) expect(() => decodeNoteContextCursor(input)).toThrow(HttpError);
    key.fill(0);
  });

  it("requires an exact 32-byte canonical base64url key", () => {
    expect(() => noteContextCursorKey(undefined)).toThrow(ConfigurationError);
    expect(() => noteContextCursorKey("A".repeat(42))).toThrow(ConfigurationError);
    expect(noteContextCursorKey(SECRET)).toHaveLength(32);
  });
});
