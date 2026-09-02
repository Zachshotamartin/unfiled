import { describe, expect, it, vi } from "vitest";

import { CaptureReceiptPayloadSchema } from "@unfiled/encrypted-aggregate";
import type {
  AuthorizedOwnerAccess,
  EncryptedAggregateService,
  KeyedMacRecord,
  SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";

import type {
  EncryptedCaptureReceiptRead,
  EncryptedCaptureRpcAdapter
} from "./encrypted-capture-rpc-adapter";
import type {
  EncryptedNoteRead,
  EncryptedNoteReadRpcAdapter
} from "./encrypted-note-read-rpc-adapter";
import { createEncryptedNoteRetentionCoordinator } from "./encrypted-note-retention-coordinator";
import type {
  EncryptedNoteRetentionClaim,
  EncryptedNoteRetentionRpcStore
} from "./encrypted-note-retention-rpc-store";
import { ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER_ID = "81818181-8181-4181-8181-818181818181";
const RUN_ID = "81000000-0000-4000-8000-000000000001";
const LEASE_TOKEN = "81000000-0000-4000-8000-000000000002";
const CLAIM_ID = "81000000-0000-4000-8000-000000000003";
const CAPTURE_ID = "cap_81000000000000000000000001" as const;
const NOTE_ID = "note_81000000000000000000000001" as const;
const OTHER_NOTE_ID = "note_81000000000000000000000002" as const;
const OTHER_MUTATION_ID = "mut_81000000000000000000000002" as const;
const JOB_ID = "job_81000000000000000000000001" as const;
const REMOVED_ITEM_ID = "itm_81000000000000000000000003" as const;
const REMOVED_BLOCK_ID = "blk_81000000000000000000000004" as const;

const oldPayload = CaptureReceiptPayloadSchema.parse({
  schemaVersion: 1,
  captureId: CAPTURE_ID,
  jobId: JOB_ID,
  decisionId: null,
  reviewItemId: null,
  mutationId: null,
  outcome: "kept_in_inbox",
  headline: "Original receipt",
  destination: null,
  insertedContentReferences: [],
  actions: [],
  reasonCodes: ["retained"],
  createdAt: "2026-07-01T00:00:00.000Z"
});

const storedCipher = Object.freeze({
  ownerId: OWNER_ID,
  resourceId: CAPTURE_ID,
  recordVersion: 1,
  kind: "capture_receipt",
  envelope: Object.freeze({ marker: "stored" }),
  keyId: "retention.ai.object.v1",
  keyClass: "ai_assisted",
  keyPurpose: "object_wrap",
  keyVersion: 1
}) as unknown as SealedEncryptedAggregateRecord<"capture_receipt">;

const sealedCipher = Object.freeze({
  ...storedCipher,
  recordVersion: 2,
  envelope: Object.freeze({ marker: "resealed" }),
  reservationId: "81000000-0000-4000-8000-000000000004"
}) as unknown as SealedEncryptedAggregateRecord<"capture_receipt">;

const verificationMac = Object.freeze({
  value: "a".repeat(64),
  keyId: "retention.ai.mac.v1",
  keyClass: "ai_assisted",
  keyPurpose: "content_mac",
  keyVersion: 1
}) satisfies KeyedMacRecord;

function claim(overrides: Partial<EncryptedNoteRetentionClaim> = {}): EncryptedNoteRetentionClaim {
  return Object.freeze({
    claimId: CLAIM_ID,
    ownerId: OWNER_ID,
    noteId: NOTE_ID,
    deletedAt: "2026-07-01T00:00:00.000Z",
    contextDigest: "b".repeat(64),
    receiptContexts: Object.freeze([
      Object.freeze({ captureId: CAPTURE_ID, recordVersion: 1, privacy: "ai_assisted" })
    ]),
    replayed: false,
    ...overrides
  });
}

function receipt(
  overrides: Partial<EncryptedCaptureReceiptRead> = {}
): EncryptedCaptureReceiptRead {
  return Object.freeze({
    captureId: CAPTURE_ID,
    recordVersion: 1,
    privacy: "ai_assisted",
    jobId: JOB_ID,
    decisionId: null,
    reviewItemId: null,
    mutationId: null,
    outcome: "kept_in_inbox",
    destinationNoteId: null,
    reasonCodes: Object.freeze(["retained"]),
    createdAt: "2026-07-01T00:00:00.000Z",
    receiptCipher: storedCipher,
    ...overrides
  });
}

function harness(
  options: Readonly<{
    loaded?: EncryptedCaptureReceiptRead;
    opened?: ReturnType<typeof CaptureReceiptPayloadSchema.parse>;
    commitNoteId?: typeof NOTE_ID | typeof OTHER_NOTE_ID;
  }> = {}
) {
  let sealedPayload: unknown;
  const loaded = options.loaded ?? receipt();
  const aggregate = {
    openCaptureReceipt: vi.fn<EncryptedAggregateService["openCaptureReceipt"]>(
      (_access, record) => {
        if (record === loaded.receiptCipher) {
          return Promise.resolve(options.opened ?? oldPayload);
        }
        return Promise.resolve(CaptureReceiptPayloadSchema.parse(sealedPayload));
      }
    ),
    sealCaptureReceipt: vi.fn<EncryptedAggregateService["sealCaptureReceipt"]>((_access, input) => {
      sealedPayload = input.payload;
      return Promise.resolve(sealedCipher);
    }),
    openNoteContent: vi.fn<EncryptedAggregateService["openNoteContent"]>(() =>
      Promise.resolve({
        schemaVersion: 1,
        title: "Live sibling",
        bodyMarkdown: "",
        structuredData: { schemaVersion: 1 }
      })
    ),
    createAggregateVerificationMac: vi.fn(() => Promise.resolve(verificationMac)),
    verifyAggregateVerificationMac: vi.fn(() => Promise.resolve(true))
  } as unknown as EncryptedAggregateService;
  const captures = {
    getCaptureReceipt: vi.fn(() => Promise.resolve(loaded))
  } as unknown as Pick<EncryptedCaptureRpcAdapter, "getCaptureReceipt">;
  const notes = {
    getNote: vi.fn(() =>
      Promise.resolve({
        noteId: OTHER_NOTE_ID,
        currentRevision: 4,
        privacy: "ai_assisted",
        contentCipher: Object.freeze({ marker: "other-note-cipher" })
      } as unknown as EncryptedNoteRead)
    )
  } as Pick<EncryptedNoteReadRpcAdapter, "getNote">;
  const store = {
    commit: vi.fn(() =>
      Promise.resolve({
        claimId: CLAIM_ID,
        noteId: options.commitNoteId ?? NOTE_ID,
        purged: true as const,
        purgedCaptureCount: 1,
        purgedReceiptCount: 1,
        replayed: false
      })
    ),
    cancel: vi.fn(() =>
      Promise.resolve({
        claimId: CLAIM_ID,
        state: "cancelled" as const,
        cancelled: true,
        replayed: false
      })
    )
  } as unknown as EncryptedNoteRetentionRpcStore;
  const coordinator = createEncryptedNoteRetentionCoordinator({
    access: Object.freeze({}) as AuthorizedOwnerAccess,
    aggregate,
    captures,
    notes,
    store
  });
  return { aggregate, captures, coordinator, notes, sealedPayload: () => sealedPayload, store };
}

describe("encrypted note retention coordinator", () => {
  it("opens a legacy v1 receipt and commits a verified non-actionable v2 receipt", async () => {
    const test = harness();
    const result = await test.coordinator.processClaim({
      runId: RUN_ID,
      leaseToken: LEASE_TOKEN,
      claim: claim()
    });

    expect(result.purged).toBe(true);
    expect(test.sealedPayload()).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        outcome: "kept_in_inbox",
        headline: "Kept in Inbox after note expired",
        destination: null,
        reviewItemId: null,
        mutationId: null,
        insertedContentReferences: [],
        actions: [],
        undoTargets: [],
        reasonCodes: ["retained", "destination_expired"]
      })
    );
    expect(test.aggregate.verifyAggregateVerificationMac).toHaveBeenCalledOnce();
    expect(test.store.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        runId: RUN_ID,
        claimId: CLAIM_ID,
        leaseToken: LEASE_TOKEN,
        contextDigest: "b".repeat(64),
        receipts: [
          expect.objectContaining({
            captureId: CAPTURE_ID,
            recordVersion: 2,
            projection: { mode: "inbox", primary: null }
          })
        ]
      })
    );
    expect(test.store.cancel).not.toHaveBeenCalled();
  });

  it("cancels and fails closed when the fetched receipt no longer matches the claim context", async () => {
    const test = harness({ loaded: receipt({ recordVersion: 2 }) });
    await expect(
      test.coordinator.processClaim({ runId: RUN_ID, leaseToken: LEASE_TOKEN, claim: claim() })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(test.aggregate.openCaptureReceipt).not.toHaveBeenCalled();
    expect(test.store.commit).not.toHaveBeenCalled();
    expect(test.store.cancel).toHaveBeenCalledOnce();
  });

  it("removes an expired primary and promotes the first remaining authenticated target", async () => {
    const multiTarget = CaptureReceiptPayloadSchema.parse({
      schemaVersion: 2,
      captureId: CAPTURE_ID,
      jobId: JOB_ID,
      decisionId: "dec_81000000000000000000000001",
      reviewItemId: null,
      mutationId: "mut_81000000000000000000000001",
      outcome: "added_to_note",
      headline: "Updated two notes",
      destination: { noteId: NOTE_ID, title: "Expired note" },
      insertedContentReferences: [
        { type: "captured", itemId: REMOVED_ITEM_ID },
        { type: "ai_generated", blockId: REMOVED_BLOCK_ID }
      ],
      actions: [
        {
          type: "undo",
          mutationId: "mut_81000000000000000000000001",
          expectedRevision: 2
        }
      ],
      undoTargets: [
        {
          noteId: NOTE_ID,
          mutationId: "mut_81000000000000000000000001",
          expectedRevision: 2
        },
        {
          noteId: OTHER_NOTE_ID,
          mutationId: OTHER_MUTATION_ID,
          expectedRevision: 4
        }
      ],
      reasonCodes: ["multi_note"],
      createdAt: "2026-07-01T00:00:00.000Z"
    });
    const test = harness({
      loaded: receipt({
        decisionId: "dec_81000000000000000000000001",
        mutationId: "mut_81000000000000000000000001",
        outcome: "added_to_note",
        destinationNoteId: NOTE_ID,
        reasonCodes: Object.freeze(["multi_note"])
      })
    });
    vi.mocked(test.aggregate.openCaptureReceipt).mockResolvedValueOnce(multiTarget);

    await expect(
      test.coordinator.processClaim({ runId: RUN_ID, leaseToken: LEASE_TOKEN, claim: claim() })
    ).resolves.toMatchObject({ purged: true });
    expect(test.sealedPayload()).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        outcome: "added_to_note",
        destination: { noteId: OTHER_NOTE_ID, title: "Live sibling" },
        mutationId: OTHER_MUTATION_ID,
        insertedContentReferences: [{ type: "captured", itemId: null }],
        actions: [{ type: "undo", mutationId: OTHER_MUTATION_ID, expectedRevision: 4 }],
        undoTargets: [{ noteId: OTHER_NOTE_ID, mutationId: OTHER_MUTATION_ID, expectedRevision: 4 }]
      })
    );
    expect(JSON.stringify(test.sealedPayload())).not.toContain(NOTE_ID);
    expect(JSON.stringify(test.sealedPayload())).not.toContain(REMOVED_ITEM_ID);
    expect(JSON.stringify(test.sealedPayload())).not.toContain(REMOVED_BLOCK_ID);
    const commitInput = vi.mocked(test.store.commit).mock.calls[0]?.[0];
    expect(JSON.stringify(commitInput)).not.toContain("Live sibling");
    expect(JSON.stringify(commitInput)).not.toContain("Expired note");
    expect(test.store.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        receipts: [
          expect.objectContaining({
            projection: {
              mode: "routed",
              primary: {
                noteId: OTHER_NOTE_ID,
                mutationId: OTHER_MUTATION_ID,
                expectedRevision: 4,
                noteRecordVersion: 4
              }
            }
          })
        ]
      })
    );
    expect(test.store.cancel).not.toHaveBeenCalled();
  });

  it("removes an expired non-primary without changing the surviving primary", async () => {
    const payload = CaptureReceiptPayloadSchema.parse({
      schemaVersion: 2,
      captureId: CAPTURE_ID,
      jobId: JOB_ID,
      decisionId: "dec_81000000000000000000000001",
      reviewItemId: null,
      mutationId: OTHER_MUTATION_ID,
      outcome: "added_to_note",
      headline: "Updated both notes",
      destination: { noteId: OTHER_NOTE_ID, title: "Live sibling" },
      insertedContentReferences: [{ type: "captured", itemId: null }],
      actions: [{ type: "undo", mutationId: OTHER_MUTATION_ID, expectedRevision: 4 }],
      undoTargets: [
        {
          noteId: NOTE_ID,
          mutationId: "mut_81000000000000000000000001",
          expectedRevision: 2
        },
        { noteId: OTHER_NOTE_ID, mutationId: OTHER_MUTATION_ID, expectedRevision: 4 }
      ],
      reasonCodes: ["multi_note"],
      createdAt: "2026-07-01T00:00:00.000Z"
    });
    const test = harness({
      opened: payload,
      loaded: receipt({
        decisionId: "dec_81000000000000000000000001",
        mutationId: OTHER_MUTATION_ID,
        outcome: "added_to_note",
        destinationNoteId: OTHER_NOTE_ID,
        reasonCodes: Object.freeze(["multi_note"])
      })
    });

    await expect(
      test.coordinator.processClaim({ runId: RUN_ID, leaseToken: LEASE_TOKEN, claim: claim() })
    ).resolves.toMatchObject({ purged: true });
    expect(test.sealedPayload()).toEqual(
      expect.objectContaining({
        destination: { noteId: OTHER_NOTE_ID, title: "Live sibling" },
        mutationId: OTHER_MUTATION_ID,
        undoTargets: [{ noteId: OTHER_NOTE_ID, mutationId: OTHER_MUTATION_ID, expectedRevision: 4 }]
      })
    );
    const committedReceipt = vi.mocked(test.store.commit).mock.calls[0]?.[0].receipts[0];
    expect(committedReceipt?.projection.mode).toBe("routed");
    expect(committedReceipt?.projection.primary).toMatchObject({
      noteId: OTHER_NOTE_ID,
      mutationId: OTHER_MUTATION_ID
    });
  });

  it("makes the receipt non-actionable when the last authenticated target expires", async () => {
    const payload = CaptureReceiptPayloadSchema.parse({
      schemaVersion: 2,
      captureId: CAPTURE_ID,
      jobId: JOB_ID,
      decisionId: "dec_81000000000000000000000001",
      reviewItemId: null,
      mutationId: "mut_81000000000000000000000001",
      outcome: "added_to_note",
      headline: "Updated expired note",
      destination: { noteId: NOTE_ID, title: "Expired note" },
      insertedContentReferences: [{ type: "captured", itemId: null }],
      actions: [
        {
          type: "undo",
          mutationId: "mut_81000000000000000000000001",
          expectedRevision: 2
        }
      ],
      undoTargets: [
        {
          noteId: NOTE_ID,
          mutationId: "mut_81000000000000000000000001",
          expectedRevision: 2
        }
      ],
      reasonCodes: ["multi_note", "destination_expired"],
      createdAt: "2026-07-01T00:00:00.000Z"
    });
    const test = harness({
      opened: payload,
      loaded: receipt({
        decisionId: "dec_81000000000000000000000001",
        mutationId: "mut_81000000000000000000000001",
        outcome: "added_to_note",
        destinationNoteId: NOTE_ID,
        reasonCodes: Object.freeze(["multi_note", "destination_expired"])
      })
    });

    await expect(
      test.coordinator.processClaim({ runId: RUN_ID, leaseToken: LEASE_TOKEN, claim: claim() })
    ).resolves.toMatchObject({ purged: true });
    expect(test.sealedPayload()).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        outcome: "kept_in_inbox",
        destination: null,
        mutationId: null,
        insertedContentReferences: [],
        actions: [],
        undoTargets: []
      })
    );
    expect(test.notes.getNote).not.toHaveBeenCalled();
    expect(test.store.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        receipts: [expect.objectContaining({ projection: { mode: "inbox", primary: null } })]
      })
    );
  });

  it("accepts the bounded E3 pending-receipt sentinel before retention reconciliation", async () => {
    const expansionPayload = CaptureReceiptPayloadSchema.parse({
      schemaVersion: 2,
      captureId: CAPTURE_ID,
      jobId: JOB_ID,
      decisionId: "dec_81000000000000000000000001",
      reviewItemId: "rvw_81000000000000000000000001",
      mutationId: "mut_81000000000000000000000001",
      outcome: "added_to_note",
      headline: "Added to a note",
      destination: { noteId: NOTE_ID, title: "Shopping" },
      insertedContentReferences: [
        { type: "captured", itemId: REMOVED_ITEM_ID },
        { type: "ai_generated", blockId: REMOVED_BLOCK_ID }
      ],
      actions: [
        { type: "open", noteId: NOTE_ID },
        {
          type: "move",
          noteId: NOTE_ID,
          decisionId: "dec_81000000000000000000000001"
        },
        {
          type: "undo",
          mutationId: "mut_81000000000000000000000001",
          expectedRevision: 2
        }
      ],
      reasonCodes: ["semantic_match"],
      createdAt: "2026-07-01T00:00:00.000Z",
      undoTargets: [
        {
          noteId: NOTE_ID,
          mutationId: "mut_81000000000000000000000001",
          expectedRevision: 2
        }
      ]
    });
    const test = harness({
      opened: expansionPayload,
      loaded: receipt({
        decisionId: expansionPayload.decisionId,
        reviewItemId: expansionPayload.reviewItemId,
        mutationId: expansionPayload.mutationId,
        outcome: "added_to_note",
        destinationNoteId: NOTE_ID,
        reasonCodes: ["expansion_pending"]
      })
    });

    await expect(
      test.coordinator.processClaim({ runId: RUN_ID, leaseToken: LEASE_TOKEN, claim: claim() })
    ).resolves.toMatchObject({ purged: true });
    expect(test.sealedPayload()).toMatchObject({
      outcome: "kept_in_inbox",
      reviewItemId: null,
      insertedContentReferences: [],
      reasonCodes: ["semantic_match", "destination_expired"]
    });
  });

  it("does not commit after cancellation is observed", async () => {
    const test = harness();
    const signal = new AbortController();
    signal.abort();
    await expect(
      test.coordinator.processClaim({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        claim: claim(),
        signal: signal.signal
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(test.captures.getCaptureReceipt).not.toHaveBeenCalled();
    expect(test.store.commit).not.toHaveBeenCalled();
    expect(test.store.cancel).toHaveBeenCalledOnce();
  });

  it("cancels without reflecting provider errors when commit CAS rejects a fetch race", async () => {
    const test = harness();
    vi.mocked(test.store.commit).mockRejectedValueOnce(
      Object.assign(new Error("opaque"), { code: "stale_revision" })
    );
    await expect(
      test.coordinator.processClaim({ runId: RUN_ID, leaseToken: LEASE_TOKEN, claim: claim() })
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(test.store.cancel).toHaveBeenCalledOnce();
  });
});
