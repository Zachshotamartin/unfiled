import { privateRagValidationFailure } from "./private-rag-errors.js";

export const FLOAT32_LE_BASE64URL_ENCODING = "f32le-base64url-v1" as const;
export const FLOAT32_EMBEDDING_SCHEMA_VERSION = 1 as const;
export const MIN_FLOAT32_EMBEDDING_DIMENSIONS = 1;
export const MAX_FLOAT32_EMBEDDING_DIMENSIONS = 4096;
export const MAX_EMBEDDING_MODEL_ID_BYTES = 200;

const FLOAT32_BYTES = 4;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INVALID_BASE64URL_DIGIT = 0xff;
const BASE64URL_DECODE_TABLE = (() => {
  const table = new Uint8Array(128);
  table.fill(INVALID_BASE64URL_DIGIT);
  for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) {
    table[BASE64URL_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();
const textEncoder = new TextEncoder();

export type Float32LeEmbeddingV1 = Readonly<{
  schemaVersion: typeof FLOAT32_EMBEDDING_SCHEMA_VERSION;
  encoding: typeof FLOAT32_LE_BASE64URL_ENCODING;
  modelId: string;
  dimensions: number;
  data: string;
}>;

export type BuildFloat32LeEmbeddingInput = Readonly<{
  modelId: string;
  values: readonly number[] | Float32Array;
}>;

export type Float32EmbeddingExpectation = Readonly<{
  modelId?: string;
  dimensions?: number;
}>;

export type ParsedFloat32LeEmbedding = Readonly<{
  schemaVersion: typeof FLOAT32_EMBEDDING_SCHEMA_VERSION;
  encoding: typeof FLOAT32_LE_BASE64URL_ENCODING;
  modelId: string;
  dimensions: number;
  values: Float32Array;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function assertDimensions(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_FLOAT32_EMBEDDING_DIMENSIONS ||
    value > MAX_FLOAT32_EMBEDDING_DIMENSIONS
  ) {
    privateRagValidationFailure("invalid_dimensions");
  }
}

function assertModelId(value: string): void {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacter(value) ||
    textEncoder.encode(value).byteLength > MAX_EMBEDDING_MODEL_ID_BYTES
  ) {
    privateRagValidationFailure("invalid_model");
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64URL_ALPHABET.charAt((block >>> 18) & 63);
    encoded += BASE64URL_ALPHABET.charAt((block >>> 12) & 63);
    if (second !== undefined) encoded += BASE64URL_ALPHABET.charAt((block >>> 6) & 63);
    if (third !== undefined) encoded += BASE64URL_ALPHABET.charAt(block & 63);
  }
  return encoded;
}

function decodeBase64Url(value: string, expectedBytes: number): Uint8Array {
  const expectedCharacters = Math.ceil((expectedBytes * 4) / 3);
  if (value.length !== expectedCharacters || value.length % 4 === 1) {
    privateRagValidationFailure("invalid_base64url");
  }

  const remainder = value.length % 4;
  const finalCode = value.charCodeAt(value.length - 1);
  const finalSextet =
    finalCode < BASE64URL_DECODE_TABLE.length
      ? (BASE64URL_DECODE_TABLE[finalCode] ?? INVALID_BASE64URL_DIGIT)
      : INVALID_BASE64URL_DIGIT;
  if (
    finalSextet === INVALID_BASE64URL_DIGIT ||
    (remainder === 2 && (finalSextet & 0x0f) !== 0) ||
    (remainder === 3 && (finalSextet & 0x03) !== 0)
  ) {
    privateRagValidationFailure("invalid_base64url");
  }

  const output = new Uint8Array(expectedBytes);
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;
  for (let inputIndex = 0; inputIndex < value.length; inputIndex += 1) {
    const code = value.charCodeAt(inputIndex);
    const digit =
      code < BASE64URL_DECODE_TABLE.length
        ? (BASE64URL_DECODE_TABLE[code] ?? INVALID_BASE64URL_DIGIT)
        : INVALID_BASE64URL_DIGIT;
    if (digit === INVALID_BASE64URL_DIGIT) {
      output.fill(0);
      privateRagValidationFailure("invalid_base64url");
    }
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outputIndex < output.length) {
        output[outputIndex] = (accumulator >>> bits) & 0xff;
      }
      outputIndex += 1;
    }
  }

  if (outputIndex !== expectedBytes) {
    output.fill(0);
    privateRagValidationFailure("invalid_base64url");
  }
  return output;
}

export function encodeFloat32LeBase64Url(values: readonly number[] | Float32Array): string {
  assertDimensions(values.length);
  const bytes = new Uint8Array(values.length * FLOAT32_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value === undefined || !Number.isFinite(value)) {
        privateRagValidationFailure("non_finite_embedding");
      }
      const rounded = Math.fround(value);
      if (!Number.isFinite(rounded)) {
        privateRagValidationFailure("non_finite_embedding");
      }
      view.setFloat32(index * FLOAT32_BYTES, rounded, true);
    }
    return encodeBase64Url(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function decodeFloat32LeBase64Url(value: string, dimensions: number): Float32Array {
  assertDimensions(dimensions);
  const bytes = decodeBase64Url(value, dimensions * FLOAT32_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(dimensions);
  try {
    for (let index = 0; index < dimensions; index += 1) {
      const component = view.getFloat32(index * FLOAT32_BYTES, true);
      if (!Number.isFinite(component)) {
        result.fill(0);
        privateRagValidationFailure("non_finite_embedding");
      }
      result[index] = component;
    }
    return result;
  } finally {
    bytes.fill(0);
  }
}

export function buildFloat32LeEmbedding(input: BuildFloat32LeEmbeddingInput): Float32LeEmbeddingV1 {
  assertModelId(input.modelId);
  assertDimensions(input.values.length);
  return {
    schemaVersion: FLOAT32_EMBEDDING_SCHEMA_VERSION,
    encoding: FLOAT32_LE_BASE64URL_ENCODING,
    modelId: input.modelId,
    dimensions: input.values.length,
    data: encodeFloat32LeBase64Url(input.values)
  };
}

export function parseFloat32LeEmbedding(
  value: unknown,
  expected: Float32EmbeddingExpectation = {}
): ParsedFloat32LeEmbedding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "encoding", "modelId", "dimensions", "data"])
  ) {
    privateRagValidationFailure("invalid_shape");
  }
  if (value.schemaVersion !== FLOAT32_EMBEDDING_SCHEMA_VERSION) {
    privateRagValidationFailure("unsupported_version");
  }
  if (value.encoding !== FLOAT32_LE_BASE64URL_ENCODING) {
    privateRagValidationFailure("unsupported_encoding");
  }
  if (typeof value.modelId !== "string") privateRagValidationFailure("invalid_model");
  assertModelId(value.modelId);
  if (typeof value.dimensions !== "number") {
    privateRagValidationFailure("invalid_dimensions");
  }
  assertDimensions(value.dimensions);
  if (typeof value.data !== "string") privateRagValidationFailure("invalid_base64url");

  if (
    (expected.modelId !== undefined && expected.modelId !== value.modelId) ||
    (expected.dimensions !== undefined && expected.dimensions !== value.dimensions)
  ) {
    privateRagValidationFailure("context_mismatch");
  }

  return {
    schemaVersion: FLOAT32_EMBEDDING_SCHEMA_VERSION,
    encoding: FLOAT32_LE_BASE64URL_ENCODING,
    modelId: value.modelId,
    dimensions: value.dimensions,
    values: decodeFloat32LeBase64Url(value.data, value.dimensions)
  };
}
