import {
  DecisionCorrectionRequestSchema,
  DecisionCorrectionResponseSchema,
  GeneratedBlockResolveRequestSchema,
  GeneratedBlockResolveResponseSchema,
  MutationBatchUndoResponseSchema,
  MutationUndoRequestSchema,
  NoteRevisionSchema,
  NoteSchema,
  OrganizationPlanSchema,
  ReviewItemDtoSchema,
  ReviewResolveRequestSchema,
  ReviewResolveResponseSchema,
  createEntityId,
  entityIdSchema,
  reviewProposalMatchesType,
  reviewResolutionMatchesSemantics,
  type DecisionCorrectionRequest,
  type DecisionCorrectionResponse,
  type EntityId,
  type GeneratedBlockResolveRequest,
  type GeneratedBlockResolveResponse,
  type MutationBatchUndoMember,
  type MutationBatchUndoResponse,
  type NoteDto,
  type OrganizationPlan,
  type PrivacyMode,
  type ReviewItemDto,
  type ReviewResolveRequest,
  type ReviewResolveResponse
} from "@unfiled/contracts";
import {
  OrganizationApplicationError,
  applyOwnerAuthorizedMaterializedOrganizationCommand,
  type AppliedOrganizationCommand
} from "@unfiled/ai-routing/application";
import {
  OrganizationMaterializationError,
  materializeAuthorizedOrganizationPlan,
  type OrganizerCandidateManifest
} from "@unfiled/ai-routing/materialization";
import {
  DomainError,
  applyNoteOperations,
  noteSnapshot,
  undoNoteMutation,
  type EntityIdFactory,
  type Note,
  type NoteMutation,
  type NoteMutationResult,
  type NoteRevision
} from "@unfiled/domain";
import {
  CapturePayloadSchema,
  CaptureReceiptPayloadSchema,
  NoteContentPayloadSchema,
  NoteMutationPayloadSchema,
  NoteRevisionPayloadSchema,
  ReviewPayloadSchema,
  encryptedFieldForRpc,
  keyedMacForRpc,
  type AuthorizedOwnerAccess,
  type CaptureReceiptPayload,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type EncryptedIdempotencyRecord,
  type KeyedMacRecord,
  type LogicalApiRequest,
  type NoteContentPayload,
  type NoteMutationPayload,
  type NoteRevisionPayload,
  type ObjectWrapReservation,
  type PayloadCodec,
  type PrivacyTransition,
  type ReviewPayload,
  type ReviewPayloadV2
} from "@unfiled/encrypted-aggregate";
import type { KeyClass, ManagedKeyRecord } from "@unfiled/key-management";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { PreparedOwnerEncryptedAggregateService } from "@/server/encryption/encrypted-aggregate-runtime";
import type {
  EncryptedOwnerInteractionRpcAdapter,
  OwnerInteractionCommitResult,
  OwnerInteractionFullCommitCommand,
  OwnerInteractionPreparedMember,
  OwnerInteractionPreparedReservation,
  OwnerInteractionPreparedSource,
  OwnerInteractionWriteCommand,
  PrepareDecisionCorrectionResult,
  PrepareGeneratedBlockResolutionResult,
  PrepareMutationBatchUndoResult,
  PrepareReviewResolutionResult
} from "@/server/encryption/encrypted-owner-interaction-rpc-adapter";
import type { EncryptedGeneratedBlockReader } from "@/server/generated-blocks/encrypted-generated-block-reader";
import {
  generatedExpansionReceiptProjectionMatches,
  reviewReceiptProjectionMatches
} from "@/server/encryption/encrypted-receipt-projection";
import type {
  EncryptedNoteMutationRead,
  EncryptedNoteRead
} from "@/server/encryption/encrypted-note-read-rpc-adapter";
import {
  ServiceRpcError,
  ServiceRpcErrorCode,
  throwIfServiceOperationAborted
} from "@/server/encryption/service-rpc-client";

const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ENCRYPTED_ORGANIZER_REASON_SENTINEL = "encrypted_organizer";
const ROUTING_RULE_OBSERVATION_MAX_WAIT_MS = 5_000;

function interactionDiagnostic(stage: string): void {
  if (process.env.UNFILED_E1_HTTP_DIAGNOSTICS === "1") {
    process.stderr.write(`[unfiled-e1-owner-interaction] ${stage}\n`);
  }
}

const CorrectionLogicalPayloadSchema = z.strictObject({
  request: DecisionCorrectionRequestSchema,
  selectedOutcome: z.enum(["applied", "needs_review"])
});
type CorrectionLogicalPayload = z.infer<typeof CorrectionLogicalPayloadSchema>;

const ReviewLogicalPayloadSchema = z.strictObject({ request: ReviewResolveRequestSchema });
type ReviewLogicalPayload = z.infer<typeof ReviewLogicalPayloadSchema>;

const GeneratedBlockLogicalPayloadSchema = z.strictObject({
  request: GeneratedBlockResolveRequestSchema
});
type GeneratedBlockLogicalPayload = z.infer<typeof GeneratedBlockLogicalPayloadSchema>;

const BatchLogicalPayloadSchema = z.strictObject({
  request: MutationUndoRequestSchema,
  selectedOutcome: z.enum(["applied", "needs_review"])
});
type BatchLogicalPayload = z.infer<typeof BatchLogicalPayloadSchema>;

const BatchStoredResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("applied"),
    response: MutationBatchUndoResponseSchema
  }),
  z.strictObject({
    outcome: z.literal("needs_review"),
    reviewItemId: entityIdSchema("rvw")
  })
]);
type BatchStoredResponse = z.infer<typeof BatchStoredResponseSchema>;

type InteractionOutcome = "applied" | "needs_review";
type PreparedWrite = Readonly<{
  member: OwnerInteractionPreparedMember;
  note: Note;
  revision: NoteRevision;
  noteContent: NoteContentPayload;
  revisionPayload: NoteRevisionPayload;
  mutationPayload: NoteMutationPayload;
  revisionSource: "interactive" | "undo";
  actor: string;
  undoTargetMutationId: EntityId<"mut"> | null;
}>;

type OpenedMutationMember = Readonly<{
  currentNote: Note;
  mutation: NoteMutationPayload;
  row: EncryptedNoteMutationRead;
}>;

type ReviewEffect = Readonly<{
  id: EntityId<"rvw">;
  recordVersion: number;
  type: NonNullable<OwnerInteractionPreparedSource["review"]>["type"];
  payload: ReviewPayload;
}>;

type SealedCommandMaterial = Readonly<{
  command: OwnerInteractionFullCommitCommand;
  requestMac: Awaited<ReturnType<EncryptedAggregateService["createIdempotencyRequestMac"]>>;
}>;

export type EncryptedOwnerInteractionCoordinatorDependencies = Readonly<{
  ownerId: string;
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  createPreparedService(
    reservations: readonly ObjectWrapReservation[]
  ): PreparedOwnerEncryptedAggregateService;
  adapter: EncryptedOwnerInteractionRpcAdapter;
  observeRoutingRuleCorrection(
    input: Readonly<{
      feedbackEventId: EntityId<"fbk">;
      captureId: EntityId<"cap">;
      captureText: string | null;
      destination:
        | Readonly<{ type: "note"; noteId: EntityId<"note"> }>
        | Readonly<{ type: "space"; spaceId: EntityId<"spc"> }>;
    }>
  ): Promise<void>;
  routingRuleObservationDeadlineAt?: number;
  signal?: AbortSignal;
}>;

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function exactOwnerId(value: string): string {
  if (!OWNER_ID_PATTERN.test(value)) return invalidInput();
  return value.toLowerCase();
}

function parsed<Value>(codec: PayloadCodec<Value>, value: unknown): Value {
  try {
    return codec.parse(value);
  } catch {
    return invalidInput();
  }
}

function publicNote(note: Note): NoteDto {
  const { userId, ...candidate } = note;
  void userId;
  return NoteSchema.parse(candidate);
}

function publicRevision(
  revision: NoteRevision,
  source: "interactive" | "undo",
  actor: string
): z.infer<typeof NoteRevisionSchema> {
  return NoteRevisionSchema.parse({ ...revision, source, actor });
}

function noteFromRead(ownerId: string, row: EncryptedNoteRead, content: NoteContentPayload): Note {
  return Object.freeze({
    id: row.noteId,
    userId: ownerId,
    currentRevision: row.currentRevision,
    spaceId: row.spaceId,
    type: row.type,
    title: content.title,
    bodyMarkdown: content.bodyMarkdown,
    structuredData: content.structuredData,
    isOpen: row.isOpen,
    pinnedAt: row.pinnedAt,
    privacy: row.privacy,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    tagIds: row.tags.map(({ tagId }) => tagId),
    links: row.links.map(({ linkType, toNoteId }) => ({ linkType, toNoteId })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

function transitionForStoredRevision(
  record: EncryptedAggregateRecord<"note_revision">,
  privacy: PrivacyMode
): PrivacyTransition {
  if (record.keyClass === privacy) return Object.freeze({ before: privacy, after: privacy });
  if (record.keyClass === "private_manual" && privacy === "ai_assisted") {
    return Object.freeze({ before: "private_manual", after: "ai_assisted" });
  }
  return unavailable();
}

function idFactory(revisionId: EntityId<"rev">, mutationId: EntityId<"mut">): EntityIdFactory {
  return ((kind) => {
    if (kind === "rev") return revisionId;
    if (kind === "mut") return mutationId;
    return createEntityId(kind);
  }) as EntityIdFactory;
}

function noteContent(note: Note): NoteContentPayload {
  return NoteContentPayloadSchema.parse({
    schemaVersion: 1,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData
  });
}

function updateMutationPayload(result: NoteMutationResult): NoteMutationPayload {
  return NoteMutationPayloadSchema.parse({
    schemaVersion: 1,
    action: "update",
    beforeRevision: result.mutation.beforeRevision,
    afterRevision: result.mutation.afterRevision,
    operations: result.mutation.operations,
    inverse: result.mutation.inverse,
    beforeSnapshot: result.mutation.beforeSnapshot,
    afterSnapshot: result.mutation.afterSnapshot
  });
}

function preparedWriteFromUndo(
  member: OwnerInteractionPreparedMember,
  result: NoteMutationResult,
  targetMutationId: EntityId<"mut">
): PreparedWrite {
  return Object.freeze({
    member,
    note: result.note,
    revision: result.revision,
    noteContent: noteContent(result.note),
    revisionPayload: NoteRevisionPayloadSchema.parse({
      schemaVersion: 1,
      snapshot: result.mutation.afterSnapshot
    }),
    mutationPayload: updateMutationPayload(result),
    revisionSource: "undo",
    actor: "user:undo",
    undoTargetMutationId: targetMutationId
  });
}

function preparedWriteFromApplication(
  member: OwnerInteractionPreparedMember,
  applied: AppliedOrganizationCommand,
  actor: string
): PreparedWrite {
  if (
    applied.note.id !== member.noteId ||
    applied.note.currentRevision !== member.expectedRevision + 1 ||
    applied.revision.id !== member.revisionId ||
    applied.mutationId !== member.mutationId
  ) {
    return unavailable();
  }
  return Object.freeze({
    member,
    note: applied.note,
    revision: applied.revision,
    noteContent: NoteContentPayloadSchema.parse(applied.noteContentPayload),
    revisionPayload: NoteRevisionPayloadSchema.parse(applied.noteRevisionPayload),
    mutationPayload: NoteMutationPayloadSchema.parse(applied.noteMutationPayload),
    revisionSource: "interactive",
    actor,
    undoTargetMutationId: null
  });
}

function interactionKeyClass(
  members: readonly OwnerInteractionPreparedMember[],
  source: OwnerInteractionPreparedSource
): KeyClass {
  if (
    members.some(
      (member) =>
        member.sourcePrivacy === "private_manual" ||
        member.targetPrivacy === "private_manual" ||
        member.currentMutation?.mutationCipher.keyClass === "private_manual" ||
        member.currentMutation?.beforeSnapshot?.snapshotCipher.keyClass === "private_manual" ||
        member.currentMutation?.beforeSnapshot?.snapshotMac.keyClass === "private_manual" ||
        member.currentMutation?.afterSnapshot.snapshotCipher.keyClass === "private_manual" ||
        member.currentMutation?.afterSnapshot.snapshotMac.keyClass === "private_manual"
    ) ||
    source.capture?.privacy === "private_manual" ||
    source.receipt?.sourcePrivacy === "private_manual" ||
    source.review?.contentCipher.keyClass === "private_manual"
  ) {
    return "private_manual";
  }
  return "ai_assisted";
}

function requestMacReference(key: ManagedKeyRecord): Readonly<{
  ownerId: string;
  keyId: string;
  keyClass: KeyClass;
  purpose: "content_mac";
  keyVersion: number;
}> {
  if (key.purpose !== "content_mac") return unavailable();
  return Object.freeze({
    ownerId: key.ownerId,
    keyId: key.keyId,
    keyClass: key.keyClass,
    purpose: "content_mac",
    keyVersion: key.keyVersion
  });
}

function objectReservation(
  ownerId: string,
  reservation: OwnerInteractionPreparedReservation
): ObjectWrapReservation {
  if (
    reservation.key.ownerId !== ownerId ||
    reservation.key.purpose !== "object_wrap" ||
    reservation.key.keyClass !== reservation.keyClass
  ) {
    return unavailable();
  }
  return Object.freeze({
    reservationId: reservation.reservationId,
    reference: Object.freeze({
      ownerId,
      keyClass: reservation.keyClass,
      purpose: "object_wrap" as const,
      keyId: reservation.key.keyId,
      keyVersion: reservation.key.keyVersion
    })
  });
}

function reservationByRole(
  reservations: readonly OwnerInteractionPreparedReservation[],
  role: OwnerInteractionPreparedReservation["role"]
): OwnerInteractionPreparedReservation {
  const matches = reservations.filter((reservation) => reservation.role === role);
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) return unavailable();
  return match;
}

function reservationIfPresent(
  reservations: readonly OwnerInteractionPreparedReservation[],
  role: OwnerInteractionPreparedReservation["role"]
): OwnerInteractionPreparedReservation | null {
  const matches = reservations.filter((reservation) => reservation.role === role);
  if (matches.length > 1) return unavailable();
  return matches[0] ?? null;
}

function revisionDto(write: PreparedWrite): z.infer<typeof NoteRevisionSchema> {
  return publicRevision(write.revision, write.revisionSource, write.actor);
}

function batchMember(write: PreparedWrite): MutationBatchUndoMember {
  return Object.freeze({
    note: publicNote(write.note),
    revision: revisionDto(write),
    mutationId: write.member.mutationId,
    undo: Object.freeze({ eligible: false as const, expiresAt: null })
  });
}

function storedRequestRecord(
  ownerId: string,
  idempotencyKey: string,
  keyClass: KeyClass,
  requestMac: Awaited<ReturnType<EncryptedAggregateService["createIdempotencyRequestMac"]>>,
  response: EncryptedAggregateRecord<"idempotency_response">
): EncryptedIdempotencyRecord {
  return Object.freeze({ ownerId, idempotencyKey, keyClass, requestMac, response });
}

function logicalRequest<Payload>(
  scope: string,
  targetResourceId: string,
  expectedRevision: number | null,
  payload: Payload
): LogicalApiRequest<Payload> {
  return Object.freeze({
    schemaVersion: 1,
    scope,
    targetResourceId,
    expectedRevision,
    payload
  });
}

function sourceReceiptMatches(
  payload: CaptureReceiptPayload,
  source: OwnerInteractionPreparedSource
): boolean {
  const row = source.receipt;
  if (row === null) return false;
  const exactReasonsMatch =
    payload.reasonCodes.length === row.reasonCodes.length &&
    payload.reasonCodes.every((reason, index) => reason === row.reasonCodes[index]);
  const organizerReasonProjectionMatches =
    row.sourcePrivacy === "ai_assisted" &&
    row.recordVersion === 1 &&
    row.decisionId !== null &&
    row.reviewItemId === null &&
    row.mutationId !== null &&
    (row.outcome === "created_note" || row.outcome === "added_to_note") &&
    row.reasonCodes.length === 1 &&
    row.reasonCodes[0] === ENCRYPTED_ORGANIZER_REASON_SENTINEL;
  const projection = Object.freeze({
    recordVersion: row.recordVersion,
    privacy: row.sourcePrivacy,
    decisionId: row.decisionId,
    reviewItemId: row.reviewItemId,
    mutationId: row.mutationId,
    outcome: row.outcome,
    reasonCodes: row.reasonCodes
  });
  const reviewProjectionMatches = reviewReceiptProjectionMatches(payload, projection);
  const generatedExpansionProjectionMatches = generatedExpansionReceiptProjectionMatches(
    payload,
    projection,
    source.generatedBlock?.blockId
  );
  return (
    payload.captureId === row.captureId &&
    payload.jobId === row.jobId &&
    payload.decisionId === row.decisionId &&
    payload.reviewItemId === row.reviewItemId &&
    payload.mutationId === row.mutationId &&
    payload.outcome === row.outcome &&
    payload.destination?.noteId === (row.destinationNoteId ?? undefined) &&
    (exactReasonsMatch ||
      organizerReasonProjectionMatches ||
      reviewProjectionMatches ||
      generatedExpansionProjectionMatches)
  );
}

function noteState(write: PreparedWrite): OwnerInteractionWriteCommand["noteState"] {
  return Object.freeze({
    spaceId: write.note.spaceId,
    type: write.note.type,
    dailyDate: write.member.currentNote?.dailyDate ?? null,
    isOpen: write.note.isOpen,
    privacy: write.note.privacy,
    pinnedAt: write.note.pinnedAt,
    archivedAt: write.note.archivedAt,
    deletedAt: write.note.deletedAt,
    tagIds: write.note.tagIds,
    links: write.note.links
  });
}

function conflictReviewPayload(): ReviewPayloadV2 {
  return ReviewPayloadSchema.parse({
    schemaVersion: 2,
    proposal: { type: "conflict", reason: "revision" },
    state: "open",
    resolution: null
  }) as ReviewPayloadV2;
}

function fallbackReceipt(
  source: CaptureReceiptPayload,
  reviewItemId: EntityId<"rvw">,
  reasonCodes: readonly string[]
): CaptureReceiptPayload {
  return CaptureReceiptPayloadSchema.parse({
    schemaVersion: 2,
    captureId: source.captureId,
    jobId: source.jobId,
    decisionId: source.decisionId,
    reviewItemId,
    mutationId: null,
    outcome: "needs_review",
    headline: "Needs your review",
    destination: null,
    insertedContentReferences: [],
    actions: [],
    reasonCodes,
    createdAt: source.createdAt,
    undoTargets: []
  });
}

function batchConflictReceipt(
  source: CaptureReceiptPayload,
  reviewItemId: EntityId<"rvw">
): CaptureReceiptPayload {
  return CaptureReceiptPayloadSchema.parse({
    ...fallbackReceipt(source, reviewItemId, ["conflict_requires_review"]),
    // A failed batch inverse is an acknowledgement-only Review. Keeping the
    // historic decision bound here would advertise route/create actions even
    // though the database correctly refuses to rewrite that decision.
    decisionId: null
  });
}

function inboxReceipt(
  source: CaptureReceiptPayload,
  reasonCodes: readonly string[]
): CaptureReceiptPayload {
  return CaptureReceiptPayloadSchema.parse({
    schemaVersion: 2,
    captureId: source.captureId,
    jobId: source.jobId,
    decisionId: source.decisionId,
    reviewItemId: source.reviewItemId,
    mutationId: null,
    outcome: "kept_in_inbox",
    headline: "Kept in Inbox",
    destination: null,
    insertedContentReferences: [],
    actions: [],
    reasonCodes,
    createdAt: source.createdAt,
    undoTargets: []
  });
}

function routedReceipt(
  source: CaptureReceiptPayload,
  destination: PreparedWrite,
  allWrites: readonly PreparedWrite[],
  insertedItemIds: readonly (EntityId<"ent"> | EntityId<"itm">)[],
  reasonCodes: readonly string[]
): CaptureReceiptPayload {
  if (source.decisionId === null) return unavailable();
  const references =
    insertedItemIds.length === 0
      ? [Object.freeze({ type: "captured" as const, itemId: null })]
      : insertedItemIds.map((itemId) => Object.freeze({ type: "captured" as const, itemId }));
  const undoTargets = [...allWrites]
    .sort((left, right) => left.note.id.localeCompare(right.note.id))
    .map((write) =>
      Object.freeze({
        noteId: write.note.id,
        mutationId: write.member.mutationId,
        expectedRevision: write.note.currentRevision
      })
    );
  return CaptureReceiptPayloadSchema.parse({
    schemaVersion: 2,
    captureId: source.captureId,
    jobId: source.jobId,
    decisionId: source.decisionId,
    reviewItemId: null,
    mutationId: destination.member.mutationId,
    outcome: destination.member.expectedRevision === 0 ? "created_note" : "added_to_note",
    headline: destination.member.expectedRevision === 0 ? "Created a note" : "Added to a note",
    destination: { noteId: destination.note.id, title: destination.note.title },
    insertedContentReferences: references,
    actions: [
      { type: "open", noteId: destination.note.id },
      { type: "move", noteId: destination.note.id, decisionId: source.decisionId },
      {
        type: "undo",
        mutationId: destination.member.mutationId,
        expectedRevision: destination.note.currentRevision
      }
    ],
    reasonCodes,
    createdAt: source.createdAt,
    undoTargets
  });
}

function restoredRouteReceipt(
  source: CaptureReceiptPayload,
  destination: PreparedWrite
): CaptureReceiptPayload {
  if (source.decisionId === null || destination.member.expectedRevision < 1) {
    return unavailable();
  }
  return CaptureReceiptPayloadSchema.parse({
    schemaVersion: 2,
    captureId: source.captureId,
    jobId: source.jobId,
    decisionId: source.decisionId,
    reviewItemId: null,
    mutationId: destination.member.mutationId,
    outcome: "added_to_note",
    headline: "Restored the previous note",
    destination: { noteId: destination.note.id, title: destination.note.title },
    insertedContentReferences: [{ type: "captured", itemId: null }],
    actions: [
      { type: "open", noteId: destination.note.id },
      { type: "move", noteId: destination.note.id, decisionId: source.decisionId }
    ],
    reasonCodes: ["user_undo"],
    createdAt: source.createdAt,
    undoTargets: []
  });
}

function terminalGeneratedBlockReceipt(
  source: CaptureReceiptPayload,
  blockId: EntityId<"blk">,
  resolution: GeneratedBlockResolveRequest["resolution"]
): CaptureReceiptPayload {
  if (source.schemaVersion !== 2 || source.reviewItemId === null) return unavailable();
  const terminalReason = resolution === "accept" ? "expansion_accepted" : "expansion_rejected";
  if (
    source.reasonCodes.includes("expansion_accepted") ||
    source.reasonCodes.includes("expansion_rejected")
  ) {
    return unavailable();
  }
  const generated = source.insertedContentReferences.filter(
    (reference) => reference.type === "ai_generated"
  );
  if (generated.length !== 1 || generated[0]?.blockId !== blockId) return unavailable();
  const withoutGeneratedReference = source.insertedContentReferences.filter(
    (reference) => reference.type !== "ai_generated"
  );
  const insertedContentReferences =
    resolution === "accept" ? source.insertedContentReferences : withoutGeneratedReference;
  if (insertedContentReferences.length > 500) return unavailable();
  const reasonCodes = [...new Set(source.reasonCodes), terminalReason];
  if (reasonCodes.length > 20) return unavailable();
  return CaptureReceiptPayloadSchema.parse({
    ...source,
    reviewItemId: null,
    insertedContentReferences,
    reasonCodes
  });
}

function metadataReview(
  source: NonNullable<OwnerInteractionPreparedSource["review"]>,
  payload: ReviewPayloadV2,
  resolution: ReviewResolveRequest["resolution"],
  occurredAt: string,
  destinationNoteId: EntityId<"note"> | null
): ReviewItemDto {
  return ReviewItemDtoSchema.parse({
    id: source.reviewItemId,
    captureId: source.captureId,
    noteId: destinationNoteId ?? source.noteId,
    type: source.type,
    proposal: payload.proposal,
    state: resolution.type === "dismiss" ? "dismissed" : "resolved",
    resolution,
    createdAt: source.createdAt,
    resolvedAt: occurredAt
  });
}

function semanticFailure(error: unknown): boolean {
  return (
    error instanceof OrganizationApplicationError ||
    error instanceof OrganizationMaterializationError ||
    error instanceof DomainError ||
    error instanceof z.ZodError
  );
}

function batchStoredWithReplay(
  stored: BatchStoredResponse,
  replayed: boolean
): BatchStoredResponse {
  return stored.outcome === "applied"
    ? Object.freeze({
        ...stored,
        response: Object.freeze({ ...stored.response, replayed })
      })
    : stored;
}

function assertCorrectionResponseBinding(
  response: DecisionCorrectionResponse,
  outcome: InteractionOutcome,
  preparation: PrepareDecisionCorrectionResult,
  request: DecisionCorrectionRequest,
  result: OwnerInteractionCommitResult
): void {
  if (response.outcome !== outcome) interactionDiagnostic("correction.binding-response-outcome");
  if (response.decisionId !== preparation.ids.decisionId) {
    interactionDiagnostic("correction.binding-response-decision");
  }
  if (result.outcome !== outcome) interactionDiagnostic("correction.binding-result-outcome");
  if (result.decisionId !== preparation.ids.decisionId) {
    interactionDiagnostic("correction.binding-result-decision");
  }
  if (
    response.outcome !== outcome ||
    response.decisionId !== preparation.ids.decisionId ||
    result.outcome !== outcome ||
    result.decisionId !== preparation.ids.decisionId
  ) {
    return unavailable();
  }
  if (response.outcome === "needs_review") {
    if (
      response.reviewItemId !== preparation.branches.needsReview.reviewItemId ||
      result.reviewItemId !== response.reviewItemId ||
      result.feedbackEventId !== null ||
      result.members.length !== 0
    ) {
      return unavailable();
    }
    return;
  }
  const source = result.members.find(({ role }) => role === "source_removal");
  const destination = result.members.find(({ role }) => role === "destination_write");
  if (source === undefined) interactionDiagnostic("correction.binding-source-missing");
  if (destination === undefined) interactionDiagnostic("correction.binding-destination-missing");
  if (result.members.length !== 2) interactionDiagnostic("correction.binding-member-count");
  if (source?.noteId !== preparation.ids.sourceNoteId) {
    interactionDiagnostic("correction.binding-source-note");
  }
  if (destination?.noteId !== preparation.ids.destinationNoteId) {
    interactionDiagnostic("correction.binding-destination-note");
  }
  if (response.source.noteId !== source?.noteId) {
    interactionDiagnostic("correction.binding-response-source-note");
  }
  if (response.source.currentRevision !== source?.currentRevision) {
    interactionDiagnostic("correction.binding-response-source-revision");
  }
  if (response.source.mutationId !== source?.mutationId) {
    interactionDiagnostic("correction.binding-response-source-mutation");
  }
  if (response.destination.type !== request.destination.type) {
    interactionDiagnostic("correction.binding-response-destination-type");
  }
  if (response.destination.noteId !== destination?.noteId) {
    interactionDiagnostic("correction.binding-response-destination-note");
  }
  if (response.destination.currentRevision !== destination?.currentRevision) {
    interactionDiagnostic("correction.binding-response-destination-revision");
  }
  if (response.destination.mutationId !== destination?.mutationId) {
    interactionDiagnostic("correction.binding-response-destination-mutation");
  }
  if (
    source === undefined ||
    destination === undefined ||
    result.members.length !== 2 ||
    source.noteId !== preparation.ids.sourceNoteId ||
    destination.noteId !== preparation.ids.destinationNoteId ||
    response.source.noteId !== source.noteId ||
    response.source.currentRevision !== source.currentRevision ||
    response.source.mutationId !== source.mutationId ||
    response.destination.type !== request.destination.type ||
    response.destination.noteId !== destination.noteId ||
    response.destination.currentRevision !== destination.currentRevision ||
    response.destination.mutationId !== destination.mutationId ||
    result.feedbackEventId === null ||
    result.feedbackEventId !== preparation.branches.applied.feedbackEventId
  ) {
    return unavailable();
  }
}

function assertReviewResponseBinding(
  response: ReviewResolveResponse,
  preparation: PrepareReviewResolutionResult,
  request: ReviewResolveRequest,
  result: OwnerInteractionCommitResult,
  authenticatedPayload: ReviewPayloadV2 | null
): void {
  const source = preparation.source?.review ?? null;
  const expectedState = request.resolution.type === "dismiss" ? "dismissed" : "resolved";
  const writesNote = request.resolution.type === "route" || request.resolution.type === "create";
  const expectedNoteId = writesNote ? preparation.ids.destinationNoteId : source?.noteId;
  if (
    response.reviewItem.id !== preparation.ids.reviewItemId ||
    result.reviewItemId !== preparation.ids.reviewItemId ||
    result.outcome !== (request.resolution.type === "dismiss" ? "dismissed" : "resolved") ||
    response.reviewItem.state !== expectedState ||
    response.reviewItem.resolvedAt !== preparation.occurredAt ||
    !isDeepStrictEqual(response.reviewItem.resolution, request.resolution) ||
    (writesNote
      ? result.members.length !== 1 ||
        result.members[0]?.role !== "destination_write" ||
        result.members[0].noteId !== expectedNoteId ||
        response.reviewItem.noteId !== expectedNoteId
      : result.members.length !== 0) ||
    (source !== null &&
      (source.reviewItemId !== response.reviewItem.id ||
        response.reviewItem.type !== source.type ||
        response.reviewItem.captureId !== source.captureId ||
        response.reviewItem.noteId !== expectedNoteId ||
        response.reviewItem.createdAt !== source.createdAt)) ||
    (authenticatedPayload !== null &&
      !isDeepStrictEqual(response.reviewItem.proposal, authenticatedPayload.proposal))
  ) {
    return unavailable();
  }
}

function assertGeneratedBlockResponseBinding(
  response: GeneratedBlockResolveResponse,
  preparation: PrepareGeneratedBlockResolutionResult,
  request: GeneratedBlockResolveRequest,
  result: OwnerInteractionCommitResult
): void {
  const expectedState = request.resolution === "accept" ? "accepted" : "rejected";
  if (
    response.block.id !== preparation.ids.generatedBlockId ||
    response.block.state !== expectedState ||
    response.block.stateRevision !== request.expectedStateRevision + 1 ||
    response.block.resolvedAt !== preparation.occurredAt ||
    result.scope !== "encrypted_review_resolution" ||
    result.outcome !== expectedState ||
    result.reviewItemId !== preparation.ids.reviewItemId ||
    result.members.length !== 0 ||
    result.decisionId !== null ||
    result.batchId !== null ||
    result.feedbackEventId === null ||
    !("generatedBlockId" in result) ||
    result.generatedBlockId !== preparation.ids.generatedBlockId ||
    !("stateRevision" in result) ||
    result.stateRevision !== request.expectedStateRevision + 1
  ) {
    return unavailable();
  }
}

function assertBatchResponseBinding(
  stored: BatchStoredResponse,
  outcome: InteractionOutcome,
  preparation: PrepareMutationBatchUndoResult,
  result: OwnerInteractionCommitResult
): void {
  if (stored.outcome !== outcome || result.outcome !== outcome) return unavailable();
  if (stored.outcome === "needs_review") {
    if (
      stored.reviewItemId !== preparation.branches.needsReview.reviewItemId ||
      result.reviewItemId !== stored.reviewItemId ||
      result.members.length !== 0
    ) {
      return unavailable();
    }
    return;
  }
  if (
    result.batchId !== preparation.branches.applied.batchId ||
    stored.response.members.length !== result.members.length
  ) {
    return unavailable();
  }
  for (const [index, member] of stored.response.members.entries()) {
    const committed = result.members[index];
    if (
      committed?.role !== "undo" ||
      member.note.id !== committed.noteId ||
      member.note.currentRevision !== committed.currentRevision ||
      member.revision.id !== committed.revisionId ||
      member.revision.noteId !== committed.noteId ||
      member.revision.revision !== committed.currentRevision ||
      member.mutationId !== committed.mutationId
    ) {
      return unavailable();
    }
  }
}

/**
 * Owner-authorized E1 plaintext coordinator. The database owns preparation,
 * identities, CAS and atomic publication; this class only opens authenticated
 * envelopes, derives exact bounded effects and seals the prepared command.
 */
export class EncryptedOwnerInteractionCoordinator {
  private readonly ownerId: string;

  public constructor(
    private readonly dependencies: EncryptedOwnerInteractionCoordinatorDependencies
  ) {
    this.ownerId = exactOwnerId(dependencies.ownerId);
  }

  private active(): void {
    if (this.dependencies.signal !== undefined) {
      throwIfServiceOperationAborted(this.dependencies.signal);
    }
  }

  private async settleRoutingRuleObservation(observe: () => Promise<void>): Promise<boolean> {
    const deadlineAt = this.dependencies.routingRuleObservationDeadlineAt;
    const remainingMs =
      deadlineAt === undefined
        ? ROUTING_RULE_OBSERVATION_MAX_WAIT_MS
        : Math.floor(deadlineAt - Date.now());
    const waitMs = Math.min(ROUTING_RULE_OBSERVATION_MAX_WAIT_MS, remainingMs);
    if (!Number.isFinite(waitMs) || waitMs <= 0) return false;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), waitMs);
    });
    // Both branches are observed even when the timeout wins, so a late abort or
    // provider rejection cannot escape as an unhandled promise rejection.
    const observation = Promise.resolve()
      .then(observe)
      .then(
        () => true as const,
        () => false as const
      );
    try {
      return await Promise.race([observation, timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async observeRoutingRuleCorrection(
    preparation: PrepareDecisionCorrectionResult,
    request: DecisionCorrectionRequest,
    response: DecisionCorrectionResponse,
    result: OwnerInteractionCommitResult,
    captureText: string | null
  ): Promise<void> {
    const observe = this.dependencies.observeRoutingRuleCorrection;
    if (response.outcome !== "applied") return;
    // Keep the runtime guard even though production composition requires this
    // dependency. It makes an incomplete or dynamically substituted
    // composition fail closed after the correction's durable commit.
    if (typeof observe !== "function") return unavailable();
    const feedbackEventId = result.feedbackEventId;
    if (
      feedbackEventId === null ||
      feedbackEventId !== preparation.branches.applied.feedbackEventId
    ) {
      return unavailable();
    }
    const destination =
      request.destination.type === "new_note" && request.destination.spaceId !== null
        ? Object.freeze({
            type: "space" as const,
            spaceId: request.destination.spaceId
          })
        : Object.freeze({
            type: "note" as const,
            noteId: response.destination.noteId
          });
    // The correction and its feedback event are already durable at this
    // point. Do not acknowledge the API request until its idempotent,
    // feedback-bound observation is durable too. If this bounded follow-up
    // fails, returning provider_unavailable forces the client to retry the
    // exact correction idempotency key; that replay cannot duplicate the note
    // writes and resumes the same observation. Diagnostics deliberately
    // contain no owner content or provider error text.
    let completed: boolean;
    try {
      completed = await this.settleRoutingRuleObservation(() =>
        observe({
          feedbackEventId,
          captureId: preparation.ids.captureId,
          captureText,
          destination
        })
      );
    } catch {
      interactionDiagnostic("correction.rule-observation-deferred");
      return unavailable();
    }
    interactionDiagnostic(
      completed ? "correction.rule-observation-complete" : "correction.rule-observation-deferred"
    );
    if (!completed) return unavailable();
  }

  private async openCurrentNote(member: OwnerInteractionPreparedMember): Promise<Note> {
    this.active();
    const row = member.currentNote;
    if (
      row?.noteId !== member.noteId ||
      row.currentRevision !== member.expectedRevision ||
      row.privacy !== member.sourcePrivacy
    ) {
      return unavailable();
    }
    const content = await this.dependencies.aggregate.openNoteContent(
      this.dependencies.access,
      row.contentCipher,
      { noteId: row.noteId, currentRevision: row.currentRevision, privacy: row.privacy }
    );
    this.active();
    return noteFromRead(this.ownerId, row, content);
  }

  private async openMutationMember(
    member: OwnerInteractionPreparedMember,
    expectedDecisionId?: EntityId<"dec">
  ): Promise<OpenedMutationMember | null> {
    const row = member.currentMutation;
    if (
      row === null ||
      member.currentNote === null ||
      member.targetMutationId === null ||
      row.mutationId !== member.targetMutationId ||
      row.noteId !== member.noteId ||
      row.currentNote.noteId !== member.noteId ||
      row.currentNote.currentRevision !== member.expectedRevision ||
      row.afterRevision !== member.expectedRevision ||
      row.undoneAt !== null ||
      !isDeepStrictEqual(row.currentNote, member.currentNote) ||
      (expectedDecisionId !== undefined && row.decisionId !== expectedDecisionId)
    ) {
      return null;
    }
    const transition: PrivacyTransition = Object.freeze({
      before: row.beforeSnapshot?.privacy ?? null,
      after: row.afterSnapshot.privacy
    });
    const currentNotePromise = this.openCurrentNote(member);
    const mutationPromise = this.dependencies.aggregate.openNoteMutation(
      this.dependencies.access,
      row.mutationCipher,
      { mutationId: row.mutationId, afterRevision: row.afterRevision, transition }
    );
    const beforePromise =
      row.beforeSnapshot === null
        ? Promise.resolve(null)
        : this.dependencies.aggregate.openNoteRevision(
            this.dependencies.access,
            Object.freeze({
              encrypted: row.beforeSnapshot.snapshotCipher,
              contentMac: row.beforeSnapshot.snapshotMac
            }),
            {
              revisionId: row.beforeSnapshot.revisionId,
              revision: row.beforeSnapshot.revision,
              transition: transitionForStoredRevision(
                row.beforeSnapshot.snapshotCipher,
                row.beforeSnapshot.privacy
              )
            }
          );
    const afterPromise = this.dependencies.aggregate.openNoteRevision(
      this.dependencies.access,
      Object.freeze({
        encrypted: row.afterSnapshot.snapshotCipher,
        contentMac: row.afterSnapshot.snapshotMac
      }),
      {
        revisionId: row.afterSnapshot.revisionId,
        revision: row.afterSnapshot.revision,
        transition: transitionForStoredRevision(
          row.afterSnapshot.snapshotCipher,
          row.afterSnapshot.privacy
        )
      }
    );
    const [currentNote, mutation, before, after] = await Promise.all([
      currentNotePromise,
      mutationPromise,
      beforePromise,
      afterPromise
    ]);
    this.active();
    const currentSnapshot = noteSnapshot(currentNote);
    if (
      mutation.beforeRevision !== row.beforeRevision ||
      mutation.afterRevision !== row.afterRevision ||
      mutation.afterRevision !== member.expectedRevision ||
      !isDeepStrictEqual(mutation.afterSnapshot, after.snapshot) ||
      !isDeepStrictEqual(mutation.afterSnapshot, currentSnapshot) ||
      (mutation.beforeSnapshot === null) !== (before === null) ||
      (before !== null && !isDeepStrictEqual(mutation.beforeSnapshot, before.snapshot))
    ) {
      return null;
    }
    return Object.freeze({ currentNote, mutation, row });
  }

  private undoWrite(
    member: OwnerInteractionPreparedMember,
    opened: OpenedMutationMember,
    occurredAt: string,
    actor = "user:undo",
    revisionSource: PreparedWrite["revisionSource"] = "undo"
  ): PreparedWrite | null {
    try {
      const factory = idFactory(member.revisionId, member.mutationId);
      const result =
        opened.mutation.action === "create"
          ? applyNoteOperations(opened.currentNote, {
              expectedRevision: member.expectedRevision,
              operations: [{ type: "set_deleted", deletedAt: occurredAt }],
              now: occurredAt,
              source: "undo",
              actor: "user:undo",
              idFactory: factory
            })
          : undoNoteMutation(
              opened.currentNote,
              Object.freeze({
                id: opened.row.mutationId,
                noteId: opened.row.noteId,
                beforeRevision: opened.mutation.beforeRevision,
                afterRevision: opened.mutation.afterRevision,
                operations: opened.mutation.operations,
                inverse: opened.mutation.inverse,
                beforeSnapshot: opened.mutation.beforeSnapshot,
                afterSnapshot: opened.mutation.afterSnapshot,
                createdAt: opened.row.createdAt,
                undoneAt: opened.row.undoneAt
              } satisfies NoteMutation),
              { expectedRevision: member.expectedRevision, now: occurredAt, idFactory: factory }
            );
      if (result.revision.id !== member.revisionId || result.mutation.id !== member.mutationId) {
        return null;
      }
      const write = preparedWriteFromUndo(member, result, opened.row.mutationId);
      return Object.freeze({ ...write, actor, revisionSource });
    } catch (error: unknown) {
      if (semanticFailure(error)) return null;
      throw error;
    }
  }

  private async openCapture(source: OwnerInteractionPreparedSource): Promise<string | null> {
    const capture = source.capture;
    if (capture === null) return null;
    const payload = await this.dependencies.aggregate.openCapture(
      this.dependencies.access,
      Object.freeze({ encrypted: capture.contentCipher, contentMac: capture.contentMac }),
      {
        captureId: capture.captureId,
        recordVersion: capture.recordVersion,
        privacy: capture.privacy
      }
    );
    this.active();
    const parsedCapture = CapturePayloadSchema.parse(payload);
    return parsedCapture.rawContent.length === capture.contentLength
      ? parsedCapture.rawContent
      : unavailable();
  }

  private async openReceipt(
    source: OwnerInteractionPreparedSource
  ): Promise<CaptureReceiptPayload | null> {
    const receipt = source.receipt;
    if (receipt === null) return null;
    interactionDiagnostic("receipt.open-started");
    const payload = await this.dependencies.aggregate.openCaptureReceipt(
      this.dependencies.access,
      receipt.receiptCipher,
      {
        captureId: receipt.captureId,
        recordVersion: receipt.recordVersion,
        sourcePrivacy: receipt.sourcePrivacy
      }
    );
    interactionDiagnostic("receipt.cipher-opened");
    this.active();
    const parsedReceipt = CaptureReceiptPayloadSchema.parse(payload);
    interactionDiagnostic("receipt.payload-parsed");
    const matches = sourceReceiptMatches(parsedReceipt, source);
    if (!matches) {
      if (parsedReceipt.captureId !== receipt.captureId) {
        interactionDiagnostic("receipt.mismatch-capture");
      }
      if (parsedReceipt.jobId !== receipt.jobId) interactionDiagnostic("receipt.mismatch-job");
      if (parsedReceipt.decisionId !== receipt.decisionId) {
        interactionDiagnostic("receipt.mismatch-decision");
      }
      if (parsedReceipt.reviewItemId !== receipt.reviewItemId) {
        interactionDiagnostic("receipt.mismatch-review");
      }
      if (parsedReceipt.mutationId !== receipt.mutationId) {
        interactionDiagnostic("receipt.mismatch-mutation");
      }
      if (parsedReceipt.outcome !== receipt.outcome) {
        interactionDiagnostic("receipt.mismatch-outcome");
      }
      if (parsedReceipt.destination?.noteId !== (receipt.destinationNoteId ?? undefined)) {
        interactionDiagnostic("receipt.mismatch-destination");
      }
      if (
        parsedReceipt.reasonCodes.length !== receipt.reasonCodes.length ||
        !parsedReceipt.reasonCodes.every((reason, index) => reason === receipt.reasonCodes[index])
      ) {
        interactionDiagnostic("receipt.mismatch-reasons");
      }
    }
    interactionDiagnostic(matches ? "receipt.source-matched" : "receipt.source-mismatch");
    return matches ? parsedReceipt : unavailable();
  }

  private manifest(
    plan: OrganizationPlan,
    destination: OwnerInteractionPreparedMember,
    decision: Awaited<ReturnType<EncryptedAggregateService["openOrganizationDecision"]>> | null,
    destinationNote: Note | null,
    spaceId: EntityId<"spc"> | null
  ): OrganizerCandidateManifest {
    const candidates = new Map<
      string,
      Readonly<{
        candidateId: EntityId<"note">;
        isOpen: boolean;
        noteId: EntityId<"note">;
        revision: number;
        noteType: Note["type"];
      }>
    >();
    for (const candidate of decision?.candidateManifest.candidates ?? []) {
      candidates.set(
        candidate.noteId,
        Object.freeze({
          candidateId: candidate.noteId,
          isOpen: candidate.isOpen,
          noteId: candidate.noteId,
          revision: candidate.revision,
          noteType: candidate.noteType
        })
      );
    }
    if (destinationNote !== null) {
      candidates.set(
        destination.noteId,
        Object.freeze({
          candidateId: destination.noteId,
          isOpen: destinationNote.isOpen,
          noteId: destination.noteId,
          revision: destinationNote.currentRevision,
          noteType: destinationNote.type
        })
      );
    }
    const tagIds = plan.operations.flatMap((operation) =>
      operation.type === "add_tags" ? operation.tagIds : []
    );
    return {
      schemaVersion: 1,
      candidates: [...candidates.values()].map((candidate) => ({ ...candidate })),
      controls: {
        expansionDisabled: true,
        explicitDestinationNoteId: destination.expectedRevision === 0 ? null : destination.noteId,
        ruleMatch: null
      },
      authorizedSpaceIds: spaceId === null ? [] : [spaceId],
      authorizedTagIds: [...new Set(tagIds)]
    };
  }

  private applicationPlan(
    base: OrganizationPlan | null,
    destination: OwnerInteractionPreparedMember,
    title: string | null,
    noteType: Note["type"],
    spaceId: EntityId<"spc"> | null,
    rawContent: string
  ): OrganizationPlan {
    if (base?.generatedExpansion !== null && base !== null) {
      throw new OrganizationMaterializationError(
        "incompatible_operation",
        "Generated expansions are not correction material"
      );
    }
    const seed: OrganizationPlan =
      base ??
      OrganizationPlanSchema.parse({
        schemaVersion: 1,
        captureKind: "freeform",
        decision: "add_to_inbox",
        destination: { candidateId: null, newNote: null },
        operations: [{ type: "append_raw", content: rawContent }],
        generatedExpansion: null,
        alternatives: [],
        reasonCodes: []
      });
    return OrganizationPlanSchema.parse({
      ...seed,
      decision: destination.expectedRevision === 0 ? "create_note" : "append_to_note",
      destination:
        destination.expectedRevision === 0
          ? {
              candidateId: null,
              newNote: {
                title: title ?? "Untitled",
                noteType,
                spaceCandidateId: spaceId
              }
            }
          : { candidateId: destination.noteId, newNote: null },
      generatedExpansion: null,
      alternatives: []
    });
  }

  private correctionPlanCanSeedMove(plan: OrganizationPlan): boolean {
    return (
      (plan.decision === "append_to_note" &&
        plan.destination.candidateId !== null &&
        plan.destination.newNote === null) ||
      (plan.decision === "create_note" &&
        plan.destination.candidateId === null &&
        plan.destination.newNote !== null)
    );
  }

  private async applyDestination(
    input: Readonly<{
      member: OwnerInteractionPreparedMember;
      basePlan: OrganizationPlan | null;
      decision: Awaited<ReturnType<EncryptedAggregateService["openOrganizationDecision"]>> | null;
      rawContent: string;
      title: string | null;
      noteType: Note["type"];
      spaceId: EntityId<"spc"> | null;
      occurredAt: string;
      decisionId: EntityId<"dec">;
      actor: string;
    }>
  ): Promise<Readonly<{
    write: PreparedWrite;
    insertedItemIds: readonly (EntityId<"ent"> | EntityId<"itm">)[];
  }> | null> {
    try {
      const currentNote =
        input.member.expectedRevision === 0 ? null : await this.openCurrentNote(input.member);
      if (
        currentNote !== null &&
        (currentNote.archivedAt !== null || currentNote.deletedAt !== null || !currentNote.isOpen)
      ) {
        return null;
      }
      const plan = this.applicationPlan(
        input.basePlan,
        input.member,
        input.title,
        input.noteType,
        input.spaceId,
        input.rawContent
      );
      const manifest = this.manifest(
        plan,
        input.member,
        input.decision,
        currentNote,
        input.spaceId
      );
      const command = materializeAuthorizedOrganizationPlan({
        captureText: input.rawContent,
        plan,
        manifest,
        stableIds: {
          decisionId: input.decisionId,
          createdNoteId: input.member.expectedRevision === 0 ? input.member.noteId : null,
          revisionId: input.member.revisionId,
          mutationId: input.member.mutationId,
          reviewItemId: null,
          generatedBlockId: null
        }
      });
      if (command.kind === "review") return null;
      const factory = idFactory(input.member.revisionId, input.member.mutationId);
      let applied: AppliedOrganizationCommand;
      if (command.kind === "create") {
        if (input.member.sourcePrivacy !== null) return null;
        applied = applyOwnerAuthorizedMaterializedOrganizationCommand({
          command,
          captureText: input.rawContent,
          idFactory: factory,
          occurredAt: input.occurredAt,
          ownerId: this.ownerId,
          sourcePrivacy: null,
          targetPrivacy: input.member.targetPrivacy
        });
      } else {
        if (currentNote === null) return null;
        applied = applyOwnerAuthorizedMaterializedOrganizationCommand({
          command,
          captureText: input.rawContent,
          currentNote,
          idFactory: factory,
          occurredAt: input.occurredAt,
          ownerId: this.ownerId,
          sourcePrivacy: input.member.sourcePrivacy ?? unavailable(),
          targetPrivacy: input.member.targetPrivacy
        });
      }
      return Object.freeze({
        write: preparedWriteFromApplication(input.member, applied, input.actor),
        insertedItemIds: applied.insertedItemIds
      });
    } catch (error: unknown) {
      if (semanticFailure(error)) return null;
      throw error;
    }
  }

  private async sealCommand<ResponsePayload>(
    input: Readonly<{
      idempotencyKey: string;
      logicalRequest: LogicalApiRequest<unknown>;
      requestCodec: PayloadCodec<unknown>;
      response: ResponsePayload;
      responseCodec: PayloadCodec<ResponsePayload>;
      requestMacKey: ManagedKeyRecord;
      reservations: readonly OwnerInteractionPreparedReservation[];
      selectedOutcome?: InteractionOutcome;
      source: OwnerInteractionPreparedSource;
      cryptoMembers: readonly OwnerInteractionPreparedMember[];
      writes: readonly PreparedWrite[];
      review: ReviewEffect | null;
      receipt: CaptureReceiptPayload | null;
    }>
  ): Promise<SealedCommandMaterial> {
    const keyClass = interactionKeyClass(input.cryptoMembers, input.source);
    const transition: PrivacyTransition = Object.freeze({ before: null, after: keyClass });
    const requestMac = await this.dependencies.aggregate.createIdempotencyRequestMac(
      this.dependencies.access,
      {
        idempotencyKey: input.idempotencyKey,
        transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec,
        keyReference: requestMacReference(input.requestMacKey)
      }
    );
    this.active();

    const reservationPlan: OwnerInteractionPreparedReservation[] = [];
    for (const write of input.writes) {
      reservationPlan.push(
        reservationByRole(input.reservations, `note_content:${write.member.ordinal}`),
        reservationByRole(input.reservations, `note_revision:${write.member.ordinal}`),
        reservationByRole(input.reservations, `note_mutation:${write.member.ordinal}`)
      );
    }
    if (input.review !== null)
      reservationPlan.push(reservationByRole(input.reservations, "review"));
    if (input.receipt !== null)
      reservationPlan.push(reservationByRole(input.reservations, "receipt"));
    reservationPlan.push(reservationByRole(input.reservations, "response"));
    if (reservationPlan.length !== input.reservations.length) return unavailable();

    const prepared = this.dependencies.createPreparedService(
      reservationPlan.map((reservation) => objectReservation(this.ownerId, reservation))
    );
    const commands: OwnerInteractionWriteCommand[] = [];
    for (const write of input.writes) {
      const member = write.member;
      const transitionForWrite: PrivacyTransition = Object.freeze({
        before: member.sourcePrivacy,
        after: write.note.privacy
      });
      const noteCipher = await prepared.service.sealNoteContent(this.dependencies.access, {
        noteId: member.noteId,
        currentRevision: write.note.currentRevision,
        privacy: write.note.privacy,
        payload: write.noteContent
      });
      const revision = await prepared.service.sealNoteRevision(this.dependencies.access, {
        revisionId: member.revisionId,
        revision: write.note.currentRevision,
        transition: transitionForWrite,
        payload: write.revisionPayload
      });
      const mutation = await prepared.service.sealNoteMutation(this.dependencies.access, {
        mutationId: member.mutationId,
        afterRevision: write.note.currentRevision,
        payload: write.mutationPayload
      });
      const [openedNote, openedRevision, openedMutation] = await Promise.all([
        prepared.service.openNoteContent(this.dependencies.access, noteCipher, {
          noteId: member.noteId,
          currentRevision: write.note.currentRevision,
          privacy: write.note.privacy
        }),
        prepared.service.openNoteRevision(this.dependencies.access, revision, {
          revisionId: member.revisionId,
          revision: write.note.currentRevision,
          transition: transitionForWrite
        }),
        prepared.service.openNoteMutation(this.dependencies.access, mutation, {
          mutationId: member.mutationId,
          afterRevision: write.note.currentRevision,
          transition: transitionForWrite
        })
      ]);
      if (
        !isDeepStrictEqual(openedNote, write.noteContent) ||
        !isDeepStrictEqual(openedRevision, write.revisionPayload) ||
        !isDeepStrictEqual(openedMutation, write.mutationPayload)
      ) {
        return unavailable();
      }
      const [noteVerification, mutationVerification] = await Promise.all([
        prepared.service.createAggregateVerificationMac(this.dependencies.access, {
          surface: "note_content",
          noteId: member.noteId,
          recordVersion: write.note.currentRevision,
          privacy: write.note.privacy,
          payload: write.noteContent
        }),
        prepared.service.createAggregateVerificationMac(this.dependencies.access, {
          surface: "note_mutation",
          mutationId: member.mutationId,
          recordVersion: write.note.currentRevision,
          payload: write.mutationPayload
        })
      ]);
      const [noteVerificationValid, mutationVerificationValid] = await Promise.all([
        prepared.service.verifyAggregateVerificationMac(
          this.dependencies.access,
          noteVerification,
          {
            surface: "note_content",
            noteId: member.noteId,
            recordVersion: write.note.currentRevision,
            privacy: write.note.privacy,
            payload: write.noteContent
          }
        ),
        prepared.service.verifyAggregateVerificationMac(
          this.dependencies.access,
          mutationVerification,
          {
            surface: "note_mutation",
            mutationId: member.mutationId,
            recordVersion: write.note.currentRevision,
            payload: write.mutationPayload
          }
        )
      ]);
      if (!noteVerificationValid || !mutationVerificationValid) return unavailable();
      commands.push(
        Object.freeze({
          ordinal: member.ordinal,
          noteId: member.noteId,
          targetMutationId: member.targetMutationId,
          expectedRevision: member.expectedRevision,
          noteState: noteState(write),
          noteCipher: encryptedFieldForRpc(noteCipher),
          revision: Object.freeze({
            id: member.revisionId,
            source: write.revisionSource,
            actor: write.actor,
            cipher: encryptedFieldForRpc(revision.encrypted),
            mac: keyedMacForRpc(revision.contentMac)
          }),
          mutation: Object.freeze({
            id: member.mutationId,
            undoTargetMutationId: write.undoTargetMutationId,
            cipher: encryptedFieldForRpc(mutation)
          }),
          verification: Object.freeze({
            noteContent: keyedMacForRpc(noteVerification),
            noteMutation: keyedMacForRpc(mutationVerification)
          })
        })
      );
    }

    let reviewCommand: OwnerInteractionFullCommitCommand["review"] = null;
    if (input.review !== null) {
      const reviewPrivacy = reservationByRole(input.reservations, "review").keyClass;
      const sealed = await prepared.service.sealReview(this.dependencies.access, {
        reviewId: input.review.id,
        recordVersion: input.review.recordVersion,
        sourcePrivacy: reviewPrivacy,
        payload: input.review.payload
      });
      const opened = await prepared.service.openReview(this.dependencies.access, sealed, {
        reviewId: input.review.id,
        recordVersion: input.review.recordVersion,
        sourcePrivacy: reviewPrivacy
      });
      if (!isDeepStrictEqual(opened, input.review.payload)) return unavailable();
      const verification = await prepared.service.createAggregateVerificationMac(
        this.dependencies.access,
        {
          surface: "review_item",
          reviewId: input.review.id,
          recordVersion: input.review.recordVersion,
          sourcePrivacy: reviewPrivacy,
          payload: input.review.payload
        }
      );
      if (
        !(await prepared.service.verifyAggregateVerificationMac(
          this.dependencies.access,
          verification,
          {
            surface: "review_item",
            reviewId: input.review.id,
            recordVersion: input.review.recordVersion,
            sourcePrivacy: reviewPrivacy,
            payload: input.review.payload
          }
        ))
      ) {
        return unavailable();
      }
      reviewCommand = Object.freeze({
        reviewItemId: input.review.id,
        recordVersion: input.review.recordVersion,
        type: input.review.type,
        cipher: encryptedFieldForRpc(sealed),
        verificationMac: keyedMacForRpc(verification)
      });
    }

    let receiptCommand: OwnerInteractionFullCommitCommand["receipt"] = null;
    if (input.receipt !== null) {
      const sourceReceipt = input.source.receipt;
      if (sourceReceipt === null) return unavailable();
      const recordVersion = sourceReceipt.recordVersion + 1;
      const sealed = await prepared.service.sealCaptureReceipt(this.dependencies.access, {
        captureId: sourceReceipt.captureId,
        recordVersion,
        sourcePrivacy: sourceReceipt.sourcePrivacy,
        payload: input.receipt
      });
      const opened = await prepared.service.openCaptureReceipt(this.dependencies.access, sealed, {
        captureId: sourceReceipt.captureId,
        recordVersion,
        sourcePrivacy: sourceReceipt.sourcePrivacy
      });
      if (!isDeepStrictEqual(opened, input.receipt)) return unavailable();
      const verification = await prepared.service.createAggregateVerificationMac(
        this.dependencies.access,
        {
          surface: "capture_receipt",
          captureId: sourceReceipt.captureId,
          recordVersion,
          sourcePrivacy: sourceReceipt.sourcePrivacy,
          payload: input.receipt
        }
      );
      if (
        !(await prepared.service.verifyAggregateVerificationMac(
          this.dependencies.access,
          verification,
          {
            surface: "capture_receipt",
            captureId: sourceReceipt.captureId,
            recordVersion,
            sourcePrivacy: sourceReceipt.sourcePrivacy,
            payload: input.receipt
          }
        ))
      ) {
        return unavailable();
      }
      receiptCommand = Object.freeze({
        recordVersion,
        cipher: encryptedFieldForRpc(sealed),
        verificationMac: keyedMacForRpc(verification)
      });
    }

    const responseCipher = await prepared.service.sealIdempotencyResponse(
      this.dependencies.access,
      {
        idempotencyKey: input.idempotencyKey,
        transition,
        response: input.response,
        responseCodec: input.responseCodec
      }
    );
    const openedResponse = await prepared.service.openIdempotencyResponse(
      this.dependencies.access,
      storedRequestRecord(this.ownerId, input.idempotencyKey, keyClass, requestMac, responseCipher),
      {
        idempotencyKey: input.idempotencyKey,
        transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec,
        responseCodec: input.responseCodec
      }
    );
    if (!isDeepStrictEqual(openedResponse, input.response)) return unavailable();
    const responseVerificationMac = await prepared.service.createAggregateVerificationMac(
      this.dependencies.access,
      {
        surface: "idempotency_response",
        idempotencyKey: input.idempotencyKey,
        transition,
        payload: input.response,
        payloadCodec: input.responseCodec
      }
    );
    if (
      !(await prepared.service.verifyAggregateVerificationMac(
        this.dependencies.access,
        responseVerificationMac,
        {
          surface: "idempotency_response",
          idempotencyKey: input.idempotencyKey,
          transition,
          payload: input.response,
          payloadCodec: input.responseCodec
        }
      ))
    ) {
      return unavailable();
    }
    prepared.assertConsumed();
    this.active();
    return Object.freeze({
      requestMac,
      command: Object.freeze({
        ...(input.selectedOutcome === undefined ? {} : { selectedOutcome: input.selectedOutcome }),
        requestMac: keyedMacForRpc(requestMac),
        responseCipher: encryptedFieldForRpc(responseCipher),
        responseVerificationMac: keyedMacForRpc(responseVerificationMac),
        writes: Object.freeze(commands),
        receipt: receiptCommand,
        review: reviewCommand
      })
    });
  }

  private async replay<ResponsePayload>(
    input: Readonly<{
      idempotencyKey: string;
      logicalRequest: LogicalApiRequest<unknown>;
      requestCodec: PayloadCodec<unknown>;
      responseCodec: PayloadCodec<ResponsePayload>;
      requestMacKey: ManagedKeyRecord;
      encryptedResponse: EncryptedAggregateRecord<"idempotency_response">;
      encryptedResponseVerificationMac: KeyedMacRecord;
      selectedOutcome?: InteractionOutcome;
      decorateResponse?: (response: ResponsePayload, replayed: boolean) => ResponsePayload;
      commit(requestMac: ReturnType<typeof keyedMacForRpc>): Promise<OwnerInteractionCommitResult>;
    }>
  ): Promise<Readonly<{ response: ResponsePayload; result: OwnerInteractionCommitResult }>> {
    const keyClass = input.requestMacKey.keyClass;
    const transition: PrivacyTransition = Object.freeze({ before: null, after: keyClass });
    interactionDiagnostic("replay.request-mac-started");
    const requestMac = await this.dependencies.aggregate.createIdempotencyRequestMac(
      this.dependencies.access,
      {
        idempotencyKey: input.idempotencyKey,
        transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec,
        keyReference: requestMacReference(input.requestMacKey)
      }
    );
    interactionDiagnostic("replay.request-mac-created");
    const result = await input.commit(keyedMacForRpc(requestMac));
    interactionDiagnostic("replay.commit-returned");
    if (
      !result.replayed ||
      !isDeepStrictEqual(result.encryptedResponse, input.encryptedResponse) ||
      !isDeepStrictEqual(result.responseVerificationMac, input.encryptedResponseVerificationMac)
    ) {
      interactionDiagnostic("replay.commit-binding-mismatch");
      return unavailable();
    }
    interactionDiagnostic("replay.commit-bound");
    const opened = await this.dependencies.aggregate.openIdempotencyResponse(
      this.dependencies.access,
      storedRequestRecord(
        this.ownerId,
        input.idempotencyKey,
        keyClass,
        requestMac,
        result.encryptedResponse
      ),
      {
        idempotencyKey: input.idempotencyKey,
        transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec,
        responseCodec: input.responseCodec
      }
    );
    interactionDiagnostic("replay.response-opened");
    if (
      !(await this.dependencies.aggregate.verifyAggregateVerificationMac(
        this.dependencies.access,
        result.responseVerificationMac,
        {
          surface: "idempotency_response",
          idempotencyKey: input.idempotencyKey,
          transition,
          payload: opened,
          payloadCodec: input.responseCodec
        }
      ))
    ) {
      interactionDiagnostic("replay.response-mac-invalid");
      return unavailable();
    }
    interactionDiagnostic("replay.response-mac-valid");
    this.active();
    const response =
      input.decorateResponse === undefined
        ? (Object.freeze({ ...(opened as object), replayed: result.replayed }) as ResponsePayload)
        : input.decorateResponse(opened, result.replayed);
    return Object.freeze({ response, result });
  }

  private async openCommittedResponse<ResponsePayload>(
    input: Readonly<{
      result: OwnerInteractionCommitResult;
      requestMac: Awaited<ReturnType<EncryptedAggregateService["createIdempotencyRequestMac"]>>;
      idempotencyKey: string;
      logicalRequest: LogicalApiRequest<unknown>;
      requestCodec: PayloadCodec<unknown>;
      responseCodec: PayloadCodec<ResponsePayload>;
      expectedResponse: ResponsePayload;
      decorateResponse?: (response: ResponsePayload, replayed: boolean) => ResponsePayload;
    }>
  ): Promise<ResponsePayload> {
    const keyClass = input.requestMac.keyClass;
    const transition: PrivacyTransition = Object.freeze({ before: null, after: keyClass });
    const opened = await this.dependencies.aggregate.openIdempotencyResponse(
      this.dependencies.access,
      storedRequestRecord(
        this.ownerId,
        input.idempotencyKey,
        keyClass,
        input.requestMac,
        input.result.encryptedResponse
      ),
      {
        idempotencyKey: input.idempotencyKey,
        transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec,
        responseCodec: input.responseCodec
      }
    );
    if (
      !(await this.dependencies.aggregate.verifyAggregateVerificationMac(
        this.dependencies.access,
        input.result.responseVerificationMac,
        {
          surface: "idempotency_response",
          idempotencyKey: input.idempotencyKey,
          transition,
          payload: opened,
          payloadCodec: input.responseCodec
        }
      )) ||
      !isDeepStrictEqual(opened, input.expectedResponse)
    ) {
      return unavailable();
    }
    return input.decorateResponse === undefined
      ? (Object.freeze({
          ...(opened as object),
          replayed: input.result.replayed
        }) as ResponsePayload)
      : input.decorateResponse(opened, input.result.replayed);
  }

  public async correctDecision(
    decisionId: EntityId<"dec">,
    requestValue: DecisionCorrectionRequest
  ): Promise<DecisionCorrectionResponse> {
    const request = parsed(DecisionCorrectionRequestSchema, requestValue);
    this.active();
    const preparation = await this.dependencies.adapter.prepareDecisionCorrection({
      ownerId: this.ownerId,
      decisionId,
      request
    });
    interactionDiagnostic("correction.prepared");
    this.active();
    if (preparation.completed) {
      const outcome = preparation.selectedOutcome ?? unavailable();
      const payload: CorrectionLogicalPayload = Object.freeze({
        request,
        selectedOutcome: outcome
      });
      const logical = logicalRequest(
        "correct_decision",
        decisionId,
        request.source.expectedRevision,
        payload
      );
      const replayed = await this.replay({
        idempotencyKey: request.idempotencyKey,
        logicalRequest: logical,
        requestCodec: CorrectionLogicalPayloadSchema,
        responseCodec: DecisionCorrectionResponseSchema,
        requestMacKey: preparation.requestMacKey,
        encryptedResponse: preparation.encryptedResponse,
        encryptedResponseVerificationMac: preparation.encryptedResponseVerificationMac,
        selectedOutcome: outcome,
        commit: (requestMac) =>
          this.dependencies.adapter.commitDecisionCorrection({
            ownerId: this.ownerId,
            decisionId,
            idempotencyKey: request.idempotencyKey,
            preparation,
            command: { selectedOutcome: outcome, requestMac }
          })
      });
      const parsedResponse = DecisionCorrectionResponseSchema.parse(replayed.response);
      assertCorrectionResponseBinding(
        parsedResponse,
        outcome,
        preparation,
        request,
        replayed.result
      );
      interactionDiagnostic("correction.replay-bound");
      await this.observeRoutingRuleCorrection(
        preparation,
        request,
        parsedResponse,
        replayed.result,
        null
      );
      return parsedResponse;
    }

    const sourceMember = preparation.members.find(({ role }) => role === "source_removal") ?? null;
    const destinationMember =
      preparation.members.find(({ role }) => role === "destination_write") ?? null;
    let sourceWrite: PreparedWrite | null = null;
    let destinationEffect: Awaited<
      ReturnType<EncryptedOwnerInteractionCoordinator["applyDestination"]>
    > = null;
    let correctionCaptureText: string | null = null;
    if (
      preparation.branches.applied.available &&
      sourceMember !== null &&
      destinationMember !== null &&
      preparation.source.decision !== null &&
      preparation.source.decision.decisionId === decisionId &&
      preparation.source.decision.captureId === preparation.ids.captureId
    ) {
      const captureText = await this.openCapture(preparation.source);
      correctionCaptureText = captureText;
      interactionDiagnostic(
        captureText === null ? "correction.capture-unavailable" : "correction.capture-opened"
      );
      if (captureText !== null) {
        const decisionPayload = await this.dependencies.aggregate.openOrganizationDecision(
          this.dependencies.access,
          preparation.source.decision.contentCipher,
          { decisionId }
        );
        interactionDiagnostic("correction.decision-opened");
        if (
          decisionPayload.validatedPlan !== null &&
          this.correctionPlanCanSeedMove(decisionPayload.validatedPlan)
        ) {
          const openedSource = await this.openMutationMember(sourceMember, decisionId);
          interactionDiagnostic(
            openedSource === null ? "correction.source-inexact" : "correction.source-opened"
          );
          sourceWrite =
            openedSource === null
              ? null
              : this.undoWrite(
                  sourceMember,
                  openedSource,
                  preparation.occurredAt,
                  "user:correction",
                  "interactive"
                );
          interactionDiagnostic(
            sourceWrite === null
              ? "correction.source-write-unavailable"
              : "correction.source-write-ready"
          );
          if (sourceWrite !== null) {
            const destination = request.destination;
            destinationEffect = await this.applyDestination({
              member: destinationMember,
              basePlan: decisionPayload.validatedPlan,
              decision: decisionPayload,
              rawContent: captureText,
              title: destination.type === "new_note" ? destination.title : null,
              noteType:
                destination.type === "new_note"
                  ? destination.noteType
                  : (destinationMember.currentNote?.type ?? "generic"),
              spaceId:
                destination.type === "new_note"
                  ? destination.spaceId
                  : (destinationMember.currentNote?.spaceId ?? null),
              occurredAt: preparation.occurredAt,
              decisionId,
              actor: "user:correction"
            });
            interactionDiagnostic(
              destinationEffect === null
                ? "correction.destination-unavailable"
                : "correction.destination-ready"
            );
          }
        }
      }
    }
    const outcome: InteractionOutcome =
      sourceWrite !== null && destinationEffect !== null ? "applied" : "needs_review";
    interactionDiagnostic(`correction.outcome-${outcome}`);
    const payload: CorrectionLogicalPayload = Object.freeze({ request, selectedOutcome: outcome });
    interactionDiagnostic("correction.logical-payload-ready");
    const logical = logicalRequest(
      "correct_decision",
      decisionId,
      request.source.expectedRevision,
      payload
    );
    interactionDiagnostic("correction.logical-request-ready");
    interactionDiagnostic("correction.receipt-open-started");
    const receipt = await this.openReceipt(preparation.source);
    interactionDiagnostic(
      receipt === null ? "correction.receipt-unavailable" : "correction.receipt-opened"
    );
    if (receipt === null) return unavailable();
    let writes: readonly PreparedWrite[];
    let response: DecisionCorrectionResponse;
    let review: ReviewEffect | null;
    let receiptPayload: CaptureReceiptPayload;
    let reservations: readonly OwnerInteractionPreparedReservation[];
    if (outcome === "applied" && sourceWrite !== null && destinationEffect !== null) {
      writes = Object.freeze(
        [sourceWrite, destinationEffect.write].sort(
          (left, right) => left.member.ordinal - right.member.ordinal
        )
      );
      review = null;
      receiptPayload = routedReceipt(
        receipt,
        destinationEffect.write,
        writes,
        destinationEffect.insertedItemIds,
        ["user_correction"]
      );
      reservations = Object.freeze([
        ...preparation.commonReservations,
        ...preparation.branches.applied.reservations
      ]);
      response = DecisionCorrectionResponseSchema.parse({
        outcome: "applied",
        decisionId,
        source: {
          noteId: sourceWrite.note.id,
          currentRevision: sourceWrite.note.currentRevision,
          mutationId: sourceWrite.member.mutationId
        },
        destination: {
          type: request.destination.type,
          noteId: destinationEffect.write.note.id,
          currentRevision: destinationEffect.write.note.currentRevision,
          mutationId: destinationEffect.write.member.mutationId
        },
        replayed: false
      });
    } else {
      const branch = preparation.branches.needsReview;
      const reviewItemId = branch.reviewItemId;
      if (!branch.available || reviewItemId === null) return unavailable();
      writes = Object.freeze([]);
      review = Object.freeze({
        id: reviewItemId,
        recordVersion: 1,
        type: "revision_conflict",
        payload: conflictReviewPayload()
      });
      receiptPayload = fallbackReceipt(receipt, reviewItemId, ["exact_inverse_unavailable"]);
      reservations = Object.freeze([...preparation.commonReservations, ...branch.reservations]);
      response = DecisionCorrectionResponseSchema.parse({
        outcome: "needs_review",
        decisionId,
        reviewItemId,
        reasonCode: "exact_inverse_unavailable",
        replayed: false
      });
    }
    const sealed = await this.sealCommand({
      idempotencyKey: request.idempotencyKey,
      logicalRequest: logical,
      requestCodec: CorrectionLogicalPayloadSchema,
      response,
      responseCodec: DecisionCorrectionResponseSchema,
      requestMacKey: preparation.requestMacKey,
      reservations,
      selectedOutcome: outcome,
      source: preparation.source,
      cryptoMembers: preparation.members,
      writes,
      review,
      receipt: receiptPayload
    });
    interactionDiagnostic("correction.command-sealed");
    const result = await this.dependencies.adapter.commitDecisionCorrection({
      ownerId: this.ownerId,
      decisionId,
      idempotencyKey: request.idempotencyKey,
      preparation,
      command: sealed.command
    });
    interactionDiagnostic("correction.command-committed");
    const opened = await this.openCommittedResponse({
      result,
      requestMac: sealed.requestMac,
      idempotencyKey: request.idempotencyKey,
      logicalRequest: logical,
      requestCodec: CorrectionLogicalPayloadSchema,
      responseCodec: DecisionCorrectionResponseSchema,
      expectedResponse: response
    });
    interactionDiagnostic("correction.response-opened");
    const parsedResponse = DecisionCorrectionResponseSchema.parse(opened);
    assertCorrectionResponseBinding(parsedResponse, outcome, preparation, request, result);
    await this.observeRoutingRuleCorrection(
      preparation,
      request,
      parsedResponse,
      result,
      correctionCaptureText
    );
    return parsedResponse;
  }

  public async resolveReviewItem(
    reviewItemId: EntityId<"rvw">,
    requestValue: ReviewResolveRequest
  ): Promise<ReviewResolveResponse> {
    const request = parsed(ReviewResolveRequestSchema, requestValue);
    const preparation = await this.dependencies.adapter.prepareReviewResolution({
      ownerId: this.ownerId,
      reviewItemId,
      request
    });
    const payload: ReviewLogicalPayload = Object.freeze({ request });
    const logical = logicalRequest("resolve_review", reviewItemId, null, payload);
    if (preparation.completed) {
      const replayed = await this.replay({
        idempotencyKey: request.idempotencyKey,
        logicalRequest: logical,
        requestCodec: ReviewLogicalPayloadSchema,
        responseCodec: ReviewResolveResponseSchema,
        requestMacKey: preparation.requestMacKey,
        encryptedResponse: preparation.encryptedResponse,
        encryptedResponseVerificationMac: preparation.encryptedResponseVerificationMac,
        commit: (requestMac) =>
          this.dependencies.adapter.commitReviewResolution({
            ownerId: this.ownerId,
            reviewItemId,
            idempotencyKey: request.idempotencyKey,
            preparation,
            command: { requestMac }
          })
      });
      const parsedResponse = ReviewResolveResponseSchema.parse(replayed.response);
      assertReviewResponseBinding(parsedResponse, preparation, request, replayed.result, null);
      return parsedResponse;
    }
    const sourceReview = preparation.source.review;
    if (sourceReview?.reviewItemId !== reviewItemId || sourceReview.state !== "open") {
      return unavailable();
    }
    const openedPayload = await this.dependencies.aggregate.openReview(
      this.dependencies.access,
      sourceReview.contentCipher,
      {
        reviewId: reviewItemId,
        recordVersion: sourceReview.recordVersion,
        sourcePrivacy: sourceReview.contentCipher.keyClass
      }
    );
    const reviewPayload = ReviewPayloadSchema.parse(openedPayload);
    if (
      reviewPayload.schemaVersion !== 2 ||
      reviewPayload.state !== sourceReview.state ||
      reviewPayload.resolution !== null ||
      reviewPayload.proposal.type === "generated_block" ||
      !reviewProposalMatchesType(sourceReview.type, reviewPayload.proposal) ||
      !reviewResolutionMatchesSemantics(
        sourceReview.type,
        reviewPayload.proposal,
        request.resolution
      )
    ) {
      return invalidInput();
    }
    const terminalPayload: ReviewPayloadV2 = ReviewPayloadSchema.parse({
      ...reviewPayload,
      state: request.resolution.type === "dismiss" ? "dismissed" : "resolved",
      resolution: request.resolution
    }) as ReviewPayloadV2;
    let destinationEffect: Awaited<
      ReturnType<EncryptedOwnerInteractionCoordinator["applyDestination"]>
    > = null;
    let writes: readonly PreparedWrite[] = Object.freeze([]);
    let receiptPayload: CaptureReceiptPayload | null = null;
    const resolvesCaptureLinkedDuplicate =
      sourceReview.type === "duplicate_suggestion" &&
      (request.resolution.type === "keep_both" || request.resolution.type === "dismiss") &&
      preparation.source.receipt !== null;
    const changesReceipt =
      request.resolution.type === "route" ||
      request.resolution.type === "create" ||
      request.resolution.type === "keep_inbox" ||
      resolvesCaptureLinkedDuplicate;
    const receipt = changesReceipt ? await this.openReceipt(preparation.source) : null;
    if (request.resolution.type === "route" || request.resolution.type === "create") {
      const member = preparation.members[0] ?? unavailable();
      const rawContent = await this.openCapture(preparation.source);
      if (rawContent === null) return unavailable();
      const decisionId = receipt?.decisionId ?? unavailable();
      const basePlan =
        reviewPayload.proposal.type === "route_capture" ? reviewPayload.proposal.plan : null;
      destinationEffect = await this.applyDestination({
        member,
        basePlan,
        decision: null,
        rawContent,
        title: request.resolution.type === "create" ? request.resolution.title : null,
        noteType:
          request.resolution.type === "create"
            ? request.resolution.noteType
            : (member.currentNote?.type ?? "generic"),
        spaceId:
          request.resolution.type === "create"
            ? request.resolution.spaceId
            : (member.currentNote?.spaceId ?? null),
        occurredAt: preparation.occurredAt,
        decisionId,
        actor: "user:review"
      });
      if (destinationEffect === null || receipt === null) return unavailable();
      writes = Object.freeze([destinationEffect.write]);
      receiptPayload = routedReceipt(
        receipt,
        destinationEffect.write,
        writes,
        destinationEffect.insertedItemIds,
        ["review_resolved"]
      );
    } else if (
      (request.resolution.type === "keep_inbox" || resolvesCaptureLinkedDuplicate) &&
      receipt !== null &&
      reservationIfPresent(preparation.reservations, "receipt") !== null
    ) {
      receiptPayload = inboxReceipt(receipt, ["review_resolved"]);
    }
    const destinationNoteId = destinationEffect?.write.note.id ?? null;
    const reviewItem = metadataReview(
      sourceReview,
      reviewPayload,
      request.resolution,
      preparation.occurredAt,
      destinationNoteId
    );
    const response = ReviewResolveResponseSchema.parse({ reviewItem, replayed: false });
    const review: ReviewEffect = Object.freeze({
      id: reviewItemId,
      recordVersion: sourceReview.recordVersion + 1,
      type: sourceReview.type,
      payload: terminalPayload
    });
    const sealed = await this.sealCommand({
      idempotencyKey: request.idempotencyKey,
      logicalRequest: logical,
      requestCodec: ReviewLogicalPayloadSchema,
      response,
      responseCodec: ReviewResolveResponseSchema,
      requestMacKey: preparation.requestMacKey,
      reservations: preparation.reservations,
      source: preparation.source,
      cryptoMembers: preparation.members,
      writes,
      review,
      receipt: receiptPayload
    });
    const result = await this.dependencies.adapter.commitReviewResolution({
      ownerId: this.ownerId,
      reviewItemId,
      idempotencyKey: request.idempotencyKey,
      preparation,
      command: sealed.command
    });
    const opened = await this.openCommittedResponse({
      result,
      requestMac: sealed.requestMac,
      idempotencyKey: request.idempotencyKey,
      logicalRequest: logical,
      requestCodec: ReviewLogicalPayloadSchema,
      responseCodec: ReviewResolveResponseSchema,
      expectedResponse: response
    });
    const parsedResponse = ReviewResolveResponseSchema.parse(opened);
    assertReviewResponseBinding(parsedResponse, preparation, request, result, terminalPayload);
    return parsedResponse;
  }

  public async resolveGeneratedBlock(
    blockId: EntityId<"blk">,
    requestValue: GeneratedBlockResolveRequest,
    reader: EncryptedGeneratedBlockReader
  ): Promise<GeneratedBlockResolveResponse> {
    const request = parsed(GeneratedBlockResolveRequestSchema, requestValue);
    const located = await reader.get(blockId);
    const reviewItemId = located.source.reviewItemId;
    if (reviewItemId === null) return invalidInput();
    const preparation = await this.dependencies.adapter.prepareGeneratedBlockResolution({
      ownerId: this.ownerId,
      blockId,
      reviewItemId,
      request
    });
    const payload: GeneratedBlockLogicalPayload = Object.freeze({ request });
    const logical = logicalRequest(
      "resolve_generated_block",
      blockId,
      request.expectedStateRevision,
      payload
    );
    if (preparation.completed) {
      const replayed = await this.replay({
        idempotencyKey: request.idempotencyKey,
        logicalRequest: logical,
        requestCodec: GeneratedBlockLogicalPayloadSchema,
        responseCodec: GeneratedBlockResolveResponseSchema,
        requestMacKey: preparation.requestMacKey,
        encryptedResponse: preparation.encryptedResponse,
        encryptedResponseVerificationMac: preparation.encryptedResponseVerificationMac,
        commit: (requestMac) =>
          this.dependencies.adapter.commitGeneratedBlockResolution({
            ownerId: this.ownerId,
            blockId,
            request,
            preparation,
            command: { requestMac }
          })
      });
      const response = GeneratedBlockResolveResponseSchema.parse(replayed.response);
      assertGeneratedBlockResponseBinding(response, preparation, request, replayed.result);
      return response;
    }

    const sourceBlock = preparation.source.generatedBlock;
    const sourceReview = preparation.source.review;
    if (
      sourceBlock === null ||
      sourceBlock === undefined ||
      sourceReview === null ||
      sourceBlock.blockId !== blockId ||
      sourceBlock.reviewItemId !== reviewItemId ||
      sourceBlock.noteId !== sourceReview.noteId
    ) {
      return unavailable();
    }
    const [blockPayload, openedReview, openedReceipt] = await Promise.all([
      this.dependencies.aggregate.openGeneratedBlock(
        this.dependencies.access,
        sourceBlock.contentCipher,
        { blockId }
      ),
      this.dependencies.aggregate.openReview(this.dependencies.access, sourceReview.contentCipher, {
        reviewId: reviewItemId,
        recordVersion: sourceReview.recordVersion,
        sourcePrivacy: sourceReview.contentCipher.keyClass
      }),
      this.openReceipt(preparation.source)
    ]);
    this.active();
    const reviewPayload = ReviewPayloadSchema.parse(openedReview);
    if (
      reviewPayload.schemaVersion !== 2 ||
      reviewPayload.state !== "open" ||
      reviewPayload.resolution !== null ||
      reviewPayload.proposal.type !== "generated_block" ||
      reviewPayload.proposal.blockId !== blockId ||
      openedReceipt?.reviewItemId !== reviewItemId
    ) {
      return invalidInput();
    }
    const internalResolution =
      request.resolution === "accept"
        ? ({ type: "accept_expansion" } as const)
        : ({ type: "reject_expansion" } as const);
    const terminalReviewPayload = ReviewPayloadSchema.parse({
      ...reviewPayload,
      state: "resolved",
      resolution: internalResolution
    }) as ReviewPayloadV2;
    const receiptPayload = terminalGeneratedBlockReceipt(
      openedReceipt,
      blockId,
      request.resolution
    );
    const response = GeneratedBlockResolveResponseSchema.parse({
      block: {
        id: blockId,
        noteId: sourceBlock.noteId,
        decisionId: sourceBlock.decisionId,
        kind: sourceBlock.kind,
        content: blockPayload.content,
        state: request.resolution === "accept" ? "accepted" : "rejected",
        stateRevision: request.expectedStateRevision + 1,
        modelId: sourceBlock.modelId,
        promptVersion: sourceBlock.promptVersion,
        createdAt: sourceBlock.createdAt,
        resolvedAt: preparation.occurredAt
      },
      replayed: false
    });
    const review: ReviewEffect = Object.freeze({
      id: reviewItemId,
      recordVersion: sourceReview.recordVersion + 1,
      type: "pending_expansion",
      payload: terminalReviewPayload
    });
    const sealed = await this.sealCommand({
      idempotencyKey: request.idempotencyKey,
      logicalRequest: logical,
      requestCodec: GeneratedBlockLogicalPayloadSchema,
      response,
      responseCodec: GeneratedBlockResolveResponseSchema,
      requestMacKey: preparation.requestMacKey,
      reservations: preparation.reservations,
      source: preparation.source,
      cryptoMembers: preparation.members,
      writes: Object.freeze([]),
      review,
      receipt: receiptPayload
    });
    const result = await this.dependencies.adapter.commitGeneratedBlockResolution({
      ownerId: this.ownerId,
      blockId,
      request,
      preparation,
      command: sealed.command
    });
    const opened = await this.openCommittedResponse({
      result,
      requestMac: sealed.requestMac,
      idempotencyKey: request.idempotencyKey,
      logicalRequest: logical,
      requestCodec: GeneratedBlockLogicalPayloadSchema,
      responseCodec: GeneratedBlockResolveResponseSchema,
      expectedResponse: response
    });
    const parsedResponse = GeneratedBlockResolveResponseSchema.parse(opened);
    assertGeneratedBlockResponseBinding(parsedResponse, preparation, request, result);
    return parsedResponse;
  }

  public async undoMutationBatch(
    mutationId: EntityId<"mut">,
    requestValue: z.infer<typeof MutationUndoRequestSchema>
  ): Promise<MutationBatchUndoResponse> {
    const request = parsed(MutationUndoRequestSchema, requestValue);
    const preparation = await this.dependencies.adapter.getMutationBatch({
      ownerId: this.ownerId,
      mutationId,
      request
    });
    if (preparation.completed) {
      const outcome = preparation.selectedOutcome ?? unavailable();
      const payload: BatchLogicalPayload = Object.freeze({ request, selectedOutcome: outcome });
      const logical = logicalRequest(
        "undo_mutation_batch",
        mutationId,
        request.expectedRevision,
        payload
      );
      const replayed = await this.replay({
        idempotencyKey: request.idempotencyKey,
        logicalRequest: logical,
        requestCodec: BatchLogicalPayloadSchema,
        responseCodec: BatchStoredResponseSchema,
        requestMacKey: preparation.requestMacKey,
        encryptedResponse: preparation.encryptedResponse,
        encryptedResponseVerificationMac: preparation.encryptedResponseVerificationMac,
        selectedOutcome: outcome,
        decorateResponse: batchStoredWithReplay,
        commit: (requestMac) =>
          this.dependencies.adapter.undoMutationBatch({
            ownerId: this.ownerId,
            mutationId,
            request,
            preparation,
            command: { selectedOutcome: outcome, requestMac }
          })
      });
      const stored = replayed.response;
      assertBatchResponseBinding(stored, outcome, preparation, replayed.result);
      if (outcome === "needs_review") {
        if (
          stored.outcome !== "needs_review" ||
          stored.reviewItemId !== preparation.branches.needsReview.reviewItemId
        ) {
          return unavailable();
        }
        throw new ServiceRpcError(ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW);
      }
      if (stored.outcome !== "applied") return unavailable();
      return MutationBatchUndoResponseSchema.parse(stored.response);
    }
    if (!preparation.members.some((member) => member.targetMutationId === mutationId)) {
      return unavailable();
    }
    const writes: PreparedWrite[] = [];
    let safe = preparation.branches.applied.available;
    if (safe) {
      for (const member of preparation.members) {
        const opened = await this.openMutationMember(member);
        const write =
          opened === null ? null : this.undoWrite(member, opened, preparation.occurredAt);
        if (write === null) {
          safe = false;
          break;
        }
        writes.push(write);
      }
    }
    const outcome: InteractionOutcome = safe ? "applied" : "needs_review";
    const payload: BatchLogicalPayload = Object.freeze({ request, selectedOutcome: outcome });
    const logical = logicalRequest(
      "undo_mutation_batch",
      mutationId,
      request.expectedRevision,
      payload
    );
    const sourceReceipt = await this.openReceipt(preparation.source);
    let storedResponse: BatchStoredResponse;
    let review: ReviewEffect | null;
    let receipt: CaptureReceiptPayload | null;
    let reservations: readonly OwnerInteractionPreparedReservation[];
    if (outcome === "applied") {
      const ordered = Object.freeze(
        [...writes].sort((left, right) => left.member.ordinal - right.member.ordinal)
      );
      storedResponse = BatchStoredResponseSchema.parse({
        outcome: "applied",
        response: {
          members: ordered.map(batchMember),
          replayed: false
        }
      });
      review = null;
      if (preparation.ids.sourceBatchKind === "correction") {
        const restoredSource = ordered.find(
          ({ member }) => member.targetMutationId === preparation.ids.restoredSourceTargetMutationId
        );
        receipt =
          sourceReceipt !== null &&
          restoredSource !== undefined &&
          reservationIfPresent(preparation.commonReservations, "receipt") !== null
            ? restoredRouteReceipt(sourceReceipt, restoredSource)
            : unavailable();
      } else {
        receipt =
          sourceReceipt !== null &&
          reservationIfPresent(preparation.commonReservations, "receipt") !== null
            ? inboxReceipt(sourceReceipt, ["user_undo"])
            : null;
      }
      reservations = Object.freeze([
        ...preparation.commonReservations,
        ...preparation.branches.applied.reservations
      ]);
    } else {
      const branch = preparation.branches.needsReview;
      const conflictId = branch.reviewItemId;
      if (!branch.available || conflictId === null) return unavailable();
      storedResponse = BatchStoredResponseSchema.parse({
        outcome: "needs_review",
        reviewItemId: conflictId
      });
      review = Object.freeze({
        id: conflictId,
        recordVersion: 1,
        type: "revision_conflict",
        payload: conflictReviewPayload()
      });
      receipt = sourceReceipt === null ? null : batchConflictReceipt(sourceReceipt, conflictId);
      reservations = Object.freeze([...preparation.commonReservations, ...branch.reservations]);
    }
    const sealed = await this.sealCommand({
      idempotencyKey: request.idempotencyKey,
      logicalRequest: logical,
      requestCodec: BatchLogicalPayloadSchema,
      response: storedResponse,
      responseCodec: BatchStoredResponseSchema,
      requestMacKey: preparation.requestMacKey,
      reservations,
      selectedOutcome: outcome,
      source: preparation.source,
      cryptoMembers: preparation.members,
      writes: outcome === "applied" ? writes : [],
      review,
      receipt
    });
    const result = await this.dependencies.adapter.undoMutationBatch({
      ownerId: this.ownerId,
      mutationId,
      request,
      preparation,
      command: sealed.command
    });
    const opened = await this.openCommittedResponse({
      result,
      requestMac: sealed.requestMac,
      idempotencyKey: request.idempotencyKey,
      logicalRequest: logical,
      requestCodec: BatchLogicalPayloadSchema,
      responseCodec: BatchStoredResponseSchema,
      expectedResponse: storedResponse,
      decorateResponse: batchStoredWithReplay
    });
    const stored = BatchStoredResponseSchema.parse(opened);
    assertBatchResponseBinding(stored, outcome, preparation, result);
    if (outcome === "needs_review") {
      if (
        stored.outcome !== "needs_review" ||
        stored.reviewItemId !== preparation.branches.needsReview.reviewItemId
      ) {
        return unavailable();
      }
      throw new ServiceRpcError(ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW);
    }
    if (stored.outcome !== "applied") return unavailable();
    return MutationBatchUndoResponseSchema.parse(stored.response);
  }
}
