import type { NoteDto } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChecklistSurface } from "./checklist-surface";

const note: NoteDto = {
  id: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  spaceId: null,
  type: "list",
  title: "Packing",
  bodyMarkdown: "- [ ] charger\n- [x] passport",
  structuredData: {
    schemaVersion: 1,
    items: [
      {
        id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        text: "charger",
        checked: false,
        ordinal: 0,
        section: null
      },
      {
        id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
        text: "passport",
        checked: true,
        ordinal: 1,
        section: null
      }
    ]
  },
  currentRevision: 2,
  isOpen: true,
  pinnedAt: null,
  privacy: "ai_assisted",
  archivedAt: null,
  deletedAt: null,
  tagIds: [],
  links: [],
  createdAt: "2026-08-30T18:00:00.000Z",
  updatedAt: "2026-08-30T18:01:00.000Z"
};

describe("ChecklistSurface", () => {
  it("keeps every item in place, in order, under one heading with a count", () => {
    const html = renderToStaticMarkup(
      <ChecklistSurface note={note} disabled={false} onToggle={vi.fn()} />
    );

    // Items check off where they are; nothing moves to a Completed group (ADR-0019, decision 8).
    expect(html).toContain('aria-label="Checklist items"');
    expect(html).not.toContain("completed-group");
    expect(html).not.toContain("Remaining items");
    expect(html).toContain(">Checklist<");
    expect(html).toContain("1 of 2");
    expect(html).toContain("charger");
    expect(html).toContain("passport");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="passport, checked"');
  });
});
