import { NoteSnapshotSchema, type EntityId, type RevisionSource } from "@unfiled/contracts";
import {
  encryptedFieldForRpc,
  keyedMacForRpc,
  NoteContentPayloadSchema,
  NoteMutationPayloadSchema,
  NoteRevisionPayloadSchema,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateService,
  type EncryptedIdempotencyRecord,
  type KeyedMacRecord,
  type LogicalApiRequest,
  type NoteContentPayload,
  type NoteMutationPayload,
  type NoteRevisionPayload,
  type PayloadCodec
} from "@unfiled/encrypted-aggregate";

import type {
  EncryptedNoteRpcAdapter,
  EncryptedNoteState,
  EncryptedNoteWriteScope,
  IncompleteEncryptedNoteWriteClaim
} from "./encrypted-note-rpc-adapter";
import {
  encryptedOnlyMutationProjection,
  encryptedOnlyNoteState
} from "./encrypted-note-command-projection";
import {
  prepareEncryptedNoteWrite,
  type EncryptedNoteWriteCoordinates
} from "./encrypted-note-write-coordinator";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

export type EncryptedNoteWriteMaterial<ResponsePayload> = Readonly<{
  noteState: EncryptedNoteState;
  noteContent: NoteContentPayload;
  revision: Readonly<{
    id: EntityId<"rev">;
    source: RevisionSource;
    actor: string;
    payload: NoteRevisionPayload;
  }>;
  mutation: Readonly<{
    id: EntityId<"mut">;
    decisionId: EntityId<"dec"> | null;
    undoTargetMutationId: EntityId<"mut"> | null;
    payload: NoteMutationPayload;
  }>;
  buildResponse(revisionContentMac: KeyedMacRecord): ResponsePayload;
}>;

export type ExecuteEncryptedNoteWriteInput<RequestPayload, ResponsePayload> = Readonly<{
  coordinates: EncryptedNoteWriteCoordinates;
  logicalRequest: LogicalApiRequest<RequestPayload>;
  requestCodec: PayloadCodec<RequestPayload>;
  responseCodec: PayloadCodec<ResponsePayload>;
  resolveNewTransition(): Promise<
    Readonly<{
      before: "ai_assisted" | "private_manual" | null;
      after: "ai_assisted" | "private_manual";
    }>
  >;
  buildMaterial(
    claim: IncompleteEncryptedNoteWriteClaim
  ): Promise<EncryptedNoteWriteMaterial<ResponsePayload>>;
}>;

export type ExecuteEncryptedNoteWriteResult<ResponsePayload> = Readonly<{
  response: ResponsePayload;
  replayed: boolean;
  noteId: EntityId<"note">;
  mutationId: EntityId<"mut">;
  currentRevision: number;
}>;

type ExecutorDependencies = Readonly<{
  adapter: EncryptedNoteRpcAdapter;
  aggregate: EncryptedAggregateService;
  access: AuthorizedOwnerAccess;
}>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function integrityFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function canonical(value: unknown): string {
  if (value === undefined) return integrityFailure();
  return JSON.stringify(value);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function snapshotForState(state: EncryptedNoteState) {
  const parsed = NoteSnapshotSchema.safeParse({
    spaceId: state.spaceId,
    type: state.type,
    title: state.title,
    bodyMarkdown: state.bodyMarkdown,
    structuredData: state.structuredData,
    isOpen: state.isOpen,
    pinnedAt: state.pinnedAt,
    privacy: state.privacy,
    archivedAt: state.archivedAt,
    deletedAt: state.deletedAt,
    tagIds: state.tagIds,
    links: state.links
  });
  if (!parsed.success) return invalidInput();
  return parsed.data;
}

function validateMaterial<ResponsePayload>(
  claim: IncompleteEncryptedNoteWriteClaim,
  material: EncryptedNoteWriteMaterial<ResponsePayload>
): Readonly<{
  noteContent: NoteContentPayload;
  revisionPayload: NoteRevisionPayload;
  mutationPayload: NoteMutationPayload;
}> {
  let noteContent: NoteContentPayload;
  let revisionPayload: NoteRevisionPayload;
  let mutationPayload: NoteMutationPayload;
  try {
    noteContent = NoteContentPayloadSchema.parse(material.noteContent);
    revisionPayload = NoteRevisionPayloadSchema.parse(material.revision.payload);
    mutationPayload = NoteMutationPayloadSchema.parse(material.mutation.payload);
  } catch {
    return invalidInput();
  }

  const afterRevision = claim.expectedRevision + 1;
  const snapshot = snapshotForState(material.noteState);
  if (
    material.noteState.privacy !== claim.targetPrivacy ||
    material.revision.id !== claim.revisionId ||
    material.mutation.id !== claim.mutationId ||
    (material.revision.source === "undo") !== (material.mutation.undoTargetMutationId !== null) ||
    material.mutation.undoTargetMutationId === claim.mutationId ||
    mutationPayload.afterRevision !== afterRevision ||
    !sameCanonical(revisionPayload.snapshot, snapshot) ||
    !sameCanonical(mutationPayload.afterSnapshot, snapshot) ||
    !sameCanonical(noteContent, {
      schemaVersion: 1,
      title: snapshot.title,
      bodyMarkdown: snapshot.bodyMarkdown,
      structuredData: snapshot.structuredData
    })
  ) {
    return invalidInput();
  }

  if (claim.scope === "create_encrypted_note") {
    if (
      claim.sourcePrivacy !== null ||
      mutationPayload.action !== "create" ||
      material.mutation.decisionId !== null ||
      material.mutation.undoTargetMutationId !== null
    ) {
      return invalidInput();
    }
  } else if (
    claim.sourcePrivacy === null ||
    mutationPayload.action !== "update" ||
    mutationPayload.beforeRevision !== claim.expectedRevision ||
    mutationPayload.beforeSnapshot.privacy !== claim.sourcePrivacy
  ) {
    return invalidInput();
  }

  // The response is built only after revision sealing so its public
  // `contentHash` can be the keyed revision MAC rather than an unkeyed digest.
  return Object.freeze({ noteContent, revisionPayload, mutationPayload });
}

function idempotencyRecord(
  claim: IncompleteEncryptedNoteWriteClaim,
  requestMac: Awaited<ReturnType<EncryptedAggregateService["createIdempotencyRequestMac"]>>,
  response: Awaited<ReturnType<EncryptedAggregateService["sealIdempotencyResponse"]>>
): EncryptedIdempotencyRecord {
  return Object.freeze({
    ownerId: claim.ownerId,
    idempotencyKey: claim.idempotencyKey,
    keyClass: claim.historyKeyClass,
    requestMac,
    response
  });
}

async function assertVerification(valid: Promise<boolean>): Promise<void> {
  if (!(await valid)) integrityFailure();
}

/**
 * Completes the owner-authorized encrypted note write protocol. Every payload
 * is opened and compared before the transaction is submitted; the response is
 * opened only after Postgres has bound it to the authenticated claim.
 */
export async function executeEncryptedNoteWrite<RequestPayload, ResponsePayload>(
  dependencies: ExecutorDependencies,
  input: ExecuteEncryptedNoteWriteInput<RequestPayload, ResponsePayload>
): Promise<ExecuteEncryptedNoteWriteResult<ResponsePayload>> {
  const prepared = await prepareEncryptedNoteWrite(dependencies, input);
  if (prepared.status === "completed") {
    return Object.freeze({
      response: prepared.response,
      replayed: true,
      noteId: prepared.claim.noteId,
      mutationId: prepared.claim.mutationId,
      currentRevision: prepared.claim.expectedRevision + 1
    });
  }

  const { claim, requestMac } = prepared;
  const material = await input.buildMaterial(claim);
  const { noteContent, revisionPayload, mutationPayload } = validateMaterial(claim, material);
  const transition = Object.freeze({
    before: claim.sourcePrivacy,
    after: claim.targetPrivacy
  });
  const afterRevision = claim.expectedRevision + 1;

  const [noteCipher, revision, mutationCipher] = await Promise.all([
    dependencies.aggregate.sealNoteContent(dependencies.access, {
      noteId: claim.noteId,
      currentRevision: afterRevision,
      privacy: claim.targetPrivacy,
      payload: noteContent
    }),
    dependencies.aggregate.sealNoteRevision(dependencies.access, {
      revisionId: claim.revisionId,
      revision: afterRevision,
      transition,
      payload: revisionPayload
    }),
    dependencies.aggregate.sealNoteMutation(dependencies.access, {
      mutationId: claim.mutationId,
      afterRevision,
      payload: mutationPayload
    })
  ]);

  const opened = await Promise.all([
    dependencies.aggregate.openNoteContent(dependencies.access, noteCipher, {
      noteId: claim.noteId,
      currentRevision: afterRevision,
      privacy: claim.targetPrivacy
    }),
    dependencies.aggregate.openNoteRevision(dependencies.access, revision.encrypted, {
      revisionId: claim.revisionId,
      revision: afterRevision,
      transition
    }),
    dependencies.aggregate.openNoteMutation(dependencies.access, mutationCipher, {
      mutationId: claim.mutationId,
      afterRevision,
      transition
    })
  ]);
  if (
    !sameCanonical(opened[0], noteContent) ||
    !sameCanonical(opened[1], revisionPayload) ||
    !sameCanonical(opened[2], mutationPayload)
  ) {
    integrityFailure();
  }

  let response: ResponsePayload;
  try {
    response = input.responseCodec.parse(material.buildResponse(revision.contentMac));
  } catch {
    return invalidInput();
  }
  const responseCipher = await dependencies.aggregate.sealIdempotencyResponse(dependencies.access, {
    idempotencyKey: claim.idempotencyKey,
    transition,
    response,
    responseCodec: input.responseCodec
  });
  const openedResponseBeforeCommit = await dependencies.aggregate.openIdempotencyResponse(
    dependencies.access,
    idempotencyRecord(claim, requestMac, responseCipher),
    {
      idempotencyKey: claim.idempotencyKey,
      transition,
      logicalRequest: input.logicalRequest,
      requestCodec: input.requestCodec,
      responseCodec: input.responseCodec
    }
  );
  if (!sameCanonical(openedResponseBeforeCommit, response)) integrityFailure();

  const [noteVerification, mutationVerification, responseVerification] = await Promise.all([
    dependencies.aggregate.createAggregateVerificationMac(dependencies.access, {
      surface: "note_content",
      noteId: claim.noteId,
      recordVersion: afterRevision,
      privacy: claim.targetPrivacy,
      payload: noteContent
    }),
    dependencies.aggregate.createAggregateVerificationMac(dependencies.access, {
      surface: "note_mutation",
      mutationId: claim.mutationId,
      recordVersion: afterRevision,
      payload: mutationPayload
    }),
    dependencies.aggregate.createAggregateVerificationMac(dependencies.access, {
      surface: "idempotency_response",
      idempotencyKey: claim.idempotencyKey,
      transition,
      payload: response,
      payloadCodec: input.responseCodec
    })
  ]);
  await Promise.all([
    assertVerification(
      dependencies.aggregate.verifyAggregateVerificationMac(dependencies.access, noteVerification, {
        surface: "note_content",
        noteId: claim.noteId,
        recordVersion: afterRevision,
        privacy: claim.targetPrivacy,
        payload: noteContent
      })
    ),
    assertVerification(
      dependencies.aggregate.verifyAggregateVerificationMac(
        dependencies.access,
        mutationVerification,
        {
          surface: "note_mutation",
          mutationId: claim.mutationId,
          recordVersion: afterRevision,
          payload: mutationPayload
        }
      )
    ),
    assertVerification(
      dependencies.aggregate.verifyAggregateVerificationMac(
        dependencies.access,
        responseVerification,
        {
          surface: "idempotency_response",
          idempotencyKey: claim.idempotencyKey,
          transition,
          payload: response,
          payloadCodec: input.responseCodec
        }
      )
    )
  ]);

  const mutationProjection =
    claim.commandProjection === "encrypted_only"
      ? encryptedOnlyMutationProjection(claim.targetPrivacy)
      : Object.freeze({
          operations: mutationPayload.operations,
          inverse: mutationPayload.inverse
        });
  const command = Object.freeze({
    occurredAt: claim.occurredAt,
    noteState:
      claim.commandProjection === "encrypted_only"
        ? encryptedOnlyNoteState(claim.noteId, material.noteState)
        : material.noteState,
    noteCipher: encryptedFieldForRpc(noteCipher),
    revision: Object.freeze({
      id: claim.revisionId,
      source: material.revision.source,
      actor: material.revision.actor,
      cipher: encryptedFieldForRpc(revision.encrypted),
      mac: keyedMacForRpc(revision.contentMac)
    }),
    mutation: Object.freeze({
      id: claim.mutationId,
      decisionId: material.mutation.decisionId,
      undoTargetMutationId: material.mutation.undoTargetMutationId,
      operations: mutationProjection.operations,
      inverse: mutationProjection.inverse,
      cipher: encryptedFieldForRpc(mutationCipher)
    }),
    requestMac: keyedMacForRpc(requestMac),
    responseCipher: encryptedFieldForRpc(responseCipher),
    verification: Object.freeze({
      noteContent: keyedMacForRpc(noteVerification),
      noteMutation: keyedMacForRpc(mutationVerification),
      idempotencyResponse: keyedMacForRpc(responseVerification)
    })
  });
  const committed =
    claim.scope === "create_encrypted_note"
      ? await dependencies.adapter.createNote({ claim, command })
      : await dependencies.adapter.applyMutation({ claim, command });

  const committedResponse: EncryptedIdempotencyRecord = Object.freeze({
    ownerId: claim.ownerId,
    idempotencyKey: claim.idempotencyKey,
    keyClass: claim.historyKeyClass,
    requestMac,
    response: Object.freeze({
      ownerId: claim.ownerId,
      resourceId: `idempotency:${claim.idempotencyKey}`,
      recordVersion: 1,
      kind: "idempotency_response",
      envelope: committed.encryptedResponse.envelope,
      keyId: committed.encryptedResponse.keyId,
      keyClass: committed.encryptedResponse.keyClass,
      keyPurpose: committed.encryptedResponse.keyPurpose,
      keyVersion: committed.encryptedResponse.keyVersion
    })
  });
  const openedResponse = await dependencies.aggregate.openIdempotencyResponse(
    dependencies.access,
    committedResponse,
    {
      idempotencyKey: claim.idempotencyKey,
      transition,
      logicalRequest: input.logicalRequest,
      requestCodec: input.requestCodec,
      responseCodec: input.responseCodec
    }
  );
  return Object.freeze({
    response: openedResponse,
    replayed: committed.replayed,
    noteId: committed.noteId,
    mutationId: committed.mutationId,
    currentRevision: committed.currentRevision
  });
}

export function encryptedNoteWriteScopeFor(
  noteId: EntityId<"note"> | null
): EncryptedNoteWriteScope {
  return noteId === null ? "create_encrypted_note" : "apply_encrypted_note_mutation";
}
