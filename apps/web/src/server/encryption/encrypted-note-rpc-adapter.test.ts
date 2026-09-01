import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import type { EncryptedFieldRpcValue, KeyedMacRpcValue } from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedNoteRpcAdapter,
  encryptedNoteWriteRpcFunctions,
  type EncryptedNoteWriteCommand,
  type EncryptedNoteWriteRequest,
  type IncompleteEncryptedNoteWriteClaim
} from "./encrypted-note-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = `note_${"0".repeat(26)}` as const;
const OTHER_NOTE_ID = `note_${"1".repeat(26)}` as const;
const REVISION_ID = `rev_${"2".repeat(26)}` as const;
const MUTATION_ID = `mut_${"3".repeat(26)}` as const;
const OTHER_MUTATION_ID = `mut_${"7".repeat(26)}` as const;
const DECISION_ID = `dec_${"4".repeat(26)}` as const;
const IDEMPOTENCY_KEY = "note-write-request-1";
const OCCURRED_AT = "2026-08-30T22:54:12.345+00:00";
const REQUEST_MAC = "a".repeat(64);
const RESPONSE_CANARY = "plaintext-response-canary";
const RESERVATIONS = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
  "20000000-0000-4000-8000-000000000004"
] as const;

type TestKeyClass = "ai_assisted" | "private_manual";

function client(implementation: ServiceRpcClient["rpc"]): ServiceRpcClient {
  return Object.freeze({ rpc: implementation });
}

function keyId(keyClass: TestKeyClass, purpose: "content_mac" | "object_wrap"): string {
  return `key_${keyClass}_${purpose}_v1`;
}

function requestMac(keyClass: TestKeyClass = "ai_assisted", keyVersion = 1): KeyedMacRpcValue {
  return {
    mac: REQUEST_MAC,
    keyId: keyId(keyClass, "content_mac"),
    keyClass,
    keyPurpose: "content_mac",
    keyVersion
  };
}

function envelope(
  resourceId: string,
  recordVersion: number,
  kind: "idempotency_response" | "note_content" | "note_mutation" | "note_revision",
  wrappingKeyId: string,
  ownerId = OWNER_ID
): ContentEnvelopeV1 {
  return {
    version: 1,
    suite: "A256GCM",
    keyId: wrappingKeyId,
    context: { tenantId: ownerId, resourceId, recordVersion, kind },
    wrappedDataKey: {
      nonce: "A".repeat(16),
      ciphertext: "A".repeat(64)
    },
    payload: {
      nonce: "A".repeat(16),
      ciphertext: "A".repeat(22)
    }
  };
}

function writeCipher<
  Kind extends "idempotency_response" | "note_content" | "note_mutation" | "note_revision"
>(
  kind: Kind,
  resourceId: string,
  recordVersion: number,
  keyClass: TestKeyClass,
  reservationId: string
): EncryptedFieldRpcValue<Kind> {
  const wrappingKeyId = keyId(keyClass, "object_wrap");
  return {
    envelope: envelope(resourceId, recordVersion, kind, wrappingKeyId),
    keyId: wrappingKeyId,
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1,
    reservationId
  };
}

function storedCipher(
  value: EncryptedFieldRpcValue<"idempotency_response">
): Record<string, unknown> {
  return {
    envelope: value.envelope,
    keyId: value.keyId,
    keyClass: value.keyClass,
    keyPurpose: value.keyPurpose,
    keyVersion: value.keyVersion
  };
}

function withPayloadCiphertext<
  Kind extends "idempotency_response" | "note_content" | "note_mutation" | "note_revision"
>(value: EncryptedFieldRpcValue<Kind>, ciphertext: string): EncryptedFieldRpcValue<Kind> {
  return {
    ...value,
    envelope: {
      ...value.envelope,
      payload: {
        ...value.envelope.payload,
        ciphertext
      }
    }
  };
}

function createRequest(keyClass: TestKeyClass = "ai_assisted"): EncryptedNoteWriteRequest {
  return {
    ownerId: OWNER_ID,
    scope: "create_encrypted_note",
    idempotencyKey: IDEMPOTENCY_KEY,
    noteId: null,
    expectedRevision: 0,
    targetPrivacy: keyClass,
    requestMac: requestMac(keyClass)
  };
}

function mutationRequest(
  options: Readonly<{
    requestKeyClass?: TestKeyClass;
    targetPrivacy?: TestKeyClass;
  }> = {}
): EncryptedNoteWriteRequest {
  const requestKeyClass = options.requestKeyClass ?? "ai_assisted";
  return {
    ownerId: OWNER_ID,
    scope: "apply_encrypted_note_mutation",
    idempotencyKey: IDEMPOTENCY_KEY,
    noteId: NOTE_ID,
    expectedRevision: 1,
    targetPrivacy: options.targetPrivacy ?? "ai_assisted",
    requestMac: requestMac(requestKeyClass)
  };
}

function claimProjection(
  request: EncryptedNoteWriteRequest,
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  const historyKeyClass = request.requestMac.keyClass;
  const sourcePrivacy =
    request.scope === "create_encrypted_note"
      ? null
      : historyKeyClass === "private_manual" && request.targetPrivacy === "ai_assisted"
        ? "private_manual"
        : request.targetPrivacy;
  return {
    scope: request.scope,
    noteId: request.noteId ?? NOTE_ID,
    expectedRevision: request.expectedRevision,
    sourcePrivacy,
    targetPrivacy: request.targetPrivacy,
    historyKeyClass,
    revisionId: REVISION_ID,
    mutationId: MUTATION_ID,
    occurredAt: OCCURRED_AT,
    commandProjection: "legacy",
    requestMacKey: {
      keyId: request.requestMac.keyId,
      keyClass: request.requestMac.keyClass,
      keyPurpose: request.requestMac.keyPurpose,
      keyVersion: request.requestMac.keyVersion
    },
    completed: false,
    encryptedResponse: null,
    ...overrides
  };
}

function incompleteClaim(
  scope: "apply_encrypted_note_mutation" | "create_encrypted_note" = "create_encrypted_note",
  options: Readonly<{
    historyKeyClass?: TestKeyClass;
    sourcePrivacy?: TestKeyClass;
    targetPrivacy?: TestKeyClass;
  }> = {}
): IncompleteEncryptedNoteWriteClaim {
  const historyKeyClass = options.historyKeyClass ?? "ai_assisted";
  return {
    ownerId: OWNER_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    scope,
    noteId: NOTE_ID,
    expectedRevision: scope === "create_encrypted_note" ? 0 : 1,
    sourcePrivacy:
      scope === "create_encrypted_note" ? null : (options.sourcePrivacy ?? historyKeyClass),
    targetPrivacy: options.targetPrivacy ?? "ai_assisted",
    historyKeyClass,
    revisionId: REVISION_ID,
    mutationId: MUTATION_ID,
    occurredAt: OCCURRED_AT,
    commandProjection: "legacy",
    requestMacKey: {
      keyId: keyId(historyKeyClass, "content_mac"),
      keyClass: historyKeyClass,
      keyPurpose: "content_mac",
      keyVersion: 1
    },
    completed: false,
    encryptedResponse: null
  };
}

function command(claim: IncompleteEncryptedNoteWriteClaim): EncryptedNoteWriteCommand {
  const afterRevision = claim.expectedRevision + 1;
  const create = claim.scope === "create_encrypted_note";
  return {
    occurredAt: claim.occurredAt,
    noteState: {
      spaceId: null,
      type: "generic",
      title: "Encrypted note",
      bodyMarkdown: "Ciphertext is authoritative.",
      structuredData: { schemaVersion: 1 },
      dailyDate: null,
      isOpen: true,
      privacy: claim.targetPrivacy,
      pinnedAt: null,
      archivedAt: null,
      deletedAt: null,
      tagIds: [],
      links: []
    },
    noteCipher: writeCipher(
      "note_content",
      claim.noteId,
      afterRevision,
      claim.targetPrivacy,
      RESERVATIONS[0]
    ),
    revision: {
      id: claim.revisionId,
      source: "manual",
      actor: `user:${OWNER_ID}`,
      cipher: writeCipher(
        "note_revision",
        claim.revisionId,
        afterRevision,
        claim.historyKeyClass,
        RESERVATIONS[1]
      ),
      mac: requestMac(claim.historyKeyClass)
    },
    mutation: {
      id: claim.mutationId,
      decisionId: create ? null : DECISION_ID,
      undoTargetMutationId: null,
      operations: create
        ? [{ type: "create_note" }]
        : [{ type: "set_title", title: "Encrypted note" }],
      inverse: create
        ? { type: "soft_delete_created_note" }
        : [{ type: "set_title", title: "Previous title" }],
      cipher: writeCipher(
        "note_mutation",
        claim.mutationId,
        afterRevision,
        claim.historyKeyClass,
        RESERVATIONS[2]
      )
    },
    requestMac: requestMac(claim.historyKeyClass),
    responseCipher: writeCipher(
      "idempotency_response",
      `idempotency:${claim.idempotencyKey}`,
      1,
      claim.historyKeyClass,
      RESERVATIONS[3]
    ),
    verification: {
      noteContent: requestMac(claim.targetPrivacy),
      noteMutation: requestMac(claim.historyKeyClass),
      idempotencyResponse: requestMac(claim.historyKeyClass)
    }
  };
}

function writeResult(
  claim: IncompleteEncryptedNoteWriteClaim,
  submitted: EncryptedNoteWriteCommand,
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    noteId: claim.noteId,
    mutationId: claim.mutationId,
    currentRevision: claim.expectedRevision + 1,
    encryptedResponse: storedCipher(submitted.responseCipher),
    replayed: false,
    indexJobCount: 1,
    ...overrides
  };
}

async function expectServiceFailure(
  result: Promise<unknown>,
  code: (typeof ServiceRpcErrorCode)[keyof typeof ServiceRpcErrorCode],
  canary?: string
): Promise<void> {
  let reason: unknown;
  try {
    await result;
  } catch (error: unknown) {
    reason = error;
  }
  expect(reason).toBeInstanceOf(ServiceRpcError);
  expect(reason).toMatchObject({ code });
  if (canary !== undefined) {
    expect(String(reason)).not.toContain(canary);
    expect(JSON.stringify(reason)).not.toContain(canary);
  }
}

describe("encrypted note write RPC adapter", () => {
  it("keeps the frozen four-function capability allowlist exact", () => {
    expect(encryptedNoteWriteRpcFunctions).toEqual([
      "get_encrypted_note_write_claim",
      "prepare_encrypted_note_write",
      "create_encrypted_note",
      "apply_encrypted_note_mutation"
    ]);
  });

  it("prepares a create with exact parameters and binds the generated claim", async () => {
    const request = createRequest();
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      ...claimProjection(request),
      replayed: false
    });
    const adapter = createEncryptedNoteRpcAdapter(client(rpc));

    await expect(adapter.prepareWrite(request)).resolves.toEqual({
      claim: {
        ownerId: OWNER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        scope: "create_encrypted_note",
        noteId: NOTE_ID,
        expectedRevision: 0,
        sourcePrivacy: null,
        targetPrivacy: "ai_assisted",
        historyKeyClass: "ai_assisted",
        revisionId: REVISION_ID,
        mutationId: MUTATION_ID,
        occurredAt: OCCURRED_AT,
        commandProjection: "legacy",
        requestMacKey: {
          keyId: keyId("ai_assisted", "content_mac"),
          keyClass: "ai_assisted",
          keyPurpose: "content_mac",
          keyVersion: 1
        },
        completed: false,
        encryptedResponse: null
      },
      replayed: false
    });
    expect(rpc).toHaveBeenCalledWith("prepare_encrypted_note_write", {
      p_owner_id: OWNER_ID,
      p_scope: "create_encrypted_note",
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_note_id: null,
      p_expected_revision: 0,
      p_target_privacy: "ai_assisted",
      p_request_mac: request.requestMac
    });
  });

  it("accepts a sticky private history key when a mutation targets AI-assisted privacy", async () => {
    const request = mutationRequest({ requestKeyClass: "private_manual" });
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      ...claimProjection(request),
      replayed: false
    });
    const adapter = createEncryptedNoteRpcAdapter(client(rpc));

    const prepared = await adapter.prepareWrite(request);
    expect(prepared.claim).toMatchObject({
      targetPrivacy: "ai_assisted",
      historyKeyClass: "private_manual",
      requestMacKey: { keyClass: "private_manual" }
    });
  });

  it("looks claims up with only owner, scope, and idempotency key", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({ found: false });
    const adapter = createEncryptedNoteRpcAdapter(client(rpc));

    await expect(
      adapter.getWriteClaim({
        ownerId: OWNER_ID,
        scope: "create_encrypted_note",
        idempotencyKey: IDEMPOTENCY_KEY
      })
    ).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith("get_encrypted_note_write_claim", {
      p_owner_id: OWNER_ID,
      p_scope: "create_encrypted_note",
      p_idempotency_key: IDEMPOTENCY_KEY
    });
  });

  it("recovers a claim bound to a retired MAC key before request-MAC recomputation", async () => {
    const retiredRequest: EncryptedNoteWriteRequest = {
      ...createRequest(),
      requestMac: {
        ...requestMac(),
        keyId: "key_ai_assisted_content_mac_retired_v7",
        keyVersion: 7
      }
    };
    const retiredKeyProjection = claimProjection(retiredRequest);
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({ found: true, ...retiredKeyProjection })
      .mockResolvedValueOnce({ ...retiredKeyProjection, replayed: true });
    const adapter = createEncryptedNoteRpcAdapter(client(rpc));

    const existing = await adapter.getWriteClaim({
      ownerId: OWNER_ID,
      scope: "create_encrypted_note",
      idempotencyKey: IDEMPOTENCY_KEY
    });
    expect(existing).toMatchObject({
      requestMacKey: {
        keyId: "key_ai_assisted_content_mac_retired_v7",
        keyVersion: 7
      }
    });

    await expect(adapter.prepareWrite(retiredRequest)).resolves.toMatchObject({
      claim: { requestMacKey: { keyVersion: 7 } },
      replayed: true
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "prepare_encrypted_note_write", {
      p_owner_id: OWNER_ID,
      p_scope: "create_encrypted_note",
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_note_id: null,
      p_expected_revision: 0,
      p_target_privacy: "ai_assisted",
      p_request_mac: retiredRequest.requestMac
    });
  });

  it("fails closed for malformed claim lookups and projections", async () => {
    for (const input of [
      {
        ownerId: OWNER_ID,
        scope: "create_encrypted_note",
        idempotencyKey: IDEMPOTENCY_KEY,
        extra: RESPONSE_CANARY
      },
      {
        ownerId: "not-an-owner",
        scope: "create_encrypted_note",
        idempotencyKey: IDEMPOTENCY_KEY
      }
    ]) {
      const rpc = vi.fn<ServiceRpcClient["rpc"]>();
      const adapter = createEncryptedNoteRpcAdapter(client(rpc));
      await expectServiceFailure(
        adapter.getWriteClaim(input as never),
        ServiceRpcErrorCode.VALIDATION_FAILED,
        RESPONSE_CANARY
      );
      expect(rpc).not.toHaveBeenCalled();
    }

    const projection = claimProjection(createRequest());
    for (const result of [
      { found: false, extra: RESPONSE_CANARY },
      { found: "true", ...projection },
      { found: true, ...projection, scope: "apply_encrypted_note_mutation" },
      { found: true, ...projection, completed: true, encryptedResponse: null },
      { found: true, ...projection, [RESPONSE_CANARY]: RESPONSE_CANARY }
    ]) {
      const adapter = createEncryptedNoteRpcAdapter(
        client(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(result))
      );
      await expectServiceFailure(
        adapter.getWriteClaim({
          ownerId: OWNER_ID,
          scope: "create_encrypted_note",
          idempotencyKey: IDEMPOTENCY_KEY
        }),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
        RESPONSE_CANARY
      );
    }
  });

  it("requires completed claims to carry a valid encrypted response and be replayed", async () => {
    const request = createRequest();
    const response = writeCipher(
      "idempotency_response",
      `idempotency:${IDEMPOTENCY_KEY}`,
      1,
      "ai_assisted",
      RESERVATIONS[3]
    );
    const validCompleted = {
      ...claimProjection(request),
      completed: true,
      encryptedResponse: storedCipher(response),
      replayed: true
    };
    const adapter = createEncryptedNoteRpcAdapter(
      client(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(validCompleted))
    );
    await expect(adapter.prepareWrite(request)).resolves.toMatchObject({
      claim: { completed: true, encryptedResponse: { keyClass: "ai_assisted" } },
      replayed: true
    });

    for (const invalid of [
      { ...validCompleted, encryptedResponse: null },
      {
        ...claimProjection(request),
        encryptedResponse: storedCipher(response),
        replayed: true
      },
      { ...validCompleted, replayed: false }
    ]) {
      const invalidAdapter = createEncryptedNoteRpcAdapter(
        client(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(invalid))
      );
      await expectServiceFailure(
        invalidAdapter.prepareWrite(request),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
      );
    }
  });

  it("fails closed when a prepared claim changes stable request fields", async () => {
    const request = mutationRequest();
    const base = claimProjection(request);
    const invalidClaims = [
      { ...base, scope: "create_encrypted_note" },
      { ...base, noteId: OTHER_NOTE_ID },
      { ...base, expectedRevision: 2 },
      { ...base, sourcePrivacy: "private_manual" },
      { ...base, targetPrivacy: "private_manual" },
      { ...base, historyKeyClass: "private_manual" },
      { ...base, revisionId: NOTE_ID },
      { ...base, mutationId: REVISION_ID },
      { ...base, occurredAt: "not-a-timestamp" },
      {
        ...base,
        requestMacKey: { ...(base.requestMacKey as Record<string, unknown>), keyVersion: 2 }
      },
      { ...base, [RESPONSE_CANARY]: RESPONSE_CANARY }
    ];

    for (const projection of invalidClaims) {
      const adapter = createEncryptedNoteRpcAdapter(
        client(
          vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
            ...projection,
            replayed: false
          })
        )
      );
      await expectServiceFailure(
        adapter.prepareWrite(request),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
        RESPONSE_CANARY
      );
    }
  });

  it("submits a fresh create with the exact frozen command parameters", async () => {
    const claim = incompleteClaim();
    const submitted: EncryptedNoteWriteCommand = {
      ...command(claim),
      occurredAt: "2026-08-30T15:54:12.345-07:00"
    };
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(writeResult(claim, submitted));
    const adapter = createEncryptedNoteRpcAdapter(client(rpc));

    await expect(adapter.createNote({ claim, command: submitted })).resolves.toMatchObject({
      noteId: NOTE_ID,
      mutationId: MUTATION_ID,
      currentRevision: 1,
      encryptedResponse: { keyClass: "ai_assisted", keyPurpose: "object_wrap" },
      replayed: false,
      indexJobCount: 1
    });
    expect(rpc).toHaveBeenCalledWith("create_encrypted_note", {
      p_owner_id: OWNER_ID,
      p_note_id: NOTE_ID,
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_command: submitted
    });
  });

  it("submits mutation CAS parameters and accepts original ciphertext on replay", async () => {
    const claim = incompleteClaim("apply_encrypted_note_mutation");
    const submitted = command(claim);
    const originalResponse = withPayloadCiphertext(
      writeCipher(
        "idempotency_response",
        `idempotency:${IDEMPOTENCY_KEY}`,
        1,
        "ai_assisted",
        RESERVATIONS[3]
      ),
      `${"B".repeat(21)}A`
    );
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      noteId: NOTE_ID,
      mutationId: MUTATION_ID,
      currentRevision: 2,
      encryptedResponse: storedCipher(originalResponse),
      replayed: true
    });
    const adapter = createEncryptedNoteRpcAdapter(client(rpc));

    await expect(adapter.applyMutation({ claim, command: submitted })).resolves.toMatchObject({
      currentRevision: 2,
      replayed: true
    });
    expect(rpc).toHaveBeenCalledWith("apply_encrypted_note_mutation", {
      p_owner_id: OWNER_ID,
      p_note_id: NOTE_ID,
      p_expected_revision: 1,
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_command: submitted
    });
  });

  it("accepts an exact undo target only for an undo revision", async () => {
    const claim = incompleteClaim("apply_encrypted_note_mutation");
    const base = command(claim);
    const submitted: EncryptedNoteWriteCommand = {
      ...base,
      revision: { ...base.revision, source: "undo" },
      mutation: { ...base.mutation, undoTargetMutationId: OTHER_MUTATION_ID }
    };
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(writeResult(claim, submitted));

    await expect(
      createEncryptedNoteRpcAdapter(client(rpc)).applyMutation({ claim, command: submitted })
    ).resolves.toMatchObject({ currentRevision: 2, replayed: false });
    expect(rpc).toHaveBeenCalledWith(
      "apply_encrypted_note_mutation",
      expect.objectContaining({ p_command: submitted })
    );
  });

  it("rejects malformed or cross-boundary commands before calling the database", async () => {
    const claim = incompleteClaim();
    const valid = command(claim);
    const invalidCommands: unknown[] = [
      { ...valid, plaintext: RESPONSE_CANARY },
      { ...valid, occurredAt: "2026-08-30T22:54:12.346+00:00" },
      { ...valid, occurredAt: "2026-08-30T22:54:12.345001+00:00" },
      {
        ...valid,
        verification: { ...valid.verification, noteContent: requestMac("private_manual") }
      },
      {
        ...valid,
        verification: { ...valid.verification, extra: RESPONSE_CANARY }
      },
      { ...valid, noteState: { ...valid.noteState, privacy: "private_manual" } },
      {
        ...valid,
        noteState: {
          ...valid.noteState,
          links: [{ toNoteId: NOTE_ID, linkType: "related" }]
        }
      },
      { ...valid, noteState: { ...valid.noteState, structuredData: { schemaVersion: 2 } } },
      { ...valid, noteCipher: { ...valid.noteCipher, keyClass: "private_manual" } },
      {
        ...valid,
        noteCipher: {
          ...valid.noteCipher,
          envelope: {
            ...valid.noteCipher.envelope,
            context: { ...valid.noteCipher.envelope.context, resourceId: OTHER_NOTE_ID }
          }
        }
      },
      { ...valid, noteCipher: { ...valid.noteCipher, reservationId: "not-a-uuid" } },
      { ...valid, revision: { ...valid.revision, id: `rev_${"5".repeat(26)}` } },
      { ...valid, mutation: { ...valid.mutation, id: `mut_${"6".repeat(26)}` } },
      { ...valid, mutation: { ...valid.mutation, undoTargetMutationId: OTHER_MUTATION_ID } },
      {
        ...valid,
        revision: { ...valid.revision, source: "undo" },
        mutation: { ...valid.mutation, undoTargetMutationId: null }
      },
      { ...valid, requestMac: { ...valid.requestMac, keyVersion: 2 } },
      {
        ...valid,
        mutation: { ...valid.mutation, operations: [{ type: "set_title", title: "wrong" }] }
      },
      {
        ...valid,
        mutation: { ...valid.mutation, inverse: [{ type: "set_title", title: "wrong" }] }
      }
    ];

    for (const invalid of invalidCommands) {
      const rpc = vi.fn<ServiceRpcClient["rpc"]>();
      const adapter = createEncryptedNoteRpcAdapter(client(rpc));
      await expectServiceFailure(
        adapter.createNote({ claim, command: invalid } as never),
        ServiceRpcErrorCode.VALIDATION_FAILED,
        RESPONSE_CANARY
      );
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("rejects the wrong claim state, scope, and malformed request parameters before RPC", async () => {
    const incomplete = incompleteClaim();
    const submitted = command(incomplete);
    const completed = {
      ...incomplete,
      completed: true,
      encryptedResponse: storedCipher(submitted.responseCipher)
    };
    const invalidSubmissions: unknown[] = [
      { claim: completed, command: submitted },
      { claim: incompleteClaim("apply_encrypted_note_mutation"), command: submitted },
      { claim: incomplete, command: submitted, extra: RESPONSE_CANARY }
    ];
    for (const invalid of invalidSubmissions) {
      const rpc = vi.fn<ServiceRpcClient["rpc"]>();
      const adapter = createEncryptedNoteRpcAdapter(client(rpc));
      await expectServiceFailure(
        adapter.createNote(invalid as never),
        ServiceRpcErrorCode.VALIDATION_FAILED,
        RESPONSE_CANARY
      );
      expect(rpc).not.toHaveBeenCalled();
    }

    const invalidRequests: unknown[] = [
      { ...createRequest(), ownerId: "not-an-owner" },
      { ...createRequest(), idempotencyKey: " spaces " },
      { ...createRequest(), noteId: NOTE_ID },
      { ...createRequest(), expectedRevision: 1 },
      { ...createRequest(), requestMac: requestMac("private_manual") },
      { ...mutationRequest(), noteId: "note_bad" },
      { ...mutationRequest(), expectedRevision: 0 },
      {
        ...mutationRequest({ targetPrivacy: "private_manual" }),
        requestMac: requestMac("ai_assisted")
      }
    ];
    for (const invalid of invalidRequests) {
      const rpc = vi.fn<ServiceRpcClient["rpc"]>();
      const adapter = createEncryptedNoteRpcAdapter(client(rpc));
      await expectServiceFailure(
        adapter.prepareWrite(invalid as never),
        ServiceRpcErrorCode.VALIDATION_FAILED
      );
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("fails closed for malformed write results and swapped fresh response ciphertext", async () => {
    const claim = incompleteClaim();
    const submitted = command(claim);
    const swappedResponse = withPayloadCiphertext(
      writeCipher(
        "idempotency_response",
        `idempotency:${IDEMPOTENCY_KEY}`,
        1,
        "ai_assisted",
        RESERVATIONS[3]
      ),
      `${"B".repeat(21)}A`
    );
    const valid = writeResult(claim, submitted);
    const invalidResults = [
      { ...valid, noteId: OTHER_NOTE_ID },
      { ...valid, mutationId: `mut_${"7".repeat(26)}` },
      { ...valid, currentRevision: 2 },
      { ...valid, encryptedResponse: storedCipher(swappedResponse) },
      { ...valid, indexJobCount: -1 },
      { ...valid, indexJobCount: 1.5 },
      { ...valid, replayed: true },
      { ...valid, [RESPONSE_CANARY]: RESPONSE_CANARY }
    ];

    for (const result of invalidResults) {
      const adapter = createEncryptedNoteRpcAdapter(
        client(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(result))
      );
      await expectServiceFailure(
        adapter.createNote({ claim, command: submitted }),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
        RESPONSE_CANARY
      );
    }
  });
});
