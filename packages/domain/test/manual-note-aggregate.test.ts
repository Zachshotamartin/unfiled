import type { EntityId, EntityKind } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  applyNoteOperations,
  archiveNote,
  createInitialNote,
  moveNote,
  patchNote,
  restoreDeletedNote,
  restoreNoteRevision,
  softDeleteNote,
  undoNoteMutation
} from "../src/index.js";

const NOW = "2026-08-30T18:30:00.000Z";
const LATER = "2026-08-30T18:31:00.000Z";
const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const ITEM_ID = "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;

function deterministicId<K extends EntityKind>(kind: K): EntityId<K> {
  const ids: Partial<Record<EntityKind, string>> = {
    mut: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1M",
    rev: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1R",
    itm: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1N"
  };
  const id = ids[kind];
  if (!id) throw new Error(`No deterministic ${kind} fixture`);
  return id as EntityId<K>;
}

function listNote() {
  return createInitialNote({
    id: NOTE_ID,
    userId: "00000000-0000-4000-8000-000000000001",
    title: "Shopping",
    type: "list",
    privacy: "ai_assisted",
    now: NOW,
    structuredData: {
      schemaVersion: 1,
      items: [{ id: ITEM_ID, text: "milk", checked: false, ordinal: 0, section: null }]
    }
  }).note;
}

function projectNote() {
  return createInitialNote({
    id: NOTE_ID,
    userId: "00000000-0000-4000-8000-000000000001",
    title: "Launch",
    type: "project",
    privacy: "ai_assisted",
    now: NOW,
    bodyMarkdown: "# Launch\n\n- [ ] Ship homepage\n- [ ] Write notes",
    structuredData: {
      schemaVersion: 1,
      checklistItems: [
        {
          id: ITEM_ID,
          text: "Ship homepage",
          checked: false,
          ordinal: 0,
          lineIndex: 2
        },
        {
          id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
          text: "Write notes",
          checked: false,
          ordinal: 1,
          lineIndex: 3
        }
      ]
    }
  }).note;
}

function logNote() {
  return createInitialNote({
    id: NOTE_ID,
    userId: "00000000-0000-4000-8000-000000000001",
    title: "Workout",
    type: "log",
    privacy: "ai_assisted",
    now: NOW,
    structuredData: {
      schemaVersion: 1,
      entries: [
        {
          id: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
          occurredAt: NOW,
          fields: { exercise: "Bench", reps: 8 }
        }
      ]
    }
  }).note;
}

describe("manual note aggregate", () => {
  it("creates correct immutable structured defaults for all five note types", () => {
    const expectations = {
      generic: { schemaVersion: 1 },
      list: { schemaVersion: 1, items: [] },
      log: { schemaVersion: 1, entries: [] },
      principle: { schemaVersion: 1 },
      project: { schemaVersion: 1, checklistItems: [] }
    } as const;

    for (const [type, structuredData] of Object.entries(expectations)) {
      const result = createInitialNote({
        id: NOTE_ID,
        userId: "00000000-0000-4000-8000-000000000001",
        title: type,
        type: type as keyof typeof expectations,
        privacy: "private_manual",
        now: NOW
      });
      expect(result.note.structuredData).toEqual(structuredData);
      expect(result.revision).toMatchObject({ revision: 1, source: "manual", type });
      expect(Object.isFrozen(result.note.structuredData)).toBe(true);
    }
  });

  it("toggles a list item with an inverse and deterministic projection", () => {
    const original = listNote();
    const result = applyNoteOperations(original, {
      expectedRevision: 1,
      operations: [{ type: "toggle_item_checked", itemId: ITEM_ID, checked: true }],
      now: LATER,
      idFactory: deterministicId
    });

    expect(result.note.currentRevision).toBe(2);
    expect(result.note.bodyMarkdown).toContain("- [x] milk");
    expect(result.note.isOpen).toBe(false);
    expect(result.revision.source).toBe("interactive");
    expect(result.mutation).toMatchObject({ beforeRevision: 1, afterRevision: 2 });
    expect(result.mutation.inverse).toEqual([
      expect.objectContaining({ type: "restore_snapshot", title: "Shopping" })
    ]);
    expect(original.bodyMarkdown).not.toContain("[x]");

    const reopened = applyNoteOperations(result.note, {
      expectedRevision: 2,
      operations: [{ type: "toggle_item_checked", itemId: ITEM_ID, checked: false }],
      now: LATER,
      idFactory: deterministicId
    });
    expect(reopened.note.isOpen).toBe(true);
  });

  it("applies title, body, privacy, move, archive, delete, tags, and links immutably", () => {
    const original = createInitialNote({
      id: NOTE_ID,
      userId: "00000000-0000-4000-8000-000000000001",
      title: "Draft",
      type: "generic",
      privacy: "ai_assisted",
      now: NOW
    }).note;
    const result = applyNoteOperations(original, {
      expectedRevision: 1,
      now: LATER,
      idFactory: deterministicId,
      operations: [
        { type: "set_title", title: "Final" },
        { type: "replace_body_markdown", bodyMarkdown: "Body" },
        { type: "set_privacy", privacy: "private_manual" },
        { type: "move_to_space", spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X" },
        { type: "set_archived", archivedAt: LATER },
        { type: "set_deleted", deletedAt: LATER },
        { type: "set_tags", tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"] },
        {
          type: "set_note_links",
          links: [
            {
              toNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
              linkType: "reference"
            }
          ]
        }
      ]
    });

    expect(result.note).toMatchObject({
      title: "Final",
      bodyMarkdown: "Body",
      privacy: "private_manual",
      spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      archivedAt: LATER,
      deletedAt: LATER,
      tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"]
    });
    expect(result.note.links).toHaveLength(1);
    expect(original).toMatchObject({ title: "Draft", archivedAt: null, deletedAt: null });
  });

  it("patches editable fields, relationships, and deduplicates tags", () => {
    const original = createInitialNote({
      id: NOTE_ID,
      userId: "00000000-0000-4000-8000-000000000001",
      title: "Draft",
      type: "generic",
      privacy: "ai_assisted",
      now: NOW
    }).note;
    const result = patchNote(original, {
      expectedRevision: 1,
      now: LATER,
      idFactory: deterministicId,
      title: "Published",
      bodyMarkdown: "A complete thought.",
      privacy: "private_manual",
      tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X", "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"],
      links: [
        {
          toNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
          linkType: "related"
        }
      ]
    });

    expect(result.note).toMatchObject({
      title: "Published",
      bodyMarkdown: "A complete thought.",
      privacy: "private_manual",
      tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"]
    });
    expect(result.note.links).toHaveLength(1);
    expect(() =>
      patchNote(original, {
        expectedRevision: 1,
        now: LATER,
        idFactory: deterministicId
      })
    ).toThrow(/validation_failed/u);
  });

  it("edits and removes list items while keeping canonical ordinals", () => {
    const original = createInitialNote({
      id: NOTE_ID,
      userId: "00000000-0000-4000-8000-000000000001",
      title: "Shopping",
      type: "list",
      privacy: "ai_assisted",
      now: NOW,
      structuredData: {
        schemaVersion: 1,
        items: [
          { id: ITEM_ID, text: "milk", checked: false, ordinal: 0, section: null },
          {
            id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
            text: "eggs",
            checked: false,
            ordinal: 1,
            section: null
          }
        ]
      }
    }).note;
    const result = applyNoteOperations(original, {
      expectedRevision: 1,
      operations: [
        { type: "edit_item_text", itemId: ITEM_ID, text: "oat milk" },
        {
          type: "remove_item",
          itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
        }
      ],
      now: LATER,
      idFactory: deterministicId
    });

    expect(result.note.bodyMarkdown).toBe("- [ ] oat milk");
    expect(result.note.structuredData).toMatchObject({
      items: [{ id: ITEM_ID, text: "oat milk", ordinal: 0 }]
    });
  });

  it("updates project checklist state, text, and removal by stable identity", () => {
    const result = applyNoteOperations(projectNote(), {
      expectedRevision: 1,
      operations: [
        { type: "toggle_item_checked", itemId: ITEM_ID, checked: true },
        { type: "edit_item_text", itemId: ITEM_ID, text: "Ship polished homepage" },
        {
          type: "remove_item",
          itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
        }
      ],
      now: LATER,
      idFactory: deterministicId
    });

    expect(result.note.bodyMarkdown).toBe("# Launch\n\n- [x] Ship polished homepage");
    expect(result.note.structuredData).toMatchObject({
      checklistItems: [{ id: ITEM_ID, text: "Ship polished homepage", checked: true }]
    });
    expect(result.note.isOpen).toBe(false);
  });

  it("updates flat log fields and keeps log Markdown canonical", () => {
    const original = logNote();
    const result = applyNoteOperations(original, {
      expectedRevision: 1,
      operations: [
        {
          type: "update_log_field",
          entryId: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
          fieldPath: ["reps"],
          value: 10
        }
      ],
      now: LATER,
      idFactory: deterministicId
    });

    expect(result.note.bodyMarkdown).toContain("- reps: 10");
    const unchanged = applyNoteOperations(original, {
      expectedRevision: 1,
      operations: [{ type: "replace_body_markdown", bodyMarkdown: original.bodyMarkdown }],
      now: LATER,
      idFactory: deterministicId
    });
    expect(unchanged.note.bodyMarkdown).toBe(original.bodyMarkdown);
  });

  it("fails closed for structurally incompatible list, project, log, and link edits", () => {
    expect(() =>
      applyNoteOperations(listNote(), {
        expectedRevision: 1,
        operations: [
          { type: "edit_item_text", itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1Y", text: "x" }
        ],
        now: LATER
      })
    ).toThrow(/structure_conflict/u);
    expect(() =>
      applyNoteOperations(projectNote(), {
        expectedRevision: 1,
        operations: [
          { type: "toggle_item_checked", itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1Z", checked: true }
        ],
        now: LATER
      })
    ).toThrow(/structure_conflict/u);
    expect(() =>
      applyNoteOperations(logNote(), {
        expectedRevision: 1,
        operations: [
          {
            type: "update_log_field",
            entryId: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            fieldPath: ["set", "reps"],
            value: 10
          }
        ],
        now: LATER
      })
    ).toThrow(/structure_conflict/u);
    expect(() =>
      applyNoteOperations(logNote(), {
        expectedRevision: 1,
        operations: [{ type: "replace_body_markdown", bodyMarkdown: "not canonical" }],
        now: LATER
      })
    ).toThrow(/structure_conflict/u);
    const link = {
      toNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const,
      linkType: "related" as const
    };
    expect(() =>
      applyNoteOperations(listNote(), {
        expectedRevision: 1,
        operations: [{ type: "set_note_links", links: [link, link] }],
        now: LATER
      })
    ).toThrow(/structure_conflict/u);
    expect(() =>
      applyNoteOperations(listNote(), {
        expectedRevision: 1,
        operations: [
          {
            type: "set_note_links",
            links: [{ toNoteId: NOTE_ID, linkType: "reference" }]
          }
        ],
        now: LATER
      })
    ).toThrow(/structure_conflict/u);
    expect(() =>
      createInitialNote({
        id: NOTE_ID,
        userId: "00000000-0000-4000-8000-000000000001",
        title: "Duplicate links",
        type: "generic",
        privacy: "ai_assisted",
        now: NOW,
        links: [link, link]
      })
    ).toThrow(/structure_conflict/u);
  });

  it("provides route-level immutable move/archive/delete/restore transitions", () => {
    const initial = createInitialNote({
      id: NOTE_ID,
      userId: "00000000-0000-4000-8000-000000000001",
      title: "Draft",
      type: "principle",
      privacy: "ai_assisted",
      now: NOW
    }).note;
    const moved = moveNote(initial, {
      expectedRevision: 1,
      spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      now: LATER,
      idFactory: deterministicId
    }).note;
    const archived = archiveNote(moved, {
      expectedRevision: 2,
      archived: true,
      now: LATER,
      idFactory: deterministicId
    }).note;
    const deleted = softDeleteNote(archived, {
      expectedRevision: 3,
      now: LATER,
      idFactory: deterministicId
    }).note;
    const restored = restoreDeletedNote(deleted, {
      expectedRevision: 4,
      now: LATER,
      idFactory: deterministicId
    }).note;

    expect(restored).toMatchObject({
      currentRevision: 5,
      spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      archivedAt: LATER,
      deletedAt: null
    });
    expect(initial.spaceId).toBeNull();
  });

  it("restores a complete historical snapshot as a new revision", () => {
    const originalResult = createInitialNote({
      id: NOTE_ID,
      userId: "00000000-0000-4000-8000-000000000001",
      title: "Original",
      type: "generic",
      privacy: "ai_assisted",
      now: NOW,
      bodyMarkdown: "Before"
    });
    const changed = applyNoteOperations(originalResult.note, {
      expectedRevision: 1,
      now: LATER,
      idFactory: deterministicId,
      operations: [
        { type: "set_title", title: "Changed" },
        { type: "replace_body_markdown", bodyMarkdown: "After" }
      ]
    }).note;
    const restored = restoreNoteRevision(changed, originalResult.revision, {
      expectedRevision: 2,
      now: LATER,
      idFactory: deterministicId
    });

    expect(restored.note).toMatchObject({ title: "Original", bodyMarkdown: "Before" });
    expect(restored.note.currentRevision).toBe(3);
    expect(restored.revision.revision).toBe(3);
  });

  it("undoes only when the mutation is still the latest compatible change", () => {
    const changed = applyNoteOperations(listNote(), {
      expectedRevision: 1,
      operations: [{ type: "toggle_item_checked", itemId: ITEM_ID, checked: true }],
      now: LATER,
      idFactory: deterministicId
    });
    const undone = undoNoteMutation(changed.note, changed.mutation, {
      expectedRevision: 2,
      now: LATER,
      idFactory: deterministicId
    });

    expect(undone.note.bodyMarkdown).toContain("- [ ] milk");
    expect(undone.note.currentRevision).toBe(3);
    expect(undone.revision.source).toBe("undo");
    expect(() =>
      undoNoteMutation({ ...changed.note, currentRevision: 3 }, changed.mutation, {
        expectedRevision: 3,
        now: LATER,
        idFactory: deterministicId
      })
    ).toThrow(/stale_revision/u);
  });

  it("rejects stale writes, incompatible toggles, and invalid content", () => {
    const note = listNote();
    expect(() =>
      applyNoteOperations(note, {
        expectedRevision: 2,
        operations: [{ type: "set_title", title: "Nope" }],
        now: LATER
      })
    ).toThrow(/stale_revision/u);
    expect(() =>
      applyNoteOperations(
        createInitialNote({
          id: NOTE_ID,
          userId: "00000000-0000-4000-8000-000000000001",
          title: "Plain",
          type: "generic",
          privacy: "ai_assisted",
          now: NOW
        }).note,
        {
          expectedRevision: 1,
          operations: [{ type: "toggle_item_checked", itemId: ITEM_ID, checked: true }],
          now: LATER
        }
      )
    ).toThrow(/structure_conflict/u);
    expect(() =>
      applyNoteOperations(note, {
        expectedRevision: 1,
        operations: [{ type: "replace_body_markdown", bodyMarkdown: "x".repeat(200_001) }],
        now: LATER
      })
    ).toThrow(/validation_failed/u);
  });
});
