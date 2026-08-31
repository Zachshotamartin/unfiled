import {
  authorizeAggregateOwner,
  type AggregateContentKind,
  type EncryptedAggregateService,
  type KeyedMacRecord,
  type PayloadCodec,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import type {
  CompletedEncryptedNoteWriteClaim,
  EncryptedNoteRpcAdapter,
  IncompleteEncryptedNoteWriteClaim
} from "./encrypted-note-rpc-adapter";
import {
  executeEncryptedNoteWrite,
  type EncryptedNoteWriteMaterial
} from "./encrypted-note-write-executor";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const REVISION = "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const IDEMPOTENCY_KEY = "encrypted-executor-create";
const OCCURRED_AT = "2026-08-30T22:54:12.345+00:00";

type RequestPayload = Readonly<{ title: string }>;
type ResponsePayload = Readonly<{ accepted: boolean }>;

const requestCodec: PayloadCodec<RequestPayload> = Object.freeze({
  parse(value: unknown) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof (value as Record<string, unknown>).title !== "string"
    ) {
      throw new TypeError("invalid request");
    }
    return Object.freeze({ title: (value as Record<string, string>).title ?? "" });
  }
});

const responseCodec: PayloadCodec<ResponsePayload> = Object.freeze({
  parse(value: unknown) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof (value as Record<string, unknown>).accepted !== "boolean"
    ) {
      throw new TypeError("invalid response");
    }
    return Object.freeze({
      accepted: (value as Record<string, boolean>).accepted ?? false
    });
  }
});

const request = Object.freeze({
  schemaVersion: 1 as const,
  scope: "create_encrypted_note",
  targetResourceId: null,
  expectedRevision: 0,
  payload: Object.freeze({ title: "Groceries" })
});

const mac: KeyedMacRecord = Object.freeze({
  value: "a".repeat(64),
  keyId: "private-mac-v1",
  keyClass: "private_manual",
  keyPurpose: "content_mac",
  keyVersion: 1
});

function claim(): IncompleteEncryptedNoteWriteClaim {
  return Object.freeze({
    ownerId: OWNER,
    idempotencyKey: IDEMPOTENCY_KEY,
    scope: "create_encrypted_note",
    noteId: NOTE,
    expectedRevision: 0,
    sourcePrivacy: null,
    targetPrivacy: "private_manual",
    historyKeyClass: "private_manual",
    revisionId: REVISION,
    mutationId: MUTATION,
    occurredAt: OCCURRED_AT,
    requestMacKey: Object.freeze({
      keyId: mac.keyId,
      keyClass: mac.keyClass,
      keyPurpose: mac.keyPurpose,
      keyVersion: mac.keyVersion
    }),
    completed: false,
    encryptedResponse: null
  });
}

function sealed<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  recordVersion: number
): SealedEncryptedAggregateRecord<Kind> {
  return Object.freeze({
    ownerId: OWNER,
    resourceId,
    recordVersion,
    kind,
    envelope: Object.freeze({
      version: 1 as const,
      suite: "A256GCM" as const,
      keyId: "private-wrap-v1",
      context: Object.freeze({ tenantId: OWNER, resourceId, recordVersion, kind }),
      wrappedDataKey: Object.freeze({ nonce: "A".repeat(16), ciphertext: "a".repeat(64) }),
      payload: Object.freeze({ nonce: "B".repeat(16), ciphertext: "b".repeat(64) })
    }),
    keyId: "private-wrap-v1",
    keyClass: "private_manual",
    keyPurpose: "object_wrap",
    keyVersion: 1,
    reservationId: `reservation:${kind}`
  });
}

function material(): EncryptedNoteWriteMaterial<ResponsePayload> {
  const snapshot = Object.freeze({
    spaceId: null,
    type: "generic" as const,
    title: "Groceries",
    bodyMarkdown: "Milk",
    structuredData: Object.freeze({ schemaVersion: 1 as const }),
    isOpen: true,
    pinnedAt: null,
    privacy: "private_manual" as const,
    archivedAt: null,
    deletedAt: null,
    tagIds: [],
    links: []
  });
  return Object.freeze({
    noteState: Object.freeze({
      ...snapshot,
      dailyDate: null
    }),
    noteContent: Object.freeze({
      schemaVersion: 1,
      title: snapshot.title,
      bodyMarkdown: snapshot.bodyMarkdown,
      structuredData: snapshot.structuredData
    }),
    revision: Object.freeze({
      id: REVISION,
      source: "manual" as const,
      actor: "user:create",
      payload: Object.freeze({ schemaVersion: 1, snapshot })
    }),
    mutation: Object.freeze({
      id: MUTATION,
      decisionId: null,
      undoTargetMutationId: null,
      payload: Object.freeze({
        schemaVersion: 1,
        action: "create" as const,
        beforeRevision: 0 as const,
        afterRevision: 1,
        operations: [{ type: "create_note" as const }] as [{ type: "create_note" }],
        inverse: Object.freeze({ type: "soft_delete_created_note" as const }),
        beforeSnapshot: null,
        afterSnapshot: snapshot
      })
    }),
    buildResponse: vi.fn(() => Object.freeze({ accepted: true }))
  });
}

function harness(options?: Readonly<{ verificationValid?: boolean }>) {
  const prepared = claim();
  const noteCipher = sealed("note_content", NOTE, 1);
  const revisionCipher = sealed("note_revision", REVISION, 1);
  const mutationCipher = sealed("note_mutation", MUTATION, 1);
  const responseCipher = sealed("idempotency_response", `idempotency:${IDEMPOTENCY_KEY}`, 1);
  const createNote = vi.fn<EncryptedNoteRpcAdapter["createNote"]>(() =>
    Promise.resolve({
      noteId: NOTE,
      mutationId: MUTATION,
      currentRevision: 1,
      encryptedResponse: {
        envelope: responseCipher.envelope,
        keyId: responseCipher.keyId,
        keyClass: responseCipher.keyClass,
        keyPurpose: responseCipher.keyPurpose,
        keyVersion: responseCipher.keyVersion
      },
      replayed: false,
      indexJobCount: 0
    })
  );
  const adapter = Object.freeze({
    getWriteClaim: vi.fn<EncryptedNoteRpcAdapter["getWriteClaim"]>(() => Promise.resolve(null)),
    prepareWrite: vi.fn<EncryptedNoteRpcAdapter["prepareWrite"]>(() =>
      Promise.resolve({ claim: prepared, replayed: false })
    ),
    createNote,
    applyMutation: vi.fn(() => Promise.reject(new Error("unexpected mutation")))
  }) satisfies EncryptedNoteRpcAdapter;
  const aggregate = {
    createIdempotencyRequestMac: vi.fn(() => Promise.resolve(mac)),
    sealNoteContent: vi.fn(() => Promise.resolve(noteCipher)),
    sealNoteRevision: vi.fn(() =>
      Promise.resolve(Object.freeze({ encrypted: revisionCipher, contentMac: mac }))
    ),
    sealNoteMutation: vi.fn(() => Promise.resolve(mutationCipher)),
    sealIdempotencyResponse: vi.fn(() => Promise.resolve(responseCipher)),
    openNoteContent: vi.fn(() => Promise.resolve(material().noteContent)),
    openNoteRevision: vi.fn(() => Promise.resolve(material().revision.payload)),
    openNoteMutation: vi.fn(() => Promise.resolve(material().mutation.payload)),
    openIdempotencyResponse: vi.fn(() => Promise.resolve(material().buildResponse(mac))),
    createAggregateVerificationMac: vi.fn(() => Promise.resolve(mac)),
    verifyAggregateVerificationMac: vi.fn(() =>
      Promise.resolve(options?.verificationValid !== false)
    )
  } as unknown as EncryptedAggregateService;
  return {
    adapter,
    aggregate,
    createNote,
    access: authorizeAggregateOwner({
      authenticatedOwnerId: OWNER,
      resourceOwnerId: OWNER
    })
  };
}

function input(buildMaterial = vi.fn(() => Promise.resolve(material()))) {
  return Object.freeze({
    coordinates: Object.freeze({
      ownerId: OWNER,
      scope: "create_encrypted_note" as const,
      idempotencyKey: IDEMPOTENCY_KEY,
      noteId: null,
      expectedRevision: 0
    }),
    logicalRequest: request,
    requestCodec,
    responseCodec,
    resolveNewTransition: vi.fn(() =>
      Promise.resolve(Object.freeze({ before: null, after: "private_manual" as const }))
    ),
    buildMaterial
  });
}

describe("encrypted note write execution", () => {
  it("opens every payload, verifies each evidence MAC, commits once, then opens the DB response", async () => {
    const dependencies = harness();
    const result = await executeEncryptedNoteWrite(dependencies, input());

    expect(result).toEqual({
      response: { accepted: true },
      replayed: false,
      noteId: NOTE,
      mutationId: MUTATION,
      currentRevision: 1
    });
    expect(dependencies.aggregate.openIdempotencyResponse).toHaveBeenCalledTimes(2);
    expect(dependencies.aggregate.verifyAggregateVerificationMac).toHaveBeenCalledTimes(3);
    expect(dependencies.createNote).toHaveBeenCalledOnce();
    expect(dependencies.createNote.mock.calls[0]?.[0].command).toMatchObject({
      occurredAt: OCCURRED_AT,
      noteState: { title: "Groceries", privacy: "private_manual" },
      revision: { id: REVISION, mac: { mac: mac.value } },
      mutation: {
        id: MUTATION,
        undoTargetMutationId: null,
        operations: [{ type: "create_note" }],
        inverse: { type: "soft_delete_created_note" }
      },
      verification: {
        noteContent: { mac: mac.value },
        noteMutation: { mac: mac.value },
        idempotencyResponse: { mac: mac.value }
      }
    });
  });

  it("does not submit when a precommit verification MAC fails", async () => {
    const dependencies = harness({ verificationValid: false });
    await expect(executeEncryptedNoteWrite(dependencies, input())).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    expect(dependencies.createNote).not.toHaveBeenCalled();
  });

  it("rejects material whose encrypted snapshot does not match the authoritative state", async () => {
    const dependencies = harness();
    const mismatched = material();
    const buildMaterial = vi.fn(() =>
      Promise.resolve({
        ...mismatched,
        noteContent: { ...mismatched.noteContent, title: "Tampered" }
      })
    );
    await expect(
      executeEncryptedNoteWrite(dependencies, input(buildMaterial))
    ).rejects.toBeInstanceOf(ServiceRpcError);
    expect(dependencies.aggregate.sealNoteContent).not.toHaveBeenCalled();
    expect(dependencies.createNote).not.toHaveBeenCalled();
  });

  it("returns a completed claim without rebuilding or resealing content", async () => {
    const dependencies = harness();
    const completed: CompletedEncryptedNoteWriteClaim = Object.freeze({
      ...claim(),
      completed: true,
      encryptedResponse: Object.freeze({
        envelope: sealed("idempotency_response", `idempotency:${IDEMPOTENCY_KEY}`, 1).envelope,
        keyId: "private-wrap-v1",
        keyClass: "private_manual",
        keyPurpose: "object_wrap",
        keyVersion: 1
      })
    });
    dependencies.adapter.getWriteClaim.mockResolvedValue(completed);
    dependencies.adapter.prepareWrite.mockResolvedValue({ claim: completed, replayed: true });
    const buildMaterial = vi.fn(() => Promise.resolve(material()));

    await expect(executeEncryptedNoteWrite(dependencies, input(buildMaterial))).resolves.toEqual({
      response: { accepted: true },
      replayed: true,
      noteId: NOTE,
      mutationId: MUTATION,
      currentRevision: 1
    });
    expect(buildMaterial).not.toHaveBeenCalled();
    expect(dependencies.aggregate.sealNoteContent).not.toHaveBeenCalled();
    expect(dependencies.createNote).not.toHaveBeenCalled();
  });
});
