import { describe, expect, it } from "vitest";

import { embeddingAllowed, rankSearchResult } from "../src/index.js";

describe("search ranking", () => {
  it("uses the documented weighted formula and pinned boost", () => {
    const score = rankSearchResult({
      fullText: 1,
      trigram: 1,
      vector: 1,
      recency: 1,
      titleExact: 1,
      pinned: true,
      privateManual: false
    });
    expect(score).toBe(1);
  });

  it("excludes vector influence for private notes", () => {
    expect(embeddingAllowed(true)).toBe(false);
    expect(
      rankSearchResult({
        fullText: 0,
        trigram: 0,
        vector: 1,
        recency: 0,
        titleExact: 0,
        pinned: false,
        privateManual: true
      })
    ).toBe(0);
  });
});
