import { captureV1ReceiptFixture, manualNoteFixtures } from "@unfiled/contracts";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import type {
  BackfillVerificationMacInput,
  KeyedMacRecord,
  NoteMutationPayload,
  NoteRevisionPayload
} from "../src/index.js";
import { AI_TRANSITION, IDS, OWNER_A, createHarness } from "./harness.js";

const snapshot = Object.freeze({
  spaceId: manualNoteFixtures.note.spaceId,
  type: manualNoteFixtures.note.type,
  title: manualNoteFixtures.note.title,
  bodyMarkdown: manualNoteFixtures.note.bodyMarkdown,
  structuredData: manualNoteFixtures.note.structuredData,
  isOpen: manualNoteFixtures.note.isOpen,
  pinnedAt: manualNoteFixtures.note.pinnedAt,
  privacy: "ai_assisted" as const,
  archivedAt: manualNoteFixtures.note.archivedAt,
  deletedAt: manualNoteFixtures.note.deletedAt,
  tagIds: manualNoteFixtures.note.tagIds,
  links: manualNoteFixtures.note.links
});

const revision: NoteRevisionPayload = Object.freeze({ schemaVersion: 1, snapshot });
const mutation: NoteMutationPayload = {
  schemaVersion: 1,
  action: "update",
  beforeRevision: 1,
  afterRevision: 2,
  operations: [{ type: "set_title", title: "After" }],
  inverse: [{ type: "set_title", title: "Before" }],
  beforeSnapshot: { ...snapshot, title: "Before" },
  afterSnapshot: { ...snapshot, title: "After" }
};
const jsonResponseCodec = z.strictObject({ ok: z.boolean() });
const storedCaptureReceiptFixture = (({ insertedContent, ...receipt }) =>
  Object.freeze({
    ...receipt,
    insertedContentReferences: insertedContent.map((item) => ({
      type: "captured" as const,
      itemId: item.itemId
    }))
  }))(captureV1ReceiptFixture);

const inputs = Object.freeze([
  {
    surface: "capture",
    captureId: IDS.capture,
    recordVersion: 1,
    privacy: "ai_assisted",
    payload: { schemaVersion: 1, rawContent: "milk" }
  },
  {
    surface: "capture_receipt",
    captureId: IDS.capture,
    recordVersion: 1,
    sourcePrivacy: "ai_assisted",
    payload: storedCaptureReceiptFixture
  },
  {
    surface: "generated_block",
    blockId: IDS.block,
    payload: { schemaVersion: 1, content: "Summary" }
  },
  {
    surface: "idempotency_response",
    idempotencyKey: "legacy-response",
    transition: AI_TRANSITION,
    payload: { ok: true },
    payloadCodec: jsonResponseCodec
  },
  {
    surface: "note_content",
    noteId: IDS.note,
    currentRevision: 2,
    privacy: "ai_assisted",
    payload: {
      schemaVersion: 1,
      title: "After",
      bodyMarkdown: "Body",
      structuredData: { schemaVersion: 1 }
    }
  },
  {
    surface: "note_mutation",
    mutationId: IDS.mutation,
    afterRevision: 2,
    payload: mutation
  },
  {
    surface: "note_revision",
    revisionId: IDS.revision,
    revision: 2,
    transition: AI_TRANSITION,
    payload: revision
  },
  {
    surface: "organization_decision",
    decisionId: IDS.decision,
    payload: {
      schemaVersion: 1,
      candidateManifest: { generationId: null, candidates: [] },
      signals: {},
      validatedPlan: null,
      band: "inbox"
    }
  },
  {
    surface: "organization_mutation_attempt",
    jobId: IDS.job,
    noteId: IDS.note,
    recordVersion: 2,
    payload: { schemaVersion: 1, operations: [{ type: "set_title", title: "After" }] }
  },
  {
    surface: "review_item",
    reviewId: IDS.review,
    recordVersion: 2,
    sourcePrivacy: "ai_assisted",
    payload: { schemaVersion: 1, choices: [], state: "open", resolution: null }
  },
  {
    surface: "routing_rule",
    ruleId: IDS.rule,
    recordVersion: 2,
    payload: {
      schemaVersion: 1,
      condition: "shop:",
      normalizedCondition: "shop:",
      aliases: []
    }
  },
  {
    surface: "space_display",
    spaceId: IDS.space,
    currentRevision: 2,
    payload: { schemaVersion: 1, name: "Shopping", slug: "shopping" }
  },
  {
    surface: "tag_display",
    tagId: IDS.tag,
    currentRevision: 2,
    payload: { schemaVersion: 1, name: "health" }
  }
] as const satisfies readonly BackfillVerificationMacInput<{ ok: boolean }>[]);

describe("legacy backfill verification MACs", () => {
  it.each(inputs)(
    "round-trips canonical $surface evidence under derived provenance",
    async (input) => {
      const harness = await createHarness();
      const mac = await harness.service.createBackfillVerificationMac(harness.accessA, input);
      await expect(
        harness.service.verifyBackfillVerificationMac(harness.accessA, mac, input)
      ).resolves.toBe(true);
      expect(mac.keyClass).toBe(
        input.surface === "space_display" ||
          input.surface === "tag_display" ||
          input.surface === "routing_rule"
          ? "private_manual"
          : "ai_assisted"
      );
    }
  );

  it("separates surface, resource, version, class, payload, and owner domains", async () => {
    const harness = await createHarness();
    const input = inputs[4];
    const mac = await harness.service.createBackfillVerificationMac(harness.accessA, input);
    await expect(
      harness.service.verifyBackfillVerificationMac(harness.accessA, mac, {
        ...input,
        currentRevision: 3
      })
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyBackfillVerificationMac(harness.accessA, mac, {
        ...input,
        payload: { ...input.payload, bodyMarkdown: "tampered" }
      })
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyBackfillVerificationMac(harness.accessA, mac, inputs[2])
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyBackfillVerificationMac(harness.accessA, mac, {
        ...input,
        privacy: "private_manual"
      })
    ).rejects.toMatchObject({ code: "invalid_record" });
    await expect(
      harness.service.verifyBackfillVerificationMac(harness.accessB, mac, input)
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("verifies an exact retired reference and rejects altered or missing keys", async () => {
    const harness = await createHarness();
    const binding = `${OWNER_A}:ai_assisted`;
    const active = harness.activeMac.get(binding);
    if (active === undefined) throw new Error("active fixture key missing");
    const retiredReference = harness.contentMacReference(OWNER_A, "ai_assisted", "retired");
    const retired = harness.macKeys.get(`${OWNER_A}:ai_assisted:${retiredReference.keyId}`);
    if (retired === undefined) throw new Error("retired fixture key missing");
    harness.activeMac.set(binding, retired);
    const input = inputs[2];
    const mac = await harness.service.createBackfillVerificationMac(harness.accessA, input);
    harness.activeMac.set(binding, active);

    await expect(
      harness.service.verifyBackfillVerificationMac(harness.accessA, mac, input)
    ).resolves.toBe(true);
    const altered: KeyedMacRecord = { ...mac, keyVersion: mac.keyVersion + 1 };
    await expect(
      harness.service.verifyBackfillVerificationMac(harness.accessA, altered, input)
    ).rejects.toMatchObject({ code: "key_unavailable" });
    harness.macKeys.delete(`${OWNER_A}:ai_assisted:${retiredReference.keyId}`);
    await expect(
      harness.service.verifyBackfillVerificationMac(harness.accessA, mac, input)
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("fails closed on invalid mutation provenance and AI attempts that touch private data", async () => {
    const harness = await createHarness();
    await expect(
      harness.service.createBackfillVerificationMac(harness.accessA, {
        ...inputs[5],
        afterRevision: 3
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.service.createBackfillVerificationMac(harness.accessA, {
        surface: "organization_mutation_attempt",
        jobId: IDS.job,
        noteId: IDS.note,
        recordVersion: 2,
        payload: {
          schemaVersion: 1,
          operations: [{ type: "set_privacy", privacy: "private_manual" }]
        }
      })
    ).rejects.toMatchObject({ code: "key_class_mismatch" });
  });
});
