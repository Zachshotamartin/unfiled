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
import { createEncryptedCaptureRpcAdapter } from "./encrypted-capture-rpc-adapter";
import {
  EncryptedCaptureAggregateRepository,
  EncryptedCaptureOperationUnavailableError,
  EncryptedCaptureUnavailableOperation
} from "./encrypted-capture-aggregate-repository";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const CAPTURE = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const JOB = "job_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const DECISION = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
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
  keyClass: "ai_assisted" | "private_manual"
): ContentEnvelopeV1 {
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: `${keyClass}-wrap-v1`,
    context: Object.freeze({ tenantId: OWNER, resourceId, recordVersion: 1, kind }),
    wrappedDataKey: Object.freeze({ nonce: "A".repeat(16), ciphertext: "a".repeat(64) }),
    payload: Object.freeze({ nonce: "B".repeat(16), ciphertext: "b".repeat(64) })
  });
}

function encrypted<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  keyClass: "ai_assisted" | "private_manual"
): EncryptedAggregateRecord<Kind> {
  return Object.freeze({
    ownerId: OWNER,
    resourceId,
    recordVersion: 1,
    kind,
    envelope: envelope(kind, resourceId, keyClass),
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
  reservationId: string
): SealedEncryptedAggregateRecord<Kind> {
  return Object.freeze({ ...encrypted(kind, resourceId, keyClass), reservationId });
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
}>;

function aggregateMocks(
  options: Readonly<{
    rawContent?: string;
    receiptPayload?: CaptureReceiptPayload;
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
  const aggregate = {
    sealCapture,
    openCapture: vi.fn(() => Promise.resolve({ schemaVersion: 1, rawContent })),
    sealCaptureReceipt,
    openCaptureReceipt,
    createAggregateVerificationMac: vi.fn(() => Promise.resolve(mac("private_manual"))),
    verifyAggregateVerificationMac: vi.fn(() => Promise.resolve(true)),
    openGeneratedBlock: vi.fn(() => Promise.resolve({ schemaVersion: 1, content: AI_TEXT }))
  } as unknown as EncryptedAggregateService;
  return Object.freeze({ aggregate, sealCapture, sealCaptureReceipt, openCaptureReceipt });
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
    getGeneratedBlocks: overrides.getGeneratedBlocks ?? vi.fn(() => Promise.resolve([]))
  });
}

function repository(
  aggregate: EncryptedAggregateService,
  captureAdapter: EncryptedCaptureRpcAdapter
): EncryptedCaptureAggregateRepository {
  return new EncryptedCaptureAggregateRepository({
    ownerId: OWNER,
    access,
    aggregate,
    adapter: captureAdapter,
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

  it("fails retry and delete closed with explicit typed operations", async () => {
    const aggregate = aggregateMocks();
    const repo = repository(aggregate.aggregate, adapter());
    await expect(repo.retryCapture(context, CAPTURE, "retry-1")).rejects.toMatchObject({
      operation: EncryptedCaptureUnavailableOperation.RETRY
    });
    await expect(
      repo.deleteCapture(context, CAPTURE, {
        idempotencyKey: "delete-1",
        removeInsertedContent: false,
        expectedNoteRevisions: []
      })
    ).rejects.toBeInstanceOf(EncryptedCaptureOperationUnavailableError);
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
