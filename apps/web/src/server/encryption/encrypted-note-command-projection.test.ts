import { describe, expect, it } from "vitest";

import {
  encryptedOnlyMutationProjection,
  encryptedOnlyNoteState,
  encryptedOnlyStructuredData
} from "./encrypted-note-command-projection";

const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;

describe("encrypted-only note command projection", () => {
  it.each([
    ["generic", { schemaVersion: 1 }],
    ["principle", { schemaVersion: 1 }],
    ["list", { schemaVersion: 1, items: [] }],
    ["log", { schemaVersion: 1, entries: [] }],
    ["project", { schemaVersion: 1, checklistItems: [] }]
  ] as const)("uses a type-valid empty %s projection", (type, expected) => {
    expect(encryptedOnlyStructuredData(type)).toEqual(expected);
  });

  it("preserves operational metadata while removing every authored content field", () => {
    const canaryTitle = "CUTOVER_TITLE_CANARY_7d30";
    const canaryBody = "CUTOVER_BODY_CANARY_41b9";
    const projected = encryptedOnlyNoteState(NOTE, {
      spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      type: "list",
      title: canaryTitle,
      bodyMarkdown: canaryBody,
      structuredData: {
        schemaVersion: 1,
        items: [
          {
            id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            text: "CUTOVER_ITEM_CANARY_fcd2",
            checked: false,
            ordinal: 0,
            section: null
          }
        ]
      },
      dailyDate: "2026-08-31",
      isOpen: false,
      privacy: "private_manual",
      pinnedAt: "2026-08-31T18:00:00.000+00:00",
      archivedAt: null,
      deletedAt: null,
      tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"],
      links: [
        {
          toNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
          linkType: "related"
        }
      ]
    });

    expect(projected).toMatchObject({
      spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      type: "list",
      title: `e-${NOTE.toLowerCase()}`,
      bodyMarkdown: "",
      structuredData: { schemaVersion: 1, items: [] },
      dailyDate: "2026-08-31",
      isOpen: false,
      privacy: "private_manual",
      tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"]
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(canaryTitle);
    expect(serialized).not.toContain(canaryBody);
    expect(serialized).not.toContain("CUTOVER_ITEM_CANARY_fcd2");
  });

  it("replaces operations and inverses with one deterministic metadata-only shape", () => {
    expect(encryptedOnlyMutationProjection("private_manual")).toEqual({
      operations: [{ type: "set_privacy", privacy: "private_manual" }],
      inverse: [{ type: "set_privacy", privacy: "private_manual" }]
    });
  });
});
