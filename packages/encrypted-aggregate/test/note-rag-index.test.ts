import {
  buildPrivateRagPayloadValue,
  createPrivateRagPayloadCodec,
  decodePrivateRagPayloadValue
} from "@unfiled/search";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  EncryptedAggregateError,
  type PayloadCodec,
  type SealedEncryptedAggregateRecord
} from "../src/index.js";
import { OWNER_A, createHarness } from "./harness.js";

const INDEX_ID = "irw_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const OTHER_INDEX_ID = "irw_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const MODEL_ID = "embedding.test.v1";
const DIMENSIONS = 3;
const CANARY = "C5C_RAG_CANARY_7f40bba9f2f34bb2";
const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";

type TestIndexDocument = Readonly<{
  schemaVersion: 1;
  normalizationVersion: 1;
  title: string;
  headings: readonly string[];
  latestSnippet: string;
  lexicalTerms: readonly string[];
  embedding: Readonly<{
    encoding: "f32le-base64url-v1";
    modelId: string;
    dimensions: number;
    data: string;
  }>;
}>;

function indexDocumentCodec(
  expectedModelId = MODEL_ID,
  expectedDimensions = DIMENSIONS
): PayloadCodec<TestIndexDocument> {
  const schema = z.strictObject({
    schemaVersion: z.literal(1),
    normalizationVersion: z.literal(1),
    title: z.string().min(1).max(200),
    headings: z.array(z.string().min(1).max(200)).max(64),
    latestSnippet: z.string().max(2_000),
    lexicalTerms: z.array(z.string().min(1).max(200)).max(4_096),
    embedding: z.strictObject({
      encoding: z.literal("f32le-base64url-v1"),
      modelId: z.literal(expectedModelId),
      dimensions: z.literal(expectedDimensions),
      data: z.string().regex(/^[A-Za-z0-9_-]{1,22000}$/u)
    })
  });
  return Object.freeze({
    parse(value: unknown): TestIndexDocument {
      return schema.parse(value);
    }
  });
}

function indexDocument(overrides: Partial<TestIndexDocument["embedding"]> = {}): TestIndexDocument {
  return Object.freeze({
    schemaVersion: 1,
    normalizationVersion: 1,
    title: `Encrypted ${CANARY}`,
    headings: ["Produce"],
    latestSnippet: `pears ${CANARY}`,
    lexicalTerms: ["pears", "produce"],
    embedding: Object.freeze({
      encoding: "f32le-base64url-v1",
      modelId: MODEL_ID,
      dimensions: DIMENSIONS,
      data: "AACAPwAAAEAAAEBA",
      ...overrides
    })
  });
}

describe("encrypted note RAG index aggregates", () => {
  it("round-trips the production private-RAG wire codec without a byte/object mismatch", async () => {
    const harness = await createHarness();
    const payload = buildPrivateRagPayloadValue({
      noteId: NOTE_ID,
      indexedRevision: 7,
      noteType: "list",
      spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      title: `Shopping ${CANARY}`,
      headings: ["Produce", "Pantry"],
      latestSnippet: `pears ${CANARY}`,
      isOpen: true,
      pinned: false,
      updatedAt: "2026-08-31T12:00:00.000Z",
      searchableText: `pears produce pantry ${CANARY}`,
      modelId: MODEL_ID,
      embedding: [1, 2, 3]
    });
    const codec = createPrivateRagPayloadCodec({
      noteId: NOTE_ID,
      indexedRevision: 7,
      modelId: MODEL_ID,
      dimensions: DIMENSIONS
    });

    const record = await harness.service.sealNoteRagIndex(harness.accessA, {
      indexId: INDEX_ID,
      indexedRevision: 7,
      payload,
      payloadCodec: codec
    });
    expect(JSON.stringify(record)).not.toContain(CANARY);

    const opened = await harness.service.openNoteRagIndex(harness.accessA, record, {
      indexId: INDEX_ID,
      indexedRevision: 7,
      payloadCodec: codec
    });
    const decoded = decodePrivateRagPayloadValue(opened, {
      noteId: NOTE_ID,
      indexedRevision: 7,
      modelId: MODEL_ID,
      dimensions: DIMENSIONS
    });
    expect(decoded.value).toEqual(payload);
    expect([...decoded.embedding]).toEqual([1, 2, 3]);
    decoded.embedding.fill(0);

    await expect(
      harness.service.openNoteRagIndex(harness.accessA, record, {
        indexId: INDEX_ID,
        indexedRevision: 7,
        payloadCodec: createPrivateRagPayloadCodec({
          noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
          indexedRevision: 7,
          modelId: MODEL_ID,
          dimensions: DIMENSIONS
        })
      })
    ).rejects.toMatchObject({ code: "payload_invalid", message: "Payload is invalid" });
  });

  it("round-trips an AI-only document under exact owner/resource/revision context", async () => {
    const harness = await createHarness();
    const payload = indexDocument();
    const codec = indexDocumentCodec();

    const record = await harness.service.sealNoteRagIndex(harness.accessA, {
      indexId: INDEX_ID,
      indexedRevision: 7,
      payload,
      payloadCodec: codec
    });

    expect(record).toMatchObject({
      ownerId: OWNER_A,
      resourceId: INDEX_ID,
      recordVersion: 7,
      kind: "note_rag_index",
      keyClass: "ai_assisted",
      keyPurpose: "object_wrap",
      reservationId: "reservation_1"
    });
    expect(record.envelope.context).toEqual({
      tenantId: OWNER_A,
      resourceId: INDEX_ID,
      recordVersion: 7,
      kind: "note_rag_index"
    });
    expect(harness.reserveObjectWrappingKey).toHaveBeenCalledWith({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });
    expect(JSON.stringify(record)).not.toContain(CANARY);
    await expect(
      harness.service.openNoteRagIndex(harness.accessA, record, {
        indexId: INDEX_ID,
        indexedRevision: 7,
        payloadCodec: codec
      })
    ).resolves.toEqual(payload);
  });

  it("rejects owner, resource, revision, and key-class substitution before decryption", async () => {
    const harness = await createHarness();
    const codec = indexDocumentCodec();
    const record = await harness.service.sealNoteRagIndex(harness.accessA, {
      indexId: INDEX_ID,
      indexedRevision: 7,
      payload: indexDocument(),
      payloadCodec: codec
    });
    harness.resolveObjectWrappingKey.mockClear();

    const attempts: readonly Readonly<{
      record: SealedEncryptedAggregateRecord<"note_rag_index">;
      indexId: typeof INDEX_ID | typeof OTHER_INDEX_ID;
      indexedRevision: number;
      useOtherOwner?: boolean;
    }>[] = [
      { record, indexId: INDEX_ID, indexedRevision: 7, useOtherOwner: true },
      { record, indexId: OTHER_INDEX_ID, indexedRevision: 7 },
      { record, indexId: INDEX_ID, indexedRevision: 8 },
      {
        record: { ...record, keyClass: "private_manual" },
        indexId: INDEX_ID,
        indexedRevision: 7
      }
    ];

    for (const attempt of attempts) {
      await expect(
        harness.service.openNoteRagIndex(
          attempt.useOtherOwner === true ? harness.accessB : harness.accessA,
          attempt.record,
          {
            indexId: attempt.indexId,
            indexedRevision: attempt.indexedRevision,
            payloadCodec: codec
          }
        )
      ).rejects.toMatchObject({ code: "invalid_record" });
    }
    expect(harness.resolveObjectWrappingKey).not.toHaveBeenCalled();
  });

  it("accepts only an exact AI-assisted object-wrap reservation", async () => {
    const harness = await createHarness();
    const privateKey = harness.activeObject.get(`${OWNER_A}:private_manual`);
    if (privateKey === undefined) throw new Error("private fixture key is missing");
    harness.setReservationOverride(() =>
      Promise.resolve({
        reservationId: "reservation_wrong_class",
        reference: privateKey.reference
      })
    );

    await expect(
      harness.service.sealNoteRagIndex(harness.accessA, {
        indexId: INDEX_ID,
        indexedRevision: 7,
        payload: indexDocument(),
        payloadCodec: indexDocumentCodec()
      })
    ).rejects.toMatchObject({ code: "reservation_invalid" });
  });

  it.each([
    ["model", indexDocument({ modelId: CANARY })],
    ["dimensions", indexDocument({ dimensions: DIMENSIONS + 1 })],
    ["unknown field", { ...indexDocument(), [CANARY]: CANARY } as TestIndexDocument]
  ])(
    "uses the caller's strict codec to reject a wrong %s without consuming a reservation",
    async (_case, payload) => {
      const harness = await createHarness();
      let caught: unknown;

      try {
        await harness.service.sealNoteRagIndex(harness.accessA, {
          indexId: INDEX_ID,
          indexedRevision: 7,
          payload,
          payloadCodec: indexDocumentCodec()
        });
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(EncryptedAggregateError);
      expect(caught).toMatchObject({ code: "payload_invalid", message: "Payload is invalid" });
      expect(String(caught)).not.toContain(CANARY);
      expect(harness.reserveObjectWrappingKey).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["model", indexDocumentCodec("embedding.test.v2", DIMENSIONS)],
    ["dimensions", indexDocumentCodec(MODEL_ID, DIMENSIONS + 1)]
  ])(
    "revalidates decrypted %s expectations with content-free errors",
    async (_case, wrongCodec) => {
      const harness = await createHarness();
      const record = await harness.service.sealNoteRagIndex(harness.accessA, {
        indexId: INDEX_ID,
        indexedRevision: 7,
        payload: indexDocument(),
        payloadCodec: indexDocumentCodec()
      });
      let caught: unknown;

      try {
        await harness.service.openNoteRagIndex(harness.accessA, record, {
          indexId: INDEX_ID,
          indexedRevision: 7,
          payloadCodec: wrongCodec
        });
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "payload_invalid", message: "Payload is invalid" });
      expect(String(caught)).not.toContain(CANARY);
    }
  );

  it("rejects invalid index identifiers and revisions before reserving a key", async () => {
    const harness = await createHarness();
    const codec = indexDocumentCodec();

    await expect(
      harness.service.sealNoteRagIndex(harness.accessA, {
        indexId: "irw_invalid",
        indexedRevision: 7,
        payload: indexDocument(),
        payloadCodec: codec
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.service.sealNoteRagIndex(harness.accessA, {
        indexId: INDEX_ID,
        indexedRevision: 0,
        payload: indexDocument(),
        payloadCodec: codec
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.reserveObjectWrappingKey).not.toHaveBeenCalled();
  });
});
