import {
  EncryptedAggregateError,
  EncryptedAggregateErrorCode,
  type NoteContentPayload,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import {
  KeyManagementError,
  KeyManagementErrorCode,
  type ManagedKeyRecordV1
} from "@unfiled/key-management";
import { PrivateRagValidationError } from "@unfiled/search";
import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../src/embedding-provider";
import { EmbeddingProviderError } from "../src/embedding-provider";
import type { IndexCryptoFactory } from "../src/index-crypto";
import type { ClaimedNoteIndexJob, NoteIndexRepository } from "../src/index-database";
import { createNoteIndexDrain, type NoteIndexDrainOptions } from "../src/index-drain";

const ULID = "01J6M9Q7G4BMKB33GSG3NJ6D1X";
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = `ijob_${ULID}`;
const NOTE_ID = `note_${ULID}`;
const INDEX_ID = `irw_${ULID}`;
const GENERATION_ID = `igen_${ULID}`;
const KEY_ID = "ai.object.v1";
const LEASE_TOKEN = "11111111-1111-4111-8111-111111111111";
const RESERVATION_ID = "22222222-2222-4222-8222-222222222222";

function managedKey(): ManagedKeyRecordV1 {
  return {
    activatedAt: "2026-08-30T12:00:00.000Z",
    createdAt: "2026-08-30T12:00:00.000Z",
    encryptedKeyMaterial: "AQIDBA",
    keyClass: "ai_assisted",
    keyId: KEY_ID,
    keyVersion: 1,
    ownerId: OWNER_ID,
    purpose: "object_wrap",
    retiredAt: null,
    revokedAt: null,
    rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
    rotation: {
      lastRootRewrappedAt: null,
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0
    },
    schemaVersion: 1,
    status: "active",
    wrapOperationLimit: 16_777_216,
    wrapOperations: 1
  };
}

function job(overrides: Partial<ClaimedNoteIndexJob> = {}): ClaimedNoteIndexJob {
  const key = managedKey();
  return {
    attempt: 1,
    embeddingDimensions: 3,
    embeddingModelId: "text-embedding-3-small",
    generationId: GENERATION_ID,
    generationRevisionToken: 1,
    indexResourceId: INDEX_ID,
    isOpen: true,
    jobId: JOB_ID,
    leaseExpiresAt: "2026-08-30T12:02:00.000Z",
    leaseToken: LEASE_TOKEN,
    noteId: NOTE_ID,
    noteType: "list",
    pinnedAt: null,
    reservation: {
      consumed: false,
      keyClass: "ai_assisted",
      keyId: KEY_ID,
      keyPurpose: "object_wrap",
      keyVersion: 1,
      operationCount: 1,
      reservationId: RESERVATION_ID
    },
    sourceEnvelopeBytes: 512,
    sourceKey: key,
    sourceNoteCipher: {
      envelope: {
        context: {
          kind: "note_content",
          recordVersion: 2,
          resourceId: NOTE_ID,
          tenantId: OWNER_ID
        },
        keyId: KEY_ID,
        payload: {
          ciphertext: Buffer.alloc(64, 1).toString("base64url"),
          nonce: Buffer.alloc(12, 2).toString("base64url")
        },
        suite: "A256GCM",
        version: 1,
        wrappedDataKey: {
          ciphertext: Buffer.alloc(48, 3).toString("base64url"),
          nonce: Buffer.alloc(12, 4).toString("base64url")
        }
      },
      keyClass: "ai_assisted",
      keyId: KEY_ID,
      keyPurpose: "object_wrap",
      keyVersion: 1
    },
    spaceId: null,
    targetKey: key,
    targetRevision: 2,
    updatedAt: "2026-08-30T12:00:00.000Z",
    userId: OWNER_ID,
    ...overrides
  };
}

function sealed(): SealedEncryptedAggregateRecord<"note_rag_index"> {
  return {
    envelope: {
      context: {
        kind: "note_rag_index",
        recordVersion: 2,
        resourceId: INDEX_ID,
        tenantId: OWNER_ID
      },
      keyId: KEY_ID,
      payload: {
        ciphertext: Buffer.alloc(64, 7).toString("base64url"),
        nonce: Buffer.alloc(12, 8).toString("base64url")
      },
      suite: "A256GCM",
      version: 1,
      wrappedDataKey: {
        ciphertext: Buffer.alloc(48, 9).toString("base64url"),
        nonce: Buffer.alloc(12, 10).toString("base64url")
      }
    },
    keyClass: "ai_assisted",
    keyId: KEY_ID,
    keyPurpose: "object_wrap",
    keyVersion: 1,
    kind: "note_rag_index",
    ownerId: OWNER_ID,
    recordVersion: 2,
    reservationId: RESERVATION_ID,
    resourceId: INDEX_ID
  };
}

function note(): NoteContentPayload {
  return {
    bodyMarkdown: "# Groceries\nMilk and eggs",
    schemaVersion: 1,
    structuredData: {},
    title: "Shopping"
  } as NoteContentPayload;
}

function repository(
  events: string[],
  claimed: readonly ClaimedNoteIndexJob[] = [job()]
): NoteIndexRepository {
  return {
    claim: vi.fn(() => {
      events.push("claim");
      return Promise.resolve({
        jobs: claimed,
        sourceEnvelopeByteBudget: 8_388_608 as const,
        sourceEnvelopeBytes: claimed.reduce((sum, item) => sum + item.sourceEnvelopeBytes, 0)
      });
    }),
    commit: vi.fn(() => {
      events.push("commit");
      return Promise.resolve({
        committed: true as const,
        generationRevisionToken: 2,
        indexId: INDEX_ID,
        jobId: JOB_ID,
        replayed: false as const,
        reservationId: RESERVATION_ID
      });
    }),
    fail: vi.fn(() => {
      events.push("fail");
      return Promise.resolve({ jobId: JOB_ID, replayed: false, state: "failed" as const });
    }),
    heartbeat: vi.fn(() => {
      events.push("heartbeat");
      return Promise.resolve({
        disclosureAuthorized: true as const,
        jobId: JOB_ID,
        leaseExpiresAt: "2026-08-30T12:03:00.000Z"
      });
    }),
    listActive: vi.fn(),
    preflight: vi.fn(() => {
      events.push("preflight");
      return Promise.resolve();
    }),
    recoverStale: vi.fn(() => {
      events.push("recover");
      return Promise.resolve({ failedCount: 0, recoveredCount: 0 });
    })
  };
}

function crypto(events: string[]): IndexCryptoFactory {
  return {
    forJob: vi.fn(() => ({
      openNote: vi.fn(() => {
        events.push("open");
        return Promise.resolve(note());
      }),
      sealIndex: vi.fn(() => {
        events.push("seal");
        return Promise.resolve(sealed());
      })
    }))
  };
}

function cryptoReturning(
  events: string[],
  record: SealedEncryptedAggregateRecord<"note_rag_index">
): IndexCryptoFactory {
  return {
    forJob: vi.fn(() => ({
      openNote: vi.fn(() => {
        events.push("open");
        return Promise.resolve(note());
      }),
      sealIndex: vi.fn(() => {
        events.push("seal");
        return Promise.resolve(record);
      })
    }))
  };
}

function embedding(
  events: string[],
  vector = new Float32Array([0.1, 0.2, 0.3])
): EmbeddingProvider {
  return {
    embed: vi.fn(() => {
      events.push("embed");
      return Promise.resolve(vector);
    })
  };
}

function options(overrides: Partial<NoteIndexDrainOptions> = {}) {
  const events: string[] = [];
  const cryptoFactory = crypto(events);
  const value: NoteIndexDrainOptions = {
    claimLimit: 4,
    concurrency: 2,
    cryptoForAuthority: () => cryptoFactory,
    embedding: embedding(events),
    embeddingDimensions: 3,
    embeddingMaxInputBytes: 2_048,
    embeddingModelId: "text-embedding-3-small",
    leaseSeconds: 120,
    recoveryLimit: 100,
    repository: repository(events),
    workerId: "index-worker-test",
    ...overrides
  };
  return { events, options: value };
}

function drainInput(signal = new AbortController().signal) {
  return {
    authority: {} as never,
    requestId: "request-1",
    signal,
    trigger: "manual" as const
  };
}

describe("encrypted note index drain", () => {
  it("orders disclosure and publication revalidation exactly and wipes the embedding", async () => {
    const vector = new Float32Array([0.1, 0.2, 0.3]);
    const { events, options: base } = options();
    const configured = { ...base, embedding: embedding(events, vector) };

    await expect(createNoteIndexDrain(configured).drain(drainInput())).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      retryScheduled: 0
    });
    expect(events).toEqual([
      "preflight",
      "recover",
      "claim",
      "open",
      "heartbeat",
      "embed",
      "seal",
      "heartbeat",
      "commit"
    ]);
    expect(Array.from(vector)).toEqual([0, 0, 0]);
  });

  it("discloses nothing and leaves recovery in charge when the first heartbeat is denied", async () => {
    const { events, options: configured } = options();
    vi.mocked(configured.repository.heartbeat).mockRejectedValueOnce(new Error("privacy changed"));

    await expect(createNoteIndexDrain(configured).drain(drainInput())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 0,
      retryScheduled: 0
    });
    expect(configured.embedding.embed).not.toHaveBeenCalled();
    expect(configured.repository.commit).not.toHaveBeenCalled();
    expect(configured.repository.fail).not.toHaveBeenCalled();
    expect(events).toEqual(["preflight", "recover", "claim", "open"]);
  });

  it("publishes nothing when privacy changes after embedding but before commit", async () => {
    const { events, options: configured } = options();
    vi.mocked(configured.repository.heartbeat)
      .mockResolvedValueOnce({
        disclosureAuthorized: true,
        jobId: JOB_ID,
        leaseExpiresAt: "2026-08-30T12:03:00.000Z"
      })
      .mockRejectedValueOnce(new Error("privacy changed"));

    await createNoteIndexDrain(configured).drain(drainInput());
    expect(configured.embedding.embed).toHaveBeenCalledOnce();
    expect(configured.repository.commit).not.toHaveBeenCalled();
    expect(configured.repository.fail).not.toHaveBeenCalled();
    expect(events).toContain("seal");
  });

  it("retries an ambiguous commit with the exact sealed arguments and no reseal or re-embed", async () => {
    const { options: configured } = options();
    vi.mocked(configured.repository.commit)
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({
        committed: true,
        indexId: INDEX_ID,
        jobId: JOB_ID,
        replayed: true,
        reservationId: RESERVATION_ID
      });

    const result = await createNoteIndexDrain(configured).drain(drainInput());
    expect(result.completed).toBe(1);
    expect(configured.repository.commit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(configured.repository.commit).mock.calls[0]?.[0]).toBe(
      vi.mocked(configured.repository.commit).mock.calls[1]?.[0]
    );
    expect(configured.embedding.embed).toHaveBeenCalledOnce();
  });

  it("uses an exact deterministic fail replay for retryable provider failures", async () => {
    const { options: configured } = options();
    vi.mocked(configured.embedding.embed).mockRejectedValue(
      new EmbeddingProviderError("rate_limited", true)
    );
    vi.mocked(configured.repository.fail)
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ jobId: JOB_ID, replayed: true, state: "queued" });

    const result = await createNoteIndexDrain(configured).drain(drainInput());
    expect(result.retryScheduled).toBe(1);
    expect(configured.repository.fail).toHaveBeenCalledTimes(2);
    const first = vi.mocked(configured.repository.fail).mock.calls[0]?.[0];
    expect(first).toBe(vi.mocked(configured.repository.fail).mock.calls[1]?.[0]);
    expect(first).toMatchObject({
      errorCode: "rate_limited",
      retryable: true,
      retryDelaySeconds: 5
    });
    expect(configured.repository.commit).not.toHaveBeenCalled();
  });

  it("rejects a model-generation mismatch before KMS or provider disclosure", async () => {
    const events: string[] = [];
    const repo = repository(events, [job({ embeddingModelId: "unexpected-model" })]);
    const cryptoFactory = crypto(events);
    const { options: base } = options({ repository: repo });
    const configured = { ...base, cryptoForAuthority: () => cryptoFactory, repository: repo };

    const result = await createNoteIndexDrain(configured).drain(drainInput());
    expect(result.failed).toBe(1);
    expect(cryptoFactory.forJob).not.toHaveBeenCalled();
    expect(configured.embedding.embed).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "validation_failed", retryable: false })
    );
  });

  it("aborts in-flight provider work without fail or commit and releases the process lock", async () => {
    const controller = new AbortController();
    const { options: configured } = options();
    vi.mocked(configured.embedding.embed).mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const drain = createNoteIndexDrain(configured);
    const pending = drain.drain(drainInput(controller.signal));
    await vi.waitFor(() => expect(configured.embedding.embed).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).resolves.toMatchObject({ claimed: 1, completed: 0 });
    expect(configured.repository.fail).not.toHaveBeenCalled();
    expect(configured.repository.commit).not.toHaveBeenCalled();
    vi.mocked(configured.repository.claim).mockResolvedValueOnce({
      jobs: [],
      sourceEnvelopeByteBudget: 8_388_608,
      sourceEnvelopeBytes: 0
    });
    await expect(drain.drain(drainInput())).resolves.toMatchObject({ claimed: 0 });
  });

  it("allows only one active process drain", async () => {
    const { options: configured } = options();
    let releaseClaim: (() => void) | undefined;
    vi.mocked(configured.repository.claim).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseClaim = () =>
            resolve({ jobs: [], sourceEnvelopeByteBudget: 8_388_608, sourceEnvelopeBytes: 0 });
        })
    );
    const drain = createNoteIndexDrain(configured);
    const first = drain.drain(drainInput());
    await vi.waitFor(() => expect(configured.repository.claim).toHaveBeenCalledOnce());
    await expect(drain.drain(drainInput())).rejects.toMatchObject({
      code: "provider_unavailable"
    });
    releaseClaim?.();
    await first;
  });

  it.each([
    {
      error: new EmbeddingProviderError("provider_key_invalid", true),
      errorCode: "provider_key_invalid",
      name: "allowlisted embedding failure",
      retryable: true
    },
    {
      error: new EmbeddingProviderError("unexpected" as never, false),
      errorCode: "provider_unavailable",
      name: "unrecognized embedding failure",
      retryable: true
    },
    {
      error: new KeyManagementError(KeyManagementErrorCode.KMS_UNAVAILABLE, "kms canary"),
      errorCode: "provider_unavailable",
      name: "unavailable KMS",
      retryable: true
    },
    {
      error: new KeyManagementError(KeyManagementErrorCode.KEY_NOT_FOUND, "key canary"),
      errorCode: "provider_unavailable",
      name: "missing managed key",
      retryable: true
    },
    {
      error: new KeyManagementError(KeyManagementErrorCode.ACCESS_DENIED, "access canary"),
      errorCode: "validation_failed",
      name: "denied managed key",
      retryable: false
    },
    {
      error: new EncryptedAggregateError(
        EncryptedAggregateErrorCode.KEY_UNAVAILABLE,
        "aggregate key canary"
      ),
      errorCode: "provider_unavailable",
      name: "unavailable aggregate key",
      retryable: true
    },
    {
      error: new EncryptedAggregateError(
        EncryptedAggregateErrorCode.ENCRYPTION_FAILED,
        "encryption canary"
      ),
      errorCode: "provider_unavailable",
      name: "aggregate encryption failure",
      retryable: true
    },
    {
      error: new EncryptedAggregateError(
        EncryptedAggregateErrorCode.UNSUPPORTED_RUNTIME,
        "runtime canary"
      ),
      errorCode: "provider_unavailable",
      name: "unsupported crypto runtime",
      retryable: true
    },
    {
      error: new EncryptedAggregateError(EncryptedAggregateErrorCode.INVALID_INPUT, "input canary"),
      errorCode: "validation_failed",
      name: "invalid aggregate input",
      retryable: false
    },
    {
      error: new PrivateRagValidationError("invalid_shape"),
      errorCode: "validation_failed",
      name: "invalid private RAG payload",
      retryable: false
    },
    {
      error: new Error("unknown dependency canary"),
      errorCode: "provider_unavailable",
      name: "unknown dependency failure",
      retryable: true
    }
  ] as const)("classifies $name into a safe failure", async ({ error, errorCode, retryable }) => {
    const factory: IndexCryptoFactory = {
      forJob: vi.fn(() => {
        throw error;
      })
    };
    const { options: configured } = options({ cryptoForAuthority: () => factory });
    vi.mocked(configured.repository.fail).mockImplementation((input) =>
      Promise.resolve({
        jobId: input.jobId,
        replayed: false,
        state: input.retryable ? "queued" : "failed"
      })
    );

    const result = await createNoteIndexDrain(configured).drain(drainInput());

    expect(configured.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode, retryable })
    );
    expect(result).toMatchObject(
      retryable ? { retryScheduled: 1 } : { failed: 1, retryScheduled: 0 }
    );
  });

  it.each([
    ["wrong dimension", new Float32Array([0.1, 0.2])],
    ["non-finite component", new Float32Array([0.1, Number.NaN, 0.3])]
  ] as const)("fails a %s embedding and wipes it", async (_name, vector) => {
    const { events, options: base } = options();
    const configured = { ...base, embedding: embedding(events, vector) };

    const result = await createNoteIndexDrain(configured).drain(drainInput());

    expect(result.failed).toBe(1);
    expect(configured.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_unavailable", retryable: true })
    );
    expect(configured.repository.commit).not.toHaveBeenCalled();
    expect(Array.from(vector)).toEqual(new Array(vector.length).fill(0));
  });

  it("classifies a document payload validation failure as terminal", async () => {
    const { options: configured } = options();
    vi.mocked(configured.repository.claim).mockResolvedValueOnce({
      jobs: [job({ updatedAt: "not-a-timestamp" })],
      sourceEnvelopeByteBudget: 8_388_608,
      sourceEnvelopeBytes: 512
    });

    const result = await createNoteIndexDrain(configured).drain(drainInput());

    expect(result.failed).toBe(1);
    expect(configured.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "validation_failed", retryable: false })
    );
    expect(configured.repository.commit).not.toHaveBeenCalled();
  });

  it("rejects every sealed-record binding mismatch before commit", async () => {
    const baseline = sealed();
    const mismatches: readonly [string, SealedEncryptedAggregateRecord<"note_rag_index">][] = [
      [
        "envelope kind",
        {
          ...baseline,
          envelope: {
            ...baseline.envelope,
            context: { ...baseline.envelope.context, kind: "note_content" }
          }
        } as never
      ],
      ["owner", { ...baseline, ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
      ["resource", { ...baseline, resourceId: `irw_${ULID.slice(0, -1)}Y` }],
      ["revision", { ...baseline, recordVersion: 3 }],
      ["key class", { ...baseline, keyClass: "private_manual" } as never],
      ["key purpose", { ...baseline, keyPurpose: "content_mac" } as never],
      ["key id", { ...baseline, keyId: "ai.object.other" }],
      ["key version", { ...baseline, keyVersion: 2 }],
      ["reservation", { ...baseline, reservationId: "33333333-3333-4333-8333-333333333333" }]
    ];

    for (const [label, record] of mismatches) {
      const events: string[] = [];
      const configuredRepository = repository(events);
      const factory = cryptoReturning(events, record);
      const { options: base } = options();
      const configured: NoteIndexDrainOptions = {
        ...base,
        cryptoForAuthority: () => factory,
        repository: configuredRepository
      };

      const result = await createNoteIndexDrain(configured).drain(drainInput());

      expect(result.failed, label).toBe(1);
      expect(configuredRepository.fail, label).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "provider_unavailable", retryable: true })
      );
      expect(configuredRepository.commit, label).not.toHaveBeenCalled();
      expect(configuredRepository.heartbeat, label).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["invalid alphabet", "***"],
    ["invalid base64url length", "A"],
    ["non-canonical base64url", "AB"],
    ["short ciphertext", Buffer.alloc(15, 1).toString("base64url")],
    ["oversized ciphertext", Buffer.alloc(262_161, 1).toString("base64url")]
  ] as const)("rejects %s in the sealed ciphertext payload", async (_name, ciphertext) => {
    const baseline = sealed();
    const record = {
      ...baseline,
      envelope: {
        ...baseline.envelope,
        payload: { ...baseline.envelope.payload, ciphertext }
      }
    };
    const events: string[] = [];
    const configuredRepository = repository(events);
    const factory = cryptoReturning(events, record);
    const { options: base } = options();
    const configured: NoteIndexDrainOptions = {
      ...base,
      cryptoForAuthority: () => factory,
      repository: configuredRepository
    };

    const result = await createNoteIndexDrain(configured).drain(drainInput());

    expect(result.failed).toBe(1);
    expect(configuredRepository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_unavailable", retryable: true })
    );
    expect(configuredRepository.commit).not.toHaveBeenCalled();
  });

  it("abandons a commit after two ambiguous responses without failing or resealing", async () => {
    const { options: configured } = options();
    vi.mocked(configured.repository.commit).mockRejectedValue(new Error("response lost"));

    const result = await createNoteIndexDrain(configured).drain(drainInput());

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 0, retryScheduled: 0 });
    expect(configured.repository.commit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(configured.repository.commit).mock.calls[0]?.[0]).toBe(
      vi.mocked(configured.repository.commit).mock.calls[1]?.[0]
    );
    expect(configured.embedding.embed).toHaveBeenCalledOnce();
    expect(configured.repository.fail).not.toHaveBeenCalled();
  });

  it("does not retry an explicitly aborted commit", async () => {
    const { options: configured } = options();
    vi.mocked(configured.repository.commit).mockRejectedValueOnce(
      new DOMException("commit aborted", "AbortError")
    );

    const result = await createNoteIndexDrain(configured).drain(drainInput());

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 0 });
    expect(configured.repository.commit).toHaveBeenCalledOnce();
    expect(configured.repository.fail).not.toHaveBeenCalled();
  });

  it("counts a definitive rejected commit as failed", async () => {
    const { options: configured } = options();
    vi.mocked(configured.repository.commit).mockResolvedValueOnce({
      committed: false,
      errorCode: "stale_revision",
      jobId: JOB_ID,
      replayed: false
    });

    await expect(createNoteIndexDrain(configured).drain(drainInput())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 1,
      retryScheduled: 0
    });
    expect(configured.repository.fail).not.toHaveBeenCalled();
  });

  it("abandons a fail transition after two ambiguous responses using the exact input", async () => {
    const { options: configured } = options();
    vi.mocked(configured.embedding.embed).mockRejectedValue(new Error("provider failed"));
    vi.mocked(configured.repository.fail).mockRejectedValue(new Error("response lost"));

    const result = await createNoteIndexDrain(configured).drain(drainInput());

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 0, retryScheduled: 0 });
    expect(configured.repository.fail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(configured.repository.fail).mock.calls[0]?.[0]).toBe(
      vi.mocked(configured.repository.fail).mock.calls[1]?.[0]
    );
  });

  it("does not retry an explicitly aborted fail transition", async () => {
    const { options: configured } = options();
    vi.mocked(configured.embedding.embed).mockRejectedValue(new Error("provider failed"));
    const abortError = new Error("fail aborted");
    abortError.name = "AbortError";
    vi.mocked(configured.repository.fail).mockRejectedValueOnce(abortError);

    const result = await createNoteIndexDrain(configured).drain(drainInput());

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 0 });
    expect(configured.repository.fail).toHaveBeenCalledOnce();
  });

  it.each([
    [0, 5],
    [1, 5],
    [2, 30],
    [3, 120],
    [4, 600],
    [5, 600],
    [6, 600],
    [Number.NaN, 600]
  ] as const)("uses bounded deterministic backoff for attempt %s", async (attempt, delay) => {
    const { options: configured } = options();
    vi.mocked(configured.repository.claim).mockResolvedValueOnce({
      jobs: [job({ attempt })],
      sourceEnvelopeByteBudget: 8_388_608,
      sourceEnvelopeBytes: 512
    });
    vi.mocked(configured.embedding.embed).mockRejectedValueOnce(
      new EmbeddingProviderError("provider_unavailable", true)
    );
    vi.mocked(configured.repository.fail).mockResolvedValueOnce({
      jobId: JOB_ID,
      replayed: false,
      state: "queued"
    });

    await createNoteIndexDrain(configured).drain(drainInput());

    expect(configured.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ retryDelaySeconds: delay })
    );
  });

  it("rejects a pre-aborted request before touching dependencies and releases the lock", async () => {
    const controller = new AbortController();
    controller.abort();
    const { options: configured } = options();
    const drain = createNoteIndexDrain(configured);

    await expect(drain.drain(drainInput(controller.signal))).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(configured.repository.preflight).not.toHaveBeenCalled();
    vi.mocked(configured.repository.claim).mockResolvedValueOnce({
      jobs: [],
      sourceEnvelopeByteBudget: 8_388_608,
      sourceEnvelopeBytes: 0
    });
    await expect(drain.drain(drainInput())).resolves.toMatchObject({ claimed: 0 });
  });

  it.each(["preflight", "recoverStale", "claim"] as const)(
    "propagates a %s dependency failure and releases the lock",
    async (method) => {
      const { options: configured } = options();
      vi.mocked(configured.repository[method]).mockRejectedValueOnce(
        new Error(`${method} unavailable`)
      );
      const drain = createNoteIndexDrain(configured);

      await expect(drain.drain(drainInput())).rejects.toThrow(`${method} unavailable`);
      expect(configured.embedding.embed).not.toHaveBeenCalled();
      vi.mocked(configured.repository.claim).mockResolvedValueOnce({
        jobs: [],
        sourceEnvelopeByteBudget: 8_388_608,
        sourceEnvelopeBytes: 0
      });
      await expect(drain.drain(drainInput())).resolves.toMatchObject({ claimed: 0 });
    }
  );

  it("propagates crypto dependency construction failure and releases the lock", async () => {
    const cryptoForAuthority = vi.fn((): IndexCryptoFactory => {
      throw new Error("crypto dependency unavailable");
    });
    const { options: configured } = options({ cryptoForAuthority });
    const drain = createNoteIndexDrain(configured);

    await expect(drain.drain(drainInput())).rejects.toThrow("crypto dependency unavailable");
    expect(configured.embedding.embed).not.toHaveBeenCalled();
    vi.mocked(configured.repository.claim).mockResolvedValueOnce({
      jobs: [],
      sourceEnvelopeByteBudget: 8_388_608,
      sourceEnvelopeBytes: 0
    });
    await expect(drain.drain(drainInput())).resolves.toMatchObject({ claimed: 0 });
  });

  it("never exceeds configured per-job concurrency", async () => {
    const claimed = ["W", "X", "Y", "Z"].map((suffix) =>
      job({ jobId: `ijob_${ULID.slice(0, -1)}${suffix}` })
    );
    const { options: configured } = options();
    vi.mocked(configured.repository.claim).mockResolvedValueOnce({
      jobs: claimed,
      sourceEnvelopeByteBudget: 8_388_608,
      sourceEnvelopeBytes: 512 * claimed.length
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    vi.mocked(configured.embedding.embed).mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return new Float32Array([0.1, 0.2, 0.3]);
    });

    const pending = createNoteIndexDrain(configured).drain(drainInput());
    await vi.waitFor(() => expect(configured.embedding.embed).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);
    release?.();

    await expect(pending).resolves.toEqual({
      claimed: 4,
      completed: 4,
      failed: 0,
      retryScheduled: 0
    });
    expect(maximumActive).toBe(2);
  });
});
