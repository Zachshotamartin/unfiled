import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  contentHash,
  createInitialNote,
  deepFreeze,
  updateNoteTitle
} from "../src/index.js";

const baseNote = {
  id: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const,
  userId: "00000000-0000-4000-8000-000000000001",
  title: "Shopping",
  type: "list" as const,
  privacy: "ai_assisted" as const,
  now: "2026-08-30T18:30:00.000Z"
};

describe("note aggregate", () => {
  it("creates an immutable first revision", () => {
    const result = createInitialNote(baseNote);

    expect(result.note.currentRevision).toBe(1);
    expect(result.revision.revision).toBe(1);
    expect(Object.isFrozen(result.note)).toBe(true);
  });

  it("rejects stale title edits", () => {
    const { note } = createInitialNote(baseNote);

    expect(() =>
      updateNoteTitle(note, {
        expectedRevision: 0,
        title: "Groceries",
        now: "2026-08-30T18:31:00.000Z"
      })
    ).toThrow(/stale_revision/u);
  });

  it("updates a title immutably and snapshots the next revision", () => {
    const { note } = createInitialNote({
      ...baseNote,
      spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      bodyMarkdown: "- [ ] milk",
      structuredData: { sections: [{ items: ["milk"] }] }
    });
    const result = updateNoteTitle(note, {
      expectedRevision: 1,
      title: "  Groceries  ",
      now: "2026-08-30T18:31:00.000Z"
    });

    expect(result.note.title).toBe("Groceries");
    expect(result.note.currentRevision).toBe(2);
    expect(result.revision.source).toBe("manual");
    expect(result.revision.contentHash).toHaveLength(64);
    expect(note.title).toBe("Shopping");
    expect(Object.isFrozen(result.note.structuredData)).toBe(true);
  });

  it("rejects blank and oversized titles on creation and update", () => {
    expect(() => createInitialNote({ ...baseNote, title: "  " })).toThrow(/validation_failed/u);
    expect(() => createInitialNote({ ...baseNote, title: "x".repeat(201) })).toThrow(
      /validation_failed/u
    );
    const { note } = createInitialNote(baseNote);
    expect(() =>
      updateNoteTitle(note, {
        expectedRevision: 1,
        title: "",
        now: "2026-08-30T18:31:00.000Z"
      })
    ).toThrow(/validation_failed/u);
    expect(() =>
      updateNoteTitle(note, {
        expectedRevision: 1,
        title: "x".repeat(201),
        now: "2026-08-30T18:31:00.000Z"
      })
    ).toThrow(/validation_failed/u);
  });

  it("canonicalizes nested values deterministically and safely freezes primitives", () => {
    const left = { z: [3, { b: 2, a: 1 }], a: null };
    const right = { a: null, z: [3, { a: 1, b: 2 }] };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(contentHash(left)).toBe(contentHash(right));
    expect(deepFreeze("already immutable")).toBe("already immutable");
    expect(deepFreeze(Object.freeze({ done: true }))).toEqual({ done: true });
  });
});
