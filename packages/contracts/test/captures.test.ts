import { describe, expect, it } from "vitest";

import {
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  CaptureDeleteRequestSchema,
  CaptureDeleteResponseSchema,
  CaptureDetailResponseSchema,
  CaptureListQuerySchema,
  CaptureListResponseSchema,
  CaptureProcessingStateSchema,
  CaptureReceiptResponseSchema,
  CaptureReceiptSchema,
  CaptureRetryRequestSchema,
  CaptureRetryResponseSchema,
  captureV1DetailFixture,
  captureV1Fixture,
  captureV1ListFixture,
  captureV1ReceiptFixture,
  captureV1ResponseFixture,
  openApiDocument
} from "../src/index.js";
import { CaptureAttachmentSchema } from "../src/index.js";
import { createEntityId, parseEntityId } from "../src/index.js";

const CAPTURE_ID = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_ID = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X";

describe("Milestone C capture contracts", () => {
  it("validates a stable capture identity, defaults optional controls, and enforces 10k text", () => {
    expect(
      CaptureCreateRequestSchema.parse({
        clientCaptureId: CAPTURE_ID,
        rawContent: "milk",
        source: "mobile",
        clientCreatedAt: "2026-08-30T18:30:00.000Z",
        clientTimezone: "America/Los_Angeles"
      })
    ).toMatchObject({
      clientCaptureId: CAPTURE_ID,
      expansionDisabled: false,
      privacy: "ai_assisted"
    });
    expect(
      CaptureCreateRequestSchema.safeParse({ ...captureV1Fixture, rawContent: "x".repeat(10_000) })
        .success
    ).toBe(true);
    for (const input of [
      { ...captureV1Fixture, rawContent: "  \n " },
      { ...captureV1Fixture, rawContent: "x".repeat(10_001) },
      { ...captureV1Fixture, clientCaptureId: "cap_bad" },
      { ...captureV1Fixture, unexpected: true }
    ]) {
      expect(CaptureCreateRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it("publishes exactly the user-visible processing state machine", () => {
    expect(CaptureProcessingStateSchema.options).toEqual([
      "queued",
      "processing",
      "done",
      "needs_review",
      "failed",
      "inbox"
    ]);
    for (const internalState of ["pending", "organized", "deleted"]) {
      expect(CaptureProcessingStateSchema.safeParse(internalState).success).toBe(false);
    }
  });

  it("strictly parses pagination, status, and an ordered date range", () => {
    expect(CaptureListQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(
      CaptureListQuerySchema.parse({
        cursor: "next-page",
        from: "2026-08-29T00:00:00.000Z",
        limit: "50",
        status: "failed",
        to: "2026-08-30T00:00:00.000Z"
      })
    ).toMatchObject({ limit: 50, status: "failed" });
    for (const input of [
      { limit: true },
      { limit: "1e2" },
      { limit: 101 },
      { status: "organized" },
      { unexpected: "query drift" },
      { from: "2026-08-30T00:00:00.000Z", to: "2026-08-30T00:00:00.000Z" },
      { from: "2026-08-31T00:00:00.000Z", to: "2026-08-30T00:00:00.000Z" }
    ]) {
      expect(CaptureListQuerySchema.safeParse(input).success).toBe(false);
    }
  });

  it("round-trips strict create, summary, detail, list, and receipt fixtures", () => {
    expect(CaptureCreateRequestSchema.parse(captureV1Fixture)).toEqual(captureV1Fixture);
    expect(CaptureCreateResponseSchema.parse(captureV1ResponseFixture)).toEqual(
      captureV1ResponseFixture
    );
    expect(CaptureDetailResponseSchema.parse(captureV1DetailFixture)).toEqual(
      captureV1DetailFixture
    );
    expect(CaptureListResponseSchema.parse(captureV1ListFixture)).toEqual(captureV1ListFixture);
    expect(
      CaptureListResponseSchema.safeParse({
        ...captureV1ListFixture,
        items: [{ ...captureV1ListFixture.items[0], receiptAvailable: false }]
      }).success
    ).toBe(false);
    expect(CaptureReceiptResponseSchema.parse({ receipt: captureV1ReceiptFixture })).toEqual({
      receipt: captureV1ReceiptFixture
    });
    expect(
      CaptureDetailResponseSchema.safeParse({ ...captureV1DetailFixture, extra: true }).success
    ).toBe(false);
  });

  it("only advertises receipt actions backed by consistent persisted identifiers", () => {
    expect(
      CaptureReceiptSchema.parse(captureV1ReceiptFixture).actions.map(({ type }) => type)
    ).toEqual(["open", "move", "undo"]);
    expect(
      CaptureReceiptSchema.safeParse({
        ...captureV1ReceiptFixture,
        actions: [{ type: "undo" }]
      }).success
    ).toBe(false);
    expect(
      CaptureReceiptSchema.safeParse({
        ...captureV1ReceiptFixture,
        actions: [{ type: "open", noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" }]
      }).success
    ).toBe(false);
    expect(
      CaptureReceiptSchema.safeParse({
        ...captureV1ReceiptFixture,
        actions: [
          { type: "undo", mutationId: MUTATION_ID, expectedRevision: 2 },
          { type: "undo", mutationId: MUTATION_ID, expectedRevision: 2 }
        ]
      }).success
    ).toBe(false);
    expect(
      CaptureReceiptSchema.safeParse({
        ...captureV1ReceiptFixture,
        actions: [
          {
            type: "move",
            noteId: NOTE_ID,
            decisionId: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
          }
        ]
      }).success
    ).toBe(false);
    expect(
      CaptureReceiptSchema.safeParse({
        ...captureV1ReceiptFixture,
        destination: null,
        mutationId: null
      }).success
    ).toBe(false);
  });

  it("keeps terminal receipts consistent with their processing state and persisted effects", () => {
    const inboxReceipt = {
      ...captureV1ReceiptFixture,
      actions: [],
      destination: null,
      insertedContent: [],
      mutationId: null,
      outcome: "kept_in_inbox"
    } as const;

    expect(CaptureReceiptSchema.safeParse(inboxReceipt).success).toBe(true);
    expect(
      CaptureReceiptSchema.safeParse({
        ...inboxReceipt,
        actions: [{ type: "open", noteId: NOTE_ID }],
        destination: { noteId: NOTE_ID, title: "Shopping" }
      }).success
    ).toBe(false);
    expect(
      CaptureReceiptSchema.safeParse({ ...captureV1ReceiptFixture, insertedContent: [] }).success
    ).toBe(false);
    expect(
      CaptureDetailResponseSchema.safeParse({
        capture: { ...captureV1DetailFixture.capture, status: "failed" }
      }).success
    ).toBe(false);
    expect(
      CaptureDetailResponseSchema.safeParse({
        capture: { ...captureV1DetailFixture.capture, receipt: null, status: "done" }
      }).success
    ).toBe(false);
    expect(
      CaptureDetailResponseSchema.safeParse({
        capture: { ...captureV1DetailFixture.capture, receipt: null, status: "failed" }
      }).success
    ).toBe(true);
    expect(
      CaptureListResponseSchema.safeParse({
        ...captureV1ListFixture,
        items: [{ ...captureV1ListFixture.items[0], receiptAvailable: false, status: "failed" }]
      }).success
    ).toBe(true);
    expect(
      CaptureListResponseSchema.safeParse({
        ...captureV1ListFixture,
        items: [{ ...captureV1ListFixture.items[0], receiptAvailable: false, status: "done" }]
      }).success
    ).toBe(false);
    expect(
      CaptureDetailResponseSchema.safeParse({
        capture: { ...captureV1DetailFixture.capture, receipt: null, status: "processing" }
      }).success
    ).toBe(true);
  });

  it("requires persisted block IDs for AI-generated receipt content", () => {
    const generated = {
      ...captureV1ReceiptFixture,
      insertedContent: [
        {
          type: "ai_generated",
          blockId: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
          content: "Buy shelf-stable milk"
        }
      ]
    };
    expect(CaptureReceiptSchema.safeParse(generated).success).toBe(true);
    expect(
      CaptureReceiptSchema.safeParse({
        ...generated,
        insertedContent: [{ type: "ai_generated", content: "Missing block identity" }]
      }).success
    ).toBe(false);
  });

  it("contracts explicit retry/delete idempotency and atomic routed-content removal", () => {
    expect(CaptureRetryRequestSchema.parse({ idempotencyKey: "retry-capture-once" })).toEqual({
      idempotencyKey: "retry-capture-once"
    });
    expect(CaptureRetryResponseSchema.parse(captureV1ResponseFixture)).toEqual(
      captureV1ResponseFixture
    );
    expect(
      CaptureCreateResponseSchema.safeParse({
        ...captureV1ResponseFixture,
        capture: { ...captureV1ResponseFixture.capture, status: "processing" }
      }).success
    ).toBe(false);
    expect(CaptureDeleteRequestSchema.parse({ idempotencyKey: "delete-capture-once" })).toEqual({
      expectedNoteRevisions: [],
      idempotencyKey: "delete-capture-once",
      removeInsertedContent: false
    });
    expect(
      CaptureDeleteRequestSchema.safeParse({
        expectedNoteRevisions: [{ expectedRevision: 3, noteId: NOTE_ID }],
        idempotencyKey: "delete-capture-once",
        removeInsertedContent: true
      }).success
    ).toBe(true);
    expect(
      CaptureDeleteRequestSchema.safeParse({
        idempotencyKey: "delete-capture-once",
        removeInsertedContent: true
      }).success
    ).toBe(false);
    expect(
      CaptureDeleteRequestSchema.safeParse({
        expectedNoteRevisions: [
          { expectedRevision: 3, noteId: NOTE_ID },
          { expectedRevision: 3, noteId: NOTE_ID }
        ],
        idempotencyKey: "delete-capture-once",
        removeInsertedContent: true
      }).success
    ).toBe(false);
    expect(
      CaptureDeleteResponseSchema.parse({
        captureId: CAPTURE_ID,
        contentRemovalMutations: [
          { expectedRevision: 4, mutationId: MUTATION_ID, noteId: NOTE_ID }
        ],
        deletedAt: "2026-08-30T18:35:00.000Z",
        removedInsertedContent: true,
        replayed: false,
        sourceRemovedFromNoteIds: [NOTE_ID]
      }).removedInsertedContent
    ).toBe(true);
    expect(
      CaptureDeleteResponseSchema.safeParse({
        captureId: CAPTURE_ID,
        contentRemovalMutations: [
          { expectedRevision: 4, mutationId: MUTATION_ID, noteId: NOTE_ID }
        ],
        deletedAt: "2026-08-30T18:35:00.000Z",
        removedInsertedContent: true,
        replayed: false,
        sourceRemovedFromNoteIds: []
      }).success
    ).toBe(false);
  });

  it("publishes the complete authenticated capture API in OpenAPI", () => {
    for (const path of [
      "/captures",
      "/captures/{captureId}",
      "/captures/{captureId}/receipt",
      "/captures/{captureId}/retry"
    ]) {
      expect(openApiDocument.paths).toHaveProperty(path);
    }
    expect(openApiDocument.paths["/captures"].post.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", required: true })
    );
    expect(openApiDocument.paths["/captures"].post.parameters[0].schema.pattern).toBe(
      "^cap_[0-9A-HJKMNP-TV-Z]{26}$"
    );
    expect(
      openApiDocument.paths["/captures/{captureId}"].delete.parameters[1].schema
    ).toMatchObject({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
    expect(openApiDocument.paths["/captures"].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "cursor" }),
        expect.objectContaining({ name: "status" }),
        expect.objectContaining({ name: "from" }),
        expect.objectContaining({ name: "to" })
      ])
    );
    for (const schema of [
      "CaptureCreateRequest",
      "CaptureCreateResponse",
      "CaptureContentRemovalMutation",
      "CaptureSummary",
      "CaptureDetailResponse",
      "CaptureListResponse",
      "CaptureReceipt",
      "CaptureReceiptResponse",
      "CaptureRetryRequest",
      "CaptureDeleteRequest",
      "CaptureDeleteResponse"
    ]) {
      expect(openApiDocument.components.schemas).toHaveProperty(schema);
    }
  });
});

describe("capture attachments", () => {
  it("issues att identifiers and accepts up to four photos and one recording on a capture", () => {
    const attachmentId = createEntityId("att");
    expect(attachmentId.startsWith("att_")).toBe(true);
    expect(() => parseEntityId(attachmentId, "att")).not.toThrow();

    const base = {
      clientCaptureId: CAPTURE_ID,
      rawContent: "whiteboard from the kitchen meeting",
      source: "mobile",
      clientCreatedAt: "2026-09-03T18:30:00.000Z",
      clientTimezone: "America/Los_Angeles"
    };
    const images = Array.from({ length: 4 }, () => createEntityId("att"));
    expect(
      CaptureCreateRequestSchema.parse({ ...base, attachmentIds: images }).attachmentIds
    ).toEqual(images);
    expect(CaptureCreateRequestSchema.parse(base).attachmentIds).toBeUndefined();
    expect(() =>
      CaptureCreateRequestSchema.parse({
        ...base,
        attachmentIds: [...images, createEntityId("att"), createEntityId("att")]
      })
    ).toThrow();
    expect(() =>
      CaptureCreateRequestSchema.parse({ ...base, attachmentIds: [images[0], images[0]] })
    ).toThrow();
    expect(() =>
      CaptureCreateRequestSchema.parse({ ...base, attachmentIds: [createEntityId("cap")] })
    ).toThrow();
  });

  it("describes an uploaded attachment without its bytes", () => {
    const uploaded = CaptureAttachmentSchema.parse({
      id: createEntityId("att"),
      kind: "image",
      mediaType: "image/jpeg",
      byteLength: 412_331,
      width: 1568,
      height: 1044,
      durationMs: null,
      createdAt: "2026-09-03T10:00:00.000Z"
    });
    expect(uploaded.kind).toBe("image");
    expect(() => CaptureAttachmentSchema.parse({ ...uploaded, dataBase64: "AAAA" })).toThrow();
  });
});
