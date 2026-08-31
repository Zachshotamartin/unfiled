import type { EntityId } from "@unfiled/contracts";
import {
  type AuthorizedOwnerAccess,
  type BackfillVerificationMacInput,
  type EncryptedAggregateService,
  type EncryptedIdempotencyRecord,
  type JsonValue,
  type KeyedMacRecord,
  type PayloadCodec,
  type PrivacyTransition,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import { isDeepStrictEqual } from "node:util";

import type { CaptureContentProtector } from "@/server/captures/content-protection";

import {
  encryptedLibrarySurfaces,
  verifiableEncryptedContentSurfaces,
  type BackfillableEncryptedLibrarySurface,
  type ContentEncryptionBackfillCandidate,
  type EncryptedLibraryObject,
  type EncryptedLibraryRpcStore,
  type EncryptedLibrarySurface,
  type VerifiableEncryptedContentSurface
} from "./encrypted-library-rpc-store";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 50;
const IDEMPOTENCY_RESOURCE_PREFIX = "idempotency:";
const COMPLETION_REFERENCE = "content-encryption-backfill-complete-v1";

type PreparedBackfillWrite<Surface extends BackfillableEncryptedLibrarySurface> = Readonly<{
  cipher: SealedEncryptedAggregateRecord<Surface>;
  contentMac: KeyedMacRecord | null;
  verificationMac: KeyedMacRecord;
}>;

type LegacyIdempotencyResponse = Readonly<{
  resourceType: "legacy_response";
  resourceId: string;
  recordVersion: 1;
}>;

export type IdempotencyVerificationCodecCoordinates = Readonly<{
  ownerId: string;
  scope: string;
  requestResourceType: string;
  requestResourceId: string;
  responseResourceType: string;
  responseResourceId: string;
  responseRecordVersion: number;
}>;

export type EncryptedLibraryBackfillDependencies = Readonly<{
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  legacyCaptureProtector: Pick<CaptureContentProtector, "openCapture">;
  ownerId: string;
  resolveIdempotencyResponseCodec(
    coordinates: IdempotencyVerificationCodecCoordinates
  ): PayloadCodec<JsonValue> | null;
  store: EncryptedLibraryRpcStore;
}>;

export type RunEncryptedLibraryBackfillBatchInput = Readonly<{
  ownerId: string;
  afterCursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}>;

export type EncryptedLibraryBackfillBatchResult = Readonly<{
  complete: boolean;
  cursor: string | null;
  processed: number;
  resources: readonly Readonly<{
    surface: EncryptedLibrarySurface;
    resourceId: string;
    recordVersion: number;
    replayed: boolean;
  }>[];
}>;

export type VerificationSweepCursor = Readonly<{
  surface: VerifiableEncryptedContentSurface;
  afterResourceId: string | null;
}>;

export type SweepEncryptedLibraryVerificationInput = Readonly<{
  ownerId: string;
  cursor?: VerificationSweepCursor | null;
  limit?: number;
  signal?: AbortSignal;
}>;

export type EncryptedLibraryVerificationSweepResult = Readonly<{
  complete: boolean;
  cursor: VerificationSweepCursor | null;
  processed: number;
  skippedLegacyIdempotency: number;
}>;

export type EncryptedLibraryBackfillOrchestrator = Readonly<{
  runBackfillBatch(
    input: RunEncryptedLibraryBackfillBatchInput
  ): Promise<EncryptedLibraryBackfillBatchResult>;
  sweepVerificationBatch(
    input: SweepEncryptedLibraryVerificationInput
  ): Promise<EncryptedLibraryVerificationSweepResult>;
}>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function failClosed(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function batchLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BATCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) invalidInput();
  return limit;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) failClosed();
}

function exactClassTransition(keyClass: "ai_assisted" | "private_manual"): PrivacyTransition {
  return Object.freeze({ before: null, after: keyClass });
}

function revisionTransition(
  keyClass: "ai_assisted" | "private_manual",
  after: "ai_assisted" | "private_manual"
): PrivacyTransition {
  if (keyClass === "ai_assisted") {
    if (after !== "ai_assisted") failClosed();
    return Object.freeze({ before: null, after });
  }
  return Object.freeze({
    before: after === "ai_assisted" ? "private_manual" : null,
    after
  });
}

function legacyResponseCodec(
  expected: LegacyIdempotencyResponse
): PayloadCodec<LegacyIdempotencyResponse> {
  return Object.freeze({
    parse(value: unknown): LegacyIdempotencyResponse {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join("|") !== "recordVersion|resourceId|resourceType" ||
        (value as Readonly<Record<string, unknown>>).resourceType !== expected.resourceType ||
        (value as Readonly<Record<string, unknown>>).resourceId !== expected.resourceId ||
        (value as Readonly<Record<string, unknown>>).recordVersion !== expected.recordVersion
      ) {
        throw new TypeError("Legacy response is invalid");
      }
      return expected;
    }
  });
}

function idempotencyKey(resourceId: string): string {
  if (!resourceId.startsWith(IDEMPOTENCY_RESOURCE_PREFIX)) failClosed();
  const value = resourceId.slice(IDEMPOTENCY_RESOURCE_PREFIX.length);
  if (value.length < 1 || value.length > 80) failClosed();
  return value;
}

async function finalizePreparedWrite<Surface extends BackfillableEncryptedLibrarySurface, Payload>(
  dependencies: EncryptedLibraryBackfillDependencies,
  candidate: ContentEncryptionBackfillCandidate<Surface>,
  verificationInput: BackfillVerificationMacInput<Payload>,
  cipher: SealedEncryptedAggregateRecord<Surface>,
  contentMac: KeyedMacRecord | null,
  opened: unknown,
  expected: unknown
): Promise<PreparedBackfillWrite<Surface>> {
  if (
    !isDeepStrictEqual(opened, expected) ||
    cipher.ownerId !== candidate.ownerId ||
    cipher.resourceId !== candidate.resourceId ||
    cipher.recordVersion !== candidate.recordVersion ||
    cipher.kind !== candidate.surface ||
    cipher.keyClass !== candidate.keyClass ||
    (contentMac !== null && contentMac.keyClass !== candidate.keyClass)
  ) {
    failClosed();
  }
  const verificationMac = await dependencies.aggregate.createBackfillVerificationMac(
    dependencies.access,
    verificationInput
  );
  if (
    verificationMac.keyClass !== candidate.keyClass ||
    !(await dependencies.aggregate.verifyBackfillVerificationMac(
      dependencies.access,
      verificationMac,
      verificationInput
    ))
  ) {
    failClosed();
  }
  return Object.freeze({ cipher, contentMac, verificationMac });
}

async function prepareBackfillWrite(
  dependencies: EncryptedLibraryBackfillDependencies,
  candidateValue: ContentEncryptionBackfillCandidate<BackfillableEncryptedLibrarySurface>
): Promise<PreparedBackfillWrite<BackfillableEncryptedLibrarySurface>> {
  const { aggregate, access } = dependencies;
  switch (candidateValue.surface) {
    case "space_display": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"space_display">;
      const input = Object.freeze({
        surface: candidate.surface,
        spaceId: candidate.resourceId as EntityId<"spc">,
        currentRevision: candidate.recordVersion,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealSpaceDisplay(access, input);
      const opened = await aggregate.openSpaceDisplay(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed.encrypted,
        sealed.contentMac,
        opened,
        input.payload
      );
    }
    case "tag_display": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"tag_display">;
      const input = Object.freeze({
        surface: candidate.surface,
        tagId: candidate.resourceId as EntityId<"tag">,
        currentRevision: candidate.recordVersion,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealTagDisplay(access, input);
      const opened = await aggregate.openTagDisplay(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed.encrypted,
        sealed.contentMac,
        opened,
        input.payload
      );
    }
    case "note_content": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"note_content">;
      const input = Object.freeze({
        surface: candidate.surface,
        noteId: candidate.resourceId as EntityId<"note">,
        currentRevision: candidate.recordVersion,
        privacy: candidate.operational.privacy,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealNoteContent(access, input);
      const opened = await aggregate.openNoteContent(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed,
        null,
        opened,
        input.payload
      );
    }
    case "note_revision": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"note_revision">;
      const transition = revisionTransition(
        candidate.keyClass,
        candidate.expectedContent.snapshot.privacy
      );
      const input = Object.freeze({
        surface: candidate.surface,
        revisionId: candidate.resourceId as EntityId<"rev">,
        revision: candidate.recordVersion,
        transition,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealNoteRevision(access, input);
      const opened = await aggregate.openNoteRevision(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed.encrypted,
        sealed.contentMac,
        opened,
        input.payload
      );
    }
    case "organization_decision": {
      const candidate =
        candidateValue as ContentEncryptionBackfillCandidate<"organization_decision">;
      const input = Object.freeze({
        surface: candidate.surface,
        decisionId: candidate.resourceId as EntityId<"dec">,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealOrganizationDecision(access, input);
      const opened = await aggregate.openOrganizationDecision(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed,
        null,
        opened,
        input.payload
      );
    }
    case "note_mutation": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"note_mutation">;
      const transition = Object.freeze({
        before: candidate.expectedContent.beforeSnapshot?.privacy ?? null,
        after: candidate.expectedContent.afterSnapshot.privacy
      });
      const input = Object.freeze({
        surface: candidate.surface,
        mutationId: candidate.resourceId as EntityId<"mut">,
        afterRevision: candidate.recordVersion,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealNoteMutation(access, input);
      const opened = await aggregate.openNoteMutation(access, sealed, {
        mutationId: input.mutationId,
        afterRevision: input.afterRevision,
        transition
      });
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed,
        null,
        opened,
        input.payload
      );
    }
    case "generated_block": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"generated_block">;
      const input = Object.freeze({
        surface: candidate.surface,
        blockId: candidate.resourceId as EntityId<"blk">,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealGeneratedBlock(access, input);
      const opened = await aggregate.openGeneratedBlock(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed,
        null,
        opened,
        input.payload
      );
    }
    case "review_item": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"review_item">;
      const input = Object.freeze({
        surface: candidate.surface,
        reviewId: candidate.resourceId as EntityId<"rvw">,
        recordVersion: candidate.recordVersion,
        sourcePrivacy: candidate.keyClass,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealReview(access, input);
      const opened = await aggregate.openReview(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed,
        null,
        opened,
        input.payload
      );
    }
    case "routing_rule": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"routing_rule">;
      const input = Object.freeze({
        surface: candidate.surface,
        ruleId: candidate.resourceId as EntityId<"rule">,
        recordVersion: candidate.recordVersion,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealRoutingRule(access, input);
      const opened = await aggregate.openRoutingRule(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed,
        null,
        opened,
        input.payload
      );
    }
    case "organization_mutation_attempt": {
      const candidate =
        candidateValue as ContentEncryptionBackfillCandidate<"organization_mutation_attempt">;
      const input = Object.freeze({
        surface: candidate.surface,
        jobId: candidate.operational.jobId as EntityId<"job">,
        noteId: candidate.operational.noteId as EntityId<"note">,
        recordVersion: candidate.recordVersion,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealOrganizationMutationAttempt(access, input);
      const opened = await aggregate.openOrganizationMutationAttempt(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed,
        null,
        opened,
        input.payload
      );
    }
    case "idempotency_response": {
      const candidate =
        candidateValue as ContentEncryptionBackfillCandidate<"idempotency_response">;
      if (candidate.operational.replayPolicy !== "legacy_nonreplayable") failClosed();
      const response = Object.freeze({
        resourceType: candidate.expectedContent.responseResourceType,
        resourceId: candidate.expectedContent.responseResourceId,
        recordVersion: candidate.expectedContent.responseRecordVersion
      }) as LegacyIdempotencyResponse;
      const responseCodec = legacyResponseCodec(response);
      const transition = exactClassTransition(candidate.keyClass);
      const key = idempotencyKey(candidate.resourceId);
      const verificationInput = Object.freeze({
        surface: candidate.surface,
        idempotencyKey: key,
        transition,
        payload: response,
        payloadCodec: responseCodec
      });
      const cipher = await aggregate.sealIdempotencyResponse(access, {
        idempotencyKey: key,
        transition,
        response,
        responseCodec
      });
      const verificationMac = await aggregate.createBackfillVerificationMac(
        access,
        verificationInput
      );
      const verificationRecord: EncryptedIdempotencyRecord = Object.freeze({
        ownerId: candidate.ownerId,
        idempotencyKey: key,
        keyClass: candidate.keyClass,
        requestMac: verificationMac,
        response: cipher
      });
      const opened = await aggregate.openIdempotencyResponseForVerification(
        access,
        verificationRecord,
        { idempotencyKey: key, responseCodec }
      );
      if (
        !isDeepStrictEqual(opened, response) ||
        cipher.keyClass !== candidate.keyClass ||
        verificationMac.keyClass !== candidate.keyClass ||
        !(await aggregate.verifyBackfillVerificationMac(access, verificationMac, verificationInput))
      ) {
        failClosed();
      }
      return Object.freeze({ cipher, contentMac: null, verificationMac });
    }
    case "capture_receipt": {
      const candidate = candidateValue as ContentEncryptionBackfillCandidate<"capture_receipt">;
      const input = Object.freeze({
        surface: candidate.surface,
        captureId: candidate.resourceId as EntityId<"cap">,
        recordVersion: candidate.recordVersion,
        sourcePrivacy: candidate.keyClass,
        payload: candidate.expectedContent
      });
      const sealed = await aggregate.sealCaptureReceipt(access, input);
      const opened = await aggregate.openCaptureReceipt(access, sealed, input);
      return finalizePreparedWrite(
        dependencies,
        candidate,
        input,
        sealed,
        null,
        opened,
        input.payload
      );
    }
  }
}

async function resealCaptureCandidate(
  dependencies: EncryptedLibraryBackfillDependencies,
  candidate: ContentEncryptionBackfillCandidate<"capture">,
  signal: AbortSignal | undefined
): Promise<boolean> {
  assertNotAborted(signal);
  const rawContent = await dependencies.legacyCaptureProtector.openCapture(
    {
      envelope: candidate.expectedContent.contentEnvelope,
      fingerprint: candidate.expectedContent.contentFingerprint,
      length: candidate.operational.contentLength
    },
    candidate.ownerId,
    candidate.resourceId
  );
  assertNotAborted(signal);
  const input = Object.freeze({
    surface: candidate.surface,
    captureId: candidate.resourceId as EntityId<"cap">,
    recordVersion: candidate.recordVersion,
    privacy: candidate.operational.privacy,
    payload: Object.freeze({ schemaVersion: 1 as const, rawContent })
  });
  const sealed = await dependencies.aggregate.sealCapture(dependencies.access, input);
  const opened = await dependencies.aggregate.openCapture(dependencies.access, sealed, input);
  const verificationMac = await dependencies.aggregate.createBackfillVerificationMac(
    dependencies.access,
    input
  );
  if (
    !isDeepStrictEqual(opened, input.payload) ||
    sealed.encrypted.keyClass !== candidate.keyClass ||
    sealed.contentMac.keyClass !== candidate.keyClass ||
    verificationMac.keyClass !== candidate.keyClass ||
    !(await dependencies.aggregate.verifyBackfillVerificationMac(
      dependencies.access,
      verificationMac,
      input
    ))
  ) {
    failClosed();
  }
  assertNotAborted(signal);
  const result = await dependencies.store.resealCaptureContent({
    ownerId: candidate.ownerId,
    captureId: candidate.resourceId,
    expectedEnvelope: candidate.expectedContent.contentEnvelope,
    expectedFingerprint: candidate.expectedContent.contentFingerprint,
    contentCipher: sealed.encrypted,
    contentMac: sealed.contentMac,
    verificationMac
  });
  assertNotAborted(signal);
  return result.replayed;
}

function sweepStartIndex(cursor: VerificationSweepCursor | null | undefined): number {
  if (cursor === undefined || cursor === null) return 0;
  const index = verifiableEncryptedContentSurfaces.indexOf(cursor.surface);
  if (index < 0) invalidInput();
  return index;
}

async function verifyStoredObject(
  dependencies: EncryptedLibraryBackfillDependencies,
  objectValue: EncryptedLibraryObject<VerifiableEncryptedContentSurface>,
  signal: AbortSignal | undefined
): Promise<"verified" | "legacy_skipped"> {
  const { aggregate, access, store } = dependencies;
  if (objectValue.surface === "note_content") {
    const object = objectValue as EncryptedLibraryObject<"note_content">;
    const payload = await aggregate.openNoteContent(access, object.encrypted, {
      noteId: object.resourceId as EntityId<"note">,
      currentRevision: object.recordVersion,
      privacy: object.operational.privacy
    });
    const input = Object.freeze({
      surface: object.surface,
      noteId: object.resourceId as EntityId<"note">,
      recordVersion: object.recordVersion,
      privacy: object.operational.privacy,
      payload
    });
    const mac = await aggregate.createAggregateVerificationMac(access, input);
    if (!(await aggregate.verifyAggregateVerificationMac(access, mac, input))) failClosed();
    assertNotAborted(signal);
    await store.verifyEncryptedContentObject({
      ownerId: object.ownerId,
      surface: object.surface,
      resourceId: object.resourceId,
      expectedRecordVersion: object.recordVersion,
      expectedEnvelope: object.encrypted.envelope,
      verificationMac: mac
    });
    assertNotAborted(signal);
    return "verified";
  }
  if (objectValue.surface === "note_mutation") {
    const object = objectValue as EncryptedLibraryObject<"note_mutation">;
    const payload = await aggregate.openNoteMutationForVerification(access, object.encrypted, {
      mutationId: object.resourceId as EntityId<"mut">,
      afterRevision: object.recordVersion
    });
    const input = Object.freeze({
      surface: object.surface,
      mutationId: object.resourceId as EntityId<"mut">,
      recordVersion: object.recordVersion,
      payload
    });
    const mac = await aggregate.createAggregateVerificationMac(access, input);
    if (!(await aggregate.verifyAggregateVerificationMac(access, mac, input))) failClosed();
    assertNotAborted(signal);
    await store.verifyEncryptedContentObject({
      ownerId: object.ownerId,
      surface: object.surface,
      resourceId: object.resourceId,
      expectedRecordVersion: object.recordVersion,
      expectedEnvelope: object.encrypted.envelope,
      verificationMac: mac
    });
    assertNotAborted(signal);
    return "verified";
  }

  const object = objectValue as EncryptedLibraryObject<"idempotency_response">;
  if (object.operational.replayPolicy === "legacy_nonreplayable") return "legacy_skipped";
  if (object.operational.requestMac === null) failClosed();
  const codec = dependencies.resolveIdempotencyResponseCodec({
    ownerId: object.ownerId,
    scope: object.operational.scope,
    requestResourceType: object.operational.requestResourceType,
    requestResourceId: object.operational.requestResourceId,
    responseResourceType: object.operational.responseResourceType,
    responseResourceId: object.operational.responseResourceId,
    responseRecordVersion: object.operational.responseRecordVersion
  });
  if (codec === null) failClosed();
  const key = idempotencyKey(object.resourceId);
  const record: EncryptedIdempotencyRecord = Object.freeze({
    ownerId: object.ownerId,
    idempotencyKey: key,
    keyClass: object.encrypted.keyClass,
    requestMac: object.operational.requestMac,
    response: object.encrypted
  });
  const payload = await aggregate.openIdempotencyResponseForVerification(access, record, {
    idempotencyKey: key,
    responseCodec: codec
  });
  const transition = exactClassTransition(object.encrypted.keyClass);
  const input = Object.freeze({
    surface: object.surface,
    idempotencyKey: key,
    transition,
    payload,
    payloadCodec: codec
  });
  const mac = await aggregate.createAggregateVerificationMac(access, input);
  if (!(await aggregate.verifyAggregateVerificationMac(access, mac, input))) failClosed();
  assertNotAborted(signal);
  await store.verifyEncryptedContentObject({
    ownerId: object.ownerId,
    surface: object.surface,
    resourceId: object.resourceId,
    expectedRecordVersion: object.recordVersion,
    expectedEnvelope: object.encrypted.envelope,
    verificationMac: mac
  });
  assertNotAborted(signal);
  return "verified";
}

export function createEncryptedLibraryBackfillOrchestrator(
  dependencies: EncryptedLibraryBackfillDependencies
): EncryptedLibraryBackfillOrchestrator {
  return Object.freeze({
    async runBackfillBatch(input) {
      if (input.ownerId !== dependencies.ownerId) invalidInput();
      const limit = batchLimit(input.limit);
      let cursor = input.afterCursor ?? null;
      let processed = 0;
      const resources: Readonly<{
        surface: EncryptedLibrarySurface;
        resourceId: string;
        recordVersion: number;
        replayed: boolean;
      }>[] = [];

      for (const surface of encryptedLibrarySurfaces) {
        assertNotAborted(input.signal);
        const remaining = limit - processed;
        if (remaining === 0) break;
        const page = await dependencies.store.listContentEncryptionBackfillCandidates({
          ownerId: input.ownerId,
          surface,
          afterCursor: cursor,
          limit: remaining
        });
        for (const candidateValue of page.items) {
          assertNotAborted(input.signal);
          let replayed: boolean;
          if (candidateValue.surface === "capture") {
            replayed = await resealCaptureCandidate(
              dependencies,
              candidateValue as ContentEncryptionBackfillCandidate<"capture">,
              input.signal
            );
            // Capture reseal is its own atomic CAS and intentionally does not advance the
            // generic backfill cursor. A crash may therefore retry the same candidate from a
            // stale page; reseal_capture_content reports that replay, while a fresh candidate
            // scan drops the now-encrypted capture. Keep the last generic commit cursor so
            // completion can compare it to the rollout row exactly.
          } else {
            const candidate =
              candidateValue as ContentEncryptionBackfillCandidate<BackfillableEncryptedLibrarySurface>;
            const prepared = await prepareBackfillWrite(dependencies, candidate);
            assertNotAborted(input.signal);
            const result = await dependencies.store.commitContentEncryptionBackfill({
              ownerId: candidate.ownerId,
              surface: candidate.surface,
              resourceId: candidate.resourceId,
              expectedRecordVersion: candidate.recordVersion,
              expectedContent: candidate.expectedContent,
              cipher: prepared.cipher,
              contentMac: prepared.contentMac,
              verificationMac: prepared.verificationMac,
              batchReference: candidate.cursor,
              expectedCursor: cursor,
              nextCursor: candidate.cursor,
              complete: false
            });
            assertNotAborted(input.signal);
            cursor = result.cursor;
            replayed = result.replayed;
          }
          resources.push(
            Object.freeze({
              surface: candidateValue.surface,
              resourceId: candidateValue.resourceId,
              recordVersion: candidateValue.recordVersion,
              replayed
            })
          );
          processed += 1;
          if (processed === limit) {
            return Object.freeze({
              complete: false,
              cursor,
              processed,
              resources: Object.freeze(resources)
            });
          }
        }
      }

      assertNotAborted(input.signal);
      await dependencies.store.completeContentEncryptionBackfill({
        ownerId: input.ownerId,
        batchReference: COMPLETION_REFERENCE,
        expectedCursor: cursor
      });
      assertNotAborted(input.signal);
      return Object.freeze({
        complete: true,
        cursor: null,
        processed,
        resources: Object.freeze(resources)
      });
    },

    async sweepVerificationBatch(input) {
      if (input.ownerId !== dependencies.ownerId) invalidInput();
      const limit = batchLimit(input.limit);
      const start = sweepStartIndex(input.cursor);
      let processed = 0;
      let skippedLegacyIdempotency = 0;

      for (let index = start; index < verifiableEncryptedContentSurfaces.length; index += 1) {
        assertNotAborted(input.signal);
        const surface = verifiableEncryptedContentSurfaces[index];
        if (surface === undefined) failClosed();
        const afterResourceId = index === start ? (input.cursor?.afterResourceId ?? null) : null;
        const remaining = limit - processed;
        const page = await dependencies.store.listEncryptedLibraryObjects({
          ownerId: input.ownerId,
          surface,
          afterResourceId,
          limit: remaining
        });
        for (const object of page.items) {
          assertNotAborted(input.signal);
          const outcome = await verifyStoredObject(dependencies, object, input.signal);
          if (outcome === "legacy_skipped") skippedLegacyIdempotency += 1;
          processed += 1;
          if (processed === limit) {
            return Object.freeze({
              complete: false,
              cursor: Object.freeze({ surface, afterResourceId: object.resourceId }),
              processed,
              skippedLegacyIdempotency
            });
          }
        }
      }

      assertNotAborted(input.signal);
      return Object.freeze({
        complete: true,
        cursor: null,
        processed,
        skippedLegacyIdempotency
      });
    }
  });
}
