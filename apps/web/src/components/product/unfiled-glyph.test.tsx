import { readdirSync, readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UnfiledGlyph, type UnfiledGlyphName } from "./unfiled-glyph";

const EVERY_GLYPH: readonly UnfiledGlyphName[] = [
  "archive",
  "arrow",
  "back",
  "bullets",
  "camera",
  "card",
  "check",
  "checkCircle",
  "checklist",
  "chevron",
  "clock",
  "close",
  "down",
  "heading",
  "inbox",
  "info",
  "library",
  "link",
  "lock",
  "microphone",
  "minus",
  "more",
  "move",
  "pen",
  "photo",
  "plus",
  "quote",
  "review",
  "search",
  "send",
  "sliders",
  "trash",
  "tray",
  "undo",
  "up",
  "warning"
];

describe("UnfiledGlyph", () => {
  it("draws every glyph with square caps, the app's own hand", () => {
    for (const glyph of EVERY_GLYPH) {
      const html = renderToStaticMarkup(<UnfiledGlyph glyph={glyph} />);
      expect(html, glyph).toContain('viewBox="0 0 24 24"');
      expect(html, glyph).toContain(`data-glyph="${glyph}"`);
      expect(html, glyph).toMatch(/<(?:path|rect|circle)\b/u);
      if (html.includes("stroke-linecap")) {
        expect(html, glyph).toContain('stroke-linecap="square"');
      }
    }
  });

  it("tilts a card 14 degrees, like the mark's card", () => {
    const html = renderToStaticMarkup(<UnfiledGlyph glyph="card" />);

    expect(html).toContain("rotate(14 12 12)");
  });

  it("carries the mark's tray and its card in the Inbox glyph", () => {
    const html = renderToStaticMarkup(<UnfiledGlyph glyph="inbox" />);

    expect(html).toContain("Q 19.5 19.5 19.5");
    expect(html).toContain('fill="currentColor"');
  });

  it("is hidden from assistive technology, since a glyph always sits beside its label", () => {
    expect(renderToStaticMarkup(<UnfiledGlyph glyph="tray" />)).toContain('aria-hidden="true"');
  });

  it("leaves no stock icon set on the product surface", () => {
    // ADR-0019, decision 4: no system symbols on the main screens; every icon is a tray, a card,
    // or a stroke in the same hand.
    const directory = new URL(".", import.meta.url);
    const stockIconPackage = ["@phosphor-icons", "react"].join("/");
    const offenders = readdirSync(directory)
      .filter((entry) => entry.endsWith(".tsx") || entry.endsWith(".ts"))
      .filter((entry) =>
        readFileSync(new URL(entry, directory), "utf8").includes(stockIconPackage)
      );

    expect(offenders).toEqual([]);
  });
});
