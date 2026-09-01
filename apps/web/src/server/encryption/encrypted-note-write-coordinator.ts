import type { EntityId } from "@unfiled/contracts";
import { serializeContentEnvelope } from "@unfiled/content-crypto";
import {
  keyedMacForRpc,
  stickyKeyClass,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type EncryptedIdempotencyRecord,
  type KeyedMacRecord,
  type LogicalApiRequest,
  type PayloadCodec,
  type PrivacyTransition
} from "@unfiled/encrypted-aggregate";

import type {
  CompletedEncryptedNoteWriteClaim,
  EncryptedNoteResponseCipher,
  EncryptedNoteRpcAdapter,
  EncryptedNoteWriteClaim,
  EncryptedNoteWriteScope,
  IncompleteEncryptedNoteWriteClaim
} from "./encrypted-note-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const MAX_PREPARE_ATTEMPTS = 2;

export type EncryptedNoteWriteCoordinates = Readonly<{
  ownerId: string;
  scope: EncryptedNoteWriteScope;
  idempotencyKey: string;
  noteId: EntityId<"note"> | null;
  expectedRevision: number;
}>;

export type PrepareEncryptedNoteWriteInput<RequestPayload, ResponsePayload> = Readonly<{
  coordinates: EncryptedNoteWriteCoordinates;
  logicalRequest: LogicalApiRequest<RequestPayload>;
  requestCodec: PayloadCodec<RequestPayload>;
  responseCodec: PayloadCodec<ResponsePayload>;
  /**
   * Resolves the current plaintext transition only after the idempotency claim
   * lookup proves that no earlier claim exists. Mutation callers perform their
   * encrypted current-note read inside this callback.
   */
  resolveNewTransition(): Promise<PrivacyTransition>;
}>;

export type ReadyEncryptedNoteWrite = Readonly<{
  status: "ready";
  claim: IncompleteEncryptedNoteWriteClaim;
  requestMac: KeyedMacRecord;
  /**
   * For a resumed claim this is the minimal transition that selects the
   * claim's sticky key class. The caller must still compare the actual
   * decrypted before/after transition before sealing the mutation payload.
   */
  keyTransition: PrivacyTransition;
  resumed: boolean;
}>;

export type CompletedEncryptedNoteWrite<ResponsePayload> = Readonly<{
  status: "completed";
  claim: CompletedEncryptedNoteWriteClaim;
  response: ResponsePayload;
  resumed: true;
}>;

export type PreparedEncryptedNoteWrite<ResponsePayload> =
  ReadyEncryptedNoteWrite | CompletedEncryptedNoteWrite<ResponsePayload>;

type CoordinatorDependencies = Readonly<{
  adapter: EncryptedNoteRpcAdapter;
  aggregate: EncryptedAggregateService;
  access: Parameters<EncryptedAggregateService["createIdempotencyRequestMac"]>[0];
}>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function invalidIdempotencyKey(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY);
}

function assertCoordinates<RequestPayload, ResponsePayload>(
  input: PrepareEncryptedNoteWriteInput<RequestPayload, ResponsePayload>
): void {
  const { coordinates, logicalRequest } = input;
  if (
    (coordinates.scope === "create_encrypted_note" &&
      (coordinates.noteId !== null || coordinates.expectedRevision !== 0)) ||
    (coordinates.scope === "apply_encrypted_note_mutation" &&
      (coordinates.noteId === null || coordinates.expectedRevision < 1)) ||
    logicalRequest.scope !== coordinates.scope ||
    logicalRequest.targetResourceId !== coordinates.noteId ||
    logicalRequest.expectedRevision !== coordinates.expectedRevision
  ) {
    invalidInput();
  }
}

function sameResponseCipher(
  left: EncryptedNoteResponseCipher,
  right: EncryptedNoteResponseCipher
): boolean {
  return (
    left.keyId === right.keyId &&
    left.keyClass === right.keyClass &&
    left.keyVersion === right.keyVersion &&
    serializeContentEnvelope(left.envelope) === serializeContentEnvelope(right.envelope)
  );
}

function assertClaimContinuity(
  existing: EncryptedNoteWriteClaim,
  prepared: EncryptedNoteWriteClaim,
  replayed: boolean
): void {
  if (
    !replayed ||
    existing.ownerId !== prepared.ownerId ||
    existing.idempotencyKey !== prepared.idempotencyKey ||
    existing.scope !== prepared.scope ||
    existing.noteId !== prepared.noteId ||
    existing.expectedRevision !== prepared.expectedRevision ||
    existing.sourcePrivacy !== prepared.sourcePrivacy ||
    existing.targetPrivacy !== prepared.targetPrivacy ||
    existing.historyKeyClass !== prepared.historyKeyClass ||
    existing.revisionId !== prepared.revisionId ||
    existing.mutationId !== prepared.mutationId ||
    existing.occurredAt !== prepared.occurredAt ||
    existing.commandProjection !== prepared.commandProjection ||
    existing.requestMacKey.keyId !== prepared.requestMacKey.keyId ||
    existing.requestMacKey.keyClass !== prepared.requestMacKey.keyClass ||
    existing.requestMacKey.keyVersion !== prepared.requestMacKey.keyVersion ||
    (existing.completed &&
      (!prepared.completed ||
        !sameResponseCipher(existing.encryptedResponse, prepared.encryptedResponse)))
  ) {
    invalidIdempotencyKey();
  }
}

function assertClaimCoordinates(
  claim: EncryptedNoteWriteClaim,
  coordinates: EncryptedNoteWriteCoordinates
): void {
  if (
    claim.ownerId !== coordinates.ownerId ||
    claim.scope !== coordinates.scope ||
    claim.idempotencyKey !== coordinates.idempotencyKey ||
    claim.expectedRevision !== coordinates.expectedRevision ||
    (coordinates.noteId !== null && claim.noteId !== coordinates.noteId)
  ) {
    invalidIdempotencyKey();
  }
}

function transitionForClaim(claim: EncryptedNoteWriteClaim): PrivacyTransition {
  const transition: PrivacyTransition = Object.freeze({
    before: claim.sourcePrivacy,
    after: claim.targetPrivacy
  });
  if (stickyKeyClass(transition) !== claim.historyKeyClass) invalidIdempotencyKey();
  return transition;
}

function assertNewTransition(
  coordinates: EncryptedNoteWriteCoordinates,
  transition: PrivacyTransition
): PrivacyTransition {
  if (
    (coordinates.scope === "create_encrypted_note" && transition.before !== null) ||
    (coordinates.scope === "apply_encrypted_note_mutation" && transition.before === null)
  ) {
    return invalidInput();
  }
  return Object.freeze({ before: transition.before, after: transition.after });
}

function exactRequestMacKey(
  claim: EncryptedNoteWriteClaim
): NonNullable<
  Parameters<EncryptedAggregateService["createIdempotencyRequestMac"]>[1]["keyReference"]
> {
  return Object.freeze({
    ownerId: claim.ownerId,
    keyClass: claim.requestMacKey.keyClass,
    purpose: claim.requestMacKey.keyPurpose,
    keyId: claim.requestMacKey.keyId,
    keyVersion: claim.requestMacKey.keyVersion
  });
}

function responseAggregateRecord(
  claim: CompletedEncryptedNoteWriteClaim,
  response: EncryptedNoteResponseCipher
): EncryptedAggregateRecord<"idempotency_response"> {
  return Object.freeze({
    ownerId: claim.ownerId,
    resourceId: `idempotency:${claim.idempotencyKey}`,
    recordVersion: 1,
    kind: "idempotency_response",
    envelope: response.envelope,
    keyId: response.keyId,
    keyClass: response.keyClass,
    keyPurpose: response.keyPurpose,
    keyVersion: response.keyVersion
  });
}

function idempotencyRecord(
  claim: CompletedEncryptedNoteWriteClaim,
  requestMac: KeyedMacRecord
): EncryptedIdempotencyRecord {
  return Object.freeze({
    ownerId: claim.ownerId,
    idempotencyKey: claim.idempotencyKey,
    keyClass: claim.historyKeyClass,
    requestMac,
    response: responseAggregateRecord(claim, claim.encryptedResponse)
  });
}

async function requestMacForClaim<RequestPayload>(
  dependencies: CoordinatorDependencies,
  claim: EncryptedNoteWriteClaim,
  input: PrepareEncryptedNoteWriteInput<RequestPayload, unknown>
): Promise<Readonly<{ requestMac: KeyedMacRecord; transition: PrivacyTransition }>> {
  const transition = transitionForClaim(claim);
  const requestMac = await dependencies.aggregate.createIdempotencyRequestMac(dependencies.access, {
    idempotencyKey: input.coordinates.idempotencyKey,
    transition,
    logicalRequest: input.logicalRequest,
    requestCodec: input.requestCodec,
    keyReference: exactRequestMacKey(claim)
  });
  return Object.freeze({ requestMac, transition });
}

async function openCompletedResponse<RequestPayload, ResponsePayload>(
  dependencies: CoordinatorDependencies,
  claim: CompletedEncryptedNoteWriteClaim,
  requestMac: KeyedMacRecord,
  transition: PrivacyTransition,
  input: PrepareEncryptedNoteWriteInput<RequestPayload, ResponsePayload>
): Promise<ResponsePayload> {
  return dependencies.aggregate.openIdempotencyResponse(
    dependencies.access,
    idempotencyRecord(claim, requestMac),
    {
      idempotencyKey: input.coordinates.idempotencyKey,
      transition,
      logicalRequest: input.logicalRequest,
      requestCodec: input.requestCodec,
      responseCodec: input.responseCodec
    }
  );
}

/**
 * Authenticates or creates a sticky encrypted write claim before any mutable
 * note read. A completed response is opened only after Postgres has compared
 * the recomputed request MAC with the stored claim.
 */
export async function prepareEncryptedNoteWrite<RequestPayload, ResponsePayload>(
  dependencies: CoordinatorDependencies,
  input: PrepareEncryptedNoteWriteInput<RequestPayload, ResponsePayload>
): Promise<PreparedEncryptedNoteWrite<ResponsePayload>> {
  assertCoordinates(input);

  for (let attempt = 0; attempt < MAX_PREPARE_ATTEMPTS; attempt += 1) {
    const existing = await dependencies.adapter.getWriteClaim({
      ownerId: input.coordinates.ownerId,
      scope: input.coordinates.scope,
      idempotencyKey: input.coordinates.idempotencyKey
    });

    let transition: PrivacyTransition;
    let requestMac: KeyedMacRecord;
    let resumed: boolean;
    if (existing === null) {
      transition = assertNewTransition(input.coordinates, await input.resolveNewTransition());
      requestMac = await dependencies.aggregate.createIdempotencyRequestMac(dependencies.access, {
        idempotencyKey: input.coordinates.idempotencyKey,
        transition,
        logicalRequest: input.logicalRequest,
        requestCodec: input.requestCodec
      });
      resumed = false;
    } else {
      assertClaimCoordinates(existing, input.coordinates);
      ({ requestMac, transition } = await requestMacForClaim(dependencies, existing, input));
      resumed = true;
    }

    try {
      const prepared = await dependencies.adapter.prepareWrite({
        ownerId: input.coordinates.ownerId,
        scope: input.coordinates.scope,
        idempotencyKey: input.coordinates.idempotencyKey,
        noteId: input.coordinates.noteId,
        expectedRevision: input.coordinates.expectedRevision,
        targetPrivacy: transition.after,
        requestMac: keyedMacForRpc(requestMac)
      });
      assertClaimCoordinates(prepared.claim, input.coordinates);
      if (existing !== null) {
        assertClaimContinuity(existing, prepared.claim, prepared.replayed);
      }

      if (prepared.claim.completed) {
        return Object.freeze({
          status: "completed",
          claim: prepared.claim,
          response: await openCompletedResponse(
            dependencies,
            prepared.claim,
            requestMac,
            transition,
            input
          ),
          resumed: true
        });
      }
      return Object.freeze({
        status: "ready",
        claim: prepared.claim,
        requestMac,
        keyTransition: transition,
        resumed: resumed || prepared.replayed
      });
    } catch (error: unknown) {
      const racedWithClaimCreation =
        existing === null &&
        attempt + 1 < MAX_PREPARE_ATTEMPTS &&
        error instanceof ServiceRpcError &&
        error.code === ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY;
      if (!racedWithClaimCreation) throw error;
    }
  }

  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}
