import { readdirSync, readFileSync } from "node:fs";

import { contrastRatio } from "@unfiled/design-tokens";
import { describe, expect, it } from "vitest";

const stylesheets = new URL("../../app/", import.meta.url);

function css(name: string): string {
  return readFileSync(new URL(name, stylesheets), "utf8");
}

const paper = css("paper.css");

function token(name: string): string {
  const value = new RegExp(`--${name}:\\s*(?<value>[^;]+);`, "u").exec(paper)?.groups?.value;
  if (value === undefined) throw new Error(`paper.css must define --${name}`);
  return value.trim();
}

const everyStylesheet = readdirSync(stylesheets)
  .filter((entry) => entry.endsWith(".css"))
  .map((entry) => [entry, css(entry)] as const);

describe("the Paper direction on the web", () => {
  it("uses the same ground, ink, and one accent the iPhone app draws", () => {
    // ADR-0019, decision 1. These are `UnfiledTheme.ink`, `.paper`, `.fog`, `.border`,
    // `.graphite`, `.raised` and `.persimmon` in hexadecimal.
    expect(token("color-canvas")).toBe("#f3f4f6");
    expect(token("color-text-primary")).toBe("#14171b");
    expect(token("color-text-secondary")).toBe("#626b76");
    expect(token("color-border")).toBe("#dde1e6");
    expect(token("color-surface")).toBe("#ffffff");
    expect(token("color-surface-raised")).toBe("#e6e8ec");
    expect(token("color-accent")).toBe("#1e6b57");
  });

  it("has no black ground anywhere", () => {
    for (const [name, source] of everyStylesheet) {
      // The retired direction's near-black canvas and its coral accent.
      expect(source.toLowerCase(), name).not.toContain("#0b0c0e");
      expect(source.toLowerCase(), name).not.toContain("#ee6f55");
      expect(source.toLowerCase(), name).not.toContain("rgb(11 12 14");
    }
    expect(paper).toContain("color-scheme: light");
  });

  it("keeps reading text and the accent legible on the light ground", () => {
    expect(
      contrastRatio(token("color-text-primary"), token("color-canvas"))
    ).toBeGreaterThanOrEqual(7);
    for (const foreground of [
      "color-text-secondary",
      "color-accent",
      "color-danger",
      "color-warning"
    ]) {
      expect(
        contrastRatio(token(foreground), token("color-canvas")),
        `${foreground} on the ground`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(token(foreground), token("color-surface")),
        `${foreground} on a surface`
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      contrastRatio(token("color-accent-contrast"), token("color-accent"))
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("sets titles and the owner's own words in the serif, and controls in the sans", () => {
    // ADR-0019, decision 2: screen titles and everything the user wrote read in the serif.
    expect(token("font-paper-serif")).toContain("ui-serif");
    for (const rule of [".page-heading h1", ".editor-title", ".markdown-preview"]) {
      const body = new RegExp(`\\${rule} \\{(?<body>[^}]*)\\}`, "u").exec(css("globals-core.css"))
        ?.groups?.body;
      expect(body, rule).toContain("var(--font-paper-serif)");
    }
  });

  it("keeps monospace for literal codes only", () => {
    // ADR-0019, decision 2: no monospace except literal codes such as deletion receipts.
    const monospaceRules = everyStylesheet.flatMap(([, source]) =>
      [
        ...source.matchAll(
          /(?<selector>[^{}]+)\{(?<body>[^}]*font-family: var\(--font-geist-mono\)[^}]*)\}/gu
        )
      ].map((match) => (match.groups?.selector ?? "").replace(/\/\*[\s\S]*?\*\//gu, "").trim())
    );

    expect(monospaceRules).toEqual([".auth-code", ".markdown-preview code"]);
  });

  it("names its spacing instead of repeating numbers per screen", () => {
    // ADR-0019, decision 10.
    for (const name of [
      "space-screen-padding",
      "space-section-top",
      "space-row-vertical",
      "space-card-padding",
      "size-touch-target"
    ]) {
      expect(() => token(name)).not.toThrow();
    }
  });
});
