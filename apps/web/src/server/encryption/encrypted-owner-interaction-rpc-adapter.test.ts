import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import type { AggregateContentKind, KeyedMacRpcValue } from "@unfiled/encrypted-aggregate";
import type { KeyClass, ManagedKeyRecordV1 } from "@unfiled/key-management";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedOwnerInteractionRpcAdapter,
  encryptedOwnerInteractionRpcFunctions
} from "./encrypted-owner-interaction-rpc-adapter";
import { ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-01T12:00:00.000Z";
const POSTGREST_OCCURRED_AT = "2026-09-01T05:00:00.123456-07:00";
const CANONICAL_OCCURRED_AT = "2026-09-01T12:00:00.123456Z";
const NOTE = `note_${"0".repeat(26)}` as const;
const NOTE_B = `note_${"4".repeat(26)}` as const;
const MUTATION = `mut_${"1".repeat(26)}` as const;
const OUTPUT_MUTATION = `mut_${"5".repeat(26)}` as const;
const REVISION = `rev_${"6".repeat(26)}` as const;
const BEFORE_REVISION = `rev_${"A".repeat(26)}` as const;
const AFTER_REVISION = `rev_${"B".repeat(26)}` as const;
const SOURCE_REVISION = `rev_${"C".repeat(26)}` as const;
const SOURCE_MUTATION = `mut_${"D".repeat(26)}` as const;
const DECISION = `dec_${"2".repeat(26)}` as const;
const REVIEW = `rvw_${"3".repeat(26)}` as const;
const CAPTURE = `cap_${"7".repeat(26)}` as const;
const FEEDBACK = `fbk_${"8".repeat(26)}` as const;
const JOB = `job_${"9".repeat(26)}` as const;
const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDEMPOTENCY = "owner-interaction-01";

function client(implementation: ServiceRpcClient["rpc"]): ServiceRpcClient {
  return Object.freeze({ rpc: implementation });
}

function envelope(
  kind: AggregateContentKind,
  resourceId: string,
  recordVersion: number,
  keyClass: KeyClass,
  ownerId = OWNER
): ContentEnvelopeV1 {
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: `${keyClass}.object_wrap.v1`,
    context: Object.freeze({ tenantId: ownerId, resourceId, recordVersion, kind }),
    wrappedDataKey: Object.freeze({ nonce: "A".repeat(16), ciphertext: "a".repeat(64) }),
    payload: Object.freeze({ nonce: "B".repeat(16), ciphertext: "b".repeat(64) })
  });
}

function storedCipher(
  kind: AggregateContentKind,
  resourceId: string,
  recordVersion: number,
  keyClass: KeyClass = "ai_assisted",
  ownerId = OWNER
): Record<string, unknown> {
  return Object.freeze({
    envelope: envelope(kind, resourceId, recordVersion, keyClass, ownerId),
    keyId: `${keyClass}.object_wrap.v1`,
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1
  });
}

function key(
  purpose: "content_mac" | "object_wrap",
  keyClass: KeyClass = "ai_assisted",
  ownerId = OWNER
): ManagedKeyRecordV1 {
  return Object.freeze({
    schemaVersion: 1,
    ownerId,
    keyClass,
    purpose,
    keyId: `${keyClass}.${purpose}.v1`,
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: "AQIDBA",
    rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555",
    createdAt: NOW,
    activatedAt: NOW,
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 0,
    wrapOperationLimit: 16_777_216,
    rotation: Object.freeze({
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    })
  });
}

function retiredKey(
  purpose: "content_mac" | "object_wrap",
  keyClass: KeyClass = "ai_assisted",
  ownerId = OWNER
): ManagedKeyRecordV1 {
  return Object.freeze({
    ...key(purpose, keyClass, ownerId),
    status: "retired" as const,
    retiredAt: NOW
  });
}

function reservation(
  role:
    | "review"
    | "receipt"
    | "response"
    | `note_content:${number}`
    | `note_revision:${number}`
    | `note_mutation:${number}`,
  surface:
    | "note_content"
    | "note_revision"
    | "note_mutation"
    | "review_item"
    | "capture_receipt"
    | "idempotency_response",
  resourceId: string,
  recordVersion: number,
  ordinal: number,
  keyClass: KeyClass = "ai_assisted"
): Record<string, unknown> {
  return Object.freeze({
    role,
    surface,
    resourceId,
    recordVersion,
    keyClass,
    reservationId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
    key: key("object_wrap", keyClass)
  });
}

function pendingPrivateReviewCreateRow(
  receiptReviewItemId: string | null = REVIEW
): Record<string, unknown> {
  const keyClass = "private_manual" as const;
  return {
    scope: "encrypted_review_resolution",
    action: "create",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: false,
    replayed: false,
    requestMacKey: key("content_mac", keyClass),
    ids: {
      reviewItemId: REVIEW,
      destinationNoteId: NOTE_B,
      destinationRevisionId: REVISION,
      destinationMutationId: OUTPUT_MUTATION
    },
    source: {
      decision: null,
      review: {
        reviewItemId: REVIEW,
        captureId: CAPTURE,
        noteId: null,
        type: "low_confidence",
        state: "open",
        recordVersion: 1,
        contentCipher: storedCipher("review_item", REVIEW, 1, keyClass),
        createdAt: POSTGREST_OCCURRED_AT,
        resolvedAt: null
      },
      receipt: {
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: receiptReviewItemId,
        mutationId: null,
        outcome: "needs_review",
        destinationNoteId: null,
        reasonCodes: ["low_confidence"],
        recordVersion: 1,
        sourcePrivacy: keyClass,
        receiptCipher: storedCipher("capture_receipt", CAPTURE, 1, keyClass)
      },
      capture: {
        captureId: CAPTURE,
        recordVersion: 1,
        privacy: keyClass,
        status: "needs_review",
        contentLength: 7,
        contentCipher: storedCipher("capture", CAPTURE, 1, keyClass),
        contentMac: requestMac(keyClass)
      }
    },
    members: [
      {
        ordinal: 0,
        role: "destination_write",
        noteId: NOTE_B,
        targetMutationId: null,
        expectedRevision: 0,
        sourcePrivacy: null,
        targetPrivacy: keyClass,
        revisionId: REVISION,
        mutationId: OUTPUT_MUTATION,
        currentNote: null,
        currentMutation: null
      }
    ],
    reservations: [
      reservation("note_content:0", "note_content", NOTE_B, 1, 10, keyClass),
      reservation("note_revision:0", "note_revision", REVISION, 1, 11, keyClass),
      reservation("note_mutation:0", "note_mutation", OUTPUT_MUTATION, 1, 12, keyClass),
      reservation("review", "review_item", REVIEW, 2, 13, keyClass),
      reservation("receipt", "capture_receipt", CAPTURE, 2, 14, keyClass),
      reservation("response", "idempotency_response", `idempotency:${IDEMPOTENCY}`, 1, 15, keyClass)
    ],
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  };
}

function pendingCrossClassReviewRouteRow(
  sourceClass: KeyClass,
  destinationClass: KeyClass
): Record<string, unknown> {
  const interactionClass = "private_manual" as const;
  return {
    scope: "encrypted_review_resolution",
    action: "route",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: false,
    replayed: false,
    requestMacKey: key("content_mac", interactionClass),
    ids: {
      reviewItemId: REVIEW,
      destinationNoteId: NOTE_B,
      destinationRevisionId: REVISION,
      destinationMutationId: OUTPUT_MUTATION
    },
    source: {
      decision: null,
      review: {
        reviewItemId: REVIEW,
        captureId: CAPTURE,
        noteId: null,
        type: "low_confidence",
        state: "open",
        recordVersion: 1,
        contentCipher: storedCipher("review_item", REVIEW, 1, sourceClass),
        createdAt: POSTGREST_OCCURRED_AT,
        resolvedAt: null
      },
      receipt: {
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review",
        destinationNoteId: null,
        reasonCodes: ["low_confidence"],
        recordVersion: 1,
        sourcePrivacy: sourceClass,
        receiptCipher: storedCipher("capture_receipt", CAPTURE, 1, sourceClass)
      },
      capture: {
        captureId: CAPTURE,
        recordVersion: 1,
        privacy: sourceClass,
        status: "needs_review",
        contentLength: 7,
        contentCipher: storedCipher("capture", CAPTURE, 1, sourceClass),
        contentMac: requestMac(sourceClass)
      }
    },
    members: [
      {
        ordinal: 0,
        role: "destination_write",
        noteId: NOTE_B,
        targetMutationId: null,
        expectedRevision: 1,
        sourcePrivacy: destinationClass,
        targetPrivacy: destinationClass,
        revisionId: REVISION,
        mutationId: OUTPUT_MUTATION,
        currentNote: noteProjection(NOTE_B, destinationClass, 1),
        currentMutation: null
      }
    ],
    reservations: [
      reservation("note_content:0", "note_content", NOTE_B, 2, 10, destinationClass),
      reservation("note_revision:0", "note_revision", REVISION, 2, 11, destinationClass),
      reservation("note_mutation:0", "note_mutation", OUTPUT_MUTATION, 2, 12, destinationClass),
      reservation("review", "review_item", REVIEW, 2, 13, interactionClass),
      reservation("receipt", "capture_receipt", CAPTURE, 2, 14, sourceClass),
      reservation(
        "response",
        "idempotency_response",
        `idempotency:${IDEMPOTENCY}`,
        1,
        15,
        interactionClass
      )
    ],
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  };
}

function pendingLinkedReviewDismissRow(): Record<string, unknown> {
  return {
    scope: "encrypted_review_resolution",
    action: "dismiss",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: false,
    replayed: false,
    requestMacKey: key("content_mac"),
    ids: {
      reviewItemId: REVIEW,
      destinationNoteId: null,
      destinationRevisionId: null,
      destinationMutationId: null
    },
    source: {
      decision: null,
      review: {
        reviewItemId: REVIEW,
        captureId: CAPTURE,
        noteId: null,
        type: "revision_conflict",
        state: "open",
        recordVersion: 1,
        contentCipher: storedCipher("review_item", REVIEW, 1),
        createdAt: POSTGREST_OCCURRED_AT,
        resolvedAt: null
      },
      receipt: {
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: null,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review",
        destinationNoteId: null,
        reasonCodes: ["revision_conflict"],
        recordVersion: 1,
        sourcePrivacy: "ai_assisted",
        receiptCipher: storedCipher("capture_receipt", CAPTURE, 1)
      },
      capture: null
    },
    members: [],
    reservations: [
      reservation("review", "review_item", REVIEW, 2, 20),
      reservation("response", "idempotency_response", `idempotency:${IDEMPOTENCY}`, 1, 22)
    ],
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  };
}

function noteProjection(
  noteId: string,
  privacy: KeyClass,
  currentRevision = 2
): Record<string, unknown> {
  return {
    noteId,
    currentRevision,
    spaceId: null,
    type: "generic",
    dailyDate: null,
    isOpen: true,
    pinnedAt: null,
    privacy,
    archivedAt: null,
    deletedAt: null,
    createdAt: POSTGREST_OCCURRED_AT,
    updatedAt: POSTGREST_OCCURRED_AT,
    contentCipher: storedCipher("note_content", noteId, currentRevision, privacy),
    space: null,
    tags: [],
    links: []
  };
}

function mutationSnapshot(
  revisionId: string,
  revision: number,
  privacy: KeyClass,
  keyClass: KeyClass
): Record<string, unknown> {
  return {
    revisionId,
    revision,
    privacy,
    snapshotCipher: storedCipher("note_revision", revisionId, revision, keyClass),
    snapshotMac: requestMac(keyClass)
  };
}

function mutationProjection(
  noteId: string,
  currentPrivacy: KeyClass,
  restoredPrivacy: KeyClass
): Record<string, unknown> {
  const historyClass =
    currentPrivacy === "private_manual" || restoredPrivacy === "private_manual"
      ? "private_manual"
      : "ai_assisted";
  return {
    mutationId: MUTATION,
    noteId,
    decisionId: DECISION,
    idempotencyKey: "source-mutation",
    beforeRevision: 1,
    afterRevision: 2,
    undoneAt: null,
    createdAt: POSTGREST_OCCURRED_AT,
    mutationCipher: storedCipher("note_mutation", MUTATION, 2, historyClass),
    currentNote: noteProjection(noteId, currentPrivacy),
    beforeSnapshot: mutationSnapshot(BEFORE_REVISION, 1, restoredPrivacy, historyClass),
    afterSnapshot: mutationSnapshot(AFTER_REVISION, 2, currentPrivacy, historyClass)
  };
}

function pendingReversePrivateCorrectionRow(): Record<string, unknown> {
  const sourceNote = NOTE_B;
  const destinationNote = NOTE;
  const sourcePrivacy = "private_manual" as const;
  return {
    scope: "encrypted_decision_correction",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: false,
    replayed: false,
    selectedOutcome: null,
    requestMacKey: key("content_mac", sourcePrivacy),
    ids: {
      decisionId: DECISION,
      sourceNoteId: sourceNote,
      destinationNoteId: destinationNote,
      captureId: CAPTURE
    },
    source: {
      decision: {
        decisionId: DECISION,
        captureId: CAPTURE,
        recordVersion: 1,
        destinationNoteId: sourceNote,
        contentCipher: storedCipher("organization_decision", DECISION, 1)
      },
      review: null,
      receipt: {
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: null,
        mutationId: MUTATION,
        outcome: "added_to_note",
        destinationNoteId: sourceNote,
        reasonCodes: ["semantic_match"],
        recordVersion: 1,
        sourcePrivacy: "ai_assisted",
        receiptCipher: storedCipher("capture_receipt", CAPTURE, 1)
      },
      capture: null
    },
    members: [
      {
        ordinal: 0,
        role: "source_removal",
        noteId: sourceNote,
        targetMutationId: MUTATION,
        expectedRevision: 2,
        sourcePrivacy,
        targetPrivacy: sourcePrivacy,
        revisionId: SOURCE_REVISION,
        mutationId: SOURCE_MUTATION,
        currentNote: noteProjection(sourceNote, sourcePrivacy),
        currentMutation: mutationProjection(sourceNote, sourcePrivacy, sourcePrivacy)
      },
      {
        ordinal: 1,
        role: "destination_write",
        noteId: destinationNote,
        targetMutationId: null,
        expectedRevision: 0,
        sourcePrivacy: null,
        targetPrivacy: sourcePrivacy,
        revisionId: REVISION,
        mutationId: OUTPUT_MUTATION,
        currentNote: null,
        currentMutation: null
      }
    ],
    commonReservations: [
      reservation("receipt", "capture_receipt", CAPTURE, 2, 30),
      reservation(
        "response",
        "idempotency_response",
        `idempotency:${IDEMPOTENCY}`,
        1,
        31,
        sourcePrivacy
      )
    ],
    branches: {
      applied: { available: false, feedbackEventId: null, batchId: null, reservations: [] },
      needsReview: {
        available: true,
        reviewItemId: REVIEW,
        reservations: [reservation("review", "review_item", REVIEW, 1, 32, sourcePrivacy)]
      }
    },
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  };
}

function reviewPreparationRow(
  requestMacKey: ManagedKeyRecordV1 = key("content_mac")
): Record<string, unknown> {
  return {
    scope: "encrypted_review_resolution",
    action: "keep_both",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: true,
    replayed: true,
    requestMacKey,
    ids: {
      reviewItemId: REVIEW,
      destinationNoteId: null,
      destinationRevisionId: null,
      destinationMutationId: null
    },
    source: null,
    members: [],
    reservations: [],
    encryptedResponse: storedCipher("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
    encryptedResponseVerificationMac: requestMac()
  };
}

function pendingReviewPreparationRow(requestMacKey: ManagedKeyRecordV1): Record<string, unknown> {
  return {
    scope: "encrypted_review_resolution",
    action: "keep_both",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: false,
    replayed: false,
    requestMacKey,
    ids: {
      reviewItemId: REVIEW,
      destinationNoteId: null,
      destinationRevisionId: null,
      destinationMutationId: null
    },
    source: {
      decision: null,
      review: {
        reviewItemId: REVIEW,
        captureId: null,
        noteId: null,
        type: "duplicate_suggestion",
        state: "open",
        recordVersion: 1,
        contentCipher: storedCipher("review_item", REVIEW, 1),
        createdAt: POSTGREST_OCCURRED_AT,
        resolvedAt: null
      },
      receipt: null,
      capture: null
    },
    members: [],
    reservations: [
      reservation("review", "review_item", REVIEW, 2, 1),
      reservation("response", "idempotency_response", `idempotency:${IDEMPOTENCY}`, 1, 2)
    ],
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  };
}

function completedCorrectionRow(
  requestMacKey: ManagedKeyRecordV1 = key("content_mac")
): Record<string, unknown> {
  return {
    scope: "encrypted_decision_correction",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: true,
    replayed: true,
    selectedOutcome: "needs_review",
    requestMacKey,
    ids: {
      decisionId: DECISION,
      sourceNoteId: NOTE,
      destinationNoteId: NOTE_B,
      captureId: CAPTURE
    },
    source: null,
    members: [],
    commonReservations: [],
    branches: {
      applied: {
        available: false,
        feedbackEventId: FEEDBACK,
        batchId: BATCH,
        reservations: []
      },
      needsReview: { available: true, reviewItemId: REVIEW, reservations: [] }
    },
    encryptedResponse: storedCipher("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
    encryptedResponseVerificationMac: requestMac()
  };
}

function completedBatchRow(
  requestMacKey: ManagedKeyRecordV1 = key("content_mac")
): Record<string, unknown> {
  return {
    scope: "encrypted_mutation_batch_undo",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: true,
    replayed: true,
    selectedOutcome: "applied",
    requestMacKey,
    ids: {
      anchorMutationId: MUTATION,
      sourceBatchKind: "organization",
      restoredSourceTargetMutationId: null
    },
    source: null,
    members: [],
    commonReservations: [],
    branches: {
      applied: { available: true, batchId: BATCH, reservations: [] },
      needsReview: { available: false, reviewItemId: REVIEW, reservations: [] }
    },
    encryptedResponse: storedCipher("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
    encryptedResponseVerificationMac: requestMac()
  };
}

function pendingHistoricallyPrivateBatchRow(): Record<string, unknown> {
  const currentNote = noteProjection(NOTE, "ai_assisted", 3);
  const currentMutation = {
    mutationId: MUTATION,
    noteId: NOTE,
    decisionId: DECISION,
    idempotencyKey: "historically-private-mutation",
    beforeRevision: 1,
    afterRevision: 2,
    undoneAt: null,
    createdAt: POSTGREST_OCCURRED_AT,
    mutationCipher: storedCipher("note_mutation", MUTATION, 2, "private_manual"),
    currentNote,
    beforeSnapshot: mutationSnapshot(BEFORE_REVISION, 1, "ai_assisted", "private_manual"),
    afterSnapshot: mutationSnapshot(AFTER_REVISION, 2, "private_manual", "private_manual")
  };
  return {
    scope: "encrypted_mutation_batch_undo",
    occurredAt: POSTGREST_OCCURRED_AT,
    completed: false,
    replayed: false,
    selectedOutcome: null,
    requestMacKey: key("content_mac", "private_manual"),
    ids: {
      anchorMutationId: MUTATION,
      sourceBatchKind: "organization",
      restoredSourceTargetMutationId: null
    },
    source: { decision: null, review: null, receipt: null, capture: null },
    members: [
      {
        ordinal: 0,
        role: "undo",
        noteId: NOTE,
        targetMutationId: MUTATION,
        expectedRevision: 3,
        sourcePrivacy: "ai_assisted",
        targetPrivacy: "ai_assisted",
        revisionId: REVISION,
        mutationId: OUTPUT_MUTATION,
        currentNote,
        currentMutation
      }
    ],
    commonReservations: [
      reservation(
        "response",
        "idempotency_response",
        `idempotency:${IDEMPOTENCY}`,
        1,
        14,
        "private_manual"
      )
    ],
    branches: {
      applied: {
        available: true,
        batchId: BATCH,
        reservations: [
          reservation("note_content:0", "note_content", NOTE, 4, 10),
          reservation("note_revision:0", "note_revision", REVISION, 4, 11),
          reservation("note_mutation:0", "note_mutation", OUTPUT_MUTATION, 4, 12)
        ]
      },
      needsReview: {
        available: true,
        reviewItemId: REVIEW,
        reservations: [reservation("review", "review_item", REVIEW, 1, 13, "private_manual")]
      }
    },
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  };
}

function requestMac(keyClass: KeyClass = "ai_assisted"): KeyedMacRpcValue {
  return Object.freeze({
    mac: "a".repeat(64),
    keyId: `${keyClass}.content_mac.v1`,
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: 1
  });
}

describe("encrypted owner-interaction RPC adapter", () => {
  it("publishes only the six frozen owner-interaction RPC capabilities", () => {
    expect(encryptedOwnerInteractionRpcFunctions).toEqual([
      "prepare_encrypted_decision_correction",
      "commit_encrypted_decision_correction",
      "prepare_encrypted_review_resolution",
      "commit_encrypted_review_resolution",
      "get_encrypted_mutation_batch",
      "undo_encrypted_mutation_batch"
    ]);
    expect(new Set(encryptedOwnerInteractionRpcFunctions).size).toBe(
      encryptedOwnerInteractionRpcFunctions.length
    );
  });

  it("sends content-free correction intent and rejects an invalid provider projection", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>(() => Promise.resolve({}));
    const adapter = createEncryptedOwnerInteractionRpcAdapter(client(rpc));

    await expect(
      adapter.prepareDecisionCorrection({
        ownerId: OWNER,
        decisionId: DECISION,
        request: {
          idempotencyKey: IDEMPOTENCY,
          source: { noteId: NOTE, expectedRevision: 2 },
          destination: {
            type: "new_note",
            title: "Sensitive destination title",
            noteType: "generic",
            spaceId: null
          }
        }
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });

    expect(rpc).toHaveBeenCalledWith("prepare_encrypted_decision_correction", {
      p_owner_id: OWNER,
      p_decision_id: DECISION,
      p_idempotency_key: IDEMPOTENCY,
      p_request: {
        source: { noteId: NOTE, expectedRevision: 2 },
        destination: { type: "new_note", noteType: "generic", spaceId: null }
      }
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("Sensitive destination title");
  });

  it("strips a Review create title and lets the database derive batch membership", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>(() => Promise.resolve({}));
    const adapter = createEncryptedOwnerInteractionRpcAdapter(client(rpc));

    await expect(
      adapter.prepareReviewResolution({
        ownerId: OWNER,
        reviewItemId: REVIEW,
        request: {
          idempotencyKey: IDEMPOTENCY,
          resolution: {
            type: "create",
            title: "Sensitive Review title",
            noteType: "project",
            spaceId: null
          }
        }
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    await expect(
      adapter.getMutationBatch({
        ownerId: OWNER,
        mutationId: MUTATION,
        request: { expectedRevision: 3, idempotencyKey: IDEMPOTENCY }
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });

    expect(rpc.mock.calls[0]).toEqual([
      "prepare_encrypted_review_resolution",
      {
        p_owner_id: OWNER,
        p_review_item_id: REVIEW,
        p_idempotency_key: IDEMPOTENCY,
        p_resolution: { type: "create", noteType: "project", spaceId: null }
      }
    ]);
    expect(rpc.mock.calls[1]).toEqual([
      "get_encrypted_mutation_batch",
      {
        p_owner_id: OWNER,
        p_mutation_id: MUTATION,
        p_expected_revision: 3,
        p_idempotency_key: IDEMPOTENCY
      }
    ]);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("Sensitive Review title");
  });

  it("keeps pending preparations active-key-only", async () => {
    const request = {
      ownerId: OWNER,
      reviewItemId: REVIEW,
      request: {
        idempotencyKey: IDEMPOTENCY,
        resolution: { type: "keep_both" as const }
      }
    };

    await expect(
      createEncryptedOwnerInteractionRpcAdapter(
        client(() => Promise.resolve(pendingReviewPreparationRow(key("content_mac"))))
      ).prepareReviewResolution(request)
    ).resolves.toMatchObject({
      completed: false,
      replayed: false,
      occurredAt: CANONICAL_OCCURRED_AT,
      source: { review: { createdAt: CANONICAL_OCCURRED_AT } }
    });

    await expect(
      createEncryptedOwnerInteractionRpcAdapter(
        client(() => Promise.resolve(pendingReviewPreparationRow(retiredKey("content_mac"))))
      ).prepareReviewResolution(request)
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("accepts a private-manual Review create and rejects a missing or substituted receipt link", async () => {
    const request = {
      ownerId: OWNER,
      reviewItemId: REVIEW,
      request: {
        idempotencyKey: IDEMPOTENCY,
        resolution: {
          type: "create" as const,
          title: "Private destination",
          noteType: "generic" as const,
          spaceId: null
        }
      }
    };

    await expect(
      createEncryptedOwnerInteractionRpcAdapter(
        client(() => Promise.resolve(pendingPrivateReviewCreateRow()))
      ).prepareReviewResolution(request)
    ).resolves.toMatchObject({
      completed: false,
      requestMacKey: { keyClass: "private_manual" },
      source: {
        review: { reviewItemId: REVIEW, captureId: CAPTURE },
        receipt: { reviewItemId: REVIEW, sourcePrivacy: "private_manual" }
      },
      members: [{ role: "destination_write", targetPrivacy: "private_manual" }]
    });

    for (const receiptReviewItemId of [null, `rvw_${"A".repeat(26)}`]) {
      await expect(
        createEncryptedOwnerInteractionRpcAdapter(
          client(() => Promise.resolve(pendingPrivateReviewCreateRow(receiptReviewItemId)))
        ).prepareReviewResolution(request)
      ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    }
  });

  it.each([
    ["ai_assisted", "private_manual"],
    ["private_manual", "ai_assisted"]
  ] as const)(
    "keeps Review routing sticky across %s source and %s destination privacy",
    async (sourceClass, destinationClass) => {
      const result = createEncryptedOwnerInteractionRpcAdapter(
        client(() =>
          Promise.resolve(pendingCrossClassReviewRouteRow(sourceClass, destinationClass))
        )
      ).prepareReviewResolution({
        ownerId: OWNER,
        reviewItemId: REVIEW,
        request: {
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "route", noteId: NOTE_B, expectedRevision: 1 }
        }
      });

      const preparation = await result;
      expect(preparation).toMatchObject({
        completed: false,
        requestMacKey: { keyClass: "private_manual" },
        source: { review: { contentCipher: { keyClass: sourceClass } } },
        members: [
          {
            sourcePrivacy: destinationClass,
            targetPrivacy: destinationClass
          }
        ]
      });
      expect(preparation.reservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "review", keyClass: "private_manual" }),
          expect.objectContaining({ role: "response", keyClass: "private_manual" }),
          expect.objectContaining({ role: "note_content:0", keyClass: destinationClass }),
          expect.objectContaining({ role: "note_revision:0", keyClass: destinationClass }),
          expect.objectContaining({ role: "note_mutation:0", keyClass: destinationClass })
        ])
      );
    }
  );

  it("allows a capture-linked Review dismiss after capture retention while preserving receipt binding", async () => {
    await expect(
      createEncryptedOwnerInteractionRpcAdapter(
        client(() => Promise.resolve(pendingLinkedReviewDismissRow()))
      ).prepareReviewResolution({
        ownerId: OWNER,
        reviewItemId: REVIEW,
        request: {
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "dismiss" }
        }
      })
    ).resolves.toMatchObject({
      action: "dismiss",
      source: {
        review: { captureId: CAPTURE },
        receipt: { reviewItemId: REVIEW },
        capture: null
      }
    });
  });

  it("accepts reverse-ID corrections and binds conflict Review privacy to the current source note", async () => {
    const result = createEncryptedOwnerInteractionRpcAdapter(
      client(() => Promise.resolve(pendingReversePrivateCorrectionRow()))
    ).prepareDecisionCorrection({
      ownerId: OWNER,
      decisionId: DECISION,
      request: {
        idempotencyKey: IDEMPOTENCY,
        source: { noteId: NOTE_B, expectedRevision: 2 },
        destination: {
          type: "new_note",
          title: "Reverse destination",
          noteType: "generic",
          spaceId: null
        }
      }
    });

    await expect(result).resolves.toMatchObject({
      completed: false,
      requestMacKey: { keyClass: "private_manual" },
      members: [
        { role: "source_removal", noteId: NOTE_B, sourcePrivacy: "private_manual" },
        { role: "destination_write", noteId: NOTE, targetPrivacy: "private_manual" }
      ],
      branches: {
        needsReview: {
          available: true,
          reservations: [{ keyClass: "private_manual" }]
        }
      }
    });
  });

  it("accepts a reverse-ID correction commit result in semantic member order", async () => {
    const completed = completedCorrectionRow(key("content_mac", "private_manual"));
    const preparationRow = {
      ...completed,
      selectedOutcome: "applied",
      ids: {
        decisionId: DECISION,
        sourceNoteId: NOTE_B,
        destinationNoteId: NOTE,
        captureId: CAPTURE
      },
      branches: {
        applied: {
          available: true,
          feedbackEventId: FEEDBACK,
          batchId: BATCH,
          reservations: []
        },
        needsReview: { available: false, reviewItemId: REVIEW, reservations: [] }
      },
      encryptedResponse: storedCipher(
        "idempotency_response",
        `idempotency:${IDEMPOTENCY}`,
        1,
        "private_manual"
      ),
      encryptedResponseVerificationMac: requestMac("private_manual")
    };
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((functionName) => {
      if (functionName === "prepare_encrypted_decision_correction") {
        return Promise.resolve(preparationRow);
      }
      if (functionName === "commit_encrypted_decision_correction") {
        return Promise.resolve({
          scope: "encrypted_decision_correction",
          outcome: "applied",
          decisionId: DECISION,
          reviewItemId: null,
          feedbackEventId: FEEDBACK,
          batchId: BATCH,
          members: [
            {
              role: "source_removal",
              noteId: NOTE_B,
              currentRevision: 3,
              revisionId: SOURCE_REVISION,
              mutationId: SOURCE_MUTATION
            },
            {
              role: "destination_write",
              noteId: NOTE,
              currentRevision: 1,
              revisionId: REVISION,
              mutationId: OUTPUT_MUTATION
            }
          ],
          encryptedResponse: storedCipher(
            "idempotency_response",
            `idempotency:${IDEMPOTENCY}`,
            1,
            "private_manual"
          ),
          responseVerificationMac: requestMac("private_manual"),
          replayed: true
        });
      }
      return Promise.reject(new Error("unexpected RPC"));
    });
    const adapter = createEncryptedOwnerInteractionRpcAdapter(client(rpc));
    const request = {
      idempotencyKey: IDEMPOTENCY,
      source: { noteId: NOTE_B, expectedRevision: 2 },
      destination: {
        type: "new_note" as const,
        title: "Reverse destination",
        noteType: "generic" as const,
        spaceId: null
      }
    };

    const preparation = await adapter.prepareDecisionCorrection({
      ownerId: OWNER,
      decisionId: DECISION,
      request
    });
    const result = await adapter.commitDecisionCorrection({
      ownerId: OWNER,
      decisionId: DECISION,
      idempotencyKey: IDEMPOTENCY,
      preparation,
      command: { selectedOutcome: "applied", requestMac: requestMac("private_manual") }
    });

    expect(result.members.map(({ role, noteId }) => ({ role, noteId }))).toEqual([
      { role: "source_removal", noteId: NOTE_B },
      { role: "destination_write", noteId: NOTE }
    ]);
  });

  it("accepts a completed Review replay with its retired request-MAC key", async () => {
    const preparationRow = reviewPreparationRow(retiredKey("content_mac"));
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((functionName) => {
      if (functionName === "prepare_encrypted_review_resolution") {
        return Promise.resolve(preparationRow);
      }
      if (functionName === "commit_encrypted_review_resolution") {
        return Promise.resolve({
          scope: "encrypted_review_resolution",
          outcome: "resolved",
          decisionId: null,
          reviewItemId: REVIEW,
          feedbackEventId: null,
          batchId: null,
          members: [],
          encryptedResponse: storedCipher("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
          responseVerificationMac: requestMac(),
          replayed: true
        });
      }
      return Promise.reject(new Error("unexpected RPC"));
    });
    const adapter = createEncryptedOwnerInteractionRpcAdapter(client(rpc));
    const request = {
      idempotencyKey: IDEMPOTENCY,
      resolution: { type: "keep_both" as const }
    };

    const preparation = await adapter.prepareReviewResolution({
      ownerId: OWNER,
      reviewItemId: REVIEW,
      request
    });
    const result = await adapter.commitReviewResolution({
      ownerId: OWNER,
      reviewItemId: REVIEW,
      idempotencyKey: IDEMPOTENCY,
      preparation,
      command: { requestMac: requestMac() }
    });

    expect(preparation).toMatchObject({
      completed: true,
      replayed: true,
      action: "keep_both",
      occurredAt: CANONICAL_OCCURRED_AT
    });
    expect(result).toMatchObject({
      scope: "encrypted_review_resolution",
      outcome: "resolved",
      reviewItemId: REVIEW,
      replayed: true
    });
    expect(rpc.mock.calls[1]).toEqual([
      "commit_encrypted_review_resolution",
      {
        p_owner_id: OWNER,
        p_review_item_id: REVIEW,
        p_idempotency_key: IDEMPOTENCY,
        p_command: { requestMac: requestMac() }
      }
    ]);
  });

  it("accepts completed correction and batch replays with retired request-MAC keys", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((functionName) => {
      if (functionName === "prepare_encrypted_decision_correction") {
        return Promise.resolve(completedCorrectionRow(retiredKey("content_mac")));
      }
      if (functionName === "commit_encrypted_decision_correction") {
        return Promise.resolve({
          scope: "encrypted_decision_correction",
          outcome: "needs_review",
          decisionId: DECISION,
          reviewItemId: REVIEW,
          feedbackEventId: null,
          batchId: null,
          members: [],
          encryptedResponse: storedCipher("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
          responseVerificationMac: requestMac(),
          replayed: true
        });
      }
      if (functionName === "get_encrypted_mutation_batch") {
        return Promise.resolve(completedBatchRow(retiredKey("content_mac")));
      }
      if (functionName === "undo_encrypted_mutation_batch") {
        return Promise.resolve({
          scope: "encrypted_mutation_batch_undo",
          outcome: "applied",
          decisionId: null,
          reviewItemId: null,
          feedbackEventId: null,
          batchId: BATCH,
          members: [
            {
              role: "undo",
              noteId: NOTE,
              currentRevision: 3,
              revisionId: REVISION,
              mutationId: OUTPUT_MUTATION
            }
          ],
          encryptedResponse: storedCipher("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
          responseVerificationMac: requestMac(),
          replayed: true
        });
      }
      return Promise.reject(new Error("unexpected RPC"));
    });
    const adapter = createEncryptedOwnerInteractionRpcAdapter(client(rpc));
    const correctionRequest = {
      idempotencyKey: IDEMPOTENCY,
      source: { noteId: NOTE, expectedRevision: 2 },
      destination: {
        type: "new_note" as const,
        title: "Destination",
        noteType: "generic" as const,
        spaceId: null
      }
    };
    const correction = await adapter.prepareDecisionCorrection({
      ownerId: OWNER,
      decisionId: DECISION,
      request: correctionRequest
    });
    const correctionResult = await adapter.commitDecisionCorrection({
      ownerId: OWNER,
      decisionId: DECISION,
      idempotencyKey: IDEMPOTENCY,
      preparation: correction,
      command: { selectedOutcome: "needs_review", requestMac: requestMac() }
    });
    const batchRequest = { expectedRevision: 2, idempotencyKey: IDEMPOTENCY };
    const batch = await adapter.getMutationBatch({
      ownerId: OWNER,
      mutationId: MUTATION,
      request: batchRequest
    });
    const batchResult = await adapter.undoMutationBatch({
      ownerId: OWNER,
      mutationId: MUTATION,
      request: batchRequest,
      preparation: batch,
      command: { selectedOutcome: "applied", requestMac: requestMac() }
    });

    expect(correction).toMatchObject({
      completed: true,
      source: null,
      members: [],
      occurredAt: CANONICAL_OCCURRED_AT
    });
    expect(correctionResult).toMatchObject({ outcome: "needs_review", replayed: true });
    expect(batch).toMatchObject({
      completed: true,
      source: null,
      members: [],
      occurredAt: CANONICAL_OCCURRED_AT
    });
    expect(batchResult.members).toEqual([
      {
        role: "undo",
        noteId: NOTE,
        currentRevision: 3,
        revisionId: REVISION,
        mutationId: OUTPUT_MUTATION
      }
    ]);
  });

  it("keeps global batch history private while reserving AI-local member outputs", async () => {
    const result = createEncryptedOwnerInteractionRpcAdapter(
      client(() => Promise.resolve(pendingHistoricallyPrivateBatchRow()))
    ).getMutationBatch({
      ownerId: OWNER,
      mutationId: MUTATION,
      request: { expectedRevision: 3, idempotencyKey: IDEMPOTENCY }
    });

    await expect(result).resolves.toMatchObject({
      completed: false,
      requestMacKey: { keyClass: "private_manual" },
      members: [
        {
          sourcePrivacy: "ai_assisted",
          targetPrivacy: "ai_assisted",
          currentMutation: { mutationCipher: { keyClass: "private_manual" } }
        }
      ],
      commonReservations: [{ role: "response", keyClass: "private_manual" }],
      branches: {
        applied: {
          reservations: [
            { role: "note_content:0", keyClass: "ai_assisted" },
            { role: "note_revision:0", keyClass: "ai_assisted" },
            { role: "note_mutation:0", keyClass: "ai_assisted" }
          ]
        },
        needsReview: {
          reservations: [{ role: "review", keyClass: "private_manual" }]
        }
      }
    });
  });

  it("rejects replay reservation, ciphertext-owner, and persisted-MAC substitution", async () => {
    const substituted = reviewPreparationRow();
    substituted.reservations = [reservation("review", "review_item", REVIEW, 2, 1)];
    substituted.encryptedResponse = storedCipher(
      "idempotency_response",
      `idempotency:${IDEMPOTENCY}`,
      1,
      "ai_assisted",
      OTHER_OWNER
    );
    const adapter = createEncryptedOwnerInteractionRpcAdapter(
      client(() => Promise.resolve(substituted))
    );

    await expect(
      adapter.prepareReviewResolution({
        ownerId: OWNER,
        reviewItemId: REVIEW,
        request: {
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "keep_both" }
        }
      })
    ).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
      message: "The encrypted data service could not complete the request"
    });

    const missingMac = reviewPreparationRow();
    missingMac.encryptedResponseVerificationMac = null;
    await expect(
      createEncryptedOwnerInteractionRpcAdapter(
        client(() => Promise.resolve(missingMac))
      ).prepareReviewResolution({
        ownerId: OWNER,
        reviewItemId: REVIEW,
        request: {
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "keep_both" }
        }
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });

    const exactPreparation = await createEncryptedOwnerInteractionRpcAdapter(
      client(() => Promise.resolve(reviewPreparationRow()))
    ).prepareReviewResolution({
      ownerId: OWNER,
      reviewItemId: REVIEW,
      request: { idempotencyKey: IDEMPOTENCY, resolution: { type: "keep_both" } }
    });
    await expect(
      createEncryptedOwnerInteractionRpcAdapter(
        client(() =>
          Promise.resolve({
            scope: "encrypted_review_resolution",
            outcome: "resolved",
            decisionId: null,
            reviewItemId: REVIEW,
            feedbackEventId: null,
            batchId: null,
            members: [],
            encryptedResponse: storedCipher(
              "idempotency_response",
              `idempotency:${IDEMPOTENCY}`,
              1
            ),
            replayed: true
          })
        )
      ).commitReviewResolution({
        ownerId: OWNER,
        reviewItemId: REVIEW,
        idempotencyKey: IDEMPOTENCY,
        preparation: exactPreparation,
        command: { requestMac: requestMac() }
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });
});
