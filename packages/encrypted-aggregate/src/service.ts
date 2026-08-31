import {
  openBytes,
  sealBytes,
  type EncryptionContext,
  type KeyEncryptionKey
} from "@unfiled/content-crypto";
import type { KeyClass, ManagedObjectWrappingKey } from "@unfiled/key-management";

import { ownerIdFromAccess, type AuthorizedOwnerAccess } from "./authorization.js";
import { canonicalPayloadBytes, decodePayload, parsePayload } from "./canonical.js";
import {
  EncryptedAggregateError,
  EncryptedAggregateErrorCode,
  aggregateFailure
} from "./errors.js";
import { createKeyedMac, verifyKeyedMac } from "./mac.js";
import {
  CapturePayloadSchema,
  CaptureReceiptPayloadSchema,
  GeneratedBlockPayloadSchema,
  NoteContentPayloadSchema,
  NoteMutationPayloadSchema,
  NoteRevisionPayloadSchema,
  OrganizationDecisionPayloadSchema,
  OrganizationMutationAttemptPayloadSchema,
  ReviewPayloadSchema,
  RoutingRulePayloadSchema,
  SpaceDisplayPayloadSchema,
  TagDisplayPayloadSchema,
  type PayloadCodec
} from "./payloads.js";
import type {
  AggregateContentKind,
  AggregateVerificationMacInput,
  BackfillVerificationMacInput,
  CreateIdempotencyRequestMacInput,
  EncryptedAggregateRecord,
  EncryptedAggregateService,
  EncryptedAggregateServiceOptions,
  EncryptedIdempotencyRecord,
  KeyedMacRecord,
  LogicalApiRequest,
  MacProtectedEncryptedAggregateRecord,
  ObjectWrapReservation,
  PrivacyTransition,
  SealedEncryptedAggregateRecord,
  SealIdempotencyResponseInput,
  SemanticMacNamespace,
  VerifyIdempotencyRequestInput
} from "./types.js";
import {
  assertEntityId,
  assertIdentifier,
  assertRecordVersion,
  exactKeyReference,
  hasExactKeys,
  isRecord,
  parseEncryptedAggregateRecord,
  parseKeyedMacRecord,
  parsePrivacy,
  stickyKeyClass
} from "./validation.js";

const RESERVATION_KEYS = ["reservationId", "reference"] as const;
const REFERENCE_KEYS = ["ownerId", "keyClass", "purpose", "keyId", "keyVersion"] as const;
const PROTECTED_RECORD_KEYS = ["encrypted", "contentMac"] as const;
const IDEMPOTENCY_RECORD_KEYS = [
  "ownerId",
  "idempotencyKey",
  "keyClass",
  "requestMac",
  "response"
] as const;
const LOGICAL_REQUEST_KEYS = [
  "schemaVersion",
  "scope",
  "targetResourceId",
  "expectedRevision",
  "payload"
] as const;
const NOTE_RAG_INDEX_ID_PATTERN = /^irw_[0-9A-HJKMNP-TV-Z]{26}$/u;
const SCOPE_PATTERN = /^[a-z][a-z0-9_.:-]{0,99}$/u;

type ExpectedAggregate<Kind extends AggregateContentKind> = Readonly<{
  ownerId: string;
  resourceId: string;
  recordVersion: number;
  kind: Kind;
  keyClass: KeyClass;
}>;

type OpenedAggregate<Kind extends AggregateContentKind, Payload> = Readonly<{
  record: EncryptedAggregateRecord<Kind>;
  payload: Payload;
}>;

type ReservedWrappingKey = Readonly<{
  reservationId: string;
  key: ManagedObjectWrappingKey;
}>;

function expectedAggregate<Kind extends AggregateContentKind>(
  ownerId: string,
  resourceId: string,
  recordVersion: number,
  kind: Kind,
  keyClass: KeyClass
): ExpectedAggregate<Kind> {
  assertIdentifier(resourceId, "Resource identifier");
  assertRecordVersion(recordVersion);
  return Object.freeze({ ownerId, resourceId, recordVersion, kind, keyClass });
}

function contextFor<Kind extends AggregateContentKind>(
  expected: ExpectedAggregate<Kind>
): EncryptionContext {
  return Object.freeze({
    tenantId: expected.ownerId,
    resourceId: expected.resourceId,
    recordVersion: expected.recordVersion,
    kind: expected.kind
  });
}

function encryptedRecord<Kind extends AggregateContentKind>(
  expected: ExpectedAggregate<Kind>,
  envelope: Awaited<ReturnType<typeof sealBytes>>,
  reserved: ReservedWrappingKey
): SealedEncryptedAggregateRecord<Kind> {
  return Object.freeze({
    ...expected,
    envelope,
    keyId: reserved.key.reference.keyId,
    keyClass: expected.keyClass,
    keyPurpose: "object_wrap" as const,
    keyVersion: reserved.key.reference.keyVersion,
    reservationId: reserved.reservationId
  });
}

function contentMacMessage<Kind extends AggregateContentKind>(
  expected: ExpectedAggregate<Kind>,
  payload: unknown
): unknown {
  return {
    domain: "unfiled:aggregate-content-mac",
    schemaVersion: 1,
    ownerId: expected.ownerId,
    resourceId: expected.resourceId,
    recordVersion: expected.recordVersion,
    kind: expected.kind,
    payload
  };
}

function semanticMacMessage(
  ownerId: string,
  namespace: SemanticMacNamespace,
  normalizedValue: string
): unknown {
  return {
    domain: "unfiled:semantic-uniqueness-mac",
    schemaVersion: 1,
    ownerId,
    namespace,
    normalizedValue
  };
}

function replayMacMessage<Payload>(
  ownerId: string,
  idempotencyKey: string,
  logicalRequest: LogicalApiRequest<Payload>
): unknown {
  return {
    domain: "unfiled:api-replay-request",
    schemaVersion: 1,
    ownerId,
    idempotencyKey,
    logicalRequest
  };
}

type AggregateVerificationCoordinates = Readonly<{
  surface: "capture_receipt" | "note_content" | "note_mutation" | "idempotency_response";
  resourceId: string;
  recordVersion: number;
  keyClass: KeyClass;
  payload: unknown;
}>;

type BackfillVerificationCoordinates = Readonly<{
  surface: AggregateContentKind;
  resourceId: string;
  recordVersion: number;
  keyClass: KeyClass;
  payload: unknown;
}>;

function aggregateVerificationMacMessage(
  ownerId: string,
  coordinates: AggregateVerificationCoordinates
): unknown {
  return {
    domain: "unfiled:aggregate-verification",
    schemaVersion: 1,
    ownerId,
    surface: coordinates.surface,
    resourceId: coordinates.resourceId,
    recordVersion: coordinates.recordVersion,
    payload: coordinates.payload
  };
}

function backfillVerificationMacMessage(
  ownerId: string,
  coordinates: BackfillVerificationCoordinates
): unknown {
  return {
    domain: "unfiled:legacy-backfill-verification",
    schemaVersion: 1,
    ownerId,
    surface: coordinates.surface,
    resourceId: coordinates.resourceId,
    recordVersion: coordinates.recordVersion,
    payload: coordinates.payload
  };
}

function assertIdempotencyKey(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, "Idempotency key is invalid");
  }
  const resourceId = `idempotency:${value}`;
  assertIdentifier(resourceId, "Idempotency resource identifier");
  return resourceId;
}

function parseLogicalRequest<Payload>(
  value: unknown,
  codec: PayloadCodec<Payload>
): LogicalApiRequest<Payload> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, LOGICAL_REQUEST_KEYS) ||
    value.schemaVersion !== 1 ||
    typeof value.scope !== "string" ||
    !SCOPE_PATTERN.test(value.scope) ||
    (value.targetResourceId !== null && typeof value.targetResourceId !== "string") ||
    (value.expectedRevision !== null &&
      (typeof value.expectedRevision !== "number" ||
        !Number.isSafeInteger(value.expectedRevision) ||
        value.expectedRevision < 0))
  ) {
    aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, "Logical request is invalid");
  }
  if (value.targetResourceId !== null) {
    assertIdentifier(value.targetResourceId, "Target resource identifier");
  }
  return Object.freeze({
    schemaVersion: 1,
    scope: value.scope,
    targetResourceId: value.targetResourceId,
    expectedRevision: value.expectedRevision,
    payload: parsePayload(codec, value.payload)
  });
}

function privacyTransitionMatches(
  transition: PrivacyTransition,
  before: unknown,
  after: unknown
): boolean {
  return transition.before === before && transition.after === after;
}

function operationTouchesPrivate(value: Readonly<{ type: string; privacy?: unknown }>): boolean {
  return (
    (value.type === "set_privacy" || value.type === "restore_snapshot") &&
    value.privacy === "private_manual"
  );
}

function assertNoteRagIndexId(value: unknown): asserts value is `irw_${string}` {
  if (typeof value !== "string" || !NOTE_RAG_INDEX_ID_PATTERN.test(value)) {
    aggregateFailure(
      EncryptedAggregateErrorCode.INVALID_INPUT,
      "Index resource identifier is invalid"
    );
  }
}

export function createEncryptedAggregateService(
  options: EncryptedAggregateServiceOptions
): EncryptedAggregateService {
  const usedReservations = new WeakSet<object>();
  const usedReservationIds = new Set<string>();

  async function reservedWrappingKey(
    ownerId: string,
    keyClass: KeyClass
  ): Promise<ReservedWrappingKey> {
    let reservation: ObjectWrapReservation;
    try {
      reservation = await options.objectWrapReservations.reserveObjectWrappingKey({
        ownerId,
        keyClass
      });
    } catch {
      aggregateFailure(
        EncryptedAggregateErrorCode.RESERVATION_INVALID,
        "Object-wrap reservation is unavailable"
      );
    }
    if (
      !isRecord(reservation) ||
      !hasExactKeys(reservation, RESERVATION_KEYS) ||
      typeof reservation.reservationId !== "string" ||
      !isRecord(reservation.reference) ||
      !hasExactKeys(reservation.reference, REFERENCE_KEYS) ||
      typeof reservation.reference.ownerId !== "string" ||
      typeof reservation.reference.keyClass !== "string" ||
      typeof reservation.reference.purpose !== "string" ||
      typeof reservation.reference.keyId !== "string" ||
      typeof reservation.reference.keyVersion !== "number"
    ) {
      aggregateFailure(
        EncryptedAggregateErrorCode.RESERVATION_INVALID,
        "Object-wrap reservation is invalid"
      );
    }
    try {
      assertIdentifier(reservation.reservationId, "Reservation identifier");
      assertIdentifier(reservation.reference.keyId, "Key identifier");
    } catch {
      aggregateFailure(
        EncryptedAggregateErrorCode.RESERVATION_INVALID,
        "Object-wrap reservation is invalid"
      );
    }
    if (
      usedReservations.has(reservation) ||
      usedReservationIds.has(reservation.reservationId) ||
      !exactKeyReference(reservation.reference, {
        ownerId,
        keyClass,
        purpose: "object_wrap"
      })
    ) {
      aggregateFailure(
        EncryptedAggregateErrorCode.RESERVATION_INVALID,
        "Object-wrap reservation is invalid"
      );
    }
    usedReservations.add(reservation);
    usedReservationIds.add(reservation.reservationId);

    let resolved: ManagedObjectWrappingKey | null;
    try {
      resolved = await options.keyResolver.resolveObjectWrappingKey({
        ownerId,
        keyClass,
        keyId: reservation.reference.keyId
      });
    } catch {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Object-wrapping key is unavailable"
      );
    }
    if (resolved === null) {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Object-wrapping key is unavailable"
      );
    }
    if (
      resolved.key.keyId !== reservation.reference.keyId ||
      !exactKeyReference(resolved.reference, {
        ownerId,
        keyClass,
        purpose: "object_wrap",
        keyId: reservation.reference.keyId,
        keyVersion: reservation.reference.keyVersion
      })
    ) {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Object-wrapping key is unavailable"
      );
    }
    return Object.freeze({ reservationId: reservation.reservationId, key: resolved });
  }

  async function sealPayload<Kind extends AggregateContentKind, Payload>(
    expected: ExpectedAggregate<Kind>,
    payloadValue: unknown,
    codec: PayloadCodec<Payload>
  ): Promise<SealedEncryptedAggregateRecord<Kind>> {
    const encoded = canonicalPayloadBytes(codec, payloadValue);
    try {
      const reserved = await reservedWrappingKey(expected.ownerId, expected.keyClass);
      try {
        const envelope = await sealBytes(
          encoded.bytes,
          contextFor(expected),
          reserved.key.key,
          options.crypto
        );
        return encryptedRecord(expected, envelope, reserved);
      } catch (error: unknown) {
        if (error instanceof EncryptedAggregateError) throw error;
        aggregateFailure(
          EncryptedAggregateErrorCode.ENCRYPTION_FAILED,
          "Content encryption failed"
        );
      }
    } finally {
      encoded.bytes.fill(0);
    }
  }

  async function resolveOpeningKey<Kind extends AggregateContentKind>(
    record: EncryptedAggregateRecord<Kind>
  ): Promise<KeyEncryptionKey> {
    let resolved: ManagedObjectWrappingKey | null;
    try {
      resolved = await options.keyResolver.resolveObjectWrappingKey({
        ownerId: record.ownerId,
        keyClass: record.keyClass,
        keyId: record.keyId
      });
    } catch {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Object-wrapping key is unavailable"
      );
    }
    if (resolved === null) {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Object-wrapping key is unavailable"
      );
    }
    if (
      resolved.key.keyId !== record.keyId ||
      !exactKeyReference(resolved.reference, {
        ownerId: record.ownerId,
        keyClass: record.keyClass,
        purpose: "object_wrap",
        keyId: record.keyId,
        keyVersion: record.keyVersion
      })
    ) {
      aggregateFailure(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "Object-wrapping key is unavailable"
      );
    }
    return resolved.key;
  }

  async function openPayload<Kind extends AggregateContentKind, Payload>(
    recordValue: unknown,
    expected: ExpectedAggregate<Kind>,
    codec: PayloadCodec<Payload>
  ): Promise<OpenedAggregate<Kind, Payload>> {
    const record = parseEncryptedAggregateRecord(recordValue, expected);
    const key = await resolveOpeningKey(record);
    let plaintext: Uint8Array;
    try {
      plaintext = await openBytes(record.envelope, contextFor(expected), key, options.crypto);
    } catch {
      aggregateFailure(EncryptedAggregateErrorCode.DECRYPTION_FAILED, "Content decryption failed");
    }
    try {
      return Object.freeze({ record, payload: decodePayload(plaintext, codec) });
    } finally {
      plaintext.fill(0);
    }
  }

  async function sealContextMacProtected<Kind extends AggregateContentKind, Payload>(
    expected: ExpectedAggregate<Kind>,
    payloadValue: unknown,
    codec: PayloadCodec<Payload>
  ): Promise<MacProtectedEncryptedAggregateRecord<Kind>> {
    const payload = parsePayload(codec, payloadValue);
    const contentMac = await createKeyedMac(
      options.keyResolver,
      expected.ownerId,
      expected.keyClass,
      contentMacMessage(expected, payload),
      options.crypto
    );
    const encrypted = await sealPayload(expected, payload, codec);
    return Object.freeze({ encrypted, contentMac });
  }

  async function openContextMacProtected<Kind extends AggregateContentKind, Payload>(
    value: unknown,
    expected: ExpectedAggregate<Kind>,
    codec: PayloadCodec<Payload>
  ): Promise<Payload> {
    if (!isRecord(value) || !hasExactKeys(value, PROTECTED_RECORD_KEYS)) {
      aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
    }
    const opened = await openPayload(value.encrypted, expected, codec);
    const contentMac = parseKeyedMacRecord(value.contentMac, expected.keyClass);
    const valid = await verifyKeyedMac(
      options.keyResolver,
      expected.ownerId,
      contentMac,
      contentMacMessage(expected, opened.payload),
      options.crypto
    );
    if (!valid) {
      aggregateFailure(
        EncryptedAggregateErrorCode.INTEGRITY_CHECK_FAILED,
        "Content integrity check failed"
      );
    }
    return opened.payload;
  }

  async function sealSemanticMacProtected<Kind extends AggregateContentKind, Payload>(
    expected: ExpectedAggregate<Kind>,
    payloadValue: unknown,
    codec: PayloadCodec<Payload>,
    namespace: SemanticMacNamespace,
    normalizedValue: (payload: Payload) => string
  ): Promise<MacProtectedEncryptedAggregateRecord<Kind>> {
    const payload = parsePayload(codec, payloadValue);
    const contentMac = await createKeyedMac(
      options.keyResolver,
      expected.ownerId,
      expected.keyClass,
      semanticMacMessage(expected.ownerId, namespace, normalizedValue(payload)),
      options.crypto
    );
    const encrypted = await sealPayload(expected, payload, codec);
    return Object.freeze({ encrypted, contentMac });
  }

  async function openSemanticMacProtected<Kind extends AggregateContentKind, Payload>(
    value: unknown,
    expected: ExpectedAggregate<Kind>,
    codec: PayloadCodec<Payload>,
    namespace: SemanticMacNamespace,
    normalizedValue: (payload: Payload) => string
  ): Promise<Payload> {
    if (!isRecord(value) || !hasExactKeys(value, PROTECTED_RECORD_KEYS)) {
      aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Encrypted record is invalid");
    }
    const opened = await openPayload(value.encrypted, expected, codec);
    const contentMac = parseKeyedMacRecord(value.contentMac, expected.keyClass);
    const valid = await verifyKeyedMac(
      options.keyResolver,
      expected.ownerId,
      contentMac,
      semanticMacMessage(expected.ownerId, namespace, normalizedValue(opened.payload)),
      options.crypto
    );
    if (!valid) {
      aggregateFailure(
        EncryptedAggregateErrorCode.INTEGRITY_CHECK_FAILED,
        "Semantic integrity check failed"
      );
    }
    return opened.payload;
  }

  function parseIdempotencyRecord(
    value: unknown,
    ownerId: string,
    idempotencyKey: string,
    keyClass: KeyClass
  ): EncryptedIdempotencyRecord {
    const resourceId = assertIdempotencyKey(idempotencyKey);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, IDEMPOTENCY_RECORD_KEYS) ||
      value.ownerId !== ownerId ||
      value.idempotencyKey !== idempotencyKey ||
      value.keyClass !== keyClass
    ) {
      aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Idempotency record is invalid");
    }
    const requestMac = parseKeyedMacRecord(value.requestMac, keyClass);
    const response = parseEncryptedAggregateRecord(value.response, {
      ownerId,
      resourceId,
      recordVersion: 1,
      kind: "idempotency_response",
      keyClass
    });
    return Object.freeze({ ownerId, idempotencyKey, keyClass, requestMac, response });
  }

  async function createIdempotencyRequestMac<RequestPayload>(
    access: AuthorizedOwnerAccess,
    input: CreateIdempotencyRequestMacInput<RequestPayload>
  ): Promise<KeyedMacRecord> {
    const ownerId = ownerIdFromAccess(access);
    assertIdempotencyKey(input.idempotencyKey);
    const keyClass = stickyKeyClass(input.transition);
    const logicalRequest = parseLogicalRequest(input.logicalRequest, input.requestCodec);
    return createKeyedMac(
      options.keyResolver,
      ownerId,
      keyClass,
      replayMacMessage(ownerId, input.idempotencyKey, logicalRequest),
      options.crypto,
      input.keyReference
    );
  }

  async function sealIdempotencyResponse<ResponsePayload>(
    access: AuthorizedOwnerAccess,
    input: SealIdempotencyResponseInput<ResponsePayload>
  ): Promise<SealedEncryptedAggregateRecord<"idempotency_response">> {
    const ownerId = ownerIdFromAccess(access);
    const resourceId = assertIdempotencyKey(input.idempotencyKey);
    const keyClass = stickyKeyClass(input.transition);
    return sealPayload(
      expectedAggregate(ownerId, resourceId, 1, "idempotency_response", keyClass),
      input.response,
      input.responseCodec
    );
  }

  async function verifyIdempotencyRequest<RequestPayload>(
    access: AuthorizedOwnerAccess,
    recordValue: unknown,
    input: VerifyIdempotencyRequestInput<RequestPayload>
  ): Promise<boolean> {
    const ownerId = ownerIdFromAccess(access);
    const keyClass = stickyKeyClass(input.transition);
    const record = parseIdempotencyRecord(recordValue, ownerId, input.idempotencyKey, keyClass);
    const logicalRequest = parseLogicalRequest(input.logicalRequest, input.requestCodec);
    return verifyKeyedMac(
      options.keyResolver,
      ownerId,
      record.requestMac,
      replayMacMessage(ownerId, record.idempotencyKey, logicalRequest),
      options.crypto
    );
  }

  function aggregateVerificationCoordinates<Payload>(
    input: AggregateVerificationMacInput<Payload>
  ): AggregateVerificationCoordinates {
    if (input.surface === "capture_receipt") {
      assertEntityId(input.captureId, "cap");
      assertRecordVersion(input.recordVersion);
      const payload = parsePayload(CaptureReceiptPayloadSchema, input.payload);
      if (payload.captureId !== input.captureId) {
        aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, "Receipt resource is invalid");
      }
      return Object.freeze({
        surface: input.surface,
        resourceId: input.captureId,
        recordVersion: input.recordVersion,
        keyClass: parsePrivacy(input.sourcePrivacy),
        payload
      });
    }
    if (input.surface === "note_content") {
      assertEntityId(input.noteId, "note");
      assertRecordVersion(input.recordVersion);
      return Object.freeze({
        surface: input.surface,
        resourceId: input.noteId,
        recordVersion: input.recordVersion,
        keyClass: parsePrivacy(input.privacy),
        payload: parsePayload(NoteContentPayloadSchema, input.payload)
      });
    }
    if (input.surface === "note_mutation") {
      assertEntityId(input.mutationId, "mut");
      assertRecordVersion(input.recordVersion);
      const payload = parsePayload(NoteMutationPayloadSchema, input.payload);
      if (payload.afterRevision !== input.recordVersion) {
        aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, "Mutation revision is invalid");
      }
      return Object.freeze({
        surface: input.surface,
        resourceId: input.mutationId,
        recordVersion: input.recordVersion,
        keyClass: stickyKeyClass({
          before: payload.beforeSnapshot?.privacy ?? null,
          after: payload.afterSnapshot.privacy
        }),
        payload
      });
    }
    return Object.freeze({
      surface: input.surface,
      resourceId: assertIdempotencyKey(input.idempotencyKey),
      recordVersion: 1,
      keyClass: stickyKeyClass(input.transition),
      payload: parsePayload(input.payloadCodec, input.payload)
    });
  }

  async function createAggregateVerificationMac<Payload>(
    access: AuthorizedOwnerAccess,
    input: AggregateVerificationMacInput<Payload>
  ): Promise<KeyedMacRecord> {
    const ownerId = ownerIdFromAccess(access);
    const coordinates = aggregateVerificationCoordinates(input);
    return createKeyedMac(
      options.keyResolver,
      ownerId,
      coordinates.keyClass,
      aggregateVerificationMacMessage(ownerId, coordinates),
      options.crypto
    );
  }

  async function verifyAggregateVerificationMac<Payload>(
    access: AuthorizedOwnerAccess,
    recordValue: unknown,
    input: AggregateVerificationMacInput<Payload>
  ): Promise<boolean> {
    const ownerId = ownerIdFromAccess(access);
    const coordinates = aggregateVerificationCoordinates(input);
    const record = parseKeyedMacRecord(recordValue, coordinates.keyClass);
    return verifyKeyedMac(
      options.keyResolver,
      ownerId,
      record,
      aggregateVerificationMacMessage(ownerId, coordinates),
      options.crypto
    );
  }

  function backfillVerificationCoordinates<Payload>(
    input: BackfillVerificationMacInput<Payload>
  ): BackfillVerificationCoordinates {
    switch (input.surface) {
      case "capture":
        assertEntityId(input.captureId, "cap");
        assertRecordVersion(input.recordVersion);
        return Object.freeze({
          surface: input.surface,
          resourceId: input.captureId,
          recordVersion: input.recordVersion,
          keyClass: parsePrivacy(input.privacy),
          payload: parsePayload(CapturePayloadSchema, input.payload)
        });
      case "capture_receipt": {
        assertEntityId(input.captureId, "cap");
        assertRecordVersion(input.recordVersion);
        const payload = parsePayload(CaptureReceiptPayloadSchema, input.payload);
        if (payload.captureId !== input.captureId) {
          aggregateFailure(
            EncryptedAggregateErrorCode.INVALID_INPUT,
            "Receipt resource is invalid"
          );
        }
        return Object.freeze({
          surface: input.surface,
          resourceId: input.captureId,
          recordVersion: input.recordVersion,
          keyClass: parsePrivacy(input.sourcePrivacy),
          payload
        });
      }
      case "generated_block":
        assertEntityId(input.blockId, "blk");
        return Object.freeze({
          surface: input.surface,
          resourceId: input.blockId,
          recordVersion: 1,
          keyClass: "ai_assisted",
          payload: parsePayload(GeneratedBlockPayloadSchema, input.payload)
        });
      case "idempotency_response":
        return Object.freeze({
          surface: input.surface,
          resourceId: assertIdempotencyKey(input.idempotencyKey),
          recordVersion: 1,
          keyClass: stickyKeyClass(input.transition),
          payload: parsePayload(input.payloadCodec, input.payload)
        });
      case "note_content":
        assertEntityId(input.noteId, "note");
        assertRecordVersion(input.currentRevision);
        return Object.freeze({
          surface: input.surface,
          resourceId: input.noteId,
          recordVersion: input.currentRevision,
          keyClass: parsePrivacy(input.privacy),
          payload: parsePayload(NoteContentPayloadSchema, input.payload)
        });
      case "note_mutation": {
        assertEntityId(input.mutationId, "mut");
        assertRecordVersion(input.afterRevision);
        const payload = parsePayload(NoteMutationPayloadSchema, input.payload);
        if (payload.afterRevision !== input.afterRevision) {
          aggregateFailure(
            EncryptedAggregateErrorCode.INVALID_INPUT,
            "Mutation revision is invalid"
          );
        }
        return Object.freeze({
          surface: input.surface,
          resourceId: input.mutationId,
          recordVersion: input.afterRevision,
          keyClass: stickyKeyClass({
            before: payload.beforeSnapshot?.privacy ?? null,
            after: payload.afterSnapshot.privacy
          }),
          payload
        });
      }
      case "note_revision": {
        assertEntityId(input.revisionId, "rev");
        assertRecordVersion(input.revision);
        const payload = parsePayload(NoteRevisionPayloadSchema, input.payload);
        if (payload.snapshot.privacy !== input.transition.after) {
          aggregateFailure(
            EncryptedAggregateErrorCode.KEY_CLASS_MISMATCH,
            "Privacy transition is invalid"
          );
        }
        return Object.freeze({
          surface: input.surface,
          resourceId: input.revisionId,
          recordVersion: input.revision,
          keyClass: stickyKeyClass(input.transition),
          payload
        });
      }
      case "organization_decision":
        assertEntityId(input.decisionId, "dec");
        return Object.freeze({
          surface: input.surface,
          resourceId: input.decisionId,
          recordVersion: 1,
          keyClass: "ai_assisted",
          payload: parsePayload(OrganizationDecisionPayloadSchema, input.payload)
        });
      case "organization_mutation_attempt": {
        assertEntityId(input.jobId, "job");
        assertEntityId(input.noteId, "note");
        assertRecordVersion(input.recordVersion);
        const payload = parsePayload(OrganizationMutationAttemptPayloadSchema, input.payload);
        if (payload.operations.some(operationTouchesPrivate)) {
          aggregateFailure(
            EncryptedAggregateErrorCode.KEY_CLASS_MISMATCH,
            "AI operation is invalid"
          );
        }
        return Object.freeze({
          surface: input.surface,
          resourceId: `${input.jobId}:${input.noteId}`,
          recordVersion: input.recordVersion,
          keyClass: "ai_assisted",
          payload
        });
      }
      case "review_item":
        assertEntityId(input.reviewId, "rvw");
        assertRecordVersion(input.recordVersion);
        return Object.freeze({
          surface: input.surface,
          resourceId: input.reviewId,
          recordVersion: input.recordVersion,
          keyClass: parsePrivacy(input.sourcePrivacy),
          payload: parsePayload(ReviewPayloadSchema, input.payload)
        });
      case "routing_rule":
        assertEntityId(input.ruleId, "rule");
        assertRecordVersion(input.recordVersion);
        return Object.freeze({
          surface: input.surface,
          resourceId: input.ruleId,
          recordVersion: input.recordVersion,
          keyClass: "private_manual",
          payload: parsePayload(RoutingRulePayloadSchema, input.payload)
        });
      case "space_display":
        assertEntityId(input.spaceId, "spc");
        assertRecordVersion(input.currentRevision);
        return Object.freeze({
          surface: input.surface,
          resourceId: input.spaceId,
          recordVersion: input.currentRevision,
          keyClass: "private_manual",
          payload: parsePayload(SpaceDisplayPayloadSchema, input.payload)
        });
      case "tag_display":
        assertEntityId(input.tagId, "tag");
        assertRecordVersion(input.currentRevision);
        return Object.freeze({
          surface: input.surface,
          resourceId: input.tagId,
          recordVersion: input.currentRevision,
          keyClass: "private_manual",
          payload: parsePayload(TagDisplayPayloadSchema, input.payload)
        });
    }
  }

  async function createBackfillVerificationMac<Payload>(
    access: AuthorizedOwnerAccess,
    input: BackfillVerificationMacInput<Payload>
  ): Promise<KeyedMacRecord> {
    const ownerId = ownerIdFromAccess(access);
    const coordinates = backfillVerificationCoordinates(input);
    return createKeyedMac(
      options.keyResolver,
      ownerId,
      coordinates.keyClass,
      backfillVerificationMacMessage(ownerId, coordinates),
      options.crypto
    );
  }

  async function verifyBackfillVerificationMac<Payload>(
    access: AuthorizedOwnerAccess,
    recordValue: unknown,
    input: BackfillVerificationMacInput<Payload>
  ): Promise<boolean> {
    const ownerId = ownerIdFromAccess(access);
    const coordinates = backfillVerificationCoordinates(input);
    const record = parseKeyedMacRecord(recordValue, coordinates.keyClass);
    return verifyKeyedMac(
      options.keyResolver,
      ownerId,
      record,
      backfillVerificationMacMessage(ownerId, coordinates),
      options.crypto
    );
  }

  return Object.freeze({
    async sealCapture(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.captureId, "cap");
      const keyClass = parsePrivacy(input.privacy);
      return sealContextMacProtected(
        expectedAggregate(ownerId, input.captureId, input.recordVersion, "capture", keyClass),
        input.payload,
        CapturePayloadSchema
      );
    },

    async openCapture(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.captureId, "cap");
      const keyClass = parsePrivacy(expected.privacy);
      return openContextMacProtected(
        record,
        expectedAggregate(ownerId, expected.captureId, expected.recordVersion, "capture", keyClass),
        CapturePayloadSchema
      );
    },

    async sealNoteContent(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.noteId, "note");
      const keyClass = parsePrivacy(input.privacy);
      return sealPayload(
        expectedAggregate(ownerId, input.noteId, input.currentRevision, "note_content", keyClass),
        input.payload,
        NoteContentPayloadSchema
      );
    },

    async openNoteContent(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.noteId, "note");
      const keyClass = parsePrivacy(expected.privacy);
      return (
        await openPayload(
          record,
          expectedAggregate(
            ownerId,
            expected.noteId,
            expected.currentRevision,
            "note_content",
            keyClass
          ),
          NoteContentPayloadSchema
        )
      ).payload;
    },

    async sealNoteRagIndex(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertNoteRagIndexId(input.indexId);
      assertRecordVersion(input.indexedRevision);
      return sealPayload(
        expectedAggregate(
          ownerId,
          input.indexId,
          input.indexedRevision,
          "note_rag_index",
          "ai_assisted"
        ),
        input.payload,
        input.payloadCodec
      );
    },

    async openNoteRagIndex(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertNoteRagIndexId(expected.indexId);
      assertRecordVersion(expected.indexedRevision);
      return (
        await openPayload(
          record,
          expectedAggregate(
            ownerId,
            expected.indexId,
            expected.indexedRevision,
            "note_rag_index",
            "ai_assisted"
          ),
          expected.payloadCodec
        )
      ).payload;
    },

    async sealSpaceDisplay(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.spaceId, "spc");
      return sealSemanticMacProtected(
        expectedAggregate(
          ownerId,
          input.spaceId,
          input.currentRevision,
          "space_display",
          "private_manual"
        ),
        input.payload,
        SpaceDisplayPayloadSchema,
        "space_slug",
        (payload) => payload.slug.toLowerCase()
      );
    },

    async openSpaceDisplay(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.spaceId, "spc");
      return openSemanticMacProtected(
        record,
        expectedAggregate(
          ownerId,
          expected.spaceId,
          expected.currentRevision,
          "space_display",
          "private_manual"
        ),
        SpaceDisplayPayloadSchema,
        "space_slug",
        (payload) => payload.slug.toLowerCase()
      );
    },

    async sealTagDisplay(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.tagId, "tag");
      return sealSemanticMacProtected(
        expectedAggregate(
          ownerId,
          input.tagId,
          input.currentRevision,
          "tag_display",
          "private_manual"
        ),
        input.payload,
        TagDisplayPayloadSchema,
        "tag_normalized_name",
        (payload) => payload.name
      );
    },

    async openTagDisplay(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.tagId, "tag");
      return openSemanticMacProtected(
        record,
        expectedAggregate(
          ownerId,
          expected.tagId,
          expected.currentRevision,
          "tag_display",
          "private_manual"
        ),
        TagDisplayPayloadSchema,
        "tag_normalized_name",
        (payload) => payload.name
      );
    },

    async sealNoteRevision(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.revisionId, "rev");
      const payload = parsePayload(NoteRevisionPayloadSchema, input.payload);
      if (payload.snapshot.privacy !== input.transition.after) {
        aggregateFailure(
          EncryptedAggregateErrorCode.KEY_CLASS_MISMATCH,
          "Privacy transition is invalid"
        );
      }
      const keyClass = stickyKeyClass(input.transition);
      return sealContextMacProtected(
        expectedAggregate(ownerId, input.revisionId, input.revision, "note_revision", keyClass),
        payload,
        NoteRevisionPayloadSchema
      );
    },

    async openNoteRevision(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.revisionId, "rev");
      const keyClass = stickyKeyClass(expected.transition);
      const payload = await openContextMacProtected(
        record,
        expectedAggregate(
          ownerId,
          expected.revisionId,
          expected.revision,
          "note_revision",
          keyClass
        ),
        NoteRevisionPayloadSchema
      );
      if (payload.snapshot.privacy !== expected.transition.after) {
        aggregateFailure(
          EncryptedAggregateErrorCode.KEY_CLASS_MISMATCH,
          "Privacy transition is invalid"
        );
      }
      return payload;
    },

    async sealNoteMutation(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.mutationId, "mut");
      const payload = parsePayload(NoteMutationPayloadSchema, input.payload);
      if (payload.afterRevision !== input.afterRevision) {
        aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, "Mutation revision is invalid");
      }
      const transition = {
        before: payload.beforeSnapshot?.privacy ?? null,
        after: payload.afterSnapshot.privacy
      } as const;
      return sealPayload(
        expectedAggregate(
          ownerId,
          input.mutationId,
          input.afterRevision,
          "note_mutation",
          stickyKeyClass(transition)
        ),
        payload,
        NoteMutationPayloadSchema
      );
    },

    async openNoteMutation(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.mutationId, "mut");
      const keyClass = stickyKeyClass(expected.transition);
      const payload = (
        await openPayload(
          record,
          expectedAggregate(
            ownerId,
            expected.mutationId,
            expected.afterRevision,
            "note_mutation",
            keyClass
          ),
          NoteMutationPayloadSchema
        )
      ).payload;
      if (
        payload.afterRevision !== expected.afterRevision ||
        !privacyTransitionMatches(
          expected.transition,
          payload.beforeSnapshot?.privacy ?? null,
          payload.afterSnapshot.privacy
        )
      ) {
        aggregateFailure(
          EncryptedAggregateErrorCode.KEY_CLASS_MISMATCH,
          "Privacy transition is invalid"
        );
      }
      return payload;
    },

    async openNoteMutationForVerification(access, recordValue, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.mutationId, "mut");
      assertRecordVersion(expected.afterRevision);
      if (
        !isRecord(recordValue) ||
        (recordValue.keyClass !== "ai_assisted" && recordValue.keyClass !== "private_manual")
      ) {
        aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Mutation record is invalid");
      }
      const keyClass = recordValue.keyClass;
      const payload = (
        await openPayload(
          recordValue,
          expectedAggregate(
            ownerId,
            expected.mutationId,
            expected.afterRevision,
            "note_mutation",
            keyClass
          ),
          NoteMutationPayloadSchema
        )
      ).payload;
      const derivedClass = stickyKeyClass({
        before: payload.beforeSnapshot?.privacy ?? null,
        after: payload.afterSnapshot.privacy
      });
      if (payload.afterRevision !== expected.afterRevision || derivedClass !== keyClass) {
        aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Mutation record is invalid");
      }
      return payload;
    },

    async sealOrganizationDecision(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.decisionId, "dec");
      return sealPayload(
        expectedAggregate(ownerId, input.decisionId, 1, "organization_decision", "ai_assisted"),
        input.payload,
        OrganizationDecisionPayloadSchema
      );
    },

    async openOrganizationDecision(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.decisionId, "dec");
      return (
        await openPayload(
          record,
          expectedAggregate(
            ownerId,
            expected.decisionId,
            1,
            "organization_decision",
            "ai_assisted"
          ),
          OrganizationDecisionPayloadSchema
        )
      ).payload;
    },

    async sealGeneratedBlock(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.blockId, "blk");
      return sealPayload(
        expectedAggregate(ownerId, input.blockId, 1, "generated_block", "ai_assisted"),
        input.payload,
        GeneratedBlockPayloadSchema
      );
    },

    async openGeneratedBlock(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.blockId, "blk");
      return (
        await openPayload(
          record,
          expectedAggregate(ownerId, expected.blockId, 1, "generated_block", "ai_assisted"),
          GeneratedBlockPayloadSchema
        )
      ).payload;
    },

    async sealReview(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.reviewId, "rvw");
      const keyClass = parsePrivacy(input.sourcePrivacy);
      return sealPayload(
        expectedAggregate(ownerId, input.reviewId, input.recordVersion, "review_item", keyClass),
        input.payload,
        ReviewPayloadSchema
      );
    },

    async openReview(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.reviewId, "rvw");
      const keyClass = parsePrivacy(expected.sourcePrivacy);
      return (
        await openPayload(
          record,
          expectedAggregate(
            ownerId,
            expected.reviewId,
            expected.recordVersion,
            "review_item",
            keyClass
          ),
          ReviewPayloadSchema
        )
      ).payload;
    },

    async sealRoutingRule(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.ruleId, "rule");
      return sealPayload(
        expectedAggregate(
          ownerId,
          input.ruleId,
          input.recordVersion,
          "routing_rule",
          "private_manual"
        ),
        input.payload,
        RoutingRulePayloadSchema
      );
    },

    async openRoutingRule(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.ruleId, "rule");
      return (
        await openPayload(
          record,
          expectedAggregate(
            ownerId,
            expected.ruleId,
            expected.recordVersion,
            "routing_rule",
            "private_manual"
          ),
          RoutingRulePayloadSchema
        )
      ).payload;
    },

    async sealOrganizationMutationAttempt(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.jobId, "job");
      assertEntityId(input.noteId, "note");
      const payload = parsePayload(OrganizationMutationAttemptPayloadSchema, input.payload);
      if (payload.operations.some(operationTouchesPrivate)) {
        aggregateFailure(EncryptedAggregateErrorCode.KEY_CLASS_MISMATCH, "AI operation is invalid");
      }
      return sealPayload(
        expectedAggregate(
          ownerId,
          `${input.jobId}:${input.noteId}`,
          input.recordVersion,
          "organization_mutation_attempt",
          "ai_assisted"
        ),
        payload,
        OrganizationMutationAttemptPayloadSchema
      );
    },

    async openOrganizationMutationAttempt(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.jobId, "job");
      assertEntityId(expected.noteId, "note");
      const payload = (
        await openPayload(
          record,
          expectedAggregate(
            ownerId,
            `${expected.jobId}:${expected.noteId}`,
            expected.recordVersion,
            "organization_mutation_attempt",
            "ai_assisted"
          ),
          OrganizationMutationAttemptPayloadSchema
        )
      ).payload;
      if (payload.operations.some(operationTouchesPrivate)) {
        aggregateFailure(EncryptedAggregateErrorCode.KEY_CLASS_MISMATCH, "AI operation is invalid");
      }
      return payload;
    },

    async sealCaptureReceipt(access, input) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(input.captureId, "cap");
      const keyClass = parsePrivacy(input.sourcePrivacy);
      if (input.payload.captureId !== input.captureId) {
        aggregateFailure(EncryptedAggregateErrorCode.INVALID_INPUT, "Receipt resource is invalid");
      }
      return sealPayload(
        expectedAggregate(
          ownerId,
          input.captureId,
          input.recordVersion,
          "capture_receipt",
          keyClass
        ),
        input.payload,
        CaptureReceiptPayloadSchema
      );
    },

    async openCaptureReceipt(access, record, expected) {
      const ownerId = ownerIdFromAccess(access);
      assertEntityId(expected.captureId, "cap");
      const keyClass = parsePrivacy(expected.sourcePrivacy);
      const payload = (
        await openPayload(
          record,
          expectedAggregate(
            ownerId,
            expected.captureId,
            expected.recordVersion,
            "capture_receipt",
            keyClass
          ),
          CaptureReceiptPayloadSchema
        )
      ).payload;
      if (payload.captureId !== expected.captureId) {
        aggregateFailure(EncryptedAggregateErrorCode.INVALID_RECORD, "Receipt resource is invalid");
      }
      return payload;
    },

    async sealIdempotencyRecord(access, input) {
      const ownerId = ownerIdFromAccess(access);
      const keyClass = stickyKeyClass(input.transition);
      const requestMac = await createIdempotencyRequestMac(access, {
        idempotencyKey: input.idempotencyKey,
        transition: input.transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec
      });
      const response = await sealIdempotencyResponse(access, {
        idempotencyKey: input.idempotencyKey,
        transition: input.transition,
        response: input.response,
        responseCodec: input.responseCodec
      });
      return Object.freeze({
        ownerId,
        idempotencyKey: input.idempotencyKey,
        keyClass,
        requestMac,
        response
      });
    },

    createIdempotencyRequestMac,

    sealIdempotencyResponse,

    verifyIdempotencyRequest,

    createAggregateVerificationMac,

    verifyAggregateVerificationMac,

    createBackfillVerificationMac,

    verifyBackfillVerificationMac,

    async openIdempotencyResponse(access, recordValue, input) {
      const valid = await verifyIdempotencyRequest(access, recordValue, input);
      if (!valid) {
        aggregateFailure(
          EncryptedAggregateErrorCode.REPLAY_MISMATCH,
          "Idempotency request differs"
        );
      }
      const ownerId = ownerIdFromAccess(access);
      const keyClass = stickyKeyClass(input.transition);
      const record = parseIdempotencyRecord(recordValue, ownerId, input.idempotencyKey, keyClass);
      return (
        await openPayload(
          record.response,
          expectedAggregate(
            ownerId,
            assertIdempotencyKey(record.idempotencyKey),
            1,
            "idempotency_response",
            keyClass
          ),
          input.responseCodec
        )
      ).payload;
    },

    async openIdempotencyResponseForVerification(access, recordValue, input) {
      const ownerId = ownerIdFromAccess(access);
      if (
        !isRecord(recordValue) ||
        (recordValue.keyClass !== "ai_assisted" && recordValue.keyClass !== "private_manual")
      ) {
        aggregateFailure(
          EncryptedAggregateErrorCode.INVALID_RECORD,
          "Idempotency record is invalid"
        );
      }
      const record = parseIdempotencyRecord(
        recordValue,
        ownerId,
        input.idempotencyKey,
        recordValue.keyClass
      );
      return (
        await openPayload(
          record.response,
          expectedAggregate(
            ownerId,
            assertIdempotencyKey(record.idempotencyKey),
            1,
            "idempotency_response",
            record.keyClass
          ),
          input.responseCodec
        )
      ).payload;
    }
  });
}
