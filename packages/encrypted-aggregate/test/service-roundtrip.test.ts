import { captureV1ReceiptFixture, manualNoteFixtures } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  EncryptedAggregateError,
  authorizeAggregateOwner,
  encryptedFieldForRpc,
  keyedMacForRpc,
  stickyKeyClass,
  type NoteMutationPayload,
  type NoteRevisionPayload
} from "../src/index.js";
import { IDS, OTHER_IDS, OWNER_A, OWNER_B, PRIVATE_TRANSITION, createHarness } from "./harness.js";

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

const noteContent = Object.freeze({
  schemaVersion: 1 as const,
  title: "Encrypted groceries",
  bodyMarkdown: "- [ ] milk",
  structuredData: {
    schemaVersion: 1 as const,
    items: [
      {
        id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const,
        text: "milk",
        checked: false,
        ordinal: 0,
        section: null
      }
    ]
  }
});

const aiSnapshot = Object.freeze({ ...baseSnapshot, privacy: "ai_assisted" as const });
const privateSnapshot = Object.freeze({ ...baseSnapshot, privacy: "private_manual" as const });
const storedCaptureReceiptFixture = (({ insertedContent, ...receipt }) =>
  Object.freeze({
    ...receipt,
    insertedContentReferences: insertedContent.map((item) => ({
      type: "captured" as const,
      itemId: item.itemId
    }))
  }))(captureV1ReceiptFixture);

function revisionPayload(
  snapshot: NoteRevisionPayload["snapshot"] = aiSnapshot
): NoteRevisionPayload {
  return { schemaVersion: 1, snapshot };
}

function mutationPayload(
  beforeSnapshot: Extract<NoteMutationPayload, { action: "update" }>["beforeSnapshot"] = aiSnapshot,
  afterSnapshot: Extract<
    NoteMutationPayload,
    { action: "update" }
  >["afterSnapshot"] = privateSnapshot
): NoteMutationPayload {
  return {
    schemaVersion: 1,
    action: "update",
    beforeRevision: 1,
    afterRevision: 2,
    operations: [{ type: "set_privacy", privacy: afterSnapshot.privacy }],
    inverse: [{ type: "set_privacy", privacy: beforeSnapshot.privacy }],
    beforeSnapshot,
    afterSnapshot
  };
}

describe("encrypted aggregate round trips", () => {
  it("authorizes only the exact canonical owner and keeps the capability opaque", () => {
    const access = authorizeAggregateOwner({
      authenticatedOwnerId: OWNER_A.toUpperCase(),
      resourceOwnerId: OWNER_A
    });
    expect(JSON.stringify(access)).toBe("{}");
    expect(() =>
      authorizeAggregateOwner({ authenticatedOwnerId: OWNER_A, resourceOwnerId: OWNER_B })
    ).toThrow(EncryptedAggregateError);
    expect(() =>
      authorizeAggregateOwner({ authenticatedOwnerId: "not-a-uuid", resourceOwnerId: "not-a-uuid" })
    ).toThrow(EncryptedAggregateError);
    expect(() =>
      authorizeAggregateOwner({
        authenticatedOwnerId: "00000000-0000-0000-0000-000000000000",
        resourceOwnerId: "00000000-0000-0000-0000-000000000000"
      })
    ).toThrow(EncryptedAggregateError);
  });

  it("seals capture content with an exact reservation and a separate content MAC", async () => {
    const harness = await createHarness();
    const payload = { schemaVersion: 1 as const, rawContent: "Buy cinnamon and pears" };
    const record = await harness.service.sealCapture(harness.accessA, {
      captureId: IDS.capture,
      recordVersion: 1,
      privacy: "private_manual",
      payload
    });

    expect(record.encrypted).toMatchObject({
      ownerId: OWNER_A,
      resourceId: IDS.capture,
      recordVersion: 1,
      kind: "capture",
      keyClass: "private_manual",
      keyPurpose: "object_wrap",
      reservationId: "reservation_1"
    });
    expect(record.contentMac).toMatchObject({
      keyClass: "private_manual",
      keyPurpose: "content_mac"
    });
    expect(record.contentMac.value).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(record)).not.toContain(payload.rawContent);
    await expect(
      harness.service.openCapture(harness.accessA, record, {
        captureId: IDS.capture,
        recordVersion: 1,
        privacy: "private_manual"
      })
    ).resolves.toEqual(payload);
    expect(harness.activeObjectWrappingKey).not.toHaveBeenCalled();
    expect(harness.reserveObjectWrappingKey).toHaveBeenCalledWith({
      ownerId: OWNER_A,
      keyClass: "private_manual"
    });
    expect(encryptedFieldForRpc(record.encrypted)).toEqual({
      envelope: record.encrypted.envelope,
      keyId: record.encrypted.keyId,
      keyClass: "private_manual",
      keyPurpose: "object_wrap",
      keyVersion: 2,
      reservationId: "reservation_1"
    });
    expect(keyedMacForRpc(record.contentMac)).toEqual({
      mac: record.contentMac.value,
      keyId: record.contentMac.keyId,
      keyClass: "private_manual",
      keyPurpose: "content_mac",
      keyVersion: 2
    });
  });

  it.each(["ai_assisted", "private_manual"] as const)(
    "round-trips current note content using the after privacy class %s",
    async (privacy) => {
      const harness = await createHarness();
      const record = await harness.service.sealNoteContent(harness.accessA, {
        noteId: IDS.note,
        currentRevision: 7,
        privacy,
        payload: noteContent
      });
      expect(record.keyClass).toBe(privacy);
      expect(record.envelope.context).toEqual({
        tenantId: OWNER_A,
        resourceId: IDS.note,
        recordVersion: 7,
        kind: "note_content"
      });
      await expect(
        harness.service.openNoteContent(harness.accessA, record, {
          noteId: IDS.note,
          currentRevision: 7,
          privacy
        })
      ).resolves.toEqual(noteContent);
    }
  );

  it("uses semantic display MACs independent of resource/version but separated by namespace and owner", async () => {
    const harness = await createHarness();
    const firstSpace = await harness.service.sealSpaceDisplay(harness.accessA, {
      spaceId: IDS.space,
      currentRevision: 1,
      payload: { schemaVersion: 1, name: "Projects", slug: "Projects" }
    });
    const secondSpace = await harness.service.sealSpaceDisplay(harness.accessA, {
      spaceId: OTHER_IDS.space,
      currentRevision: 9,
      payload: { schemaVersion: 1, name: "PROJECTS", slug: "projects" }
    });
    const tag = await harness.service.sealTagDisplay(harness.accessA, {
      tagId: IDS.tag,
      currentRevision: 1,
      payload: { schemaVersion: 1, name: "PROJECTS" }
    });
    const otherOwner = await harness.service.sealSpaceDisplay(harness.accessB, {
      spaceId: IDS.space,
      currentRevision: 1,
      payload: { schemaVersion: 1, name: "Projects", slug: "projects" }
    });

    expect(firstSpace.encrypted.keyClass).toBe("private_manual");
    expect(firstSpace.contentMac.value).toBe(secondSpace.contentMac.value);
    expect(firstSpace.encrypted.envelope.payload.ciphertext).not.toBe(
      secondSpace.encrypted.envelope.payload.ciphertext
    );
    expect(firstSpace.contentMac.value).not.toBe(tag.contentMac.value);
    expect(firstSpace.contentMac.value).not.toBe(otherOwner.contentMac.value);

    await expect(
      harness.service.openSpaceDisplay(harness.accessA, firstSpace, {
        spaceId: IDS.space,
        currentRevision: 1
      })
    ).resolves.toEqual({ schemaVersion: 1, name: "Projects", slug: "Projects" });
    await expect(
      harness.service.openTagDisplay(harness.accessA, tag, {
        tagId: IDS.tag,
        currentRevision: 1
      })
    ).resolves.toEqual({ schemaVersion: 1, name: "projects" });
  });

  it.each([
    [{ before: null, after: "ai_assisted" }, "ai_assisted"],
    [{ before: "ai_assisted", after: "ai_assisted" }, "ai_assisted"],
    [{ before: "ai_assisted", after: "private_manual" }, "private_manual"],
    [{ before: "private_manual", after: "ai_assisted" }, "private_manual"],
    [{ before: "private_manual", after: "private_manual" }, "private_manual"]
  ] as const)("derives sticky history class for %j", async (transition, keyClass) => {
    expect(stickyKeyClass(transition)).toBe(keyClass);
    const harness = await createHarness();
    const snapshot = transition.after === "private_manual" ? privateSnapshot : aiSnapshot;
    const record = await harness.service.sealNoteRevision(harness.accessA, {
      revisionId: IDS.revision,
      revision: 4,
      transition,
      payload: revisionPayload(snapshot)
    });
    expect(record.encrypted.keyClass).toBe(keyClass);
    await expect(
      harness.service.openNoteRevision(harness.accessA, record, {
        revisionId: IDS.revision,
        revision: 4,
        transition
      })
    ).resolves.toEqual(revisionPayload(snapshot));
  });

  it("derives mutation history from before and after snapshots, including create revision zero", async () => {
    const harness = await createHarness();
    const update = mutationPayload();
    const updateRecord = await harness.service.sealNoteMutation(harness.accessA, {
      mutationId: IDS.mutation,
      afterRevision: 2,
      payload: update
    });
    expect(updateRecord.keyClass).toBe("private_manual");
    await expect(
      harness.service.openNoteMutation(harness.accessA, updateRecord, {
        mutationId: IDS.mutation,
        afterRevision: 2,
        transition: PRIVATE_TRANSITION
      })
    ).resolves.toEqual(update);

    const create: NoteMutationPayload = {
      schemaVersion: 1 as const,
      action: "create" as const,
      beforeRevision: 0 as const,
      afterRevision: 1 as const,
      operations: [{ type: "create_note" }],
      inverse: { type: "soft_delete_created_note" as const },
      beforeSnapshot: null,
      afterSnapshot: aiSnapshot
    };
    const createRecord = await harness.service.sealNoteMutation(harness.accessA, {
      mutationId: IDS.mutation,
      afterRevision: 1,
      payload: create
    });
    expect(createRecord.keyClass).toBe("ai_assisted");
    await expect(
      harness.service.openNoteMutation(harness.accessA, createRecord, {
        mutationId: IDS.mutation,
        afterRevision: 1,
        transition: { before: null, after: "ai_assisted" }
      })
    ).resolves.toEqual(create);

    const privacyDowngrade = mutationPayload(privateSnapshot, aiSnapshot);
    const downgradeRecord = await harness.service.sealNoteMutation(harness.accessA, {
      mutationId: IDS.mutation,
      afterRevision: 2,
      payload: privacyDowngrade
    });
    await expect(
      harness.service.openNoteMutationForVerification(harness.accessA, downgradeRecord, {
        mutationId: IDS.mutation,
        afterRevision: 2
      })
    ).resolves.toEqual(privacyDowngrade);
    await expect(
      harness.service.openNoteMutationForVerification(
        harness.accessA,
        { ...downgradeRecord, keyClass: "ai_assisted" },
        { mutationId: IDS.mutation, afterRevision: 2 }
      )
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("round-trips immutable AI-only decision and generated-block payloads", async () => {
    const harness = await createHarness();
    const decisionPayload = {
      schemaVersion: 1 as const,
      candidateManifest: {
        generationId: "generation_v1",
        candidates: [
          {
            noteId: IDS.note,
            revision: 3,
            title: "Groceries",
            noteType: "list" as const,
            spacePath: "Home / Shopping",
            isOpen: true,
            pinned: false,
            headings: ["Produce"],
            latestSnippet: "pears"
          }
        ]
      },
      signals: { lexical: 0.9, exactTitle: true },
      validatedPlan: {
        schemaVersion: 1 as const,
        captureKind: "list_items" as const,
        decision: "append_to_note" as const,
        destination: { candidateId: IDS.note, newNote: null },
        operations: [{ type: "append_list_items" as const, section: null, items: ["pears"] }],
        generatedExpansion: null,
        alternatives: [],
        reasonCodes: ["explicit_shopping_intent" as const]
      },
      band: "auto" as const
    };
    const decision = await harness.service.sealOrganizationDecision(harness.accessA, {
      decisionId: IDS.decision,
      payload: decisionPayload
    });
    expect(decision.keyClass).toBe("ai_assisted");
    await expect(
      harness.service.openOrganizationDecision(harness.accessA, decision, {
        decisionId: IDS.decision
      })
    ).resolves.toEqual(decisionPayload);

    const generatedPayload = { schemaVersion: 1 as const, content: "Try grouping by aisle." };
    const block = await harness.service.sealGeneratedBlock(harness.accessA, {
      blockId: IDS.block,
      payload: generatedPayload
    });
    expect(block.recordVersion).toBe(1);
    expect(block.keyClass).toBe("ai_assisted");
    await expect(
      harness.service.openGeneratedBlock(harness.accessA, block, { blockId: IDS.block })
    ).resolves.toEqual(generatedPayload);
  });

  it("uses source provenance for versioned review and receipt, and private defaults for routing", async () => {
    const harness = await createHarness();
    const reviewPayload = {
      schemaVersion: 1 as const,
      choices: [{ noteId: IDS.note, label: "Groceries" }],
      state: "open" as const,
      resolution: null
    };
    const review = await harness.service.sealReview(harness.accessA, {
      reviewId: IDS.review,
      recordVersion: 3,
      sourcePrivacy: "private_manual",
      payload: reviewPayload
    });
    expect(review.keyClass).toBe("private_manual");
    await expect(
      harness.service.openReview(harness.accessA, review, {
        reviewId: IDS.review,
        recordVersion: 3,
        sourcePrivacy: "private_manual"
      })
    ).resolves.toEqual(reviewPayload);

    const routingPayload = {
      schemaVersion: 1 as const,
      condition: "starts with shop:",
      normalizedCondition: "shop:",
      aliases: ["groceries"]
    };
    const routing = await harness.service.sealRoutingRule(harness.accessA, {
      ruleId: IDS.rule,
      recordVersion: 5,
      payload: routingPayload
    });
    expect(routing.keyClass).toBe("private_manual");
    await expect(
      harness.service.openRoutingRule(harness.accessA, routing, {
        ruleId: IDS.rule,
        recordVersion: 5
      })
    ).resolves.toEqual(routingPayload);

    const receipt = await harness.service.sealCaptureReceipt(harness.accessA, {
      captureId: IDS.capture,
      recordVersion: 2,
      sourcePrivacy: "ai_assisted",
      payload: storedCaptureReceiptFixture
    });
    expect(receipt.keyClass).toBe("ai_assisted");
    await expect(
      harness.service.openCaptureReceipt(harness.accessA, receipt, {
        captureId: IDS.capture,
        recordVersion: 2,
        sourcePrivacy: "ai_assisted"
      })
    ).resolves.toEqual(storedCaptureReceiptFixture);
  });

  it("keeps organization mutation attempts AI-only and version-bound", async () => {
    const harness = await createHarness();
    const payload = {
      schemaVersion: 1 as const,
      operations: [{ type: "set_title" as const, title: "Groceries today" }]
    };
    const attempt = await harness.service.sealOrganizationMutationAttempt(harness.accessA, {
      jobId: IDS.job,
      noteId: IDS.note,
      recordVersion: 2,
      payload
    });
    expect(attempt).toMatchObject({
      resourceId: `${IDS.job}:${IDS.note}`,
      recordVersion: 2,
      keyClass: "ai_assisted"
    });
    await expect(
      harness.service.openOrganizationMutationAttempt(harness.accessA, attempt, {
        jobId: IDS.job,
        noteId: IDS.note,
        recordVersion: 2
      })
    ).resolves.toEqual(payload);
    await expect(
      harness.service.sealOrganizationMutationAttempt(harness.accessA, {
        jobId: IDS.job,
        noteId: IDS.note,
        recordVersion: 3,
        payload: {
          schemaVersion: 1,
          operations: [{ type: "set_privacy", privacy: "private_manual" }]
        }
      })
    ).rejects.toMatchObject({ code: "key_class_mismatch" });
  });

  it("rejects stale or substituted owner, resource, version, kind, and class contexts", async () => {
    const harness = await createHarness();
    const review = await harness.service.sealReview(harness.accessA, {
      reviewId: IDS.review,
      recordVersion: 4,
      sourcePrivacy: "private_manual",
      payload: { schemaVersion: 1, choices: [], state: "open", resolution: null }
    });
    await expect(
      harness.service.openReview(harness.accessA, review, {
        reviewId: IDS.review,
        recordVersion: 3,
        sourcePrivacy: "private_manual"
      })
    ).rejects.toMatchObject({ code: "invalid_record" });
    await expect(
      harness.service.openReview(harness.accessB, review, {
        reviewId: IDS.review,
        recordVersion: 4,
        sourcePrivacy: "private_manual"
      })
    ).rejects.toMatchObject({ code: "invalid_record" });
    await expect(
      harness.service.openReview(
        harness.accessA,
        { ...review, kind: "routing_rule" },
        {
          reviewId: IDS.review,
          recordVersion: 4,
          sourcePrivacy: "private_manual"
        }
      )
    ).rejects.toMatchObject({ code: "invalid_record" });
    await expect(
      harness.service.openReview(harness.accessA, review, {
        reviewId: IDS.review,
        recordVersion: 4,
        sourcePrivacy: "ai_assisted"
      })
    ).rejects.toMatchObject({ code: "invalid_record" });
  });
});
