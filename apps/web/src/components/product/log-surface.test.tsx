import { LogStructuredDataSchema, type LogEntry, type NoteDto } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LogSurface, noteWithUpdatedLogField, priorLogFieldValue } from "./log-surface";

const ENTRY_ONE = "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const ENTRY_TWO = "ent_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const ENTRY_OTHER = "ent_01J6M9Q7G4BMKB33GSG3NJ6D1Z";

const entries: LogEntry[] = [
  {
    id: ENTRY_ONE,
    occurredAt: "2026-08-30T18:00:00.000Z",
    fields: { exercise: "Bench", reps: 8, weight: 135 }
  },
  {
    id: ENTRY_OTHER,
    occurredAt: "2026-08-31T18:00:00.000Z",
    fields: { exercise: "Squat", reps: 5, weight: 225 }
  },
  {
    id: ENTRY_TWO,
    occurredAt: "2026-09-01T18:00:00.000Z",
    fields: { exercise: "bench", reps: 6, weight: 145 }
  }
];

const note: NoteDto = {
  id: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  spaceId: null,
  type: "log",
  title: "Workout log",
  bodyMarkdown: "",
  structuredData: { schemaVersion: 1, entries },
  currentRevision: 3,
  isOpen: true,
  pinnedAt: null,
  privacy: "ai_assisted",
  archivedAt: null,
  deletedAt: null,
  tagIds: [],
  links: [],
  createdAt: "2026-08-30T18:00:00.000Z",
  updatedAt: "2026-09-01T18:00:00.000Z"
};

describe("LogSurface", () => {
  it("uses the latest prior value only for the same exercise", () => {
    expect(priorLogFieldValue(entries, ENTRY_TWO, "weight")).toBe(135);
    expect(priorLogFieldValue(entries, ENTRY_TWO, "reps")).toBe(8);
    expect(priorLogFieldValue(entries, ENTRY_TWO, "exercise")).toBeUndefined();
    expect(priorLogFieldValue(entries, ENTRY_ONE, "weight")).toBeUndefined();
  });

  it("updates structured data and its deterministic Markdown projection together", () => {
    const updated = noteWithUpdatedLogField(note, {
      entryId: ENTRY_TWO,
      fieldKey: "weight",
      value: 155
    });
    const structured = LogStructuredDataSchema.parse(updated.structuredData);

    expect(structured.entries[2]?.fields.weight).toBe(155);
    expect(updated.bodyMarkdown).toContain("- weight: 155");
    expect(updated.bodyMarkdown).not.toContain("- weight: 145");
  });

  it("renders labeled text and numeric editors with separate 44px controls", () => {
    const html = renderToStaticMarkup(
      <LogSurface note={note} disabled={false} onUpdate={vi.fn()} />
    );

    expect(html).toContain('aria-labelledby="log-fields-heading"');
    expect(html).toContain('type="number"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('placeholder="135"');
    expect(html).toContain('aria-label="Decrease weight"');
    expect(html).toContain('aria-label="Increase weight"');
    expect(html).toContain('aria-label="Save weight"');
    expect(html).toContain('class="log-stepper"');
    expect(html).toContain('class="log-field-save"');
    expect(html).toContain("Previous 135");
  });

  it("renders a clear empty state for a valid empty log", () => {
    const html = renderToStaticMarkup(
      <LogSurface
        note={{ ...note, structuredData: { schemaVersion: 1, entries: [] } }}
        disabled={false}
        onUpdate={vi.fn()}
      />
    );

    expect(html).toContain("This log has no entries yet.");
    expect(html).toContain("0 entries");
  });
});
