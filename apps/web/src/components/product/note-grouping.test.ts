import type { NoteSummary } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import { groupNotesByDay } from "./note-grouping";

function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    archivedAt: null,
    currentRevision: 2,
    deletedAt: null,
    id: "note_01ARZ3NDEKTSV4RRFFQ69G5FA1",
    isOpen: true,
    pinnedAt: null,
    privacy: "ai_assisted",
    spaceId: null,
    title: "A note",
    type: "generic",
    updatedAt: "2026-09-03T09:00:00.000Z",
    ...overrides
  };
}

const now = new Date("2026-09-03T18:00:00.000Z");

describe("groupNotesByDay", () => {
  it("groups by when a note last changed, in the app's order", () => {
    const groups = groupNotesByDay(
      [
        note({ id: "note_01ARZ3NDEKTSV4RRFFQ69G5FA1", updatedAt: "2026-09-03T09:00:00.000Z" }),
        note({ id: "note_01ARZ3NDEKTSV4RRFFQ69G5FA2", updatedAt: "2026-09-02T09:00:00.000Z" }),
        note({ id: "note_01ARZ3NDEKTSV4RRFFQ69G5FA3", updatedAt: "2026-08-30T09:00:00.000Z" }),
        note({ id: "note_01ARZ3NDEKTSV4RRFFQ69G5FA4", updatedAt: "2026-07-01T09:00:00.000Z" }),
        note({
          id: "note_01ARZ3NDEKTSV4RRFFQ69G5FA5",
          pinnedAt: "2026-01-01T09:00:00.000Z",
          updatedAt: "2026-01-01T09:00:00.000Z"
        })
      ],
      now
    );

    expect(groups.map((group) => group.title)).toEqual([
      "Pinned",
      "Today",
      "Yesterday",
      "This week",
      "Earlier"
    ]);
    expect(groups.map((group) => group.notes.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("leaves out a group with nothing in it", () => {
    const groups = groupNotesByDay([note({ updatedAt: "2026-09-03T09:00:00.000Z" })], now);

    expect(groups.map((group) => group.title)).toEqual(["Today"]);
  });

  it("keeps a note whose timestamp cannot be read instead of dropping it", () => {
    const groups = groupNotesByDay([note({ updatedAt: "not a date" })], now);

    expect(groups).toEqual([
      { notes: [expect.objectContaining({ updatedAt: "not a date" })], title: "Earlier" }
    ]);
  });
});
