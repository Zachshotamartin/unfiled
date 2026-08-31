import type { NoteContentPayload } from "@unfiled/encrypted-aggregate";
import { describe, expect, it } from "vitest";

import { prepareIndexText, truncateUtf8 } from "../src/index-text";

function note(overrides: Partial<NoteContentPayload> = {}): NoteContentPayload {
  return {
    bodyMarkdown: "# Groceries\nMilk and eggs\n## Next week\nCoffee",
    schemaVersion: 1,
    structuredData: {},
    title: "Shopping",
    ...overrides
  } as NoteContentPayload;
}

describe("private index text preparation", () => {
  it("derives bounded headings, snippet, searchable text, and provider text", () => {
    const prepared = prepareIndexText(note(), 32);

    expect(prepared.headings).toEqual(["Groceries", "Next week"]);
    expect(prepared.latestSnippet).toBe("# Groceries Milk and eggs ## Next week Coffee");
    expect(new TextEncoder().encode(prepared.providerText).byteLength).toBeLessThanOrEqual(32);
    expect(prepared.searchableText).toContain("Shopping");
    expect(Object.isFrozen(prepared.headings)).toBe(true);
  });

  it("does not split multibyte Unicode while truncating", () => {
    expect(truncateUtf8("a🗂️b", 5)).toBe("a🗂");
    expect(
      new TextEncoder().encode(truncateUtf8("🗂️".repeat(100), 17)).byteLength
    ).toBeLessThanOrEqual(17);
  });

  it("caps heading count and display lengths", () => {
    const body = Array.from(
      { length: 100 },
      (_value, index) => `# ${index}-${"x".repeat(250)}`
    ).join("\n");
    const prepared = prepareIndexText(note({ bodyMarkdown: body }), 128);
    expect(prepared.headings).toHaveLength(64);
    expect(prepared.headings.every((heading) => heading.length <= 200)).toBe(true);
    expect(prepared.latestSnippet.length).toBeLessThanOrEqual(200);
  });

  it("rejects unsafe budgets and an empty semantic document", () => {
    expect(() => prepareIndexText(note(), 0)).toThrow("budget");
    expect(() => prepareIndexText(note(), 190_001)).toThrow("budget");
    expect(() => prepareIndexText(note({ bodyMarkdown: "", title: " " }), 20)).toThrow("empty");
  });
});
