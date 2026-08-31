import { describe, expect, it } from "vitest";

import {
  IndexDatabaseContractError,
  NOTE_INDEX_RPC_NAMES,
  createNoteIndexRepository,
  type CommitNoteRagIndexInput,
  type ContentEnvelopeV1,
  type IndexDatabaseQuery,
  type IndexDatabaseQueryExecutor,
  type IndexDatabaseQueryResult,
  type ListActiveNoteRagIndexInput
} from "../src/index-database";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ULID = "01J6M9Q7G4BMKB33GSG3NJ6D1X";
const JOB_ID = `ijob_${ULID}`;
const NOTE_ID = `note_${ULID}`;
const GENERATION_ID = `igen_${ULID}`;
const INDEX_ID = `irw_${ULID}`;
const SPACE_ID = `spc_${ULID}`;
const LEASE_TOKEN = "11111111-1111-4111-8111-111111111111";
const RESERVATION_ID = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "ai_assisted.object_wrap.v1";
const CREATED_AT_DATABASE = "2026-08-30T12:00:00+00:00";
const CREATED_AT = "2026-08-30T12:00:00.000Z";

function base64(bytes: number, seed: number): string {
  return Buffer.alloc(bytes, seed).toString("base64url");
}

function envelope(
  kind: "note_content" | "note_rag_index",
  resourceId: string,
  recordVersion: number,
  payloadBytes = 16,
  ownerId = OWNER_ID,
  keyId = KEY_ID
): ContentEnvelopeV1 {
  return {
    version: 1,
    suite: "A256GCM",
    keyId,
    context: { tenantId: ownerId, resourceId, recordVersion, kind },
    wrappedDataKey: { nonce: base64(12, 1), ciphertext: base64(48, 2) },
    payload: { nonce: base64(12, 3), ciphertext: base64(payloadBytes, 4) }
  };
}

function managedKey(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    keyClass: "ai_assisted",
    purpose: "object_wrap",
    keyId: KEY_ID,
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: "AQIDBA",
    rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
    createdAt: CREATED_AT_DATABASE,
    activatedAt: CREATED_AT_DATABASE,
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 2,
    wrapOperationLimit: 16_777_216,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    },
    ...overrides
  };
}

function claimJob(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    jobId: JOB_ID,
    userId: OWNER_ID,
    noteId: NOTE_ID,
    generationId: GENERATION_ID,
    targetRevision: 3,
    indexResourceId: INDEX_ID,
    noteType: "list",
    spaceId: SPACE_ID,
    isOpen: true,
    pinnedAt: null,
    updatedAt: CREATED_AT_DATABASE,
    attempt: 1,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: "2026-08-30T12:01:00+00:00",
    sourceNoteCipher: {
      envelope: envelope("note_content", NOTE_ID, 3, 64),
      keyId: KEY_ID,
      keyClass: "ai_assisted",
      keyPurpose: "object_wrap",
      keyVersion: 1
    },
    sourceEnvelopeBytes: 512,
    sourceKey: managedKey(),
    targetKey: managedKey(),
    embeddingModelId: "text-embedding-3-small",
    embeddingDimensions: 1_536,
    generationRevisionToken: 7,
    reservation: {
      reservationId: RESERVATION_ID,
      keyId: KEY_ID,
      keyClass: "ai_assisted",
      keyPurpose: "object_wrap",
      keyVersion: 1,
      operationCount: 1,
      consumed: false
    },
    ...overrides
  };
}

function claimResult(job: Record<string, unknown> = claimJob()): Record<string, unknown> {
  return {
    jobs: [job],
    sourceEnvelopeBytes: 512,
    sourceEnvelopeByteBudget: 8_388_608
  };
}

function identityResult(
  sessionUser = "unfiled_index_worker",
  currentUser = "unfiled_index_worker"
): IndexDatabaseQueryResult {
  return { rows: [{ sessionUser, currentUser }] };
}

function rpcResult(result: unknown): IndexDatabaseQueryResult {
  return { rows: [{ result }] };
}

type QueuedResponse =
  IndexDatabaseQueryResult | ((query: IndexDatabaseQuery) => IndexDatabaseQueryResult);

function queuedExecutor(responses: readonly QueuedResponse[]): Readonly<{
  executor: IndexDatabaseQueryExecutor;
  calls: IndexDatabaseQuery[];
}> {
  const queue = [...responses];
  const calls: IndexDatabaseQuery[] = [];
  const executor: IndexDatabaseQueryExecutor = {
    query(query) {
      calls.push(query);
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected query");
      return Promise.resolve(typeof next === "function" ? next(query) : next);
    }
  };
  return { executor, calls };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function emptyListResult(): Record<string, unknown> {
  return {
    ownerId: OWNER_ID,
    generation: null,
    coverage: {
      expectedNoteCount: 0,
      indexedNoteCount: 0,
      eligibleNoteCount: 0,
      coveredNoteCount: 0,
      repairCount: 0,
      repairLimitExceeded: false,
      repairCandidates: [],
      pendingJobCount: 0,
      verified: false,
      complete: false
    },
    items: [],
    keys: [],
    page: {
      limit: 25,
      ciphertextByteBudget: 1_048_576,
      returnedCount: 0,
      ciphertextBytes: 0,
      hasMore: false,
      nextCursor: null
    }
  };
}

function listInput(
  overrides: Partial<ListActiveNoteRagIndexInput> = {}
): ListActiveNoteRagIndexInput {
  return {
    ownerId: OWNER_ID,
    cursor: null,
    limit: 25,
    ciphertextByteBudget: 1_048_576,
    signal: signal(),
    ...overrides
  };
}

function commitInput(overrides: Partial<CommitNoteRagIndexInput> = {}): CommitNoteRagIndexInput {
  return {
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    indexId: INDEX_ID,
    indexEnvelope: envelope("note_rag_index", INDEX_ID, 3),
    indexKeyId: KEY_ID,
    indexKeyClass: "ai_assisted",
    indexKeyPurpose: "object_wrap",
    indexKeyVersion: 1,
    reservationId: RESERVATION_ID,
    encryptedByteLength: 16,
    signal: signal(),
    ...overrides
  };
}

describe("note index database capability", () => {
  it("requires the exact non-bypass session and current role", async () => {
    for (const identity of [
      identityResult("service_role", "service_role"),
      identityResult("unfiled_index_worker", "postgres"),
      identityResult("postgres", "unfiled_index_worker")
    ]) {
      const { executor, calls } = queuedExecutor([identity]);
      const repository = createNoteIndexRepository(executor);

      await expect(repository.preflight(signal())).rejects.toMatchObject({
        code: "identity_denied"
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("uses only the six allowlisted RPCs, content-free preflights, and unnamed queries", async () => {
    const responses = [
      identityResult(),
      rpcResult({ recoveredCount: 0, failedCount: 0 }),
      identityResult(),
      rpcResult({ jobs: [], sourceEnvelopeBytes: 0, sourceEnvelopeByteBudget: 8_388_608 }),
      identityResult(),
      rpcResult({ jobId: JOB_ID, leaseExpiresAt: CREATED_AT_DATABASE, disclosureAuthorized: true }),
      identityResult(),
      rpcResult({
        jobId: JOB_ID,
        indexId: INDEX_ID,
        reservationId: RESERVATION_ID,
        generationRevisionToken: 8,
        committed: true,
        replayed: false
      }),
      identityResult(),
      rpcResult({ jobId: JOB_ID, state: "queued", replayed: false }),
      identityResult(),
      rpcResult(emptyListResult())
    ];
    const { executor, calls } = queuedExecutor(responses);
    const repository = createNoteIndexRepository(executor);

    await repository.recoverStale(100, signal());
    await repository.claim({
      workerId: "index-worker-1",
      limit: 10,
      leaseSeconds: 60,
      signal: signal()
    });
    await repository.heartbeat({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      leaseSeconds: 60,
      signal: signal()
    });
    await repository.commit(commitInput());
    await repository.fail({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      errorCode: "provider_unavailable",
      retryable: true,
      retryDelaySeconds: 30,
      signal: signal()
    });
    await repository.listActive(listInput());

    expect(calls).toHaveLength(12);
    const rpcCalls = calls.filter((_, index) => index % 2 === 1);
    expect(rpcCalls.map((call) => /public\.([a-z_]+)/u.exec(call.text)?.[1])).toEqual(
      NOTE_INDEX_RPC_NAMES.slice().sort((left, right) => {
        const invocationOrder = [
          "recover_stale_note_index_jobs",
          "claim_note_index_jobs",
          "heartbeat_note_index_job",
          "commit_note_rag_index",
          "fail_note_index_job",
          "list_active_note_rag_index"
        ];
        return invocationOrder.indexOf(left) - invocationOrder.indexOf(right);
      })
    );
    for (const [index, call] of calls.entries()) {
      expect(Object.keys(call).sort()).toEqual(["signal", "text", "values"]);
      expect(call.text).not.toMatch(/\b(?:insert|update|delete|set\s+role|from\s+public\.)\b/iu);
      if (index % 2 === 0) {
        expect(call.text).toBe(
          'select session_user::text as "sessionUser", current_user::text as "currentUser"'
        );
        expect(call.values).toEqual([]);
      }
    }
    expect(new Set(rpcCalls.map((call) => /public\.([a-z_]+)/u.exec(call.text)?.[1])).size).toBe(6);
  });

  it("strictly parses and cross-checks a claimed encrypted job", async () => {
    const { executor } = queuedExecutor([identityResult(), rpcResult(claimResult())]);
    const result = await createNoteIndexRepository(executor).claim({
      workerId: "index-worker-1",
      limit: 1,
      leaseSeconds: 60,
      signal: signal()
    });

    expect(result.sourceEnvelopeBytes).toBe(512);
    expect(result.jobs[0]).toMatchObject({
      jobId: JOB_ID,
      userId: OWNER_ID,
      noteId: NOTE_ID,
      sourceKey: { createdAt: CREATED_AT, keyClass: "ai_assisted", purpose: "object_wrap" },
      targetKey: { ownerId: OWNER_ID, status: "active" },
      reservation: { reservationId: RESERVATION_ID, operationCount: 1, consumed: false }
    });
  });

  it("rejects unknown response keys, mismatched byte totals, and crossed key ownership", async () => {
    const invalidResults = [
      { ...claimResult(), unexpected: true },
      { ...claimResult(), sourceEnvelopeBytes: 511 },
      claimResult(claimJob({ targetKey: managedKey({ ownerId: OTHER_OWNER_ID }) })),
      claimResult(
        claimJob({
          sourceNoteCipher: {
            ...(claimJob().sourceNoteCipher as Record<string, unknown>),
            extra: "not-allowed"
          }
        })
      )
    ];

    for (const invalid of invalidResults) {
      const { executor } = queuedExecutor([identityResult(), rpcResult(invalid)]);
      await expect(
        createNoteIndexRepository(executor).claim({
          workerId: "index-worker-1",
          limit: 1,
          leaseSeconds: 60,
          signal: signal()
        })
      ).rejects.toBeInstanceOf(IndexDatabaseContractError);
    }
  });

  it("validates input bounds before touching the database", async () => {
    const { executor, calls } = queuedExecutor([]);
    const repository = createNoteIndexRepository(executor);

    await expect(
      repository.claim({ workerId: "index-worker-1", limit: 0, leaseSeconds: 60, signal: signal() })
    ).rejects.toBeInstanceOf(IndexDatabaseContractError);
    await expect(repository.recoverStale(1_001, signal())).rejects.toBeInstanceOf(
      IndexDatabaseContractError
    );
    await expect(
      repository.fail({
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        errorCode: "plaintext-secret" as never,
        retryable: true,
        retryDelaySeconds: 30,
        signal: signal()
      })
    ).rejects.toBeInstanceOf(IndexDatabaseContractError);
    expect(calls).toHaveLength(0);
  });

  it("propagates aborts before a query and between identity and RPC execution", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new DOMException("stop", "AbortError"));
    const first = queuedExecutor([]);
    await expect(
      createNoteIndexRepository(first.executor).preflight(alreadyAborted.signal)
    ).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(first.calls).toHaveLength(0);

    const duringPreflight = new AbortController();
    const second = queuedExecutor([
      () => {
        duringPreflight.abort(new DOMException("stop", "AbortError"));
        return identityResult();
      }
    ]);
    await expect(
      createNoteIndexRepository(second.executor).recoverStale(100, duringPreflight.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(second.calls).toHaveLength(1);
  });

  it("accepts exact heartbeat, commit, fail, and recovery variants", async () => {
    const heartbeat = queuedExecutor([
      identityResult(),
      rpcResult({ jobId: JOB_ID, leaseExpiresAt: CREATED_AT_DATABASE, disclosureAuthorized: true })
    ]);
    await expect(
      createNoteIndexRepository(heartbeat.executor).heartbeat({
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        leaseSeconds: 60,
        signal: signal()
      })
    ).resolves.toEqual({ jobId: JOB_ID, leaseExpiresAt: CREATED_AT, disclosureAuthorized: true });

    for (const result of [
      {
        jobId: JOB_ID,
        indexId: INDEX_ID,
        reservationId: RESERVATION_ID,
        generationRevisionToken: 9,
        committed: true,
        replayed: false
      },
      {
        jobId: JOB_ID,
        indexId: INDEX_ID,
        reservationId: RESERVATION_ID,
        committed: true,
        replayed: true
      },
      { jobId: JOB_ID, committed: false, errorCode: "stale_revision", replayed: false }
    ]) {
      const queued = queuedExecutor([identityResult(), rpcResult(result)]);
      await expect(
        createNoteIndexRepository(queued.executor).commit(commitInput())
      ).resolves.toMatchObject(result);
    }

    const failure = queuedExecutor([
      identityResult(),
      rpcResult({ jobId: JOB_ID, state: "failed", replayed: true })
    ]);
    await expect(
      createNoteIndexRepository(failure.executor).fail({
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        errorCode: "validation_failed",
        retryable: false,
        retryDelaySeconds: 0,
        signal: signal()
      })
    ).resolves.toEqual({ jobId: JOB_ID, state: "failed", replayed: true });

    const recovery = queuedExecutor([
      identityResult(),
      rpcResult({ recoveredCount: 3, failedCount: 2 })
    ]);
    await expect(
      createNoteIndexRepository(recovery.executor).recoverStale(100, signal())
    ).resolves.toEqual({
      recoveredCount: 3,
      failedCount: 2
    });
  });

  it("rejects non-exact transition results and mismatched commit bindings", async () => {
    const invalidOperations: readonly (() => Promise<unknown>)[] = [
      () => {
        const queued = queuedExecutor([
          identityResult(),
          rpcResult({
            jobId: JOB_ID,
            leaseExpiresAt: CREATED_AT_DATABASE,
            disclosureAuthorized: true,
            extra: true
          })
        ]);
        return createNoteIndexRepository(queued.executor).heartbeat({
          jobId: JOB_ID,
          leaseToken: LEASE_TOKEN,
          leaseSeconds: 60,
          signal: signal()
        });
      },
      () => {
        const queued = queuedExecutor([
          identityResult(),
          rpcResult({
            jobId: JOB_ID,
            indexId: INDEX_ID,
            reservationId: LEASE_TOKEN,
            committed: true,
            replayed: true
          })
        ]);
        return createNoteIndexRepository(queued.executor).commit(commitInput());
      },
      () => {
        const queued = queuedExecutor([
          identityResult(),
          rpcResult({ jobId: JOB_ID, state: "queued", replayed: false, error: "secret" })
        ]);
        return createNoteIndexRepository(queued.executor).fail({
          jobId: JOB_ID,
          leaseToken: LEASE_TOKEN,
          errorCode: "provider_unavailable",
          retryable: true,
          retryDelaySeconds: 30,
          signal: signal()
        });
      },
      () => {
        const queued = queuedExecutor([
          identityResult(),
          rpcResult({ recoveredCount: 0, failedCount: 0, extra: true })
        ]);
        return createNoteIndexRepository(queued.executor).recoverStale(100, signal());
      }
    ];

    for (const operation of invalidOperations) {
      await expect(operation()).rejects.toBeInstanceOf(IndexDatabaseContractError);
    }
  });

  it("strictly validates an active encrypted index page and its key set", async () => {
    const active = {
      ownerId: OWNER_ID,
      generation: {
        generationId: GENERATION_ID,
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1_536,
        envelopeSchemaVersion: 1,
        revisionToken: 12
      },
      coverage: {
        expectedNoteCount: 1,
        indexedNoteCount: 1,
        eligibleNoteCount: 1,
        coveredNoteCount: 1,
        repairCount: 0,
        repairLimitExceeded: false,
        repairCandidates: [],
        pendingJobCount: 0,
        verified: true,
        complete: true
      },
      items: [
        {
          indexId: INDEX_ID,
          noteId: NOTE_ID,
          indexedRevision: 3,
          cipher: {
            envelope: envelope("note_rag_index", INDEX_ID, 3),
            keyId: KEY_ID,
            keyClass: "ai_assisted",
            keyPurpose: "object_wrap",
            keyVersion: 1
          },
          encryptedByteLength: 16
        }
      ],
      keys: [managedKey()],
      page: {
        limit: 25,
        ciphertextByteBudget: 1_048_576,
        returnedCount: 1,
        ciphertextBytes: 16,
        hasMore: true,
        nextCursor: {
          generationId: GENERATION_ID,
          revisionToken: 12,
          afterIndexId: INDEX_ID
        }
      }
    };
    const { executor } = queuedExecutor([identityResult(), rpcResult(active)]);
    const result = await createNoteIndexRepository(executor).listActive(listInput());

    expect(result.generation).toMatchObject({ generationId: GENERATION_ID, revisionToken: 12 });
    expect(result.items[0]?.cipher.envelope.context.kind).toBe("note_rag_index");
    expect(result.keys[0]?.createdAt).toBe(CREATED_AT);
    expect(result.page.nextCursor?.afterIndexId).toBe(INDEX_ID);
  });

  it("rejects list pages with unknown keys, byte mismatches, or unbound managed keys", async () => {
    const invalidPages = [
      { ...emptyListResult(), extra: true },
      {
        ...emptyListResult(),
        page: { ...(emptyListResult().page as Record<string, unknown>), ciphertextBytes: 1 }
      },
      {
        ...emptyListResult(),
        keys: [managedKey()],
        generation: {
          generationId: GENERATION_ID,
          embeddingModelId: "text-embedding-3-small",
          embeddingDimensions: 1_536,
          envelopeSchemaVersion: 1,
          revisionToken: 0
        }
      }
    ];

    for (const invalid of invalidPages) {
      const { executor } = queuedExecutor([identityResult(), rpcResult(invalid)]);
      await expect(
        createNoteIndexRepository(executor).listActive(listInput())
      ).rejects.toBeInstanceOf(IndexDatabaseContractError);
    }
  });
});
