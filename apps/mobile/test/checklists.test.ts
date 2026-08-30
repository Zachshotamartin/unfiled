import { describe, expect, it } from "vitest";

import {
  checklistItemsFromNote,
  toggleChecklistItemLocally
} from "../src/features/notes/checklists";

describe("mobile checklist projection", () => {
  it("reads canonical structured items in ordinal order", () => {
    const items = checklistItemsFromNote({
      archivedAt: null,
      bodyMarkdown: "- [ ] Milk\n- [x] Bread",
      createdAt: "2026-08-30T10:00:00.000Z",
      currentRevision: 2,
      deletedAt: null,
      id: "note_01J00000000000000000000000",
      isOpen: true,
      links: [],
      pinnedAt: null,
      privacy: "ai_assisted",
      revisions: [],
      spaceId: null,
      structuredData: {
        items: [
          {
            checked: true,
            id: "itm_01J00000000000000000000002",
            ordinal: 1,
            section: null,
            text: "Bread"
          },
          {
            checked: false,
            id: "itm_01J00000000000000000000001",
            ordinal: 0,
            section: null,
            text: "Milk"
          }
        ],
        schemaVersion: 1
      },
      tagIds: [],
      title: "Shopping",
      type: "list",
      updatedAt: "2026-08-30T11:00:00.000Z"
    });
    expect(items.map(({ id }) => id)).toEqual([
      "itm_01J00000000000000000000001",
      "itm_01J00000000000000000000002"
    ]);
    expect(toggleChecklistItemLocally(items, items[0]?.id ?? "", true)[0]?.checked).toBe(true);
    expect(items[0]?.checked).toBe(false);
  });
});
