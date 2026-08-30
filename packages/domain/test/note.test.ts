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
      structuredData: {
        schemaVersion: 1,
        items: [
          {
            id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            text: "milk",
            checked: false,
            ordinal: 0,
            section: null
          }
        ]
      }
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

  it("initializes list, log, and project content from their canonical source", () => {
    const list = createInitialNote({
      ...baseNote,
      bodyMarkdown: "## Market\n\n- [ ] milk"
    }).note;
    expect(list.bodyMarkdown).toBe("## Market\n\n- [ ] milk");
    expect(list.structuredData).toMatchObject({
      items: [{ text: "milk", section: "Market" }]
    });

    const log = createInitialNote({
      ...baseNote,
      type: "log",
      bodyMarkdown: "Bench press: 8 reps"
    }).note;
    expect(log.structuredData).toMatchObject({
      entries: [{ fields: { text: "Bench press: 8 reps" } }]
    });
    expect(log.bodyMarkdown).toContain("- text: Bench press: 8 reps");

    const project = createInitialNote({
      ...baseNote,
      type: "project",
      structuredData: {
        schemaVersion: 1,
        checklistItems: [
          {
            id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            text: "Ship",
            checked: true,
            ordinal: 0,
            lineIndex: 0
          }
        ]
      }
    }).note;
    expect(project.bodyMarkdown).toBe("- [x] Ship");
  });

  it("rejects a supplied log structure whose Markdown projection disagrees", () => {
    expect(() =>
      createInitialNote({
        ...baseNote,
        type: "log",
        bodyMarkdown: "edited outside the log fields",
        structuredData: {
          schemaVersion: 1,
          entries: [
            {
              id: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
              occurredAt: baseNote.now,
              fields: { exercise: "Bench" }
            }
          ]
        }
      })
    ).toThrow(/structure_conflict/u);
    expect(() => createInitialNote({ ...baseNote, bodyMarkdown: "x".repeat(200_001) })).toThrow(
      /validation_failed/u
    );
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
