import { describe, expect, it } from "vitest";

import {
  RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS,
  RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
} from "../src/index.js";

describe("encrypted generation verification capacity", () => {
  it("matches the fixed worst-case page and ciphertext bounds", () => {
    const maxPages = 33;
    const pageCiphertextByteBudget = 8_388_608;
    const maxDatabaseCiphertextBytesPerRow = 262_160;
    const guaranteedRowsPerPage = Math.floor(
      pageCiphertextByteBudget / maxDatabaseCiphertextBytesPerRow
    );

    expect(guaranteedRowsPerPage).toBe(31);
    expect(maxPages * guaranteedRowsPerPage).toBe(1_023);
    expect(RAG_GENERATION_VERIFICATION_NOTE_CAPACITY).toBe(1_000);
    expect(maxPages * guaranteedRowsPerPage).toBeGreaterThanOrEqual(
      RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
    );
    expect(RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS).toBe(4);
  });
});
