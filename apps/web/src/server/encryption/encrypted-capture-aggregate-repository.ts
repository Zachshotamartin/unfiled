import {
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  CaptureDeleteRequestSchema,
  CaptureDeleteResponseSchema,
  CaptureDetailResponseSchema,
  CaptureListQuerySchema,
  CaptureListResponseSchema,
  CaptureReceiptResponseSchema,
  CaptureReceiptSchema,
  CaptureRetryRequestSchema,
  CaptureRetryResponseSchema,
  NoteSnapshotSchema,
  createEntityId,
  entityIdSchema,
  parseEntityId,
  type Capture,
  type CaptureCreateResponse,
  type CaptureDeleteResponse,
  type CaptureDetailResponse,
  type CaptureListQuery,
  type CaptureListResponse,
  type CaptureReceipt,
  type CaptureReceiptContent,
  type CaptureReceiptResponse,
  type CaptureRetryResponse,
  type CaptureSummary,
  type EntityId,
  type NoteSnapshot,
  type RoutingRuleMatchSnapshot
} from "@unfiled/contracts";
import {
  applyNoteOperations,
  undoNoteMutation,
  type EntityIdFactory,
  type Note,
  type NoteMutation
} from "@unfiled/domain";
import {
  CapturePayloadSchema,
  CaptureReceiptPayloadSchema,
  MAX_CAPTURE_RECEIPT_UNDO_TARGETS,
  NoteContentPayloadSchema,
  NoteMutationPayloadSchema,
  NoteRevisionPayloadSchema,
  encryptedFieldForRpc,
  keyedMacForRpc,
  type AggregateContentKind,
  type AuthorizedOwnerAccess,
  type CaptureReceiptPayload,
  type EncryptedAggregateService,
  type EncryptedIdempotencyRecord,
  type EncryptedAggregateRecord,
  type EncryptedFieldRpcValue,
  type KeyedMacRecord,
  type KeyedMacRpcValue,
  type LogicalApiRequest,
  type NoteContentPayload,
  type NoteMutationPayload,
  type PayloadCodec,
  type PrivacyTransition,
  type CaptureReceiptUndoTarget
} from "@unfiled/encrypted-aggregate";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type {
  CaptureRepository,
  CaptureRepositoryContext,
  NormalizedCaptureCreateInput,
  NormalizedCaptureDeleteInput
} from "@/server/captures/repository";

import {
  encryptedCaptureTimestampMicros,
  type EncryptedCaptureDetailRead,
  type EncryptedCaptureCommandScope,
  type EncryptedCaptureRead,
  type EncryptedCaptureReceiptRead,
  type EncryptedCaptureRpcAdapter,
  type EncryptedCaptureUndoWriteCommand,
  type StoredEncryptedFieldRpcValue
} from "./encrypted-capture-rpc-adapter";
import type {
  EncryptedNoteMutationRead,
  EncryptedNoteReadRpcAdapter
} from "./encrypted-note-read-rpc-adapter";
import {
  encryptedOnlyMutationProjection,
  encryptedOnlyNoteState
} from "./encrypted-note-command-projection";
import {
  generatedExpansionReceiptProjectionMatches,
  reviewReceiptProjectionMatches
} from "./encrypted-receipt-projection";
import {
  ServiceRpcError,
  ServiceRpcErrorCode,
  throwIfServiceOperationAborted
} from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEVICE_ID_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._:-]{0,119})$/u;
const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,3})$/u;
const MAX_CAPTURE_SCAN = 10_000;
const READ_BATCH_SIZE = 100;
const GENERATED_BLOCK_BATCH_SIZE = 100;
const MAX_CAPTURE_UNDO_PLAINTEXT_BYTES = 1_000_000;
const ENCRYPTED_ORGANIZER_REASON_SENTINEL = "encrypted_organizer";

function captureAggregateDiagnostic(stage: string): void {
  if (process.env.UNFILED_E1_HTTP_DIAGNOSTICS === "1") {
    process.stderr.write(`[unfiled-e1-capture-aggregate] ${stage}\n`);
  }
}

const RetryIntentSchema = z.strictObject({ action: z.literal("retry") });
const DeleteExpectedNoteRevisionsSchema = z
  .array(
    z.strictObject({
      noteId: entityIdSchema("note"),
      expectedRevision: z.number().int().positive()
    })
  )
  .max(MAX_CAPTURE_RECEIPT_UNDO_TARGETS);
const DeleteIntentSchema = z.discriminatedUnion("removeInsertedContent", [
  z.strictObject({
    action: z.literal("delete"),
    removeInsertedContent: z.literal(false),
    expectedNoteRevisions: z.tuple([])
  }),
  z.strictObject({
    action: z.literal("delete"),
    removeInsertedContent: z.literal(true),
    expectedNoteRevisions: DeleteExpectedNoteRevisionsSchema.min(1)
  })
]);

type RetryIntent = z.infer<typeof RetryIntentSchema>;
type DeleteIntent = z.infer<typeof DeleteIntentSchema>;

export const EncryptedCaptureUnavailableOperation = Object.freeze({
  DELETE: "delete",
  RETRY: "retry"
} as const);

export type EncryptedCaptureUnavailableOperationValue =
  (typeof EncryptedCaptureUnavailableOperation)[keyof typeof EncryptedCaptureUnavailableOperation];

export class EncryptedCaptureOperationUnavailableError extends Error {
  public readonly code = "encrypted_capture_operation_unavailable" as const;

  public constructor(public readonly operation: EncryptedCaptureUnavailableOperationValue) {
    super("That encrypted capture operation is not available yet");
    this.name = "EncryptedCaptureOperationUnavailableError";
  }
}

export type EncryptedCaptureAggregateRepositoryDependencies = Readonly<{
  ownerId: string;
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  adapter: EncryptedCaptureRpcAdapter;
  noteReads: EncryptedNoteReadRpcAdapter;
  routingRules?: Readonly<{
    match(captureText: string): Promise<RoutingRuleMatchSnapshot | null>;
  }>;
  signal?: AbortSignal;
  createJobId?: () => EntityId<"job">;
  now?: () => Date;
}>;

type OpenedCapture = Readonly<{
  row: EncryptedCaptureRead;
  rawContent: string;
}>;

type EncryptedCaptureCommandCrypto = Readonly<{
  requestMac: KeyedMacRecord;
  responseCipher: Awaited<ReturnType<EncryptedAggregateService["sealIdempotencyResponse"]>>;
  responseVerificationMac: KeyedMacRecord;
}>;

type PreparedCaptureUndoWrite = Readonly<{
  command: EncryptedCaptureUndoWriteCommand;
  plaintextBytes: number;
}>;

type ContractSchema<Value> = Readonly<{
  safeParse(
    value: unknown
  ): Readonly<{ success: true; data: Value }> | Readonly<{ success: false }>;
}>;

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function invalidIdempotency(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY);
}

function contract<Value>(schema: ContractSchema<Value>, value: unknown): Value {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : unavailable();
}

function exactOwnerId(value: string, failure: () => never): string {
  if (!UUID_PATTERN.test(value)) return failure();
  return value.toLowerCase();
}

function assertEntity<Kind extends "cap" | "job">(
  value: string,
  kind: Kind,
  failure: () => never
): EntityId<Kind> {
  try {
    parseEntityId(value, kind);
  } catch {
    return failure();
  }
  return value as EntityId<Kind>;
}

function sameInstant(left: string, right: string): boolean {
  return (
    encryptedCaptureTimestampMicros(left, invalidInput) ===
    encryptedCaptureTimestampMicros(right, invalidInput)
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseCreateInput(input: NormalizedCaptureCreateInput): NormalizedCaptureCreateInput {
  const parsed = CaptureCreateRequestSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  const deviceId = parsed.data.deviceId ?? "";
  if (
    !DEVICE_ID_PATTERN.test(deviceId) ||
    parsed.data.clientTimezone.length > 64 ||
    !TIMEZONE_PATTERN.test(parsed.data.clientTimezone)
  )
    return invalidInput();
  encryptedCaptureTimestampMicros(parsed.data.clientCreatedAt, invalidInput);
  return Object.freeze({
    clientCaptureId: parsed.data.clientCaptureId,
    rawContent: parsed.data.rawContent,
    source: parsed.data.source,
    ...(parsed.data.deviceId === undefined ? {} : { deviceId: parsed.data.deviceId }),
    clientCreatedAt: parsed.data.clientCreatedAt,
    clientTimezone: parsed.data.clientTimezone,
    privacy: parsed.data.privacy,
    ...(parsed.data.explicitDestinationNoteId === undefined
      ? {}
      : { explicitDestinationNoteId: parsed.data.explicitDestinationNoteId }),
    expansionDisabled: parsed.data.expansionDisabled
  });
}

function decodeCursor(value: string | undefined): Readonly<{
  receivedAt: string;
  captureId: EntityId<"cap">;
}> | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 512) return invalidInput();
  let decoded: string;
  try {
    const buffer = Buffer.from(value, "base64");
    if (buffer.toString("base64") !== value) return invalidInput();
    decoded = buffer.toString("utf8");
  } catch {
    return invalidInput();
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(decoded) as unknown;
  } catch {
    return invalidInput();
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return invalidInput();
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "id" ||
    keys[1] !== "receivedAt" ||
    typeof record.receivedAt !== "string" ||
    typeof record.id !== "string"
  ) {
    return invalidInput();
  }
  encryptedCaptureTimestampMicros(record.receivedAt, invalidInput);
  return Object.freeze({
    receivedAt: record.receivedAt,
    captureId: assertEntity(record.id, "cap", invalidInput)
  });
}

function encodeCursor(capture: EncryptedCaptureRead): string {
  const value = Buffer.from(
    JSON.stringify({
      receivedAt: capture.receivedAt,
      id: capture.captureId
    }),
    "utf8"
  ).toString("base64");
  if (value.length > 512) return unavailable();
  return value;
}

function matchesQuery(row: EncryptedCaptureRead, query: CaptureListQuery): boolean {
  const createdAt = encryptedCaptureTimestampMicros(row.clientCreatedAt, unavailable);
  return (
    (query.status === undefined || row.status === query.status) &&
    (query.from === undefined ||
      createdAt >= encryptedCaptureTimestampMicros(query.from, invalidInput)) &&
    (query.to === undefined || createdAt < encryptedCaptureTimestampMicros(query.to, invalidInput))
  );
}

function publicCapture(row: EncryptedCaptureRead, rawContent: string): Capture {
  return Object.freeze({
    id: row.captureId,
    rawContent,
    source: row.source,
    deviceId: row.deviceId,
    privacy: row.privacy,
    explicitDestinationNoteId: row.explicitDestinationNoteId,
    expansionDisabled: row.expansionDisabled,
    clientCreatedAt: row.clientCreatedAt,
    clientTimezone: row.clientTimezone,
    receivedAt: row.receivedAt,
    status: row.status,
    lastErrorCode: row.lastErrorCode
  });
}

function acceptedCapture(opened: OpenedCapture): CaptureCreateResponse["capture"] {
  return Object.freeze({
    ...publicCapture(opened.row, opened.rawContent),
    status: "queued" as const,
    lastErrorCode: null
  });
}

function sameCreateIntent(opened: OpenedCapture, input: NormalizedCaptureCreateInput): boolean {
  return (
    opened.row.captureId === input.clientCaptureId &&
    opened.rawContent === input.rawContent &&
    opened.row.contentLength === input.rawContent.length &&
    opened.row.source === input.source &&
    opened.row.deviceId === (input.deviceId ?? "") &&
    sameInstant(opened.row.clientCreatedAt, input.clientCreatedAt) &&
    opened.row.clientTimezone === input.clientTimezone &&
    opened.row.privacy === input.privacy &&
    opened.row.explicitDestinationNoteId === (input.explicitDestinationNoteId ?? null) &&
    opened.row.expansionDisabled === input.expansionDisabled
  );
}

function receiptMatchesProjection(
  payload: CaptureReceiptPayload,
  row: EncryptedCaptureReceiptRead
): boolean {
  const exactReasonsMatch = sameStringArray(payload.reasonCodes, row.reasonCodes);
  const organizerReasonProjectionMatches =
    row.privacy === "ai_assisted" &&
    row.recordVersion === 1 &&
    row.decisionId !== null &&
    row.reviewItemId === null &&
    row.mutationId !== null &&
    (row.outcome === "created_note" || row.outcome === "added_to_note") &&
    row.reasonCodes.length === 1 &&
    row.reasonCodes[0] === ENCRYPTED_ORGANIZER_REASON_SENTINEL;
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
      reviewReceiptProjectionMatches(payload, row) ||
      generatedExpansionReceiptProjectionMatches(payload, row)) &&
    sameInstant(payload.createdAt, row.createdAt)
  );
}

function storedCipherForRpc<Kind extends AggregateContentKind>(
  record: EncryptedAggregateRecord<Kind>
): StoredEncryptedFieldRpcValue<Kind> {
  return Object.freeze({
    envelope: record.envelope,
    keyId: record.keyId,
    keyClass: record.keyClass,
    keyPurpose: record.keyPurpose,
    keyVersion: record.keyVersion
  });
}

function payloadByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function revisionTransition(
  record: EncryptedAggregateRecord<"note_revision">,
  privacy: Capture["privacy"]
): PrivacyTransition {
  if (record.keyClass === privacy) return Object.freeze({ before: privacy, after: privacy });
  if (record.keyClass === "private_manual" && privacy === "ai_assisted") {
    return Object.freeze({ before: "private_manual", after: "ai_assisted" });
  }
  return unavailable();
}

function receiptUndoTargets(payload: CaptureReceiptPayload): readonly CaptureReceiptUndoTarget[] {
  if (payload.schemaVersion === 2) return payload.undoTargets;
  const undoActions = payload.actions.filter((action) => action.type === "undo");
  const undo = undoActions[0];
  if (
    undoActions.length !== 1 ||
    undo === undefined ||
    payload.destination === null ||
    payload.mutationId === null ||
    undo.mutationId !== payload.mutationId
  ) {
    throw new EncryptedCaptureOperationUnavailableError(
      EncryptedCaptureUnavailableOperation.DELETE
    );
  }
  return Object.freeze([
    Object.freeze({
      noteId: payload.destination.noteId,
      mutationId: payload.mutationId,
      expectedRevision: undo.expectedRevision
    })
  ]);
}

function sameExpectedRevisions(
  expected: readonly Readonly<{ noteId: EntityId<"note">; expectedRevision: number }>[],
  targets: readonly CaptureReceiptUndoTarget[]
): boolean {
  return (
    expected.length === targets.length &&
    expected.every((value, index) => {
      const target = targets[index];
      if (target === undefined) return false;
      return value.noteId === target.noteId && value.expectedRevision === target.expectedRevision;
    })
  );
}

function noteFromEncryptedRead(
  ownerId: string,
  row: EncryptedNoteMutationRead["currentNote"],
  content: NoteContentPayload
): Note {
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
    tagIds: row.tags.map((tag) => tag.tagId),
    links: row.links.map((link) => ({ toNoteId: link.toNoteId, linkType: link.linkType })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

function snapshotFromNote(note: Note): NoteSnapshot {
  return NoteSnapshotSchema.parse({
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: note.tagIds,
    links: note.links
  });
}

function undoIdFactory(revisionId: EntityId<"rev">, mutationId: EntityId<"mut">): EntityIdFactory {
  return ((kind) => {
    if (kind === "rev") return revisionId;
    if (kind === "mut") return mutationId;
    return createEntityId(kind);
  }) as EntityIdFactory;
}

export class EncryptedCaptureAggregateRepository implements CaptureRepository {
  private readonly ownerId: string;
  private readonly createJobId: () => EntityId<"job">;
  private readonly now: () => Date;

  public constructor(
    private readonly dependencies: EncryptedCaptureAggregateRepositoryDependencies
  ) {
    this.ownerId = exactOwnerId(dependencies.ownerId, invalidInput);
    this.createJobId = dependencies.createJobId ?? (() => createEntityId("job"));
    this.now = dependencies.now ?? (() => new Date());
  }

  private assertContext(context: CaptureRepositoryContext): void {
    if (exactOwnerId(context.userId, invalidInput) !== this.ownerId) {
      throw new ServiceRpcError(ServiceRpcErrorCode.FORBIDDEN);
    }
  }

  private assertNotAborted(): void {
    if (this.dependencies.signal !== undefined) {
      throwIfServiceOperationAborted(this.dependencies.signal);
    }
  }

  private async routingRuleMatch(
    input: NormalizedCaptureCreateInput
  ): Promise<RoutingRuleMatchSnapshot | null> {
    if (
      input.privacy !== "ai_assisted" ||
      input.explicitDestinationNoteId !== undefined ||
      this.dependencies.routingRules === undefined
    ) {
      return null;
    }
    this.assertNotAborted();
    const match = await this.dependencies.routingRules.match(input.rawContent);
    this.assertNotAborted();
    return match;
  }

  private async openReceiptPayload(
    row: EncryptedCaptureReceiptRead
  ): Promise<CaptureReceiptPayload> {
    this.assertNotAborted();
    const payload = await this.dependencies.aggregate.openCaptureReceipt(
      this.dependencies.access,
      row.receiptCipher,
      { captureId: row.captureId, recordVersion: row.recordVersion, sourcePrivacy: row.privacy }
    );
    this.assertNotAborted();
    if (!receiptMatchesProjection(payload, row)) return unavailable();
    return payload;
  }

  private async prepareUndoWrite(
    target: CaptureReceiptUndoTarget,
    receipt: CaptureReceiptPayload,
    occurredAt: string,
    remainingPlaintextBytes: number
  ): Promise<PreparedCaptureUndoWrite> {
    this.assertNotAborted();
    const row = await this.dependencies.noteReads.getMutation({
      ownerId: this.ownerId,
      mutationId: target.mutationId
    });
    this.assertNotAborted();
    if (
      row.mutationId !== target.mutationId ||
      row.noteId !== target.noteId ||
      row.decisionId !== receipt.decisionId ||
      row.afterRevision !== target.expectedRevision ||
      row.currentNote.noteId !== target.noteId ||
      row.currentNote.currentRevision !== target.expectedRevision ||
      row.undoneAt !== null
    ) {
      throw new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION);
    }

    const mutationTransition: PrivacyTransition = Object.freeze({
      before: row.beforeSnapshot?.privacy ?? null,
      after: row.afterSnapshot.privacy
    });
    const [currentContent, originalMutation, beforeRevision, afterRevision] = await Promise.all([
      this.dependencies.aggregate.openNoteContent(
        this.dependencies.access,
        row.currentNote.contentCipher,
        {
          noteId: row.noteId,
          currentRevision: row.currentNote.currentRevision,
          privacy: row.currentNote.privacy
        }
      ),
      this.dependencies.aggregate.openNoteMutation(this.dependencies.access, row.mutationCipher, {
        mutationId: row.mutationId,
        afterRevision: row.afterRevision,
        transition: mutationTransition
      }),
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
              transition: revisionTransition(
                row.beforeSnapshot.snapshotCipher,
                row.beforeSnapshot.privacy
              )
            }
          ),
      this.dependencies.aggregate.openNoteRevision(
        this.dependencies.access,
        Object.freeze({
          encrypted: row.afterSnapshot.snapshotCipher,
          contentMac: row.afterSnapshot.snapshotMac
        }),
        {
          revisionId: row.afterSnapshot.revisionId,
          revision: row.afterSnapshot.revision,
          transition: revisionTransition(
            row.afterSnapshot.snapshotCipher,
            row.afterSnapshot.privacy
          )
        }
      )
    ]);
    this.assertNotAborted();
    const currentNote = noteFromEncryptedRead(this.ownerId, row.currentNote, currentContent);
    const currentSnapshot = snapshotFromNote(currentNote);
    if (
      originalMutation.beforeRevision !== row.beforeRevision ||
      originalMutation.afterRevision !== row.afterRevision ||
      originalMutation.afterRevision !== target.expectedRevision ||
      originalMutation.afterSnapshot.privacy !== row.afterSnapshot.privacy ||
      !isDeepStrictEqual(originalMutation.afterSnapshot, afterRevision.snapshot) ||
      !isDeepStrictEqual(originalMutation.afterSnapshot, currentSnapshot) ||
      (originalMutation.beforeSnapshot === null) !== (beforeRevision === null) ||
      (beforeRevision !== null &&
        !isDeepStrictEqual(originalMutation.beforeSnapshot, beforeRevision.snapshot))
    ) {
      return unavailable();
    }

    const revisionId = createEntityId("rev");
    const mutationId = createEntityId("mut");
    const idFactory = undoIdFactory(revisionId, mutationId);
    const result =
      originalMutation.action === "create"
        ? applyNoteOperations(currentNote, {
            expectedRevision: target.expectedRevision,
            operations: [{ type: "set_deleted", deletedAt: occurredAt }],
            now: occurredAt,
            source: "undo",
            actor: "capture:delete",
            idFactory
          })
        : undoNoteMutation(
            currentNote,
            Object.freeze({
              id: row.mutationId,
              noteId: row.noteId,
              beforeRevision: originalMutation.beforeRevision,
              afterRevision: originalMutation.afterRevision,
              operations: originalMutation.operations,
              inverse: originalMutation.inverse,
              beforeSnapshot: originalMutation.beforeSnapshot,
              afterSnapshot: originalMutation.afterSnapshot,
              createdAt: row.createdAt,
              undoneAt: row.undoneAt
            } satisfies NoteMutation),
            { expectedRevision: target.expectedRevision, now: occurredAt, idFactory }
          );
    if (result.revision.id !== revisionId || result.mutation.id !== mutationId) {
      return unavailable();
    }
    const noteContent = NoteContentPayloadSchema.parse({
      schemaVersion: 1,
      title: result.note.title,
      bodyMarkdown: result.note.bodyMarkdown,
      structuredData: result.note.structuredData
    });
    const revisionPayload = NoteRevisionPayloadSchema.parse({
      schemaVersion: 1,
      snapshot: result.mutation.afterSnapshot
    });
    const mutationPayload: NoteMutationPayload = NoteMutationPayloadSchema.parse({
      schemaVersion: 1,
      action: "update",
      beforeRevision: result.mutation.beforeRevision,
      afterRevision: result.mutation.afterRevision,
      operations: result.mutation.operations,
      inverse: result.mutation.inverse,
      beforeSnapshot: result.mutation.beforeSnapshot,
      afterSnapshot: result.mutation.afterSnapshot
    });
    const transition: PrivacyTransition = Object.freeze({
      before: currentNote.privacy,
      after: result.note.privacy
    });
    const plaintextBytes = payloadByteLength([
      receipt,
      currentSnapshot,
      originalMutation,
      noteContent,
      revisionPayload,
      mutationPayload
    ]);
    if (plaintextBytes > remainingPlaintextBytes) return invalidInput();
    const [noteCipher, revision, mutationCipher] = await Promise.all([
      this.dependencies.aggregate.sealNoteContent(this.dependencies.access, {
        noteId: row.noteId,
        currentRevision: result.note.currentRevision,
        privacy: result.note.privacy,
        payload: noteContent
      }),
      this.dependencies.aggregate.sealNoteRevision(this.dependencies.access, {
        revisionId,
        revision: result.note.currentRevision,
        transition,
        payload: revisionPayload
      }),
      this.dependencies.aggregate.sealNoteMutation(this.dependencies.access, {
        mutationId,
        afterRevision: result.note.currentRevision,
        payload: mutationPayload
      })
    ]);
    this.assertNotAborted();
    const opened = await Promise.all([
      this.dependencies.aggregate.openNoteContent(this.dependencies.access, noteCipher, {
        noteId: row.noteId,
        currentRevision: result.note.currentRevision,
        privacy: result.note.privacy
      }),
      this.dependencies.aggregate.openNoteRevision(this.dependencies.access, revision, {
        revisionId,
        revision: result.note.currentRevision,
        transition
      }),
      this.dependencies.aggregate.openNoteMutation(this.dependencies.access, mutationCipher, {
        mutationId,
        afterRevision: result.note.currentRevision,
        transition
      })
    ]);
    this.assertNotAborted();
    if (
      !isDeepStrictEqual(opened[0], noteContent) ||
      !isDeepStrictEqual(opened[1], revisionPayload) ||
      !isDeepStrictEqual(opened[2], mutationPayload)
    ) {
      return unavailable();
    }
    const [noteVerification, mutationVerification] = await Promise.all([
      this.dependencies.aggregate.createAggregateVerificationMac(this.dependencies.access, {
        surface: "note_content",
        noteId: row.noteId,
        recordVersion: result.note.currentRevision,
        privacy: result.note.privacy,
        payload: noteContent
      }),
      this.dependencies.aggregate.createAggregateVerificationMac(this.dependencies.access, {
        surface: "note_mutation",
        mutationId,
        recordVersion: result.note.currentRevision,
        payload: mutationPayload
      })
    ]);
    const verified = await Promise.all([
      this.dependencies.aggregate.verifyAggregateVerificationMac(
        this.dependencies.access,
        noteVerification,
        {
          surface: "note_content",
          noteId: row.noteId,
          recordVersion: result.note.currentRevision,
          privacy: result.note.privacy,
          payload: noteContent
        }
      ),
      this.dependencies.aggregate.verifyAggregateVerificationMac(
        this.dependencies.access,
        mutationVerification,
        {
          surface: "note_mutation",
          mutationId,
          recordVersion: result.note.currentRevision,
          payload: mutationPayload
        }
      )
    ]);
    this.assertNotAborted();
    if (!verified.every(Boolean)) return unavailable();
    const noteState = encryptedOnlyNoteState(row.noteId, {
      spaceId: result.note.spaceId,
      type: result.note.type,
      title: result.note.title,
      bodyMarkdown: result.note.bodyMarkdown,
      structuredData: result.note.structuredData,
      dailyDate: row.currentNote.dailyDate,
      isOpen: result.note.isOpen,
      privacy: result.note.privacy,
      pinnedAt: result.note.pinnedAt,
      archivedAt: result.note.archivedAt,
      deletedAt: result.note.deletedAt,
      tagIds: result.note.tagIds,
      links: result.note.links
    });
    const mutationProjection = encryptedOnlyMutationProjection(result.note.privacy);
    return Object.freeze({
      plaintextBytes,
      command: Object.freeze({
        noteId: row.noteId,
        targetMutationId: row.mutationId,
        expectedRevision: target.expectedRevision,
        sourcePrivacy: currentNote.privacy,
        expectedCurrentCipher: storedCipherForRpc(row.currentNote.contentCipher),
        expectedMutationCipher: storedCipherForRpc(row.mutationCipher),
        noteState,
        noteCipher: encryptedFieldForRpc(noteCipher),
        revision: Object.freeze({
          id: revisionId,
          source: "undo",
          actor: result.revision.actor,
          cipher: encryptedFieldForRpc(revision.encrypted),
          mac: keyedMacForRpc(revision.contentMac)
        }),
        mutation: Object.freeze({
          id: mutationId,
          decisionId: null,
          undoTargetMutationId: row.mutationId,
          operations: mutationProjection.operations,
          inverse: mutationProjection.inverse,
          cipher: encryptedFieldForRpc(mutationCipher)
        }),
        verification: Object.freeze({
          noteContent: keyedMacForRpc(noteVerification),
          noteMutation: keyedMacForRpc(mutationVerification)
        })
      })
    });
  }

  private async openCapture(row: EncryptedCaptureRead): Promise<OpenedCapture> {
    const payload = await this.dependencies.aggregate.openCapture(
      this.dependencies.access,
      Object.freeze({ encrypted: row.contentCipher, contentMac: row.contentMac }),
      { captureId: row.captureId, recordVersion: row.recordVersion, privacy: row.privacy }
    );
    if (payload.rawContent.length !== row.contentLength) return unavailable();
    return Object.freeze({ row, rawContent: payload.rawContent });
  }

  private async findExisting(captureId: EntityId<"cap">): Promise<OpenedCapture | null> {
    try {
      const detail = await this.dependencies.adapter.getCaptureDetail({
        ownerId: this.ownerId,
        captureId
      });
      return await this.openCapture(detail);
    } catch (error: unknown) {
      if (error instanceof ServiceRpcError && error.code === ServiceRpcErrorCode.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  private async sealCommand<RequestPayload, ResponsePayload>(input: {
    idempotencyKey: string;
    transition: PrivacyTransition;
    logicalRequest: LogicalApiRequest<RequestPayload>;
    requestCodec: PayloadCodec<RequestPayload>;
    response: ResponsePayload;
    responseCodec: PayloadCodec<ResponsePayload>;
    requestMacKey?: Parameters<
      EncryptedAggregateService["createIdempotencyRequestMac"]
    >[1]["keyReference"];
  }): Promise<EncryptedCaptureCommandCrypto> {
    this.assertNotAborted();
    const requestMac = await this.dependencies.aggregate.createIdempotencyRequestMac(
      this.dependencies.access,
      {
        idempotencyKey: input.idempotencyKey,
        transition: input.transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec,
        ...(input.requestMacKey === undefined ? {} : { keyReference: input.requestMacKey })
      }
    );
    this.assertNotAborted();
    const responseCipher = await this.dependencies.aggregate.sealIdempotencyResponse(
      this.dependencies.access,
      {
        idempotencyKey: input.idempotencyKey,
        transition: input.transition,
        response: input.response,
        responseCodec: input.responseCodec
      }
    );
    this.assertNotAborted();
    const responseVerificationMac =
      await this.dependencies.aggregate.createAggregateVerificationMac(this.dependencies.access, {
        surface: "idempotency_response",
        idempotencyKey: input.idempotencyKey,
        transition: input.transition,
        payload: input.response,
        payloadCodec: input.responseCodec
      });
    this.assertNotAborted();
    const verified = await this.dependencies.aggregate.verifyAggregateVerificationMac(
      this.dependencies.access,
      responseVerificationMac,
      {
        surface: "idempotency_response",
        idempotencyKey: input.idempotencyKey,
        transition: input.transition,
        payload: input.response,
        payloadCodec: input.responseCodec
      }
    );
    this.assertNotAborted();
    if (!verified) return unavailable();
    const opened = await this.dependencies.aggregate.openIdempotencyResponse(
      this.dependencies.access,
      Object.freeze({
        ownerId: this.ownerId,
        idempotencyKey: input.idempotencyKey,
        keyClass: input.transition.after,
        requestMac,
        response: responseCipher
      }),
      {
        idempotencyKey: input.idempotencyKey,
        transition: input.transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec,
        responseCodec: input.responseCodec
      }
    );
    this.assertNotAborted();
    if (!isDeepStrictEqual(opened, input.response)) return unavailable();
    return Object.freeze({ requestMac, responseCipher, responseVerificationMac });
  }

  private async openCommandResponse<RequestPayload, ResponsePayload>(input: {
    idempotencyKey: string;
    transition: PrivacyTransition;
    logicalRequest: LogicalApiRequest<RequestPayload>;
    requestCodec: PayloadCodec<RequestPayload>;
    responseCodec: PayloadCodec<ResponsePayload>;
    requestMac: KeyedMacRecord;
    response: EncryptedIdempotencyRecord["response"];
  }): Promise<ResponsePayload> {
    return this.dependencies.aggregate.openIdempotencyResponse(
      this.dependencies.access,
      Object.freeze({
        ownerId: this.ownerId,
        idempotencyKey: input.idempotencyKey,
        keyClass: input.transition.after,
        requestMac: input.requestMac,
        response: input.response
      }),
      {
        idempotencyKey: input.idempotencyKey,
        transition: input.transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec,
        responseCodec: input.responseCodec
      }
    );
  }

  private async commandClaim(
    scope: EncryptedCaptureCommandScope,
    idempotencyKey: string,
    captureId: EntityId<"cap">
  ) {
    this.assertNotAborted();
    const claim = await this.dependencies.adapter.getCommandClaim({
      ownerId: this.ownerId,
      scope,
      idempotencyKey
    });
    this.assertNotAborted();
    if (claim !== null && (claim.scope !== scope || claim.captureId !== captureId)) {
      return invalidIdempotency();
    }
    return claim;
  }

  private replayResponse(
    opened: OpenedCapture,
    input: NormalizedCaptureCreateInput
  ): CaptureCreateResponse {
    if (!sameCreateIntent(opened, input)) return invalidIdempotency();
    return contract(CaptureCreateResponseSchema, {
      capture: acceptedCapture(opened),
      jobId: opened.row.jobId,
      replayed: true
    });
  }

  public async createCapture(
    context: CaptureRepositoryContext,
    inputValue: NormalizedCaptureCreateInput
  ): Promise<CaptureCreateResponse> {
    this.assertContext(context);
    const input = parseCreateInput(inputValue);
    const existing = await this.findExisting(input.clientCaptureId);
    if (existing !== null) return this.replayResponse(existing, input);

    const occurredDate = this.now();
    if (!(occurredDate instanceof Date) || !Number.isFinite(occurredDate.valueOf())) {
      return unavailable();
    }
    const occurredAt = occurredDate.toISOString();
    const jobId = assertEntity(this.createJobId(), "job", unavailable);
    const capturePayload = CapturePayloadSchema.parse({
      schemaVersion: 1,
      rawContent: input.rawContent
    });
    const sealedCapture = await this.dependencies.aggregate.sealCapture(this.dependencies.access, {
      captureId: input.clientCaptureId,
      recordVersion: 1,
      privacy: input.privacy,
      payload: capturePayload
    });
    const openedCapture = await this.dependencies.aggregate.openCapture(
      this.dependencies.access,
      sealedCapture,
      { captureId: input.clientCaptureId, recordVersion: 1, privacy: input.privacy }
    );
    if (openedCapture.rawContent !== input.rawContent) return unavailable();

    let routingRuleMatch = await this.routingRuleMatch(input);

    let privateReceiptCipher: EncryptedFieldRpcValue<"capture_receipt"> | null = null;
    let privateReceiptVerificationMac: KeyedMacRpcValue | null = null;
    if (input.privacy === "private_manual") {
      const receiptPayload = CaptureReceiptPayloadSchema.parse({
        schemaVersion: 2,
        captureId: input.clientCaptureId,
        jobId,
        decisionId: null,
        reviewItemId: null,
        mutationId: null,
        outcome: "kept_in_inbox",
        headline: "Kept private in Inbox",
        destination: null,
        insertedContentReferences: [],
        actions: [],
        undoTargets: [],
        reasonCodes: ["private_manual"],
        createdAt: occurredAt
      });
      const receiptInput = Object.freeze({
        captureId: input.clientCaptureId,
        recordVersion: 1,
        sourcePrivacy: input.privacy,
        payload: receiptPayload
      });
      const sealedReceipt = await this.dependencies.aggregate.sealCaptureReceipt(
        this.dependencies.access,
        receiptInput
      );
      const [openedReceipt, receiptVerificationMac] = await Promise.all([
        this.dependencies.aggregate.openCaptureReceipt(
          this.dependencies.access,
          sealedReceipt,
          receiptInput
        ),
        this.dependencies.aggregate.createAggregateVerificationMac(this.dependencies.access, {
          surface: "capture_receipt",
          ...receiptInput
        })
      ]);
      const verificationValid = await this.dependencies.aggregate.verifyAggregateVerificationMac(
        this.dependencies.access,
        receiptVerificationMac,
        { surface: "capture_receipt", ...receiptInput }
      );
      if (
        !verificationValid ||
        !receiptMatchesProjection(openedReceipt, {
          captureId: input.clientCaptureId,
          recordVersion: 1,
          privacy: input.privacy,
          jobId,
          decisionId: null,
          reviewItemId: null,
          mutationId: null,
          outcome: "kept_in_inbox",
          destinationNoteId: null,
          reasonCodes: ["private_manual"],
          createdAt: occurredAt,
          receiptCipher: sealedReceipt
        })
      )
        return unavailable();
      privateReceiptCipher = encryptedFieldForRpc(sealedReceipt);
      privateReceiptVerificationMac = keyedMacForRpc(receiptVerificationMac);
    }

    try {
      let result: Awaited<ReturnType<EncryptedCaptureRpcAdapter["createCapture"]>>;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await this.dependencies.adapter.createCapture({
            ownerId: this.ownerId,
            capture: {
              clientCaptureId: input.clientCaptureId,
              jobId,
              occurredAt,
              contentCipher: encryptedFieldForRpc(sealedCapture.encrypted),
              contentMac: keyedMacForRpc(sealedCapture.contentMac),
              contentLength: input.rawContent.length,
              source: input.source,
              deviceId: input.deviceId ?? "",
              clientCreatedAt: input.clientCreatedAt,
              clientTimezone: input.clientTimezone,
              privacy: input.privacy,
              explicitDestinationNoteId: input.explicitDestinationNoteId ?? null,
              routingRuleMatch,
              expansionDisabled: input.expansionDisabled,
              privateReceiptCipher,
              privateReceiptVerificationMac
            }
          });
          break;
        } catch (error: unknown) {
          if (
            attempt !== 0 ||
            routingRuleMatch === null ||
            !(error instanceof ServiceRpcError) ||
            error.code !== ServiceRpcErrorCode.ROUTING_RULE_MATCH_STALE
          ) {
            throw error;
          }
          routingRuleMatch = await this.routingRuleMatch(input);
        }
      }
      if (result.replayed) {
        const replay = await this.findExisting(input.clientCaptureId);
        return replay === null ? unavailable() : this.replayResponse(replay, input);
      }
      const accepted: OpenedCapture = Object.freeze({
        row: Object.freeze({
          captureId: input.clientCaptureId,
          recordVersion: 1,
          jobId,
          source: input.source,
          deviceId: input.deviceId ?? "",
          contentLength: input.rawContent.length,
          privacy: input.privacy,
          explicitDestinationNoteId: input.explicitDestinationNoteId ?? null,
          expansionDisabled: input.expansionDisabled,
          clientCreatedAt: input.clientCreatedAt,
          clientTimezone: input.clientTimezone,
          receivedAt: occurredAt,
          status: "queued",
          lastErrorCode: null,
          contentCipher: sealedCapture.encrypted,
          contentMac: sealedCapture.contentMac,
          receiptAvailable: false
        }),
        rawContent: input.rawContent
      });
      return contract(CaptureCreateResponseSchema, {
        capture: acceptedCapture(accepted),
        jobId,
        replayed: false
      });
    } catch (error: unknown) {
      if (
        !(error instanceof ServiceRpcError) ||
        error.code !== ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY
      )
        throw error;
      const raced = await this.findExisting(input.clientCaptureId);
      return raced === null ? Promise.reject(error) : this.replayResponse(raced, input);
    }
  }

  public async listCaptures(
    context: CaptureRepositoryContext,
    queryValue: CaptureListQuery
  ): Promise<CaptureListResponse> {
    this.assertContext(context);
    const parsed = CaptureListQuerySchema.safeParse(queryValue);
    if (!parsed.success) return invalidInput();
    const query = parsed.data;
    let cursor = decodeCursor(query.cursor);
    const matching: EncryptedCaptureRead[] = [];
    let scanned = 0;
    let exhausted = false;
    while (matching.length < query.limit + 1 && !exhausted) {
      const page = await this.dependencies.adapter.listCaptures({
        ownerId: this.ownerId,
        cursor,
        limit: READ_BATCH_SIZE
      });
      scanned += page.captures.length;
      if (scanned > MAX_CAPTURE_SCAN) return unavailable();
      for (const row of page.captures) {
        if (matchesQuery(row, query)) matching.push(row);
        if (matching.length >= query.limit + 1) break;
      }
      exhausted = page.captures.length < READ_BATCH_SIZE;
      if (!exhausted) {
        if (page.nextCursor === null) return unavailable();
        cursor = page.nextCursor;
      }
    }
    const hasMore = matching.length > query.limit;
    const visibleRows = matching.slice(0, query.limit);
    const opened = await Promise.all(visibleRows.map((row) => this.openCapture(row)));
    const items: CaptureSummary[] = opened.map(({ row, rawContent }) => ({
      id: row.captureId,
      jobId: row.jobId,
      rawContentPreview: rawContent.trim().slice(0, 280),
      source: row.source,
      privacy: row.privacy,
      clientCreatedAt: row.clientCreatedAt,
      receivedAt: row.receivedAt,
      status: row.status,
      lastErrorCode: row.lastErrorCode,
      receiptAvailable: row.receiptAvailable
    }));
    let nextCursor: string | null = null;
    if (hasMore) {
      const lastVisible = visibleRows.at(-1);
      if (lastVisible === undefined) return unavailable();
      nextCursor = encodeCursor(lastVisible);
    }
    return contract(CaptureListResponseSchema, {
      items,
      pageInfo: { hasMore, nextCursor }
    });
  }

  private async openReceipt(
    row: EncryptedCaptureReceiptRead,
    knownCapture?: OpenedCapture
  ): Promise<CaptureReceipt> {
    captureAggregateDiagnostic("receipt.open-started");
    const payload = await this.dependencies.aggregate.openCaptureReceipt(
      this.dependencies.access,
      row.receiptCipher,
      { captureId: row.captureId, recordVersion: row.recordVersion, sourcePrivacy: row.privacy }
    );
    captureAggregateDiagnostic("receipt.cipher-opened");
    if (!receiptMatchesProjection(payload, row)) {
      if (payload.captureId !== row.captureId)
        captureAggregateDiagnostic("receipt.mismatch-capture");
      if (payload.jobId !== row.jobId) captureAggregateDiagnostic("receipt.mismatch-job");
      if (payload.decisionId !== row.decisionId) {
        captureAggregateDiagnostic("receipt.mismatch-decision");
      }
      if (payload.reviewItemId !== row.reviewItemId) {
        captureAggregateDiagnostic("receipt.mismatch-review");
      }
      if (payload.mutationId !== row.mutationId) {
        captureAggregateDiagnostic("receipt.mismatch-mutation");
      }
      if (payload.outcome !== row.outcome) captureAggregateDiagnostic("receipt.mismatch-outcome");
      if (payload.destination?.noteId !== (row.destinationNoteId ?? undefined)) {
        captureAggregateDiagnostic("receipt.mismatch-destination");
      }
      if (!sameStringArray(payload.reasonCodes, row.reasonCodes)) {
        captureAggregateDiagnostic("receipt.mismatch-reasons");
      }
      if (!sameInstant(payload.createdAt, row.createdAt)) {
        captureAggregateDiagnostic("receipt.mismatch-created-at");
      }
      return unavailable();
    }
    captureAggregateDiagnostic("receipt.projection-matched");

    let capture = knownCapture;
    if (
      payload.insertedContentReferences.some((reference) => reference.type === "captured") &&
      capture === undefined
    ) {
      const detail = await this.dependencies.adapter.getCaptureDetail({
        ownerId: this.ownerId,
        captureId: row.captureId
      });
      captureAggregateDiagnostic("receipt.capture-loaded");
      capture = await this.openCapture(detail);
      captureAggregateDiagnostic("receipt.capture-opened");
    }
    if (
      capture !== undefined &&
      (capture.row.captureId !== row.captureId ||
        capture.row.jobId !== row.jobId ||
        capture.row.privacy !== row.privacy)
    ) {
      if (capture.row.captureId !== row.captureId) {
        captureAggregateDiagnostic("receipt.capture-binding-capture");
      }
      if (capture.row.jobId !== row.jobId) {
        captureAggregateDiagnostic("receipt.capture-binding-job");
      }
      if (capture.row.privacy !== row.privacy) {
        captureAggregateDiagnostic("receipt.capture-binding-privacy");
      }
      return unavailable();
    }
    captureAggregateDiagnostic("receipt.capture-bound");

    const blockIds = [
      ...new Set(
        payload.insertedContentReferences.flatMap((reference) =>
          reference.type === "ai_generated" ? [reference.blockId] : []
        )
      )
    ];
    const blocks = new Map<EntityId<"blk">, string>();
    for (let offset = 0; offset < blockIds.length; offset += GENERATED_BLOCK_BATCH_SIZE) {
      const batch = blockIds.slice(offset, offset + GENERATED_BLOCK_BATCH_SIZE);
      const rows = await this.dependencies.adapter.getGeneratedBlocks({
        ownerId: this.ownerId,
        blockIds: batch
      });
      const opened = await Promise.all(
        rows.map(async (block) => {
          if (
            payload.decisionId === null ||
            block.decisionId !== payload.decisionId ||
            block.noteId !== payload.destination?.noteId
          ) {
            return unavailable();
          }
          const value = await this.dependencies.aggregate.openGeneratedBlock(
            this.dependencies.access,
            block.contentCipher,
            { blockId: block.blockId }
          );
          return Object.freeze({ blockId: block.blockId, content: value.content });
        })
      );
      for (const block of opened) blocks.set(block.blockId, block.content);
    }

    const insertedContent: CaptureReceiptContent[] = payload.insertedContentReferences.map(
      (reference) => {
        if (reference.type === "captured") {
          if (capture === undefined) return unavailable();
          return Object.freeze({
            type: "captured" as const,
            itemId: reference.itemId,
            content: capture.rawContent
          });
        }
        const content = blocks.get(reference.blockId);
        if (content === undefined) return unavailable();
        return Object.freeze({
          type: "ai_generated" as const,
          blockId: reference.blockId,
          content
        });
      }
    );
    captureAggregateDiagnostic("receipt.content-hydrated");
    const publicReceipt = {
      schemaVersion: 1,
      captureId: payload.captureId,
      jobId: payload.jobId,
      decisionId: payload.decisionId,
      reviewItemId: payload.reviewItemId,
      mutationId: payload.mutationId,
      outcome: payload.outcome,
      headline: payload.headline,
      destination: payload.destination,
      insertedContent,
      actions: payload.actions,
      reasonCodes: payload.reasonCodes,
      createdAt: payload.createdAt
    } as const;
    const parsedReceipt = CaptureReceiptSchema.safeParse(publicReceipt);
    if (!parsedReceipt.success) {
      const allowedFields = new Set([
        "schemaVersion",
        "captureId",
        "jobId",
        "decisionId",
        "reviewItemId",
        "mutationId",
        "outcome",
        "headline",
        "destination",
        "insertedContent",
        "actions",
        "reasonCodes",
        "createdAt"
      ]);
      const fields = new Set(
        parsedReceipt.error.issues.map(({ path }) => {
          const field = path[0];
          return typeof field === "string" && allowedFields.has(field) ? field : "root";
        })
      );
      for (const field of fields) captureAggregateDiagnostic(`receipt.public-contract-${field}`);
      return unavailable();
    }
    captureAggregateDiagnostic("receipt.public-contract-valid");
    return contract(CaptureReceiptSchema, publicReceipt);
  }

  public async getCapture(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">
  ): Promise<CaptureDetailResponse> {
    this.assertContext(context);
    assertEntity(captureId, "cap", invalidInput);
    const detail: EncryptedCaptureDetailRead = await this.dependencies.adapter.getCaptureDetail({
      ownerId: this.ownerId,
      captureId
    });
    const opened = await this.openCapture(detail);
    const receipt = detail.receipt === null ? null : await this.openReceipt(detail.receipt, opened);
    return contract(CaptureDetailResponseSchema, {
      capture: { ...publicCapture(detail, opened.rawContent), jobId: detail.jobId, receipt }
    });
  }

  public async getReceipt(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">
  ): Promise<CaptureReceiptResponse> {
    this.assertContext(context);
    assertEntity(captureId, "cap", invalidInput);
    const row = await this.dependencies.adapter.getCaptureReceipt({
      ownerId: this.ownerId,
      captureId
    });
    return contract(CaptureReceiptResponseSchema, { receipt: await this.openReceipt(row) });
  }

  public async retryCapture(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">,
    idempotencyKey: string
  ): Promise<CaptureRetryResponse> {
    this.assertContext(context);
    assertEntity(captureId, "cap", invalidInput);
    const parsedRequest = CaptureRetryRequestSchema.safeParse({ idempotencyKey });
    if (!parsedRequest.success) return invalidInput();
    const key = parsedRequest.data.idempotencyKey;
    const intent: RetryIntent = RetryIntentSchema.parse({ action: "retry" });
    const logicalRequest: LogicalApiRequest<RetryIntent> = Object.freeze({
      schemaVersion: 1,
      scope: "retry_capture",
      targetResourceId: captureId,
      expectedRevision: null,
      payload: intent
    });
    const claim = await this.commandClaim("retry_capture", key, captureId);
    if (claim !== null) {
      const transition: PrivacyTransition = Object.freeze({
        before: claim.keyClass,
        after: claim.keyClass
      });
      const requestMac = await this.dependencies.aggregate.createIdempotencyRequestMac(
        this.dependencies.access,
        {
          idempotencyKey: key,
          transition,
          logicalRequest,
          requestCodec: RetryIntentSchema,
          keyReference: claim.requestMacKey
        }
      );
      const result = await this.dependencies.adapter.retryCapture({
        ownerId: this.ownerId,
        captureId,
        privacy: claim.keyClass,
        idempotencyKey: key,
        command: Object.freeze({ requestMac: keyedMacForRpc(requestMac) })
      });
      const response = await this.openCommandResponse({
        idempotencyKey: key,
        transition,
        logicalRequest,
        requestCodec: RetryIntentSchema,
        responseCodec: CaptureRetryResponseSchema,
        requestMac,
        response: result.encryptedResponse
      });
      if (response.capture.id !== captureId || response.jobId !== result.jobId) {
        return unavailable();
      }
      return contract(CaptureRetryResponseSchema, { ...response, replayed: true });
    }

    const detail = await this.dependencies.adapter.getCaptureDetail({
      ownerId: this.ownerId,
      captureId
    });
    const opened = await this.openCapture(detail);
    const transition: PrivacyTransition = Object.freeze({
      before: detail.privacy,
      after: detail.privacy
    });
    const response = contract(CaptureRetryResponseSchema, {
      capture: acceptedCapture(opened),
      jobId: detail.jobId,
      replayed: false
    });
    const crypto = await this.sealCommand({
      idempotencyKey: key,
      transition,
      logicalRequest,
      requestCodec: RetryIntentSchema,
      response,
      responseCodec: CaptureRetryResponseSchema
    });
    const occurredDate = this.now();
    if (!(occurredDate instanceof Date) || !Number.isFinite(occurredDate.valueOf())) {
      return unavailable();
    }
    const result = await this.dependencies.adapter.retryCapture({
      ownerId: this.ownerId,
      captureId,
      privacy: detail.privacy,
      idempotencyKey: key,
      command: Object.freeze({
        occurredAt: occurredDate.toISOString(),
        requestMac: keyedMacForRpc(crypto.requestMac),
        responseCipher: encryptedFieldForRpc(crypto.responseCipher),
        responseVerificationMac: keyedMacForRpc(crypto.responseVerificationMac)
      })
    });
    const committed = await this.openCommandResponse({
      idempotencyKey: key,
      transition,
      logicalRequest,
      requestCodec: RetryIntentSchema,
      responseCodec: CaptureRetryResponseSchema,
      requestMac: crypto.requestMac,
      response: result.encryptedResponse
    });
    if (committed.capture.id !== captureId || committed.jobId !== result.jobId) {
      return unavailable();
    }
    return contract(CaptureRetryResponseSchema, { ...committed, replayed: result.replayed });
  }

  public async deleteCapture(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">,
    input: NormalizedCaptureDeleteInput
  ): Promise<CaptureDeleteResponse> {
    this.assertContext(context);
    assertEntity(captureId, "cap", invalidInput);
    const parsedRequest = CaptureDeleteRequestSchema.safeParse(input);
    if (!parsedRequest.success) return invalidInput();
    const expectedNoteRevisions = Object.freeze(
      [...parsedRequest.data.expectedNoteRevisions].sort((left, right) =>
        left.noteId.localeCompare(right.noteId)
      )
    );
    const key = parsedRequest.data.idempotencyKey;
    const intent: DeleteIntent = DeleteIntentSchema.parse({
      action: "delete",
      removeInsertedContent: parsedRequest.data.removeInsertedContent,
      expectedNoteRevisions
    });
    const logicalRequest: LogicalApiRequest<DeleteIntent> = Object.freeze({
      schemaVersion: 1,
      scope: "delete_capture",
      targetResourceId: captureId,
      expectedRevision: null,
      payload: intent
    });
    const needsUndo = parsedRequest.data.removeInsertedContent;
    const claim = await this.commandClaim("delete_capture", key, captureId);
    if (claim !== null) {
      const transition: PrivacyTransition = Object.freeze({
        before: claim.keyClass,
        after: claim.keyClass
      });
      const requestMac = await this.dependencies.aggregate.createIdempotencyRequestMac(
        this.dependencies.access,
        {
          idempotencyKey: key,
          transition,
          logicalRequest,
          requestCodec: DeleteIntentSchema,
          keyReference: claim.requestMacKey
        }
      );
      this.assertNotAborted();
      const replayCommand = {
        ownerId: this.ownerId,
        captureId,
        privacy: claim.keyClass,
        idempotencyKey: key,
        command: Object.freeze({ requestMac: keyedMacForRpc(requestMac) })
      };
      const result = needsUndo
        ? await this.dependencies.adapter.deleteCaptureWithUndo(replayCommand)
        : await this.dependencies.adapter.deleteCapture(replayCommand);
      const response = await this.openCommandResponse({
        idempotencyKey: key,
        transition,
        logicalRequest,
        requestCodec: DeleteIntentSchema,
        responseCodec: CaptureDeleteResponseSchema,
        requestMac,
        response: result.encryptedResponse
      });
      if (response.captureId !== captureId) return unavailable();
      return contract(CaptureDeleteResponseSchema, { ...response, replayed: true });
    }

    this.assertNotAborted();
    const [detail, deletionContext, receiptRow] = await Promise.all([
      this.dependencies.adapter.getCaptureDetail({ ownerId: this.ownerId, captureId }),
      this.dependencies.adapter.getDeleteContext({ ownerId: this.ownerId, captureId }),
      needsUndo
        ? this.dependencies.adapter.getCaptureReceipt({ ownerId: this.ownerId, captureId })
        : Promise.resolve(null)
    ]);
    await this.openCapture(detail);
    this.assertNotAborted();
    const occurredDate = this.now();
    if (!(occurredDate instanceof Date) || !Number.isFinite(occurredDate.valueOf())) {
      return unavailable();
    }
    const occurredAt = occurredDate.toISOString();
    let receiptPayload: CaptureReceiptPayload | null = null;
    const preparedUndoWrites: PreparedCaptureUndoWrite[] = [];
    if (needsUndo) {
      if (receiptRow === null) return unavailable();
      receiptPayload = await this.openReceiptPayload(receiptRow);
      const targets = receiptUndoTargets(receiptPayload);
      if (
        targets.length < 1 ||
        targets.length > MAX_CAPTURE_RECEIPT_UNDO_TARGETS ||
        !sameExpectedRevisions(expectedNoteRevisions, targets) ||
        !sameStringArray(
          deletionContext.sourceNoteIds,
          targets.map((target) => target.noteId)
        )
      ) {
        throw new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION);
      }
      let remainingBytes = MAX_CAPTURE_UNDO_PLAINTEXT_BYTES;
      for (const target of targets) {
        this.assertNotAborted();
        const prepared = await this.prepareUndoWrite(
          target,
          receiptPayload,
          occurredAt,
          remainingBytes
        );
        preparedUndoWrites.push(prepared);
        remainingBytes -= prepared.plaintextBytes;
      }
    }
    const response = contract(CaptureDeleteResponseSchema, {
      captureId,
      deletedAt: occurredAt,
      sourceRemovedFromNoteIds: deletionContext.sourceNoteIds,
      removedInsertedContent: preparedUndoWrites.length > 0,
      contentRemovalMutations: preparedUndoWrites.map(({ command }) => ({
        mutationId: command.mutation.id,
        noteId: command.noteId,
        expectedRevision: command.expectedRevision + 1
      })),
      replayed: false
    });
    const transition: PrivacyTransition = Object.freeze({
      before: detail.privacy,
      after: detail.privacy
    });
    const crypto = await this.sealCommand({
      idempotencyKey: key,
      transition,
      logicalRequest,
      requestCodec: DeleteIntentSchema,
      response,
      responseCodec: CaptureDeleteResponseSchema
    });
    this.assertNotAborted();
    const command = {
      ownerId: this.ownerId,
      captureId,
      privacy: detail.privacy,
      idempotencyKey: key,
      command:
        needsUndo && receiptRow !== null && receiptPayload !== null
          ? Object.freeze({
              occurredAt,
              removeInsertedContent: true as const,
              sourceNoteIds: deletionContext.sourceNoteIds,
              receipt: Object.freeze({
                recordVersion: receiptRow.recordVersion,
                cipher: storedCipherForRpc(receiptRow.receiptCipher)
              }),
              undoWrites: Object.freeze(preparedUndoWrites.map(({ command }) => command)),
              requestMac: keyedMacForRpc(crypto.requestMac),
              responseCipher: encryptedFieldForRpc(crypto.responseCipher),
              responseVerificationMac: keyedMacForRpc(crypto.responseVerificationMac)
            })
          : Object.freeze({
              occurredAt,
              removeInsertedContent: false as const,
              sourceNoteIds: deletionContext.sourceNoteIds,
              requestMac: keyedMacForRpc(crypto.requestMac),
              responseCipher: encryptedFieldForRpc(crypto.responseCipher),
              responseVerificationMac: keyedMacForRpc(crypto.responseVerificationMac)
            })
    };
    const result = needsUndo
      ? await this.dependencies.adapter.deleteCaptureWithUndo(command)
      : await this.dependencies.adapter.deleteCapture(command);
    const committed = await this.openCommandResponse({
      idempotencyKey: key,
      transition,
      logicalRequest,
      requestCodec: DeleteIntentSchema,
      responseCodec: CaptureDeleteResponseSchema,
      requestMac: crypto.requestMac,
      response: result.encryptedResponse
    });
    if (committed.captureId !== captureId) return unavailable();
    return contract(CaptureDeleteResponseSchema, { ...committed, replayed: result.replayed });
  }
}
