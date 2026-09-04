import {
  DecisionCorrectionRequestSchema,
  GeneratedBlockResolveRequestSchema,
  MutationBatchUndoResponseSchema,
  MutationUndoRequestSchema,
  NoteSnapshotSchema,
  ReviewResolveRequestSchema,
  noteAttachmentReferences,
  type EntityId,
  type NoteSnapshot
} from "@unfiled/contracts";
import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  CaptureReceiptPayloadSchema,
  NoteMutationPayloadSchema,
  OrganizationDecisionPayloadSchema,
  type AggregateContentKind,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type KeyedMacRecord,
  type ObjectWrapReservation,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import type { KeyClass, ManagedKeyRecordV1 } from "@unfiled/key-management";
import { describe, expect, it, type Mock, vi } from "vitest";

import type { PreparedOwnerEncryptedAggregateService } from "@/server/encryption/encrypted-aggregate-runtime";
import type {
  EncryptedOwnerInteractionRpcAdapter,
  OwnerInteractionCommitResult,
  OwnerInteractionPreparedMember,
  OwnerInteractionPreparedReservation,
  OwnerInteractionPreparedSource,
  PrepareDecisionCorrectionResult,
  PrepareGeneratedBlockResolutionResult,
  PrepareMutationBatchUndoResult,
  PrepareReviewResolutionResult
} from "@/server/encryption/encrypted-owner-interaction-rpc-adapter";
import { ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";
import type { EncryptedGeneratedBlockReader } from "@/server/generated-blocks/encrypted-generated-block-reader";

import { EncryptedOwnerInteractionCoordinator } from "./encrypted-owner-interaction-coordinator";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-01T12:00:00.000Z";
const NOTE_A = `note_${"0".repeat(26)}` as const;
const NOTE_B = `note_${"1".repeat(26)}` as const;
const NOTE_C = `note_${"K".repeat(26)}` as const;
const REV_BEFORE = `rev_${"2".repeat(26)}` as const;
const REV_AFTER = `rev_${"3".repeat(26)}` as const;
const REV_UNDO = `rev_${"4".repeat(26)}` as const;
const MUTATION = `mut_${"5".repeat(26)}` as const;
const MUTATION_UNDO = `mut_${"6".repeat(26)}` as const;
const DESTINATION_REVISION = `rev_${"7".repeat(26)}` as const;
const DESTINATION_MUTATION = `mut_${"8".repeat(26)}` as const;
const CAPTURE = `cap_${"9".repeat(26)}` as const;
const JOB = `job_${"A".repeat(26)}` as const;
const DECISION = `dec_${"B".repeat(26)}` as const;
const REVIEW = `rvw_${"C".repeat(26)}` as const;
const BLOCK = `blk_${"M".repeat(26)}` as const;
const FEEDBACK = `fbk_${"D".repeat(26)}` as const;
const SOURCE_REMOVAL_MUTATION = `mut_${"E".repeat(26)}` as const;
const SOURCE_BEFORE_REVISION = `rev_${"F".repeat(26)}` as const;
const SOURCE_AFTER_REVISION = `rev_${"G".repeat(26)}` as const;
const DESTINATION_BEFORE_REVISION = `rev_${"H".repeat(26)}` as const;
const DESTINATION_AFTER_REVISION = `rev_${"J".repeat(26)}` as const;
const PHOTO = `att_${"N".repeat(26)}` as const;
const RECORDING = `att_${"P".repeat(26)}` as const;
const BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDEMPOTENCY = "owner-interaction-01";

type TestCipher = EncryptedAggregateRecord<AggregateContentKind>;

function envelope(
  kind: AggregateContentKind,
  resourceId: string,
  recordVersion: number,
  keyClass: KeyClass
): ContentEnvelopeV1 {
  return {
    version: 1,
    suite: "A256GCM",
    keyId: `${keyClass}.object_wrap.v1`,
    context: { tenantId: OWNER, resourceId, recordVersion, kind },
    wrappedDataKey: { nonce: "A".repeat(16), ciphertext: "a".repeat(64) },
    payload: { nonce: "B".repeat(16), ciphertext: "b".repeat(64) }
  };
}

function stored<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  recordVersion: number,
  keyClass: KeyClass = "ai_assisted"
): EncryptedAggregateRecord<Kind> {
  return Object.freeze({
    ownerId: OWNER,
    resourceId,
    recordVersion,
    kind,
    envelope: envelope(kind, resourceId, recordVersion, keyClass),
    keyId: `${keyClass}.object_wrap.v1`,
    keyClass,
    keyPurpose: "object_wrap" as const,
    keyVersion: 1
  });
}

function sealed<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  recordVersion: number,
  keyClass: KeyClass,
  reservationId: string
): SealedEncryptedAggregateRecord<Kind> {
  return Object.freeze({ ...stored(kind, resourceId, recordVersion, keyClass), reservationId });
}

function key(
  purpose: "content_mac" | "object_wrap",
  keyClass: KeyClass = "ai_assisted"
): ManagedKeyRecordV1 {
  return {
    schemaVersion: 1,
    ownerId: OWNER,
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
    rotation: {
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    }
  };
}

function reservation(
  role: OwnerInteractionPreparedReservation["role"],
  surface: OwnerInteractionPreparedReservation["surface"],
  resourceId: string,
  recordVersion: number,
  ordinal: number,
  keyClass: KeyClass = "ai_assisted"
): OwnerInteractionPreparedReservation {
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

function mac(keyClass: KeyClass = "ai_assisted"): KeyedMacRecord {
  return Object.freeze({
    value: "a".repeat(64),
    keyId: `${keyClass}.content_mac.v1`,
    keyClass,
    keyPurpose: "content_mac" as const,
    keyVersion: 1
  });
}

function sourceReceipt(
  destinationNoteId: EntityId<"note"> = NOTE_A,
  mutationId: EntityId<"mut"> = MUTATION,
  expectedRevision = 2
) {
  return CaptureReceiptPayloadSchema.parse({
    schemaVersion: 2,
    captureId: CAPTURE,
    jobId: JOB,
    decisionId: DECISION,
    reviewItemId: null,
    mutationId,
    outcome: "added_to_note",
    headline: "Added to a note",
    destination: { noteId: destinationNoteId, title: "After" },
    insertedContentReferences: [{ type: "captured", itemId: null }],
    actions: [
      { type: "open", noteId: destinationNoteId },
      { type: "move", noteId: destinationNoteId, decisionId: DECISION },
      { type: "undo", mutationId, expectedRevision }
    ],
    reasonCodes: ["semantic_match"],
    createdAt: NOW,
    undoTargets: [{ noteId: destinationNoteId, mutationId, expectedRevision }]
  });
}

function correctionSource(capturePresent: boolean): OwnerInteractionPreparedSource {
  return Object.freeze({
    decision: Object.freeze({
      decisionId: DECISION,
      captureId: CAPTURE,
      recordVersion: 1 as const,
      destinationNoteId: NOTE_A,
      contentCipher: stored("organization_decision", DECISION, 1)
    }),
    review: null,
    receipt: Object.freeze({
      captureId: CAPTURE,
      jobId: JOB,
      decisionId: DECISION,
      reviewItemId: null,
      mutationId: MUTATION,
      outcome: "added_to_note" as const,
      destinationNoteId: NOTE_A,
      reasonCodes: Object.freeze(["semantic_match"]),
      recordVersion: 1,
      sourcePrivacy: "ai_assisted" as const,
      receiptCipher: stored("capture_receipt", CAPTURE, 1)
    }),
    capture: capturePresent
      ? Object.freeze({
          captureId: CAPTURE,
          recordVersion: 1 as const,
          privacy: "ai_assisted" as const,
          status: "done" as const,
          contentLength: 7,
          contentCipher: stored("capture", CAPTURE, 1),
          contentMac: mac()
        })
      : null
  });
}

function placeholderCorrectionMembers(): readonly OwnerInteractionPreparedMember[] {
  return Object.freeze([
    Object.freeze({
      ordinal: 0,
      role: "source_removal" as const,
      noteId: NOTE_A,
      targetMutationId: MUTATION,
      expectedRevision: 2,
      sourcePrivacy: "ai_assisted" as const,
      targetPrivacy: "ai_assisted" as const,
      revisionId: REV_UNDO,
      mutationId: MUTATION_UNDO,
      currentNote: null,
      currentMutation: null
    }),
    Object.freeze({
      ordinal: 1,
      role: "destination_write" as const,
      noteId: NOTE_B,
      targetMutationId: null,
      expectedRevision: 0,
      sourcePrivacy: null,
      targetPrivacy: "ai_assisted" as const,
      revisionId: DESTINATION_REVISION,
      mutationId: DESTINATION_MUTATION,
      currentNote: null,
      currentMutation: null
    })
  ]);
}

function correctionPreparation(capturePresent = false): PrepareDecisionCorrectionResult {
  const members = placeholderCorrectionMembers();
  return Object.freeze({
    scope: "encrypted_decision_correction" as const,
    occurredAt: NOW,
    completed: false,
    replayed: false,
    selectedOutcome: null,
    requestMacKey: key("content_mac"),
    ids: Object.freeze({
      decisionId: DECISION,
      sourceNoteId: NOTE_A,
      destinationNoteId: NOTE_B,
      captureId: CAPTURE
    }),
    source: correctionSource(capturePresent),
    members,
    commonReservations: Object.freeze([
      reservation("receipt", "capture_receipt", CAPTURE, 2, 1),
      reservation("response", "idempotency_response", `idempotency:${IDEMPOTENCY}`, 1, 2)
    ]),
    branches: Object.freeze({
      applied: Object.freeze({
        available: true,
        feedbackEventId: FEEDBACK,
        batchId: BATCH_ID,
        reservations: Object.freeze([
          reservation("note_content:0", "note_content", NOTE_A, 3, 3),
          reservation("note_revision:0", "note_revision", REV_UNDO, 3, 4),
          reservation("note_mutation:0", "note_mutation", MUTATION_UNDO, 3, 5),
          reservation("note_content:1", "note_content", NOTE_B, 1, 6),
          reservation("note_revision:1", "note_revision", DESTINATION_REVISION, 1, 7),
          reservation("note_mutation:1", "note_mutation", DESTINATION_MUTATION, 1, 8)
        ])
      }),
      needsReview: Object.freeze({
        available: true,
        reviewItemId: REVIEW,
        reservations: Object.freeze([reservation("review", "review_item", REVIEW, 1, 9)])
      })
    }),
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

type CryptoHarness = Readonly<{
  service: EncryptedAggregateService;
  createPreparedService: Mock<
    (reservations: readonly ObjectWrapReservation[]) => PreparedOwnerEncryptedAggregateService
  >;
  assertConsumed: ReturnType<typeof vi.fn>;
  sourcePayloads: Map<string, unknown>;
  setResponse(value: unknown): void;
  responseCipher(): EncryptedAggregateRecord<"idempotency_response">;
}>;

function cryptoHarness(): CryptoHarness {
  const sourcePayloads = new Map<string, unknown>();
  const sealedPayloads = new Map<string, unknown>();
  const sealedClasses = new Map<string, KeyClass>();
  let responseValue: unknown;
  let latestResponse = stored("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1);
  let plan: readonly ObjectWrapReservation[] = Object.freeze([]);
  let reservationIndex = 0;
  const assertConsumed = vi.fn(() => {
    expect(reservationIndex).toBe(plan.length);
  });
  const nextReservation = (): string => {
    const item = plan[reservationIndex];
    if (item === undefined) throw new TypeError("reservation_exhausted");
    reservationIndex += 1;
    return item.reservationId;
  };
  const payloadKey = (record: TestCipher): string =>
    `${record.kind}:${record.resourceId}:${record.recordVersion}`;
  const opened = (record: TestCipher): unknown =>
    sealedPayloads.get(payloadKey(record)) ?? sourcePayloads.get(payloadKey(record));

  const service = {
    createIdempotencyRequestMac: vi.fn(
      (_access: unknown, input: Readonly<{ transition: { after: KeyClass } }>) =>
        Promise.resolve(mac(input.transition.after))
    ),
    sealReview: vi.fn(
      (
        _access: unknown,
        input: Readonly<{
          reviewId: EntityId<"rvw">;
          recordVersion: number;
          sourcePrivacy: KeyClass;
          payload: unknown;
        }>
      ) => {
        const record = sealed(
          "review_item",
          input.reviewId,
          input.recordVersion,
          input.sourcePrivacy,
          nextReservation()
        );
        sealedPayloads.set(payloadKey(record), input.payload);
        sealedClasses.set(payloadKey(record), input.sourcePrivacy);
        return Promise.resolve(record);
      }
    ),
    openReview: vi.fn((_access: unknown, record: TestCipher) => Promise.resolve(opened(record))),
    sealCaptureReceipt: vi.fn(
      (
        _access: unknown,
        input: Readonly<{
          captureId: EntityId<"cap">;
          recordVersion: number;
          sourcePrivacy: KeyClass;
          payload: unknown;
        }>
      ) => {
        const record = sealed(
          "capture_receipt",
          input.captureId,
          input.recordVersion,
          input.sourcePrivacy,
          nextReservation()
        );
        sealedPayloads.set(payloadKey(record), input.payload);
        sealedClasses.set(payloadKey(record), input.sourcePrivacy);
        return Promise.resolve(record);
      }
    ),
    openCaptureReceipt: vi.fn((_access: unknown, record: TestCipher) =>
      Promise.resolve(opened(record))
    ),
    sealNoteContent: vi.fn(
      (
        _access: unknown,
        input: Readonly<{
          noteId: EntityId<"note">;
          currentRevision: number;
          privacy: KeyClass;
          payload: unknown;
        }>
      ) => {
        const record = sealed(
          "note_content",
          input.noteId,
          input.currentRevision,
          input.privacy,
          nextReservation()
        );
        sealedPayloads.set(payloadKey(record), input.payload);
        sealedClasses.set(payloadKey(record), input.privacy);
        return Promise.resolve(record);
      }
    ),
    openNoteContent: vi.fn((_access: unknown, record: TestCipher) =>
      Promise.resolve(opened(record))
    ),
    sealNoteRevision: vi.fn(
      (
        _access: unknown,
        input: Readonly<{
          revisionId: EntityId<"rev">;
          revision: number;
          transition: { after: KeyClass };
          payload: unknown;
        }>
      ) => {
        const encrypted = sealed(
          "note_revision",
          input.revisionId,
          input.revision,
          input.transition.after,
          nextReservation()
        );
        sealedPayloads.set(payloadKey(encrypted), input.payload);
        sealedClasses.set(payloadKey(encrypted), input.transition.after);
        return Promise.resolve({ encrypted, contentMac: mac(input.transition.after) });
      }
    ),
    openNoteRevision: vi.fn((_access: unknown, record: Readonly<{ encrypted: TestCipher }>) =>
      Promise.resolve(opened(record.encrypted))
    ),
    sealNoteMutation: vi.fn(
      (
        _access: unknown,
        input: Readonly<{
          mutationId: EntityId<"mut">;
          afterRevision: number;
          payload: unknown;
        }>
      ) => {
        const reservedKeyClass = plan[reservationIndex]?.reference.keyClass ?? "ai_assisted";
        const record = sealed(
          "note_mutation",
          input.mutationId,
          input.afterRevision,
          reservedKeyClass,
          nextReservation()
        );
        sealedPayloads.set(payloadKey(record), input.payload);
        sealedClasses.set(payloadKey(record), reservedKeyClass);
        return Promise.resolve(record);
      }
    ),
    openNoteMutation: vi.fn((_access: unknown, record: TestCipher) =>
      Promise.resolve(opened(record))
    ),
    openCapture: vi.fn((_access: unknown, record: Readonly<{ encrypted: TestCipher }>) =>
      Promise.resolve(opened(record.encrypted))
    ),
    openOrganizationDecision: vi.fn((_access: unknown, record: TestCipher) =>
      Promise.resolve(opened(record))
    ),
    openGeneratedBlock: vi.fn((_access: unknown, record: TestCipher) =>
      Promise.resolve(opened(record))
    ),
    sealIdempotencyResponse: vi.fn(
      (
        _access: unknown,
        input: Readonly<{
          idempotencyKey: string;
          transition: { after: KeyClass };
          response: unknown;
        }>
      ) => {
        responseValue = input.response;
        const record = sealed(
          "idempotency_response",
          `idempotency:${input.idempotencyKey}`,
          1,
          input.transition.after,
          nextReservation()
        );
        latestResponse = stored(
          "idempotency_response",
          `idempotency:${input.idempotencyKey}`,
          1,
          input.transition.after
        );
        sealedClasses.set(payloadKey(record), input.transition.after);
        return Promise.resolve(record);
      }
    ),
    openIdempotencyResponse: vi.fn(() => Promise.resolve(responseValue)),
    createAggregateVerificationMac: vi.fn(
      (
        _access: unknown,
        input: Readonly<{
          surface: string;
          recordVersion: number;
          noteId?: string;
          mutationId?: string;
          reviewId?: string;
          captureId?: string;
          idempotencyKey?: string;
          privacy?: KeyClass;
          sourcePrivacy?: KeyClass;
          transition?: Readonly<{ after: KeyClass }>;
        }>
      ) => {
        const resourceId =
          input.noteId ??
          input.mutationId ??
          input.reviewId ??
          input.captureId ??
          (input.idempotencyKey === undefined ? undefined : `idempotency:${input.idempotencyKey}`);
        const storedClass =
          resourceId === undefined
            ? undefined
            : sealedClasses.get(`${input.surface}:${resourceId}:${input.recordVersion}`);
        return Promise.resolve(
          mac(
            storedClass ??
              input.privacy ??
              input.sourcePrivacy ??
              input.transition?.after ??
              "ai_assisted"
          )
        );
      }
    ),
    verifyAggregateVerificationMac: vi.fn((_access: unknown, record: unknown) =>
      Promise.resolve(
        typeof record === "object" &&
          record !== null &&
          "value" in record &&
          record.value === "a".repeat(64)
      )
    )
  } as unknown as EncryptedAggregateService;
  const createPreparedService = vi.fn(
    (reservations: readonly ObjectWrapReservation[]): PreparedOwnerEncryptedAggregateService => {
      plan = reservations;
      reservationIndex = 0;
      return Object.freeze({ service, assertConsumed });
    }
  );
  return Object.freeze({
    service,
    createPreparedService,
    assertConsumed,
    sourcePayloads,
    setResponse(value: unknown) {
      responseValue = value;
    },
    responseCipher() {
      return latestResponse;
    }
  });
}

function coordinator(
  adapter: EncryptedOwnerInteractionRpcAdapter,
  crypto: CryptoHarness,
  observeRoutingRuleCorrection: NonNullable<
    ConstructorParameters<
      typeof EncryptedOwnerInteractionCoordinator
    >[0]["observeRoutingRuleCorrection"]
  > = () => Promise.resolve(),
  routingRuleObservationDeadlineAt?: number,
  listCaptureAttachments: NonNullable<
    ConstructorParameters<typeof EncryptedOwnerInteractionCoordinator>[0]["listCaptureAttachments"]
  > = () => Promise.resolve([])
): EncryptedOwnerInteractionCoordinator {
  return new EncryptedOwnerInteractionCoordinator({
    ownerId: OWNER,
    access: authorizeAggregateOwner({
      authenticatedOwnerId: OWNER,
      resourceOwnerId: OWNER
    }),
    aggregate: crypto.service,
    createPreparedService: (reservations) => crypto.createPreparedService(reservations),
    adapter,
    listCaptureAttachments,
    observeRoutingRuleCorrection,
    ...(routingRuleObservationDeadlineAt === undefined ? {} : { routingRuleObservationDeadlineAt })
  });
}

function adapterStub(overrides: Partial<EncryptedOwnerInteractionRpcAdapter>) {
  const rejected = () => Promise.reject(new TypeError("unexpected_adapter_call"));
  return Object.freeze({
    prepareDecisionCorrection: vi.fn(rejected),
    commitDecisionCorrection: vi.fn(rejected),
    prepareReviewResolution: vi.fn(rejected),
    commitReviewResolution: vi.fn(rejected),
    prepareGeneratedBlockResolution: vi.fn(rejected),
    commitGeneratedBlockResolution: vi.fn(rejected),
    getMutationBatch: vi.fn(rejected),
    undoMutationBatch: vi.fn(rejected),
    ...overrides
  }) as unknown as EncryptedOwnerInteractionRpcAdapter;
}

function correctionRequest() {
  return DecisionCorrectionRequestSchema.parse({
    idempotencyKey: IDEMPOTENCY,
    source: { noteId: NOTE_A, expectedRevision: 2 },
    destination: {
      type: "new_note",
      title: "Moved capture",
      noteType: "generic",
      spaceId: null
    }
  });
}

function commitResult(
  scope: OwnerInteractionCommitResult["scope"],
  outcome: OwnerInteractionCommitResult["outcome"],
  cipher: EncryptedAggregateRecord<"idempotency_response">,
  overrides: Partial<OwnerInteractionCommitResult> = {}
): OwnerInteractionCommitResult {
  return Object.freeze({
    scope,
    outcome,
    decisionId: null,
    reviewItemId: null,
    feedbackEventId: null,
    batchId: null,
    members: Object.freeze([]),
    encryptedResponse: cipher,
    responseVerificationMac: mac(),
    replayed: false,
    ...overrides
  });
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: (typeof ServiceRpcErrorCode)[keyof typeof ServiceRpcErrorCode]
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "ServiceRpcError", code });
}

describe("encrypted owner-interaction coordinator", () => {
  it("re-homes a repeatedly corrected append using current authenticated lineage", async () => {
    const crypto = cryptoHarness();
    const before = snapshot("Before current route");
    const after = snapshot("Current routed note");
    const currentNote = noteRead(after, 2);
    const sourceMember = Object.freeze({
      ...batchMemberFixture(currentNote),
      role: "source_removal" as const
    });
    const base = correctionPreparation(true);
    const destinationMember = base.members.find(({ role }) => role === "destination_write");
    if (base.completed || destinationMember === undefined || base.source.receipt === null) {
      throw new Error("Applied correction fixture requires a destination");
    }
    const preparation: PrepareDecisionCorrectionResult = Object.freeze({
      ...base,
      source: Object.freeze({
        ...base.source,
        receipt: Object.freeze({
          ...base.source.receipt,
          reasonCodes: Object.freeze(["encrypted_organizer"])
        })
      }),
      members: Object.freeze([sourceMember, destinationMember])
    });
    const rawContent = "Workout";
    crypto.sourcePayloads.set(`capture:${CAPTURE}:1`, {
      schemaVersion: 1,
      rawContent
    });
    crypto.sourcePayloads.set(
      `organization_decision:${DECISION}:1`,
      OrganizationDecisionPayloadSchema.parse({
        schemaVersion: 1,
        candidateManifest: { generationId: null, candidates: [] },
        signals: {},
        validatedPlan: {
          schemaVersion: 1,
          captureKind: "freeform",
          decision: "append_to_note",
          destination: { candidateId: NOTE_C, newNote: null },
          operations: [{ type: "append_raw", content: rawContent }],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["semantic_match"]
        },
        band: "auto"
      })
    );
    crypto.sourcePayloads.set(`capture_receipt:${CAPTURE}:1`, sourceReceipt());
    crypto.sourcePayloads.set(`note_content:${NOTE_A}:2`, {
      schemaVersion: 1,
      title: after.title,
      bodyMarkdown: after.bodyMarkdown,
      structuredData: after.structuredData
    });
    crypto.sourcePayloads.set(
      `note_mutation:${MUTATION}:2`,
      updateMutationPayload(before, after, 1, 2)
    );
    crypto.sourcePayloads.set(`note_revision:${REV_BEFORE}:1`, {
      schemaVersion: 1,
      snapshot: before
    });
    crypto.sourcePayloads.set(`note_revision:${REV_AFTER}:2`, {
      schemaVersion: 1,
      snapshot: after
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitDecisionCorrection"]>[0]) => {
        expect(input.command).toMatchObject({
          selectedOutcome: "applied",
          writes: [
            {
              ordinal: 0,
              noteId: NOTE_A,
              targetMutationId: MUTATION,
              revision: { source: "interactive", actor: "user:correction" }
            },
            {
              ordinal: 1,
              noteId: NOTE_B,
              targetMutationId: null,
              revision: { source: "interactive", actor: "user:correction" }
            }
          ]
        });
        return Promise.resolve(
          commitResult("encrypted_decision_correction", "applied", crypto.responseCipher(), {
            decisionId: DECISION,
            feedbackEventId: FEEDBACK,
            batchId: BATCH_ID,
            members: Object.freeze([
              Object.freeze({
                role: "source_removal" as const,
                noteId: NOTE_A,
                currentRevision: 3,
                revisionId: REV_UNDO,
                mutationId: MUTATION_UNDO
              }),
              Object.freeze({
                role: "destination_write" as const,
                noteId: NOTE_B,
                currentRevision: 1,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ])
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareDecisionCorrection: vi.fn(() => Promise.resolve(preparation)),
      commitDecisionCorrection: commit
    });
    const mismatchedPreparation: PrepareDecisionCorrectionResult = Object.freeze({
      ...base,
      source: Object.freeze({
        ...base.source,
        receipt: Object.freeze({
          ...base.source.receipt,
          reasonCodes: Object.freeze(["unrelated_projection"])
        })
      }),
      members: Object.freeze([sourceMember, destinationMember])
    });
    const mismatchedAdapter = adapterStub({
      prepareDecisionCorrection: vi.fn(() => Promise.resolve(mismatchedPreparation)),
      commitDecisionCorrection: commit
    });

    await expectServiceError(
      coordinator(mismatchedAdapter, crypto).correctDecision(DECISION, correctionRequest()),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
    expect(commit).not.toHaveBeenCalled();

    const observeRoutingRuleCorrection = vi.fn(() => Promise.resolve());
    await expect(
      coordinator(adapter, crypto, observeRoutingRuleCorrection).correctDecision(
        DECISION,
        correctionRequest()
      )
    ).resolves.toMatchObject({
      outcome: "applied",
      source: { noteId: NOTE_A, currentRevision: 3, mutationId: MUTATION_UNDO },
      destination: {
        type: "new_note",
        noteId: NOTE_B,
        currentRevision: 1,
        mutationId: DESTINATION_MUTATION
      }
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(observeRoutingRuleCorrection).toHaveBeenCalledWith({
      feedbackEventId: FEEDBACK,
      captureId: CAPTURE,
      captureText: rawContent,
      destination: { type: "note", noteId: NOTE_B }
    });

    const observationDeadlineBase = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(observationDeadlineBase);
    try {
      const stalledObservation = vi.fn(
        () =>
          new Promise<void>(() => {
            // Deliberately never settles; the bounded failure deadline must win.
          })
      );
      await expectServiceError(
        coordinator(
          adapter,
          crypto,
          stalledObservation,
          observationDeadlineBase + 25
        ).correctDecision(DECISION, correctionRequest()),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
      );
      expect(commit).toHaveBeenCalledTimes(2);
      expect(stalledObservation).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  });

  it("persists the zero-note Review branch when an applied correction lacks its source capture", async () => {
    const crypto = cryptoHarness();
    crypto.sourcePayloads.set("capture_receipt:" + CAPTURE + ":1", sourceReceipt());
    const basePreparation = correctionPreparation(false);
    const privateMembers = Object.freeze(
      basePreparation.members.map((member) =>
        Object.freeze({
          ...member,
          sourcePrivacy:
            member.role === "source_removal" ? ("private_manual" as const) : member.sourcePrivacy,
          targetPrivacy: "private_manual" as const
        })
      )
    );
    const privateReservation = (
      item: OwnerInteractionPreparedReservation
    ): OwnerInteractionPreparedReservation =>
      Object.freeze({
        ...item,
        keyClass: "private_manual" as const,
        key: key("object_wrap", "private_manual")
      });
    const [commonReviewReservation, commonResponseReservation] = basePreparation.commonReservations;
    if (commonReviewReservation === undefined || commonResponseReservation === undefined) {
      throw new Error("Correction fixture is missing common reservations");
    }
    const preparation: PrepareDecisionCorrectionResult = Object.freeze({
      ...basePreparation,
      requestMacKey: key("content_mac", "private_manual"),
      members: privateMembers,
      commonReservations: Object.freeze([
        commonReviewReservation,
        privateReservation(commonResponseReservation)
      ]),
      branches: Object.freeze({
        applied: Object.freeze({
          ...basePreparation.branches.applied,
          reservations: Object.freeze(
            basePreparation.branches.applied.reservations.map(privateReservation)
          )
        }),
        needsReview: Object.freeze({
          ...basePreparation.branches.needsReview,
          reservations: Object.freeze(
            basePreparation.branches.needsReview.reservations.map(privateReservation)
          )
        })
      })
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitDecisionCorrection"]>[0]) => {
        expect(input.command).toMatchObject({ selectedOutcome: "needs_review", writes: [] });
        return Promise.resolve(
          commitResult("encrypted_decision_correction", "needs_review", crypto.responseCipher(), {
            decisionId: DECISION,
            reviewItemId: REVIEW
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareDecisionCorrection: vi.fn(() => Promise.resolve(preparation)),
      commitDecisionCorrection: commit
    });
    const observeRoutingRuleCorrection = vi.fn(() => Promise.resolve());

    const response = await coordinator(
      adapter,
      crypto,
      observeRoutingRuleCorrection
    ).correctDecision(DECISION, correctionRequest());

    expect(response).toEqual({
      outcome: "needs_review",
      decisionId: DECISION,
      reviewItemId: REVIEW,
      reasonCode: "exact_inverse_unavailable",
      replayed: false
    });
    expect(commit).toHaveBeenCalledTimes(1);
    const command = commit.mock.calls[0]?.[0].command;
    expect(command).toMatchObject({ writes: [], selectedOutcome: "needs_review" });
    expect(command).toHaveProperty("review.reviewItemId", REVIEW);
    expect(command).toHaveProperty("receipt.recordVersion", 2);
    expect(vi.mocked(crypto.service.sealCaptureReceipt).mock.calls[0]?.[1].payload).toMatchObject({
      reasonCodes: ["exact_inverse_unavailable"]
    });
    expect(vi.mocked(crypto.service.sealReview).mock.calls[0]?.[1]).toMatchObject({
      sourcePrivacy: "private_manual"
    });
    expect(vi.mocked(crypto.service.sealCaptureReceipt).mock.calls[0]?.[1]).toMatchObject({
      sourcePrivacy: "ai_assisted"
    });
    expect(
      crypto.createPreparedService.mock.calls[0]?.[0].map(
        ({ reservationId }: ObjectWrapReservation) => reservationId
      )
    ).toEqual([
      preparation.branches.needsReview.reservations[0]?.reservationId,
      preparation.commonReservations[0]?.reservationId,
      preparation.commonReservations[1]?.reservationId
    ]);
    expect(crypto.assertConsumed).toHaveBeenCalledOnce();
    expect(observeRoutingRuleCorrection).not.toHaveBeenCalled();
  });

  it("replays the committed correction branch without resealing and rejects a substituted response", async () => {
    const crypto = cryptoHarness();
    const preparation: PrepareDecisionCorrectionResult = Object.freeze({
      ...correctionPreparation(false),
      completed: true,
      replayed: true,
      selectedOutcome: "needs_review",
      source: null,
      members: Object.freeze([]),
      commonReservations: Object.freeze([]),
      branches: Object.freeze({
        applied: Object.freeze({
          available: false,
          feedbackEventId: FEEDBACK,
          batchId: BATCH_ID,
          reservations: Object.freeze([])
        }),
        needsReview: Object.freeze({
          available: true,
          reviewItemId: REVIEW,
          reservations: Object.freeze([])
        })
      }),
      encryptedResponse: stored("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
      encryptedResponseVerificationMac: mac()
    });
    crypto.setResponse({
      outcome: "needs_review",
      decisionId: DECISION,
      reviewItemId: REVIEW,
      reasonCode: "exact_inverse_unavailable",
      replayed: false
    });
    const encryptedResponse = preparation.encryptedResponse;
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitDecisionCorrection"]>[0]) => {
        expect(Object.keys(input.command).sort()).toEqual(["requestMac", "selectedOutcome"]);
        return Promise.resolve(
          commitResult("encrypted_decision_correction", "needs_review", encryptedResponse, {
            decisionId: DECISION,
            reviewItemId: REVIEW,
            replayed: true
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareDecisionCorrection: vi.fn(() => Promise.resolve(preparation)),
      commitDecisionCorrection: commit
    });

    await expect(
      coordinator(adapter, crypto).correctDecision(DECISION, correctionRequest())
    ).resolves.toMatchObject({ outcome: "needs_review", replayed: true });
    expect(crypto.createPreparedService).not.toHaveBeenCalled();

    crypto.setResponse({
      outcome: "needs_review",
      decisionId: `dec_${"E".repeat(26)}`,
      reviewItemId: REVIEW,
      reasonCode: "exact_inverse_unavailable",
      replayed: false
    });
    await expectServiceError(
      coordinator(adapter, crypto).correctDecision(DECISION, correctionRequest()),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );

    crypto.setResponse({
      outcome: "needs_review",
      decisionId: DECISION,
      reviewItemId: REVIEW,
      reasonCode: "exact_inverse_unavailable",
      replayed: false
    });
    const tamperedMac = Object.freeze({ ...mac(), value: "b".repeat(64) });
    const tamperedPreparation: PrepareDecisionCorrectionResult = Object.freeze({
      ...preparation,
      encryptedResponseVerificationMac: tamperedMac
    });
    const tamperedAdapter = adapterStub({
      prepareDecisionCorrection: vi.fn(() => Promise.resolve(tamperedPreparation)),
      commitDecisionCorrection: vi.fn(() =>
        Promise.resolve(
          commitResult("encrypted_decision_correction", "needs_review", encryptedResponse, {
            decisionId: DECISION,
            reviewItemId: REVIEW,
            responseVerificationMac: tamperedMac,
            replayed: true
          })
        )
      )
    });
    await expectServiceError(
      coordinator(tamperedAdapter, crypto).correctDecision(DECISION, correctionRequest()),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
  });

  it("requires learned-rule observation before success and resumes it on exact replay", async () => {
    const crypto = cryptoHarness();
    const encryptedResponse = stored("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1);
    const preparation: PrepareDecisionCorrectionResult = Object.freeze({
      ...correctionPreparation(false),
      completed: true,
      replayed: true,
      selectedOutcome: "applied",
      source: null,
      members: Object.freeze([]),
      commonReservations: Object.freeze([]),
      branches: Object.freeze({
        applied: Object.freeze({
          available: true,
          feedbackEventId: FEEDBACK,
          batchId: BATCH_ID,
          reservations: Object.freeze([])
        }),
        needsReview: Object.freeze({
          available: false,
          reviewItemId: null,
          reservations: Object.freeze([])
        })
      }),
      encryptedResponse,
      encryptedResponseVerificationMac: mac()
    });
    crypto.setResponse({
      outcome: "applied",
      decisionId: DECISION,
      source: {
        noteId: NOTE_A,
        currentRevision: 3,
        mutationId: MUTATION_UNDO
      },
      destination: {
        type: "new_note",
        noteId: NOTE_B,
        currentRevision: 1,
        mutationId: DESTINATION_MUTATION
      },
      replayed: false
    });
    const commit = vi.fn(() =>
      Promise.resolve(
        commitResult("encrypted_decision_correction", "applied", encryptedResponse, {
          decisionId: DECISION,
          feedbackEventId: FEEDBACK,
          batchId: BATCH_ID,
          members: Object.freeze([
            Object.freeze({
              role: "source_removal" as const,
              noteId: NOTE_A,
              currentRevision: 3,
              revisionId: REV_UNDO,
              mutationId: MUTATION_UNDO
            }),
            Object.freeze({
              role: "destination_write" as const,
              noteId: NOTE_B,
              currentRevision: 1,
              revisionId: DESTINATION_REVISION,
              mutationId: DESTINATION_MUTATION
            })
          ]),
          replayed: true
        })
      )
    );
    const adapter = adapterStub({
      prepareDecisionCorrection: vi.fn(() => Promise.resolve(preparation)),
      commitDecisionCorrection: commit
    });
    const privateCanary = "shopping: private correction oat milk 7fcb9e";
    const observeRoutingRuleCorrection = vi
      .fn<
        NonNullable<
          ConstructorParameters<
            typeof EncryptedOwnerInteractionCoordinator
          >[0]["observeRoutingRuleCorrection"]
        >
      >()
      .mockRejectedValueOnce(new Error(privateCanary))
      .mockResolvedValueOnce(undefined);
    const previousDiagnostics = process.env.UNFILED_E1_HTTP_DIAGNOSTICS;
    process.env.UNFILED_E1_HTTP_DIAGNOSTICS = "1";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let diagnostics: string;
    try {
      await expectServiceError(
        coordinator(adapter, crypto, observeRoutingRuleCorrection).correctDecision(
          DECISION,
          correctionRequest()
        ),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
      );

      await expect(
        coordinator(adapter, crypto, observeRoutingRuleCorrection).correctDecision(
          DECISION,
          correctionRequest()
        )
      ).resolves.toMatchObject({ outcome: "applied", replayed: true });
      diagnostics = stderr.mock.calls.map(([value]) => String(value)).join("");
    } finally {
      stderr.mockRestore();
      if (previousDiagnostics === undefined) delete process.env.UNFILED_E1_HTTP_DIAGNOSTICS;
      else process.env.UNFILED_E1_HTTP_DIAGNOSTICS = previousDiagnostics;
    }

    expect(crypto.createPreparedService).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(observeRoutingRuleCorrection).toHaveBeenCalledTimes(2);
    expect(observeRoutingRuleCorrection).toHaveBeenNthCalledWith(1, {
      feedbackEventId: FEEDBACK,
      captureId: CAPTURE,
      captureText: null,
      destination: { type: "note", noteId: NOTE_B }
    });
    expect(observeRoutingRuleCorrection).toHaveBeenNthCalledWith(2, {
      feedbackEventId: FEEDBACK,
      captureId: CAPTURE,
      captureText: null,
      destination: { type: "note", noteId: NOTE_B }
    });
    expect(diagnostics).toContain("correction.rule-observation-deferred");
    expect(diagnostics).toContain("correction.rule-observation-complete");
    expect(diagnostics).not.toContain(privateCanary);
  });

  /** An adapter answering a correction that already committed, so only the observation remains. */
  function committedCorrectionAdapter(crypto: CryptoHarness) {
    const encryptedResponse = stored("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1);
    const preparation: PrepareDecisionCorrectionResult = Object.freeze({
      ...correctionPreparation(false),
      completed: true,
      replayed: true,
      selectedOutcome: "applied",
      source: null,
      members: Object.freeze([]),
      commonReservations: Object.freeze([]),
      branches: Object.freeze({
        applied: Object.freeze({
          available: true,
          feedbackEventId: FEEDBACK,
          batchId: BATCH_ID,
          reservations: Object.freeze([])
        }),
        needsReview: Object.freeze({
          available: false,
          reviewItemId: null,
          reservations: Object.freeze([])
        })
      }),
      encryptedResponse,
      encryptedResponseVerificationMac: mac()
    });
    crypto.setResponse({
      outcome: "applied",
      decisionId: DECISION,
      source: { noteId: NOTE_A, currentRevision: 3, mutationId: MUTATION_UNDO },
      destination: {
        type: "new_note",
        noteId: NOTE_B,
        currentRevision: 1,
        mutationId: DESTINATION_MUTATION
      },
      replayed: false
    });
    return adapterStub({
      prepareDecisionCorrection: vi.fn(() => Promise.resolve(preparation)),
      commitDecisionCorrection: vi.fn(() =>
        Promise.resolve(
          commitResult("encrypted_decision_correction", "applied", encryptedResponse, {
            decisionId: DECISION,
            feedbackEventId: FEEDBACK,
            batchId: BATCH_ID,
            members: Object.freeze([
              Object.freeze({
                role: "source_removal" as const,
                noteId: NOTE_A,
                currentRevision: 3,
                revisionId: REV_UNDO,
                mutationId: MUTATION_UNDO
              }),
              Object.freeze({
                role: "destination_write" as const,
                noteId: NOTE_B,
                currentRevision: 1,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ]),
            replayed: true
          })
        )
      )
    });
  }

  it("stops waiting for the observation at the deadline it was handed", async () => {
    const crypto = cryptoHarness();
    const adapter = committedCorrectionAdapter(crypto);
    const neverSettles = (): Promise<void> => new Promise(() => undefined);
    const startedAt = Date.now();

    await expectServiceError(
      coordinator(adapter, crypto, neverSettles, Date.now() + 25).correctDecision(
        DECISION,
        correctionRequest()
      ),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );

    // The deadline, not the default wait, bounded the answer.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("waits fifteen seconds for the observation before answering unavailable", async () => {
    vi.useFakeTimers();
    try {
      const crypto = cryptoHarness();
      const adapter = committedCorrectionAdapter(crypto);
      const neverSettles = (): Promise<void> => new Promise(() => undefined);
      let settled = false;
      const pending = expectServiceError(
        coordinator(adapter, crypto, neverSettles).correctDecision(DECISION, correctionRequest()),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
      ).finally(() => {
        settled = true;
      });

      // Five seconds -- the old bound -- sat inside the observation's ordinary range and turned
      // durable corrections into 503s; the wait now outlasts a slow observation.
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies every authenticated batch inverse and consumes only the exact selected reservations", async () => {
    const crypto = cryptoHarness();
    const before = snapshot("Before");
    const after = snapshot("After");
    const currentNote = noteRead(after, 2);
    const mutationPayload = NoteMutationPayloadSchema.parse({
      schemaVersion: 1,
      action: "update",
      beforeRevision: 1,
      afterRevision: 2,
      operations: [{ type: "set_title", title: "After" }],
      inverse: [
        {
          type: "restore_snapshot",
          spaceId: before.spaceId,
          noteType: before.type,
          title: before.title,
          bodyMarkdown: before.bodyMarkdown,
          structuredData: before.structuredData,
          privacy: before.privacy,
          isOpen: before.isOpen,
          pinnedAt: before.pinnedAt,
          archivedAt: before.archivedAt,
          deletedAt: before.deletedAt,
          tagIds: before.tagIds,
          links: before.links
        }
      ],
      beforeSnapshot: before,
      afterSnapshot: after
    });
    const member = batchMemberFixture(currentNote);
    crypto.sourcePayloads.set(`note_content:${NOTE_A}:2`, {
      schemaVersion: 1,
      title: after.title,
      bodyMarkdown: after.bodyMarkdown,
      structuredData: after.structuredData
    });
    crypto.sourcePayloads.set(`note_mutation:${MUTATION}:2`, mutationPayload);
    crypto.sourcePayloads.set(`note_revision:${REV_BEFORE}:1`, {
      schemaVersion: 1,
      snapshot: before
    });
    crypto.sourcePayloads.set(`note_revision:${REV_AFTER}:2`, {
      schemaVersion: 1,
      snapshot: after
    });
    const preparation = batchPreparation(member, true);
    crypto.sourcePayloads.set(`capture_receipt:${CAPTURE}:1`, sourceReceipt());
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["undoMutationBatch"]>[0]) => {
        expect(input.command).toMatchObject({ selectedOutcome: "applied" });
        expect(input.command).toHaveProperty("writes.0.targetMutationId", MUTATION);
        expect(input.command).toHaveProperty("writes.0.revision.source", "undo");
        return Promise.resolve(
          commitResult("encrypted_mutation_batch_undo", "applied", crypto.responseCipher(), {
            batchId: BATCH_ID,
            members: Object.freeze([
              Object.freeze({
                role: "undo" as const,
                noteId: NOTE_A,
                currentRevision: 3,
                revisionId: REV_UNDO,
                mutationId: MUTATION_UNDO
              })
            ])
          })
        );
      }
    );
    const adapter = adapterStub({
      getMutationBatch: vi.fn(() => Promise.resolve(preparation)),
      undoMutationBatch: commit
    });

    const result = await coordinator(adapter, crypto).undoMutationBatch(
      MUTATION,
      MutationUndoRequestSchema.parse({
        expectedRevision: 2,
        idempotencyKey: IDEMPOTENCY
      })
    );

    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      note: { id: NOTE_A, title: "Before", currentRevision: 3 },
      revision: { id: REV_UNDO, noteId: NOTE_A, revision: 3, source: "undo" },
      mutationId: MUTATION_UNDO,
      undo: { eligible: false, expiresAt: null }
    });
    expect(
      crypto.createPreparedService.mock.calls[0]?.[0].map(
        ({ reservationId }: ObjectWrapReservation) => reservationId
      )
    ).toEqual([
      preparation.branches.applied.reservations[0]?.reservationId,
      preparation.branches.applied.reservations[1]?.reservationId,
      preparation.branches.applied.reservations[2]?.reservationId,
      preparation.commonReservations[0]?.reservationId,
      preparation.commonReservations[1]?.reservationId
    ]);
    expect(vi.mocked(crypto.service.sealCaptureReceipt).mock.calls[0]?.[1].payload).toMatchObject({
      reasonCodes: ["user_undo"]
    });
    expect(crypto.assertConsumed).toHaveBeenCalledOnce();

    commit.mockImplementationOnce(() => {
      crypto.setResponse({ outcome: "applied", response: batchReplayResponse(NOTE_B) });
      return Promise.resolve(
        commitResult("encrypted_mutation_batch_undo", "applied", crypto.responseCipher(), {
          batchId: BATCH_ID,
          members: Object.freeze([
            Object.freeze({
              role: "undo" as const,
              noteId: NOTE_A,
              currentRevision: 3,
              revisionId: REV_UNDO,
              mutationId: MUTATION_UNDO
            })
          ])
        })
      );
    });
    await expectServiceError(
      coordinator(adapter, crypto).undoMutationBatch(
        MUTATION,
        MutationUndoRequestSchema.parse({ expectedRevision: 2, idempotencyKey: IDEMPOTENCY })
      ),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
  });

  it("restores correction provenance to the source note without advertising undo-of-undo", async () => {
    const crypto = cryptoHarness();
    const sourceBefore = snapshot("Original source");
    const sourceAfter = snapshot("Source after correction");
    const destinationBefore = snapshot("Destination before correction");
    const destinationAfter = snapshot("Destination after correction");
    const sourceMember = correctionUndoMember({
      ordinal: 0,
      noteId: NOTE_A,
      targetMutationId: SOURCE_REMOVAL_MUTATION,
      outputRevisionId: REV_UNDO,
      outputMutationId: MUTATION_UNDO,
      beforeRevisionId: SOURCE_BEFORE_REVISION,
      afterRevisionId: SOURCE_AFTER_REVISION,
      before: sourceBefore,
      after: sourceAfter,
      expectedRevision: 3
    });
    const destinationMember = correctionUndoMember({
      ordinal: 1,
      noteId: NOTE_B,
      targetMutationId: MUTATION,
      outputRevisionId: DESTINATION_REVISION,
      outputMutationId: DESTINATION_MUTATION,
      beforeRevisionId: DESTINATION_BEFORE_REVISION,
      afterRevisionId: DESTINATION_AFTER_REVISION,
      before: destinationBefore,
      after: destinationAfter,
      expectedRevision: 2
    });
    const base = batchPreparation(sourceMember, true);
    const baseSource = base.source;
    if (baseSource === null) {
      throw new Error("Correction Undo fixture requires source state");
    }
    if (baseSource.receipt === null) {
      throw new Error("Correction Undo fixture requires a source receipt");
    }
    const baseReceipt = baseSource.receipt;
    const preparation: PrepareMutationBatchUndoResult = Object.freeze({
      ...base,
      ids: Object.freeze({
        anchorMutationId: MUTATION,
        sourceBatchKind: "correction" as const,
        restoredSourceTargetMutationId: SOURCE_REMOVAL_MUTATION
      }),
      source: Object.freeze({
        ...baseSource,
        receipt: Object.freeze({
          ...baseReceipt,
          mutationId: MUTATION,
          destinationNoteId: NOTE_B
        })
      }),
      members: Object.freeze([sourceMember, destinationMember]),
      branches: Object.freeze({
        ...base.branches,
        applied: Object.freeze({
          ...base.branches.applied,
          reservations: Object.freeze([
            reservation("note_content:0", "note_content", NOTE_A, 4, 21),
            reservation("note_revision:0", "note_revision", REV_UNDO, 4, 22),
            reservation("note_mutation:0", "note_mutation", MUTATION_UNDO, 4, 23),
            reservation("note_content:1", "note_content", NOTE_B, 3, 24),
            reservation("note_revision:1", "note_revision", DESTINATION_REVISION, 3, 25),
            reservation("note_mutation:1", "note_mutation", DESTINATION_MUTATION, 3, 26)
          ])
        })
      })
    });
    const sourcePayloads = [
      {
        member: sourceMember,
        before: sourceBefore,
        after: sourceAfter,
        beforeRevisionId: SOURCE_BEFORE_REVISION,
        afterRevisionId: SOURCE_AFTER_REVISION
      },
      {
        member: destinationMember,
        before: destinationBefore,
        after: destinationAfter,
        beforeRevisionId: DESTINATION_BEFORE_REVISION,
        afterRevisionId: DESTINATION_AFTER_REVISION
      }
    ] as const;
    for (const item of sourcePayloads) {
      const targetMutationId = item.member.targetMutationId;
      if (targetMutationId === null) throw new Error("Undo fixture target is required");
      crypto.sourcePayloads.set(
        `note_content:${item.member.noteId}:${item.member.expectedRevision}`,
        {
          schemaVersion: 1,
          title: item.after.title,
          bodyMarkdown: item.after.bodyMarkdown,
          structuredData: item.after.structuredData
        }
      );
      crypto.sourcePayloads.set(
        `note_mutation:${targetMutationId}:${item.member.expectedRevision}`,
        updateMutationPayload(
          item.before,
          item.after,
          item.member.expectedRevision - 1,
          item.member.expectedRevision
        )
      );
      crypto.sourcePayloads.set(
        `note_revision:${item.beforeRevisionId}:${item.member.expectedRevision - 1}`,
        { schemaVersion: 1, snapshot: item.before }
      );
      crypto.sourcePayloads.set(
        `note_revision:${item.afterRevisionId}:${item.member.expectedRevision}`,
        { schemaVersion: 1, snapshot: item.after }
      );
    }
    crypto.sourcePayloads.set(`capture_receipt:${CAPTURE}:1`, sourceReceipt(NOTE_B, MUTATION, 2));
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["undoMutationBatch"]>[0]) => {
        expect("receipt" in input.command ? input.command.receipt : null).not.toBeNull();
        return Promise.resolve(
          commitResult("encrypted_mutation_batch_undo", "applied", crypto.responseCipher(), {
            batchId: BATCH_ID,
            members: Object.freeze([
              Object.freeze({
                role: "undo" as const,
                noteId: NOTE_A,
                currentRevision: 4,
                revisionId: REV_UNDO,
                mutationId: MUTATION_UNDO
              }),
              Object.freeze({
                role: "undo" as const,
                noteId: NOTE_B,
                currentRevision: 3,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ])
          })
        );
      }
    );
    const adapter = adapterStub({
      getMutationBatch: vi.fn(() => Promise.resolve(preparation)),
      undoMutationBatch: commit
    });

    const response = await coordinator(adapter, crypto).undoMutationBatch(
      MUTATION,
      MutationUndoRequestSchema.parse({
        expectedRevision: 2,
        idempotencyKey: IDEMPOTENCY
      })
    );

    expect(response.members.map(({ note }) => note.id)).toEqual([NOTE_A, NOTE_B]);
    expect(vi.mocked(crypto.service.sealCaptureReceipt).mock.calls[0]?.[1].payload).toEqual(
      expect.objectContaining({
        mutationId: MUTATION_UNDO,
        outcome: "added_to_note",
        destination: { noteId: NOTE_A, title: "Original source" },
        actions: [
          { type: "open", noteId: NOTE_A },
          { type: "move", noteId: NOTE_A, decisionId: DECISION }
        ],
        reasonCodes: ["user_undo"],
        undoTargets: []
      })
    );
  });

  it("replays an immutable completed batch and rejects an authenticated member substitution", async () => {
    const crypto = cryptoHarness();
    const pending = batchPreparation(batchMemberFixture(noteRead(snapshot("After"), 2)));
    const preparation: PrepareMutationBatchUndoResult = Object.freeze({
      ...pending,
      completed: true,
      replayed: true,
      selectedOutcome: "applied",
      source: null,
      members: Object.freeze([]),
      commonReservations: Object.freeze([]),
      branches: Object.freeze({
        applied: Object.freeze({
          available: true,
          batchId: BATCH_ID,
          reservations: Object.freeze([])
        }),
        needsReview: Object.freeze({
          available: false,
          reviewItemId: REVIEW,
          reservations: Object.freeze([])
        })
      }),
      encryptedResponse: stored("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
      encryptedResponseVerificationMac: mac()
    });
    const response = batchReplayResponse();
    crypto.setResponse({ outcome: "applied", response });
    const commit = vi.fn(() =>
      Promise.resolve(
        commitResult("encrypted_mutation_batch_undo", "applied", preparation.encryptedResponse, {
          batchId: BATCH_ID,
          replayed: true,
          members: Object.freeze([
            Object.freeze({
              role: "undo" as const,
              noteId: NOTE_A,
              currentRevision: 3,
              revisionId: REV_UNDO,
              mutationId: MUTATION_UNDO
            })
          ])
        })
      )
    );
    const adapter = adapterStub({
      getMutationBatch: vi.fn(() => Promise.resolve(preparation)),
      undoMutationBatch: commit
    });

    await expect(
      coordinator(adapter, crypto).undoMutationBatch(
        MUTATION,
        MutationUndoRequestSchema.parse({ expectedRevision: 2, idempotencyKey: IDEMPOTENCY })
      )
    ).resolves.toEqual({ ...response, replayed: true });
    expect(crypto.createPreparedService).not.toHaveBeenCalled();

    crypto.setResponse({ outcome: "applied", response: batchReplayResponse(NOTE_B) });
    await expectServiceError(
      coordinator(adapter, crypto).undoMutationBatch(
        MUTATION,
        MutationUndoRequestSchema.parse({ expectedRevision: 2, idempotencyKey: IDEMPOTENCY })
      ),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
  });

  it("commits an unsafe stale batch as Review before returning the private conflict", async () => {
    const crypto = cryptoHarness();
    const member = Object.freeze({
      ...batchMemberFixture(noteRead(snapshot("After"), 2)),
      currentMutation: null
    });
    const preparation = batchPreparation(member, true);
    crypto.sourcePayloads.set(`capture_receipt:${CAPTURE}:1`, sourceReceipt());
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["undoMutationBatch"]>[0]) => {
        expect(input.command).toMatchObject({ selectedOutcome: "needs_review", writes: [] });
        return Promise.resolve(
          commitResult("encrypted_mutation_batch_undo", "needs_review", crypto.responseCipher(), {
            reviewItemId: REVIEW
          })
        );
      }
    );
    const adapter = adapterStub({
      getMutationBatch: vi.fn(() => Promise.resolve(preparation)),
      undoMutationBatch: commit
    });

    await expectServiceError(
      coordinator(adapter, crypto).undoMutationBatch(
        MUTATION,
        MutationUndoRequestSchema.parse({ expectedRevision: 2, idempotencyKey: IDEMPOTENCY })
      ),
      ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0].command).toHaveProperty("review.reviewItemId", REVIEW);
    expect(commit.mock.calls[0]?.[0].command).toHaveProperty("writes.length", 0);
    expect(vi.mocked(crypto.service.sealCaptureReceipt).mock.calls[0]?.[1].payload).toMatchObject({
      decisionId: null,
      reasonCodes: ["conflict_requires_review"]
    });
  });

  it("seals a receipt-free batch conflict with the non-first anchor note privacy", async () => {
    const crypto = cryptoHarness();
    const first = batchMemberFixture(noteRead(snapshot("First"), 2));
    const anchor = Object.freeze({
      ...first,
      ordinal: 1,
      noteId: NOTE_B,
      targetMutationId: MUTATION,
      sourcePrivacy: "private_manual" as const,
      targetPrivacy: "private_manual" as const,
      revisionId: DESTINATION_REVISION,
      mutationId: DESTINATION_MUTATION,
      currentNote: null,
      currentMutation: null
    });
    const basePreparation = batchPreparation(first);
    const preparation: PrepareMutationBatchUndoResult = Object.freeze({
      ...basePreparation,
      requestMacKey: key("content_mac", "private_manual"),
      members: Object.freeze([
        Object.freeze({ ...first, targetMutationId: MUTATION_UNDO }),
        anchor
      ]),
      commonReservations: Object.freeze([
        reservation(
          "response",
          "idempotency_response",
          `idempotency:${IDEMPOTENCY}`,
          1,
          40,
          "private_manual"
        )
      ]),
      branches: Object.freeze({
        applied: Object.freeze({
          available: false,
          batchId: null,
          reservations: Object.freeze([])
        }),
        needsReview: Object.freeze({
          ...basePreparation.branches.needsReview,
          reservations: Object.freeze([
            reservation("review", "review_item", REVIEW, 1, 41, "private_manual")
          ])
        })
      })
    });
    const commit = vi.fn(() =>
      Promise.resolve(
        commitResult("encrypted_mutation_batch_undo", "needs_review", crypto.responseCipher(), {
          reviewItemId: REVIEW,
          responseVerificationMac: mac("private_manual")
        })
      )
    );
    const adapter = adapterStub({
      getMutationBatch: vi.fn(() => Promise.resolve(preparation)),
      undoMutationBatch: commit
    });

    await expectServiceError(
      coordinator(adapter, crypto).undoMutationBatch(
        MUTATION,
        MutationUndoRequestSchema.parse({ expectedRevision: 2, idempotencyKey: IDEMPOTENCY })
      ),
      ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(vi.mocked(crypto.service.sealReview).mock.calls[0]?.[1]).toMatchObject({
      sourcePrivacy: "private_manual"
    });
  });

  it("dismisses a capture-linked Review without rewriting its receipt or requiring retained capture", async () => {
    const crypto = cryptoHarness();
    const preparation = reviewPreparation(true);
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: { type: "conflict", reason: "revision" },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitReviewResolution"]>[0]) => {
        expect(input.command).toHaveProperty("receipt", null);
        return Promise.resolve(
          commitResult("encrypted_review_resolution", "dismissed", crypto.responseCipher(), {
            reviewItemId: REVIEW
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "dismiss" }
        })
      )
    ).resolves.toMatchObject({
      reviewItem: { id: REVIEW, captureId: CAPTURE, state: "dismissed" },
      replayed: false
    });
    expect(crypto.service.openCaptureReceipt).not.toHaveBeenCalled();
    expect(crypto.service.openCapture).not.toHaveBeenCalled();
    expect(crypto.service.sealCaptureReceipt).not.toHaveBeenCalled();
  });

  it("continues an incomplete replayed duplicate preparation with the same reservations", async () => {
    const crypto = cryptoHarness();
    const first = reviewPreparation();
    if (first.completed || first.source.review === null) {
      throw new TypeError("invalid_test_preparation");
    }
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...first,
      action: "keep_both" as const,
      replayed: true,
      source: Object.freeze({
        ...first.source,
        review: Object.freeze({
          ...first.source.review,
          type: "duplicate_suggestion" as const
        })
      })
    });
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: {
        type: "duplicate_notes",
        explanation: "These notes may overlap.",
        notes: [
          { noteId: NOTE_A, revision: 2 },
          { noteId: NOTE_B, revision: 1 }
        ]
      },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitReviewResolution"]>[0]) => {
        expect(input.preparation.replayed).toBe(true);
        expect(input.preparation.reservations).toEqual(first.reservations);
        return Promise.resolve(
          commitResult("encrypted_review_resolution", "resolved", crypto.responseCipher(), {
            reviewItemId: REVIEW
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "keep_both" }
        })
      )
    ).resolves.toMatchObject({
      reviewItem: {
        id: REVIEW,
        type: "duplicate_suggestion",
        state: "resolved",
        resolution: { type: "keep_both" }
      },
      replayed: false
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(crypto.service.sealNoteContent).not.toHaveBeenCalled();
    expect(crypto.service.sealNoteRevision).not.toHaveBeenCalled();
    expect(crypto.service.sealNoteMutation).not.toHaveBeenCalled();
  });

  it("keeps a decision-free batch-conflict receipt in Inbox without reviving route lineage", async () => {
    const crypto = cryptoHarness();
    const base = reviewPreparation(true);
    if (base.completed || base.source.receipt === null) {
      throw new TypeError("invalid_test_preparation");
    }
    const receiptCipher = stored("capture_receipt", CAPTURE, 2);
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...base,
      action: "keep_inbox" as const,
      source: Object.freeze({
        ...base.source,
        decision: null,
        capture: null,
        receipt: Object.freeze({
          ...base.source.receipt,
          decisionId: null,
          reviewItemId: REVIEW,
          mutationId: null,
          outcome: "needs_review" as const,
          destinationNoteId: null,
          reasonCodes: Object.freeze(["conflict_requires_review"]),
          recordVersion: 2,
          receiptCipher
        })
      }),
      reservations: Object.freeze([
        reservation("review", "review_item", REVIEW, 2, 30),
        reservation("receipt", "capture_receipt", CAPTURE, 3, 31),
        reservation("response", "idempotency_response", `idempotency:${IDEMPOTENCY}`, 1, 32)
      ])
    });
    crypto.sourcePayloads.set(`capture_receipt:${CAPTURE}:2`, {
      schemaVersion: 2,
      captureId: CAPTURE,
      jobId: JOB,
      decisionId: null,
      reviewItemId: REVIEW,
      mutationId: null,
      outcome: "needs_review",
      headline: "Needs your review",
      destination: null,
      insertedContentReferences: [],
      actions: [],
      reasonCodes: ["conflict_requires_review"],
      createdAt: NOW,
      undoTargets: []
    });
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: { type: "conflict", reason: "revision" },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitReviewResolution"]>[0]) => {
        expect(input.command).toMatchObject({ writes: [] });
        return Promise.resolve(
          commitResult("encrypted_review_resolution", "resolved", crypto.responseCipher(), {
            reviewItemId: REVIEW
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "keep_inbox" }
        })
      )
    ).resolves.toMatchObject({
      reviewItem: {
        id: REVIEW,
        captureId: CAPTURE,
        state: "resolved",
        resolution: { type: "keep_inbox" }
      },
      replayed: false
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(vi.mocked(crypto.service.sealCaptureReceipt).mock.calls[0]?.[1].payload).toMatchObject({
      decisionId: null,
      outcome: "kept_in_inbox",
      reasonCodes: ["review_resolved"]
    });
  });

  it("creates a private-manual destination from Review with decision-bound receipt lineage", async () => {
    const crypto = cryptoHarness();
    const preparation = privateReviewCreatePreparation();
    const rawContent = "Workout";
    const receipt = CaptureReceiptPayloadSchema.parse({
      schemaVersion: 2,
      captureId: CAPTURE,
      jobId: JOB,
      decisionId: DECISION,
      reviewItemId: REVIEW,
      mutationId: null,
      outcome: "needs_review",
      headline: "Choose a destination",
      destination: null,
      insertedContentReferences: [],
      actions: [],
      reasonCodes: ["low_confidence"],
      createdAt: NOW,
      undoTargets: []
    });
    crypto.sourcePayloads.set(`capture:${CAPTURE}:1`, {
      schemaVersion: 1,
      rawContent
    });
    crypto.sourcePayloads.set(`capture_receipt:${CAPTURE}:1`, receipt);
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: {
        type: "route_capture",
        plan: {
          schemaVersion: 1,
          captureKind: "freeform",
          decision: "add_to_inbox",
          destination: { candidateId: null, newNote: null },
          operations: [{ type: "append_raw", content: rawContent }],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["ambiguous_intent"]
        }
      },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitReviewResolution"]>[0]) => {
        expect(input.command).toMatchObject({
          writes: [
            {
              noteId: NOTE_B,
              noteState: { privacy: "private_manual" },
              noteCipher: { keyClass: "private_manual" },
              mutation: { cipher: { keyClass: "private_manual" } }
            }
          ],
          review: { cipher: { keyClass: "private_manual" } },
          receipt: { cipher: { keyClass: "ai_assisted" } },
          responseCipher: { keyClass: "private_manual" }
        });
        return Promise.resolve(
          commitResult("encrypted_review_resolution", "resolved", crypto.responseCipher(), {
            reviewItemId: REVIEW,
            members: Object.freeze([
              Object.freeze({
                role: "destination_write" as const,
                noteId: NOTE_B,
                currentRevision: 1,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ]),
            responseVerificationMac: mac("private_manual")
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: {
            type: "create",
            title: "Private log",
            noteType: "generic",
            spaceId: null
          }
        })
      )
    ).resolves.toMatchObject({
      reviewItem: {
        id: REVIEW,
        captureId: CAPTURE,
        noteId: NOTE_B,
        state: "resolved",
        resolution: { type: "create", title: "Private log" }
      },
      replayed: false
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(vi.mocked(crypto.service.sealReview).mock.calls[0]?.[1]).toMatchObject({
      sourcePrivacy: "private_manual"
    });
  });

  it("creates a note from a Review whose organizer plan deferred without operations", async () => {
    const crypto = cryptoHarness();
    const base = privateReviewCreatePreparation();
    if (base.completed || base.source.receipt === null || base.source.capture === null) {
      throw new Error("Review create fixture requires a source capture and receipt");
    }
    const rawContent = "2 protein shakes, sunflower seeds, 3 cups coffee";
    // The commit function projects one content-free reason onto the receipt row.
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...base,
      source: Object.freeze({
        ...base.source,
        capture: Object.freeze({ ...base.source.capture, contentLength: rawContent.length }),
        receipt: Object.freeze({
          ...base.source.receipt,
          reasonCodes: Object.freeze(["ambiguous_intent"])
        })
      })
    });
    crypto.sourcePayloads.set(`capture:${CAPTURE}:1`, { schemaVersion: 1, rawContent });
    crypto.sourcePayloads.set(
      `capture_receipt:${CAPTURE}:1`,
      CaptureReceiptPayloadSchema.parse({
        schemaVersion: 2,
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review",
        headline: "Needs your review",
        destination: null,
        insertedContentReferences: [],
        actions: [],
        reasonCodes: ["ambiguous_intent", "no_candidate_fit", "parser_override"],
        createdAt: NOW,
        undoTargets: []
      })
    );
    // The organizer's deferred plan: needs_review with no operations at all.
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: {
        type: "route_capture",
        plan: {
          schemaVersion: 1,
          captureKind: "log_entry",
          decision: "needs_review",
          destination: { candidateId: null, newNote: null },
          operations: [],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["ambiguous_intent", "no_candidate_fit", "parser_override"]
        }
      },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitReviewResolution"]>[0]) => {
        expect(input.command).toMatchObject({
          writes: [{ noteId: NOTE_B, noteState: { privacy: "private_manual" } }]
        });
        return Promise.resolve(
          commitResult("encrypted_review_resolution", "resolved", crypto.responseCipher(), {
            reviewItemId: REVIEW,
            members: Object.freeze([
              Object.freeze({
                role: "destination_write" as const,
                noteId: NOTE_B,
                currentRevision: 1,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ]),
            responseVerificationMac: mac("private_manual")
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "create", title: "Food log", noteType: "generic", spaceId: null }
        })
      )
    ).resolves.toMatchObject({
      reviewItem: { id: REVIEW, noteId: NOTE_B, state: "resolved" },
      replayed: false
    });
    expect(commit).toHaveBeenCalledOnce();
    const sealedContent = vi.mocked(crypto.service.sealNoteContent).mock.calls[0]?.[1];
    expect(JSON.stringify(sealedContent ?? {})).toContain(rawContent);
  });

  it("creates a log note from Review for a capture longer than one old log field", async () => {
    // "Let Unfiled decide" on a detailed workout log: the note is seeded with the whole capture
    // as one entry. Under the 500-character field bound that write failed and the API answered
    // 503, which the phone read as "The service is busy".
    const crypto = cryptoHarness();
    const base = privateReviewCreatePreparation();
    if (base.completed || base.source.receipt === null || base.source.capture === null) {
      throw new Error("Review create fixture requires a source capture and receipt");
    }
    const rawContent = Array.from(
      { length: 12 },
      (_, index) => `Set ${index + 1}: bench press 4x8 at 185 lb, last rep slow and clean.`
    ).join("\n");
    expect(rawContent.length).toBeGreaterThan(500);
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...base,
      source: Object.freeze({
        ...base.source,
        capture: Object.freeze({ ...base.source.capture, contentLength: rawContent.length }),
        receipt: Object.freeze({
          ...base.source.receipt,
          reasonCodes: Object.freeze(["low_information"])
        })
      })
    });
    crypto.sourcePayloads.set(`capture:${CAPTURE}:1`, { schemaVersion: 1, rawContent });
    crypto.sourcePayloads.set(
      `capture_receipt:${CAPTURE}:1`,
      CaptureReceiptPayloadSchema.parse({
        schemaVersion: 2,
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review",
        headline: "Needs your review",
        destination: null,
        insertedContentReferences: [],
        actions: [],
        reasonCodes: ["low_information"],
        createdAt: NOW,
        undoTargets: []
      })
    );
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: {
        type: "route_capture",
        plan: {
          schemaVersion: 1,
          captureKind: "log_entry",
          decision: "needs_review",
          destination: { candidateId: null, newNote: null },
          operations: [],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["low_information"]
        }
      },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitReviewResolution"]>[0]) => {
        expect(input.command).toMatchObject({
          writes: [{ noteId: NOTE_B, noteState: { privacy: "private_manual" } }]
        });
        return Promise.resolve(
          commitResult("encrypted_review_resolution", "resolved", crypto.responseCipher(), {
            reviewItemId: REVIEW,
            members: Object.freeze([
              Object.freeze({
                role: "destination_write" as const,
                noteId: NOTE_B,
                currentRevision: 1,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ]),
            responseVerificationMac: mac("private_manual")
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "create", title: "Workout log", noteType: "log", spaceId: null }
        })
      )
    ).resolves.toMatchObject({
      reviewItem: { id: REVIEW, noteId: NOTE_B, state: "resolved" },
      replayed: false
    });
    expect(commit).toHaveBeenCalledOnce();
    const sealedContent = vi.mocked(crypto.service.sealNoteContent).mock.calls[0]?.[1];
    const sealed = JSON.stringify(sealedContent ?? {});
    expect(sealed).toContain("Set 12: bench press");
    expect(sealed).toContain('"entries"');
  });

  it("keeps the photo when the owner files a photo capture from Review", async () => {
    const crypto = cryptoHarness();
    const base = privateReviewCreatePreparation();
    if (base.completed || base.source.receipt === null || base.source.capture === null) {
      throw new Error("Review create fixture requires a source capture and receipt");
    }
    const rawContent = "Photo";
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...base,
      source: Object.freeze({
        ...base.source,
        capture: Object.freeze({ ...base.source.capture, contentLength: rawContent.length })
      })
    });
    crypto.sourcePayloads.set(`capture:${CAPTURE}:1`, { schemaVersion: 1, rawContent });
    crypto.sourcePayloads.set(
      `capture_receipt:${CAPTURE}:1`,
      CaptureReceiptPayloadSchema.parse({
        schemaVersion: 2,
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review",
        headline: "Needs your review",
        destination: null,
        insertedContentReferences: [],
        actions: [],
        reasonCodes: ["low_confidence"],
        createdAt: NOW,
        undoTargets: []
      })
    );
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: {
        type: "route_capture",
        plan: {
          schemaVersion: 1,
          captureKind: "freeform",
          decision: "needs_review",
          destination: { candidateId: null, newNote: null },
          operations: [],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["ambiguous_intent"]
        }
      },
      state: "open",
      resolution: null
    });
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: vi.fn(() =>
        Promise.resolve(
          commitResult("encrypted_review_resolution", "resolved", crypto.responseCipher(), {
            reviewItemId: REVIEW,
            members: Object.freeze([
              Object.freeze({
                role: "destination_write" as const,
                noteId: NOTE_B,
                currentRevision: 1,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ]),
            responseVerificationMac: mac("private_manual")
          })
        )
      )
    });
    const listCaptureAttachments = vi.fn(() =>
      Promise.resolve([
        { id: PHOTO, kind: "image" as const },
        { id: RECORDING, kind: "audio" as const }
      ])
    );

    await expect(
      coordinator(adapter, crypto, undefined, undefined, listCaptureAttachments).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "create", title: "Receipt", noteType: "generic", spaceId: null }
        })
      )
    ).resolves.toMatchObject({ reviewItem: { id: REVIEW, noteId: NOTE_B }, replayed: false });
    expect(listCaptureAttachments).toHaveBeenCalledWith(CAPTURE);
    // The photo the owner filed has to survive into the note that files it, placed the way the
    // organizer places one: its own paragraph of references, after the owner's own words.
    const sealedContent = JSON.stringify(
      vi.mocked(crypto.service.sealNoteContent).mock.calls[0]?.[1] ?? {}
    );
    expect(sealedContent).toContain(`![Photo](unfiled-attachment:${PHOTO})`);
    expect(sealedContent).toContain(`[Recording](unfiled-attachment:${RECORDING})`);
  });

  it("creates a list note from a Review with the capture split into items", async () => {
    const crypto = cryptoHarness();
    const base = privateReviewCreatePreparation();
    if (base.completed || base.source.receipt === null || base.source.capture === null) {
      throw new Error("Review create fixture requires a source capture and receipt");
    }
    const rawContent = "Groceries: milk, eggs, bread";
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...base,
      source: Object.freeze({
        ...base.source,
        capture: Object.freeze({ ...base.source.capture, contentLength: rawContent.length }),
        receipt: Object.freeze({
          ...base.source.receipt,
          reasonCodes: Object.freeze(["ambiguous_intent"])
        })
      })
    });
    crypto.sourcePayloads.set(`capture:${CAPTURE}:1`, { schemaVersion: 1, rawContent });
    crypto.sourcePayloads.set(
      `capture_receipt:${CAPTURE}:1`,
      CaptureReceiptPayloadSchema.parse({
        schemaVersion: 2,
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review",
        headline: "Needs your review",
        destination: null,
        insertedContentReferences: [],
        actions: [],
        reasonCodes: ["ambiguous_intent", "no_candidate_fit"],
        createdAt: NOW,
        undoTargets: []
      })
    );
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: {
        type: "route_capture",
        plan: {
          schemaVersion: 1,
          captureKind: "list_items",
          decision: "needs_review",
          destination: { candidateId: null, newNote: null },
          operations: [],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["ambiguous_intent", "no_candidate_fit"]
        }
      },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitReviewResolution"]>[0]) => {
        expect(input.command).toMatchObject({ writes: [{ noteId: NOTE_B }] });
        return Promise.resolve(
          commitResult("encrypted_review_resolution", "resolved", crypto.responseCipher(), {
            reviewItemId: REVIEW,
            members: Object.freeze([
              Object.freeze({
                role: "destination_write" as const,
                noteId: NOTE_B,
                currentRevision: 1,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ]),
            responseVerificationMac: mac("private_manual")
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "create", title: "Groceries", noteType: "list", spaceId: null }
        })
      )
    ).resolves.toMatchObject({ reviewItem: { id: REVIEW, noteId: NOTE_B, state: "resolved" } });
    const sealedContent = JSON.stringify(
      vi.mocked(crypto.service.sealNoteContent).mock.calls[0]?.[1] ?? {}
    );
    // Three separate items, not one paragraph carrying the whole line.
    expect(sealedContent).toMatch(/"(text|content|label)":"milk"/);
    expect(sealedContent).toMatch(/"(text|content|label)":"eggs"/);
    expect(sealedContent).toMatch(/"(text|content|label)":"bread"/);
    expect(sealedContent).not.toContain("Groceries: milk, eggs, bread");
  });

  it("routes a private Review into an AI note without downgrading Review history", async () => {
    const crypto = cryptoHarness();
    const preparation = privateReviewRoutePreparation();
    const rawContent = "Workout";
    const existing = snapshot("Existing log");
    crypto.sourcePayloads.set(`note_content:${NOTE_A}:1`, {
      schemaVersion: 1,
      title: existing.title,
      bodyMarkdown: existing.bodyMarkdown,
      structuredData: existing.structuredData
    });
    crypto.sourcePayloads.set(`capture:${CAPTURE}:1`, {
      schemaVersion: 1,
      rawContent
    });
    crypto.sourcePayloads.set(
      `capture_receipt:${CAPTURE}:1`,
      CaptureReceiptPayloadSchema.parse({
        schemaVersion: 2,
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review",
        headline: "Choose a destination",
        destination: null,
        insertedContentReferences: [],
        actions: [],
        reasonCodes: ["low_confidence"],
        createdAt: NOW,
        undoTargets: []
      })
    );
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: {
        type: "route_capture",
        plan: {
          schemaVersion: 1,
          captureKind: "freeform",
          decision: "add_to_inbox",
          destination: { candidateId: null, newNote: null },
          operations: [{ type: "append_raw", content: rawContent }],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["ambiguous_intent"]
        }
      },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(
      (input: Parameters<EncryptedOwnerInteractionRpcAdapter["commitReviewResolution"]>[0]) => {
        expect(input.command).toMatchObject({
          writes: [
            {
              noteId: NOTE_A,
              noteState: { privacy: "ai_assisted" },
              noteCipher: { keyClass: "ai_assisted" },
              revision: {
                cipher: { keyClass: "ai_assisted" },
                mac: { keyClass: "ai_assisted" }
              },
              mutation: { cipher: { keyClass: "ai_assisted" } },
              verification: {
                noteContent: { keyClass: "ai_assisted" },
                noteMutation: { keyClass: "ai_assisted" }
              }
            }
          ],
          review: { cipher: { keyClass: "private_manual" } },
          receipt: { cipher: { keyClass: "private_manual" } },
          responseCipher: { keyClass: "private_manual" },
          responseVerificationMac: { keyClass: "private_manual" }
        });
        return Promise.resolve(
          commitResult("encrypted_review_resolution", "resolved", crypto.responseCipher(), {
            reviewItemId: REVIEW,
            members: Object.freeze([
              Object.freeze({
                role: "destination_write" as const,
                noteId: NOTE_A,
                currentRevision: 2,
                revisionId: DESTINATION_REVISION,
                mutationId: DESTINATION_MUTATION
              })
            ]),
            responseVerificationMac: mac("private_manual")
          })
        );
      }
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "route", noteId: NOTE_A, expectedRevision: 1 }
        })
      )
    ).resolves.toMatchObject({
      reviewItem: {
        id: REVIEW,
        noteId: NOTE_A,
        state: "resolved",
        resolution: { type: "route", noteId: NOTE_A }
      },
      replayed: false
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(vi.mocked(crypto.service.sealReview).mock.calls[0]?.[1]).toMatchObject({
      sourcePrivacy: "private_manual"
    });
  });

  it("replays an immutable completed Review response without re-reading mutable Review state", async () => {
    const crypto = cryptoHarness();
    const pending = reviewPreparation();
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...pending,
      completed: true,
      replayed: true,
      source: null,
      members: Object.freeze([]),
      reservations: Object.freeze([]),
      encryptedResponse: stored("idempotency_response", `idempotency:${IDEMPOTENCY}`, 1),
      encryptedResponseVerificationMac: mac()
    });
    const storedResponse = {
      reviewItem: {
        id: REVIEW,
        captureId: null,
        noteId: null,
        type: "revision_conflict" as const,
        proposal: { type: "conflict" as const, reason: "revision" as const },
        state: "dismissed" as const,
        resolution: { type: "dismiss" as const },
        createdAt: NOW,
        resolvedAt: NOW
      },
      replayed: false
    };
    crypto.setResponse(storedResponse);
    const commit = vi.fn(() =>
      Promise.resolve(
        commitResult("encrypted_review_resolution", "dismissed", preparation.encryptedResponse, {
          reviewItemId: REVIEW,
          replayed: true
        })
      )
    );
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expect(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "dismiss" }
        })
      )
    ).resolves.toEqual({ ...storedResponse, replayed: true });
    expect(crypto.createPreparedService).not.toHaveBeenCalled();
  });

  it.each(["accept", "reject"] as const)(
    "%ss a generated block without rewriting user-authored note content",
    async (resolution) => {
      const crypto = cryptoHarness();
      const firstPreparation = generatedBlockPreparation(resolution);
      const preparation: PrepareGeneratedBlockResolutionResult = Object.freeze({
        ...firstPreparation,
        replayed: true
      });
      if (preparation.completed || preparation.source.generatedBlock === undefined) {
        throw new TypeError("invalid_generated_block_preparation");
      }
      const sourceBlock = preparation.source.generatedBlock;
      crypto.sourcePayloads.set(`generated_block:${BLOCK}:1`, {
        schemaVersion: 1,
        content: "A separately encrypted expansion"
      });
      crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
        schemaVersion: 2,
        proposal: { type: "generated_block", blockId: BLOCK },
        state: "open",
        resolution: null
      });
      crypto.sourcePayloads.set(
        `capture_receipt:${CAPTURE}:1`,
        CaptureReceiptPayloadSchema.parse({
          schemaVersion: 2,
          captureId: CAPTURE,
          jobId: JOB,
          decisionId: DECISION,
          reviewItemId: REVIEW,
          mutationId: MUTATION,
          outcome: "added_to_note",
          headline: "Added to a note",
          destination: { noteId: NOTE_A, title: "After" },
          insertedContentReferences: [
            { type: "captured", itemId: null },
            { type: "ai_generated", blockId: BLOCK }
          ],
          actions: [
            { type: "open", noteId: NOTE_A },
            { type: "move", noteId: NOTE_A, decisionId: DECISION },
            { type: "undo", mutationId: MUTATION, expectedRevision: 2 }
          ],
          reasonCodes: ["semantic_match"],
          createdAt: NOW,
          undoTargets: [{ noteId: NOTE_A, mutationId: MUTATION, expectedRevision: 2 }]
        })
      );
      const commit = vi.fn(
        (
          input: Parameters<
            EncryptedOwnerInteractionRpcAdapter["commitGeneratedBlockResolution"]
          >[0]
        ) => {
          expect(input.preparation.replayed).toBe(true);
          expect(input.preparation.reservations).toEqual(firstPreparation.reservations);
          expect(input.command).toMatchObject({ writes: [] });
          return Promise.resolve({
            scope: "encrypted_review_resolution" as const,
            outcome: resolution === "accept" ? ("accepted" as const) : ("rejected" as const),
            decisionId: null,
            reviewItemId: REVIEW,
            feedbackEventId: FEEDBACK,
            batchId: null,
            members: Object.freeze([]),
            encryptedResponse: crypto.responseCipher(),
            responseVerificationMac: mac(),
            replayed: false,
            generatedBlockId: BLOCK,
            stateRevision: 2
          });
        }
      );
      const adapter = adapterStub({
        prepareGeneratedBlockResolution: vi.fn(() => Promise.resolve(preparation)),
        commitGeneratedBlockResolution: commit
      });
      const blockReader = {
        get: vi.fn(() =>
          Promise.resolve({
            source: sourceBlock,
            payload: { schemaVersion: 1, content: "A separately encrypted expansion" },
            block: {
              id: BLOCK,
              noteId: NOTE_A,
              decisionId: DECISION,
              kind: "suggestion",
              content: "A separately encrypted expansion",
              state: "proposed",
              stateRevision: 1,
              modelId: "gpt-test",
              promptVersion: "organizer-v1",
              createdAt: NOW,
              resolvedAt: null
            }
          })
        )
      } as unknown as EncryptedGeneratedBlockReader;

      await expect(
        coordinator(adapter, crypto).resolveGeneratedBlock(
          BLOCK,
          GeneratedBlockResolveRequestSchema.parse({
            expectedStateRevision: 1,
            idempotencyKey: IDEMPOTENCY,
            resolution
          }),
          blockReader
        )
      ).resolves.toMatchObject({
        block: {
          id: BLOCK,
          state: resolution === "accept" ? "accepted" : "rejected",
          stateRevision: 2,
          content: "A separately encrypted expansion"
        },
        replayed: false
      });
      expect(commit).toHaveBeenCalledOnce();
      expect(crypto.service.sealNoteContent).not.toHaveBeenCalled();
      expect(crypto.service.sealNoteRevision).not.toHaveBeenCalled();
      expect(crypto.service.sealNoteMutation).not.toHaveBeenCalled();
      const sealedReceipt = vi.mocked(crypto.service.sealCaptureReceipt).mock.calls[0]?.[1]
        .payload as {
        insertedContentReferences: readonly { type: string }[];
        reasonCodes: string[];
      };
      expect(sealedReceipt.reasonCodes).toContain(
        resolution === "accept" ? "expansion_accepted" : "expansion_rejected"
      );
      expect(
        sealedReceipt.insertedContentReferences.some(
          (reference) => reference.type === "ai_generated"
        )
      ).toBe(resolution === "accept");
    }
  );

  it("refuses generic Review dismissal for a persisted generated block", async () => {
    const crypto = cryptoHarness();
    const base = reviewPreparation();
    if (base.completed || base.source.review === null) throw new TypeError("invalid_preparation");
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...base,
      source: Object.freeze({
        ...base.source,
        review: Object.freeze({
          ...base.source.review,
          noteId: NOTE_A,
          type: "pending_expansion" as const
        })
      })
    });
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: { type: "generated_block", blockId: BLOCK },
      state: "open",
      resolution: null
    });
    const commit = vi.fn();
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expectServiceError(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "dismiss" }
        })
      ),
      ServiceRpcErrorCode.VALIDATION_FAILED
    );
    expect(commit).not.toHaveBeenCalled();
    expect(crypto.createPreparedService).not.toHaveBeenCalled();
  });

  it("rejects a ciphertext-valid fresh Review response with a substituted note and proposal", async () => {
    const crypto = cryptoHarness();
    const pending = reviewPreparation();
    if (pending.completed || pending.source.review === null) {
      throw new TypeError("invalid_test_preparation");
    }
    const preparation: PrepareReviewResolutionResult = Object.freeze({
      ...pending,
      source: Object.freeze({
        ...pending.source,
        review: Object.freeze({
          ...pending.source.review,
          noteId: NOTE_A,
          type: "duplicate_suggestion" as const
        })
      })
    });
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: {
        type: "duplicate_notes",
        explanation: "These notes overlap.",
        notes: [
          { noteId: NOTE_A, revision: 2 },
          { noteId: NOTE_B, revision: 1 }
        ]
      },
      state: "open",
      resolution: null
    });
    const commit = vi.fn(() => {
      crypto.setResponse({
        reviewItem: {
          id: REVIEW,
          captureId: null,
          noteId: NOTE_B,
          type: "duplicate_suggestion",
          proposal: {
            type: "duplicate_notes",
            explanation: "These notes overlap.",
            notes: [
              { noteId: NOTE_A, revision: 3 },
              { noteId: NOTE_B, revision: 1 }
            ]
          },
          state: "dismissed",
          resolution: { type: "dismiss" },
          createdAt: NOW,
          resolvedAt: NOW
        },
        replayed: false
      });
      return Promise.resolve(
        commitResult("encrypted_review_resolution", "dismissed", crypto.responseCipher(), {
          reviewItemId: REVIEW
        })
      );
    });
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expectServiceError(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "dismiss" }
        })
      ),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it("rejects a Review metadata/proposal semantic mismatch before sealing or commit", async () => {
    const crypto = cryptoHarness();
    crypto.sourcePayloads.set(`review_item:${REVIEW}:1`, {
      schemaVersion: 2,
      proposal: { type: "conflict", reason: "candidate_eligibility" },
      state: "open",
      resolution: null
    });
    const preparation = reviewPreparation();
    const commit = vi.fn();
    const adapter = adapterStub({
      prepareReviewResolution: vi.fn(() => Promise.resolve(preparation)),
      commitReviewResolution: commit
    });

    await expectServiceError(
      coordinator(adapter, crypto).resolveReviewItem(
        REVIEW,
        ReviewResolveRequestSchema.parse({
          idempotencyKey: IDEMPOTENCY,
          resolution: { type: "dismiss" }
        })
      ),
      ServiceRpcErrorCode.VALIDATION_FAILED
    );
    expect(commit).not.toHaveBeenCalled();
    expect(crypto.createPreparedService).not.toHaveBeenCalled();
  });
});

function snapshot(title: string): NoteSnapshot {
  return NoteSnapshotSchema.parse({
    spaceId: null,
    type: "generic",
    title,
    bodyMarkdown: title,
    structuredData: { schemaVersion: 1 },
    isOpen: true,
    pinnedAt: null,
    privacy: "ai_assisted",
    archivedAt: null,
    deletedAt: null,
    tagIds: [],
    links: []
  });
}

function batchReplayResponse(noteId: EntityId<"note"> = NOTE_A) {
  const value = snapshot("Before");
  return MutationBatchUndoResponseSchema.parse({
    members: [
      {
        note: {
          ...value,
          id: noteId,
          currentRevision: 3,
          createdAt: NOW,
          updatedAt: NOW,
          attachments: noteAttachmentReferences(value.bodyMarkdown)
        },
        revision: {
          ...value,
          id: REV_UNDO,
          noteId,
          revision: 3,
          source: "undo",
          contentHash: "a".repeat(64),
          actor: "user:undo",
          createdAt: NOW
        },
        mutationId: MUTATION_UNDO,
        undo: { eligible: false, expiresAt: null }
      }
    ],
    replayed: false
  });
}

function noteRead(value: NoteSnapshot, revision: number, noteId: EntityId<"note"> = NOTE_A) {
  return Object.freeze({
    noteId,
    currentRevision: revision,
    spaceId: value.spaceId,
    type: value.type,
    dailyDate: null,
    isOpen: value.isOpen,
    pinnedAt: value.pinnedAt,
    privacy: value.privacy,
    archivedAt: value.archivedAt,
    deletedAt: value.deletedAt,
    createdAt: NOW,
    updatedAt: NOW,
    contentCipher: stored("note_content", noteId, revision),
    space: null,
    tags: Object.freeze([]),
    links: Object.freeze([])
  });
}

function batchMemberFixture(
  currentNote: ReturnType<typeof noteRead>
): OwnerInteractionPreparedMember {
  return Object.freeze({
    ordinal: 0,
    role: "undo" as const,
    noteId: NOTE_A,
    targetMutationId: MUTATION,
    expectedRevision: 2,
    sourcePrivacy: "ai_assisted" as const,
    targetPrivacy: "ai_assisted" as const,
    revisionId: REV_UNDO,
    mutationId: MUTATION_UNDO,
    currentNote,
    currentMutation: Object.freeze({
      mutationId: MUTATION,
      noteId: NOTE_A,
      decisionId: DECISION,
      idempotencyKey: "original-mutation",
      beforeRevision: 1,
      afterRevision: 2,
      undoneAt: null,
      createdAt: NOW,
      mutationCipher: stored("note_mutation", MUTATION, 2),
      currentNote,
      beforeSnapshot: Object.freeze({
        revisionId: REV_BEFORE,
        revision: 1,
        privacy: "ai_assisted" as const,
        snapshotCipher: stored("note_revision", REV_BEFORE, 1),
        snapshotMac: mac()
      }),
      afterSnapshot: Object.freeze({
        revisionId: REV_AFTER,
        revision: 2,
        privacy: "ai_assisted" as const,
        snapshotCipher: stored("note_revision", REV_AFTER, 2),
        snapshotMac: mac()
      })
    })
  });
}

function updateMutationPayload(
  before: NoteSnapshot,
  after: NoteSnapshot,
  beforeRevision: number,
  afterRevision: number
) {
  return NoteMutationPayloadSchema.parse({
    schemaVersion: 1,
    action: "update",
    beforeRevision,
    afterRevision,
    operations: [{ type: "set_title", title: after.title }],
    inverse: [
      {
        type: "restore_snapshot",
        spaceId: before.spaceId,
        noteType: before.type,
        title: before.title,
        bodyMarkdown: before.bodyMarkdown,
        structuredData: before.structuredData,
        privacy: before.privacy,
        isOpen: before.isOpen,
        pinnedAt: before.pinnedAt,
        archivedAt: before.archivedAt,
        deletedAt: before.deletedAt,
        tagIds: before.tagIds,
        links: before.links
      }
    ],
    beforeSnapshot: before,
    afterSnapshot: after
  });
}

function correctionUndoMember(
  input: Readonly<{
    ordinal: number;
    noteId: EntityId<"note">;
    targetMutationId: EntityId<"mut">;
    outputRevisionId: EntityId<"rev">;
    outputMutationId: EntityId<"mut">;
    beforeRevisionId: EntityId<"rev">;
    afterRevisionId: EntityId<"rev">;
    before: NoteSnapshot;
    after: NoteSnapshot;
    expectedRevision: number;
  }>
): OwnerInteractionPreparedMember {
  const beforeRevision = input.expectedRevision - 1;
  const currentNote = noteRead(input.after, input.expectedRevision, input.noteId);
  return Object.freeze({
    ordinal: input.ordinal,
    role: "undo" as const,
    noteId: input.noteId,
    targetMutationId: input.targetMutationId,
    expectedRevision: input.expectedRevision,
    sourcePrivacy: "ai_assisted" as const,
    targetPrivacy: "ai_assisted" as const,
    revisionId: input.outputRevisionId,
    mutationId: input.outputMutationId,
    currentNote,
    currentMutation: Object.freeze({
      mutationId: input.targetMutationId,
      noteId: input.noteId,
      decisionId: DECISION,
      idempotencyKey: `correction-${input.ordinal}`,
      beforeRevision,
      afterRevision: input.expectedRevision,
      undoneAt: null,
      createdAt: NOW,
      mutationCipher: stored("note_mutation", input.targetMutationId, input.expectedRevision),
      currentNote,
      beforeSnapshot: Object.freeze({
        revisionId: input.beforeRevisionId,
        revision: beforeRevision,
        privacy: "ai_assisted" as const,
        snapshotCipher: stored("note_revision", input.beforeRevisionId, beforeRevision),
        snapshotMac: mac()
      }),
      afterSnapshot: Object.freeze({
        revisionId: input.afterRevisionId,
        revision: input.expectedRevision,
        privacy: "ai_assisted" as const,
        snapshotCipher: stored("note_revision", input.afterRevisionId, input.expectedRevision),
        snapshotMac: mac()
      })
    })
  });
}

function batchPreparation(
  member: OwnerInteractionPreparedMember,
  withReceipt = false
): PrepareMutationBatchUndoResult {
  const receipt = correctionSource(false).receipt;
  return Object.freeze({
    scope: "encrypted_mutation_batch_undo" as const,
    occurredAt: NOW,
    completed: false,
    replayed: false,
    selectedOutcome: null,
    requestMacKey: key("content_mac"),
    ids: Object.freeze({
      anchorMutationId: MUTATION,
      sourceBatchKind: "organization" as const,
      restoredSourceTargetMutationId: null
    }),
    source: Object.freeze({
      decision: null,
      review: null,
      receipt: withReceipt ? receipt : null,
      capture: null
    }),
    members: Object.freeze([member]),
    commonReservations: Object.freeze([
      ...(withReceipt ? [reservation("receipt", "capture_receipt", CAPTURE, 2, 19)] : []),
      reservation("response", "idempotency_response", `idempotency:${IDEMPOTENCY}`, 1, 20)
    ]),
    branches: Object.freeze({
      applied: Object.freeze({
        available: true,
        batchId: BATCH_ID,
        reservations: Object.freeze([
          reservation("note_content:0", "note_content", NOTE_A, 3, 21),
          reservation("note_revision:0", "note_revision", REV_UNDO, 3, 22),
          reservation("note_mutation:0", "note_mutation", MUTATION_UNDO, 3, 23)
        ])
      }),
      needsReview: Object.freeze({
        available: true,
        reviewItemId: REVIEW,
        reservations: Object.freeze([reservation("review", "review_item", REVIEW, 1, 24)])
      })
    }),
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

function reviewPreparation(withReceipt = false): PrepareReviewResolutionResult {
  const correction = correctionSource(withReceipt);
  return Object.freeze({
    scope: "encrypted_review_resolution" as const,
    action: "dismiss" as const,
    occurredAt: NOW,
    completed: false,
    replayed: false,
    requestMacKey: key("content_mac"),
    ids: Object.freeze({
      reviewItemId: REVIEW,
      destinationNoteId: null,
      destinationRevisionId: null,
      destinationMutationId: null
    }),
    source: Object.freeze({
      decision: null,
      capture: null,
      receipt:
        withReceipt && correction.receipt !== null
          ? Object.freeze({ ...correction.receipt, reviewItemId: REVIEW })
          : null,
      review: Object.freeze({
        reviewItemId: REVIEW,
        captureId: withReceipt ? CAPTURE : null,
        noteId: null,
        type: "revision_conflict" as const,
        state: "open" as const,
        recordVersion: 1,
        createdAt: NOW,
        resolvedAt: null,
        contentCipher: stored("review_item", REVIEW, 1)
      })
    }),
    members: Object.freeze([]),
    reservations: Object.freeze([
      reservation("review", "review_item", REVIEW, 2, 30),
      reservation("response", "idempotency_response", `idempotency:${IDEMPOTENCY}`, 1, 32)
    ]),
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

function generatedBlockPreparation(
  resolution: "accept" | "reject"
): PrepareGeneratedBlockResolutionResult {
  return Object.freeze({
    scope: "encrypted_review_resolution" as const,
    action: resolution === "accept" ? ("accept_expansion" as const) : ("reject_expansion" as const),
    occurredAt: NOW,
    completed: false,
    replayed: false,
    requestMacKey: key("content_mac"),
    ids: Object.freeze({
      reviewItemId: REVIEW,
      destinationNoteId: null,
      destinationRevisionId: null,
      destinationMutationId: null,
      generatedBlockId: BLOCK,
      stateRevision: 1
    }),
    source: Object.freeze({
      decision: null,
      review: Object.freeze({
        reviewItemId: REVIEW,
        captureId: CAPTURE,
        noteId: NOTE_A,
        type: "pending_expansion" as const,
        state: "open" as const,
        recordVersion: 1,
        createdAt: NOW,
        resolvedAt: null,
        contentCipher: stored("review_item", REVIEW, 1)
      }),
      receipt: Object.freeze({
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: MUTATION,
        outcome: "added_to_note" as const,
        destinationNoteId: NOTE_A,
        reasonCodes: Object.freeze(["expansion_pending"]),
        recordVersion: 1,
        sourcePrivacy: "ai_assisted" as const,
        receiptCipher: stored("capture_receipt", CAPTURE, 1)
      }),
      capture: Object.freeze({
        captureId: CAPTURE,
        recordVersion: 1 as const,
        privacy: "ai_assisted" as const,
        status: "needs_review" as const,
        contentLength: 7,
        contentCipher: stored("capture", CAPTURE, 1),
        contentMac: mac()
      }),
      generatedBlock: Object.freeze({
        blockId: BLOCK,
        recordVersion: 1 as const,
        noteId: NOTE_A,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        kind: "suggestion" as const,
        state: "proposed" as const,
        stateRevision: 1,
        modelId: "gpt-test",
        promptVersion: "organizer-v1",
        resolvedAt: null,
        createdAt: NOW,
        contentCipher: stored("generated_block", BLOCK, 1)
      })
    }),
    members: Object.freeze([]),
    reservations: Object.freeze([
      reservation("review", "review_item", REVIEW, 2, 50),
      reservation("receipt", "capture_receipt", CAPTURE, 2, 51),
      reservation("response", "idempotency_response", `idempotency:${IDEMPOTENCY}`, 1, 52)
    ]),
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

function privateReviewCreatePreparation(): PrepareReviewResolutionResult {
  const sourceClass = "ai_assisted" as const;
  const targetClass = "private_manual" as const;
  return Object.freeze({
    scope: "encrypted_review_resolution" as const,
    action: "create" as const,
    occurredAt: NOW,
    completed: false,
    replayed: false,
    requestMacKey: key("content_mac", targetClass),
    ids: Object.freeze({
      reviewItemId: REVIEW,
      destinationNoteId: NOTE_B,
      destinationRevisionId: DESTINATION_REVISION,
      destinationMutationId: DESTINATION_MUTATION
    }),
    source: Object.freeze({
      decision: null,
      review: Object.freeze({
        reviewItemId: REVIEW,
        captureId: CAPTURE,
        noteId: null,
        type: "low_confidence" as const,
        state: "open" as const,
        recordVersion: 1,
        createdAt: NOW,
        resolvedAt: null,
        contentCipher: stored("review_item", REVIEW, 1, sourceClass)
      }),
      receipt: Object.freeze({
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review" as const,
        destinationNoteId: null,
        reasonCodes: Object.freeze(["low_confidence"]),
        recordVersion: 1,
        sourcePrivacy: sourceClass,
        receiptCipher: stored("capture_receipt", CAPTURE, 1, sourceClass)
      }),
      capture: Object.freeze({
        captureId: CAPTURE,
        recordVersion: 1 as const,
        privacy: sourceClass,
        status: "needs_review" as const,
        contentLength: 7,
        contentCipher: stored("capture", CAPTURE, 1, sourceClass),
        contentMac: mac(sourceClass)
      })
    }),
    members: Object.freeze([
      Object.freeze({
        ordinal: 0,
        role: "destination_write" as const,
        noteId: NOTE_B,
        targetMutationId: null,
        expectedRevision: 0,
        sourcePrivacy: null,
        targetPrivacy: targetClass,
        revisionId: DESTINATION_REVISION,
        mutationId: DESTINATION_MUTATION,
        currentNote: null,
        currentMutation: null
      })
    ]),
    reservations: Object.freeze([
      reservation("note_content:0", "note_content", NOTE_B, 1, 50, targetClass),
      reservation("note_revision:0", "note_revision", DESTINATION_REVISION, 1, 51, targetClass),
      reservation("note_mutation:0", "note_mutation", DESTINATION_MUTATION, 1, 52, targetClass),
      reservation("review", "review_item", REVIEW, 2, 53, targetClass),
      reservation("receipt", "capture_receipt", CAPTURE, 2, 54, sourceClass),
      reservation(
        "response",
        "idempotency_response",
        `idempotency:${IDEMPOTENCY}`,
        1,
        55,
        targetClass
      )
    ]),
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

function privateReviewRoutePreparation(): PrepareReviewResolutionResult {
  const sourceClass = "private_manual" as const;
  const destinationClass = "ai_assisted" as const;
  return Object.freeze({
    scope: "encrypted_review_resolution" as const,
    action: "route" as const,
    occurredAt: NOW,
    completed: false,
    replayed: false,
    requestMacKey: key("content_mac", sourceClass),
    ids: Object.freeze({
      reviewItemId: REVIEW,
      destinationNoteId: NOTE_A,
      destinationRevisionId: DESTINATION_REVISION,
      destinationMutationId: DESTINATION_MUTATION
    }),
    source: Object.freeze({
      decision: null,
      review: Object.freeze({
        reviewItemId: REVIEW,
        captureId: CAPTURE,
        noteId: null,
        type: "low_confidence" as const,
        state: "open" as const,
        recordVersion: 1,
        createdAt: NOW,
        resolvedAt: null,
        contentCipher: stored("review_item", REVIEW, 1, sourceClass)
      }),
      receipt: Object.freeze({
        captureId: CAPTURE,
        jobId: JOB,
        decisionId: DECISION,
        reviewItemId: REVIEW,
        mutationId: null,
        outcome: "needs_review" as const,
        destinationNoteId: null,
        reasonCodes: Object.freeze(["low_confidence"]),
        recordVersion: 1,
        sourcePrivacy: sourceClass,
        receiptCipher: stored("capture_receipt", CAPTURE, 1, sourceClass)
      }),
      capture: Object.freeze({
        captureId: CAPTURE,
        recordVersion: 1 as const,
        privacy: sourceClass,
        status: "needs_review" as const,
        contentLength: 7,
        contentCipher: stored("capture", CAPTURE, 1, sourceClass),
        contentMac: mac(sourceClass)
      })
    }),
    members: Object.freeze([
      Object.freeze({
        ordinal: 0,
        role: "destination_write" as const,
        noteId: NOTE_A,
        targetMutationId: null,
        expectedRevision: 1,
        sourcePrivacy: destinationClass,
        targetPrivacy: destinationClass,
        revisionId: DESTINATION_REVISION,
        mutationId: DESTINATION_MUTATION,
        currentNote: noteRead(snapshot("Existing log"), 1),
        currentMutation: null
      })
    ]),
    reservations: Object.freeze([
      reservation("note_content:0", "note_content", NOTE_A, 2, 60, destinationClass),
      reservation(
        "note_revision:0",
        "note_revision",
        DESTINATION_REVISION,
        2,
        61,
        destinationClass
      ),
      reservation(
        "note_mutation:0",
        "note_mutation",
        DESTINATION_MUTATION,
        2,
        62,
        destinationClass
      ),
      reservation("review", "review_item", REVIEW, 2, 63, sourceClass),
      reservation("receipt", "capture_receipt", CAPTURE, 2, 64, sourceClass),
      reservation(
        "response",
        "idempotency_response",
        `idempotency:${IDEMPOTENCY}`,
        1,
        65,
        sourceClass
      )
    ]),
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}
