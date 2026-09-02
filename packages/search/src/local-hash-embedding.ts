import { normalizePrivateRagText } from "./private-rag-payload.js";

/**
 * Provider-free retrieval profile used by the zero-cost private beta.
 *
 * This is intentionally named as a lexical hash, not an AI embedding.  A
 * generation carrying this model ID must never be presented as semantic
 * search evidence.  The vector is still useful inside the existing encrypted
 * hybrid index because shared words, adjacent-word pairs, and character
 * trigrams land in the same signed buckets without disclosing note text to an
 * external provider.
 */
export const LOCAL_HASH_EMBEDDING_MODEL_ID = "unfiled-local-hash-v1" as const;
export const LOCAL_HASH_EMBEDDING_DIMENSIONS = 512 as const;
export const MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES = 64 * 1_024;

const MAX_TOKEN_CHARACTERS = 64;
const MAX_FEATURES = 24_000;
const textEncoder = new TextEncoder();

export class LocalHashEmbeddingError extends Error {
  public constructor() {
    super("local_hash_embedding_invalid_input");
    this.name = "LocalHashEmbeddingError";
  }
}

function hash(value: string, seed: number): number {
  let result = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result;
}

function addFeature(vector: Float64Array, feature: string, weight: number): void {
  const bucket = hash(feature, 0x811c9dc5) % vector.length;
  const sign = (hash(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
  const previous = vector[bucket];
  if (previous === undefined) throw new LocalHashEmbeddingError();
  vector[bucket] = previous + sign * weight;
}

function words(value: string): readonly string[] {
  const result: string[] = [];
  for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (token.length === 0) continue;
    result.push(Array.from(token).slice(0, MAX_TOKEN_CHARACTERS).join(""));
    if (result.length >= MAX_FEATURES) break;
  }
  return result;
}

function addCharacterTrigrams(vector: Float64Array, value: string, budget: number): number {
  if (budget <= 0) return 0;
  const characters = Array.from(` ${value} `);
  if (characters.length <= 3) {
    addFeature(vector, `c:${characters.join("")}`, 0.22);
    return 1;
  }
  let added = 0;
  for (let index = 0; index <= characters.length - 3 && added < budget; index += 1) {
    addFeature(vector, `c:${characters.slice(index, index + 3).join("")}`, 0.22);
    added += 1;
  }
  return added;
}

function normalize(vector: Float64Array): Float32Array {
  let squaredNorm = 0;
  for (const value of vector) {
    squaredNorm += value * value;
    if (!Number.isFinite(squaredNorm)) throw new LocalHashEmbeddingError();
  }
  if (squaredNorm <= 0) throw new LocalHashEmbeddingError();
  const divisor = Math.sqrt(squaredNorm);
  const output = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (value === undefined) throw new LocalHashEmbeddingError();
    const normalized = Math.fround(value / divisor);
    if (!Number.isFinite(normalized)) {
      output.fill(0);
      throw new LocalHashEmbeddingError();
    }
    output[index] = normalized;
  }
  return output;
}

export function createLocalHashEmbedding(value: string): Float32Array {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    textEncoder.encode(value).byteLength > MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES
  ) {
    throw new LocalHashEmbeddingError();
  }
  const normalized = normalizePrivateRagText(value);
  if (normalized.length === 0) throw new LocalHashEmbeddingError();

  const vector = new Float64Array(LOCAL_HASH_EMBEDDING_DIMENSIONS);
  const tokens = words(normalized);
  if (tokens.length === 0) throw new LocalHashEmbeddingError();

  const tokenCounts = new Map<string, number>();
  for (const token of tokens) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  let features = 0;
  for (const [token, count] of tokenCounts) {
    addFeature(vector, `w:${token}`, 1 + Math.log(count));
    features += 1;
  }
  for (let index = 0; index < tokens.length - 1 && features < MAX_FEATURES; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (left === undefined || right === undefined) throw new LocalHashEmbeddingError();
    addFeature(vector, `b:${left}\u0001${right}`, 0.62);
    features += 1;
  }
  addCharacterTrigrams(vector, normalized, MAX_FEATURES - features);
  try {
    return normalize(vector);
  } finally {
    vector.fill(0);
  }
}
