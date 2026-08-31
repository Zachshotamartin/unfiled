/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  type EncryptedAggregateService,
  type JsonValue,
  type KeyedMacRecord,
  type PayloadCodec,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedLibraryBackfillOrchestrator,
  type EncryptedLibraryBackfillDependencies
} from "./encrypted-library-backfill-orchestrator";
import {
  encryptedLibrarySurfaces,
  type ContentEncryptionBackfillCandidate,
  type EncryptedLibraryPage,
  type EncryptedLibraryObject,
  type EncryptedLibraryRpcStore,
  type EncryptedLibrarySurface,
  type ListEncryptedLibraryObjectsInput
} from "./encrypted-library-rpc-store";
import { ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const TIME = "2026-08-30T12:00:00.000Z";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

const IDS = Object.freeze({
  block: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  capture: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  decision: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  job: "job_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  mutation: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  note: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  revision: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  review: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  rule: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  space: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  tag: "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"
});

const RESOURCE: Readonly<Record<EncryptedLibrarySurface, string>> = Object.freeze({
  space_display: IDS.space,
  tag_display: IDS.tag,
  note_content: IDS.note,
  note_revision: IDS.revision,
  organization_decision: IDS.decision,
  note_mutation: IDS.mutation,
  generated_block: IDS.block,
  review_item: IDS.review,
  routing_rule: IDS.rule,
  organization_mutation_attempt: `${IDS.job}:${IDS.note}`,
  idempotency_response: "idempotency:legacy-1",
  capture_receipt: IDS.capture,
  capture: IDS.capture
});

const RANK: Readonly<Record<EncryptedLibrarySurface, string>> = Object.freeze({
  space_display: "01",
  tag_display: "02",
  note_content: "03",
  note_revision: "04",
  organization_decision: "05",
  note_mutation: "06",
  generated_block: "07",
  review_item: "08",
  routing_rule: "09",
  organization_mutation_attempt: "10",
  idempotency_response: "11",
  capture_receipt: "12",
  capture: "13"
});

const VERSION: Readonly<Record<EncryptedLibrarySurface, number>> = Object.freeze({
  space_display: 2,
  tag_display: 2,
  note_content: 2,
  note_revision: 2,
  organization_decision: 1,
  note_mutation: 2,
  generated_block: 1,
  review_item: 2,
  routing_rule: 2,
  organization_mutation_attempt: 2,
  idempotency_response: 1,
  capture_receipt: 2,
  capture: 1
});

const noteSnapshot = Object.freeze({
  spaceId: IDS.space,
  type: "generic" as const,
  title: "A note",
  bodyMarkdown: "Body",
  structuredData: { schemaVersion: 1 as const },
  isOpen: true,
  pinnedAt: null,
  privacy: "ai_assisted" as const,
  archivedAt: null,
  deletedAt: null,
  tagIds: [],
  links: []
});

function envelope(
  surface: EncryptedLibrarySurface,
  resourceId = RESOURCE[surface],
  recordVersion = VERSION[surface]
): ContentEnvelopeV1 {
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: "wrap-v1",
    context: Object.freeze({
      tenantId: OWNER,
      resourceId,
      recordVersion,
      kind: surface
    }),
    wrappedDataKey: Object.freeze({ nonce: "AAAAAAAAAAAAAAAA", ciphertext: "A".repeat(64) }),
    payload: Object.freeze({ nonce: "BBBBBBBBBBBBBBBB", ciphertext: "B".repeat(64) })
  });
}

function cipher<Surface extends EncryptedLibrarySurface>(
  surface: Surface,
  keyClass: "ai_assisted" | "private_manual",
  resourceId = RESOURCE[surface],
  recordVersion = VERSION[surface]
): SealedEncryptedAggregateRecord<Surface> {
  return Object.freeze({
    ownerId: OWNER,
    resourceId,
    recordVersion,
    kind: surface,
    envelope: envelope(surface, resourceId, recordVersion),
    keyId: "wrap-v1",
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1,
    reservationId: `reservation-${surface}`
  });
}

function mac(keyClass: "ai_assisted" | "private_manual", value = HEX_A): KeyedMacRecord {
  return Object.freeze({
    value,
    keyId: `${keyClass}-mac-v1`,
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: 1
  });
}

function candidate(
  surface: EncryptedLibrarySurface
): ContentEncryptionBackfillCandidate<typeof surface> {
  const resourceId = RESOURCE[surface];
  const recordVersion = VERSION[surface];
  const keyClass =
    surface === "space_display" ||
    surface === "tag_display" ||
    surface === "routing_rule" ||
    surface === "idempotency_response"
      ? "private_manual"
      : "ai_assisted";
  const expectedContentBySurface: Readonly<Record<EncryptedLibrarySurface, unknown>> = {
    space_display: { schemaVersion: 1, name: "Inbox", slug: "inbox" },
    tag_display: { schemaVersion: 1, name: "health" },
    note_content: {
      schemaVersion: 1,
      title: "A note",
      bodyMarkdown: "Body",
      structuredData: { schemaVersion: 1 }
    },
    note_revision: { schemaVersion: 1, snapshot: noteSnapshot },
    organization_decision: {
      schemaVersion: 1,
      candidateManifest: { generationId: null, candidates: [] },
      signals: {},
      validatedPlan: null,
      band: "inbox"
    },
    note_mutation: {
      schemaVersion: 1,
      action: "update",
      beforeRevision: 1,
      afterRevision: 2,
      operations: [{ type: "set_title", title: "A note" }],
      inverse: [{ type: "set_title", title: "Old" }],
      beforeSnapshot: { ...noteSnapshot, title: "Old" },
      afterSnapshot: noteSnapshot
    },
    generated_block: { schemaVersion: 1, content: "Summary" },
    review_item: { schemaVersion: 1, choices: [], state: "open", resolution: null },
    routing_rule: {
      schemaVersion: 1,
      condition: "shop:",
      normalizedCondition: "shop:",
      aliases: []
    },
    organization_mutation_attempt: {
      schemaVersion: 1,
      operations: [{ type: "set_title", title: "A note" }]
    },
    idempotency_response: {
      requestHash: HEX_A,
      responseJson: { ignoredLegacyPlaintext: true },
      requestResourceType: "legacy_idempotency",
      requestResourceId: resourceId,
      responseResourceType: "legacy_response",
      responseResourceId: resourceId,
      responseRecordVersion: 1
    },
    capture_receipt: {
      schemaVersion: 1,
      captureId: IDS.capture,
      jobId: IDS.job,
      decisionId: IDS.decision,
      reviewItemId: null,
      mutationId: IDS.mutation,
      outcome: "added_to_note",
      headline: "Added",
      destination: { noteId: IDS.note, title: "A note" },
      insertedContentReferences: [{ type: "captured", itemId: null }],
      actions: [{ type: "open", noteId: IDS.note }],
      reasonCodes: ["explicit_destination"],
      createdAt: TIME
    },
    capture: { contentEnvelope: envelope("capture"), contentFingerprint: HEX_A }
  };
  const operationalBySurface: Readonly<Record<EncryptedLibrarySurface, unknown>> = {
    space_display: { parentId: null, sortKey: "a0", archivedAt: null, updatedAt: TIME },
    tag_display: { updatedAt: TIME },
    note_content: {
      spaceId: IDS.space,
      type: "generic",
      dailyDate: null,
      isOpen: true,
      privacy: "ai_assisted",
      archivedAt: null,
      deletedAt: null,
      updatedAt: TIME
    },
    note_revision: {
      noteId: IDS.note,
      source: "manual",
      privacy: "ai_assisted",
      actor: `user:${OWNER}`,
      mutationId: IDS.mutation,
      createdAt: TIME,
      legacyContentHash: HEX_A
    },
    organization_decision: {
      captureId: IDS.capture,
      destinationNoteId: null,
      score: null,
      margin: null,
      reasonCodes: [],
      createdAt: TIME
    },
    note_mutation: {
      noteId: IDS.note,
      decisionId: IDS.decision,
      beforeRevision: 1,
      afterRevision: 2,
      idempotencyKey: "mutation-1",
      undoneAt: null,
      createdAt: TIME
    },
    generated_block: {
      noteId: IDS.note,
      decisionId: IDS.decision,
      kind: "summary",
      state: "proposed",
      modelId: "model",
      promptVersion: "v1",
      resolvedAt: null,
      createdAt: TIME
    },
    review_item: {
      captureId: IDS.capture,
      noteId: null,
      type: "low_confidence",
      createdAt: TIME,
      resolvedAt: null
    },
    routing_rule: {
      enabled: true,
      ruleType: "prefix",
      destinationNoteId: IDS.note,
      destinationSpaceId: null,
      priority: 1,
      source: "explicit",
      lastFiredAt: null,
      updatedAt: TIME
    },
    organization_mutation_attempt: {
      jobId: IDS.job,
      noteId: IDS.note,
      plannedRevision: 1,
      replanCount: 0,
      state: "applied",
      reviewItemId: null,
      updatedAt: TIME
    },
    idempotency_response: {
      scope: "legacy",
      createdAt: TIME,
      completedAt: TIME,
      replayPolicy: "legacy_nonreplayable"
    },
    capture_receipt: {
      jobId: IDS.job,
      decisionId: IDS.decision,
      reviewItemId: null,
      mutationId: IDS.mutation,
      outcome: "added_to_note",
      destinationNoteId: IDS.note,
      reasonCodes: ["explicit_destination"],
      createdAt: TIME
    },
    capture: {
      source: "web",
      deviceId: "browser",
      contentLength: 4,
      clientCreatedAt: TIME,
      clientTimezone: "UTC",
      privacy: "ai_assisted",
      status: "organized"
    }
  };
  return {
    surface,
    ownerId: OWNER,
    cursor: `${RANK[surface]}:${surface}:${resourceId}`,
    resourceId,
    recordVersion,
    keyClass,
    expectedContent: expectedContentBySurface[surface],
    operational: operationalBySurface[surface]
  } as ContentEncryptionBackfillCandidate<typeof surface>;
}

function aggregateHarness(options: Readonly<{ tamperOpen?: boolean }> = {}) {
  const verificationMac = mac("ai_assisted", HEX_B);
  const privateVerificationMac = mac("private_manual", HEX_B);
  const opened = (input: Readonly<{ payload?: unknown }>) =>
    Promise.resolve(options.tamperOpen ? { tampered: true } : input.payload);
  const sealPlain = (
    surface: EncryptedLibrarySurface,
    keyClass: "ai_assisted" | "private_manual",
    input: Readonly<Record<string, unknown>>
  ) => {
    const resourceId = (input.spaceId ??
      input.tagId ??
      input.noteId ??
      input.revisionId ??
      input.decisionId ??
      input.mutationId ??
      input.blockId ??
      input.reviewId ??
      input.ruleId ??
      input.captureId) as string;
    const version = (input.currentRevision ??
      input.revision ??
      input.afterRevision ??
      input.recordVersion ??
      1) as number;
    return cipher(surface, keyClass, resourceId, version);
  };
  const aggregate = {
    sealSpaceDisplay: vi.fn((_access, input) =>
      Promise.resolve({
        encrypted: sealPlain("space_display", "private_manual", input),
        contentMac: mac("private_manual")
      })
    ),
    openSpaceDisplay: vi.fn((_access, _record, input) => opened(input)),
    sealTagDisplay: vi.fn((_access, input) =>
      Promise.resolve({
        encrypted: sealPlain("tag_display", "private_manual", input),
        contentMac: mac("private_manual")
      })
    ),
    openTagDisplay: vi.fn((_access, _record, input) => opened(input)),
    sealNoteContent: vi.fn((_access, input) =>
      Promise.resolve(sealPlain("note_content", input.privacy, input))
    ),
    openNoteContent: vi.fn((_access, _record, input) => opened(input)),
    sealNoteRevision: vi.fn((_access, input) =>
      Promise.resolve({
        encrypted: sealPlain(
          "note_revision",
          input.transition.before === "private_manual" ||
            input.transition.after === "private_manual"
            ? "private_manual"
            : "ai_assisted",
          input
        ),
        contentMac: mac("ai_assisted")
      })
    ),
    openNoteRevision: vi.fn((_access, _record, input) => opened(input)),
    sealOrganizationDecision: vi.fn((_access, input) =>
      Promise.resolve(sealPlain("organization_decision", "ai_assisted", input))
    ),
    openOrganizationDecision: vi.fn((_access, _record, input) => opened(input)),
    sealNoteMutation: vi.fn((_access, input) =>
      Promise.resolve(sealPlain("note_mutation", "ai_assisted", input))
    ),
    openNoteMutation: vi.fn(() =>
      Promise.resolve(
        options.tamperOpen ? { tampered: true } : candidate("note_mutation").expectedContent
      )
    ),
    openNoteMutationForVerification: vi.fn(() =>
      Promise.resolve(candidate("note_mutation").expectedContent)
    ),
    sealGeneratedBlock: vi.fn((_access, input) =>
      Promise.resolve(sealPlain("generated_block", "ai_assisted", input))
    ),
    openGeneratedBlock: vi.fn((_access, _record, input) => opened(input)),
    sealReview: vi.fn((_access, input) =>
      Promise.resolve(sealPlain("review_item", input.sourcePrivacy, input))
    ),
    openReview: vi.fn((_access, _record, input) => opened(input)),
    sealRoutingRule: vi.fn((_access, input) =>
      Promise.resolve(sealPlain("routing_rule", "private_manual", input))
    ),
    openRoutingRule: vi.fn((_access, _record, input) => opened(input)),
    sealOrganizationMutationAttempt: vi.fn((_access, input) =>
      Promise.resolve(
        cipher(
          "organization_mutation_attempt",
          "ai_assisted",
          `${input.jobId}:${input.noteId}`,
          input.recordVersion
        )
      )
    ),
    openOrganizationMutationAttempt: vi.fn((_access, _record, input) => opened(input)),
    sealIdempotencyResponse: vi.fn((_access, input) => {
      const keyClass =
        input.transition.before === "private_manual" || input.transition.after === "private_manual"
          ? "private_manual"
          : "ai_assisted";
      return Promise.resolve(
        cipher("idempotency_response", keyClass, `idempotency:${input.idempotencyKey}`, 1)
      );
    }),
    openIdempotencyResponseForVerification: vi.fn((_access, record) => {
      const idempotencyRecord = record as Readonly<{ idempotencyKey: string }>;
      return Promise.resolve(
        idempotencyRecord.idempotencyKey === "legacy-1"
          ? {
              resourceType: "legacy_response",
              resourceId: "idempotency:legacy-1",
              recordVersion: 1
            }
          : { ok: true }
      );
    }),
    sealCaptureReceipt: vi.fn((_access, input) =>
      Promise.resolve(sealPlain("capture_receipt", input.sourcePrivacy, input))
    ),
    openCaptureReceipt: vi.fn((_access, _record, input) => opened(input)),
    sealCapture: vi.fn((_access, input) =>
      Promise.resolve({
        encrypted: sealPlain("capture", input.privacy, input),
        contentMac: mac(input.privacy)
      })
    ),
    openCapture: vi.fn((_access, _record, input) => opened(input)),
    createBackfillVerificationMac: vi.fn((_access, input) =>
      Promise.resolve(
        input.surface === "space_display" ||
          input.surface === "tag_display" ||
          input.surface === "routing_rule" ||
          input.surface === "idempotency_response"
          ? privateVerificationMac
          : verificationMac
      )
    ),
    verifyBackfillVerificationMac: vi.fn(() => Promise.resolve(true)),
    createAggregateVerificationMac: vi.fn((_access, input) =>
      Promise.resolve(
        input.surface === "idempotency_response" && input.transition.after === "private_manual"
          ? privateVerificationMac
          : verificationMac
      )
    ),
    verifyAggregateVerificationMac: vi.fn(() => Promise.resolve(true)),
    verifyIdempotencyRequest: vi.fn(() => Promise.reject(new Error("must not authorize replay"))),
    openIdempotencyResponse: vi.fn(() => Promise.reject(new Error("must not replay-open")))
  } as unknown as EncryptedAggregateService;
  return { aggregate, verificationMac };
}

function storeHarness(
  candidates: readonly ContentEncryptionBackfillCandidate<EncryptedLibrarySurface>[] = encryptedLibrarySurfaces.map(
    candidate
  )
) {
  const commitContentEncryptionBackfill = vi.fn((input) =>
    Promise.resolve({
      surface: input.surface,
      resourceId: input.resourceId,
      recordVersion: input.expectedRecordVersion,
      cursor: input.nextCursor,
      complete: false,
      replayed: false
    })
  );
  const completeContentEncryptionBackfill = vi.fn(() =>
    Promise.resolve({ complete: true, replayed: false })
  );
  const resealCaptureContent = vi.fn(() =>
    Promise.resolve({ captureId: IDS.capture, envelopeDigest: HEX_A, replayed: false })
  );
  const listContentEncryptionBackfillCandidates = vi.fn((input) =>
    Promise.resolve({
      surface: input.surface,
      items: candidates.filter(
        (item) => item.surface === input.surface && item.cursor > (input.afterCursor ?? "")
      ),
      nextCursor: null
    })
  );
  const listEncryptedLibraryObjects = vi.fn(
    (
      input: ListEncryptedLibraryObjectsInput<EncryptedLibrarySurface>
    ): Promise<EncryptedLibraryPage<EncryptedLibrarySurface>> =>
      Promise.resolve({ surface: input.surface, items: [], nextCursor: null })
  );
  const verifyEncryptedContentObject = vi.fn(() =>
    Promise.resolve({
      surface: "note_content",
      resourceId: IDS.note,
      recordVersion: 2,
      envelopeDigest: HEX_A,
      replayed: false
    })
  );
  const store = {
    listContentEncryptionBackfillCandidates,
    commitContentEncryptionBackfill,
    completeContentEncryptionBackfill,
    resealCaptureContent,
    listEncryptedLibraryObjects,
    verifyEncryptedContentObject
  } as unknown as EncryptedLibraryRpcStore;
  return {
    store,
    commitContentEncryptionBackfill,
    completeContentEncryptionBackfill,
    resealCaptureContent,
    listContentEncryptionBackfillCandidates,
    listEncryptedLibraryObjects,
    verifyEncryptedContentObject
  };
}

function dependencies(
  options: Readonly<{
    candidates?: readonly ContentEncryptionBackfillCandidate<EncryptedLibrarySurface>[];
    tamperOpen?: boolean;
  }> = {}
) {
  const aggregate = aggregateHarness(
    options.tamperOpen === undefined ? {} : { tamperOpen: options.tamperOpen }
  );
  const store = storeHarness(options.candidates ?? encryptedLibrarySurfaces.map(candidate));
  const legacyCaptureProtector = {
    openCapture: vi.fn(() => Promise.resolve("milk"))
  };
  const responseCodec: PayloadCodec<JsonValue> = Object.freeze({
    parse(value: unknown): JsonValue {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        (value as Readonly<Record<string, unknown>>).ok !== true
      ) {
        throw new TypeError("response invalid");
      }
      return { ok: true };
    }
  });
  const resolveIdempotencyResponseCodec = vi.fn<
    EncryptedLibraryBackfillDependencies["resolveIdempotencyResponseCodec"]
  >(() => responseCodec);
  const value: EncryptedLibraryBackfillDependencies = Object.freeze({
    access: authorizeAggregateOwner({ authenticatedOwnerId: OWNER, resourceOwnerId: OWNER }),
    aggregate: aggregate.aggregate,
    legacyCaptureProtector,
    ownerId: OWNER,
    resolveIdempotencyResponseCodec,
    store: store.store
  });
  return { value, aggregate, store, legacyCaptureProtector, resolveIdempotencyResponseCodec };
}

function storedObject(
  surface: "note_content" | "note_mutation",
  resourceId: string
): EncryptedLibraryObject<typeof surface> {
  const operational =
    surface === "note_content"
      ? {
          spaceId: IDS.space,
          type: "generic" as const,
          dailyDate: null,
          isOpen: true,
          pinnedAt: null,
          privacy: "ai_assisted" as const,
          archivedAt: null,
          deletedAt: null,
          createdAt: TIME,
          updatedAt: TIME
        }
      : {
          decisionId: IDS.decision,
          noteId: IDS.note,
          beforeRevision: 1,
          afterRevision: 2,
          undoneAt: null,
          createdAt: TIME
        };
  return {
    surface,
    ownerId: OWNER,
    resourceId,
    recordVersion: 2,
    operational,
    encrypted: cipher(surface, "ai_assisted", resourceId, 2),
    contentMac: null
  };
}

function storedIdempotency(
  resourceId: string,
  replayPolicy: "legacy_nonreplayable" | "logical_mac"
): EncryptedLibraryObject<"idempotency_response"> {
  return {
    surface: "idempotency_response",
    ownerId: OWNER,
    resourceId,
    recordVersion: 1,
    operational: {
      scope: "create_encrypted_note",
      requestResourceType: "note_create",
      requestResourceId: IDS.note,
      responseResourceType: "note_write_result",
      responseResourceId: IDS.note,
      responseRecordVersion: 2,
      createdAt: TIME,
      completedAt: TIME,
      replayPolicy,
      requestMac: replayPolicy === "logical_mac" ? mac("ai_assisted") : null
    },
    encrypted: cipher("idempotency_response", "ai_assisted", resourceId, 1),
    contentMac: null
  };
}

describe("encrypted library backfill orchestration", () => {
  it("seals, opens, compares, verifies, and atomically advances all 13 typed surfaces", async () => {
    const harness = dependencies();
    const orchestrator = createEncryptedLibraryBackfillOrchestrator(harness.value);
    const result = await orchestrator.runBackfillBatch({ ownerId: OWNER, limit: 50 });

    expect(result).toMatchObject({ complete: true, cursor: null, processed: 13 });
    expect(harness.store.commitContentEncryptionBackfill).toHaveBeenCalledTimes(12);
    expect(harness.store.resealCaptureContent).toHaveBeenCalledOnce();
    expect(harness.store.completeContentEncryptionBackfill).toHaveBeenCalledWith({
      ownerId: OWNER,
      batchReference: "content-encryption-backfill-complete-v1",
      expectedCursor: `12:capture_receipt:${IDS.capture}`
    });
    expect(harness.legacyCaptureProtector.openCapture).toHaveBeenCalledWith(
      { envelope: envelope("capture"), fingerprint: HEX_A, length: 4 },
      OWNER,
      IDS.capture
    );
    const spaceCommit = harness.store.commitContentEncryptionBackfill.mock.calls.find(
      ([input]) => input.surface === "space_display"
    )?.[0];
    expect(spaceCommit).toMatchObject({
      contentMac: { value: HEX_A },
      verificationMac: { value: HEX_B }
    });
    const noteCommit = harness.store.commitContentEncryptionBackfill.mock.calls.find(
      ([input]) => input.surface === "note_content"
    )?.[0];
    expect(noteCommit?.contentMac).toBeNull();
    expect(harness.aggregate.aggregate.verifyIdempotencyRequest).not.toHaveBeenCalled();
    expect(harness.aggregate.aggregate.openIdempotencyResponse).not.toHaveBeenCalled();
    expect(
      harness.aggregate.aggregate.openIdempotencyResponseForVerification
    ).toHaveBeenCalledOnce();
  });

  it("enforces a total owner-scoped batch bound and returns a resumable global cursor", async () => {
    const harness = dependencies();
    const result = await createEncryptedLibraryBackfillOrchestrator(harness.value).runBackfillBatch(
      { ownerId: OWNER, limit: 2 }
    );

    expect(result).toMatchObject({
      complete: false,
      processed: 2,
      cursor: `02:tag_display:${IDS.tag}`
    });
    expect(harness.store.commitContentEncryptionBackfill).toHaveBeenCalledTimes(2);
    expect(harness.store.completeContentEncryptionBackfill).not.toHaveBeenCalled();
  });

  it("keeps the generic cursor stable across a capture reseal crash and exact replay", async () => {
    const harness = dependencies({ candidates: [] });
    const receipt = candidate("capture_receipt");
    const capture = candidate("capture");
    let capturePage = 0;
    harness.store.listContentEncryptionBackfillCandidates.mockImplementation((input) => {
      if (input.surface === "capture_receipt") {
        return Promise.resolve({
          surface: input.surface,
          items: input.afterCursor === null ? [receipt] : [],
          nextCursor: null
        });
      }
      if (input.surface === "capture") {
        capturePage += 1;
        return Promise.resolve({
          surface: input.surface,
          // The second page models a stale page replayed after the caller lost the fresh
          // reseal acknowledgement. The third scan models the DB candidate disappearing.
          items: capturePage <= 2 ? [capture] : [],
          nextCursor: null
        });
      }
      return Promise.resolve({ surface: input.surface, items: [], nextCursor: null });
    });
    harness.store.resealCaptureContent
      .mockResolvedValueOnce({ captureId: IDS.capture, envelopeDigest: HEX_A, replayed: false })
      .mockResolvedValueOnce({ captureId: IDS.capture, envelopeDigest: HEX_A, replayed: true });
    const orchestrator = createEncryptedLibraryBackfillOrchestrator(harness.value);

    const fresh = await orchestrator.runBackfillBatch({ ownerId: OWNER, limit: 2 });
    expect(fresh).toMatchObject({
      complete: false,
      cursor: `12:capture_receipt:${IDS.capture}`,
      processed: 2,
      resources: [{ surface: "capture_receipt" }, { surface: "capture", replayed: false }]
    });

    const replay = await orchestrator.runBackfillBatch({
      ownerId: OWNER,
      afterCursor: fresh.cursor,
      limit: 1
    });
    expect(replay).toMatchObject({
      complete: false,
      cursor: `12:capture_receipt:${IDS.capture}`,
      processed: 1,
      resources: [{ surface: "capture", replayed: true }]
    });

    await expect(
      orchestrator.runBackfillBatch({ ownerId: OWNER, afterCursor: replay.cursor, limit: 10 })
    ).resolves.toMatchObject({ complete: true, cursor: null, processed: 0 });
    expect(harness.store.resealCaptureContent).toHaveBeenCalledTimes(2);
    expect(harness.store.completeContentEncryptionBackfill).toHaveBeenCalledWith({
      ownerId: OWNER,
      batchReference: "content-encryption-backfill-complete-v1",
      expectedCursor: `12:capture_receipt:${IDS.capture}`
    });
  });

  it("fails closed before commit on plaintext comparison drift, cancellation, or invalid bounds", async () => {
    const tampered = dependencies({ candidates: [candidate("space_display")], tamperOpen: true });
    await expect(
      createEncryptedLibraryBackfillOrchestrator(tampered.value).runBackfillBatch({
        ownerId: OWNER
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(tampered.store.commitContentEncryptionBackfill).not.toHaveBeenCalled();

    const cancelled = dependencies({ candidates: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      createEncryptedLibraryBackfillOrchestrator(cancelled.value).runBackfillBatch({
        ownerId: OWNER,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(cancelled.store.listContentEncryptionBackfillCandidates).not.toHaveBeenCalled();

    await expect(
      createEncryptedLibraryBackfillOrchestrator(cancelled.value).runBackfillBatch({
        ownerId: OWNER,
        limit: 51
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });

    await expect(
      createEncryptedLibraryBackfillOrchestrator(cancelled.value).runBackfillBatch({
        ownerId: "22222222-2222-4222-8222-222222222222"
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    await expect(
      createEncryptedLibraryBackfillOrchestrator(cancelled.value).sweepVerificationBatch({
        ownerId: "22222222-2222-4222-8222-222222222222"
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    expect(cancelled.store.completeContentEncryptionBackfill).not.toHaveBeenCalled();
  });

  it("does not commit a prepared backfill write after cancellation", async () => {
    const harness = dependencies({ candidates: [candidate("space_display")] });
    const controller = new AbortController();
    let release: (() => void) | undefined;
    vi.mocked(harness.aggregate.aggregate.openSpaceDisplay).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ schemaVersion: 1, name: "Inbox", slug: "inbox" });
        })
    );

    const pending = createEncryptedLibraryBackfillOrchestrator(harness.value).runBackfillBatch({
      ownerId: OWNER,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    controller.abort();
    release?.();

    await expect(pending).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    expect(harness.store.commitContentEncryptionBackfill).not.toHaveBeenCalled();
    expect(harness.store.completeContentEncryptionBackfill).not.toHaveBeenCalled();
  });
});

describe("encrypted content verification sweep", () => {
  it("reopens and verifies fresh objects while categorically skipping legacy replay records", async () => {
    const harness = dependencies({ candidates: [] });
    const pages: Readonly<
      Record<string, readonly EncryptedLibraryObject<EncryptedLibrarySurface>[]>
    > = {
      note_content: [storedObject("note_content", IDS.note)],
      note_mutation: [storedObject("note_mutation", IDS.mutation)],
      idempotency_response: [
        storedIdempotency("idempotency:legacy-2", "legacy_nonreplayable"),
        storedIdempotency("idempotency:logical-1", "logical_mac")
      ]
    };
    harness.store.listEncryptedLibraryObjects.mockImplementation((input) =>
      Promise.resolve({
        surface: input.surface,
        items: pages[input.surface] ?? [],
        nextCursor: null
      })
    );

    const result = await createEncryptedLibraryBackfillOrchestrator(
      harness.value
    ).sweepVerificationBatch({ ownerId: OWNER, limit: 10 });

    expect(result).toEqual({
      complete: true,
      cursor: null,
      processed: 4,
      skippedLegacyIdempotency: 1
    });
    expect(harness.store.verifyEncryptedContentObject).toHaveBeenCalledTimes(3);
    expect(harness.resolveIdempotencyResponseCodec).toHaveBeenCalledOnce();
    expect(
      harness.aggregate.aggregate.openIdempotencyResponseForVerification
    ).toHaveBeenCalledOnce();
    expect(harness.aggregate.aggregate.verifyIdempotencyRequest).not.toHaveBeenCalled();
    expect(harness.aggregate.aggregate.openIdempotencyResponse).not.toHaveBeenCalled();
  });

  it("returns a bounded sweep cursor and fails closed when a logical response codec is unavailable", async () => {
    const bounded = dependencies({ candidates: [] });
    bounded.store.listEncryptedLibraryObjects.mockImplementation((input) =>
      Promise.resolve({
        surface: input.surface,
        items: input.surface === "note_content" ? [storedObject("note_content", IDS.note)] : [],
        nextCursor: null
      })
    );
    await expect(
      createEncryptedLibraryBackfillOrchestrator(bounded.value).sweepVerificationBatch({
        ownerId: OWNER,
        limit: 1
      })
    ).resolves.toEqual({
      complete: false,
      cursor: { surface: "note_content", afterResourceId: IDS.note },
      processed: 1,
      skippedLegacyIdempotency: 0
    });

    const unavailable = dependencies({ candidates: [] });
    unavailable.resolveIdempotencyResponseCodec.mockReturnValue(null);
    unavailable.store.listEncryptedLibraryObjects.mockImplementation((input) =>
      Promise.resolve({
        surface: input.surface,
        items:
          input.surface === "idempotency_response"
            ? [storedIdempotency("idempotency:logical-1", "logical_mac")]
            : [],
        nextCursor: null
      })
    );
    await expect(
      createEncryptedLibraryBackfillOrchestrator(unavailable.value).sweepVerificationBatch({
        ownerId: OWNER,
        limit: 10
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(unavailable.store.verifyEncryptedContentObject).not.toHaveBeenCalled();
  });

  it("does not persist verification evidence after cancellation", async () => {
    const harness = dependencies({ candidates: [] });
    const controller = new AbortController();
    let release: ((value: KeyedMacRecord) => void) | undefined;
    harness.store.listEncryptedLibraryObjects.mockImplementation((input) =>
      Promise.resolve({
        surface: input.surface,
        items: input.surface === "note_content" ? [storedObject("note_content", IDS.note)] : [],
        nextCursor: null
      })
    );
    vi.mocked(harness.aggregate.aggregate.createAggregateVerificationMac).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    const pending = createEncryptedLibraryBackfillOrchestrator(
      harness.value
    ).sweepVerificationBatch({ ownerId: OWNER, signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeDefined());
    controller.abort();
    release?.(harness.aggregate.verificationMac);

    await expect(pending).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    expect(harness.store.verifyEncryptedContentObject).not.toHaveBeenCalled();
  });
});
