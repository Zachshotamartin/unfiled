import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  type AggregateContentKind,
  type CaptureReceiptPayload,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type KeyedMacRecord,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import type {
  EncryptedCaptureDetailRead,
  EncryptedCaptureRead,
  EncryptedCaptureReceiptRead,
  EncryptedCaptureRpcAdapter,
  EncryptedGeneratedBlockRead
} from "./encrypted-capture-rpc-adapter";
import type {
  EncryptedNoteMutationRead,
  EncryptedNoteReadRpcAdapter
} from "./encrypted-note-read-rpc-adapter";
import { createEncryptedCaptureRpcAdapter } from "./encrypted-capture-rpc-adapter";
import {
  EncryptedCaptureAggregateRepository,
  EncryptedCaptureOperationUnavailableError
} from "./encrypted-capture-aggregate-repository";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const CAPTURE = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const JOB = "job_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const DECISION = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const BEFORE_REVISION = "rev_01J6M9Q7G4BMKB33GSG3NJ6D1W" as const;
const AFTER_REVISION = "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const ITEM = "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const BLOCK = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const RAW = "buy milk and batteries";
const AI_TEXT = "A concise generated summary";
const CLIENT_AT = "2026-08-31T10:59:59.123-07:00";
const CLIENT_AT_CANONICAL = "2026-08-31T17:59:59.123000+00:00";
const RECEIVED_AT = "2026-08-31T18:00:00.123000+00:00";

const access = authorizeAggregateOwner({
  authenticatedOwnerId: OWNER,
  resourceOwnerId: OWNER
});
const context = Object.freeze({ accessToken: "user-token-never-forwarded", userId: OWNER });

function envelope(
  kind: AggregateContentKind,
  resourceId: string,
  keyClass: "ai_assisted" | "private_manual",
  recordVersion = 1
): ContentEnvelopeV1 {
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: `${keyClass}-wrap-v1`,
    context: Object.freeze({ tenantId: OWNER, resourceId, recordVersion, kind }),
    wrappedDataKey: Object.freeze({ nonce: "A".repeat(16), ciphertext: "a".repeat(64) }),
    payload: Object.freeze({ nonce: "B".repeat(16), ciphertext: "b".repeat(64) })
  });
}

function encrypted<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  keyClass: "ai_assisted" | "private_manual",
  recordVersion = 1
): EncryptedAggregateRecord<Kind> {
  return Object.freeze({
    ownerId: OWNER,
    resourceId,
    recordVersion,
    kind,
    envelope: envelope(kind, resourceId, keyClass, recordVersion),
    keyId: `${keyClass}-wrap-v1`,
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1
  });
}

function sealed<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  keyClass: "ai_assisted" | "private_manual",
  reservationId: string,
  recordVersion = 1
): SealedEncryptedAggregateRecord<Kind> {
  return Object.freeze({
    ...encrypted(kind, resourceId, keyClass, recordVersion),
    reservationId
  });
}

function mac(keyClass: "ai_assisted" | "private_manual"): KeyedMacRecord {
  return Object.freeze({
    value: "a".repeat(64),
    keyId: `${keyClass}-mac-v1`,
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: 1
  });
}

function captureRow(
  privacy: "ai_assisted" | "private_manual" = "private_manual",
  overrides: Partial<EncryptedCaptureRead> = {}
): EncryptedCaptureRead {
  return Object.freeze({
    captureId: CAPTURE,
    recordVersion: 1,
    jobId: JOB,
    source: "web",
    deviceId: "",
    contentLength: RAW.length,
    privacy,
    explicitDestinationNoteId: null,
    expansionDisabled: false,
    clientCreatedAt: CLIENT_AT_CANONICAL,
    clientTimezone: "America/Los_Angeles",
    receivedAt: RECEIVED_AT,
    status: privacy === "private_manual" ? "inbox" : "queued",
    lastErrorCode: null,
    contentCipher: encrypted("capture", CAPTURE, privacy),
    contentMac: mac(privacy),
    receiptAvailable: privacy === "private_manual",
    ...overrides
  });
}

function receiptRow(
  privacy: "ai_assisted" | "private_manual" = "private_manual",
  overrides: Partial<EncryptedCaptureReceiptRead> = {}
): EncryptedCaptureReceiptRead {
  return Object.freeze({
    captureId: CAPTURE,
    recordVersion: 1,
    privacy,
    jobId: JOB,
    decisionId: null,
    reviewItemId: null,
    mutationId: null,
    outcome: "kept_in_inbox",
    destinationNoteId: null,
    reasonCodes: ["private_manual"],
    createdAt: RECEIVED_AT,
    receiptCipher: encrypted("capture_receipt", CAPTURE, privacy),
    ...overrides
  });
}

function detail(
  privacy: "ai_assisted" | "private_manual" = "private_manual",
  overrides: Partial<EncryptedCaptureDetailRead> = {}
): EncryptedCaptureDetailRead {
  const capture = captureRow(privacy);
  return Object.freeze({
    ...capture,
    job: Object.freeze({
      jobId: JOB,
      state: privacy === "private_manual" ? "succeeded" : "created",
      attempt: 0,
      startedAt: null,
      completedAt: privacy === "private_manual" ? RECEIVED_AT : null,
      errorCode: null,
      createdAt: RECEIVED_AT,
      updatedAt: RECEIVED_AT
    }),
    receipt: privacy === "private_manual" ? receiptRow(privacy) : null,
    ...overrides
  });
}

function input(privacy: "ai_assisted" | "private_manual" = "private_manual") {
  return Object.freeze({
    clientCaptureId: CAPTURE,
    rawContent: RAW,
    source: "web" as const,
    clientCreatedAt: CLIENT_AT,
    clientTimezone: "America/Los_Angeles",
    privacy,
    expansionDisabled: false
  });
}

function inboxPayload(createdAt = RECEIVED_AT): CaptureReceiptPayload {
  return Object.freeze({
    schemaVersion: 1,
    captureId: CAPTURE,
    jobId: JOB,
    decisionId: null,
    reviewItemId: null,
    mutationId: null,
    outcome: "kept_in_inbox",
    headline: "Kept private in Inbox",
    destination: null,
    insertedContentReferences: [],
    actions: [],
    reasonCodes: ["private_manual"],
    createdAt
  });
}

type AggregateMocks = Readonly<{
  aggregate: EncryptedAggregateService;
  sealCapture: ReturnType<typeof vi.fn>;
  sealCaptureReceipt: ReturnType<typeof vi.fn>;
  openCaptureReceipt: ReturnType<typeof vi.fn>;
  sealIdempotencyResponse: ReturnType<typeof vi.fn>;
}>;

function aggregateMocks(
  options: Readonly<{
    rawContent?: string;
    receiptPayload?: CaptureReceiptPayload;
    idempotencyResponses?: Readonly<Record<string, unknown>>;
  }> = {}
): AggregateMocks {
  const rawContent = options.rawContent ?? RAW;
  const capture = sealed(
    "capture",
    CAPTURE,
    "private_manual",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  );
  const receipt = sealed(
    "capture_receipt",
    CAPTURE,
    "private_manual",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  );
  const sealCapture = vi.fn((_access, request: { privacy: "ai_assisted" | "private_manual" }) =>
    Promise.resolve({
      encrypted:
        request.privacy === "private_manual"
          ? capture
          : sealed("capture", CAPTURE, "ai_assisted", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      contentMac: mac(request.privacy)
    })
  );
  const sealCaptureReceipt = vi.fn(() => Promise.resolve(receipt));
  const openCaptureReceipt = vi.fn(
    (_access, _record, request?: { payload?: CaptureReceiptPayload }) =>
      Promise.resolve(options.receiptPayload ?? request?.payload ?? inboxPayload())
  );
  const commandResponses = new Map<string, unknown>(
    Object.entries(options.idempotencyResponses ?? {})
  );
  const sealIdempotencyResponse = vi.fn(
    (
      _access,
      request: {
        idempotencyKey: string;
        transition: { after: "ai_assisted" | "private_manual" };
        response: unknown;
      }
    ) => {
      commandResponses.set(request.idempotencyKey, request.response);
      return Promise.resolve(
        sealed(
          "idempotency_response",
          `idempotency:${request.idempotencyKey}`,
          request.transition.after,
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        )
      );
    }
  );
  const aggregate = {
    sealCapture,
    openCapture: vi.fn(() => Promise.resolve({ schemaVersion: 1, rawContent })),
    sealCaptureReceipt,
    openCaptureReceipt,
    createIdempotencyRequestMac: vi.fn(
      (_access, request: { transition: { after: "ai_assisted" | "private_manual" } }) =>
        Promise.resolve(mac(request.transition.after))
    ),
    sealIdempotencyResponse,
    openIdempotencyResponse: vi.fn((_access, _record, request: { idempotencyKey: string }) =>
      Promise.resolve(commandResponses.get(request.idempotencyKey))
    ),
    createAggregateVerificationMac: vi.fn(
      (
        _access,
        request: {
          transition?: { after: "ai_assisted" | "private_manual" };
          sourcePrivacy?: "ai_assisted" | "private_manual";
          privacy?: "ai_assisted" | "private_manual";
        }
      ) =>
        Promise.resolve(
          mac(
            request.transition?.after ??
              request.sourcePrivacy ??
              request.privacy ??
              "private_manual"
          )
        )
    ),
    verifyAggregateVerificationMac: vi.fn(() => Promise.resolve(true)),
    openGeneratedBlock: vi.fn(() => Promise.resolve({ schemaVersion: 1, content: AI_TEXT }))
  } as unknown as EncryptedAggregateService;
  return Object.freeze({
    aggregate,
    sealCapture,
    sealCaptureReceipt,
    openCaptureReceipt,
    sealIdempotencyResponse
  });
}

function adapter(overrides: Partial<EncryptedCaptureRpcAdapter> = {}): EncryptedCaptureRpcAdapter {
  const notFound = () => Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND));
  return Object.freeze({
    createCapture:
      overrides.createCapture ??
      vi.fn(() =>
        Promise.resolve({
          captureId: CAPTURE,
          jobId: JOB,
          replayed: false
        })
      ),
    listCaptures:
      overrides.listCaptures ?? vi.fn(() => Promise.resolve({ captures: [], nextCursor: null })),
    getCaptureDetail: overrides.getCaptureDetail ?? vi.fn(notFound),
    getCaptureReceipt: overrides.getCaptureReceipt ?? vi.fn(notFound),
    getGeneratedBlocks: overrides.getGeneratedBlocks ?? vi.fn(() => Promise.resolve([])),
    getCommandClaim: overrides.getCommandClaim ?? vi.fn(() => Promise.resolve(null)),
    getDeleteContext:
      overrides.getDeleteContext ??
      vi.fn(() => Promise.resolve({ captureId: CAPTURE, sourceNoteIds: [] })),
    retryCapture: overrides.retryCapture ?? vi.fn(notFound),
    deleteCapture: overrides.deleteCapture ?? vi.fn(notFound),
    deleteCaptureWithUndo: overrides.deleteCaptureWithUndo ?? vi.fn(notFound)
  });
}

function repository(
  aggregate: EncryptedAggregateService,
  captureAdapter: EncryptedCaptureRpcAdapter,
  noteReads: EncryptedNoteReadRpcAdapter = {
    listNotes: vi.fn(() => Promise.reject(new Error("unexpected_note_read"))),
    getNote: vi.fn(() => Promise.reject(new Error("unexpected_note_read"))),
    listRevisions: vi.fn(() => Promise.reject(new Error("unexpected_note_read"))),
    getMutation: vi.fn(() => Promise.reject(new Error("unexpected_note_read")))
  },
  signal?: AbortSignal
): EncryptedCaptureAggregateRepository {
  return new EncryptedCaptureAggregateRepository({
    ownerId: OWNER,
    access,
    aggregate,
    adapter: captureAdapter,
    noteReads,
    ...(signal === undefined ? {} : { signal }),
    createJobId: () => JOB,
    now: () => new Date("2026-08-31T18:00:00.123Z")
  });
}

async function expectServiceError(promise: Promise<unknown>, code: string): Promise<void> {
  let reason: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    reason = error;
  }
  expect(reason).toBeInstanceOf(ServiceRpcError);
  expect(reason).toMatchObject({ code });
}

describe("encrypted capture aggregate repository", () => {
  it("seals, opens, MAC-verifies, and submits a private capture through the strict adapter", async () => {
    const aggregate = aggregateMocks();
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name) => {
      if (name === "get_encrypted_capture_detail") {
        return Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND));
      }
      if (name === "create_encrypted_capture_with_job") {
        return Promise.resolve({ captureId: CAPTURE, jobId: JOB, replayed: false });
      }
      return Promise.reject(new Error("unexpected_rpc"));
    });
    const result = await repository(
      aggregate.aggregate,
      createEncryptedCaptureRpcAdapter({ rpc })
    ).createCapture(context, input());
    expect(result).toMatchObject({
      capture: { id: CAPTURE, rawContent: RAW, status: "queued", lastErrorCode: null },
      jobId: JOB,
      replayed: false
    });
    const createCall = rpc.mock.calls.find(
      ([name]) => name === "create_encrypted_capture_with_job"
    );
    expect(createCall).toBeDefined();
    expect(JSON.stringify(createCall)).not.toContain(RAW);
    const parameters = createCall?.[1] as Record<string, unknown>;
    const sentCapture = parameters.p_capture as Readonly<Record<string, unknown>>;
    expect(sentCapture.privacy).toBe("private_manual");
    expect(sentCapture.privateReceiptCipher).toEqual(
      expect.objectContaining({
        keyPurpose: "object_wrap"
      })
    );
    expect(sentCapture.privateReceiptVerificationMac).toEqual(
      expect.objectContaining({
        keyPurpose: "content_mac"
      })
    );
    expect(aggregate.sealCaptureReceipt).toHaveBeenCalledTimes(1);
    expect(aggregate.openCaptureReceipt).toHaveBeenCalledTimes(1);
  });

  it("submits AI-assisted captures with no fabricated private receipt", async () => {
    const aggregate = aggregateMocks();
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name, parameters) => {
      if (name === "get_encrypted_capture_detail") {
        return Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND));
      }
      if (name === "create_encrypted_capture_with_job") {
        expect(parameters.p_capture as Record<string, unknown>).toMatchObject({
          privacy: "ai_assisted",
          privateReceiptCipher: null,
          privateReceiptVerificationMac: null
        });
        return Promise.resolve({ captureId: CAPTURE, jobId: JOB, replayed: false });
      }
      return Promise.reject(new Error("unexpected_rpc"));
    });
    await expect(
      repository(aggregate.aggregate, createEncryptedCaptureRpcAdapter({ rpc })).createCapture(
        context,
        input("ai_assisted")
      )
    ).resolves.toMatchObject({
      capture: { status: "queued", privacy: "ai_assisted" },
      replayed: false
    });
    expect(aggregate.sealCaptureReceipt).not.toHaveBeenCalled();
    expect(aggregate.openCaptureReceipt).not.toHaveBeenCalled();
  });

  it("recovers an exact lost-response replay before resealing and preserves the stored acceptance time", async () => {
    const aggregate = aggregateMocks();
    const createCapture = vi.fn();
    const captureAdapter = adapter({
      getCaptureDetail: vi.fn(() => Promise.resolve(detail())),
      createCapture
    });
    const result = await repository(aggregate.aggregate, captureAdapter).createCapture(
      context,
      input()
    );
    expect(result).toMatchObject({
      capture: {
        clientCreatedAt: CLIENT_AT_CANONICAL,
        receivedAt: RECEIVED_AT,
        status: "queued",
        rawContent: RAW
      },
      jobId: JOB,
      replayed: true
    });
    expect(createCapture).not.toHaveBeenCalled();
    expect(aggregate.sealCapture).not.toHaveBeenCalled();
  });

  it("rejects a reused capture id whose semantic create intent differs", async () => {
    const aggregate = aggregateMocks();
    const captureAdapter = adapter({ getCaptureDetail: vi.fn(() => Promise.resolve(detail())) });
    await expectServiceError(
      repository(aggregate.aggregate, captureAdapter).createCapture(context, {
        ...input(),
        rawContent: "different content"
      }),
      ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY
    );
  });

  it("recovers a concurrent create race only after decrypting and comparing the winner", async () => {
    const aggregate = aggregateMocks();
    const getCaptureDetail = vi
      .fn<EncryptedCaptureRpcAdapter["getCaptureDetail"]>()
      .mockRejectedValueOnce(new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND))
      .mockResolvedValueOnce(detail());
    const captureAdapter = adapter({
      getCaptureDetail,
      createCapture: vi.fn(() =>
        Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY))
      )
    });
    await expect(
      repository(aggregate.aggregate, captureAdapter).createCapture(context, input())
    ).resolves.toMatchObject({ replayed: true, capture: { receivedAt: RECEIVED_AT } });
    expect(getCaptureDetail).toHaveBeenCalledTimes(2);
  });

  it("hydrates captured and generated references without exposing storage envelopes", async () => {
    const routedPayload: CaptureReceiptPayload = Object.freeze({
      schemaVersion: 1,
      captureId: CAPTURE,
      jobId: JOB,
      decisionId: DECISION,
      reviewItemId: null,
      mutationId: MUTATION,
      outcome: "added_to_note",
      headline: "Added to Shopping",
      destination: Object.freeze({ noteId: NOTE, title: "Shopping" }),
      insertedContentReferences: [
        { type: "captured" as const, itemId: null },
        { type: "ai_generated" as const, blockId: BLOCK }
      ],
      actions: [
        { type: "open" as const, noteId: NOTE },
        { type: "undo" as const, mutationId: MUTATION, expectedRevision: 2 }
      ],
      reasonCodes: ["explicit_destination"],
      createdAt: RECEIVED_AT
    });
    const routedReceipt = receiptRow("ai_assisted", {
      decisionId: DECISION,
      mutationId: MUTATION,
      outcome: "added_to_note",
      destinationNoteId: NOTE,
      reasonCodes: ["explicit_destination"]
    });
    const routedDetail = detail("ai_assisted", {
      status: "done",
      receiptAvailable: true,
      receipt: routedReceipt
    });
    const generated: EncryptedGeneratedBlockRead = Object.freeze({
      blockId: BLOCK,
      recordVersion: 1,
      noteId: NOTE,
      decisionId: DECISION,
      kind: "summary",
      state: "accepted",
      modelId: "model",
      promptVersion: "routing-v1",
      resolvedAt: RECEIVED_AT,
      createdAt: RECEIVED_AT,
      contentCipher: encrypted("generated_block", BLOCK, "ai_assisted")
    });
    const aggregate = aggregateMocks({ receiptPayload: routedPayload });
    const captureAdapter = adapter({
      getCaptureDetail: vi.fn(() => Promise.resolve(routedDetail)),
      getCaptureReceipt: vi.fn(() => Promise.resolve(routedReceipt)),
      getGeneratedBlocks: vi.fn(() => Promise.resolve([generated]))
    });
    const result = await repository(aggregate.aggregate, captureAdapter).getCapture(
      context,
      CAPTURE
    );
    expect(result.capture.receipt).toMatchObject({
      destination: { noteId: NOTE, title: "Shopping" },
      insertedContent: [
        { type: "captured", content: RAW },
        { type: "ai_generated", blockId: BLOCK, content: AI_TEXT }
      ]
    });
    expect(JSON.stringify(result)).not.toMatch(/contentCipher|contentMac|envelope|keyId/u);
  });

  it("hydrates direct receipt reads and bounds list output to decrypted public summaries", async () => {
    const aggregate = aggregateMocks({ receiptPayload: inboxPayload() });
    const row = captureRow("private_manual", { status: "inbox", receiptAvailable: true });
    const captureAdapter = adapter({
      getCaptureReceipt: vi.fn(() => Promise.resolve(receiptRow())),
      getCaptureDetail: vi.fn(() => Promise.resolve(detail())),
      listCaptures: vi.fn(() =>
        Promise.resolve({
          captures: [row],
          nextCursor: {
            receivedAt: row.receivedAt,
            captureId: row.captureId
          }
        })
      )
    });
    const repo = repository(aggregate.aggregate, captureAdapter);
    await expect(repo.getReceipt(context, CAPTURE)).resolves.toMatchObject({
      receipt: { outcome: "kept_in_inbox", insertedContent: [] }
    });
    await expect(repo.listCaptures(context, { limit: 30 })).resolves.toMatchObject({
      items: [{ id: CAPTURE, rawContentPreview: RAW, receiptAvailable: true }],
      pageInfo: { hasMore: false, nextCursor: null }
    });
  });

  it("retries a failed capture through a sealed logical-MAC command", async () => {
    const aggregate = aggregateMocks();
    const retryCapture = vi.fn<EncryptedCaptureRpcAdapter["retryCapture"]>((request) =>
      Promise.resolve({
        captureId: CAPTURE,
        jobId: JOB,
        encryptedResponse: encrypted(
          "idempotency_response",
          `idempotency:${request.idempotencyKey}`,
          request.privacy
        ),
        replayed: false
      })
    );
    const failed = detail("ai_assisted", {
      status: "failed",
      lastErrorCode: "provider_unavailable",
      job: {
        ...detail("ai_assisted").job,
        state: "failed",
        errorCode: "provider_unavailable"
      }
    });
    const repo = repository(
      aggregate.aggregate,
      adapter({
        getCaptureDetail: vi.fn(() => Promise.resolve(failed)),
        retryCapture
      })
    );
    await expect(repo.retryCapture(context, CAPTURE, "retry-1")).resolves.toMatchObject({
      capture: { id: CAPTURE, rawContent: RAW, status: "queued", lastErrorCode: null },
      jobId: JOB,
      replayed: false
    });
    expect(retryCapture).toHaveBeenCalledTimes(1);
    const command = retryCapture.mock.calls[0]?.[0].command;
    expect(JSON.stringify(command)).not.toContain(RAW);
    expect(command?.requestMac.keyPurpose).toBe("content_mac");
    expect(command && "responseCipher" in command ? command.responseCipher.keyPurpose : null).toBe(
      "object_wrap"
    );
  });

  it("deletes a capture while retaining note content and sealing the exact response", async () => {
    const aggregate = aggregateMocks();
    const deleteCapture = vi.fn<EncryptedCaptureRpcAdapter["deleteCapture"]>((request) =>
      Promise.resolve({
        captureId: CAPTURE,
        encryptedResponse: encrypted(
          "idempotency_response",
          `idempotency:${request.idempotencyKey}`,
          request.privacy
        ),
        replayed: false
      })
    );
    const repo = repository(
      aggregate.aggregate,
      adapter({
        getCaptureDetail: vi.fn(() => Promise.resolve(detail("ai_assisted"))),
        getDeleteContext: vi.fn(() =>
          Promise.resolve({ captureId: CAPTURE, sourceNoteIds: [NOTE] })
        ),
        deleteCapture
      })
    );
    await expect(
      repo.deleteCapture(context, CAPTURE, {
        idempotencyKey: "delete-1",
        removeInsertedContent: false,
        expectedNoteRevisions: []
      })
    ).resolves.toEqual({
      captureId: CAPTURE,
      deletedAt: "2026-08-31T18:00:00.123Z",
      sourceRemovedFromNoteIds: [NOTE],
      removedInsertedContent: false,
      contentRemovalMutations: [],
      replayed: false
    });
    expect(JSON.stringify(deleteCapture.mock.calls[0]?.[0])).not.toContain(RAW);
    expect(deleteCapture.mock.calls[0]?.[0].command).toEqual(
      expect.objectContaining({ removeInsertedContent: false, sourceNoteIds: [NOTE] })
    );
  });

  it("replays a completed encrypted delete without rereading the tombstoned capture", async () => {
    const storedResponse = Object.freeze({
      captureId: CAPTURE,
      deletedAt: "2026-08-31T18:00:00.123Z",
      sourceRemovedFromNoteIds: [NOTE],
      removedInsertedContent: false,
      contentRemovalMutations: [],
      replayed: false
    });
    const aggregate = aggregateMocks({
      idempotencyResponses: { "delete-replay": storedResponse }
    });
    const getCaptureDetail = vi.fn(() => Promise.reject(new Error("must_not_read")));
    const deleteCapture = vi.fn<EncryptedCaptureRpcAdapter["deleteCapture"]>(() =>
      Promise.resolve({
        captureId: CAPTURE,
        encryptedResponse: encrypted(
          "idempotency_response",
          "idempotency:delete-replay",
          "ai_assisted"
        ),
        replayed: true
      })
    );
    const repo = repository(
      aggregate.aggregate,
      adapter({
        getCaptureDetail,
        getCommandClaim: vi.fn<EncryptedCaptureRpcAdapter["getCommandClaim"]>(() =>
          Promise.resolve({
            scope: "delete_capture",
            captureId: CAPTURE,
            keyClass: "ai_assisted",
            requestMacKey: {
              ownerId: OWNER,
              keyClass: "ai_assisted",
              purpose: "content_mac",
              keyId: "ai_assisted-mac-v1",
              keyVersion: 1
            }
          })
        ),
        deleteCapture
      })
    );
    await expect(
      repo.deleteCapture(context, CAPTURE, {
        idempotencyKey: "delete-replay",
        removeInsertedContent: false,
        expectedNoteRevisions: []
      })
    ).resolves.toEqual({ ...storedResponse, replayed: true });
    expect(getCaptureDetail).not.toHaveBeenCalled();
    const replayCommand = deleteCapture.mock.calls[0]?.[0].command;
    expect(replayCommand?.requestMac.keyPurpose).toBe("content_mac");
    expect(replayCommand && "responseCipher" in replayCommand).toBe(false);
    expect(aggregate.sealIdempotencyResponse).not.toHaveBeenCalled();
  });

  it("keeps a legacy routed receipt without an authenticated undo target fail-closed", async () => {
    const legacyPayload: CaptureReceiptPayload = Object.freeze({
      schemaVersion: 1,
      captureId: CAPTURE,
      jobId: JOB,
      decisionId: DECISION,
      reviewItemId: null,
      mutationId: MUTATION,
      outcome: "added_to_note",
      headline: "Added to Shopping",
      destination: Object.freeze({ noteId: NOTE, title: "Shopping" }),
      insertedContentReferences: [{ type: "captured" as const, itemId: null }],
      actions: [{ type: "open" as const, noteId: NOTE }],
      reasonCodes: ["explicit_destination"],
      createdAt: RECEIVED_AT
    });
    const aggregate = aggregateMocks({ receiptPayload: legacyPayload });
    const captureAdapter = adapter({
      getCaptureDetail: vi.fn(() => Promise.resolve(detail("ai_assisted"))),
      getDeleteContext: vi.fn(() => Promise.resolve({ captureId: CAPTURE, sourceNoteIds: [NOTE] })),
      getCaptureReceipt: vi.fn(() =>
        Promise.resolve(
          receiptRow("ai_assisted", {
            decisionId: DECISION,
            mutationId: MUTATION,
            outcome: "added_to_note",
            destinationNoteId: NOTE,
            reasonCodes: ["explicit_destination"]
          })
        )
      )
    });
    const repo = repository(aggregate.aggregate, captureAdapter);
    await expect(
      repo.deleteCapture(context, CAPTURE, {
        idempotencyKey: "delete-1",
        removeInsertedContent: true,
        expectedNoteRevisions: [{ noteId: NOTE, expectedRevision: 2 }]
      })
    ).rejects.toBeInstanceOf(EncryptedCaptureOperationUnavailableError);
    expect(captureAdapter.deleteCapture).not.toHaveBeenCalled();
    expect(captureAdapter.deleteCaptureWithUndo).not.toHaveBeenCalled();
  });

  it("stops a delete after cancellation without reading, sealing, or committing", async () => {
    const aggregate = aggregateMocks();
    const controller = new AbortController();
    const getCommandClaim = vi.fn(() => {
      controller.abort();
      return Promise.resolve(null);
    });
    const captureAdapter = adapter({ getCommandClaim });
    await expectServiceError(
      repository(aggregate.aggregate, captureAdapter, undefined, controller.signal).deleteCapture(
        context,
        CAPTURE,
        {
          idempotencyKey: "cancel-delete-1",
          removeInsertedContent: false,
          expectedNoteRevisions: []
        }
      ),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
    expect(getCommandClaim).toHaveBeenCalledOnce();
    expect(captureAdapter.getCaptureDetail).not.toHaveBeenCalled();
    expect(aggregate.sealIdempotencyResponse).not.toHaveBeenCalled();
    expect(captureAdapter.deleteCapture).not.toHaveBeenCalled();
    expect(captureAdapter.deleteCaptureWithUndo).not.toHaveBeenCalled();
  });

  it("prepares and commits one authenticated encrypted inverse without a plaintext fallback", async () => {
    const privateTitle = "Canary title never sent to PostgREST";
    const privateBody = "Canary body never sent to PostgREST";
    const privateStructuredText = "Canary structured item never sent to PostgREST";
    const beforeSnapshot = Object.freeze({
      spaceId: null,
      type: "list" as const,
      title: privateTitle,
      bodyMarkdown: privateBody,
      structuredData: {
        schemaVersion: 1 as const,
        items: [
          {
            id: ITEM,
            text: privateStructuredText,
            checked: false,
            ordinal: 0,
            section: null
          }
        ]
      },
      isOpen: true,
      pinnedAt: null,
      privacy: "ai_assisted" as const,
      archivedAt: null,
      deletedAt: null,
      tagIds: [],
      links: []
    });
    const afterSnapshot = Object.freeze({ ...beforeSnapshot, title: "After routing" });
    const originalMutation = Object.freeze({
      schemaVersion: 1 as const,
      action: "update" as const,
      beforeRevision: 1,
      afterRevision: 2,
      operations: [{ type: "set_title" as const, title: "After routing" }],
      inverse: [{ type: "set_title" as const, title: "Before routing" }],
      beforeSnapshot,
      afterSnapshot
    });
    const receiptPayload: CaptureReceiptPayload = Object.freeze({
      schemaVersion: 2,
      captureId: CAPTURE,
      jobId: JOB,
      decisionId: DECISION,
      reviewItemId: null,
      mutationId: MUTATION,
      outcome: "added_to_note",
      headline: "Added to note",
      destination: Object.freeze({ noteId: NOTE, title: "After routing" }),
      insertedContentReferences: [{ type: "captured" as const, itemId: null }],
      actions: [
        { type: "open" as const, noteId: NOTE },
        { type: "undo" as const, mutationId: MUTATION, expectedRevision: 2 }
      ],
      undoTargets: [{ noteId: NOTE, mutationId: MUTATION, expectedRevision: 2 }],
      reasonCodes: ["explicit_destination"],
      createdAt: RECEIVED_AT
    });
    const base = aggregateMocks({ receiptPayload });
    let sealedNotePayload: unknown;
    let sealedRevisionPayload: unknown;
    let sealedMutationPayload: unknown;
    const aggregate = Object.freeze({
      ...base.aggregate,
      openNoteContent: vi.fn(
        (
          _access: Parameters<EncryptedAggregateService["openNoteContent"]>[0],
          record: EncryptedAggregateRecord<"note_content">
        ) =>
          Promise.resolve(
            record.recordVersion === 2
              ? {
                  schemaVersion: 1 as const,
                  title: afterSnapshot.title,
                  bodyMarkdown: afterSnapshot.bodyMarkdown,
                  structuredData: afterSnapshot.structuredData
                }
              : sealedNotePayload
          )
      ),
      openNoteRevision: vi.fn(
        (
          _access: Parameters<EncryptedAggregateService["openNoteRevision"]>[0],
          record: EncryptedAggregateRecord<"note_revision">
        ) => {
          if (record.resourceId === BEFORE_REVISION) {
            return Promise.resolve({ schemaVersion: 1 as const, snapshot: beforeSnapshot });
          }
          if (record.resourceId === AFTER_REVISION) {
            return Promise.resolve({ schemaVersion: 1 as const, snapshot: afterSnapshot });
          }
          return Promise.resolve(sealedRevisionPayload);
        }
      ),
      openNoteMutation: vi.fn(
        (
          _access: Parameters<EncryptedAggregateService["openNoteMutation"]>[0],
          record: EncryptedAggregateRecord<"note_mutation">
        ) =>
          Promise.resolve(record.resourceId === MUTATION ? originalMutation : sealedMutationPayload)
      ),
      sealNoteContent: vi.fn(
        (
          _access: Parameters<EncryptedAggregateService["sealNoteContent"]>[0],
          request: Parameters<EncryptedAggregateService["sealNoteContent"]>[1]
        ) => {
          sealedNotePayload = request.payload;
          return Promise.resolve(
            sealed(
              "note_content",
              request.noteId,
              request.privacy,
              "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              request.currentRevision
            )
          );
        }
      ),
      sealNoteRevision: vi.fn(
        (
          _access: Parameters<EncryptedAggregateService["sealNoteRevision"]>[0],
          request: Parameters<EncryptedAggregateService["sealNoteRevision"]>[1]
        ) => {
          sealedRevisionPayload = request.payload;
          return Promise.resolve({
            encrypted: sealed(
              "note_revision",
              request.revisionId,
              request.transition.after,
              "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              request.revision
            ),
            contentMac: mac(request.transition.after)
          });
        }
      ),
      sealNoteMutation: vi.fn(
        (
          _access: Parameters<EncryptedAggregateService["sealNoteMutation"]>[0],
          request: Parameters<EncryptedAggregateService["sealNoteMutation"]>[1]
        ) => {
          sealedMutationPayload = request.payload;
          return Promise.resolve(
            sealed(
              "note_mutation",
              request.mutationId,
              "ai_assisted",
              "ffffffff-ffff-4fff-8fff-ffffffffffff",
              request.afterRevision
            )
          );
        }
      )
    }) as unknown as EncryptedAggregateService;
    const mutationRead: EncryptedNoteMutationRead = Object.freeze({
      mutationId: MUTATION,
      noteId: NOTE,
      decisionId: DECISION,
      idempotencyKey: "original-route",
      beforeRevision: 1,
      afterRevision: 2,
      undoneAt: null,
      createdAt: RECEIVED_AT,
      mutationCipher: encrypted("note_mutation", MUTATION, "ai_assisted", 2),
      currentNote: Object.freeze({
        noteId: NOTE,
        currentRevision: 2,
        spaceId: null,
        type: "list",
        dailyDate: null,
        isOpen: true,
        pinnedAt: null,
        privacy: "ai_assisted",
        archivedAt: null,
        deletedAt: null,
        createdAt: RECEIVED_AT,
        updatedAt: RECEIVED_AT,
        contentCipher: encrypted("note_content", NOTE, "ai_assisted", 2),
        space: null,
        tags: [],
        links: []
      }),
      beforeSnapshot: Object.freeze({
        revisionId: BEFORE_REVISION,
        revision: 1,
        privacy: "ai_assisted",
        snapshotCipher: encrypted("note_revision", BEFORE_REVISION, "ai_assisted", 1)
      }),
      afterSnapshot: Object.freeze({
        revisionId: AFTER_REVISION,
        revision: 2,
        privacy: "ai_assisted",
        snapshotCipher: encrypted("note_revision", AFTER_REVISION, "ai_assisted", 2)
      })
    });
    const noteReads: EncryptedNoteReadRpcAdapter = Object.freeze({
      listNotes: vi.fn(() => Promise.reject(new Error("unexpected_note_list"))),
      getNote: vi.fn(() => Promise.reject(new Error("unexpected_note_get"))),
      listRevisions: vi.fn(() => Promise.reject(new Error("unexpected_revision_list"))),
      getMutation: vi.fn(() => Promise.resolve(mutationRead))
    });
    const routedReceipt = receiptRow("ai_assisted", {
      decisionId: DECISION,
      mutationId: MUTATION,
      outcome: "added_to_note",
      destinationNoteId: NOTE,
      reasonCodes: ["explicit_destination"]
    });
    const deleteCaptureWithUndo = vi.fn<EncryptedCaptureRpcAdapter["deleteCaptureWithUndo"]>(
      (request) =>
        Promise.resolve({
          captureId: CAPTURE,
          encryptedResponse: encrypted(
            "idempotency_response",
            `idempotency:${request.idempotencyKey}`,
            "ai_assisted"
          ),
          replayed: false
        })
    );
    const captureAdapter = adapter({
      getCaptureDetail: vi.fn(() =>
        Promise.resolve(
          detail("ai_assisted", {
            status: "done",
            receiptAvailable: true,
            receipt: routedReceipt
          })
        )
      ),
      getDeleteContext: vi.fn(() => Promise.resolve({ captureId: CAPTURE, sourceNoteIds: [NOTE] })),
      getCaptureReceipt: vi.fn(() => Promise.resolve(routedReceipt)),
      deleteCaptureWithUndo
    });
    const result = await repository(aggregate, captureAdapter, noteReads).deleteCapture(
      context,
      CAPTURE,
      {
        idempotencyKey: "delete-with-content-1",
        removeInsertedContent: true,
        expectedNoteRevisions: [{ noteId: NOTE, expectedRevision: 2 }]
      }
    );
    expect(result).toMatchObject({
      captureId: CAPTURE,
      removedInsertedContent: true,
      replayed: false,
      contentRemovalMutations: [{ noteId: NOTE, expectedRevision: 3 }]
    });
    expect(result.contentRemovalMutations[0]?.mutationId).toMatch(/^mut_/u);
    expect(deleteCaptureWithUndo).toHaveBeenCalledOnce();
    const submittedCommand = deleteCaptureWithUndo.mock.calls[0]?.[0].command;
    expect(submittedCommand).toMatchObject({
      removeInsertedContent: true,
      sourceNoteIds: [NOTE],
      undoWrites: [
        {
          noteId: NOTE,
          targetMutationId: MUTATION,
          expectedRevision: 2,
          noteState: {
            type: "list",
            title: `e-${NOTE.toLowerCase()}`,
            bodyMarkdown: "",
            structuredData: { schemaVersion: 1, items: [] }
          },
          mutation: {
            undoTargetMutationId: MUTATION,
            operations: [{ type: "set_privacy", privacy: "ai_assisted" }],
            inverse: [{ type: "set_privacy", privacy: "ai_assisted" }]
          }
        }
      ]
    });
    const serializedCommand = JSON.stringify(submittedCommand);
    expect(serializedCommand).not.toContain(privateTitle);
    expect(serializedCommand).not.toContain(privateBody);
    expect(serializedCommand).not.toContain(privateStructuredText);
    expect(sealedNotePayload).toMatchObject({
      title: privateTitle,
      bodyMarkdown: privateBody,
      structuredData: { items: [{ text: privateStructuredText }] }
    });
    expect(captureAdapter.deleteCapture).not.toHaveBeenCalled();
  });

  it("never crosses the constructor owner boundary", async () => {
    const aggregate = aggregateMocks();
    await expectServiceError(
      repository(aggregate.aggregate, adapter()).listCaptures(
        {
          accessToken: "token",
          userId: OTHER_OWNER
        },
        { limit: 30 }
      ),
      ServiceRpcErrorCode.FORBIDDEN
    );
  });
});
