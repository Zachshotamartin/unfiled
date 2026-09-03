import {
  applyMaterializedOrganizationCommand,
  type AppliedOrganizationCommand
} from "@unfiled/ai-routing";
import { NoteSchema, type EntityId, type EntityKind } from "@unfiled/contracts";
import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import type { EntityIdFactory, Note } from "@unfiled/domain";
import {
  authorizeAggregateOwner,
  CaptureReceiptPayloadSchema,
  createEncryptedAggregateService,
  encryptedFieldForRpc,
  GeneratedBlockPayloadSchema,
  jsonPayloadCodec,
  keyedMacForRpc,
  NoteContentPayloadSchema,
  NoteMutationPayloadSchema,
  NoteRevisionPayloadSchema,
  OrganizationDecisionPayloadSchema,
  ReviewPayloadSchema,
  type AggregateContentKind,
  type CaptureReceiptPayload,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type JsonValue,
  type LogicalApiRequest,
  type ObjectWrapReservation,
  type OrganizationDecisionPayload,
  type ReviewPayload
} from "@unfiled/encrypted-aggregate";
import {
  createManagedKeyResolver,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser,
  type ManagedKeyStore
} from "@unfiled/key-management";
import { createHash } from "node:crypto";

import type {
  AtomicOrganizerCommand,
  EncryptedCandidate,
  EncryptedProjection,
  OrganizerCipher,
  OrganizerPreparation,
  OrganizerReviewReason
} from "./drain.js";
import { OrganizerUnavailableError } from "./errors.js";
import {
  custodianForOrganizerAuthority,
  managedKeyRecordParserForOrganizerAuthority,
  type OrganizerKeyAuthority
} from "./key-management.js";
import { organizerLocalDate } from "./local-date.js";
import {
  sameOrganizerCaptureControls,
  type DecryptedAttachment,
  type DecryptedCandidate
} from "./planner.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INDEXABLE_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;

type ReservationSpec = Readonly<{
  groupUse?: Readonly<{ operationCount: number; operationIndex: number }>;
  reservationId: string;
}>;

type OrganizerWriteRequestPayload = Readonly<{
  captureId: string;
  decisionId: string;
  jobId: string;
}>;

type OrganizerWriteResponsePayload = Readonly<{
  jobId: string;
  mutationId: string;
  noteId: string;
  revision: number;
  schemaVersion: 1;
}>;

function unavailable(): never {
  throw new OrganizerUnavailableError();
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) unavailable();
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const row = object(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    unavailable();
  }
  return row;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBinding(
  record: ManagedKeyRecord,
  binding: Readonly<{ ownerId: string; keyClass: string; purpose: string }>
): boolean {
  return (
    record.ownerId === binding.ownerId &&
    record.keyClass === binding.keyClass &&
    record.purpose === binding.purpose
  );
}

function keyStore(records: readonly ManagedKeyRecord[]): ManagedKeyStore {
  return Object.freeze({
    findActive(binding): Promise<ManagedKeyRecord | null> {
      return Promise.resolve(
        records.find((record) => record.status === "active" && sameBinding(record, binding)) ?? null
      );
    },
    findById(selector): Promise<ManagedKeyRecord | null> {
      return Promise.resolve(
        records.find(
          (record) =>
            record.ownerId === selector.ownerId &&
            record.keyClass === selector.keyClass &&
            record.purpose === selector.purpose &&
            record.keyId === selector.keyId &&
            (record.status === "active" || record.status === "retired")
        ) ?? null
      );
    }
  });
}

function parsedProjection<Kind extends AggregateContentKind>(
  ownerId: string,
  projection: EncryptedProjection,
  parseRecord: ManagedKeyRecordParser,
  expected: Readonly<{
    keyClass: "ai_assisted";
    kind: Kind;
    recordVersion: number;
    resourceId: string;
  }>
): Readonly<{ key: ManagedKeyRecord; record: EncryptedAggregateRecord<Kind> }> {
  if (
    projection.resourceId !== expected.resourceId ||
    projection.recordVersion !== expected.recordVersion
  ) {
    unavailable();
  }
  const cipher = exact(projection.cipher, [
    "envelope",
    "keyClass",
    "keyId",
    "keyPurpose",
    "keyVersion"
  ]);
  let key: ManagedKeyRecord;
  let envelope: ReturnType<typeof parseContentEnvelope>;
  try {
    key = parseRecord(projection.key);
    envelope = parseContentEnvelope(serializeContentEnvelope(cipher.envelope));
  } catch {
    return unavailable();
  }
  if (
    cipher.keyClass !== expected.keyClass ||
    cipher.keyPurpose !== "object_wrap" ||
    cipher.keyId !== key.keyId ||
    cipher.keyVersion !== key.keyVersion ||
    key.ownerId !== ownerId ||
    key.keyClass !== expected.keyClass ||
    key.purpose !== "object_wrap" ||
    (key.status !== "active" && key.status !== "retired") ||
    envelope.keyId !== key.keyId ||
    envelope.context.kind !== expected.kind ||
    envelope.context.recordVersion !== expected.recordVersion ||
    envelope.context.resourceId !== expected.resourceId ||
    envelope.context.tenantId !== ownerId
  ) {
    unavailable();
  }
  return Object.freeze({
    key,
    record: Object.freeze({
      envelope,
      keyClass: expected.keyClass,
      keyId: key.keyId,
      keyPurpose: "object_wrap" as const,
      keyVersion: key.keyVersion,
      kind: expected.kind,
      ownerId,
      recordVersion: expected.recordVersion,
      resourceId: expected.resourceId
    })
  });
}

function readAggregate(
  authority: OrganizerKeyAuthority,
  keys: readonly ManagedKeyRecord[]
): EncryptedAggregateService {
  const parseRecord = managedKeyRecordParserForOrganizerAuthority(authority);
  const resolver = createManagedKeyResolver({
    custodian: custodianForOrganizerAuthority(authority),
    parseRecord,
    store: keyStore(keys),
    workload: "organization_worker"
  });
  return createEncryptedAggregateService({
    keyResolver: resolver,
    objectWrapReservations: {
      reserveObjectWrappingKey(): Promise<never> {
        return Promise.reject(new OrganizerUnavailableError());
      }
    }
  });
}

function captureAuthentication(
  ownerId: string,
  projection: EncryptedProjection,
  parseRecord: ManagedKeyRecordParser
): Readonly<{ contentMac: unknown; key: ManagedKeyRecord }> {
  const contentMac = exact(projection.contentMac, [
    "value",
    "keyId",
    "keyClass",
    "keyPurpose",
    "keyVersion"
  ]);
  let key: ManagedKeyRecord;
  try {
    key = parseRecord(projection.contentMacKey);
  } catch {
    return unavailable();
  }
  if (
    typeof contentMac.value !== "string" ||
    !/^[0-9a-f]{64}$/u.test(contentMac.value) ||
    contentMac.keyId !== key.keyId ||
    contentMac.keyClass !== "ai_assisted" ||
    contentMac.keyPurpose !== "content_mac" ||
    contentMac.keyVersion !== key.keyVersion ||
    key.ownerId !== ownerId ||
    key.keyClass !== "ai_assisted" ||
    key.purpose !== "content_mac" ||
    (key.status !== "active" && key.status !== "retired")
  ) {
    unavailable();
  }
  return Object.freeze({ contentMac, key });
}

function writeAggregate(
  authority: OrganizerKeyAuthority,
  preparation: OrganizerPreparation,
  reservations: readonly ReservationSpec[]
): Readonly<{ aggregate: EncryptedAggregateService; assertConsumed(): void }> {
  const parseRecord = managedKeyRecordParserForOrganizerAuthority(authority);
  let contentMac: ManagedKeyRecord;
  let objectWrap: ManagedKeyRecord;
  try {
    contentMac = parseRecord(preparation.keys.contentMac);
    objectWrap = parseRecord(preparation.keys.objectWrap);
  } catch {
    return unavailable();
  }
  if (
    contentMac.ownerId !== objectWrap.ownerId ||
    contentMac.keyClass !== "ai_assisted" ||
    contentMac.purpose !== "content_mac" ||
    contentMac.status !== "active" ||
    objectWrap.keyClass !== "ai_assisted" ||
    objectWrap.purpose !== "object_wrap" ||
    objectWrap.status !== "active"
  ) {
    unavailable();
  }
  let reservationIndex = 0;
  const resolver = createManagedKeyResolver({
    custodian: custodianForOrganizerAuthority(authority),
    parseRecord,
    store: keyStore([contentMac, objectWrap]),
    workload: "organization_worker"
  });
  const aggregate = createEncryptedAggregateService({
    keyResolver: resolver,
    objectWrapReservations: {
      reserveObjectWrappingKey(binding): Promise<ObjectWrapReservation> {
        const reservation = reservations[reservationIndex];
        if (
          reservation === undefined ||
          binding.ownerId !== objectWrap.ownerId ||
          binding.keyClass !== "ai_assisted"
        ) {
          return Promise.reject(new OrganizerUnavailableError());
        }
        reservationIndex += 1;
        const base = {
          reference: Object.freeze({
            keyClass: "ai_assisted" as const,
            keyId: objectWrap.keyId,
            keyVersion: objectWrap.keyVersion,
            ownerId: objectWrap.ownerId,
            purpose: "object_wrap" as const
          }),
          reservationId: reservation.reservationId
        };
        return Promise.resolve(
          reservation.groupUse === undefined
            ? Object.freeze(base)
            : Object.freeze({ ...base, groupUse: reservation.groupUse })
        );
      }
    }
  });
  return Object.freeze({
    aggregate,
    assertConsumed(): void {
      if (reservationIndex !== reservations.length) unavailable();
    }
  });
}

function deterministicIdFactory(jobId: string, decisionId: string): EntityIdFactory {
  const offsets = new Map<EntityKind, number>();
  return <Kind extends EntityKind>(kind: Kind): EntityId<Kind> => {
    const offset = offsets.get(kind) ?? 0;
    offsets.set(kind, offset + 1);
    const digest = createHash("sha256")
      .update(`unfiled.organizer.entity.v1:${jobId}:${decisionId}:${kind}:${offset}`, "utf8")
      .digest();
    let value = BigInt(`0x${digest.subarray(0, 16).toString("hex")}`);
    digest.fill(0);
    let suffix = "";
    for (let index = 0; index < 26; index += 1) {
      suffix = `${CROCKFORD_BASE32.charAt(Number(value & 31n))}${suffix}`;
      value >>= 5n;
    }
    return `${kind}_${suffix}`;
  };
}

function headings(markdown: string): readonly string[] {
  const result: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const value = INDEXABLE_HEADING.exec(line)?.[1]?.trim();
    if (value !== undefined && value.length > 0)
      result.push(Array.from(value).slice(0, 200).join(""));
    if (result.length === 64) break;
  }
  return Object.freeze(result);
}

function snippet(markdown: string): string {
  return Array.from(markdown.replace(/\s+/gu, " ").trim()).slice(-2_000).join("");
}

function currentNote(
  ownerId: string,
  encrypted: EncryptedCandidate,
  decrypted: DecryptedCandidate
): Note {
  if (
    encrypted.noteId !== decrypted.noteId ||
    encrypted.candidateId !== decrypted.candidateId ||
    encrypted.noteType !== decrypted.noteType ||
    encrypted.revision !== decrypted.revision ||
    encrypted.isOpen !== decrypted.isOpen
  ) {
    unavailable();
  }
  try {
    const parsed = NoteSchema.parse({
      archivedAt: encrypted.archivedAt,
      bodyMarkdown: decrypted.bodyMarkdown,
      createdAt: encrypted.updatedAt,
      currentRevision: encrypted.revision,
      deletedAt: encrypted.deletedAt,
      id: encrypted.noteId,
      isOpen: encrypted.isOpen,
      links: encrypted.links,
      pinnedAt: encrypted.pinnedAt,
      privacy: "ai_assisted",
      spaceId: encrypted.spaceId,
      structuredData: decrypted.structuredData,
      tagIds: encrypted.tagIds,
      title: decrypted.title,
      type: encrypted.noteType,
      updatedAt: encrypted.updatedAt
    });
    return Object.freeze({ ...parsed, userId: ownerId });
  } catch {
    return unavailable();
  }
}

function emptyStructuredData(type: EncryptedCandidate["noteType"]): JsonValue {
  if (type === "list") return { items: [], schemaVersion: 1 };
  if (type === "log") return { entries: [], schemaVersion: 1 };
  if (type === "project") return { checklistItems: [], schemaVersion: 1 };
  return { schemaVersion: 1 };
}

function dailyDate(
  input: Parameters<OrganizerCipher["sealCommand"]>[0],
  applied: AppliedOrganizationCommand
): string | null {
  if (input.destination !== null) return input.destination.encrypted.dailyDate;
  if (applied.note.type !== "list" && applied.note.type !== "log") return null;
  return organizerLocalDate(input.job.occurredAt, input.job.clientTimezone);
}

function publicNoteState(
  input: Parameters<OrganizerCipher["sealCommand"]>[0],
  applied: AppliedOrganizationCommand
): Readonly<Record<string, JsonValue>> {
  const requiresCompatibilityPlaintext = input.job.commandProjection === "legacy";
  return Object.freeze({
    archivedAt: applied.note.archivedAt,
    bodyMarkdown: requiresCompatibilityPlaintext ? applied.note.bodyMarkdown : "",
    dailyDate: dailyDate(input, applied),
    deletedAt: applied.note.deletedAt,
    isOpen: applied.note.isOpen,
    links: applied.note.links,
    pinnedAt: applied.note.pinnedAt,
    privacy: "ai_assisted",
    spaceId: applied.note.spaceId,
    structuredData: requiresCompatibilityPlaintext
      ? applied.note.structuredData
      : emptyStructuredData(applied.note.type),
    tagIds: applied.note.tagIds,
    title: requiresCompatibilityPlaintext
      ? applied.note.title
      : `e-${applied.note.id.toLowerCase()}`,
    type: applied.note.type
  });
}

function decisionPayload(
  input: Parameters<OrganizerCipher["sealCommand"]>[0]
): OrganizationDecisionPayload {
  const validatedPlan = Object.freeze({
    ...input.plan.validatedPlan,
    generatedExpansion: null
  });
  return OrganizationDecisionPayloadSchema.parse({
    band: input.routingDecision?.band ?? (input.plan.kind === "review" ? "review" : "auto"),
    candidateManifest: {
      generationId: input.ragGenerationId,
      candidates: input.candidates.map(({ decrypted, encrypted }) => ({
        headings: headings(decrypted.bodyMarkdown),
        isOpen: encrypted.isOpen,
        latestSnippet: snippet(decrypted.bodyMarkdown),
        noteId: encrypted.noteId,
        noteType: encrypted.noteType,
        pinned: encrypted.pinnedAt !== null,
        revision: encrypted.revision,
        spacePath: encrypted.spaceId ?? "",
        title: decrypted.title
      }))
    },
    schemaVersion: 1,
    signals: {
      captureOrdinal: input.job.accountCaptureOrdinal,
      explicitDestination: input.controls.explicitDestinationNoteId !== null,
      policyFailClosed: input.routingDecision?.failClosed ?? false,
      policyMargin: input.routingDecision?.margin ?? null,
      policyReasons: input.routingDecision?.reasons ?? [],
      policyScore: input.routingDecision?.score ?? null,
      generatedBlockId: input.plan.generatedBlock?.blockId ?? null,
      modelId: input.job.modelId,
      promptVersion: input.job.promptVersion,
      routingMode: input.job.routingMode,
      schemaVersion: input.job.schemaVersion
    },
    validatedPlan
  });
}

function assertCandidateEvidenceBinding(
  input: Parameters<OrganizerCipher["sealCommand"]>[0]
): void {
  if (
    input.candidates.length > 8 ||
    (input.ragGenerationId !== null &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.ragGenerationId))
  ) {
    unavailable();
  }
  const candidateIds = new Set<string>();
  const noteIds = new Set<string>();
  for (const { decrypted, encrypted } of input.candidates) {
    if (
      candidateIds.has(encrypted.candidateId) ||
      noteIds.has(encrypted.noteId) ||
      encrypted.candidateId !== decrypted.candidateId ||
      encrypted.noteId !== decrypted.noteId ||
      encrypted.noteType !== decrypted.noteType ||
      encrypted.revision !== decrypted.revision ||
      encrypted.isOpen !== decrypted.isOpen ||
      !encrypted.isOpen ||
      encrypted.archivedAt !== null ||
      encrypted.deletedAt !== null ||
      encrypted.source.resourceId !== encrypted.noteId ||
      encrypted.source.recordVersion !== encrypted.revision
    ) {
      unavailable();
    }
    candidateIds.add(encrypted.candidateId);
    noteIds.add(encrypted.noteId);
  }

  const referencedCandidateIds = [
    input.plan.validatedPlan.destination.candidateId,
    ...input.plan.validatedPlan.alternatives,
    ...input.plan.validatedPlan.operations.flatMap((operation) =>
      operation.type === "add_relation" ? [operation.toCandidateId] : []
    )
  ].filter((candidateId): candidateId is `note_${string}` => candidateId !== null);
  if (referencedCandidateIds.some((candidateId) => !candidateIds.has(candidateId))) unavailable();

  if (input.plan.kind === "append") {
    const destination = input.destination;
    const destinationCandidateId = input.plan.candidateId;
    const evidence = input.candidates.find(
      ({ decrypted }) => decrypted.candidateId === destinationCandidateId
    );
    if (
      destination === null ||
      evidence === undefined ||
      destination.decrypted.candidateId !== destinationCandidateId ||
      !candidateIds.has(destination.decrypted.candidateId) ||
      !sameCanonical(destination, evidence)
    ) {
      unavailable();
    }
  } else if (input.destination !== null) {
    unavailable();
  }
}

function reviewType(reason: OrganizerReviewReason): string {
  if (reason === "duplicate_suggestion") return "duplicate_suggestion";
  if (reason === "planner_ambiguity") return "low_confidence";
  if (reason === "revision_conflict") return "revision_conflict";
  if (reason === "explicit_destination_unavailable") return "structure_conflict";
  return "pending_expansion";
}

function reviewPayload(input: Parameters<OrganizerCipher["sealCommand"]>[0]): ReviewPayload {
  const { plan, reviewReason: reason } = input;
  if (reason === null) unavailable();
  const duplicateNotes = plan.validatedPlan.alternatives.map((candidateId) => {
    const candidate = input.candidates.find(
      ({ decrypted }) => decrypted.candidateId === candidateId
    );
    if (candidate === undefined) return unavailable();
    return Object.freeze({
      noteId: candidate.encrypted.noteId,
      revision: candidate.encrypted.revision
    });
  });
  const proposal =
    reason === "duplicate_suggestion"
      ? {
          type: "duplicate_notes" as const,
          explanation:
            "This capture may overlap with these notes. Keep both leaves every note unchanged.",
          notes: duplicateNotes
        }
      : reason === "revision_conflict"
        ? { type: "conflict" as const, reason: "revision" as const }
        : reason === "explicit_destination_unavailable"
          ? { type: "conflict" as const, reason: "candidate_eligibility" as const }
          : reason === "expansion_pending"
            ? plan.generatedBlock === null
              ? { type: "conflict" as const, reason: "consent_controls" as const }
              : { type: "generated_block" as const, blockId: plan.generatedBlock.blockId }
            : { type: "route_capture" as const, plan: plan.validatedPlan };
  return ReviewPayloadSchema.parse({
    proposal,
    resolution: null,
    schemaVersion: 2,
    state: "open"
  });
}

function routedReceipt(
  input: Parameters<OrganizerCipher["sealCommand"]>[0],
  applied: AppliedOrganizationCommand
): CaptureReceiptPayload {
  const capturedContentReferences =
    applied.insertedItemIds.length === 0
      ? [{ itemId: null, type: "captured" as const }]
      : applied.insertedItemIds.map((itemId) => ({ itemId, type: "captured" as const }));
  const insertedContentReferences = [
    ...capturedContentReferences,
    ...(input.plan.generatedBlock === null
      ? []
      : [{ blockId: input.plan.generatedBlock.blockId, type: "ai_generated" as const }])
  ];
  return CaptureReceiptPayloadSchema.parse({
    actions: [
      { noteId: applied.note.id, type: "open" },
      { decisionId: input.preparation.ids.decisionId, noteId: applied.note.id, type: "move" },
      {
        expectedRevision: applied.note.currentRevision,
        mutationId: input.preparation.ids.mutationId,
        type: "undo"
      }
    ],
    captureId: input.job.captureId,
    createdAt: input.job.occurredAt,
    decisionId: input.preparation.ids.decisionId,
    destination: { noteId: applied.note.id, title: applied.note.title },
    headline: input.plan.kind === "create" ? "Created a note" : "Added to a note",
    insertedContentReferences,
    jobId: input.job.jobId,
    mutationId: input.preparation.ids.mutationId,
    outcome: input.plan.kind === "create" ? "created_note" : "added_to_note",
    reasonCodes: input.plan.validatedPlan.reasonCodes,
    reviewItemId: input.plan.generatedBlock === null ? null : input.preparation.ids.reviewItemId,
    schemaVersion: 2,
    undoTargets: [
      {
        expectedRevision: applied.note.currentRevision,
        mutationId: input.preparation.ids.mutationId,
        noteId: applied.note.id
      }
    ]
  });
}

function deferredReceipt(
  input: Parameters<OrganizerCipher["sealCommand"]>[0]
): CaptureReceiptPayload {
  return CaptureReceiptPayloadSchema.parse({
    actions: [],
    captureId: input.job.captureId,
    createdAt: input.job.occurredAt,
    decisionId: input.preparation.ids.decisionId,
    destination: null,
    headline: "Needs your review",
    insertedContentReferences: [],
    jobId: input.job.jobId,
    mutationId: null,
    outcome: "needs_review",
    reasonCodes: input.plan.validatedPlan.reasonCodes,
    reviewItemId: input.preparation.ids.reviewItemId,
    schemaVersion: 2,
    undoTargets: []
  });
}

function contentMacReference(authority: OrganizerKeyAuthority, preparation: OrganizerPreparation) {
  const key = managedKeyRecordParserForOrganizerAuthority(authority)(preparation.keys.contentMac);
  return Object.freeze({
    keyClass: key.keyClass,
    keyId: key.keyId,
    keyVersion: key.keyVersion,
    ownerId: key.ownerId,
    purpose: "content_mac" as const
  });
}

function groupedReservation(
  preparation: OrganizerPreparation,
  operationIndex: number
): ReservationSpec {
  return Object.freeze({
    groupUse: Object.freeze({
      operationCount: preparation.reservations.noteWrite.operationCount,
      operationIndex
    }),
    reservationId: preparation.reservations.noteWrite.reservationId
  });
}

function singleReservation(reservationId: string): ReservationSpec {
  return Object.freeze({ reservationId });
}

async function assertVerification(value: Promise<boolean>): Promise<void> {
  if (!(await value)) unavailable();
}

function logicalRequest(
  input: Parameters<OrganizerCipher["sealCommand"]>[0]
): LogicalApiRequest<OrganizerWriteRequestPayload> {
  return Object.freeze({
    expectedRevision: input.preparation.expectedRevision,
    payload: Object.freeze({
      captureId: input.job.captureId,
      decisionId: input.preparation.ids.decisionId,
      jobId: input.job.jobId
    }),
    schemaVersion: 1,
    scope:
      input.preparation.mode === "create"
        ? "create_encrypted_note"
        : "apply_encrypted_note_mutation",
    targetResourceId: input.preparation.noteId
  });
}

function assertPreparationBinding(input: Parameters<OrganizerCipher["sealCommand"]>[0]): void {
  assertCandidateEvidenceBinding(input);
  const { plan, preparation, stableIds } = input;
  if (
    preparation.jobId !== input.job.jobId ||
    preparation.replanCount !== input.activeReplanCount ||
    input.activeReplanCount < input.job.replanCount ||
    stableIds.decisionId !== preparation.ids.decisionId ||
    stableIds.decisionId !== plan.decisionId ||
    stableIds.generatedBlockId !== (plan.generatedBlock?.blockId ?? null) ||
    (plan.generatedBlock !== null &&
      stableIds.generatedBlockId !== preparation.ids.generatedBlockId) ||
    !sameOrganizerCaptureControls(input.controls, input.capture.controls) ||
    !sameOrganizerCaptureControls(input.controls, input.job.controls)
  ) {
    unavailable();
  }

  if (plan.kind === "review") {
    if (
      input.routingDecision?.autoApply === true ||
      stableIds.createdNoteId !== null ||
      stableIds.revisionId !== null ||
      stableIds.mutationId !== null ||
      stableIds.reviewItemId !== plan.reviewItemId ||
      stableIds.reviewItemId !== preparation.ids.reviewItemId
    ) {
      unavailable();
    }
    return;
  }

  if (
    input.routingDecision === null ||
    !input.routingDecision.autoApply ||
    input.routingDecision.band !== "auto" ||
    preparation.mode !== plan.kind ||
    preparation.noteId !== plan.noteId ||
    preparation.expectedRevision !== (plan.kind === "create" ? null : plan.expectedRevision) ||
    preparation.targetRevision !== plan.afterRevision ||
    preparation.ids.revisionId !== plan.revisionId ||
    preparation.ids.mutationId !== plan.mutationId ||
    stableIds.revisionId !== plan.revisionId ||
    stableIds.mutationId !== plan.mutationId ||
    stableIds.reviewItemId !==
      (plan.generatedBlock === null ? null : preparation.ids.reviewItemId) ||
    stableIds.createdNoteId !== (plan.kind === "create" ? plan.noteId : null)
  ) {
    unavailable();
  }
}

async function sealReviewCommand(
  input: Parameters<OrganizerCipher["sealCommand"]>[0]
): Promise<AtomicOrganizerCommand> {
  if (input.reviewReason === null || input.plan.kind !== "review" || input.destination !== null) {
    unavailable();
  }
  const runtime = writeAggregate(input.authority, input.preparation, [
    singleReservation(input.preparation.reservations.decision.reservationId),
    singleReservation(input.preparation.reservations.review.reservationId),
    singleReservation(input.preparation.reservations.receipt.reservationId)
  ]);
  const access = authorizeAggregateOwner({
    authenticatedOwnerId: input.job.ownerId,
    resourceOwnerId: input.job.ownerId
  });
  const decisionValue = decisionPayload(input);
  const reviewValue = reviewPayload(input);
  const receiptValue = deferredReceipt(input);
  const decision = await runtime.aggregate.sealOrganizationDecision(access, {
    decisionId: input.preparation.ids.decisionId,
    payload: decisionValue
  });
  const review = await runtime.aggregate.sealReview(access, {
    payload: reviewValue,
    recordVersion: 1,
    reviewId: input.preparation.ids.reviewItemId,
    sourcePrivacy: "ai_assisted"
  });
  const receipt = await runtime.aggregate.sealCaptureReceipt(access, {
    captureId: input.job.captureId,
    payload: receiptValue,
    recordVersion: 1,
    sourcePrivacy: "ai_assisted"
  });
  runtime.assertConsumed();
  const [decisionMac, reviewMac, receiptMac] = await Promise.all([
    runtime.aggregate.createAggregateVerificationMac(access, {
      decisionId: input.preparation.ids.decisionId,
      payload: decisionValue,
      surface: "organization_decision"
    }),
    runtime.aggregate.createAggregateVerificationMac(access, {
      payload: reviewValue,
      recordVersion: 1,
      reviewId: input.preparation.ids.reviewItemId,
      sourcePrivacy: "ai_assisted",
      surface: "review_item"
    }),
    runtime.aggregate.createAggregateVerificationMac(access, {
      captureId: input.job.captureId,
      payload: receiptValue,
      recordVersion: 1,
      sourcePrivacy: "ai_assisted",
      surface: "capture_receipt"
    })
  ]);
  await Promise.all([
    assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, decisionMac, {
        decisionId: input.preparation.ids.decisionId,
        payload: decisionValue,
        surface: "organization_decision"
      })
    ),
    assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, reviewMac, {
        payload: reviewValue,
        recordVersion: 1,
        reviewId: input.preparation.ids.reviewItemId,
        sourcePrivacy: "ai_assisted",
        surface: "review_item"
      })
    ),
    assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, receiptMac, {
        captureId: input.job.captureId,
        payload: receiptValue,
        recordVersion: 1,
        sourcePrivacy: "ai_assisted",
        surface: "capture_receipt"
      })
    )
  ]);
  return Object.freeze({
    decision: Object.freeze({
      band: "review",
      cipher: encryptedFieldForRpc(decision),
      reasonCodes: input.plan.validatedPlan.reasonCodes,
      verificationMac: keyedMacForRpc(decisionMac)
    }),
    generatedBlock: null,
    noteWrite: null,
    outcome: "review",
    receipt: Object.freeze({
      cipher: encryptedFieldForRpc(receipt),
      verificationMac: keyedMacForRpc(receiptMac)
    }),
    review: Object.freeze({
      cipher: encryptedFieldForRpc(review),
      type: reviewType(input.reviewReason),
      verificationMac: keyedMacForRpc(reviewMac)
    }),
    reviewReason: input.reviewReason
  });
}

async function sealRoutedCommand(
  input: Parameters<OrganizerCipher["sealCommand"]>[0]
): Promise<AtomicOrganizerCommand> {
  const hasGeneratedBlock = input.plan.kind !== "review" && input.plan.generatedBlock !== null;
  if (
    input.plan.kind === "review" ||
    hasGeneratedBlock !== (input.reviewReason === "expansion_pending") ||
    (input.plan.kind === "append" && input.destination === null) ||
    (input.plan.kind === "create" && input.destination !== null)
  ) {
    unavailable();
  }
  const applied = applyMaterializedOrganizationCommand(
    input.plan.kind === "append"
      ? {
          captureText: input.capture.rawContent,
          command: input.plan,
          currentNote: currentNote(
            input.job.ownerId,
            input.destination?.encrypted ?? unavailable(),
            input.destination?.decrypted ?? unavailable()
          ),
          idFactory: deterministicIdFactory(input.job.jobId, input.preparation.ids.decisionId),
          occurredAt: input.job.occurredAt,
          ownerId: input.job.ownerId
        }
      : {
          captureText: input.capture.rawContent,
          command: input.plan,
          idFactory: deterministicIdFactory(input.job.jobId, input.preparation.ids.decisionId),
          occurredAt: input.job.occurredAt,
          ownerId: input.job.ownerId
        }
  );
  if (
    applied.note.id !== input.preparation.noteId ||
    applied.note.currentRevision !== input.preparation.targetRevision ||
    applied.revision.id !== input.preparation.ids.revisionId ||
    applied.mutationId !== input.preparation.ids.mutationId
  ) {
    unavailable();
  }
  const noteContentPayload = NoteContentPayloadSchema.parse(applied.noteContentPayload);
  const noteRevisionPayload = NoteRevisionPayloadSchema.parse(applied.noteRevisionPayload);
  const noteMutationPayload = NoteMutationPayloadSchema.parse(applied.noteMutationPayload);
  const generatedBlockValue =
    input.plan.generatedBlock === null
      ? null
      : GeneratedBlockPayloadSchema.parse({
          content: input.plan.generatedBlock.text,
          schemaVersion: 1
        });
  const reviewValue = generatedBlockValue === null ? null : reviewPayload(input);

  const runtime = writeAggregate(input.authority, input.preparation, [
    groupedReservation(input.preparation, 0),
    groupedReservation(input.preparation, 1),
    groupedReservation(input.preparation, 2),
    groupedReservation(input.preparation, 3),
    singleReservation(input.preparation.reservations.decision.reservationId),
    singleReservation(input.preparation.reservations.receipt.reservationId),
    ...(generatedBlockValue === null
      ? []
      : [
          singleReservation(input.preparation.reservations.generatedBlock.reservationId),
          singleReservation(input.preparation.reservations.review.reservationId)
        ])
  ]);
  const access = authorizeAggregateOwner({
    authenticatedOwnerId: input.job.ownerId,
    resourceOwnerId: input.job.ownerId
  });
  const transition = Object.freeze({
    after: "ai_assisted" as const,
    before: input.preparation.mode === "create" ? null : ("ai_assisted" as const)
  });
  const requestPayloadCodec = jsonPayloadCodec<OrganizerWriteRequestPayload & JsonValue>();
  const responsePayloadCodec = jsonPayloadCodec<OrganizerWriteResponsePayload & JsonValue>();
  const request = logicalRequest(input);
  const idempotencyKey = `organizer:${input.job.jobId}`;
  const requestMac = await runtime.aggregate.createIdempotencyRequestMac(access, {
    idempotencyKey,
    keyReference: contentMacReference(input.authority, input.preparation),
    logicalRequest: request,
    requestCodec: requestPayloadCodec,
    transition
  });
  const noteCipher = await runtime.aggregate.sealNoteContent(access, {
    currentRevision: applied.note.currentRevision,
    noteId: applied.note.id,
    payload: noteContentPayload,
    privacy: "ai_assisted"
  });
  const revision = await runtime.aggregate.sealNoteRevision(access, {
    payload: noteRevisionPayload,
    revision: applied.note.currentRevision,
    revisionId: input.preparation.ids.revisionId,
    transition
  });
  const mutation = await runtime.aggregate.sealNoteMutation(access, {
    afterRevision: applied.note.currentRevision,
    mutationId: input.preparation.ids.mutationId,
    payload: noteMutationPayload
  });
  const responseValue: OrganizerWriteResponsePayload = Object.freeze({
    jobId: input.job.jobId,
    mutationId: input.preparation.ids.mutationId,
    noteId: applied.note.id,
    revision: applied.note.currentRevision,
    schemaVersion: 1
  });
  const responseCipher = await runtime.aggregate.sealIdempotencyResponse(access, {
    idempotencyKey,
    response: responseValue,
    responseCodec: responsePayloadCodec,
    transition
  });
  const decisionValue = decisionPayload(input);
  const decision = await runtime.aggregate.sealOrganizationDecision(access, {
    decisionId: input.preparation.ids.decisionId,
    payload: decisionValue
  });
  const receiptValue = routedReceipt(input, applied);
  const receipt = await runtime.aggregate.sealCaptureReceipt(access, {
    captureId: input.job.captureId,
    payload: receiptValue,
    recordVersion: 1,
    sourcePrivacy: "ai_assisted"
  });
  const generatedBlock =
    generatedBlockValue === null || input.plan.generatedBlock === null
      ? null
      : await runtime.aggregate.sealGeneratedBlock(access, {
          blockId: input.plan.generatedBlock.blockId,
          payload: generatedBlockValue
        });
  const review =
    reviewValue === null
      ? null
      : await runtime.aggregate.sealReview(access, {
          payload: reviewValue,
          recordVersion: 1,
          reviewId: input.preparation.ids.reviewItemId,
          sourcePrivacy: "ai_assisted"
        });
  runtime.assertConsumed();

  const [noteMac, mutationMac, responseMac, decisionMac, receiptMac] = await Promise.all([
    runtime.aggregate.createAggregateVerificationMac(access, {
      noteId: applied.note.id,
      payload: noteContentPayload,
      privacy: "ai_assisted",
      recordVersion: applied.note.currentRevision,
      surface: "note_content"
    }),
    runtime.aggregate.createAggregateVerificationMac(access, {
      mutationId: input.preparation.ids.mutationId,
      payload: noteMutationPayload,
      recordVersion: applied.note.currentRevision,
      surface: "note_mutation"
    }),
    runtime.aggregate.createAggregateVerificationMac(access, {
      idempotencyKey,
      payload: responseValue as OrganizerWriteResponsePayload & JsonValue,
      payloadCodec: responsePayloadCodec,
      surface: "idempotency_response",
      transition
    }),
    runtime.aggregate.createAggregateVerificationMac(access, {
      decisionId: input.preparation.ids.decisionId,
      payload: decisionValue,
      surface: "organization_decision"
    }),
    runtime.aggregate.createAggregateVerificationMac(access, {
      captureId: input.job.captureId,
      payload: receiptValue,
      recordVersion: 1,
      sourcePrivacy: "ai_assisted",
      surface: "capture_receipt"
    })
  ]);
  const generatedBlockMac =
    generatedBlockValue === null || input.plan.generatedBlock === null
      ? null
      : await runtime.aggregate.createAggregateVerificationMac(access, {
          blockId: input.plan.generatedBlock.blockId,
          payload: generatedBlockValue,
          surface: "generated_block"
        });
  const reviewMac =
    reviewValue === null
      ? null
      : await runtime.aggregate.createAggregateVerificationMac(access, {
          payload: reviewValue,
          recordVersion: 1,
          reviewId: input.preparation.ids.reviewItemId,
          sourcePrivacy: "ai_assisted",
          surface: "review_item"
        });

  const idempotencyRecord = Object.freeze({
    idempotencyKey,
    keyClass: "ai_assisted" as const,
    ownerId: input.job.ownerId,
    requestMac,
    response: responseCipher
  });
  const opened = await Promise.all([
    runtime.aggregate.openNoteContent(access, noteCipher, {
      currentRevision: applied.note.currentRevision,
      noteId: applied.note.id,
      privacy: "ai_assisted"
    }),
    runtime.aggregate.openNoteRevision(access, revision, {
      revision: applied.note.currentRevision,
      revisionId: input.preparation.ids.revisionId,
      transition
    }),
    runtime.aggregate.openNoteMutation(access, mutation, {
      afterRevision: applied.note.currentRevision,
      mutationId: input.preparation.ids.mutationId,
      transition
    }),
    runtime.aggregate.openIdempotencyResponse(access, idempotencyRecord, {
      idempotencyKey,
      logicalRequest: request,
      requestCodec: requestPayloadCodec,
      responseCodec: responsePayloadCodec,
      transition
    })
  ]);
  if (
    !sameCanonical(opened[0], noteContentPayload) ||
    !sameCanonical(opened[1], noteRevisionPayload) ||
    !sameCanonical(opened[2], noteMutationPayload) ||
    !sameCanonical(opened[3], responseValue)
  ) {
    unavailable();
  }
  await Promise.all([
    assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, noteMac, {
        noteId: applied.note.id,
        payload: noteContentPayload,
        privacy: "ai_assisted",
        recordVersion: applied.note.currentRevision,
        surface: "note_content"
      })
    ),
    assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, mutationMac, {
        mutationId: input.preparation.ids.mutationId,
        payload: noteMutationPayload,
        recordVersion: applied.note.currentRevision,
        surface: "note_mutation"
      })
    ),
    assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, responseMac, {
        idempotencyKey,
        payload: responseValue as OrganizerWriteResponsePayload & JsonValue,
        payloadCodec: responsePayloadCodec,
        surface: "idempotency_response",
        transition
      })
    ),
    assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, decisionMac, {
        decisionId: input.preparation.ids.decisionId,
        payload: decisionValue,
        surface: "organization_decision"
      })
    ),
    assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, receiptMac, {
        captureId: input.job.captureId,
        payload: receiptValue,
        recordVersion: 1,
        sourcePrivacy: "ai_assisted",
        surface: "capture_receipt"
      })
    )
  ]);
  if (
    generatedBlockValue !== null &&
    input.plan.generatedBlock !== null &&
    generatedBlockMac !== null
  ) {
    await assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, generatedBlockMac, {
        blockId: input.plan.generatedBlock.blockId,
        payload: generatedBlockValue,
        surface: "generated_block"
      })
    );
  }
  if (reviewValue !== null && reviewMac !== null) {
    await assertVerification(
      runtime.aggregate.verifyAggregateVerificationMac(access, reviewMac, {
        payload: reviewValue,
        recordVersion: 1,
        reviewId: input.preparation.ids.reviewItemId,
        sourcePrivacy: "ai_assisted",
        surface: "review_item"
      })
    );
  }

  const mutationProjection =
    input.preparation.mode === "create"
      ? Object.freeze({
          inverse: Object.freeze({ type: "soft_delete_created_note" as const }),
          operations: Object.freeze([Object.freeze({ type: "create_note" as const })])
        })
      : Object.freeze({
          inverse: Object.freeze([
            Object.freeze({ privacy: "ai_assisted" as const, type: "set_privacy" as const })
          ]),
          operations: Object.freeze([
            Object.freeze({ privacy: "ai_assisted" as const, type: "set_privacy" as const })
          ])
        });
  return Object.freeze({
    decision: Object.freeze({
      band: "auto",
      cipher: encryptedFieldForRpc(decision),
      reasonCodes: input.plan.validatedPlan.reasonCodes,
      verificationMac: keyedMacForRpc(decisionMac)
    }),
    generatedBlock:
      generatedBlock === null || generatedBlockMac === null || input.plan.generatedBlock === null
        ? null
        : Object.freeze({
            cipher: encryptedFieldForRpc(generatedBlock),
            kind: input.plan.generatedBlock.kind,
            modelId: input.job.modelId,
            promptVersion: input.job.promptVersion,
            verificationMac: keyedMacForRpc(generatedBlockMac)
          }),
    noteWrite: Object.freeze({
      mutation: Object.freeze({
        cipher: encryptedFieldForRpc(mutation),
        decisionId: input.preparation.mode === "create" ? null : input.preparation.ids.decisionId,
        id: input.preparation.ids.mutationId,
        inverse: mutationProjection.inverse,
        operations: mutationProjection.operations,
        undoTargetMutationId: null
      }),
      noteCipher: encryptedFieldForRpc(noteCipher),
      noteState: publicNoteState(input, applied),
      occurredAt: input.job.occurredAt,
      requestMac: keyedMacForRpc(requestMac),
      responseCipher: encryptedFieldForRpc(responseCipher),
      revision: Object.freeze({
        actor: "organization:organizer",
        cipher: encryptedFieldForRpc(revision.encrypted),
        id: input.preparation.ids.revisionId,
        mac: keyedMacForRpc(revision.contentMac),
        source: "organization"
      }),
      verification: Object.freeze({
        idempotencyResponse: keyedMacForRpc(responseMac),
        noteContent: keyedMacForRpc(noteMac),
        noteMutation: keyedMacForRpc(mutationMac)
      })
    }),
    outcome: input.plan.kind === "create" ? "created" : "appended",
    receipt: Object.freeze({
      cipher: encryptedFieldForRpc(receipt),
      verificationMac: keyedMacForRpc(receiptMac)
    }),
    review:
      review === null || reviewMac === null
        ? null
        : Object.freeze({
            cipher: encryptedFieldForRpc(review),
            type: "pending_expansion",
            verificationMac: keyedMacForRpc(reviewMac)
          }),
    reviewReason: hasGeneratedBlock ? "expansion_pending" : null
  });
}

export function createProductionOrganizerCipher(): OrganizerCipher {
  return Object.freeze({
    async openCapture(input) {
      assertActive(input.signal);
      try {
        const parseRecord = managedKeyRecordParserForOrganizerAuthority(input.authority);
        const bound = parsedProjection(input.job.ownerId, input.job.source, parseRecord, {
          keyClass: "ai_assisted",
          kind: "capture",
          recordVersion: 1,
          resourceId: input.job.captureId
        });
        const authentication = captureAuthentication(
          input.job.ownerId,
          input.job.source,
          parseRecord
        );
        const aggregate = readAggregate(input.authority, [bound.key, authentication.key]);
        const access = authorizeAggregateOwner({
          authenticatedOwnerId: input.job.ownerId,
          resourceOwnerId: input.job.ownerId
        });
        const payload = await aggregate.openCapture(
          access,
          Object.freeze({ encrypted: bound.record, contentMac: authentication.contentMac }),
          {
            captureId: input.job.captureId,
            privacy: "ai_assisted",
            recordVersion: 1
          }
        );
        assertActive(input.signal);
        return Object.freeze({
          controls: input.job.controls,
          rawContent: payload.rawContent,
          guidance: payload.guidance ?? null
        });
      } catch {
        return unavailable();
      }
    },
    async openCaptureAttachments(input) {
      assertActive(input.signal);
      try {
        const parseRecord = managedKeyRecordParserForOrganizerAuthority(input.authority);
        const access = authorizeAggregateOwner({
          authenticatedOwnerId: input.job.ownerId,
          resourceOwnerId: input.job.ownerId
        });
        const opened: DecryptedAttachment[] = [];
        for (const attachment of input.attachments) {
          const bound = parsedProjection(input.job.ownerId, attachment.source, parseRecord, {
            keyClass: "ai_assisted",
            kind: "capture_attachment",
            recordVersion: 1,
            resourceId: attachment.attachmentId
          });
          const authentication = captureAuthentication(
            input.job.ownerId,
            attachment.source,
            parseRecord
          );
          const aggregate = readAggregate(input.authority, [bound.key, authentication.key]);
          const payload = await aggregate.openCaptureAttachment(
            access,
            Object.freeze({ encrypted: bound.record, contentMac: authentication.contentMac }),
            {
              attachmentId: attachment.attachmentId,
              captureId: input.job.captureId,
              privacy: "ai_assisted",
              recordVersion: 1
            }
          );
          if (
            payload.kind !== attachment.kind ||
            payload.mediaType !== attachment.mediaType ||
            payload.byteLength !== attachment.byteLength ||
            (payload.width ?? null) !== attachment.width ||
            (payload.height ?? null) !== attachment.height ||
            (payload.durationMs ?? null) !== attachment.durationMs
          )
            return unavailable();
          opened.push(
            Object.freeze({
              attachmentId: attachment.attachmentId,
              kind: attachment.kind,
              mediaType: attachment.mediaType,
              dataBase64: payload.dataBase64,
              byteLength: attachment.byteLength,
              width: attachment.width,
              height: attachment.height,
              durationMs: attachment.durationMs
            })
          );
          assertActive(input.signal);
        }
        return Object.freeze(opened);
      } catch {
        return unavailable();
      }
    },
    async openCandidate(input) {
      assertActive(input.signal);
      try {
        const bound = parsedProjection(
          input.ownerId,
          input.candidate.source,
          managedKeyRecordParserForOrganizerAuthority(input.authority),
          {
            keyClass: "ai_assisted",
            kind: "note_content",
            recordVersion: input.candidate.revision,
            resourceId: input.candidate.noteId
          }
        );
        const aggregate = readAggregate(input.authority, [bound.key]);
        const access = authorizeAggregateOwner({
          authenticatedOwnerId: input.ownerId,
          resourceOwnerId: input.ownerId
        });
        const payload = await aggregate.openNoteContent(access, bound.record, {
          currentRevision: input.candidate.revision,
          noteId: input.candidate.noteId,
          privacy: "ai_assisted"
        });
        assertActive(input.signal);
        return Object.freeze({
          bodyMarkdown: payload.bodyMarkdown,
          candidateId: input.candidate.candidateId,
          isOpen: input.candidate.isOpen,
          noteId: input.candidate.noteId,
          noteType: input.candidate.noteType,
          revision: input.candidate.revision,
          structuredData: payload.structuredData,
          title: payload.title
        });
      } catch {
        return unavailable();
      }
    },
    async sealCommand(input) {
      assertActive(input.signal);
      try {
        assertPreparationBinding(input);
        const command =
          input.plan.kind === "review"
            ? await sealReviewCommand(input)
            : await sealRoutedCommand(input);
        assertActive(input.signal);
        return command;
      } catch {
        return unavailable();
      }
    }
  });
}
