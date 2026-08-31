import { describe, expect, it } from "vitest";

import {
  MAX_PRIVATE_RAG_HEADINGS,
  buildPrivateRagPayloadValue,
  createPrivateRagPayloadCodec,
  decodePrivateRagPayloadValue,
  parsePrivateRagIndexDocumentBytes,
  serializePrivateRagIndexDocument,
  type BuildPrivateRagPayloadValueInput,
  type PrivateRagPayloadCodec,
  type PrivateRagPayloadValueV1
} from "../src/index.js";

const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const SPACE_ID = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const EXPECTED = {
  noteId: NOTE_ID,
  indexedRevision: 7,
  modelId: "embed.v1",
  dimensions: 3
} as const;

function input(
  overrides: Partial<BuildPrivateRagPayloadValueInput> = {}
): BuildPrivateRagPayloadValueInput {
  return {
    noteId: NOTE_ID,
    indexedRevision: 7,
    noteType: "project",
    spaceId: SPACE_ID,
    title: "  Launch Plan  ",
    headings: ["Milestones", "Risks", "Owners", "Appendix"],
    latestSnippet: "Confirm the launch checklist.",
    isOpen: true,
    pinned: true,
    updatedAt: "2026-08-31T12:00:00.000Z",
    searchableText: "Milestones   launch checklist and owners",
    modelId: "embed.v1",
    embedding: [1, 0, -1],
    ...overrides
  };
}

describe("private RAG payload values", () => {
  it("builds an immutable, explicitly versioned candidate document", () => {
    const value = buildPrivateRagPayloadValue(input());
    expect(value).toMatchObject({
      schemaVersion: 1,
      normalizationVersion: 1,
      rankingVersion: 1,
      noteId: NOTE_ID,
      noteType: "project",
      spaceId: SPACE_ID,
      isOpen: true,
      pinned: true,
      latestSnippet: "Confirm the launch checklist.",
      normalizedLexicalText: "launch plan milestones launch checklist and owners"
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.headings)).toBe(true);
    expect(Object.isFrozen(value.embedding)).toBe(true);
  });

  it("exposes the aggregate-compatible structural codec and a separate vector decoder", () => {
    const value = buildPrivateRagPayloadValue(input());
    const codec: PrivateRagPayloadCodec<PrivateRagPayloadValueV1> =
      createPrivateRagPayloadCodec(EXPECTED);
    const parsed = codec.parse(JSON.parse(JSON.stringify(value)) as unknown);
    expect(parsed).toEqual(value);
    const decoded = decodePrivateRagPayloadValue(parsed, EXPECTED);
    expect(decoded.value).toEqual(value);
    expect([...decoded.embedding]).toEqual([1, 0, -1]);
  });

  it("round-trips canonical byte helpers without making bytes the aggregate contract", () => {
    const value = buildPrivateRagPayloadValue(input());
    const bytes = serializePrivateRagIndexDocument(value, EXPECTED);
    expect(new TextDecoder().decode(bytes).startsWith('{"embedding"')).toBe(true);
    expect(parsePrivateRagIndexDocumentBytes(bytes, EXPECTED)).toEqual(value);
  });

  it("rejects unknown top-level and embedding keys and all context substitution", () => {
    const value = buildPrivateRagPayloadValue(input());
    const codec = createPrivateRagPayloadCodec(EXPECTED);
    expect(() => codec.parse({ ...value, plaintext: "leak" })).toThrow(
      expect.objectContaining({ code: "invalid_shape" })
    );
    expect(() => codec.parse({ ...value, embedding: { ...value.embedding, extra: true } })).toThrow(
      expect.objectContaining({ code: "invalid_shape" })
    );
    expect(() =>
      createPrivateRagPayloadCodec({ ...EXPECTED, indexedRevision: 8 }).parse(value)
    ).toThrow(expect.objectContaining({ code: "context_mismatch" }));
    expect(() =>
      createPrivateRagPayloadCodec({ ...EXPECTED, modelId: "embed.v2" }).parse(value)
    ).toThrow(expect.objectContaining({ code: "context_mismatch" }));
  });

  it("enforces candidate-field bounds before encryption", () => {
    expect(() => buildPrivateRagPayloadValue(input({ title: "x".repeat(201) }))).toThrow(
      expect.objectContaining({ code: "invalid_text" })
    );
    expect(() =>
      buildPrivateRagPayloadValue(
        input({ headings: Array(MAX_PRIVATE_RAG_HEADINGS + 1).fill("h") })
      )
    ).toThrow(expect.objectContaining({ code: "invalid_shape" }));
    expect(() => buildPrivateRagPayloadValue(input({ latestSnippet: "x".repeat(201) }))).toThrow(
      expect.objectContaining({ code: "invalid_text" })
    );
    expect(() =>
      buildPrivateRagPayloadValue(input({ updatedAt: "2026-08-31T05:00:00-07:00" }))
    ).toThrow(expect.objectContaining({ code: "invalid_timestamp" }));
  });
});
