import { manualNoteFixtures } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import { jsonPayloadCodec, type KeyedMacRecord, type NoteMutationPayload } from "../src/index.js";
import {
  AI_TRANSITION,
  IDS,
  OTHER_IDS,
  OWNER_A,
  PRIVATE_TRANSITION,
  createHarness
} from "./harness.js";

const noteContent = Object.freeze({
  schemaVersion: 1 as const,
  title: "Verification canary",
  bodyMarkdown: "Canonical encrypted content",
  structuredData: { schemaVersion: 1 as const }
});

const baseSnapshot = Object.freeze({
  spaceId: manualNoteFixtures.note.spaceId,
  type: manualNoteFixtures.note.type,
  title: manualNoteFixtures.note.title,
  bodyMarkdown: manualNoteFixtures.note.bodyMarkdown,
  structuredData: manualNoteFixtures.note.structuredData,
  isOpen: manualNoteFixtures.note.isOpen,
  pinnedAt: manualNoteFixtures.note.pinnedAt,
  privacy: manualNoteFixtures.note.privacy,
  archivedAt: manualNoteFixtures.note.archivedAt,
  deletedAt: manualNoteFixtures.note.deletedAt,
  tagIds: manualNoteFixtures.note.tagIds,
  links: manualNoteFixtures.note.links
});

function updateMutation(
  beforePrivacy: "ai_assisted" | "private_manual",
  afterPrivacy: "ai_assisted" | "private_manual"
): Extract<NoteMutationPayload, { action: "update" }> {
  return {
    schemaVersion: 1,
    action: "update",
    beforeRevision: 1,
    afterRevision: 2,
    operations: [{ type: "set_privacy", privacy: afterPrivacy }],
    inverse: [{ type: "set_privacy", privacy: beforePrivacy }],
    beforeSnapshot: { ...baseSnapshot, privacy: beforePrivacy },
    afterSnapshot: { ...baseSnapshot, privacy: afterPrivacy }
  };
}

const createMutation: Extract<NoteMutationPayload, { action: "create" }> = {
  schemaVersion: 1 as const,
  action: "create" as const,
  beforeRevision: 0 as const,
  afterRevision: 1 as const,
  operations: [{ type: "create_note" }],
  inverse: { type: "soft_delete_created_note" as const },
  beforeSnapshot: null,
  afterSnapshot: { ...baseSnapshot, privacy: "ai_assisted" as const }
};

const privateReceipt = Object.freeze({
  schemaVersion: 1 as const,
  captureId: IDS.capture,
  jobId: IDS.job,
  decisionId: null,
  reviewItemId: null,
  mutationId: null,
  outcome: "kept_in_inbox" as const,
  headline: "Kept private in Inbox",
  destination: null,
  insertedContentReferences: [],
  actions: [],
  reasonCodes: ["private_manual"],
  createdAt: "2026-08-30T12:34:56.789Z"
});

describe("aggregate verification MACs", () => {
  it("authenticates a fresh encrypted capture receipt under its source privacy class", async () => {
    const harness = await createHarness();
    const input = {
      surface: "capture_receipt" as const,
      captureId: IDS.capture,
      recordVersion: 1,
      sourcePrivacy: "private_manual" as const,
      payload: privateReceipt
    };
    const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);

    expect(record).toMatchObject({ keyClass: "private_manual", keyPurpose: "content_mac" });
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
    ).resolves.toBe(true);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        captureId: OTHER_IDS.capture
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        payload: { ...privateReceipt, headline: "Tampered" }
      })
    ).resolves.toBe(false);
    expect(JSON.stringify(record)).not.toContain(privateReceipt.headline);
  });

  it("authenticates a generated block under its fixed AI-assisted identity", async () => {
    const harness = await createHarness();
    const input = {
      surface: "generated_block" as const,
      blockId: IDS.block,
      payload: { content: "Encrypted proposal canary", schemaVersion: 1 as const }
    };
    const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);

    expect(record).toMatchObject({ keyClass: "ai_assisted", keyPurpose: "content_mac" });
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
    ).resolves.toBe(true);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        blockId: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
      })
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        payload: { ...input.payload, content: "tampered" }
      })
    ).resolves.toBe(false);
    expect(JSON.stringify(record)).not.toContain(input.payload.content);
  });

  it.each(["ai_assisted", "private_manual"] as const)(
    "derives current-note class %s from authoritative privacy and verifies the exact payload",
    async (privacy) => {
      const harness = await createHarness();
      const input = {
        surface: "note_content" as const,
        noteId: IDS.note,
        recordVersion: 7,
        privacy,
        payload: noteContent
      };
      const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);
      expect(record).toMatchObject({ keyClass: privacy, keyPurpose: "content_mac" });
      await expect(
        harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
      ).resolves.toBe(true);
      expect(JSON.stringify(record)).not.toContain(noteContent.title);
    }
  );

  it("binds the MAC domain to owner, surface, resource, version, class, and canonical payload", async () => {
    const harness = await createHarness();
    const input = {
      surface: "note_content" as const,
      noteId: IDS.note,
      recordVersion: 2,
      privacy: "ai_assisted" as const,
      payload: noteContent
    };
    const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);

    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        noteId: OTHER_IDS.note
      })
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        recordVersion: 3
      })
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        payload: { ...noteContent, bodyMarkdown: "tampered" }
      })
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        surface: "note_mutation",
        mutationId: IDS.mutation,
        recordVersion: 1,
        payload: createMutation
      })
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        privacy: "private_manual"
      })
    ).rejects.toMatchObject({ code: "invalid_record" });
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessB, record, input)
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("derives sticky mutation history class from snapshots and enforces the authoritative version", async () => {
    const harness = await createHarness();
    for (const [payload, keyClass] of [
      [updateMutation("ai_assisted", "private_manual"), "private_manual"],
      [updateMutation("private_manual", "ai_assisted"), "private_manual"],
      [updateMutation("ai_assisted", "ai_assisted"), "ai_assisted"]
    ] as const) {
      const input = {
        surface: "note_mutation" as const,
        mutationId: IDS.mutation,
        recordVersion: 2,
        payload
      };
      const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);
      expect(record.keyClass).toBe(keyClass);
      await expect(
        harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
      ).resolves.toBe(true);
    }

    const created = await harness.service.createAggregateVerificationMac(harness.accessA, {
      surface: "note_mutation",
      mutationId: IDS.mutation,
      recordVersion: 1,
      payload: createMutation
    });
    expect(created.keyClass).toBe("ai_assisted");

    await expect(
      harness.service.createAggregateVerificationMac(harness.accessA, {
        surface: "note_mutation",
        mutationId: IDS.mutation,
        recordVersion: 3,
        payload: updateMutation("ai_assisted", "ai_assisted")
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it.each([
    [AI_TRANSITION, "ai_assisted"],
    [PRIVATE_TRANSITION, "private_manual"]
  ] as const)(
    "derives idempotency response history class from transition %#",
    async (transition, keyClass) => {
      const harness = await createHarness();
      const input = {
        surface: "idempotency_response" as const,
        idempotencyKey: "verification-response",
        transition,
        payload: { accepted: true, revision: 2 },
        payloadCodec: jsonPayloadCodec<{ accepted: boolean; revision: number }>()
      };
      const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);
      expect(record.keyClass).toBe(keyClass);
      await expect(
        harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
      ).resolves.toBe(true);
      await expect(
        harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
          ...input,
          idempotencyKey: "verification-response-other"
        })
      ).resolves.toBe(false);
    }
  );

  it("authenticates organizer decisions as AI-assisted and binds the prepared decision ID", async () => {
    const harness = await createHarness();
    const input = {
      surface: "organization_decision" as const,
      decisionId: IDS.decision,
      payload: {
        schemaVersion: 1 as const,
        candidateManifest: { generationId: null, candidates: [] },
        signals: { deterministic: true },
        validatedPlan: null,
        band: "inbox" as const
      }
    };
    const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);

    expect(record).toMatchObject({ keyClass: "ai_assisted", keyPurpose: "content_mac" });
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
    ).resolves.toBe(true);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        decisionId: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
      })
    ).resolves.toBe(false);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
        ...input,
        payload: { ...input.payload, band: "review" }
      })
    ).resolves.toBe(false);
  });

  it.each(["ai_assisted", "private_manual"] as const)(
    "authenticates organizer Review content under its source class %s",
    async (sourcePrivacy) => {
      const harness = await createHarness();
      const input = {
        surface: "review_item" as const,
        reviewId: IDS.review,
        recordVersion: 1,
        sourcePrivacy,
        payload: {
          schemaVersion: 1 as const,
          choices: [{ candidateId: IDS.note, label: "Groceries" }],
          state: "open" as const,
          resolution: null
        }
      };
      const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);

      expect(record).toMatchObject({ keyClass: sourcePrivacy, keyPurpose: "content_mac" });
      await expect(
        harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
      ).resolves.toBe(true);
      await expect(
        harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
          ...input,
          recordVersion: 2
        })
      ).resolves.toBe(false);
      await expect(
        harness.service.verifyAggregateVerificationMac(harness.accessA, record, {
          ...input,
          sourcePrivacy: sourcePrivacy === "ai_assisted" ? "private_manual" : "ai_assisted"
        })
      ).rejects.toMatchObject({ code: "invalid_record" });
    }
  );

  it("verifies with the exact retired referenced key and fails closed when it is missing or altered", async () => {
    const harness = await createHarness();
    const binding = `${OWNER_A}:ai_assisted`;
    const active = harness.activeMac.get(binding);
    if (active === undefined) throw new Error("fixture active MAC key missing");
    const retiredReference = harness.contentMacReference(OWNER_A, "ai_assisted", "retired");
    const retired = harness.macKeys.get(`${OWNER_A}:ai_assisted:${retiredReference.keyId}`);
    if (retired === undefined) throw new Error("fixture retired MAC key missing");
    harness.activeMac.set(binding, retired);
    const input = {
      surface: "note_content" as const,
      noteId: IDS.note,
      recordVersion: 2,
      privacy: "ai_assisted" as const,
      payload: noteContent
    };
    const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);
    harness.activeMac.set(binding, active);

    expect(record).toMatchObject({
      keyId: retiredReference.keyId,
      keyVersion: retiredReference.keyVersion
    });
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
    ).resolves.toBe(true);
    expect(harness.resolveContentMacKey).toHaveBeenLastCalledWith({
      ownerId: OWNER_A,
      keyClass: "ai_assisted",
      keyId: retiredReference.keyId
    });

    const altered: KeyedMacRecord = { ...record, keyVersion: record.keyVersion + 1 };
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, altered, input)
    ).rejects.toMatchObject({ code: "key_unavailable" });

    harness.macKeys.delete(`${OWNER_A}:ai_assisted:${retiredReference.keyId}`);
    await expect(
      harness.service.verifyAggregateVerificationMac(harness.accessA, record, input)
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("rejects malformed keyed-MAC records before key lookup", async () => {
    const harness = await createHarness();
    const input = {
      surface: "note_content" as const,
      noteId: IDS.note,
      recordVersion: 2,
      privacy: "ai_assisted" as const,
      payload: noteContent
    };
    const record = await harness.service.createAggregateVerificationMac(harness.accessA, input);
    await expect(
      harness.service.verifyAggregateVerificationMac(
        harness.accessA,
        { ...record, unexpected: true },
        input
      )
    ).rejects.toMatchObject({ code: "invalid_record" });
  });
});
