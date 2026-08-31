import {
  buildFloat32LeEmbedding,
  parseFloat32LeEmbedding,
  type Float32LeEmbeddingV1
} from "./float32-embedding.js";
import { privateRagValidationFailure } from "./private-rag-errors.js";

export const PRIVATE_RAG_INDEX_SCHEMA_VERSION = 1 as const;
export const PRIVATE_RAG_NORMALIZATION_VERSION = 1 as const;
export const PRIVATE_RAG_RANKING_VERSION = 1 as const;
export const MAX_PRIVATE_RAG_PAYLOAD_BYTES = 245_760;
export const MAX_PRIVATE_RAG_TITLE_CHARACTERS = 200;
export const MAX_PRIVATE_RAG_HEADING_CHARACTERS = 200;
export const MAX_PRIVATE_RAG_HEADINGS = 64;
export const MAX_PRIVATE_RAG_CANDIDATE_HEADINGS = 3;
export const MAX_PRIVATE_RAG_SNIPPET_CHARACTERS = 200;
export const MAX_PRIVATE_RAG_NORMALIZED_TEXT_BYTES = 200_000;

const NOTE_ID_PATTERN = /^note_[0-9A-HJKMNP-TV-Z]{26}$/u;
const SPACE_ID_PATTERN = /^spc_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NOTE_TYPES = new Set(["generic", "list", "log", "principle", "project"]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type PrivateRagNoteType = "generic" | "list" | "log" | "principle" | "project";

export type PrivateRagIndexDocumentV1 = Readonly<{
  schemaVersion: typeof PRIVATE_RAG_INDEX_SCHEMA_VERSION;
  normalizationVersion: typeof PRIVATE_RAG_NORMALIZATION_VERSION;
  rankingVersion: typeof PRIVATE_RAG_RANKING_VERSION;
  noteId: string;
  indexedRevision: number;
  noteType: PrivateRagNoteType;
  spaceId: string | null;
  title: string;
  headings: readonly string[];
  latestSnippet: string;
  isOpen: boolean;
  pinned: boolean;
  updatedAt: string;
  normalizedLexicalText: string;
  embedding: Float32LeEmbeddingV1;
}>;

export type BuildPrivateRagIndexDocumentInput = Readonly<{
  noteId: string;
  indexedRevision: number;
  noteType: PrivateRagNoteType;
  spaceId: string | null;
  title: string;
  headings: readonly string[];
  latestSnippet: string;
  isOpen: boolean;
  pinned: boolean;
  updatedAt: string;
  searchableText: string;
  modelId: string;
  embedding: readonly number[] | Float32Array;
}>;

export type BuildPrivateRagPayloadValueInput = BuildPrivateRagIndexDocumentInput;
export type PrivateRagPayloadValueV1 = PrivateRagIndexDocumentV1;

export type PrivateRagIndexDocumentExpectation = Readonly<{
  noteId: string;
  indexedRevision: number;
  modelId: string;
  dimensions: number;
}>;

/** Structural shape shared with encrypted-aggregate without creating a package dependency. */
export type PrivateRagPayloadCodec<Value> = Readonly<{
  parse(value: unknown): Value;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function assertNoteId(value: string): void {
  if (!NOTE_ID_PATTERN.test(value)) privateRagValidationFailure("invalid_note_id");
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    privateRagValidationFailure("invalid_revision");
  }
}

function assertDisplayText(value: string, maximumCharacters: number, allowEmpty: boolean): void {
  if (
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maximumCharacters ||
    value.includes(String.fromCodePoint(0))
  ) {
    privateRagValidationFailure("invalid_text");
  }
}

function assertUpdatedAt(value: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    privateRagValidationFailure("invalid_timestamp");
  }
}

function freezeDocument(input: {
  noteId: string;
  indexedRevision: number;
  noteType: PrivateRagNoteType;
  spaceId: string | null;
  title: string;
  headings: readonly string[];
  latestSnippet: string;
  isOpen: boolean;
  pinned: boolean;
  updatedAt: string;
  normalizedLexicalText: string;
  embedding: Float32LeEmbeddingV1;
}): PrivateRagIndexDocumentV1 {
  return Object.freeze({
    schemaVersion: PRIVATE_RAG_INDEX_SCHEMA_VERSION,
    normalizationVersion: PRIVATE_RAG_NORMALIZATION_VERSION,
    rankingVersion: PRIVATE_RAG_RANKING_VERSION,
    noteId: input.noteId,
    indexedRevision: input.indexedRevision,
    noteType: input.noteType,
    spaceId: input.spaceId,
    title: input.title,
    headings: Object.freeze([...input.headings]),
    latestSnippet: input.latestSnippet,
    isOpen: input.isOpen,
    pinned: input.pinned,
    updatedAt: input.updatedAt,
    normalizedLexicalText: input.normalizedLexicalText,
    embedding: Object.freeze({ ...input.embedding })
  });
}

function validateWireDocument(
  value: unknown,
  expected: PrivateRagIndexDocumentExpectation
): PrivateRagIndexDocumentV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "normalizationVersion",
      "rankingVersion",
      "noteId",
      "indexedRevision",
      "noteType",
      "spaceId",
      "title",
      "headings",
      "latestSnippet",
      "isOpen",
      "pinned",
      "updatedAt",
      "normalizedLexicalText",
      "embedding"
    ])
  ) {
    privateRagValidationFailure("invalid_shape");
  }
  if (
    value.schemaVersion !== PRIVATE_RAG_INDEX_SCHEMA_VERSION ||
    value.normalizationVersion !== PRIVATE_RAG_NORMALIZATION_VERSION ||
    value.rankingVersion !== PRIVATE_RAG_RANKING_VERSION
  ) {
    privateRagValidationFailure("unsupported_version");
  }
  if (typeof value.noteId !== "string") privateRagValidationFailure("invalid_note_id");
  assertNoteId(value.noteId);
  if (typeof value.indexedRevision !== "number") {
    privateRagValidationFailure("invalid_revision");
  }
  assertRevision(value.indexedRevision);
  if (typeof value.noteType !== "string" || !NOTE_TYPES.has(value.noteType)) {
    privateRagValidationFailure("invalid_shape");
  }
  if (
    value.spaceId !== null &&
    (typeof value.spaceId !== "string" || !SPACE_ID_PATTERN.test(value.spaceId))
  ) {
    privateRagValidationFailure("invalid_shape");
  }
  if (typeof value.title !== "string") privateRagValidationFailure("invalid_text");
  assertDisplayText(value.title, MAX_PRIVATE_RAG_TITLE_CHARACTERS, false);
  if (!Array.isArray(value.headings) || value.headings.length > MAX_PRIVATE_RAG_HEADINGS) {
    privateRagValidationFailure("invalid_shape");
  }
  const headings: string[] = [];
  for (const heading of value.headings) {
    if (typeof heading !== "string") privateRagValidationFailure("invalid_text");
    assertDisplayText(heading, MAX_PRIVATE_RAG_HEADING_CHARACTERS, false);
    headings.push(heading);
  }
  if (typeof value.latestSnippet !== "string") privateRagValidationFailure("invalid_text");
  assertDisplayText(value.latestSnippet, MAX_PRIVATE_RAG_SNIPPET_CHARACTERS, true);
  if (typeof value.isOpen !== "boolean" || typeof value.pinned !== "boolean") {
    privateRagValidationFailure("invalid_shape");
  }
  if (typeof value.updatedAt !== "string") privateRagValidationFailure("invalid_timestamp");
  assertUpdatedAt(value.updatedAt);
  if (typeof value.normalizedLexicalText !== "string") {
    privateRagValidationFailure("invalid_text");
  }
  if (
    value.normalizedLexicalText.length === 0 ||
    normalizePrivateRagText(value.normalizedLexicalText) !== value.normalizedLexicalText ||
    utf8Length(value.normalizedLexicalText) > MAX_PRIVATE_RAG_NORMALIZED_TEXT_BYTES
  ) {
    privateRagValidationFailure("invalid_text");
  }
  if (value.noteId !== expected.noteId || value.indexedRevision !== expected.indexedRevision) {
    privateRagValidationFailure("context_mismatch");
  }

  const parsedEmbedding = parseFloat32LeEmbedding(value.embedding, {
    modelId: expected.modelId,
    dimensions: expected.dimensions
  });
  parsedEmbedding.values.fill(0);
  const document = freezeDocument({
    noteId: value.noteId,
    indexedRevision: value.indexedRevision,
    noteType: value.noteType as PrivateRagNoteType,
    spaceId: value.spaceId,
    title: value.title,
    headings,
    latestSnippet: value.latestSnippet,
    isOpen: value.isOpen,
    pinned: value.pinned,
    updatedAt: value.updatedAt,
    normalizedLexicalText: value.normalizedLexicalText,
    embedding: Object.freeze({ ...(value.embedding as Float32LeEmbeddingV1) })
  });
  if (
    textEncoder.encode(JSON.stringify(canonicalWireValue(document))).byteLength >
    MAX_PRIVATE_RAG_PAYLOAD_BYTES
  ) {
    privateRagValidationFailure("payload_too_large");
  }
  return document;
}

function canonicalWireValue(document: PrivateRagIndexDocumentV1): Record<string, unknown> {
  return {
    embedding: {
      data: document.embedding.data,
      dimensions: document.embedding.dimensions,
      encoding: document.embedding.encoding,
      modelId: document.embedding.modelId,
      schemaVersion: document.embedding.schemaVersion
    },
    headings: document.headings,
    indexedRevision: document.indexedRevision,
    isOpen: document.isOpen,
    latestSnippet: document.latestSnippet,
    normalizationVersion: document.normalizationVersion,
    normalizedLexicalText: document.normalizedLexicalText,
    noteId: document.noteId,
    noteType: document.noteType,
    pinned: document.pinned,
    rankingVersion: document.rankingVersion,
    schemaVersion: document.schemaVersion,
    spaceId: document.spaceId,
    title: document.title,
    updatedAt: document.updatedAt
  };
}

export function normalizePrivateRagText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function buildPrivateRagIndexDocument(
  input: BuildPrivateRagIndexDocumentInput
): PrivateRagIndexDocumentV1 {
  const normalizedLexicalText = normalizePrivateRagText(`${input.title} ${input.searchableText}`);
  const candidate = freezeDocument({
    noteId: input.noteId,
    indexedRevision: input.indexedRevision,
    noteType: input.noteType,
    spaceId: input.spaceId,
    title: input.title,
    headings: input.headings,
    latestSnippet: input.latestSnippet,
    isOpen: input.isOpen,
    pinned: input.pinned,
    updatedAt: input.updatedAt,
    normalizedLexicalText,
    embedding: buildFloat32LeEmbedding({ modelId: input.modelId, values: input.embedding })
  });
  return validateWireDocument(candidate, {
    noteId: input.noteId,
    indexedRevision: input.indexedRevision,
    modelId: input.modelId,
    dimensions: input.embedding.length
  });
}

export function buildPrivateRagPayloadValue(
  input: BuildPrivateRagPayloadValueInput
): PrivateRagPayloadValueV1 {
  return buildPrivateRagIndexDocument(input);
}

export function createPrivateRagIndexDocumentCodec(
  expected: PrivateRagIndexDocumentExpectation
): PrivateRagPayloadCodec<PrivateRagIndexDocumentV1> {
  return Object.freeze({
    parse(value: unknown): PrivateRagIndexDocumentV1 {
      return validateWireDocument(value, expected);
    }
  });
}

export function createPrivateRagPayloadCodec(
  expected: PrivateRagIndexDocumentExpectation
): PrivateRagPayloadCodec<PrivateRagPayloadValueV1> {
  return createPrivateRagIndexDocumentCodec(expected);
}

export function decodePrivateRagIndexEmbedding(document: PrivateRagIndexDocumentV1): Float32Array {
  return parseFloat32LeEmbedding(document.embedding, {
    modelId: document.embedding.modelId,
    dimensions: document.embedding.dimensions
  }).values;
}

export function decodePrivateRagPayloadValue(
  value: unknown,
  expected: PrivateRagIndexDocumentExpectation
): Readonly<{ value: PrivateRagPayloadValueV1; embedding: Float32Array }> {
  const parsed = createPrivateRagPayloadCodec(expected).parse(value);
  return Object.freeze({ value: parsed, embedding: decodePrivateRagIndexEmbedding(parsed) });
}

export function serializePrivateRagIndexDocument(
  value: unknown,
  expected: PrivateRagIndexDocumentExpectation
): Uint8Array {
  const document = createPrivateRagIndexDocumentCodec(expected).parse(value);
  const bytes = textEncoder.encode(JSON.stringify(canonicalWireValue(document)));
  if (bytes.byteLength > MAX_PRIVATE_RAG_PAYLOAD_BYTES) {
    privateRagValidationFailure("payload_too_large");
  }
  return bytes;
}

export function parsePrivateRagIndexDocumentBytes(
  bytes: Uint8Array,
  expected: PrivateRagIndexDocumentExpectation
): PrivateRagIndexDocumentV1 {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PRIVATE_RAG_PAYLOAD_BYTES) {
    privateRagValidationFailure("payload_too_large");
  }
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch {
    privateRagValidationFailure("invalid_shape");
  }
  return createPrivateRagIndexDocumentCodec(expected).parse(value);
}

/** Convenience wrapper for content-crypto callers that still operate on bytes. */
export function buildPrivateRagPayload(input: BuildPrivateRagIndexDocumentInput): Uint8Array {
  const document = buildPrivateRagIndexDocument(input);
  return serializePrivateRagIndexDocument(document, {
    noteId: input.noteId,
    indexedRevision: input.indexedRevision,
    modelId: input.modelId,
    dimensions: input.embedding.length
  });
}

/** Convenience wrapper retained for the exact retriever's byte-opening port. */
export function parsePrivateRagPayload(
  bytes: Uint8Array,
  expected: PrivateRagIndexDocumentExpectation
): PrivateRagIndexDocumentV1 {
  return parsePrivateRagIndexDocumentBytes(bytes, expected);
}
