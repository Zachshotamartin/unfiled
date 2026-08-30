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
  it("keeps remaining items visible and collapses checked items into Completed", () => {
    const html = renderToStaticMarkup(
      <ChecklistSurface note={note} disabled={false} onToggle={vi.fn()} />
    );

    expect(html).toContain('aria-label="Remaining items"');
    expect(html).toContain('<details class="completed-group">');
    expect(html).toContain("Completed");
    expect(html.indexOf("charger")).toBeLessThan(html.indexOf("completed-group"));
    expect(html.indexOf("passport")).toBeGreaterThan(html.indexOf("completed-group"));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="passport, checked"');
  });
});
