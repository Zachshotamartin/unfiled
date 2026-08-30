import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { color, contrastRatio, motion, radius, spacing, typography } from "../src/index.js";

const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
const rootBody = /:root\s*\{(?<body>[\s\S]*?)\}/u.exec(css)?.groups?.body;

if (rootBody === undefined) throw new Error("tokens.css must contain a :root declaration");

const cssVariables = Object.fromEntries(
  [...rootBody.matchAll(/--(?<name>[\w-]+):\s*(?<value>[^;]+);/gu)].map((match) => {
    const name = match.groups?.name;
    const value = match.groups?.value;
    if (name === undefined || value === undefined) {
      throw new Error("Every design token must have a name and value");
    }
    return [name, value.trim()];
  })
);

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}

describe("Unfiled design tokens", () => {
  it("locks the selected brand palette", () => {
    expect(color.canvas).toBe("#0B0C0E");
    expect(color.accent).toBe("#EE6F55");
    expect(color.textPrimary).toBe("#F2EFE8");
  });

  it("meets AAA for primary reading text and AA for the accent", () => {
    expect(contrastRatio(color.textPrimary, color.canvas)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(color.accent, color.canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("meets the contrast gates for semantic text and status pairs", () => {
    const aaPairs = [
      [color.textSecondary, color.canvas],
      [color.textSecondary, color.surface],
      [color.danger, color.canvas],
      [color.danger, color.surface],
      [color.warning, color.canvas],
      [color.warning, color.surface],
      [color.accentContrast, color.accent],
      [color.accent, color.generatedSurface]
    ] as const;

    for (const [foreground, background] of aaPairs) {
      expect(
        contrastRatio(foreground, background),
        `${foreground} on ${background} must meet WCAG AA for normal text`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps JavaScript and CSS color tokens in parity", () => {
    for (const [name, value] of Object.entries(color)) {
      expect(cssVariables[`color-${kebabCase(name)}`]?.toLowerCase()).toBe(value.toLowerCase());
    }
  });

  it("keeps JavaScript and CSS radius tokens in parity", () => {
    for (const [name, value] of Object.entries(radius)) {
      expect(cssVariables[`radius-${kebabCase(name)}`]).toBe(`${value}px`);
    }
  });

  it("keeps JavaScript and CSS motion tokens in parity", () => {
    for (const [name, value] of Object.entries(motion.duration)) {
      expect(cssVariables[`motion-duration-${kebabCase(name)}`]).toBe(`${value}ms`);
    }
    expect(cssVariables["motion-easing-standard"]).toBe(
      `cubic-bezier(${motion.easing.standard.join(", ")})`
    );
  });

  it("exports the documented shape, spacing, motion, and type scales", () => {
    expect(radius.container).toBe(12);
    expect(spacing[4]).toBe(16);
    expect(motion.duration.receipt).toBe(250);
    expect(typography.body).toEqual({ fontSize: 16, lineHeight: 24, fontWeight: 400 });
  });
});
