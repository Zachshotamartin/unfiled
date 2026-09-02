import { describe, expect, it } from "vitest";

import {
  createLocalHashEmbedding,
  LOCAL_HASH_EMBEDDING_DIMENSIONS,
  LOCAL_HASH_EMBEDDING_MODEL_ID,
  LocalHashEmbeddingError,
  MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES
} from "../src/index.js";

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

describe("provider-free local hash embeddings", () => {
  it("publishes a stable, explicitly non-provider model profile", () => {
    expect(LOCAL_HASH_EMBEDDING_MODEL_ID).toBe("unfiled-local-hash-v1");
    expect(LOCAL_HASH_EMBEDDING_DIMENSIONS).toBe(512);
  });

  it("is deterministic, normalization-stable, finite, and unit length", () => {
    const first = createLocalHashEmbedding("  SHOPPING\nMilk and Oatmeal  ");
    const second = createLocalHashEmbedding("shopping milk and oatmeal");
    expect(first).toEqual(second);
    expect(first).toHaveLength(LOCAL_HASH_EMBEDDING_DIMENSIONS);
    expect([...first].every(Number.isFinite)).toBe(true);
    const norm = Math.sqrt([...first].reduce((sum, component) => sum + component ** 2, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("ranks shared vocabulary above unrelated text without an external request", () => {
    const query = createLocalHashEmbedding("shopping list oatmeal and blueberries");
    const related = createLocalHashEmbedding("groceries: blueberries, oatmeal, bananas");
    const unrelated = createLocalHashEmbedding("bench press workout sets and repetitions");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("rejects empty, nul-containing, and oversized inputs", () => {
    for (const value of [
      "  \n\t ",
      "valid\0hidden",
      "x".repeat(MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES + 1)
    ]) {
      expect(() => createLocalHashEmbedding(value)).toThrow(LocalHashEmbeddingError);
    }
  });
});
