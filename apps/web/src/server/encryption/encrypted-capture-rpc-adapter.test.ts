import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import type {
  AggregateContentKind,
  EncryptedFieldRpcValue,
  KeyedMacRpcValue
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedCaptureRpcAdapter,
  encryptedCaptureRpcFunctions,
  type CreateEncryptedCaptureCommand,
  type StoredEncryptedFieldRpcValue
} from "./encrypted-capture-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const CAPTURE = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const OTHER_CAPTURE = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const JOB = "job_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const OTHER_JOB = "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const RULE = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const UNDO_MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const UNDO_REVISION = "rev_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const DECISION = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const BLOCK = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const OCCURRED_AT = "2026-08-31T18:00:00.123Z";
const CLIENT_AT = "2026-08-31T10:59:59.123-07:00";
const CANARY = "plaintext-shopping-list";

function client(implementation: ServiceRpcClient["rpc"]): ServiceRpcClient {
  return Object.freeze({ rpc: implementation });
}

function keyId(keyClass: "ai_assisted" | "private_manual"): string {
  return `${keyClass}-wrap-v1`;
}

function envelope(
  kind: AggregateContentKind,
  resourceId: string,
  recordVersion: number,
  keyClass: "ai_assisted" | "private_manual",
  ownerId = OWNER
): ContentEnvelopeV1 {
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: keyId(keyClass),
    context: Object.freeze({ tenantId: ownerId, resourceId, recordVersion, kind }),
    wrappedDataKey: Object.freeze({ nonce: "A".repeat(16), ciphertext: "a".repeat(64) }),
    payload: Object.freeze({ nonce: "B".repeat(16), ciphertext: "b".repeat(64) })
  });
}

function storedCipher<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  recordVersion: number,
  keyClass: "ai_assisted" | "private_manual",
  ownerId = OWNER
): StoredEncryptedFieldRpcValue<Kind> {
  return Object.freeze({
    envelope: envelope(kind, resourceId, recordVersion, keyClass, ownerId),
    keyId: keyId(keyClass),
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1
  });
}

function sealedCipher<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  keyClass: "ai_assisted" | "private_manual",
  reservationId: string,
  recordVersion = 1
): EncryptedFieldRpcValue<Kind> {
  return Object.freeze({
    ...storedCipher(kind, resourceId, recordVersion, keyClass),
    reservationId
  });
}

function mac(keyClass: "ai_assisted" | "private_manual"): KeyedMacRpcValue {
  return Object.freeze({
    mac: "a".repeat(64),
    keyId: `${keyClass}-mac-v1`,
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: 1
  });
}

function captureRow(
  options: Readonly<{
    captureId?: typeof CAPTURE | typeof OTHER_CAPTURE;
    jobId?: typeof JOB | typeof OTHER_JOB;
    privacy?: "ai_assisted" | "private_manual";
    receivedAt?: string;
    ownerId?: string;
    receiptAvailable?: boolean;
    status?: "queued" | "done" | "inbox";
  }> = {}
): Record<string, unknown> {
  const captureId = options.captureId ?? CAPTURE;
  const privacy = options.privacy ?? "private_manual";
  return {
    captureId,
    recordVersion: 1,
    jobId: options.jobId ?? JOB,
    source: "web",
    deviceId: "",
    contentLength: 12,
    privacy,
    explicitDestinationNoteId: null,
    expansionDisabled: false,
    clientCreatedAt: CLIENT_AT,
    clientTimezone: "America/Los_Angeles",
    receivedAt: options.receivedAt ?? OCCURRED_AT,
    status: options.status ?? "queued",
    lastErrorCode: null,
    contentCipher: storedCipher("capture", captureId, 1, privacy, options.ownerId),
    contentMac: mac(privacy),
    receiptAvailable: options.receiptAvailable ?? false
  };
}

function receiptRow(): Record<string, unknown> {
  return {
    captureId: CAPTURE,
    recordVersion: 1,
    privacy: "private_manual",
    jobId: JOB,
    decisionId: null,
    reviewItemId: null,
    mutationId: null,
    outcome: "kept_in_inbox",
    destinationNoteId: null,
    reasonCodes: ["private_manual"],
    createdAt: OCCURRED_AT,
    receiptCipher: storedCipher("capture_receipt", CAPTURE, 1, "private_manual")
  };
}

function detailRow(): Record<string, unknown> {
  const capture = Object.fromEntries(
    Object.entries(captureRow({ status: "inbox", receiptAvailable: true })).filter(
      ([key]) => key !== "receiptAvailable"
    )
  );
  return {
    ...capture,
    job: {
      jobId: JOB,
      state: "succeeded",
      attempt: 0,
      startedAt: null,
      completedAt: OCCURRED_AT,
      errorCode: null,
      createdAt: OCCURRED_AT,
      updatedAt: OCCURRED_AT
    },
    receipt: receiptRow()
  };
}

function privateCommand(): CreateEncryptedCaptureCommand {
  return Object.freeze({
    ownerId: OWNER,
    capture: Object.freeze({
      clientCaptureId: CAPTURE,
      jobId: JOB,
      occurredAt: OCCURRED_AT,
      contentCipher: sealedCipher(
        "capture",
        CAPTURE,
        "private_manual",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      ),
      contentMac: mac("private_manual"),
      contentLength: 12,
      source: "web",
      deviceId: "",
      clientCreatedAt: CLIENT_AT,
      clientTimezone: "America/Los_Angeles",
      privacy: "private_manual",
      explicitDestinationNoteId: null,
      routingRuleMatch: null,
      expansionDisabled: false,
      privateReceiptCipher: sealedCipher(
        "capture_receipt",
        CAPTURE,
        "private_manual",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      ),
      privateReceiptVerificationMac: mac("private_manual")
    })
  });
}

async function expectFailure(
  promise: Promise<unknown>,
  code: (typeof ServiceRpcErrorCode)[keyof typeof ServiceRpcErrorCode]
): Promise<void> {
  let reason: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    reason = error;
  }
  expect(reason).toBeInstanceOf(ServiceRpcError);
  expect(reason).toMatchObject({ code });
  expect(String(reason)).not.toContain(CANARY);
  expect(JSON.stringify(reason)).not.toContain(CANARY);
}

describe("encrypted capture RPC adapter", () => {
  it("exposes only the ten encrypted service-role RPCs", () => {
    expect(encryptedCaptureRpcFunctions).toEqual([
      "create_encrypted_capture_with_job",
      "list_encrypted_captures",
      "get_encrypted_capture_receipt",
      "get_encrypted_capture_detail",
      "get_encrypted_generated_blocks",
      "get_encrypted_capture_command_claim",
      "get_encrypted_capture_delete_context",
      "retry_encrypted_capture",
      "delete_encrypted_capture",
      "delete_encrypted_capture_with_undo"
    ]);
  });

  it("submits a bound private capture command without a plaintext field", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      captureId: CAPTURE,
      jobId: JOB,
      replayed: false
    });
    const result = await createEncryptedCaptureRpcAdapter(client(rpc)).createCapture(
      privateCommand()
    );
    expect(result).toEqual({ captureId: CAPTURE, jobId: JOB, replayed: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, parameters] = rpc.mock.calls[0] ?? [];
    expect(name).toBe("create_encrypted_capture_with_job");
    expect(JSON.stringify(parameters)).not.toContain(CANARY);
    const capture = (parameters as Record<string, unknown>).p_capture as Record<string, unknown>;
    expect(capture).not.toHaveProperty("rawContent");
    expect(capture).not.toHaveProperty("content");
    expect(Object.keys(capture.contentMac as object).sort()).toEqual([
      "keyClass",
      "keyId",
      "keyPurpose",
      "keyVersion",
      "mac"
    ]);
  });

  it("accepts the AI command shape only with null private receipt fields", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      captureId: CAPTURE,
      jobId: JOB,
      replayed: false
    });
    const base = privateCommand();
    await expect(
      createEncryptedCaptureRpcAdapter(client(rpc)).createCapture({
        ...base,
        capture: {
          ...base.capture,
          privacy: "ai_assisted",
          contentCipher: sealedCipher(
            "capture",
            CAPTURE,
            "ai_assisted",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          ),
          contentMac: mac("ai_assisted"),
          privateReceiptCipher: null,
          privateReceiptVerificationMac: null
        }
      })
    ).resolves.toMatchObject({ replayed: false });
  });

  it("accepts only a strict content-free rule snapshot on AI capture admission", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      captureId: CAPTURE,
      jobId: JOB,
      replayed: false
    });
    const base = privateCommand();
    const ai = {
      ...base,
      capture: {
        ...base.capture,
        privacy: "ai_assisted" as const,
        contentCipher: sealedCipher(
          "capture",
          CAPTURE,
          "ai_assisted",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        ),
        contentMac: mac("ai_assisted"),
        routingRuleMatch: {
          ruleId: RULE,
          ruleRevision: 7,
          destinationKind: "note" as const,
          destinationId: NOTE,
          priority: 900,
          matched: true as const
        },
        privateReceiptCipher: null,
        privateReceiptVerificationMac: null
      }
    };
    await expect(createEncryptedCaptureRpcAdapter(client(rpc)).createCapture(ai)).resolves.toEqual({
      captureId: CAPTURE,
      jobId: JOB,
      replayed: false
    });
    expect((rpc.mock.calls[0]?.[1].p_capture as Record<string, unknown>).routingRuleMatch).toEqual(
      ai.capture.routingRuleMatch
    );

    await expectFailure(
      createEncryptedCaptureRpcAdapter(client(vi.fn())).createCapture({
        ...ai,
        capture: { ...ai.capture, explicitDestinationNoteId: NOTE }
      }),
      ServiceRpcErrorCode.VALIDATION_FAILED
    );
  });

  it("rejects owner/resource/envelope substitution and same-reservation commands before RPC", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const adapter = createEncryptedCaptureRpcAdapter(client(rpc));
    const base = privateCommand();
    const receiptCipher = base.capture.privateReceiptCipher;
    if (receiptCipher === null) throw new TypeError("invalid_test_fixture");
    const foreign = {
      ...base,
      capture: {
        ...base.capture,
        contentCipher: {
          ...base.capture.contentCipher,
          envelope: envelope("capture", CAPTURE, 1, "private_manual", OTHER_OWNER)
        }
      }
    };
    const reusedReservation = {
      ...base,
      capture: {
        ...base.capture,
        privateReceiptCipher: {
          ...receiptCipher,
          reservationId: base.capture.contentCipher.reservationId
        }
      }
    };
    await expectFailure(adapter.createCapture(foreign), ServiceRpcErrorCode.VALIDATION_FAILED);
    await expectFailure(
      adapter.createCapture(reusedReservation),
      ServiceRpcErrorCode.VALIDATION_FAILED
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects create responses with extra keys or a different resource", async () => {
    for (const response of [
      { captureId: OTHER_CAPTURE, jobId: JOB, replayed: false },
      { captureId: CAPTURE, jobId: JOB, replayed: false, rawContent: CANARY }
    ]) {
      const adapter = createEncryptedCaptureRpcAdapter(client(vi.fn().mockResolvedValue(response)));
      await expectFailure(
        adapter.createCapture(privateCommand()),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
      );
    }
  });

  it("parses a strictly ordered page and binds its cursor to the last capture", async () => {
    const older = "2026-08-31T17:59:59.999999Z";
    const adapter = createEncryptedCaptureRpcAdapter(
      client(
        vi.fn().mockResolvedValue({
          captures: [
            captureRow(),
            captureRow({ captureId: OTHER_CAPTURE, jobId: OTHER_JOB, receivedAt: older })
          ],
          nextCursor: { receivedAt: older, captureId: OTHER_CAPTURE }
        })
      )
    );
    await expect(adapter.listCaptures({ ownerId: OWNER, limit: 2 })).resolves.toMatchObject({
      captures: [{ captureId: CAPTURE }, { captureId: OTHER_CAPTURE }],
      nextCursor: { receivedAt: older, captureId: OTHER_CAPTURE }
    });
  });

  it("rejects list projections with foreign envelopes, unstable order, or cursor mismatch", async () => {
    const cases = [
      {
        captures: [captureRow({ ownerId: OTHER_OWNER })],
        nextCursor: { receivedAt: OCCURRED_AT, captureId: CAPTURE }
      },
      {
        captures: [
          captureRow({ receivedAt: "2026-08-31T17:00:00.000Z" }),
          captureRow({ captureId: OTHER_CAPTURE, jobId: OTHER_JOB, receivedAt: OCCURRED_AT })
        ],
        nextCursor: { receivedAt: OCCURRED_AT, captureId: OTHER_CAPTURE }
      },
      {
        captures: [captureRow()],
        nextCursor: { receivedAt: OCCURRED_AT, captureId: OTHER_CAPTURE }
      }
    ];
    for (const response of cases) {
      const adapter = createEncryptedCaptureRpcAdapter(client(vi.fn().mockResolvedValue(response)));
      await expectFailure(
        adapter.listCaptures({ ownerId: OWNER, limit: 2 }),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
      );
    }
  });

  it("rejects extra input keys and a page that does not advance beyond its cursor", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const adapter = createEncryptedCaptureRpcAdapter(client(rpc));
    const extraInput = { ownerId: OWNER, limit: 2, rawContent: CANARY };
    await expectFailure(adapter.listCaptures(extraInput), ServiceRpcErrorCode.VALIDATION_FAILED);
    const extraCursorInput = {
      ownerId: OWNER,
      limit: 2,
      cursor: { receivedAt: OCCURRED_AT, captureId: CAPTURE, plaintext: CANARY }
    };
    await expectFailure(
      adapter.listCaptures(extraCursorInput),
      ServiceRpcErrorCode.VALIDATION_FAILED
    );
    expect(rpc).not.toHaveBeenCalled();

    const nonAdvancing = createEncryptedCaptureRpcAdapter(
      client(
        vi.fn().mockResolvedValue({
          captures: [captureRow()],
          nextCursor: { receivedAt: OCCURRED_AT, captureId: CAPTURE }
        })
      )
    );
    await expectFailure(
      nonAdvancing.listCaptures({
        ownerId: OWNER,
        limit: 2,
        cursor: { receivedAt: OCCURRED_AT, captureId: CAPTURE }
      }),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
  });

  it("binds detail and receipt projections to the capture, job, privacy, and envelope", async () => {
    const good = createEncryptedCaptureRpcAdapter(
      client(
        vi.fn().mockResolvedValue({
          capture: detailRow()
        })
      )
    );
    await expect(
      good.getCaptureDetail({ ownerId: OWNER, captureId: CAPTURE })
    ).resolves.toMatchObject({
      captureId: CAPTURE,
      jobId: JOB,
      receipt: { captureId: CAPTURE, jobId: JOB, privacy: "private_manual" }
    });

    const badDetail = detailRow();
    badDetail.receipt = { ...receiptRow(), jobId: OTHER_JOB };
    const bad = createEncryptedCaptureRpcAdapter(
      client(vi.fn().mockResolvedValue({ capture: badDetail }))
    );
    await expectFailure(
      bad.getCaptureDetail({ ownerId: OWNER, captureId: CAPTURE }),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
  });

  it("requires generated blocks in the exact requested order and rejects duplicate or oversized inputs", async () => {
    const block = {
      blockId: BLOCK,
      recordVersion: 1,
      noteId: NOTE,
      decisionId: DECISION,
      reviewItemId: null,
      kind: "summary",
      state: "accepted",
      stateRevision: 2,
      modelId: "model",
      promptVersion: "routing-v1",
      resolvedAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
      contentCipher: storedCipher("generated_block", BLOCK, 1, "ai_assisted")
    };
    const adapter = createEncryptedCaptureRpcAdapter(
      client(vi.fn().mockResolvedValue({ blocks: [block] }))
    );
    await expect(
      adapter.getGeneratedBlocks({ ownerId: OWNER, blockIds: [BLOCK] })
    ).resolves.toMatchObject([{ blockId: BLOCK, noteId: NOTE, decisionId: DECISION }]);
    await expectFailure(
      adapter.getGeneratedBlocks({ ownerId: OWNER, blockIds: [BLOCK, BLOCK] }),
      ServiceRpcErrorCode.VALIDATION_FAILED
    );
    await expectFailure(
      adapter.getGeneratedBlocks({
        ownerId: OWNER,
        blockIds: Array.from({ length: 101 }, () => BLOCK)
      }),
      ServiceRpcErrorCode.VALIDATION_FAILED
    );
  });

  it("binds command claims and delete context to exact owner-scoped metadata", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name) => {
      if (name === "get_encrypted_capture_command_claim") {
        return Promise.resolve({
          found: true,
          claim: {
            scope: "delete_capture",
            captureId: CAPTURE,
            keyClass: "private_manual",
            requestMacKey: {
              keyId: "private_manual-mac-v1",
              keyClass: "private_manual",
              keyPurpose: "content_mac",
              keyVersion: 1
            }
          }
        });
      }
      if (name === "get_encrypted_capture_delete_context") {
        return Promise.resolve({ captureId: CAPTURE, sourceNoteIds: [NOTE] });
      }
      return Promise.reject(new Error("unexpected_rpc"));
    });
    const adapter = createEncryptedCaptureRpcAdapter(client(rpc));
    await expect(
      adapter.getCommandClaim({
        ownerId: OWNER,
        scope: "delete_capture",
        idempotencyKey: "delete-1"
      })
    ).resolves.toMatchObject({
      captureId: CAPTURE,
      requestMacKey: { ownerId: OWNER, purpose: "content_mac" }
    });
    await expect(adapter.getDeleteContext({ ownerId: OWNER, captureId: CAPTURE })).resolves.toEqual(
      { captureId: CAPTURE, sourceNoteIds: [NOTE] }
    );

    const unsorted = createEncryptedCaptureRpcAdapter(
      client(
        vi.fn().mockResolvedValue({
          captureId: CAPTURE,
          sourceNoteIds: ["note_01J6M9Q7G4BMKB33GSG3NJ6D1Y", NOTE]
        })
      )
    );
    await expectFailure(
      unsorted.getDeleteContext({ ownerId: OWNER, captureId: CAPTURE }),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
  });

  it("submits strict retry/delete ciphertext commands and parses only bound responses", async () => {
    const retryKey = "retry-1";
    const deleteKey = "delete-1";
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name, parameters) => {
      const key = (parameters as Record<string, unknown>).p_idempotency_key;
      if (name === "retry_encrypted_capture") {
        return Promise.resolve({
          captureId: CAPTURE,
          jobId: JOB,
          encryptedResponse: storedCipher(
            "idempotency_response",
            `idempotency:${String(key)}`,
            1,
            "private_manual"
          ),
          replayed: false
        });
      }
      if (name === "delete_encrypted_capture") {
        return Promise.resolve({
          captureId: CAPTURE,
          encryptedResponse: storedCipher(
            "idempotency_response",
            `idempotency:${String(key)}`,
            1,
            "private_manual"
          ),
          replayed: true
        });
      }
      return Promise.reject(new Error("unexpected_rpc"));
    });
    const adapter = createEncryptedCaptureRpcAdapter(client(rpc));
    const material = {
      occurredAt: OCCURRED_AT,
      requestMac: mac("private_manual"),
      responseCipher: sealedCipher(
        "idempotency_response",
        `idempotency:${retryKey}`,
        "private_manual",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      ),
      responseVerificationMac: mac("private_manual")
    } as const;
    await expect(
      adapter.retryCapture({
        ownerId: OWNER,
        captureId: CAPTURE,
        privacy: "private_manual",
        idempotencyKey: retryKey,
        command: material
      })
    ).resolves.toMatchObject({ captureId: CAPTURE, jobId: JOB, replayed: false });
    await expect(
      adapter.deleteCapture({
        ownerId: OWNER,
        captureId: CAPTURE,
        privacy: "private_manual",
        idempotencyKey: deleteKey,
        command: { requestMac: mac("private_manual") }
      })
    ).resolves.toMatchObject({ captureId: CAPTURE, replayed: true });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(CANARY);

    await expectFailure(
      adapter.deleteCapture({
        ownerId: OWNER,
        captureId: CAPTURE,
        privacy: "private_manual",
        idempotencyKey: deleteKey,
        command: {
          ...material,
          responseCipher: sealedCipher(
            "idempotency_response",
            `idempotency:${deleteKey}`,
            "private_manual",
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
          ),
          removeInsertedContent: false,
          sourceNoteIds: [NOTE, NOTE]
        }
      }),
      ServiceRpcErrorCode.VALIDATION_FAILED
    );
  });

  it("submits one exact encrypted multi-note undo command to its dedicated RPC", async () => {
    const key = "delete-with-undo-1";
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name, parameters) => {
      expect(name).toBe("delete_encrypted_capture_with_undo");
      expect(parameters).toMatchObject({
        p_owner_id: OWNER,
        p_capture_id: CAPTURE,
        p_idempotency_key: key,
        p_command: {
          removeInsertedContent: true,
          sourceNoteIds: [NOTE],
          undoWrites: [{ noteId: NOTE, targetMutationId: MUTATION, expectedRevision: 2 }]
        }
      });
      return Promise.resolve({
        captureId: CAPTURE,
        encryptedResponse: storedCipher(
          "idempotency_response",
          `idempotency:${key}`,
          1,
          "private_manual"
        ),
        replayed: false
      });
    });
    const adapter = createEncryptedCaptureRpcAdapter(client(rpc));
    const result = await adapter.deleteCaptureWithUndo({
      ownerId: OWNER,
      captureId: CAPTURE,
      privacy: "private_manual",
      idempotencyKey: key,
      command: {
        occurredAt: OCCURRED_AT,
        removeInsertedContent: true,
        sourceNoteIds: [NOTE],
        receipt: {
          recordVersion: 1,
          cipher: storedCipher("capture_receipt", CAPTURE, 1, "private_manual")
        },
        undoWrites: [
          {
            noteId: NOTE,
            targetMutationId: MUTATION,
            expectedRevision: 2,
            sourcePrivacy: "private_manual",
            expectedCurrentCipher: storedCipher("note_content", NOTE, 2, "private_manual"),
            expectedMutationCipher: storedCipher("note_mutation", MUTATION, 2, "private_manual"),
            noteState: {
              spaceId: null,
              type: "generic",
              title: `e-${NOTE.toLowerCase()}`,
              bodyMarkdown: "",
              structuredData: { schemaVersion: 1 },
              dailyDate: null,
              isOpen: true,
              privacy: "private_manual",
              pinnedAt: null,
              archivedAt: null,
              deletedAt: null,
              tagIds: [],
              links: []
            },
            noteCipher: sealedCipher(
              "note_content",
              NOTE,
              "private_manual",
              "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              3
            ),
            revision: {
              id: UNDO_REVISION,
              source: "undo",
              actor: "capture:delete",
              cipher: sealedCipher(
                "note_revision",
                UNDO_REVISION,
                "private_manual",
                "ffffffff-ffff-4fff-8fff-ffffffffffff",
                3
              ),
              mac: mac("private_manual")
            },
            mutation: {
              id: UNDO_MUTATION,
              decisionId: null,
              undoTargetMutationId: MUTATION,
              operations: [{ type: "set_privacy", privacy: "private_manual" }],
              inverse: [{ type: "set_privacy", privacy: "private_manual" }],
              cipher: sealedCipher(
                "note_mutation",
                UNDO_MUTATION,
                "private_manual",
                "99999999-9999-4999-8999-999999999999",
                3
              )
            },
            verification: {
              noteContent: mac("private_manual"),
              noteMutation: mac("private_manual")
            }
          }
        ],
        requestMac: mac("private_manual"),
        responseCipher: sealedCipher(
          "idempotency_response",
          `idempotency:${key}`,
          "private_manual",
          "77777777-7777-4777-8777-777777777777"
        ),
        responseVerificationMac: mac("private_manual")
      }
    });
    expect(result).toMatchObject({ captureId: CAPTURE, replayed: false });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("never reflects a provider plaintext canary in typed failures", async () => {
    const adapter = createEncryptedCaptureRpcAdapter(
      client(
        vi.fn().mockResolvedValue({
          receipt: { ...receiptRow(), [CANARY]: CANARY }
        })
      )
    );
    await expectFailure(
      adapter.getCaptureReceipt({ ownerId: OWNER, captureId: CAPTURE }),
      ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    );
  });
});
