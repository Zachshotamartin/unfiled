import {
  CaptureProcessingStateSchema,
  DecisionCorrectionRequestSchema,
  GeneratedBlockResolveRequestSchema,
  MutationUndoRequestSchema,
  NoteLinkValueSchema,
  NoteTypeSchema,
  PrivacyModeSchema,
  ReviewResolveRequestSchema,
  ReviewStateSchema,
  ReviewTypeSchema,
  parseEntityId,
  type DecisionCorrectionRequest,
  type EntityId,
  type GeneratedBlockResolveRequest,
  type MutationUndoRequest,
  type NoteLinkValue,
  type NoteType,
  type PrivacyMode,
  type ReviewResolveRequest,
  type ReviewState,
  type ReviewType
} from "@unfiled/contracts";
import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import type {
  AggregateContentKind,
  EncryptedAggregateRecord,
  EncryptedFieldRpcValue,
  KeyedMacRecord,
  KeyedMacRpcValue,
  ObjectWrapReservation
} from "@unfiled/encrypted-aggregate";
import {
  parseAnyManagedKeyRecord,
  type KeyClass,
  type ManagedKeyRecord
} from "@unfiled/key-management";
import { isDeepStrictEqual } from "node:util";

import { canonicalUtcTimestampFromMicros } from "./canonical-rpc-timestamp";
import { encryptedCaptureTimestampMicros } from "./encrypted-capture-rpc-adapter";
import type { EncryptedGeneratedBlockRead } from "./encrypted-capture-rpc-adapter";
import {
  createEncryptedNoteReadRpcAdapter,
  type EncryptedNoteMutationRead,
  type EncryptedNoteRead
} from "./encrypted-note-read-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]*$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_BATCH_MEMBERS = 16;

function projectionDiagnostic(stage: string): void {
  if (process.env.UNFILED_E1_HTTP_DIAGNOSTICS === "1") {
    process.stderr.write(`[unfiled-e1-owner-projection] ${stage}\n`);
  }
}

export const encryptedOwnerInteractionRpcFunctions = Object.freeze([
  "prepare_encrypted_decision_correction",
  "commit_encrypted_decision_correction",
  "prepare_encrypted_review_resolution",
  "commit_encrypted_review_resolution",
  "resolve_encrypted_generated_block",
  "get_encrypted_mutation_batch",
  "undo_encrypted_mutation_batch"
] as const);

export type EncryptedOwnerInteractionRpcFunction =
  (typeof encryptedOwnerInteractionRpcFunctions)[number];

export type StoredOwnerInteractionCipher<Kind extends AggregateContentKind> = Readonly<
  Pick<
    EncryptedAggregateRecord<Kind>,
    "envelope" | "keyId" | "keyClass" | "keyPurpose" | "keyVersion"
  >
>;

export type OwnerInteractionMemberRole = "source_removal" | "destination_write" | "undo";

export type OwnerInteractionPreparedMember = Readonly<{
  ordinal: number;
  role: OwnerInteractionMemberRole;
  noteId: EntityId<"note">;
  targetMutationId: EntityId<"mut"> | null;
  expectedRevision: number;
  sourcePrivacy: PrivacyMode | null;
  targetPrivacy: PrivacyMode;
  revisionId: EntityId<"rev">;
  mutationId: EntityId<"mut">;
  currentNote: EncryptedNoteRead | null;
  currentMutation: EncryptedNoteMutationRead | null;
}>;

export type OwnerInteractionReservationSurface =
  | "note_content"
  | "note_revision"
  | "note_mutation"
  | "review_item"
  | "capture_receipt"
  | "idempotency_response";

export type OwnerInteractionReservationRole =
  | `note_content:${number}`
  | `note_revision:${number}`
  | `note_mutation:${number}`
  | "review"
  | "receipt"
  | "response";

export type OwnerInteractionPreparedReservation = Readonly<{
  role: OwnerInteractionReservationRole;
  surface: OwnerInteractionReservationSurface;
  resourceId: string;
  recordVersion: number;
  keyClass: KeyClass;
  reservationId: string;
  key: ManagedKeyRecord;
}>;

export type OwnerInteractionSourceDecision = Readonly<{
  decisionId: EntityId<"dec">;
  captureId: EntityId<"cap">;
  recordVersion: 1;
  destinationNoteId: EntityId<"note"> | null;
  contentCipher: EncryptedAggregateRecord<"organization_decision">;
}>;

export type OwnerInteractionSourceReview = Readonly<{
  reviewItemId: EntityId<"rvw">;
  captureId: EntityId<"cap"> | null;
  noteId: EntityId<"note"> | null;
  type: ReviewType;
  state: ReviewState;
  recordVersion: number;
  createdAt: string;
  resolvedAt: string | null;
  contentCipher: EncryptedAggregateRecord<"review_item">;
}>;

export type OwnerInteractionSourceReceipt = Readonly<{
  captureId: EntityId<"cap">;
  jobId: EntityId<"job">;
  decisionId: EntityId<"dec"> | null;
  reviewItemId: EntityId<"rvw"> | null;
  mutationId: EntityId<"mut"> | null;
  outcome: "created_note" | "added_to_note" | "kept_in_inbox" | "needs_review" | "failed";
  destinationNoteId: EntityId<"note"> | null;
  reasonCodes: readonly string[];
  recordVersion: number;
  sourcePrivacy: PrivacyMode;
  receiptCipher: EncryptedAggregateRecord<"capture_receipt">;
}>;

export type OwnerInteractionSourceCapture = Readonly<{
  captureId: EntityId<"cap">;
  recordVersion: 1;
  privacy: PrivacyMode;
  status: "queued" | "processing" | "done" | "needs_review" | "failed" | "inbox";
  contentLength: number;
  contentCipher: EncryptedAggregateRecord<"capture">;
  contentMac: KeyedMacRecord;
}>;

export type OwnerInteractionPreparedSource = Readonly<{
  decision: OwnerInteractionSourceDecision | null;
  review: OwnerInteractionSourceReview | null;
  receipt: OwnerInteractionSourceReceipt | null;
  capture: OwnerInteractionSourceCapture | null;
  generatedBlock?: EncryptedGeneratedBlockRead | null;
}>;

export type OwnerInteractionCorrectionAppliedBranch = Readonly<{
  available: boolean;
  feedbackEventId: EntityId<"fbk"> | null;
  batchId: string | null;
  reservations: readonly OwnerInteractionPreparedReservation[];
}>;

export type OwnerInteractionNeedsReviewBranch = Readonly<{
  available: boolean;
  reviewItemId: EntityId<"rvw"> | null;
  reservations: readonly OwnerInteractionPreparedReservation[];
}>;

type OwnerInteractionPendingPreparation = Readonly<{
  occurredAt: string;
  completed: false;
  replayed: boolean;
  requestMacKey: ManagedKeyRecord;
  source: OwnerInteractionPreparedSource;
  members: readonly OwnerInteractionPreparedMember[];
  encryptedResponse: null;
  encryptedResponseVerificationMac: null;
}>;

type OwnerInteractionCompletedPreparation = Readonly<{
  occurredAt: string;
  completed: true;
  replayed: true;
  requestMacKey: ManagedKeyRecord;
  source: null;
  members: readonly OwnerInteractionPreparedMember[];
  encryptedResponse: EncryptedAggregateRecord<"idempotency_response">;
  encryptedResponseVerificationMac: KeyedMacRecord;
}>;

type OwnerInteractionPreparationBase =
  OwnerInteractionPendingPreparation | OwnerInteractionCompletedPreparation;

export type PrepareDecisionCorrectionResult = OwnerInteractionPreparationBase &
  Readonly<{
    scope: "encrypted_decision_correction";
    selectedOutcome: "applied" | "needs_review" | null;
    commonReservations: readonly OwnerInteractionPreparedReservation[];
    ids: Readonly<{
      decisionId: EntityId<"dec">;
      sourceNoteId: EntityId<"note">;
      destinationNoteId: EntityId<"note">;
      captureId: EntityId<"cap">;
    }>;
    branches: Readonly<{
      applied: OwnerInteractionCorrectionAppliedBranch;
      needsReview: OwnerInteractionNeedsReviewBranch;
    }>;
  }>;

export type OwnerInteractionReviewResolutionIds = Readonly<{
  reviewItemId: EntityId<"rvw">;
  destinationNoteId: EntityId<"note"> | null;
  destinationRevisionId: EntityId<"rev"> | null;
  destinationMutationId: EntityId<"mut"> | null;
}>;

export type PrepareReviewResolutionResult = OwnerInteractionPreparationBase &
  Readonly<{
    scope: "encrypted_review_resolution";
    action: ReviewResolveRequest["resolution"]["type"];
    ids: OwnerInteractionReviewResolutionIds;
    reservations: readonly OwnerInteractionPreparedReservation[];
  }>;

export type GeneratedBlockResolutionAction = "accept_expansion" | "reject_expansion";

export type PrepareGeneratedBlockResolutionResult = OwnerInteractionPreparationBase &
  Readonly<{
    scope: "encrypted_review_resolution";
    action: GeneratedBlockResolutionAction;
    ids: OwnerInteractionReviewResolutionIds &
      Readonly<{
        generatedBlockId: EntityId<"blk">;
        stateRevision: number;
      }>;
    reservations: readonly OwnerInteractionPreparedReservation[];
  }>;

export type OwnerInteractionBatchAppliedBranch = Readonly<{
  available: boolean;
  batchId: string | null;
  reservations: readonly OwnerInteractionPreparedReservation[];
}>;

export type PrepareMutationBatchUndoResult = OwnerInteractionPreparationBase &
  Readonly<{
    scope: "encrypted_mutation_batch_undo";
    selectedOutcome: "applied" | "needs_review" | null;
    commonReservations: readonly OwnerInteractionPreparedReservation[];
    ids: Readonly<{
      anchorMutationId: EntityId<"mut">;
      sourceBatchKind: "organization" | "correction";
      restoredSourceTargetMutationId: EntityId<"mut"> | null;
    }>;
    branches: Readonly<{
      applied: OwnerInteractionBatchAppliedBranch;
      needsReview: OwnerInteractionNeedsReviewBranch;
    }>;
  }>;

export type OwnerInteractionNoteState = Readonly<{
  spaceId: EntityId<"spc"> | null;
  type: NoteType;
  dailyDate: string | null;
  isOpen: boolean;
  privacy: PrivacyMode;
  pinnedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  tagIds: readonly EntityId<"tag">[];
  links: readonly NoteLinkValue[];
}>;

export type OwnerInteractionWriteCommand = Readonly<{
  ordinal: number;
  noteId: EntityId<"note">;
  targetMutationId: EntityId<"mut"> | null;
  expectedRevision: number;
  noteState: OwnerInteractionNoteState;
  noteCipher: EncryptedFieldRpcValue<"note_content">;
  revision: Readonly<{
    id: EntityId<"rev">;
    source: "interactive" | "undo";
    actor: string;
    cipher: EncryptedFieldRpcValue<"note_revision">;
    mac: KeyedMacRpcValue;
  }>;
  mutation: Readonly<{
    id: EntityId<"mut">;
    undoTargetMutationId: EntityId<"mut"> | null;
    cipher: EncryptedFieldRpcValue<"note_mutation">;
  }>;
  verification: Readonly<{
    noteContent: KeyedMacRpcValue;
    noteMutation: KeyedMacRpcValue;
  }>;
}>;

export type OwnerInteractionFullCommitCommand = Readonly<{
  selectedOutcome?: "applied" | "needs_review";
  requestMac: KeyedMacRpcValue;
  responseCipher: EncryptedFieldRpcValue<"idempotency_response">;
  responseVerificationMac: KeyedMacRpcValue;
  writes: readonly OwnerInteractionWriteCommand[];
  receipt: Readonly<{
    recordVersion: number;
    cipher: EncryptedFieldRpcValue<"capture_receipt">;
    verificationMac: KeyedMacRpcValue;
  }> | null;
  review: Readonly<{
    reviewItemId: EntityId<"rvw">;
    recordVersion: number;
    type: ReviewType;
    cipher: EncryptedFieldRpcValue<"review_item">;
    verificationMac: KeyedMacRpcValue;
  }> | null;
}>;

export type OwnerInteractionReplayCommand =
  | Readonly<{ selectedOutcome: "applied" | "needs_review"; requestMac: KeyedMacRpcValue }>
  | Readonly<{ requestMac: KeyedMacRpcValue; selectedOutcome?: never }>;

export type OwnerInteractionCommitCommand =
  OwnerInteractionFullCommitCommand | OwnerInteractionReplayCommand;

export type OwnerInteractionCommitResult = Readonly<{
  scope:
    | "encrypted_decision_correction"
    | "encrypted_review_resolution"
    | "encrypted_mutation_batch_undo";
  outcome: "applied" | "needs_review" | "resolved" | "dismissed" | "accepted" | "rejected";
  decisionId: EntityId<"dec"> | null;
  reviewItemId: EntityId<"rvw"> | null;
  feedbackEventId: EntityId<"fbk"> | null;
  batchId: string | null;
  members: readonly Readonly<{
    role: OwnerInteractionMemberRole;
    noteId: EntityId<"note">;
    currentRevision: number;
    revisionId: EntityId<"rev">;
    mutationId: EntityId<"mut">;
  }>[];
  encryptedResponse: EncryptedAggregateRecord<"idempotency_response">;
  responseVerificationMac: KeyedMacRecord;
  replayed: boolean;
}>;

export type GeneratedBlockResolutionCommitResult = OwnerInteractionCommitResult &
  Readonly<{
    scope: "encrypted_review_resolution";
    outcome: "accepted" | "rejected";
    generatedBlockId: EntityId<"blk">;
    stateRevision: number;
    reviewItemId: EntityId<"rvw">;
    feedbackEventId: EntityId<"fbk">;
  }>;

export type EncryptedOwnerInteractionRpcAdapter = Readonly<{
  prepareDecisionCorrection(
    input: Readonly<{
      ownerId: string;
      decisionId: EntityId<"dec">;
      request: DecisionCorrectionRequest;
    }>
  ): Promise<PrepareDecisionCorrectionResult>;
  commitDecisionCorrection(
    input: Readonly<{
      ownerId: string;
      decisionId: EntityId<"dec">;
      idempotencyKey: string;
      preparation: PrepareDecisionCorrectionResult;
      command: OwnerInteractionCommitCommand;
    }>
  ): Promise<OwnerInteractionCommitResult>;
  prepareReviewResolution(
    input: Readonly<{
      ownerId: string;
      reviewItemId: EntityId<"rvw">;
      request: ReviewResolveRequest;
    }>
  ): Promise<PrepareReviewResolutionResult>;
  commitReviewResolution(
    input: Readonly<{
      ownerId: string;
      reviewItemId: EntityId<"rvw">;
      idempotencyKey: string;
      preparation: PrepareReviewResolutionResult;
      command: OwnerInteractionCommitCommand;
    }>
  ): Promise<OwnerInteractionCommitResult>;
  prepareGeneratedBlockResolution(
    input: Readonly<{
      ownerId: string;
      blockId: EntityId<"blk">;
      reviewItemId: EntityId<"rvw">;
      request: GeneratedBlockResolveRequest;
    }>
  ): Promise<PrepareGeneratedBlockResolutionResult>;
  commitGeneratedBlockResolution(
    input: Readonly<{
      ownerId: string;
      blockId: EntityId<"blk">;
      request: GeneratedBlockResolveRequest;
      preparation: PrepareGeneratedBlockResolutionResult;
      command: OwnerInteractionCommitCommand;
    }>
  ): Promise<GeneratedBlockResolutionCommitResult>;
  getMutationBatch(
    input: Readonly<{
      ownerId: string;
      mutationId: EntityId<"mut">;
      request: MutationUndoRequest;
    }>
  ): Promise<PrepareMutationBatchUndoResult>;
  undoMutationBatch(
    input: Readonly<{
      ownerId: string;
      mutationId: EntityId<"mut">;
      request: MutationUndoRequest;
      preparation: PrepareMutationBatchUndoResult;
      command: OwnerInteractionCommitCommand;
    }>
  ): Promise<OwnerInteractionCommitResult>;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;
type Failure = () => never;

function inputFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function projectionFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], failure: Failure): UnknownRecord {
  if (!isRecord(value)) return failure();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return failure();
  }
  return value;
}

function canonicalOwnerId(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failure();
  return value.toLowerCase();
}

function canonicalUuid(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value) || value !== value.toLowerCase()) {
    return failure();
  }
  return value;
}

type OwnerInteractionEntityKind =
  "blk" | "cap" | "dec" | "fbk" | "job" | "mut" | "note" | "rev" | "rvw" | "spc" | "tag";

function entityId<Kind extends OwnerInteractionEntityKind>(
  value: unknown,
  kind: Kind,
  failure: Failure
): EntityId<Kind> {
  if (typeof value !== "string") return failure();
  try {
    parseEntityId(value, kind);
  } catch {
    return failure();
  }
  return value as EntityId<Kind>;
}

function nullableEntityId<Kind extends OwnerInteractionEntityKind>(
  value: unknown,
  kind: Kind,
  failure: Failure
): EntityId<Kind> | null {
  return value === null ? null : entityId(value, kind, failure);
}

function positiveInteger(value: unknown, failure: Failure): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_DATABASE_INTEGER
  ) {
    return failure();
  }
  return value;
}

function nonnegativeInteger(value: unknown, failure: Failure): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= MAX_DATABASE_INTEGER
  ) {
    return failure();
  }
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, failure: Failure): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    return failure();
  }
  return value;
}

function timestamp(value: unknown, failure: Failure): string {
  return canonicalUtcTimestampFromMicros(encryptedCaptureTimestampMicros(value, failure), failure);
}

function nullableTimestamp(value: unknown, failure: Failure): string | null {
  return value === null ? null : timestamp(value, failure);
}

function privacy(value: unknown, failure: Failure): PrivacyMode {
  const parsed = PrivacyModeSchema.safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function noteType(value: unknown, failure: Failure): NoteType {
  const parsed = NoteTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function keyClass(value: unknown, failure: Failure): KeyClass {
  return value === "ai_assisted" || value === "private_manual" ? value : failure();
}

function idempotencyKey(value: unknown, failure: Failure): string {
  const parsed = boundedString(value, 1, 80, failure);
  return IDEMPOTENCY_KEY_PATTERN.test(parsed) ? parsed : failure();
}

function resourceId(value: unknown, failure: Failure): string {
  const parsed = boundedString(value, 1, 128, failure);
  return RESOURCE_ID_PATTERN.test(parsed) ? parsed : failure();
}

function parseStoredCipher<Kind extends AggregateContentKind>(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
    keyClass?: KeyClass;
  }>,
  failure: Failure
): EncryptedAggregateRecord<Kind> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const parsedKeyId = boundedString(record.keyId, 1, 128, failure);
  if (!KEY_ID_PATTERN.test(parsedKeyId) || record.keyPurpose !== "object_wrap") return failure();
  const parsedClass = keyClass(record.keyClass, failure);
  if (expected.keyClass !== undefined && expected.keyClass !== parsedClass) return failure();
  const keyVersion = positiveInteger(record.keyVersion, failure);
  let envelope;
  try {
    envelope = parseContentEnvelope(serializeContentEnvelope(record.envelope));
  } catch {
    return failure();
  }
  if (
    envelope.keyId !== parsedKeyId ||
    envelope.context.tenantId !== expected.ownerId ||
    envelope.context.resourceId !== expected.resourceId ||
    envelope.context.recordVersion !== expected.recordVersion ||
    envelope.context.kind !== expected.kind
  ) {
    return failure();
  }
  return Object.freeze({
    ownerId: expected.ownerId,
    resourceId: expected.resourceId,
    recordVersion: expected.recordVersion,
    kind: expected.kind,
    envelope,
    keyId: parsedKeyId,
    keyClass: parsedClass,
    keyPurpose: "object_wrap" as const,
    keyVersion
  });
}

function parseSealedCipher<Kind extends AggregateContentKind>(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
    keyClass: KeyClass;
    reservationId?: string;
  }>,
  failure: Failure
): EncryptedFieldRpcValue<Kind> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion", "reservationId"],
    failure
  );
  const reservationId = boundedString(record.reservationId, 1, 128, failure);
  if (
    !UUID_PATTERN.test(reservationId) ||
    (expected.reservationId !== undefined && reservationId !== expected.reservationId)
  ) {
    return failure();
  }
  const stored = parseStoredCipher(
    {
      envelope: record.envelope,
      keyId: record.keyId,
      keyClass: record.keyClass,
      keyPurpose: record.keyPurpose,
      keyVersion: record.keyVersion
    },
    expected,
    failure
  );
  return Object.freeze({
    envelope: stored.envelope,
    keyId: stored.keyId,
    keyClass: stored.keyClass,
    keyPurpose: stored.keyPurpose,
    keyVersion: stored.keyVersion,
    reservationId
  });
}

function parseStoredMac(value: unknown, expectedClass: KeyClass, failure: Failure): KeyedMacRecord {
  const record = exactRecord(
    value,
    ["mac", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const parsedKeyId = boundedString(record.keyId, 1, 128, failure);
  if (
    typeof record.mac !== "string" ||
    !MAC_PATTERN.test(record.mac) ||
    !KEY_ID_PATTERN.test(parsedKeyId) ||
    record.keyClass !== expectedClass ||
    record.keyPurpose !== "content_mac"
  ) {
    return failure();
  }
  return Object.freeze({
    value: record.mac,
    keyId: parsedKeyId,
    keyClass: expectedClass,
    keyPurpose: "content_mac" as const,
    keyVersion: positiveInteger(record.keyVersion, failure)
  });
}

function parseCommandMac(
  value: unknown,
  expectedClass: KeyClass,
  failure: Failure
): KeyedMacRpcValue {
  const parsed = parseStoredMac(value, expectedClass, failure);
  return Object.freeze({
    mac: parsed.value,
    keyId: parsed.keyId,
    keyClass: parsed.keyClass,
    keyPurpose: parsed.keyPurpose,
    keyVersion: parsed.keyVersion
  });
}

function parsePreparedKey(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    keyClass?: KeyClass;
    purpose: "content_mac" | "object_wrap";
  }>,
  failure: Failure
): ManagedKeyRecord {
  let parsed: ManagedKeyRecord;
  try {
    parsed = parseAnyManagedKeyRecord(value);
  } catch {
    return failure();
  }
  if (
    parsed.ownerId !== expected.ownerId ||
    parsed.purpose !== expected.purpose ||
    parsed.status !== "active" ||
    (expected.keyClass !== undefined && parsed.keyClass !== expected.keyClass)
  ) {
    return failure();
  }
  return parsed;
}

function parseReplayRequestMacKey(
  value: unknown,
  ownerId: string,
  failure: Failure
): ManagedKeyRecord {
  let parsed: ManagedKeyRecord;
  try {
    parsed = parseAnyManagedKeyRecord(value);
  } catch {
    return failure();
  }
  if (
    parsed.ownerId !== ownerId ||
    parsed.purpose !== "content_mac" ||
    (parsed.status !== "active" && parsed.status !== "retired")
  ) {
    return failure();
  }
  return parsed;
}

async function parsePreparedNote(
  value: unknown,
  ownerId: string,
  noteId: EntityId<"note">,
  failure: Failure
): Promise<EncryptedNoteRead> {
  const adapter = createEncryptedNoteReadRpcAdapter(
    Object.freeze({
      rpc(functionName: string): Promise<unknown> {
        return functionName === "get_encrypted_note"
          ? Promise.resolve(value)
          : Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE));
      }
    })
  );
  try {
    return await adapter.getNote({ ownerId, noteId });
  } catch {
    return failure();
  }
}

async function parsePreparedMutation(
  value: unknown,
  ownerId: string,
  mutationId: EntityId<"mut">,
  failure: Failure
): Promise<EncryptedNoteMutationRead> {
  const adapter = createEncryptedNoteReadRpcAdapter(
    Object.freeze({
      rpc(functionName: string): Promise<unknown> {
        return functionName === "get_encrypted_note_mutation"
          ? Promise.resolve(value)
          : Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE));
      }
    })
  );
  try {
    return await adapter.getMutation({ ownerId, mutationId });
  } catch {
    return failure();
  }
}

function parseSourceDecision(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionSourceDecision | null {
  if (value === null) return null;
  const record = exactRecord(
    value,
    ["decisionId", "captureId", "recordVersion", "destinationNoteId", "contentCipher"],
    failure
  );
  const decisionId = entityId(record.decisionId, "dec", failure);
  const recordVersion = positiveInteger(record.recordVersion, failure);
  if (recordVersion !== 1) return failure();
  return Object.freeze({
    decisionId,
    captureId: entityId(record.captureId, "cap", failure),
    recordVersion: 1 as const,
    destinationNoteId: nullableEntityId(record.destinationNoteId, "note", failure),
    contentCipher: parseStoredCipher(
      record.contentCipher,
      {
        ownerId,
        resourceId: decisionId,
        recordVersion: 1,
        kind: "organization_decision",
        keyClass: "ai_assisted"
      },
      failure
    )
  });
}

function parseSourceReview(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionSourceReview | null {
  if (value === null) return null;
  const record = exactRecord(
    value,
    [
      "reviewItemId",
      "captureId",
      "noteId",
      "type",
      "state",
      "recordVersion",
      "contentCipher",
      "createdAt",
      "resolvedAt"
    ],
    failure
  );
  const reviewItemId = entityId(record.reviewItemId, "rvw", failure);
  const parsedType = ReviewTypeSchema.safeParse(record.type);
  const parsedState = ReviewStateSchema.safeParse(record.state);
  if (!parsedType.success || !parsedState.success) return failure();
  const recordVersion = positiveInteger(record.recordVersion, failure);
  const cipher = parseStoredCipher(
    record.contentCipher,
    { ownerId, resourceId: reviewItemId, recordVersion, kind: "review_item" },
    failure
  );
  const createdAt = timestamp(record.createdAt, failure);
  const resolvedAt = nullableTimestamp(record.resolvedAt, failure);
  if (
    (parsedState.data === "open" && resolvedAt !== null) ||
    (parsedState.data !== "open" && resolvedAt === null) ||
    (resolvedAt !== null &&
      encryptedCaptureTimestampMicros(resolvedAt, failure) <
        encryptedCaptureTimestampMicros(createdAt, failure))
  ) {
    return failure();
  }
  return Object.freeze({
    reviewItemId,
    captureId: nullableEntityId(record.captureId, "cap", failure),
    noteId: nullableEntityId(record.noteId, "note", failure),
    type: parsedType.data,
    state: parsedState.data,
    recordVersion,
    createdAt,
    resolvedAt,
    contentCipher: cipher
  });
}

function parseSourceReceipt(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionSourceReceipt | null {
  if (value === null) return null;
  const record = exactRecord(
    value,
    [
      "captureId",
      "jobId",
      "decisionId",
      "reviewItemId",
      "mutationId",
      "outcome",
      "destinationNoteId",
      "reasonCodes",
      "recordVersion",
      "sourcePrivacy",
      "receiptCipher"
    ],
    failure
  );
  const captureId = entityId(record.captureId, "cap", failure);
  const sourcePrivacy = privacy(record.sourcePrivacy, failure);
  const recordVersion = positiveInteger(record.recordVersion, failure);
  if (
    record.outcome !== "created_note" &&
    record.outcome !== "added_to_note" &&
    record.outcome !== "kept_in_inbox" &&
    record.outcome !== "needs_review" &&
    record.outcome !== "failed"
  ) {
    return failure();
  }
  if (!Array.isArray(record.reasonCodes) || record.reasonCodes.length > 20) return failure();
  const reasonCodes = Object.freeze(
    record.reasonCodes.map((reason) => {
      const parsed = boundedString(reason, 1, 64, failure);
      return REASON_CODE_PATTERN.test(parsed) ? parsed : failure();
    })
  );
  if (new Set(reasonCodes).size !== reasonCodes.length) return failure();
  return Object.freeze({
    captureId,
    jobId: entityId(record.jobId, "job", failure),
    decisionId: nullableEntityId(record.decisionId, "dec", failure),
    reviewItemId: nullableEntityId(record.reviewItemId, "rvw", failure),
    mutationId: nullableEntityId(record.mutationId, "mut", failure),
    outcome: record.outcome,
    destinationNoteId: nullableEntityId(record.destinationNoteId, "note", failure),
    reasonCodes,
    recordVersion,
    sourcePrivacy,
    receiptCipher: parseStoredCipher(
      record.receiptCipher,
      {
        ownerId,
        resourceId: captureId,
        recordVersion,
        kind: "capture_receipt",
        keyClass: sourcePrivacy
      },
      failure
    )
  });
}

function parseSourceCapture(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionSourceCapture | null {
  if (value === null) return null;
  const record = exactRecord(
    value,
    [
      "captureId",
      "recordVersion",
      "privacy",
      "status",
      "contentLength",
      "contentCipher",
      "contentMac"
    ],
    failure
  );
  const captureId = entityId(record.captureId, "cap", failure);
  const recordVersion = positiveInteger(record.recordVersion, failure);
  const parsedPrivacy = privacy(record.privacy, failure);
  const parsedStatus = CaptureProcessingStateSchema.safeParse(record.status);
  if (!parsedStatus.success || recordVersion !== 1) return failure();
  const contentLength = positiveInteger(record.contentLength, failure);
  if (contentLength > 10_000) return failure();
  return Object.freeze({
    captureId,
    recordVersion: 1 as const,
    privacy: parsedPrivacy,
    status: parsedStatus.data,
    contentLength,
    contentCipher: parseStoredCipher(
      record.contentCipher,
      {
        ownerId,
        resourceId: captureId,
        recordVersion: 1,
        kind: "capture",
        keyClass: parsedPrivacy
      },
      failure
    ),
    contentMac: parseStoredMac(record.contentMac, parsedPrivacy, failure)
  });
}

function parseSourceGeneratedBlock(
  value: unknown,
  ownerId: string,
  failure: Failure
): EncryptedGeneratedBlockRead | null {
  if (value === null) return null;
  const record = exactRecord(
    value,
    [
      "blockId",
      "noteId",
      "decisionId",
      "reviewItemId",
      "kind",
      "state",
      "stateRevision",
      "modelId",
      "promptVersion",
      "resolvedAt",
      "createdAt",
      "contentCipher"
    ],
    failure
  );
  const blockId = entityId(record.blockId, "blk", failure);
  const kind =
    record.kind === "summary" ||
    record.kind === "interpretation" ||
    record.kind === "suggestion" ||
    record.kind === "label"
      ? record.kind
      : failure();
  const state =
    record.state === "proposed" || record.state === "accepted" || record.state === "rejected"
      ? record.state
      : failure();
  const stateRevision = positiveInteger(record.stateRevision, failure);
  const resolvedAt = nullableTimestamp(record.resolvedAt, failure);
  const createdAt = timestamp(record.createdAt, failure);
  if (
    (state === "proposed" && (stateRevision !== 1 || resolvedAt !== null)) ||
    (state !== "proposed" && (stateRevision < 2 || resolvedAt === null)) ||
    (resolvedAt !== null &&
      encryptedCaptureTimestampMicros(resolvedAt, failure) <
        encryptedCaptureTimestampMicros(createdAt, failure))
  ) {
    return failure();
  }
  return Object.freeze({
    blockId,
    recordVersion: 1 as const,
    noteId: entityId(record.noteId, "note", failure),
    decisionId: entityId(record.decisionId, "dec", failure),
    reviewItemId: nullableEntityId(record.reviewItemId, "rvw", failure),
    kind,
    state,
    stateRevision,
    modelId: boundedString(record.modelId, 1, 120, failure),
    promptVersion: boundedString(record.promptVersion, 1, 120, failure),
    resolvedAt,
    createdAt,
    contentCipher: parseStoredCipher(
      record.contentCipher,
      {
        ownerId,
        resourceId: blockId,
        recordVersion: 1,
        kind: "generated_block",
        keyClass: "ai_assisted"
      },
      failure
    )
  });
}

function parseSource(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionPreparedSource {
  if (!isRecord(value)) return failure();
  const hasGeneratedBlock = Object.hasOwn(value, "generatedBlock");
  const record = exactRecord(
    value,
    ["decision", "review", "receipt", "capture", ...(hasGeneratedBlock ? ["generatedBlock"] : [])],
    failure
  );
  return Object.freeze({
    decision: parseSourceDecision(record.decision, ownerId, failure),
    review: parseSourceReview(record.review, ownerId, failure),
    receipt: parseSourceReceipt(record.receipt, ownerId, failure),
    capture: parseSourceCapture(record.capture, ownerId, failure),
    generatedBlock: hasGeneratedBlock
      ? parseSourceGeneratedBlock(record.generatedBlock, ownerId, failure)
      : null
  });
}

function memberRole(value: unknown, failure: Failure): OwnerInteractionMemberRole {
  return value === "source_removal" || value === "destination_write" || value === "undo"
    ? value
    : failure();
}

function sourceBatchKind(
  value: unknown,
  failure: Failure
): PrepareMutationBatchUndoResult["ids"]["sourceBatchKind"] {
  return value === "organization" || value === "correction" ? value : failure();
}

async function parseMember(
  value: unknown,
  ownerId: string,
  failure: Failure
): Promise<OwnerInteractionPreparedMember> {
  const record = exactRecord(
    value,
    [
      "ordinal",
      "role",
      "noteId",
      "targetMutationId",
      "expectedRevision",
      "sourcePrivacy",
      "targetPrivacy",
      "revisionId",
      "mutationId",
      "currentNote",
      "currentMutation"
    ],
    failure
  );
  const ordinal = nonnegativeInteger(record.ordinal, failure);
  if (ordinal >= MAX_BATCH_MEMBERS) return failure();
  const role = memberRole(record.role, failure);
  const noteId = entityId(record.noteId, "note", failure);
  const targetMutationId = nullableEntityId(record.targetMutationId, "mut", failure);
  const expectedRevision = nonnegativeInteger(record.expectedRevision, failure);
  const sourcePrivacy =
    record.sourcePrivacy === null ? null : privacy(record.sourcePrivacy, failure);
  const targetPrivacy = privacy(record.targetPrivacy, failure);
  const revisionId = entityId(record.revisionId, "rev", failure);
  const mutationId = entityId(record.mutationId, "mut", failure);
  projectionDiagnostic(`member.${role}.scalars`);
  const currentNote =
    record.currentNote === null
      ? null
      : await parsePreparedNote(record.currentNote, ownerId, noteId, failure);
  projectionDiagnostic(`member.${role}.note`);
  const currentMutation =
    record.currentMutation === null
      ? null
      : targetMutationId === null
        ? failure()
        : await parsePreparedMutation(record.currentMutation, ownerId, targetMutationId, failure);
  projectionDiagnostic(`member.${role}.mutation`);

  if (role === "destination_write") {
    if (targetMutationId !== null || currentMutation !== null) return failure();
    if (expectedRevision === 0) {
      if (sourcePrivacy !== null || currentNote !== null) return failure();
    } else if (
      sourcePrivacy === null ||
      currentNote?.currentRevision !== expectedRevision ||
      currentNote.privacy !== sourcePrivacy
    ) {
      return failure();
    }
  } else {
    if (
      expectedRevision < 1 ||
      targetMutationId === null ||
      sourcePrivacy === null ||
      currentNote?.currentRevision !== expectedRevision ||
      currentNote.privacy !== sourcePrivacy ||
      currentMutation?.noteId !== noteId ||
      currentMutation.mutationId !== targetMutationId ||
      !isDeepStrictEqual(currentMutation.currentNote, currentNote)
    ) {
      return failure();
    }
    const restoredPrivacy = currentMutation.beforeSnapshot?.privacy ?? currentNote.privacy;
    if (targetPrivacy !== restoredPrivacy) return failure();
  }

  projectionDiagnostic(`member.${role}.bindings`);

  return Object.freeze({
    ordinal,
    role,
    noteId,
    targetMutationId,
    expectedRevision,
    sourcePrivacy,
    targetPrivacy,
    revisionId,
    mutationId,
    currentNote,
    currentMutation
  });
}

async function parseMembers(
  value: unknown,
  ownerId: string,
  failure: Failure
): Promise<readonly OwnerInteractionPreparedMember[]> {
  if (!Array.isArray(value) || value.length > MAX_BATCH_MEMBERS) return failure();
  const members: OwnerInteractionPreparedMember[] = [];
  const noteIds = new Set<string>();
  const targetMutationIds = new Set<string>();
  const revisionIds = new Set<string>();
  const mutationIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    const member = await parseMember(item, ownerId, failure);
    if (
      member.ordinal !== index ||
      noteIds.has(member.noteId) ||
      (member.targetMutationId !== null && targetMutationIds.has(member.targetMutationId)) ||
      revisionIds.has(member.revisionId) ||
      mutationIds.has(member.mutationId)
    ) {
      return failure();
    }
    noteIds.add(member.noteId);
    if (member.targetMutationId !== null) targetMutationIds.add(member.targetMutationId);
    revisionIds.add(member.revisionId);
    mutationIds.add(member.mutationId);
    members.push(member);
  }
  return Object.freeze(members);
}

function reservationRole(value: unknown, failure: Failure): OwnerInteractionReservationRole {
  if (value === "review" || value === "receipt" || value === "response") return value;
  if (typeof value !== "string") return failure();
  const match = /^(note_content|note_revision|note_mutation):(0|[1-9][0-9]?)$/u.exec(value);
  if (match === null || Number(match[2]) >= MAX_BATCH_MEMBERS) return failure();
  return value as OwnerInteractionReservationRole;
}

function reservationSurface(value: unknown, failure: Failure): OwnerInteractionReservationSurface {
  return value === "note_content" ||
    value === "note_revision" ||
    value === "note_mutation" ||
    value === "review_item" ||
    value === "capture_receipt" ||
    value === "idempotency_response"
    ? value
    : failure();
}

function expectedSurface(
  role: OwnerInteractionReservationRole
): OwnerInteractionReservationSurface {
  if (role === "review") return "review_item";
  if (role === "receipt") return "capture_receipt";
  if (role === "response") return "idempotency_response";
  return role.slice(0, role.indexOf(":")) as OwnerInteractionReservationSurface;
}

function parseReservation(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionPreparedReservation {
  const record = exactRecord(
    value,
    ["role", "surface", "resourceId", "recordVersion", "keyClass", "reservationId", "key"],
    failure
  );
  const role = reservationRole(record.role, failure);
  const surface = reservationSurface(record.surface, failure);
  if (surface !== expectedSurface(role)) return failure();
  const parsedClass = keyClass(record.keyClass, failure);
  const reservationId = boundedString(record.reservationId, 1, 128, failure);
  if (!UUID_PATTERN.test(reservationId)) return failure();
  return Object.freeze({
    role,
    surface,
    resourceId: resourceId(record.resourceId, failure),
    recordVersion: positiveInteger(record.recordVersion, failure),
    keyClass: parsedClass,
    reservationId,
    key: parsePreparedKey(
      record.key,
      { ownerId, keyClass: parsedClass, purpose: "object_wrap" },
      failure
    )
  });
}

function parseReservations(
  value: unknown,
  ownerId: string,
  failure: Failure
): readonly OwnerInteractionPreparedReservation[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH_MEMBERS * 3 + 3) return failure();
  const roles = new Set<string>();
  const reservations = new Set<string>();
  return Object.freeze(
    value.map((item) => {
      const parsed = parseReservation(item, ownerId, failure);
      if (roles.has(parsed.role) || reservations.has(parsed.reservationId)) return failure();
      roles.add(parsed.role);
      reservations.add(parsed.reservationId);
      return parsed;
    })
  );
}

function assertDisjointReservations(
  groups: readonly (readonly OwnerInteractionPreparedReservation[])[],
  failure: Failure
): void {
  const reservationIds = new Set<string>();
  for (const group of groups) {
    for (const reservation of group) {
      if (reservationIds.has(reservation.reservationId)) return failure();
      reservationIds.add(reservation.reservationId);
    }
  }
}

export function objectWrapReservationFromPreparation(
  reservation: OwnerInteractionPreparedReservation
): ObjectWrapReservation {
  return Object.freeze({
    reservationId: reservation.reservationId,
    reference: Object.freeze({
      ownerId: reservation.key.ownerId,
      keyClass: reservation.key.keyClass,
      purpose: "object_wrap" as const,
      keyId: reservation.key.keyId,
      keyVersion: reservation.key.keyVersion
    })
  });
}

export function reservationByRole(
  reservations: readonly OwnerInteractionPreparedReservation[],
  role: OwnerInteractionReservationRole
): OwnerInteractionPreparedReservation {
  const matches = reservations.filter((reservation) => reservation.role === role);
  return matches.length === 1 && matches[0] !== undefined ? matches[0] : projectionFailure();
}

function parseCorrectionAppliedBranch(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionCorrectionAppliedBranch {
  const record = exactRecord(
    value,
    ["available", "feedbackEventId", "batchId", "reservations"],
    failure
  );
  if (typeof record.available !== "boolean") return failure();
  const feedbackEventId = nullableEntityId(record.feedbackEventId, "fbk", failure);
  const batchId = record.batchId === null ? null : canonicalUuid(record.batchId, failure);
  const reservations = parseReservations(record.reservations, ownerId, failure);
  if (
    record.available !== (feedbackEventId !== null && batchId !== null && reservations.length > 0)
  ) {
    return failure();
  }
  return Object.freeze({
    available: record.available,
    feedbackEventId,
    batchId,
    reservations
  });
}

function parseBatchAppliedBranch(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionBatchAppliedBranch {
  const record = exactRecord(value, ["available", "batchId", "reservations"], failure);
  if (typeof record.available !== "boolean") return failure();
  const batchId = record.batchId === null ? null : canonicalUuid(record.batchId, failure);
  const reservations = parseReservations(record.reservations, ownerId, failure);
  if (record.available !== (batchId !== null && reservations.length > 0)) return failure();
  return Object.freeze({ available: record.available, batchId, reservations });
}

function parseNeedsReviewBranch(
  value: unknown,
  ownerId: string,
  failure: Failure
): OwnerInteractionNeedsReviewBranch {
  const record = exactRecord(value, ["available", "reviewItemId", "reservations"], failure);
  if (typeof record.available !== "boolean") return failure();
  const reviewItemId = nullableEntityId(record.reviewItemId, "rvw", failure);
  const reservations = parseReservations(record.reservations, ownerId, failure);
  if (record.available !== (reviewItemId !== null && reservations.length > 0)) return failure();
  return Object.freeze({ available: record.available, reviewItemId, reservations });
}

function selectedOutcome(value: unknown, failure: Failure): "applied" | "needs_review" | null {
  return value === null || value === "applied" || value === "needs_review" ? value : failure();
}

function parsePendingPreparationReplay(
  completed: unknown,
  replayed: unknown,
  selected: "applied" | "needs_review" | null,
  encryptedResponse: EncryptedAggregateRecord<"idempotency_response"> | null,
  encryptedResponseVerificationMac: unknown,
  failure: Failure
): boolean {
  if (
    completed !== false ||
    typeof replayed !== "boolean" ||
    selected !== null ||
    encryptedResponse !== null ||
    encryptedResponseVerificationMac !== null
  ) {
    return failure();
  }
  return replayed;
}

function reservationForRole(
  reservations: readonly OwnerInteractionPreparedReservation[],
  role: OwnerInteractionReservationRole
): OwnerInteractionPreparedReservation | null {
  return reservations.find((reservation) => reservation.role === role) ?? null;
}

function assertMemberReservationBindings(
  members: readonly OwnerInteractionPreparedMember[],
  reservations: readonly OwnerInteractionPreparedReservation[],
  failure: Failure
): void {
  const noteReservations = reservations.filter(
    (reservation) =>
      reservation.surface === "note_content" ||
      reservation.surface === "note_revision" ||
      reservation.surface === "note_mutation"
  );
  if (noteReservations.length !== members.length * 3) return failure();
  for (const member of members) {
    const afterRevision = member.expectedRevision + 1;
    if (afterRevision > MAX_DATABASE_INTEGER) return failure();
    const note = reservationForRole(reservations, `note_content:${member.ordinal}`);
    const revision = reservationForRole(reservations, `note_revision:${member.ordinal}`);
    const mutation = reservationForRole(reservations, `note_mutation:${member.ordinal}`);
    const stickyClass: KeyClass =
      member.sourcePrivacy === "private_manual" || member.targetPrivacy === "private_manual"
        ? "private_manual"
        : "ai_assisted";
    if (
      note?.resourceId !== member.noteId ||
      note.recordVersion !== afterRevision ||
      note.keyClass !== member.targetPrivacy ||
      revision?.resourceId !== member.revisionId ||
      revision.recordVersion !== afterRevision ||
      revision.keyClass !== stickyClass ||
      mutation?.resourceId !== member.mutationId ||
      mutation.recordVersion !== afterRevision ||
      mutation.keyClass !== stickyClass
    ) {
      return failure();
    }
  }
}

function interactionKeyClass(
  members: readonly OwnerInteractionPreparedMember[],
  source: OwnerInteractionPreparedSource
): KeyClass {
  return members.some(
    (member) =>
      member.sourcePrivacy === "private_manual" ||
      member.targetPrivacy === "private_manual" ||
      member.currentMutation?.mutationCipher.keyClass === "private_manual" ||
      member.currentMutation?.beforeSnapshot?.snapshotCipher.keyClass === "private_manual" ||
      member.currentMutation?.beforeSnapshot?.snapshotMac.keyClass === "private_manual" ||
      member.currentMutation?.afterSnapshot.snapshotCipher.keyClass === "private_manual" ||
      member.currentMutation?.afterSnapshot.snapshotMac.keyClass === "private_manual"
  ) ||
    source.receipt?.sourcePrivacy === "private_manual" ||
    source.capture?.privacy === "private_manual" ||
    source.review?.contentCipher.keyClass === "private_manual"
    ? "private_manual"
    : "ai_assisted";
}

function parseEncryptedResponse(
  value: unknown,
  ownerId: string,
  key: string,
  expectedClass: KeyClass,
  failure: Failure
): EncryptedAggregateRecord<"idempotency_response"> | null {
  return value === null
    ? null
    : parseStoredCipher(
        value,
        {
          ownerId,
          resourceId: `idempotency:${key}`,
          recordVersion: 1,
          kind: "idempotency_response",
          keyClass: expectedClass
        },
        failure
      );
}

function parseCompletedResponse(
  record: UnknownRecord,
  ownerId: string,
  key: string,
  failure: Failure
): Readonly<{
  encryptedResponse: EncryptedAggregateRecord<"idempotency_response">;
  encryptedResponseVerificationMac: KeyedMacRecord;
  occurredAt: string;
  requestMacKey: ManagedKeyRecord;
}> {
  if (
    record.completed !== true ||
    record.replayed !== true ||
    record.source !== null ||
    !Array.isArray(record.members) ||
    record.members.length !== 0
  ) {
    return failure();
  }
  const requestMacKey = parseReplayRequestMacKey(record.requestMacKey, ownerId, failure);
  const encryptedResponse = parseEncryptedResponse(
    record.encryptedResponse,
    ownerId,
    key,
    requestMacKey.keyClass,
    failure
  );
  if (encryptedResponse === null || record.encryptedResponseVerificationMac === null) {
    return failure();
  }
  return Object.freeze({
    occurredAt: timestamp(record.occurredAt, failure),
    requestMacKey,
    encryptedResponse,
    encryptedResponseVerificationMac: parseStoredMac(
      record.encryptedResponseVerificationMac,
      requestMacKey.keyClass,
      failure
    )
  });
}

function parseCompletedCorrectionAppliedBranch(
  value: unknown,
  selected: "applied" | "needs_review",
  failure: Failure
): OwnerInteractionCorrectionAppliedBranch {
  const record = exactRecord(
    value,
    ["available", "feedbackEventId", "batchId", "reservations"],
    failure
  );
  if (
    record.available !== (selected === "applied") ||
    !Array.isArray(record.reservations) ||
    record.reservations.length !== 0
  ) {
    return failure();
  }
  const feedbackEventId = nullableEntityId(record.feedbackEventId, "fbk", failure);
  const batchId = record.batchId === null ? null : canonicalUuid(record.batchId, failure);
  if (selected === "applied" && (feedbackEventId === null || batchId === null)) return failure();
  return Object.freeze({
    available: record.available,
    feedbackEventId,
    batchId,
    reservations: Object.freeze([])
  });
}

function parseCompletedBatchAppliedBranch(
  value: unknown,
  selected: "applied" | "needs_review",
  failure: Failure
): OwnerInteractionBatchAppliedBranch {
  const record = exactRecord(value, ["available", "batchId", "reservations"], failure);
  if (
    record.available !== (selected === "applied") ||
    !Array.isArray(record.reservations) ||
    record.reservations.length !== 0
  ) {
    return failure();
  }
  const batchId = record.batchId === null ? null : canonicalUuid(record.batchId, failure);
  if (selected === "applied" && batchId === null) return failure();
  return Object.freeze({
    available: record.available,
    batchId,
    reservations: Object.freeze([])
  });
}

function parseCompletedNeedsReviewBranch(
  value: unknown,
  selected: "applied" | "needs_review",
  failure: Failure
): OwnerInteractionNeedsReviewBranch {
  const record = exactRecord(value, ["available", "reviewItemId", "reservations"], failure);
  if (
    record.available !== (selected === "needs_review") ||
    !Array.isArray(record.reservations) ||
    record.reservations.length !== 0
  ) {
    return failure();
  }
  const reviewItemId = nullableEntityId(record.reviewItemId, "rvw", failure);
  if (selected === "needs_review" && reviewItemId === null) return failure();
  return Object.freeze({
    available: record.available,
    reviewItemId,
    reservations: Object.freeze([])
  });
}

function assertCommonReservations(
  reservations: readonly OwnerInteractionPreparedReservation[],
  source: OwnerInteractionPreparedSource,
  ownerId: string,
  key: string,
  expectedClass: KeyClass,
  failure: Failure
): void {
  const expectedLength = source.receipt === null ? 1 : 2;
  if (reservations.length !== expectedLength) return failure();
  const response = reservationForRole(reservations, "response");
  if (
    response?.resourceId !== `idempotency:${key}` ||
    response.recordVersion !== 1 ||
    response.keyClass !== expectedClass
  ) {
    return failure();
  }
  const receipt = reservationForRole(reservations, "receipt");
  if (source.receipt === null) {
    if (receipt !== null) return failure();
  } else if (
    receipt?.resourceId !== source.receipt.captureId ||
    receipt.recordVersion !== source.receipt.recordVersion + 1 ||
    receipt.keyClass !== source.receipt.sourcePrivacy
  ) {
    return failure();
  }
  if (ownerId !== response.key.ownerId) return failure();
}

function assertReviewBranchReservation(
  branch: OwnerInteractionNeedsReviewBranch,
  sourcePrivacy: PrivacyMode,
  failure: Failure
): void {
  if (!branch.available) return;
  const reservation = reservationForRole(branch.reservations, "review");
  if (
    branch.reviewItemId === null ||
    branch.reservations.length !== 1 ||
    reservation?.resourceId !== branch.reviewItemId ||
    reservation.recordVersion !== 1 ||
    reservation.keyClass !== sourcePrivacy
  ) {
    return failure();
  }
}

async function parseDecisionCorrectionPreparation(
  value: unknown,
  request: Readonly<{
    ownerId: string;
    decisionId: EntityId<"dec">;
    input: DecisionCorrectionRequest;
  }>
): Promise<PrepareDecisionCorrectionResult> {
  const record = exactRecord(
    value,
    [
      "scope",
      "occurredAt",
      "completed",
      "replayed",
      "selectedOutcome",
      "requestMacKey",
      "ids",
      "source",
      "members",
      "commonReservations",
      "branches",
      "encryptedResponse",
      "encryptedResponseVerificationMac"
    ],
    projectionFailure
  );
  projectionDiagnostic("correction.record");
  if (record.scope !== "encrypted_decision_correction") return projectionFailure();
  const occurredAt = timestamp(record.occurredAt, projectionFailure);
  const selected = selectedOutcome(record.selectedOutcome, projectionFailure);
  projectionDiagnostic("correction.lifecycle-fields");
  const idsRecord = exactRecord(
    record.ids,
    ["decisionId", "sourceNoteId", "destinationNoteId", "captureId"],
    projectionFailure
  );
  const ids = Object.freeze({
    decisionId: entityId(idsRecord.decisionId, "dec", projectionFailure),
    sourceNoteId: entityId(idsRecord.sourceNoteId, "note", projectionFailure),
    destinationNoteId: entityId(idsRecord.destinationNoteId, "note", projectionFailure),
    captureId: entityId(idsRecord.captureId, "cap", projectionFailure)
  });
  projectionDiagnostic("correction.ids");
  if (record.completed) {
    projectionDiagnostic("correction.completed");
    if (selected === null) projectionDiagnostic("correction.completed-missing-outcome");
    if (ids.decisionId !== request.decisionId) {
      projectionDiagnostic("correction.completed-decision-mismatch");
    }
    if (ids.sourceNoteId !== request.input.source.noteId) {
      projectionDiagnostic("correction.completed-source-mismatch");
    }
    if (ids.sourceNoteId === ids.destinationNoteId) {
      projectionDiagnostic("correction.completed-identical-notes");
    }
    if (
      request.input.destination.type === "existing_note" &&
      ids.destinationNoteId !== request.input.destination.noteId
    ) {
      projectionDiagnostic("correction.completed-destination-mismatch");
    }
    if (!Array.isArray(record.commonReservations)) {
      projectionDiagnostic("correction.completed-common-not-array");
    } else if (record.commonReservations.length !== 0) {
      projectionDiagnostic("correction.completed-common-not-empty");
    }
    if (
      selected === null ||
      ids.decisionId !== request.decisionId ||
      ids.sourceNoteId !== request.input.source.noteId ||
      ids.sourceNoteId === ids.destinationNoteId ||
      (request.input.destination.type === "existing_note" &&
        ids.destinationNoteId !== request.input.destination.noteId) ||
      !Array.isArray(record.commonReservations) ||
      record.commonReservations.length !== 0
    ) {
      return projectionFailure();
    }
    const branchesRecord = exactRecord(
      record.branches,
      ["applied", "needsReview"],
      projectionFailure
    );
    projectionDiagnostic("correction.completed-branches-record");
    const branches = Object.freeze({
      applied: parseCompletedCorrectionAppliedBranch(
        branchesRecord.applied,
        selected,
        projectionFailure
      ),
      needsReview: parseCompletedNeedsReviewBranch(
        branchesRecord.needsReview,
        selected,
        projectionFailure
      )
    });
    const completed = parseCompletedResponse(
      record,
      request.ownerId,
      request.input.idempotencyKey,
      projectionFailure
    );
    projectionDiagnostic("correction.completed-response");
    return Object.freeze({
      scope: "encrypted_decision_correction" as const,
      ...completed,
      completed: true as const,
      replayed: true as const,
      selectedOutcome: selected,
      ids,
      source: null,
      members: Object.freeze([]),
      commonReservations: Object.freeze([]),
      branches
    });
  }
  const source = parseSource(record.source, request.ownerId, projectionFailure);
  projectionDiagnostic("correction.source");
  const members = await parseMembers(record.members, request.ownerId, projectionFailure);
  projectionDiagnostic("correction.members");
  const commonReservations = parseReservations(
    record.commonReservations,
    request.ownerId,
    projectionFailure
  );
  projectionDiagnostic("correction.common-reservations");
  const branchesRecord = exactRecord(
    record.branches,
    ["applied", "needsReview"],
    projectionFailure
  );
  const branches = Object.freeze({
    applied: parseCorrectionAppliedBranch(
      branchesRecord.applied,
      request.ownerId,
      projectionFailure
    ),
    needsReview: parseNeedsReviewBranch(
      branchesRecord.needsReview,
      request.ownerId,
      projectionFailure
    )
  });
  projectionDiagnostic("correction.branches");
  assertDisjointReservations(
    [commonReservations, branches.applied.reservations, branches.needsReview.reservations],
    projectionFailure
  );
  projectionDiagnostic("correction.disjoint-reservations");

  const sourceMember = members.find((member) => member.role === "source_removal");
  const destinationMember = members.find((member) => member.role === "destination_write");
  if (
    ids.decisionId !== request.decisionId ||
    ids.sourceNoteId !== request.input.source.noteId ||
    ids.sourceNoteId === ids.destinationNoteId ||
    source.decision === null ||
    source.receipt === null ||
    source.review !== null ||
    source.decision.decisionId !== ids.decisionId ||
    source.decision.captureId !== ids.captureId ||
    source.decision.destinationNoteId !== ids.sourceNoteId ||
    source.receipt.captureId !== ids.captureId ||
    source.receipt.decisionId !== ids.decisionId ||
    source.receipt.destinationNoteId !== ids.sourceNoteId ||
    sourceMember === undefined ||
    destinationMember === undefined ||
    members.length !== 2 ||
    sourceMember.noteId !== ids.sourceNoteId ||
    sourceMember.expectedRevision !== request.input.source.expectedRevision ||
    sourceMember.targetMutationId !== source.receipt.mutationId ||
    destinationMember.noteId !== ids.destinationNoteId
  ) {
    return projectionFailure();
  }
  projectionDiagnostic("correction.structural-bindings");
  if (
    request.input.destination.type === "existing_note"
      ? ids.destinationNoteId !== request.input.destination.noteId ||
        destinationMember.expectedRevision !== request.input.destination.expectedRevision ||
        destinationMember.currentNote?.type === undefined
      : destinationMember.expectedRevision !== 0 ||
        destinationMember.currentNote !== null ||
        destinationMember.targetPrivacy !== sourceMember.targetPrivacy
  ) {
    return projectionFailure();
  }
  projectionDiagnostic("correction.destination-binding");
  if (source.capture !== null && source.capture.captureId !== ids.captureId) {
    return projectionFailure();
  }
  projectionDiagnostic("correction.capture-binding");

  const expectedClass = interactionKeyClass(members, source);
  const requestMacKey = parsePreparedKey(
    record.requestMacKey,
    { ownerId: request.ownerId, keyClass: expectedClass, purpose: "content_mac" },
    projectionFailure
  );
  projectionDiagnostic("correction.request-mac-key");
  const encryptedResponse = parseEncryptedResponse(
    record.encryptedResponse,
    request.ownerId,
    request.input.idempotencyKey,
    expectedClass,
    projectionFailure
  );
  const replayed = parsePendingPreparationReplay(
    record.completed,
    record.replayed,
    selected,
    encryptedResponse,
    record.encryptedResponseVerificationMac,
    projectionFailure
  );
  projectionDiagnostic("correction.pending-lifecycle");
  assertCommonReservations(
    commonReservations,
    source,
    request.ownerId,
    request.input.idempotencyKey,
    expectedClass,
    projectionFailure
  );
  projectionDiagnostic("correction.common-reservation-bindings");
  if (branches.applied.available) {
    assertMemberReservationBindings(members, branches.applied.reservations, projectionFailure);
  }
  projectionDiagnostic("correction.member-reservation-bindings");
  assertReviewBranchReservation(branches.needsReview, expectedClass, projectionFailure);
  projectionDiagnostic("correction.review-reservation-binding");
  if (
    (selected === "applied" && !branches.applied.available) ||
    (selected === "needs_review" && !branches.needsReview.available)
  ) {
    return projectionFailure();
  }

  return Object.freeze({
    scope: "encrypted_decision_correction" as const,
    occurredAt,
    completed: false as const,
    replayed,
    selectedOutcome: null,
    requestMacKey,
    ids,
    source,
    members,
    commonReservations,
    branches,
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

async function parseMutationBatchPreparation(
  value: unknown,
  request: Readonly<{
    ownerId: string;
    mutationId: EntityId<"mut">;
    input: MutationUndoRequest;
  }>
): Promise<PrepareMutationBatchUndoResult> {
  const record = exactRecord(
    value,
    [
      "scope",
      "occurredAt",
      "completed",
      "replayed",
      "selectedOutcome",
      "requestMacKey",
      "ids",
      "source",
      "members",
      "commonReservations",
      "branches",
      "encryptedResponse",
      "encryptedResponseVerificationMac"
    ],
    projectionFailure
  );
  if (record.scope !== "encrypted_mutation_batch_undo") return projectionFailure();
  const occurredAt = timestamp(record.occurredAt, projectionFailure);
  const selected = selectedOutcome(record.selectedOutcome, projectionFailure);
  const idsRecord = exactRecord(
    record.ids,
    ["anchorMutationId", "sourceBatchKind", "restoredSourceTargetMutationId"],
    projectionFailure
  );
  const ids = Object.freeze({
    anchorMutationId: entityId(idsRecord.anchorMutationId, "mut", projectionFailure),
    sourceBatchKind: sourceBatchKind(idsRecord.sourceBatchKind, projectionFailure),
    restoredSourceTargetMutationId: nullableEntityId(
      idsRecord.restoredSourceTargetMutationId,
      "mut",
      projectionFailure
    )
  });
  if ((ids.sourceBatchKind === "correction") !== (ids.restoredSourceTargetMutationId !== null)) {
    return projectionFailure();
  }
  if (record.completed === true) {
    if (
      selected === null ||
      ids.anchorMutationId !== request.mutationId ||
      !Array.isArray(record.commonReservations) ||
      record.commonReservations.length !== 0
    ) {
      return projectionFailure();
    }
    const branchesRecord = exactRecord(
      record.branches,
      ["applied", "needsReview"],
      projectionFailure
    );
    const branches = Object.freeze({
      applied: parseCompletedBatchAppliedBranch(
        branchesRecord.applied,
        selected,
        projectionFailure
      ),
      needsReview: parseCompletedNeedsReviewBranch(
        branchesRecord.needsReview,
        selected,
        projectionFailure
      )
    });
    const completed = parseCompletedResponse(
      record,
      request.ownerId,
      request.input.idempotencyKey,
      projectionFailure
    );
    return Object.freeze({
      scope: "encrypted_mutation_batch_undo" as const,
      ...completed,
      completed: true as const,
      replayed: true as const,
      selectedOutcome: selected,
      ids,
      source: null,
      members: Object.freeze([]),
      commonReservations: Object.freeze([]),
      branches
    });
  }
  const source = parseSource(record.source, request.ownerId, projectionFailure);
  const members = await parseMembers(record.members, request.ownerId, projectionFailure);
  const commonReservations = parseReservations(
    record.commonReservations,
    request.ownerId,
    projectionFailure
  );
  const branchesRecord = exactRecord(
    record.branches,
    ["applied", "needsReview"],
    projectionFailure
  );
  const branches = Object.freeze({
    applied: parseBatchAppliedBranch(branchesRecord.applied, request.ownerId, projectionFailure),
    needsReview: parseNeedsReviewBranch(
      branchesRecord.needsReview,
      request.ownerId,
      projectionFailure
    )
  });
  assertDisjointReservations(
    [commonReservations, branches.applied.reservations, branches.needsReview.reservations],
    projectionFailure
  );

  const anchor = members.find((member) => member.targetMutationId === request.mutationId);
  const restoredSource =
    ids.restoredSourceTargetMutationId === null
      ? null
      : (members.find((member) => member.targetMutationId === ids.restoredSourceTargetMutationId) ??
        null);
  const receipt = source.receipt;
  const correctionReceiptMatches =
    receipt === null
      ? false
      : receipt.decisionId !== null &&
        receipt.mutationId === ids.anchorMutationId &&
        receipt.destinationNoteId === anchor?.noteId;
  if (
    ids.anchorMutationId !== request.mutationId ||
    members.length < 1 ||
    members.some((member) => member.role !== "undo") ||
    members.some(
      (member, index) => index > 0 && (members[index - 1]?.noteId ?? member.noteId) >= member.noteId
    ) ||
    anchor?.expectedRevision !== request.input.expectedRevision ||
    source.decision !== null ||
    source.review !== null ||
    source.capture !== null
  ) {
    return projectionFailure();
  }
  if (
    ids.sourceBatchKind === "correction" &&
    (members.length !== 2 ||
      restoredSource === null ||
      restoredSource === anchor ||
      !correctionReceiptMatches)
  ) {
    return projectionFailure();
  }
  if (source.receipt !== null) {
    const mutationIds = new Set(members.map((member) => member.targetMutationId));
    if (source.receipt.mutationId !== null && !mutationIds.has(source.receipt.mutationId)) {
      return projectionFailure();
    }
  }

  const expectedClass = interactionKeyClass(members, source);
  const requestMacKey = parsePreparedKey(
    record.requestMacKey,
    { ownerId: request.ownerId, keyClass: expectedClass, purpose: "content_mac" },
    projectionFailure
  );
  const encryptedResponse = parseEncryptedResponse(
    record.encryptedResponse,
    request.ownerId,
    request.input.idempotencyKey,
    expectedClass,
    projectionFailure
  );
  const replayed = parsePendingPreparationReplay(
    record.completed,
    record.replayed,
    selected,
    encryptedResponse,
    record.encryptedResponseVerificationMac,
    projectionFailure
  );
  assertCommonReservations(
    commonReservations,
    source,
    request.ownerId,
    request.input.idempotencyKey,
    expectedClass,
    projectionFailure
  );
  if (branches.applied.available) {
    assertMemberReservationBindings(members, branches.applied.reservations, projectionFailure);
  }
  assertReviewBranchReservation(branches.needsReview, expectedClass, projectionFailure);
  if (
    (selected === "applied" && !branches.applied.available) ||
    (selected === "needs_review" && !branches.needsReview.available)
  ) {
    return projectionFailure();
  }

  return Object.freeze({
    scope: "encrypted_mutation_batch_undo" as const,
    occurredAt,
    completed: false as const,
    replayed,
    selectedOutcome: null,
    requestMacKey,
    ids,
    source,
    members,
    commonReservations,
    branches,
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

async function parseReviewResolutionPreparation(
  value: unknown,
  request: Readonly<{
    ownerId: string;
    reviewItemId: EntityId<"rvw">;
    input: ReviewResolveRequest;
  }>
): Promise<PrepareReviewResolutionResult> {
  const record = exactRecord(
    value,
    [
      "scope",
      "action",
      "occurredAt",
      "completed",
      "replayed",
      "requestMacKey",
      "ids",
      "source",
      "members",
      "reservations",
      "encryptedResponse",
      "encryptedResponseVerificationMac"
    ],
    projectionFailure
  );
  if (
    record.scope !== "encrypted_review_resolution" ||
    record.action !== request.input.resolution.type
  ) {
    return projectionFailure();
  }
  const action = record.action as ReviewResolveRequest["resolution"]["type"];
  const occurredAt = timestamp(record.occurredAt, projectionFailure);
  if (typeof record.completed !== "boolean" || typeof record.replayed !== "boolean") {
    return projectionFailure();
  }
  const idsRecord = exactRecord(
    record.ids,
    ["reviewItemId", "destinationNoteId", "destinationRevisionId", "destinationMutationId"],
    projectionFailure
  );
  const ids = Object.freeze({
    reviewItemId: entityId(idsRecord.reviewItemId, "rvw", projectionFailure),
    destinationNoteId: nullableEntityId(idsRecord.destinationNoteId, "note", projectionFailure),
    destinationRevisionId: nullableEntityId(
      idsRecord.destinationRevisionId,
      "rev",
      projectionFailure
    ),
    destinationMutationId: nullableEntityId(
      idsRecord.destinationMutationId,
      "mut",
      projectionFailure
    )
  });
  const writesNote = action === "route" || action === "create";
  if (record.completed) {
    if (
      ids.reviewItemId !== request.reviewItemId ||
      !Array.isArray(record.reservations) ||
      record.reservations.length !== 0 ||
      (writesNote
        ? ids.destinationNoteId === null ||
          ids.destinationRevisionId === null ||
          ids.destinationMutationId === null
        : ids.destinationNoteId !== null ||
          ids.destinationRevisionId !== null ||
          ids.destinationMutationId !== null) ||
      (action === "route" &&
        (request.input.resolution.type !== "route" ||
          ids.destinationNoteId !== request.input.resolution.noteId))
    ) {
      return projectionFailure();
    }
    const completed = parseCompletedResponse(
      record,
      request.ownerId,
      request.input.idempotencyKey,
      projectionFailure
    );
    return Object.freeze({
      scope: "encrypted_review_resolution" as const,
      action,
      ...completed,
      completed: true as const,
      replayed: true as const,
      ids,
      source: null,
      members: Object.freeze([]),
      reservations: Object.freeze([])
    });
  }
  const source = parseSource(record.source, request.ownerId, projectionFailure);
  const members = await parseMembers(record.members, request.ownerId, projectionFailure);
  const reservations = parseReservations(record.reservations, request.ownerId, projectionFailure);
  const expectedClass = interactionKeyClass(members, source);
  const resolvesCaptureLinkedDuplicate =
    source.review?.type === "duplicate_suggestion" &&
    (action === "keep_both" || action === "dismiss") &&
    source.receipt !== null;
  const changesReceipt = writesNote || action === "keep_inbox" || resolvesCaptureLinkedDuplicate;

  if (
    ids.reviewItemId !== request.reviewItemId ||
    source.review?.reviewItemId !== request.reviewItemId ||
    source.review.state !== "open" ||
    source.decision !== null ||
    (writesNote ? members.length !== 1 : members.length !== 0) ||
    (writesNote
      ? ids.destinationNoteId === null ||
        ids.destinationRevisionId === null ||
        ids.destinationMutationId === null
      : ids.destinationNoteId !== null ||
        ids.destinationRevisionId !== null ||
        ids.destinationMutationId !== null)
  ) {
    return projectionFailure();
  }
  if (writesNote) {
    const member = members[0];
    if (
      member?.role !== "destination_write" ||
      member.noteId !== ids.destinationNoteId ||
      member.revisionId !== ids.destinationRevisionId ||
      member.mutationId !== ids.destinationMutationId ||
      source.capture === null ||
      (source.receipt?.decisionId ?? null) === null ||
      source.review.captureId !== source.capture.captureId ||
      source.receipt?.captureId !== source.capture.captureId
    ) {
      return projectionFailure();
    }
    if (
      action === "route"
        ? request.input.resolution.type !== "route" ||
          member.noteId !== request.input.resolution.noteId ||
          member.expectedRevision !== request.input.resolution.expectedRevision ||
          member.sourcePrivacy === null ||
          member.targetPrivacy !== member.sourcePrivacy
        : request.input.resolution.type !== "create" ||
          member.expectedRevision !== 0 ||
          member.targetPrivacy !== expectedClass
    ) {
      return projectionFailure();
    }
  } else if (
    (action === "keep_inbox" || resolvesCaptureLinkedDuplicate) &&
    (source.capture === null || source.receipt === null)
  ) {
    return projectionFailure();
  }
  if (source.capture !== null && source.review.captureId !== source.capture.captureId) {
    return projectionFailure();
  }
  if (source.review.captureId === null) {
    if (source.capture !== null || source.receipt !== null) return projectionFailure();
  } else {
    if (
      source.review.captureId !== source.receipt?.captureId ||
      source.receipt.reviewItemId !== request.reviewItemId ||
      (changesReceipt && source.capture === null)
    ) {
      return projectionFailure();
    }
  }

  const requestMacKey = parsePreparedKey(
    record.requestMacKey,
    { ownerId: request.ownerId, keyClass: expectedClass, purpose: "content_mac" },
    projectionFailure
  );
  const encryptedResponse = parseEncryptedResponse(
    record.encryptedResponse,
    request.ownerId,
    request.input.idempotencyKey,
    expectedClass,
    projectionFailure
  );
  const replayed = parsePendingPreparationReplay(
    record.completed,
    record.replayed,
    null,
    encryptedResponse,
    record.encryptedResponseVerificationMac,
    projectionFailure
  );

  const reviewReservation = reservationForRole(reservations, "review");
  const responseReservation = reservationForRole(reservations, "response");
  const receiptReservation = reservationForRole(reservations, "receipt");
  const writesReceipt = source.receipt !== null && changesReceipt;
  const expectedReservationCount = 2 + members.length * 3 + (writesReceipt ? 1 : 0);
  if (
    reservations.length !== expectedReservationCount ||
    reviewReservation?.resourceId !== source.review.reviewItemId ||
    reviewReservation.recordVersion !== source.review.recordVersion + 1 ||
    reviewReservation.keyClass !== expectedClass ||
    responseReservation?.resourceId !== `idempotency:${request.input.idempotencyKey}` ||
    responseReservation.recordVersion !== 1 ||
    responseReservation.keyClass !== expectedClass
  ) {
    return projectionFailure();
  }
  if (!writesReceipt) {
    if (receiptReservation !== null) return projectionFailure();
  } else if (
    receiptReservation?.resourceId !== source.receipt.captureId ||
    receiptReservation.recordVersion !== source.receipt.recordVersion + 1 ||
    receiptReservation.keyClass !== source.receipt.sourcePrivacy
  ) {
    return projectionFailure();
  }
  assertMemberReservationBindings(members, reservations, projectionFailure);

  return Object.freeze({
    scope: "encrypted_review_resolution" as const,
    action,
    occurredAt,
    completed: false as const,
    replayed,
    requestMacKey,
    ids,
    source,
    members,
    reservations,
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

function generatedResolutionAction(
  resolution: GeneratedBlockResolveRequest["resolution"]
): GeneratedBlockResolutionAction {
  return resolution === "accept" ? "accept_expansion" : "reject_expansion";
}

async function parseGeneratedBlockResolutionPreparation(
  value: unknown,
  request: Readonly<{
    ownerId: string;
    blockId: EntityId<"blk">;
    reviewItemId: EntityId<"rvw">;
    input: GeneratedBlockResolveRequest;
  }>
): Promise<PrepareGeneratedBlockResolutionResult> {
  const record = exactRecord(
    value,
    [
      "scope",
      "action",
      "occurredAt",
      "completed",
      "replayed",
      "requestMacKey",
      "ids",
      "source",
      "members",
      "reservations",
      "encryptedResponse",
      "encryptedResponseVerificationMac"
    ],
    projectionFailure
  );
  const action = generatedResolutionAction(request.input.resolution);
  if (record.scope !== "encrypted_review_resolution" || record.action !== action) {
    return projectionFailure();
  }
  if (typeof record.completed !== "boolean" || typeof record.replayed !== "boolean") {
    return projectionFailure();
  }
  const idsRecord = exactRecord(
    record.ids,
    [
      "reviewItemId",
      "destinationNoteId",
      "destinationRevisionId",
      "destinationMutationId",
      "generatedBlockId",
      "stateRevision"
    ],
    projectionFailure
  );
  const ids = Object.freeze({
    reviewItemId: entityId(idsRecord.reviewItemId, "rvw", projectionFailure),
    destinationNoteId: nullableEntityId(idsRecord.destinationNoteId, "note", projectionFailure),
    destinationRevisionId: nullableEntityId(
      idsRecord.destinationRevisionId,
      "rev",
      projectionFailure
    ),
    destinationMutationId: nullableEntityId(
      idsRecord.destinationMutationId,
      "mut",
      projectionFailure
    ),
    generatedBlockId: entityId(idsRecord.generatedBlockId, "blk", projectionFailure),
    stateRevision: positiveInteger(idsRecord.stateRevision, projectionFailure)
  });
  if (
    ids.reviewItemId !== request.reviewItemId ||
    ids.generatedBlockId !== request.blockId ||
    ids.stateRevision !== request.input.expectedStateRevision ||
    ids.destinationNoteId !== null ||
    ids.destinationRevisionId !== null ||
    ids.destinationMutationId !== null
  ) {
    return projectionFailure();
  }
  if (record.completed) {
    if (!Array.isArray(record.reservations) || record.reservations.length !== 0) {
      return projectionFailure();
    }
    const completed = parseCompletedResponse(
      record,
      request.ownerId,
      request.input.idempotencyKey,
      projectionFailure
    );
    if (completed.requestMacKey.keyClass !== "ai_assisted") return projectionFailure();
    return Object.freeze({
      scope: "encrypted_review_resolution" as const,
      action,
      ...completed,
      completed: true as const,
      replayed: true as const,
      ids,
      source: null,
      members: Object.freeze([]),
      reservations: Object.freeze([])
    });
  }

  const occurredAt = timestamp(record.occurredAt, projectionFailure);
  const source = parseSource(record.source, request.ownerId, projectionFailure);
  const members = await parseMembers(record.members, request.ownerId, projectionFailure);
  const reservations = parseReservations(record.reservations, request.ownerId, projectionFailure);
  const block = source.generatedBlock;
  const review = source.review;
  const receipt = source.receipt;
  const capture = source.capture;
  if (
    source.decision !== null ||
    members.length !== 0 ||
    block === null ||
    block === undefined ||
    review === null ||
    receipt === null ||
    capture === null ||
    block.blockId !== request.blockId ||
    block.reviewItemId !== request.reviewItemId ||
    block.state !== "proposed" ||
    block.stateRevision !== request.input.expectedStateRevision ||
    block.resolvedAt !== null ||
    review.reviewItemId !== request.reviewItemId ||
    review.type !== "pending_expansion" ||
    review.state !== "open" ||
    review.noteId !== block.noteId ||
    review.captureId !== capture.captureId ||
    receipt.captureId !== capture.captureId ||
    receipt.reviewItemId !== request.reviewItemId ||
    receipt.destinationNoteId !== block.noteId ||
    receipt.decisionId !== block.decisionId ||
    receipt.sourcePrivacy !== "ai_assisted" ||
    capture.privacy !== "ai_assisted" ||
    capture.status !== "needs_review"
  ) {
    return projectionFailure();
  }
  const requestMacKey = parsePreparedKey(
    record.requestMacKey,
    { ownerId: request.ownerId, keyClass: "ai_assisted", purpose: "content_mac" },
    projectionFailure
  );
  const encryptedResponse = parseEncryptedResponse(
    record.encryptedResponse,
    request.ownerId,
    request.input.idempotencyKey,
    "ai_assisted",
    projectionFailure
  );
  const replayed = parsePendingPreparationReplay(
    record.completed,
    record.replayed,
    null,
    encryptedResponse,
    record.encryptedResponseVerificationMac,
    projectionFailure
  );
  const responseReservation = reservationForRole(reservations, "response");
  const reviewReservation = reservationForRole(reservations, "review");
  const receiptReservation = reservationForRole(reservations, "receipt");
  if (
    reservations.length !== 3 ||
    responseReservation?.resourceId !== `idempotency:${request.input.idempotencyKey}` ||
    responseReservation.recordVersion !== 1 ||
    responseReservation.keyClass !== "ai_assisted" ||
    reviewReservation?.resourceId !== request.reviewItemId ||
    reviewReservation.recordVersion !== review.recordVersion + 1 ||
    reviewReservation.keyClass !== "ai_assisted" ||
    receiptReservation?.resourceId !== receipt.captureId ||
    receiptReservation.recordVersion !== receipt.recordVersion + 1 ||
    receiptReservation.keyClass !== "ai_assisted"
  ) {
    return projectionFailure();
  }
  return Object.freeze({
    scope: "encrypted_review_resolution" as const,
    action,
    occurredAt,
    completed: false as const,
    replayed,
    requestMacKey,
    ids,
    source,
    members,
    reservations,
    encryptedResponse: null,
    encryptedResponseVerificationMac: null
  });
}

function nullableDate(value: unknown, failure: Failure): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return failure();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : failure();
}

function parseNoteState(
  value: unknown,
  expectedNoteId: EntityId<"note">,
  failure: Failure
): OwnerInteractionNoteState {
  const record = exactRecord(
    value,
    [
      "spaceId",
      "type",
      "dailyDate",
      "isOpen",
      "privacy",
      "pinnedAt",
      "archivedAt",
      "deletedAt",
      "tagIds",
      "links"
    ],
    failure
  );
  if (typeof record.isOpen !== "boolean") return failure();
  if (!Array.isArray(record.tagIds) || record.tagIds.length > 100) return failure();
  const tagIds = Object.freeze(record.tagIds.map((tag) => entityId(tag, "tag", failure)));
  if (new Set(tagIds).size !== tagIds.length) return failure();
  if (!Array.isArray(record.links) || record.links.length > 100) return failure();
  const links = Object.freeze(
    record.links.map((link) => {
      const parsed = NoteLinkValueSchema.safeParse(link);
      return parsed.success ? Object.freeze(parsed.data) : failure();
    })
  );
  const linkIdentities = links.map(({ toNoteId, linkType }) => `${toNoteId}:${linkType}`);
  if (
    links.some(({ toNoteId }) => toNoteId === expectedNoteId) ||
    new Set(linkIdentities).size !== linkIdentities.length
  ) {
    return failure();
  }
  return Object.freeze({
    spaceId: nullableEntityId(record.spaceId, "spc", failure),
    type: noteType(record.type, failure),
    dailyDate: nullableDate(record.dailyDate, failure),
    isOpen: record.isOpen,
    privacy: privacy(record.privacy, failure),
    pinnedAt: nullableTimestamp(record.pinnedAt, failure),
    archivedAt: nullableTimestamp(record.archivedAt, failure),
    deletedAt: nullableTimestamp(record.deletedAt, failure),
    tagIds,
    links
  });
}

function parseWriteCommand(
  value: unknown,
  ownerId: string,
  member: OwnerInteractionPreparedMember,
  reservations: readonly OwnerInteractionPreparedReservation[],
  failure: Failure
): OwnerInteractionWriteCommand {
  const record = exactRecord(
    value,
    [
      "ordinal",
      "noteId",
      "targetMutationId",
      "expectedRevision",
      "noteState",
      "noteCipher",
      "revision",
      "mutation",
      "verification"
    ],
    failure
  );
  const ordinal = nonnegativeInteger(record.ordinal, failure);
  const noteId = entityId(record.noteId, "note", failure);
  const targetMutationId = nullableEntityId(record.targetMutationId, "mut", failure);
  const expectedRevision = nonnegativeInteger(record.expectedRevision, failure);
  if (
    ordinal !== member.ordinal ||
    noteId !== member.noteId ||
    targetMutationId !== member.targetMutationId ||
    expectedRevision !== member.expectedRevision
  ) {
    return failure();
  }
  const afterRevision = expectedRevision + 1;
  const stickyClass: KeyClass =
    member.sourcePrivacy === "private_manual" || member.targetPrivacy === "private_manual"
      ? "private_manual"
      : "ai_assisted";
  const noteReservation = reservationByRole(reservations, `note_content:${ordinal}`);
  const revisionReservation = reservationByRole(reservations, `note_revision:${ordinal}`);
  const mutationReservation = reservationByRole(reservations, `note_mutation:${ordinal}`);
  const noteState = parseNoteState(record.noteState, noteId, failure);
  if (noteState.privacy !== member.targetPrivacy) return failure();
  const revisionRecord = exactRecord(
    record.revision,
    ["id", "source", "actor", "cipher", "mac"],
    failure
  );
  const revisionId = entityId(revisionRecord.id, "rev", failure);
  const actor = boundedString(revisionRecord.actor, 3, 200, failure);
  if (
    revisionId !== member.revisionId ||
    (revisionRecord.source !== "interactive" && revisionRecord.source !== "undo") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/u.test(actor)
  ) {
    return failure();
  }
  const mutationRecord = exactRecord(
    record.mutation,
    ["id", "undoTargetMutationId", "cipher"],
    failure
  );
  const mutationId = entityId(mutationRecord.id, "mut", failure);
  const undoTargetMutationId = nullableEntityId(
    mutationRecord.undoTargetMutationId,
    "mut",
    failure
  );
  if (
    mutationId !== member.mutationId ||
    undoTargetMutationId !== (member.role === "destination_write" ? null : member.targetMutationId)
  ) {
    return failure();
  }
  const verificationRecord = exactRecord(
    record.verification,
    ["noteContent", "noteMutation"],
    failure
  );
  return Object.freeze({
    ordinal,
    noteId,
    targetMutationId,
    expectedRevision,
    noteState,
    noteCipher: parseSealedCipher(
      record.noteCipher,
      {
        ownerId,
        resourceId: noteId,
        recordVersion: afterRevision,
        kind: "note_content",
        keyClass: member.targetPrivacy,
        reservationId: noteReservation.reservationId
      },
      failure
    ),
    revision: Object.freeze({
      id: revisionId,
      source: revisionRecord.source,
      actor,
      cipher: parseSealedCipher(
        revisionRecord.cipher,
        {
          ownerId,
          resourceId: revisionId,
          recordVersion: afterRevision,
          kind: "note_revision",
          keyClass: stickyClass,
          reservationId: revisionReservation.reservationId
        },
        failure
      ),
      mac: parseCommandMac(revisionRecord.mac, stickyClass, failure)
    }),
    mutation: Object.freeze({
      id: mutationId,
      undoTargetMutationId,
      cipher: parseSealedCipher(
        mutationRecord.cipher,
        {
          ownerId,
          resourceId: mutationId,
          recordVersion: afterRevision,
          kind: "note_mutation",
          keyClass: stickyClass,
          reservationId: mutationReservation.reservationId
        },
        failure
      )
    }),
    verification: Object.freeze({
      noteContent: parseCommandMac(verificationRecord.noteContent, member.targetPrivacy, failure),
      noteMutation: parseCommandMac(verificationRecord.noteMutation, stickyClass, failure)
    })
  });
}

function parseCommitCommand(
  value: unknown,
  input: Readonly<{
    ownerId: string;
    idempotencyKey: string;
    selectedOutcome: "applied" | "needs_review" | null;
    source: OwnerInteractionPreparedSource;
    cryptoMembers: readonly OwnerInteractionPreparedMember[];
    writeMembers: readonly OwnerInteractionPreparedMember[];
    reservations: readonly OwnerInteractionPreparedReservation[];
    reviewItemId: EntityId<"rvw"> | null;
    reviewType: ReviewType | null;
    reviewRecordVersion: number | null;
  }>,
  failure: Failure
): OwnerInteractionFullCommitCommand {
  const keys = [
    ...(input.selectedOutcome === null ? [] : ["selectedOutcome"]),
    "requestMac",
    "responseCipher",
    "responseVerificationMac",
    "writes",
    "receipt",
    "review"
  ];
  const record = exactRecord(value, keys, failure);
  if (input.selectedOutcome !== null && record.selectedOutcome !== input.selectedOutcome) {
    return failure();
  }
  const expectedClass = interactionKeyClass(input.cryptoMembers, input.source);
  const responseReservation = reservationByRole(input.reservations, "response");
  if (!Array.isArray(record.writes) || record.writes.length !== input.writeMembers.length) {
    return failure();
  }
  const writes = Object.freeze(
    record.writes.map((write, index) => {
      const member = input.writeMembers[index];
      return member === undefined
        ? failure()
        : parseWriteCommand(write, input.ownerId, member, input.reservations, failure);
    })
  );
  const receiptReservation = reservationForRole(input.reservations, "receipt");
  let receipt: OwnerInteractionFullCommitCommand["receipt"];
  if (receiptReservation === null) {
    if (record.receipt !== null) return failure();
    receipt = null;
  } else {
    if (input.source.receipt === null) return failure();
    const receiptRecord = exactRecord(
      record.receipt,
      ["recordVersion", "cipher", "verificationMac"],
      failure
    );
    const recordVersion = positiveInteger(receiptRecord.recordVersion, failure);
    if (
      recordVersion !== receiptReservation.recordVersion ||
      recordVersion !== input.source.receipt.recordVersion + 1
    ) {
      return failure();
    }
    receipt = Object.freeze({
      recordVersion,
      cipher: parseSealedCipher(
        receiptRecord.cipher,
        {
          ownerId: input.ownerId,
          resourceId: input.source.receipt.captureId,
          recordVersion,
          kind: "capture_receipt",
          keyClass: input.source.receipt.sourcePrivacy,
          reservationId: receiptReservation.reservationId
        },
        failure
      ),
      verificationMac: parseCommandMac(
        receiptRecord.verificationMac,
        input.source.receipt.sourcePrivacy,
        failure
      )
    });
  }
  const reviewReservation = reservationForRole(input.reservations, "review");
  let review: OwnerInteractionFullCommitCommand["review"];
  if (reviewReservation === null) {
    if (record.review !== null) return failure();
    review = null;
  } else {
    if (
      input.reviewItemId === null ||
      input.reviewType === null ||
      input.reviewRecordVersion === null
    ) {
      return failure();
    }
    const reviewRecord = exactRecord(
      record.review,
      ["reviewItemId", "recordVersion", "type", "cipher", "verificationMac"],
      failure
    );
    const reviewItemId = entityId(reviewRecord.reviewItemId, "rvw", failure);
    const recordVersion = positiveInteger(reviewRecord.recordVersion, failure);
    const parsedType = ReviewTypeSchema.safeParse(reviewRecord.type);
    if (
      reviewItemId !== input.reviewItemId ||
      recordVersion !== input.reviewRecordVersion ||
      !parsedType.success ||
      parsedType.data !== input.reviewType ||
      recordVersion !== reviewReservation.recordVersion
    ) {
      return failure();
    }
    review = Object.freeze({
      reviewItemId,
      recordVersion,
      type: parsedType.data,
      cipher: parseSealedCipher(
        reviewRecord.cipher,
        {
          ownerId: input.ownerId,
          resourceId: reviewItemId,
          recordVersion,
          kind: "review_item",
          keyClass: reviewReservation.keyClass,
          reservationId: reviewReservation.reservationId
        },
        failure
      ),
      verificationMac: parseCommandMac(
        reviewRecord.verificationMac,
        reviewReservation.keyClass,
        failure
      )
    });
  }
  return Object.freeze({
    ...(input.selectedOutcome === null ? {} : { selectedOutcome: input.selectedOutcome }),
    requestMac: parseCommandMac(record.requestMac, expectedClass, failure),
    responseCipher: parseSealedCipher(
      record.responseCipher,
      {
        ownerId: input.ownerId,
        resourceId: `idempotency:${input.idempotencyKey}`,
        recordVersion: 1,
        kind: "idempotency_response",
        keyClass: expectedClass,
        reservationId: responseReservation.reservationId
      },
      failure
    ),
    responseVerificationMac: parseCommandMac(
      record.responseVerificationMac,
      expectedClass,
      failure
    ),
    writes,
    receipt,
    review
  });
}

function parseCommitResultMember(
  value: unknown,
  failure: Failure
): OwnerInteractionCommitResult["members"][number] {
  const record = exactRecord(
    value,
    ["role", "noteId", "currentRevision", "revisionId", "mutationId"],
    failure
  );
  return Object.freeze({
    role: memberRole(record.role, failure),
    noteId: entityId(record.noteId, "note", failure),
    currentRevision: positiveInteger(record.currentRevision, failure),
    revisionId: entityId(record.revisionId, "rev", failure),
    mutationId: entityId(record.mutationId, "mut", failure)
  });
}

type CommitMemberExpectation =
  | Readonly<{
      kind: "exact";
      members: readonly OwnerInteractionPreparedMember[];
    }>
  | Readonly<{
      kind: "fixed";
      members: readonly Readonly<{
        role: OwnerInteractionMemberRole;
        noteId: EntityId<"note">;
        revisionId?: EntityId<"rev">;
        mutationId?: EntityId<"mut">;
      }>[];
    }>
  | Readonly<{
      kind: "batch_replay";
      maximum: number;
      minimum: number;
    }>;

function parseCommitResult(
  value: unknown,
  input: Readonly<{
    ownerId: string;
    idempotencyKey: string;
    scope: OwnerInteractionCommitResult["scope"];
    outcome: OwnerInteractionCommitResult["outcome"];
    decisionId: EntityId<"dec"> | null;
    reviewItemId: EntityId<"rvw"> | null;
    feedbackEventId: EntityId<"fbk"> | null;
    batchId: string | null;
    expectedClass: KeyClass;
    memberExpectation: CommitMemberExpectation;
  }>,
  failure: Failure
): OwnerInteractionCommitResult {
  const record = exactRecord(
    value,
    [
      "scope",
      "outcome",
      "decisionId",
      "reviewItemId",
      "feedbackEventId",
      "batchId",
      "members",
      "encryptedResponse",
      "responseVerificationMac",
      "replayed"
    ],
    failure
  );
  if (
    record.scope !== input.scope ||
    record.outcome !== input.outcome ||
    typeof record.replayed !== "boolean"
  ) {
    return failure();
  }
  const decisionId = nullableEntityId(record.decisionId, "dec", failure);
  const reviewItemId = nullableEntityId(record.reviewItemId, "rvw", failure);
  const feedbackEventId = nullableEntityId(record.feedbackEventId, "fbk", failure);
  const batchId = record.batchId === null ? null : canonicalUuid(record.batchId, failure);
  if (
    decisionId !== input.decisionId ||
    reviewItemId !== input.reviewItemId ||
    feedbackEventId !== input.feedbackEventId ||
    batchId !== input.batchId ||
    !Array.isArray(record.members)
  ) {
    return failure();
  }
  const members = Object.freeze(
    record.members.map((member) => parseCommitResultMember(member, failure))
  );
  const noteIds = new Set<string>();
  const revisionIds = new Set<string>();
  const mutationIds = new Set<string>();
  for (const member of members) {
    if (
      noteIds.has(member.noteId) ||
      revisionIds.has(member.revisionId) ||
      mutationIds.has(member.mutationId)
    ) {
      return failure();
    }
    noteIds.add(member.noteId);
    revisionIds.add(member.revisionId);
    mutationIds.add(member.mutationId);
  }
  if (input.scope === "encrypted_mutation_batch_undo" && input.outcome === "applied") {
    let previousNoteId: string | null = null;
    for (const member of members) {
      if (previousNoteId !== null && previousNoteId >= member.noteId) return failure();
      previousNoteId = member.noteId;
    }
  }
  if (input.memberExpectation.kind === "batch_replay") {
    if (
      members.length < input.memberExpectation.minimum ||
      members.length > input.memberExpectation.maximum ||
      members.some(({ role }) => role !== "undo")
    ) {
      return failure();
    }
  } else if (input.memberExpectation.kind === "exact") {
    const expectedMembers = input.memberExpectation.members;
    if (members.length !== expectedMembers.length) return failure();
    for (const [index, member] of members.entries()) {
      const expected = expectedMembers[index];
      if (
        expected?.role !== member.role ||
        member.noteId !== expected.noteId ||
        member.currentRevision !== expected.expectedRevision + 1 ||
        member.revisionId !== expected.revisionId ||
        member.mutationId !== expected.mutationId
      ) {
        return failure();
      }
    }
  } else {
    const expectedMembers = input.memberExpectation.members;
    if (members.length !== expectedMembers.length) return failure();
    for (const [index, member] of members.entries()) {
      const expected = expectedMembers[index];
      if (
        expected?.role !== member.role ||
        member.noteId !== expected.noteId ||
        (expected.revisionId !== undefined && member.revisionId !== expected.revisionId) ||
        (expected.mutationId !== undefined && member.mutationId !== expected.mutationId)
      ) {
        return failure();
      }
    }
  }
  return Object.freeze({
    scope: input.scope,
    outcome: input.outcome,
    decisionId,
    reviewItemId,
    feedbackEventId,
    batchId,
    members,
    encryptedResponse: parseStoredCipher(
      record.encryptedResponse,
      {
        ownerId: input.ownerId,
        resourceId: `idempotency:${input.idempotencyKey}`,
        recordVersion: 1,
        kind: "idempotency_response",
        keyClass: input.expectedClass
      },
      failure
    ),
    responseVerificationMac: parseStoredMac(
      record.responseVerificationMac,
      input.expectedClass,
      failure
    ),
    replayed: record.replayed
  });
}

function parseGeneratedBlockResolutionCommitResult(
  value: unknown,
  input: Readonly<{
    ownerId: string;
    blockId: EntityId<"blk">;
    reviewItemId: EntityId<"rvw">;
    idempotencyKey: string;
    expectedStateRevision: number;
    resolution: GeneratedBlockResolveRequest["resolution"];
  }>,
  failure: Failure
): GeneratedBlockResolutionCommitResult {
  const record = exactRecord(
    value,
    [
      "scope",
      "outcome",
      "decisionId",
      "reviewItemId",
      "feedbackEventId",
      "batchId",
      "members",
      "encryptedResponse",
      "responseVerificationMac",
      "replayed",
      "generatedBlockId",
      "stateRevision"
    ],
    failure
  );
  const expectedOutcome = input.resolution === "accept" ? "accepted" : "rejected";
  const reviewItemId = entityId(record.reviewItemId, "rvw", failure);
  const feedbackEventId = entityId(record.feedbackEventId, "fbk", failure);
  const generatedBlockId = entityId(record.generatedBlockId, "blk", failure);
  const stateRevision = positiveInteger(record.stateRevision, failure);
  if (
    record.scope !== "encrypted_review_resolution" ||
    record.outcome !== expectedOutcome ||
    record.decisionId !== null ||
    reviewItemId !== input.reviewItemId ||
    record.batchId !== null ||
    !Array.isArray(record.members) ||
    record.members.length !== 0 ||
    typeof record.replayed !== "boolean" ||
    generatedBlockId !== input.blockId ||
    stateRevision !== input.expectedStateRevision + 1
  ) {
    return failure();
  }
  return Object.freeze({
    scope: "encrypted_review_resolution" as const,
    outcome: expectedOutcome,
    decisionId: null,
    reviewItemId,
    feedbackEventId,
    batchId: null,
    members: Object.freeze([]),
    encryptedResponse: parseStoredCipher(
      record.encryptedResponse,
      {
        ownerId: input.ownerId,
        resourceId: `idempotency:${input.idempotencyKey}`,
        recordVersion: 1,
        kind: "idempotency_response",
        keyClass: "ai_assisted"
      },
      failure
    ),
    responseVerificationMac: parseStoredMac(record.responseVerificationMac, "ai_assisted", failure),
    replayed: record.replayed,
    generatedBlockId,
    stateRevision
  });
}

function correctionResultExpectation(
  preparation: PrepareDecisionCorrectionResult,
  selected: "applied" | "needs_review"
) {
  if (selected === "applied") {
    if (
      !preparation.branches.applied.available ||
      preparation.branches.applied.feedbackEventId === null ||
      preparation.branches.applied.batchId === null
    ) {
      return projectionFailure();
    }
    return Object.freeze({
      outcome: "applied" as const,
      decisionId: preparation.ids.decisionId,
      reviewItemId: null,
      feedbackEventId: preparation.branches.applied.feedbackEventId,
      batchId: preparation.branches.applied.batchId,
      writeMembers: preparation.members,
      memberExpectation: preparation.completed
        ? ({
            kind: "fixed",
            members: Object.freeze([
              Object.freeze({
                role: "source_removal" as const,
                noteId: preparation.ids.sourceNoteId
              }),
              Object.freeze({
                role: "destination_write" as const,
                noteId: preparation.ids.destinationNoteId
              })
            ])
          } satisfies CommitMemberExpectation)
        : ({ kind: "exact", members: preparation.members } satisfies CommitMemberExpectation)
    });
  }
  if (
    !preparation.branches.needsReview.available ||
    preparation.branches.needsReview.reviewItemId === null
  ) {
    return projectionFailure();
  }
  return Object.freeze({
    outcome: "needs_review" as const,
    decisionId: preparation.ids.decisionId,
    reviewItemId: preparation.branches.needsReview.reviewItemId,
    feedbackEventId: null,
    batchId: null,
    writeMembers: Object.freeze([]),
    memberExpectation: {
      kind: "fixed",
      members: Object.freeze([])
    } satisfies CommitMemberExpectation
  });
}

function batchResultExpectation(
  preparation: PrepareMutationBatchUndoResult,
  selected: "applied" | "needs_review"
) {
  if (selected === "applied") {
    if (!preparation.branches.applied.available || preparation.branches.applied.batchId === null) {
      return projectionFailure();
    }
    return Object.freeze({
      outcome: "applied" as const,
      decisionId: null,
      reviewItemId: null,
      feedbackEventId: null,
      batchId: preparation.branches.applied.batchId,
      writeMembers: preparation.members,
      memberExpectation: preparation.completed
        ? ({
            kind: "batch_replay",
            minimum: 1,
            maximum: MAX_BATCH_MEMBERS
          } satisfies CommitMemberExpectation)
        : ({ kind: "exact", members: preparation.members } satisfies CommitMemberExpectation)
    });
  }
  if (
    !preparation.branches.needsReview.available ||
    preparation.branches.needsReview.reviewItemId === null
  ) {
    return projectionFailure();
  }
  return Object.freeze({
    outcome: "needs_review" as const,
    decisionId: null,
    reviewItemId: preparation.branches.needsReview.reviewItemId,
    feedbackEventId: null,
    batchId: null,
    writeMembers: Object.freeze([]),
    memberExpectation: {
      kind: "fixed",
      members: Object.freeze([])
    } satisfies CommitMemberExpectation
  });
}

function parseReplayCommand(
  value: unknown,
  selected: "applied" | "needs_review" | null,
  expectedClass: KeyClass,
  failure: Failure
): OwnerInteractionReplayCommand {
  const record = exactRecord(
    value,
    selected === null ? ["requestMac"] : ["selectedOutcome", "requestMac"],
    failure
  );
  if (selected !== null && record.selectedOutcome !== selected) return failure();
  return Object.freeze({
    ...(selected === null ? {} : { selectedOutcome: selected }),
    requestMac: parseCommandMac(record.requestMac, expectedClass, failure)
  });
}

function parseOwnerInteractionInput(value: unknown, keys: readonly string[]): UnknownRecord {
  return exactRecord(value, keys, inputFailure);
}

export function createEncryptedOwnerInteractionRpcAdapter(
  client: ServiceRpcClient
): EncryptedOwnerInteractionRpcAdapter {
  return Object.freeze({
    async prepareDecisionCorrection(input) {
      const requestRecord = parseOwnerInteractionInput(input, ["ownerId", "decisionId", "request"]);
      const ownerId = canonicalOwnerId(requestRecord.ownerId, inputFailure);
      const decisionId = entityId(requestRecord.decisionId, "dec", inputFailure);
      const parsed = DecisionCorrectionRequestSchema.safeParse(requestRecord.request);
      if (!parsed.success) return inputFailure();
      const request = parsed.data;
      const structuralDestination =
        request.destination.type === "existing_note"
          ? Object.freeze({
              type: "existing_note" as const,
              noteId: request.destination.noteId,
              expectedRevision: request.destination.expectedRevision
            })
          : Object.freeze({
              type: "new_note" as const,
              noteType: request.destination.noteType,
              spaceId: request.destination.spaceId
            });
      return parseDecisionCorrectionPreparation(
        await client.rpc("prepare_encrypted_decision_correction", {
          p_owner_id: ownerId,
          p_decision_id: decisionId,
          p_idempotency_key: request.idempotencyKey,
          p_request: {
            source: request.source,
            destination: structuralDestination
          }
        }),
        { ownerId, decisionId, input: request }
      );
    },

    async commitDecisionCorrection(input) {
      projectionDiagnostic("correction.commit-input");
      const requestRecord = parseOwnerInteractionInput(input, [
        "ownerId",
        "decisionId",
        "idempotencyKey",
        "preparation",
        "command"
      ]);
      const ownerId = canonicalOwnerId(requestRecord.ownerId, inputFailure);
      const decisionId = entityId(requestRecord.decisionId, "dec", inputFailure);
      const key = idempotencyKey(requestRecord.idempotencyKey, inputFailure);
      const preparation = requestRecord.preparation as PrepareDecisionCorrectionResult;
      if (preparation.ids.decisionId !== decisionId) {
        return inputFailure();
      }
      const commandRecord = isRecord(requestRecord.command)
        ? requestRecord.command
        : inputFailure();
      const selected = selectedOutcome(commandRecord.selectedOutcome, inputFailure);
      if (selected === null) return inputFailure();
      const expectation = correctionResultExpectation(preparation, selected);
      const branchReservations =
        selected === "applied"
          ? preparation.branches.applied.reservations
          : preparation.branches.needsReview.reservations;
      const reservations = Object.freeze([
        ...preparation.commonReservations,
        ...branchReservations
      ]);
      const expectedClass = preparation.completed
        ? preparation.requestMacKey.keyClass
        : interactionKeyClass(preparation.members, preparation.source);
      const parsedCommand = preparation.completed
        ? parseReplayCommand(requestRecord.command, selected, expectedClass, inputFailure)
        : parseCommitCommand(
            requestRecord.command,
            {
              ownerId,
              idempotencyKey: key,
              selectedOutcome: selected,
              source: preparation.source,
              cryptoMembers: preparation.members,
              writeMembers: expectation.writeMembers,
              reservations,
              reviewItemId: expectation.reviewItemId,
              reviewType: selected === "needs_review" ? "revision_conflict" : null,
              reviewRecordVersion: selected === "needs_review" ? 1 : null
            },
            inputFailure
          );
      projectionDiagnostic(
        preparation.completed ? "correction.commit-replay-command" : "correction.commit-command"
      );
      if (preparation.completed && preparation.selectedOutcome !== selected) return inputFailure();
      const rawResult = await client.rpc("commit_encrypted_decision_correction", {
        p_owner_id: ownerId,
        p_decision_id: decisionId,
        p_idempotency_key: key,
        p_command: parsedCommand
      });
      projectionDiagnostic("correction.commit-rpc-returned");
      const result = parseCommitResult(
        rawResult,
        {
          ownerId,
          idempotencyKey: key,
          scope: "encrypted_decision_correction",
          ...expectation,
          expectedClass
        },
        projectionFailure
      );
      projectionDiagnostic("correction.commit-result");
      return result;
    },

    async prepareReviewResolution(input) {
      const requestRecord = parseOwnerInteractionInput(input, [
        "ownerId",
        "reviewItemId",
        "request"
      ]);
      const ownerId = canonicalOwnerId(requestRecord.ownerId, inputFailure);
      const reviewItemId = entityId(requestRecord.reviewItemId, "rvw", inputFailure);
      const parsed = ReviewResolveRequestSchema.safeParse(requestRecord.request);
      if (!parsed.success) return inputFailure();
      const request = parsed.data;
      const structuralResolution =
        request.resolution.type === "create"
          ? Object.freeze({
              type: "create" as const,
              noteType: request.resolution.noteType,
              spaceId: request.resolution.spaceId
            })
          : request.resolution;
      return parseReviewResolutionPreparation(
        await client.rpc("prepare_encrypted_review_resolution", {
          p_owner_id: ownerId,
          p_review_item_id: reviewItemId,
          p_idempotency_key: request.idempotencyKey,
          p_resolution: structuralResolution
        }),
        { ownerId, reviewItemId, input: request }
      );
    },

    async commitReviewResolution(input) {
      const requestRecord = parseOwnerInteractionInput(input, [
        "ownerId",
        "reviewItemId",
        "idempotencyKey",
        "preparation",
        "command"
      ]);
      const ownerId = canonicalOwnerId(requestRecord.ownerId, inputFailure);
      const reviewItemId = entityId(requestRecord.reviewItemId, "rvw", inputFailure);
      const key = idempotencyKey(requestRecord.idempotencyKey, inputFailure);
      const preparation = requestRecord.preparation as PrepareReviewResolutionResult;
      const sourceReview = preparation.completed ? null : preparation.source.review;
      if (
        preparation.ids.reviewItemId !== reviewItemId ||
        (!preparation.completed && sourceReview === null)
      ) {
        return inputFailure();
      }
      const expectedClass = preparation.completed
        ? preparation.requestMacKey.keyClass
        : interactionKeyClass(preparation.members, preparation.source);
      const parsedCommand = preparation.completed
        ? parseReplayCommand(requestRecord.command, null, expectedClass, inputFailure)
        : parseCommitCommand(
            requestRecord.command,
            {
              ownerId,
              idempotencyKey: key,
              selectedOutcome: null,
              source: preparation.source,
              cryptoMembers: preparation.members,
              writeMembers: preparation.members,
              reservations: preparation.reservations,
              reviewItemId,
              reviewType: sourceReview?.type ?? inputFailure(),
              reviewRecordVersion: (sourceReview?.recordVersion ?? inputFailure()) + 1
            },
            inputFailure
          );
      const outcome = preparation.action === "dismiss" ? "dismissed" : "resolved";
      const memberExpectation: CommitMemberExpectation = preparation.completed
        ? preparation.action === "route" || preparation.action === "create"
          ? {
              kind: "fixed",
              members: Object.freeze([
                Object.freeze({
                  role: "destination_write",
                  noteId: preparation.ids.destinationNoteId ?? inputFailure(),
                  revisionId: preparation.ids.destinationRevisionId ?? inputFailure(),
                  mutationId: preparation.ids.destinationMutationId ?? inputFailure()
                })
              ])
            }
          : { kind: "fixed", members: Object.freeze([]) }
        : { kind: "exact", members: preparation.members };
      return parseCommitResult(
        await client.rpc("commit_encrypted_review_resolution", {
          p_owner_id: ownerId,
          p_review_item_id: reviewItemId,
          p_idempotency_key: key,
          p_command: parsedCommand
        }),
        {
          ownerId,
          idempotencyKey: key,
          scope: "encrypted_review_resolution",
          outcome,
          decisionId: null,
          reviewItemId,
          feedbackEventId: null,
          batchId: null,
          expectedClass,
          memberExpectation
        },
        projectionFailure
      );
    },

    async prepareGeneratedBlockResolution(input) {
      const requestRecord = parseOwnerInteractionInput(input, [
        "ownerId",
        "blockId",
        "reviewItemId",
        "request"
      ]);
      const ownerId = canonicalOwnerId(requestRecord.ownerId, inputFailure);
      const blockId = entityId(requestRecord.blockId, "blk", inputFailure);
      const reviewItemId = entityId(requestRecord.reviewItemId, "rvw", inputFailure);
      const parsed = GeneratedBlockResolveRequestSchema.safeParse(requestRecord.request);
      if (!parsed.success) return inputFailure();
      const request = parsed.data;
      return parseGeneratedBlockResolutionPreparation(
        await client.rpc("prepare_encrypted_review_resolution", {
          p_owner_id: ownerId,
          p_review_item_id: reviewItemId,
          p_idempotency_key: request.idempotencyKey,
          p_resolution: {
            type: generatedResolutionAction(request.resolution),
            generatedBlockId: blockId,
            expectedStateRevision: request.expectedStateRevision
          }
        }),
        { ownerId, blockId, reviewItemId, input: request }
      );
    },

    async commitGeneratedBlockResolution(input) {
      const requestRecord = parseOwnerInteractionInput(input, [
        "ownerId",
        "blockId",
        "request",
        "preparation",
        "command"
      ]);
      const ownerId = canonicalOwnerId(requestRecord.ownerId, inputFailure);
      const blockId = entityId(requestRecord.blockId, "blk", inputFailure);
      const requestParsed = GeneratedBlockResolveRequestSchema.safeParse(requestRecord.request);
      if (!requestParsed.success) return inputFailure();
      const request = requestParsed.data;
      const preparation = requestRecord.preparation as PrepareGeneratedBlockResolutionResult;
      const reviewItemId = preparation.ids.reviewItemId;
      const sourceReview = preparation.completed ? null : preparation.source.review;
      if (
        preparation.ids.generatedBlockId !== blockId ||
        preparation.ids.stateRevision !== request.expectedStateRevision ||
        preparation.action !== generatedResolutionAction(request.resolution) ||
        (!preparation.completed && sourceReview === null)
      ) {
        return inputFailure();
      }
      const expectedClass = preparation.completed
        ? preparation.requestMacKey.keyClass
        : interactionKeyClass(preparation.members, preparation.source);
      if (expectedClass !== "ai_assisted") return inputFailure();
      const parsedCommand = preparation.completed
        ? parseReplayCommand(requestRecord.command, null, expectedClass, inputFailure)
        : parseCommitCommand(
            requestRecord.command,
            {
              ownerId,
              idempotencyKey: request.idempotencyKey,
              selectedOutcome: null,
              source: preparation.source,
              cryptoMembers: preparation.members,
              writeMembers: Object.freeze([]),
              reservations: preparation.reservations,
              reviewItemId,
              reviewType: "pending_expansion",
              reviewRecordVersion: (sourceReview?.recordVersion ?? inputFailure()) + 1
            },
            inputFailure
          );
      return parseGeneratedBlockResolutionCommitResult(
        await client.rpc("resolve_encrypted_generated_block", {
          p_owner_id: ownerId,
          p_generated_block_id: blockId,
          p_expected_state_revision: request.expectedStateRevision,
          p_idempotency_key: request.idempotencyKey,
          p_command: parsedCommand
        }),
        {
          ownerId,
          blockId,
          reviewItemId,
          idempotencyKey: request.idempotencyKey,
          expectedStateRevision: request.expectedStateRevision,
          resolution: request.resolution
        },
        projectionFailure
      );
    },

    async getMutationBatch(input) {
      const requestRecord = parseOwnerInteractionInput(input, ["ownerId", "mutationId", "request"]);
      const ownerId = canonicalOwnerId(requestRecord.ownerId, inputFailure);
      const mutationId = entityId(requestRecord.mutationId, "mut", inputFailure);
      const parsed = MutationUndoRequestSchema.safeParse(requestRecord.request);
      if (!parsed.success) return inputFailure();
      const request = parsed.data;
      return parseMutationBatchPreparation(
        await client.rpc("get_encrypted_mutation_batch", {
          p_owner_id: ownerId,
          p_mutation_id: mutationId,
          p_expected_revision: request.expectedRevision,
          p_idempotency_key: request.idempotencyKey
        }),
        { ownerId, mutationId, input: request }
      );
    },

    async undoMutationBatch(input) {
      const requestRecord = parseOwnerInteractionInput(input, [
        "ownerId",
        "mutationId",
        "request",
        "preparation",
        "command"
      ]);
      const ownerId = canonicalOwnerId(requestRecord.ownerId, inputFailure);
      const mutationId = entityId(requestRecord.mutationId, "mut", inputFailure);
      const requestParsed = MutationUndoRequestSchema.safeParse(requestRecord.request);
      if (!requestParsed.success) return inputFailure();
      const request = requestParsed.data;
      const preparation = requestRecord.preparation as PrepareMutationBatchUndoResult;
      if (preparation.ids.anchorMutationId !== mutationId) {
        return inputFailure();
      }
      const commandRecord = isRecord(requestRecord.command)
        ? requestRecord.command
        : inputFailure();
      const selected = selectedOutcome(commandRecord.selectedOutcome, inputFailure);
      if (selected === null) return inputFailure();
      const expectation = batchResultExpectation(preparation, selected);
      const branchReservations =
        selected === "applied"
          ? preparation.branches.applied.reservations
          : preparation.branches.needsReview.reservations;
      const reservations = Object.freeze([
        ...preparation.commonReservations,
        ...branchReservations
      ]);
      const expectedClass = preparation.completed
        ? preparation.requestMacKey.keyClass
        : interactionKeyClass(preparation.members, preparation.source);
      const parsedCommand = preparation.completed
        ? parseReplayCommand(requestRecord.command, selected, expectedClass, inputFailure)
        : parseCommitCommand(
            requestRecord.command,
            {
              ownerId,
              idempotencyKey: request.idempotencyKey,
              selectedOutcome: selected,
              source: preparation.source,
              cryptoMembers: preparation.members,
              writeMembers: expectation.writeMembers,
              reservations,
              reviewItemId: expectation.reviewItemId,
              reviewType: selected === "needs_review" ? "revision_conflict" : null,
              reviewRecordVersion: selected === "needs_review" ? 1 : null
            },
            inputFailure
          );
      if (preparation.completed && preparation.selectedOutcome !== selected) return inputFailure();
      return parseCommitResult(
        await client.rpc("undo_encrypted_mutation_batch", {
          p_owner_id: ownerId,
          p_mutation_id: mutationId,
          p_expected_revision: request.expectedRevision,
          p_idempotency_key: request.idempotencyKey,
          p_command: parsedCommand
        }),
        {
          ownerId,
          idempotencyKey: request.idempotencyKey,
          scope: "encrypted_mutation_batch_undo",
          ...expectation,
          expectedClass
        },
        projectionFailure
      );
    }
  });
}
