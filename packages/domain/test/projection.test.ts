import type { EntityId, EntityKind } from "@unfiled/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  listView,
  reconcileListMarkdown,
  reconcileLogMarkdown,
  reconcileProjectChecklist,
  renderListMarkdown,
  renderLogMarkdown,
  updateProjectChecklistLine
} from "../src/index.js";

const ITEM_A = "itm_01J6M9Q7G4BMKB33GSG3NJ6D1A" as const;
const ITEM_B = "itm_01J6M9Q7G4BMKB33GSG3NJ6D1B" as const;
const ITEM_C = "itm_01J6M9Q7G4BMKB33GSG3NJ6D1C" as const;
const ENTRY_A = "ent_01J6M9Q7G4BMKB33GSG3NJ6D1A" as const;
const ENTRY_B = "ent_01J6M9Q7G4BMKB33GSG3NJ6D1B" as const;
const ENTRY_C = "ent_01J6M9Q7G4BMKB33GSG3NJ6D1C" as const;

function nextItemId<K extends EntityKind>(kind: K): EntityId<K> {
  if (kind !== "itm") throw new Error(`Unexpected ${kind} request`);
  return ITEM_B as EntityId<K>;
}

function nextEntryId<K extends EntityKind>(kind: K): EntityId<K> {
  if (kind !== "ent") throw new Error(`Unexpected ${kind} request`);
  return ENTRY_C as EntityId<K>;
}

function propertyItemId(ordinal: number): EntityId<"itm"> {
  return `itm_${String(ordinal).padStart(26, "0")}`;
}

function propertyEntryId(ordinal: number): EntityId<"ent"> {
  return `ent_${String(ordinal).padStart(26, "0")}`;
}

describe("structured Markdown projections", () => {
  it("renders list bytes deterministically with checked items in place", () => {
    const data = {
      schemaVersion: 1 as const,
      items: [
        { id: ITEM_B, text: "eggs", checked: true, ordinal: 1, section: null },
        { id: ITEM_A, text: "milk", checked: false, ordinal: 0, section: null }
      ]
    };
    expect(renderListMarkdown(data)).toBe("- [ ] milk\n- [x] eggs");
    expect(listView(data)).toMatchObject({ remainingCount: 1 });
    expect(listView(data).openItems.map(({ text }) => text)).toEqual(["milk"]);
    expect(listView(data).completedItems.map(({ text }) => text)).toEqual(["eggs"]);
  });

  it("renders sectioned and empty lists without unstable separators", () => {
    expect(renderListMarkdown({ schemaVersion: 1, items: [] })).toBe("");
    expect(
      renderListMarkdown({
        schemaVersion: 1,
        items: [
          { id: ITEM_A, text: "milk", checked: false, ordinal: 0, section: "Market" },
          { id: ITEM_B, text: "eggs", checked: false, ordinal: 1, section: null }
        ]
      })
    ).toBe("- [ ] eggs\n\n## Market\n\n- [ ] milk");
  });

  it("keeps each section's items in order with their checks in place", () => {
    expect(
      renderListMarkdown({
        schemaVersion: 1,
        items: [
          { id: ITEM_A, text: "eggs", checked: true, ordinal: 0, section: "Dairy" },
          { id: ITEM_B, text: "bread", checked: false, ordinal: 1, section: null },
          { id: ITEM_C, text: "milk", checked: false, ordinal: 2, section: "Dairy" }
        ]
      })
    ).toBe("- [ ] bread\n\n## Dairy\n\n- [x] eggs\n- [ ] milk");
  });

  it("reads a legacy Completed heading as no section and never renders it back", () => {
    const previous = {
      schemaVersion: 1 as const,
      items: [{ id: ITEM_A, text: "milk", checked: false, ordinal: 0, section: null }]
    };
    const reconciled = reconcileListMarkdown(
      previous,
      "- [ ] milk\n\n## Completed\n\n- [x] eggs",
      nextItemId
    );
    expect(reconciled.items.map(({ text, checked, section }) => ({ text, checked, section }))).toEqual([
      { text: "milk", checked: false, section: null },
      { text: "eggs", checked: true, section: null }
    ]);
    expect(renderListMarkdown(reconciled)).toBe("- [ ] milk\n- [x] eggs");
  });

  it("renders log fields in stable order without locale-dependent output", () => {
    const data = {
      schemaVersion: 1 as const,
      entries: [
        {
          id: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const,
          occurredAt: "2026-08-30T18:30:00.000Z",
          fields: { weight: 135, exercise: "Bench", reps: 8 }
        }
      ]
    };
    expect(renderLogMarkdown(data)).toBe(
      "## 2026-08-30T18:30:00.000Z\n\n- exercise: Bench\n- reps: 8\n- weight: 135"
    );
    expect(renderLogMarkdown({ ...data, entries: [...data.entries] })).toBe(
      renderLogMarkdown(data)
    );
  });

  it("sorts log entries by timestamp and id and renders null values", () => {
    expect(
      renderLogMarkdown({
        schemaVersion: 1,
        entries: [
          {
            id: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
            occurredAt: "2026-08-30T18:31:00.000Z",
            fields: {}
          },
          {
            id: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            occurredAt: "2026-08-30T18:30:00.000Z",
            fields: { note: null }
          }
        ]
      })
    ).toBe("## 2026-08-30T18:30:00.000Z\n\n- note: null\n\n## 2026-08-30T18:31:00.000Z\n");
  });

  it("preserves list item identity across checked-state edits", () => {
    const previous = {
      schemaVersion: 1 as const,
      items: [{ id: ITEM_A, text: "milk", checked: false, ordinal: 0, section: null }]
    };
    const reconciled = reconcileListMarkdown(previous, "- [x] milk", nextItemId);
    expect(reconciled.items).toEqual([
      { id: ITEM_A, text: "milk", checked: true, ordinal: 0, section: null }
    ]);
  });

  it("reconciles plain bullets and rejects missing or duplicate stable identities", () => {
    const previous = {
      schemaVersion: 1 as const,
      items: [{ id: ITEM_A, text: "milk", checked: false, ordinal: 0, section: null }]
    };
    expect(reconcileListMarkdown(previous, "* milk", nextItemId).items[0]).toMatchObject({
      id: ITEM_A,
      checked: false
    });
    expect(() => reconcileListMarkdown(previous, "just prose", nextItemId)).toThrow(
      /structure_conflict/u
    );
    expect(() =>
      reconcileListMarkdown(
        {
          schemaVersion: 1,
          items: [
            ...previous.items,
            { id: ITEM_B, text: " MILK ", checked: true, ordinal: 1, section: null }
          ]
        },
        "- milk",
        nextItemId
      )
    ).toThrow(/structure_conflict/u);
    expect(() => reconcileListMarkdown(previous, "- milk\n- MILK", nextItemId)).toThrow(
      /structure_conflict/u
    );
    expect(() =>
      reconcileListMarkdown(previous, "- milk\nthis prose is not a list item", nextItemId)
    ).toThrow(/structure_conflict/u);
  });

  it("accepts indented H2-H6 list sections and uses ordinal identity only as fallback", () => {
    const previous = {
      schemaVersion: 1 as const,
      items: [
        { id: ITEM_A, text: "old first", checked: false, ordinal: 0, section: null },
        { id: ITEM_B, text: "keep me", checked: false, ordinal: 1, section: null }
      ]
    };
    expect(
      reconcileListMarkdown(
        previous,
        "  ### Market  \n\n+ renamed first\n* [X] keep me",
        nextItemId
      )
    ).toEqual({
      schemaVersion: 1,
      items: [
        { id: ITEM_A, text: "renamed first", checked: false, ordinal: 0, section: "Market" },
        { id: ITEM_B, text: "keep me", checked: true, ordinal: 1, section: "Market" }
      ]
    });
  });

  it("preserves project checklist identity across reordering and adds only new IDs", () => {
    const previous = [
      { id: ITEM_A, text: "Ship homepage", checked: false, ordinal: 0, lineIndex: 2 }
    ];
    const markdown = "# Launch\n\n- [x] Ship homepage\n- [ ] Write notes";
    const reconciled = reconcileProjectChecklist(previous, markdown, nextItemId);

    expect(reconciled).toEqual([
      { id: ITEM_A, text: "Ship homepage", checked: true, ordinal: 0, lineIndex: 2 },
      { id: ITEM_B, text: "Write notes", checked: false, ordinal: 1, lineIndex: 3 }
    ]);
  });

  it("fails closed when duplicate checklist text makes identity ambiguous", () => {
    expect(() =>
      reconcileProjectChecklist([], "- [ ] same thing\n- [ ] same thing", nextItemId)
    ).toThrow(/structure_conflict/u);
  });

  it("updates and removes a project line only when its stable index still matches", () => {
    const item = {
      id: ITEM_A,
      text: "Ship homepage",
      checked: false,
      ordinal: 0,
      lineIndex: 1
    };
    const markdown = "# Launch\n- [ ] Ship homepage";
    expect(updateProjectChecklistLine(markdown, item, { checked: true, text: "Ship it" })).toBe(
      "# Launch\n- [x] Ship it"
    );
    expect(updateProjectChecklistLine(markdown, item, { remove: true })).toBe("# Launch");
    expect(() =>
      updateProjectChecklistLine("# Launch\n- [ ] Changed elsewhere", item, { checked: true })
    ).toThrow(/structure_conflict/u);
    expect(() => updateProjectChecklistLine("# Launch", item, { checked: true })).toThrow(
      /structure_conflict/u
    );
  });

  it("preserves project marker, indentation, spacing, and trailing bytes on toggle", () => {
    const item = {
      id: ITEM_A,
      text: "Ship homepage",
      checked: false,
      ordinal: 0,
      lineIndex: 1
    };
    const markdown = "Context\n\t*   [ ]   Ship homepage   ";
    expect(updateProjectChecklistLine(markdown, item, { checked: true })).toBe(
      "Context\n\t*   [x]   Ship homepage   "
    );
    expect(updateProjectChecklistLine(markdown, item, { text: "Ship it" })).toBe(
      "Context\n\t*   [ ]   Ship it"
    );
  });

  it("uses the project line as a stable fallback when text changes", () => {
    const previous = [
      { id: ITEM_A, text: "Old wording", checked: false, ordinal: 0, lineIndex: 0 }
    ];
    expect(reconcileProjectChecklist(previous, "- [ ] New wording", nextItemId)).toEqual([
      { id: ITEM_A, text: "New wording", checked: false, ordinal: 0, lineIndex: 0 }
    ]);
    expect(() =>
      reconcileProjectChecklist(
        [
          ...previous,
          { id: ITEM_B, text: " old wording ", checked: true, ordinal: 1, lineIndex: 1 }
        ],
        "- [ ] new",
        nextItemId
      )
    ).toThrow(/structure_conflict/u);
  });

  it("is byte-deterministic across equivalent list array instances", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 30 })
            .filter((text) => text.trim().length > 0 && !/[\r\n]/u.test(text)),
          { maxLength: 20 }
        ),
        (texts) => {
          const items = texts.map((text, ordinal) => ({
            id: propertyItemId(ordinal),
            text,
            checked: ordinal % 2 === 0,
            ordinal,
            section: null
          }));
          expect(renderListMarkdown({ schemaVersion: 1, items })).toBe(
            renderListMarkdown({ schemaVersion: 1, items: items.map((item) => ({ ...item })) })
          );
        }
      )
    );
  });

  it("quotes ambiguous log strings and parses every canonical value losslessly", () => {
    const data = {
      schemaVersion: 1 as const,
      entries: [
        {
          id: ENTRY_A,
          occurredAt: "2026-08-30T18:30:00.000Z",
          fields: {
            empty: "",
            multiline: "line one\nline two",
            nullValue: null,
            numeric: 42,
            numericString: "42",
            padded: " padded ",
            quoteLeading: '"hello',
            word: "Bench"
          }
        }
      ]
    };
    const markdown = [
      "## 2026-08-30T18:30:00.000Z",
      "",
      "- empty: ",
      '- multiline: "line one\\nline two"',
      "- nullValue: null",
      "- numeric: 42",
      '- numericString: "42"',
      '- padded: " padded "',
      '- quoteLeading: "\\"hello"',
      "- word: Bench"
    ].join("\n");

    expect(renderLogMarkdown(data)).toBe(markdown);
    expect(reconcileLogMarkdown(data, markdown, nextEntryId)).toEqual(data);
  });

  it("reconciles duplicate log timestamps by prior ID order and allocates on timestamp edits", () => {
    const occurredAt = "2026-08-30T18:30:00.000Z";
    const previous = {
      schemaVersion: 1 as const,
      entries: [
        { id: ENTRY_B, occurredAt, fields: { set: "second" } },
        { id: ENTRY_A, occurredAt, fields: { set: "first" } }
      ]
    };
    const sameTime = [
      `## ${occurredAt}`,
      "",
      "- set: updated first",
      "",
      `## ${occurredAt}`,
      "",
      "- set: updated second"
    ].join("\n");
    expect(reconcileLogMarkdown(previous, sameTime, nextEntryId)).toEqual({
      schemaVersion: 1,
      entries: [
        { id: ENTRY_A, occurredAt, fields: { set: "updated first" } },
        { id: ENTRY_B, occurredAt, fields: { set: "updated second" } }
      ]
    });

    const movedTime = "## 2026-08-30T19:30:00+01:00\n\n- set: moved";
    expect(reconcileLogMarkdown(previous, movedTime, nextEntryId).entries[0]).toMatchObject({
      id: ENTRY_C,
      occurredAt: "2026-08-30T19:30:00+01:00",
      fields: { set: "moved" }
    });
  });

  it("renders every finite JavaScript number in the shared decimal grammar", () => {
    const data = {
      schemaVersion: 1 as const,
      entries: [
        {
          id: ENTRY_A,
          occurredAt: "2026-08-30T18:30:00.000Z",
          fields: { large: 1e21, smallest: Number.MIN_VALUE, small: 1e-7 }
        }
      ]
    };
    const markdown = renderLogMarkdown(data);
    expect(markdown).toContain("- large: 1000000000000000000000");
    expect(markdown).toContain(`- smallest: 0.${"0".repeat(323)}5`);
    expect(markdown).toContain("- small: 0.0000001");
    expect(reconcileLogMarkdown(data, markdown, nextEntryId)).toEqual(data);
  });

  it("fails closed for mixed log prose, fields before headings, and duplicate keys", () => {
    const empty = { schemaVersion: 1 as const, entries: [] };
    for (const markdown of [
      "plain prose",
      "- reps: 8",
      "## 2026-08-30T18:30:00.000Z\n- reps: 8\nunknown",
      "## 2026-08-30T18:30:00.000Z\n- reps: 8\n- reps: 9",
      "## not-a-time\n- reps: 8"
    ]) {
      expect(() => reconcileLogMarkdown(empty, markdown, nextEntryId)).toThrow(
        /structure_conflict/u
      );
    }
  });

  it("round-trips deterministic log projections under generated structured data", () => {
    const safeKey = fc
      .stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,20}$/u)
      .filter((key) => key === key.trim());
    const fieldValue = fc.oneof(
      fc.constant(null),
      fc.double({ noDefaultInfinity: true, noNaN: true }).filter((value) => !Object.is(value, -0)),
      fc.string({ maxLength: 40 })
    );
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            fields: fc.dictionary(safeKey, fieldValue, { maxKeys: 8 }),
            occurredAt: fc.constantFrom("2026-08-30T18:30:00.000Z", "2026-08-30T19:30:00+01:00")
          }),
          { maxLength: 20 }
        ),
        (entries) => {
          const data = {
            schemaVersion: 1 as const,
            entries: entries.map((entry, ordinal) => ({
              ...entry,
              id: propertyEntryId(ordinal)
            }))
          };
          const expected = {
            ...data,
            entries: [...data.entries].sort(
              (left, right) =>
                left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)
            )
          };
          const reconciled = reconcileLogMarkdown(data, renderLogMarkdown(data), () => {
            throw new Error("Canonical log round-trip unexpectedly allocated an ID");
          });
          expect(reconciled).toEqual(expected);
          expect(renderLogMarkdown(reconciled)).toBe(renderLogMarkdown(data));
        }
      )
    );
  });
});
