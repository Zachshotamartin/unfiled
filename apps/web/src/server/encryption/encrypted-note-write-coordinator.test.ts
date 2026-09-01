import {
  authorizeAggregateOwner,
  type EncryptedAggregateService,
  type KeyedMacRecord,
  type LogicalApiRequest,
  type PayloadCodec
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import type {
  CompletedEncryptedNoteWriteClaim,
  EncryptedNoteRpcAdapter,
  IncompleteEncryptedNoteWriteClaim
} from "./encrypted-note-rpc-adapter";
import { prepareEncryptedNoteWrite } from "./encrypted-note-write-coordinator";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const REVISION = "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const REVISION_B = "rev_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const MUTATION_B = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const IDEMPOTENCY_KEY = "note-write-1";
const OCCURRED_AT = "2026-08-30T22:54:12.345+00:00";

type RequestPayload = Readonly<{ title: string }>;
type ResponsePayload = Readonly<{ accepted: boolean }>;
type CreateRequestMacAccess = Parameters<
  EncryptedAggregateService["createIdempotencyRequestMac"]
>[0];
type CreateRequestMacInput = Parameters<
  EncryptedAggregateService["createIdempotencyRequestMac"]
>[1];
type PrepareWriteInput = Parameters<EncryptedNoteRpcAdapter["prepareWrite"]>[0];

const requestCodec: PayloadCodec<RequestPayload> = Object.freeze({
  parse(value: unknown): RequestPayload {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof (value as Readonly<Record<string, unknown>>).title !== "string"
    ) {
      throw new TypeError("invalid request");
    }
    return Object.freeze({ title: (value as Readonly<Record<string, string>>).title ?? "" });
  }
});

const responseCodec: PayloadCodec<ResponsePayload> = Object.freeze({
  parse(value: unknown): ResponsePayload {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof (value as Readonly<Record<string, unknown>>).accepted !== "boolean"
    ) {
      throw new TypeError("invalid response");
    }
    return Object.freeze({
      accepted: (value as Readonly<Record<string, boolean>>).accepted ?? false
    });
  }
});

const logicalRequest: LogicalApiRequest<RequestPayload> = Object.freeze({
  schemaVersion: 1,
  scope: "create_encrypted_note",
  targetResourceId: null,
  expectedRevision: 0,
  payload: Object.freeze({ title: "Groceries" })
});

const retiredMac: KeyedMacRecord = Object.freeze({
  value: "a".repeat(64),
  keyId: "mac-retired-v1",
  keyClass: "private_manual",
  keyPurpose: "content_mac",
  keyVersion: 1
});

const activeMac: KeyedMacRecord = Object.freeze({
  value: "b".repeat(64),
  keyId: "mac-active-v2",
  keyClass: "private_manual",
  keyPurpose: "content_mac",
  keyVersion: 2
});

function incompleteCreateClaim(): IncompleteEncryptedNoteWriteClaim {
  return Object.freeze({
    ownerId: OWNER,
    idempotencyKey: IDEMPOTENCY_KEY,
    scope: "create_encrypted_note",
    noteId: NOTE_A,
    expectedRevision: 0,
    sourcePrivacy: null,
    targetPrivacy: "private_manual",
    historyKeyClass: "private_manual",
    revisionId: REVISION,
    mutationId: MUTATION,
    occurredAt: OCCURRED_AT,
    commandProjection: "legacy",
    requestMacKey: Object.freeze({
      keyId: retiredMac.keyId,
      keyClass: retiredMac.keyClass,
      keyPurpose: retiredMac.keyPurpose,
      keyVersion: retiredMac.keyVersion
    }),
    completed: false,
    encryptedResponse: null
  });
}

function completedCreateClaim(): CompletedEncryptedNoteWriteClaim {
  return Object.freeze({
    ...incompleteCreateClaim(),
    completed: true,
    encryptedResponse: Object.freeze({
      envelope: Object.freeze({
        version: 1,
        suite: "A256GCM",
        keyId: "wrap-retired-v1",
        context: Object.freeze({
          tenantId: OWNER,
          resourceId: `idempotency:${IDEMPOTENCY_KEY}`,
          recordVersion: 1,
          kind: "idempotency_response"
        }),
        wrappedDataKey: Object.freeze({ nonce: "AAAAAAAAAAAAAAAA", ciphertext: "A".repeat(64) }),
        payload: Object.freeze({ nonce: "BBBBBBBBBBBBBBBB", ciphertext: "B".repeat(64) })
      }),
      keyId: "wrap-retired-v1",
      keyClass: "private_manual",
      keyPurpose: "object_wrap",
      keyVersion: 1
    })
  });
}

function dependencies(
  input: Readonly<{
    getWriteClaim: EncryptedNoteRpcAdapter["getWriteClaim"];
    prepareWrite: EncryptedNoteRpcAdapter["prepareWrite"];
    createRequestMac?: EncryptedAggregateService["createIdempotencyRequestMac"];
    openResponse?: (
      access: CreateRequestMacAccess,
      record: unknown,
      options: unknown
    ) => Promise<unknown>;
  }>
): Readonly<{
  adapter: EncryptedNoteRpcAdapter;
  aggregate: EncryptedAggregateService;
  access: Parameters<EncryptedAggregateService["createIdempotencyRequestMac"]>[0];
}> {
  const aggregate = {
    createIdempotencyRequestMac: input.createRequestMac ?? vi.fn(() => Promise.resolve(activeMac)),
    openIdempotencyResponse:
      input.openResponse ?? vi.fn(() => Promise.resolve(Object.freeze({ accepted: true })))
  } as unknown as EncryptedAggregateService;
  const adapter = {
    getWriteClaim: input.getWriteClaim,
    prepareWrite: input.prepareWrite,
    createNote: vi.fn(() => Promise.reject(new Error("unexpected create"))),
    applyMutation: vi.fn(() => Promise.reject(new Error("unexpected mutation")))
  } satisfies EncryptedNoteRpcAdapter;
  return Object.freeze({
    adapter,
    aggregate,
    access: authorizeAggregateOwner({
      authenticatedOwnerId: OWNER,
      resourceOwnerId: OWNER
    })
  });
}

function createInput(
  resolveNewTransition: () => Promise<
    Readonly<{
      before: null;
      after: "private_manual";
    }>
  >
) {
  return Object.freeze({
    coordinates: Object.freeze({
      ownerId: OWNER,
      scope: "create_encrypted_note" as const,
      idempotencyKey: IDEMPOTENCY_KEY,
      noteId: null,
      expectedRevision: 0
    }),
    logicalRequest,
    requestCodec,
    responseCodec,
    resolveNewTransition
  });
}

describe("encrypted note write preparation", () => {
  it("recomputes a completed claim under its exact retired MAC key before opening it", async () => {
    const events: string[] = [];
    const claim = completedCreateClaim();
    const getWriteClaim = vi.fn(() => {
      events.push("lookup");
      return Promise.resolve(claim);
    });
    const createRequestMac = vi.fn(
      (_access: CreateRequestMacAccess, input: CreateRequestMacInput) => {
        events.push("mac");
        expect(input.keyReference).toEqual({
          ownerId: OWNER,
          keyId: retiredMac.keyId,
          keyClass: "private_manual",
          purpose: "content_mac",
          keyVersion: 1
        });
        return Promise.resolve(retiredMac);
      }
    );
    const prepareWrite = vi.fn(() => {
      events.push("prepare");
      return Promise.resolve({ claim, replayed: true });
    });
    const openResponse = vi.fn((_access, record) => {
      events.push("open");
      expect(record).toMatchObject({
        ownerId: OWNER,
        idempotencyKey: IDEMPOTENCY_KEY,
        requestMac: retiredMac,
        response: {
          resourceId: `idempotency:${IDEMPOTENCY_KEY}`,
          kind: "idempotency_response",
          keyId: "wrap-retired-v1"
        }
      });
      return Promise.resolve(Object.freeze({ accepted: true }));
    });
    const resolveNewTransition = vi.fn(() => {
      events.push("resolve");
      return Promise.resolve({ before: null, after: "private_manual" } as const);
    });

    const result = await prepareEncryptedNoteWrite(
      dependencies({ getWriteClaim, prepareWrite, createRequestMac, openResponse }),
      createInput(resolveNewTransition)
    );

    expect(result).toMatchObject({ status: "completed", response: { accepted: true } });
    expect(resolveNewTransition).not.toHaveBeenCalled();
    expect(events).toEqual(["lookup", "mac", "prepare", "open"]);
  });

  it("binds an AI-to-private replay to the exact source privacy and sticky private key", async () => {
    const claim: CompletedEncryptedNoteWriteClaim = Object.freeze({
      ...completedCreateClaim(),
      scope: "apply_encrypted_note_mutation",
      noteId: NOTE_A,
      expectedRevision: 3,
      sourcePrivacy: "ai_assisted",
      targetPrivacy: "private_manual",
      historyKeyClass: "private_manual"
    });
    const createRequestMac = vi.fn(
      (_access: CreateRequestMacAccess, input: CreateRequestMacInput) => {
        expect(input).toMatchObject({
          transition: { before: "ai_assisted", after: "private_manual" },
          keyReference: {
            ownerId: OWNER,
            keyId: retiredMac.keyId,
            keyClass: "private_manual",
            purpose: "content_mac",
            keyVersion: 1
          }
        });
        return Promise.resolve(retiredMac);
      }
    );
    const openResponse = vi.fn(
      (_access: CreateRequestMacAccess, _record: unknown, options: unknown) => {
        expect(options).toMatchObject({
          transition: { before: "ai_assisted", after: "private_manual" }
        });
        return Promise.resolve(Object.freeze({ accepted: true }));
      }
    );
    const resolveNewTransition = vi.fn(() =>
      Promise.resolve({ before: "ai_assisted", after: "private_manual" } as const)
    );

    await expect(
      prepareEncryptedNoteWrite(
        dependencies({
          getWriteClaim: vi.fn(() => Promise.resolve(claim)),
          prepareWrite: vi.fn(() => Promise.resolve({ claim, replayed: true })),
          createRequestMac,
          openResponse
        }),
        {
          coordinates: {
            ownerId: OWNER,
            scope: "apply_encrypted_note_mutation",
            idempotencyKey: IDEMPOTENCY_KEY,
            noteId: NOTE_A,
            expectedRevision: 3
          },
          logicalRequest: {
            ...logicalRequest,
            scope: "apply_encrypted_note_mutation",
            targetResourceId: NOTE_A,
            expectedRevision: 3
          },
          requestCodec,
          responseCodec,
          resolveNewTransition
        }
      )
    ).resolves.toMatchObject({ status: "completed", response: { accepted: true } });
    expect(resolveNewTransition).not.toHaveBeenCalled();
    expect(openResponse).toHaveBeenCalledOnce();
  });

  it("rejects logical request scope mismatch before lookup or content resolution", async () => {
    const getWriteClaim = vi.fn<EncryptedNoteRpcAdapter["getWriteClaim"]>();
    const prepareWrite = vi.fn<EncryptedNoteRpcAdapter["prepareWrite"]>();
    const resolveNewTransition = vi.fn(() =>
      Promise.resolve({ before: null, after: "private_manual" } as const)
    );

    await expect(
      prepareEncryptedNoteWrite(dependencies({ getWriteClaim, prepareWrite }), {
        ...createInput(resolveNewTransition),
        logicalRequest: {
          ...logicalRequest,
          scope: "apply_encrypted_note_mutation"
        }
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    expect(getWriteClaim).not.toHaveBeenCalled();
    expect(resolveNewTransition).not.toHaveBeenCalled();
    expect(prepareWrite).not.toHaveBeenCalled();
  });

  it("rejects existing-to-prepared claim drift and a false replay marker before opening", async () => {
    const existing = completedCreateClaim();
    const changedResponse = Object.freeze({
      ...existing.encryptedResponse,
      keyVersion: existing.encryptedResponse.keyVersion + 1
    });
    const cases: readonly Readonly<{
      claim: CompletedEncryptedNoteWriteClaim;
      replayed: boolean;
    }>[] = [
      { claim: Object.freeze({ ...existing, revisionId: REVISION_B }), replayed: true },
      { claim: Object.freeze({ ...existing, mutationId: MUTATION_B }), replayed: true },
      {
        claim: Object.freeze({ ...existing, occurredAt: "2026-08-30T22:54:12.346+00:00" }),
        replayed: true
      },
      {
        claim: Object.freeze({ ...existing, sourcePrivacy: "ai_assisted" }),
        replayed: true
      },
      {
        claim: Object.freeze({
          ...existing,
          requestMacKey: Object.freeze({ ...existing.requestMacKey, keyVersion: 2 })
        }),
        replayed: true
      },
      {
        claim: Object.freeze({ ...existing, encryptedResponse: changedResponse }),
        replayed: true
      },
      { claim: existing, replayed: false }
    ];

    for (const prepared of cases) {
      const openResponse = vi.fn(() => Promise.resolve(Object.freeze({ accepted: true })));
      const resolveNewTransition = vi.fn(() =>
        Promise.resolve({ before: null, after: "private_manual" } as const)
      );
      await expect(
        prepareEncryptedNoteWrite(
          dependencies({
            getWriteClaim: vi.fn(() => Promise.resolve(existing)),
            prepareWrite: vi.fn(() => Promise.resolve(prepared)),
            createRequestMac: vi.fn(() => Promise.resolve(retiredMac)),
            openResponse
          }),
          createInput(resolveNewTransition)
        )
      ).rejects.toMatchObject({ code: ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY });
      expect(resolveNewTransition).not.toHaveBeenCalled();
      expect(openResponse).not.toHaveBeenCalled();
    }
  });

  it("resolves current privacy only after an absent claim and prepares with the active MAC", async () => {
    const events: string[] = [];
    const claim = incompleteCreateClaim();
    const getWriteClaim = vi.fn(() => {
      events.push("lookup");
      return Promise.resolve(null);
    });
    const resolveNewTransition = vi.fn(() => {
      events.push("resolve");
      return Promise.resolve({ before: null, after: "private_manual" } as const);
    });
    const createRequestMac = vi.fn(
      (_access: CreateRequestMacAccess, input: CreateRequestMacInput) => {
        events.push("mac");
        expect(input).not.toHaveProperty("keyReference");
        return Promise.resolve(activeMac);
      }
    );
    const prepareWrite = vi.fn((input: PrepareWriteInput) => {
      events.push("prepare");
      expect(input.requestMac).toMatchObject({
        mac: activeMac.value,
        keyId: activeMac.keyId,
        keyPurpose: "content_mac"
      });
      return Promise.resolve({
        claim: Object.freeze({
          ...claim,
          requestMacKey: Object.freeze({
            keyId: activeMac.keyId,
            keyClass: activeMac.keyClass,
            keyPurpose: activeMac.keyPurpose,
            keyVersion: activeMac.keyVersion
          })
        }),
        replayed: false
      });
    });

    const result = await prepareEncryptedNoteWrite(
      dependencies({ getWriteClaim, prepareWrite, createRequestMac }),
      createInput(resolveNewTransition)
    );

    expect(result).toMatchObject({
      status: "ready",
      resumed: false,
      keyTransition: { before: null, after: "private_manual" }
    });
    expect(events).toEqual(["lookup", "resolve", "mac", "prepare"]);
  });

  it("recovers a concurrent claim creation once and then uses its stored key reference", async () => {
    const claim = incompleteCreateClaim();
    const getWriteClaim = vi
      .fn<EncryptedNoteRpcAdapter["getWriteClaim"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(claim);
    const resolveNewTransition = vi.fn(() =>
      Promise.resolve({ before: null, after: "private_manual" } as const)
    );
    const createRequestMac = vi
      .fn<EncryptedAggregateService["createIdempotencyRequestMac"]>()
      .mockResolvedValueOnce(activeMac)
      .mockResolvedValueOnce(retiredMac);
    const prepareWrite = vi
      .fn<EncryptedNoteRpcAdapter["prepareWrite"]>()
      .mockRejectedValueOnce(new ServiceRpcError(ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY))
      .mockResolvedValueOnce({ claim, replayed: true });

    const result = await prepareEncryptedNoteWrite(
      dependencies({ getWriteClaim, prepareWrite, createRequestMac }),
      createInput(resolveNewTransition)
    );

    expect(result).toMatchObject({ status: "ready", resumed: true, requestMac: retiredMac });
    expect(resolveNewTransition).toHaveBeenCalledTimes(1);
    expect(getWriteClaim).toHaveBeenCalledTimes(2);
    expect(createRequestMac.mock.calls[1]?.[1]).toMatchObject({
      keyReference: {
        ownerId: OWNER,
        keyId: retiredMac.keyId,
        purpose: "content_mac",
        keyVersion: 1
      }
    });
  });

  it("rejects a reused mutation idempotency key before reading the current note", async () => {
    const mutationClaim = Object.freeze({
      ...incompleteCreateClaim(),
      scope: "apply_encrypted_note_mutation" as const,
      noteId: NOTE_B,
      expectedRevision: 3,
      sourcePrivacy: "private_manual" as const,
      targetPrivacy: "ai_assisted" as const,
      historyKeyClass: "private_manual" as const
    });
    const getWriteClaim = vi.fn(() => Promise.resolve(mutationClaim));
    const createRequestMac = vi.fn(() => Promise.resolve(retiredMac));
    const prepareWrite = vi.fn<EncryptedNoteRpcAdapter["prepareWrite"]>();
    const resolveNewTransition = vi.fn(() =>
      Promise.resolve({ before: "private_manual", after: "ai_assisted" } as const)
    );

    await expect(
      prepareEncryptedNoteWrite(dependencies({ getWriteClaim, prepareWrite, createRequestMac }), {
        coordinates: {
          ownerId: OWNER,
          scope: "apply_encrypted_note_mutation",
          idempotencyKey: IDEMPOTENCY_KEY,
          noteId: NOTE_A,
          expectedRevision: 3
        },
        logicalRequest: {
          ...logicalRequest,
          scope: "apply_encrypted_note_mutation",
          targetResourceId: NOTE_A,
          expectedRevision: 3
        },
        requestCodec,
        responseCodec,
        resolveNewTransition
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY });
    expect(createRequestMac).not.toHaveBeenCalled();
    expect(resolveNewTransition).not.toHaveBeenCalled();
    expect(prepareWrite).not.toHaveBeenCalled();
  });

  it("propagates lookup failure without resolving content or falling back", async () => {
    const failure = new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
    const getWriteClaim = vi.fn(() => Promise.reject(failure));
    const prepareWrite = vi.fn<EncryptedNoteRpcAdapter["prepareWrite"]>();
    const resolveNewTransition = vi.fn(() =>
      Promise.resolve({ before: null, after: "private_manual" } as const)
    );

    await expect(
      prepareEncryptedNoteWrite(
        dependencies({ getWriteClaim, prepareWrite }),
        createInput(resolveNewTransition)
      )
    ).rejects.toBe(failure);
    expect(resolveNewTransition).not.toHaveBeenCalled();
    expect(prepareWrite).not.toHaveBeenCalled();
  });
});
