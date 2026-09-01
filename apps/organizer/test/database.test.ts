import { describe, expect, it } from "vitest";

import {
  ORGANIZER_IDENTITY_SQL,
  ORGANIZER_RPC_SQL,
  OrganizerDatabaseContractError,
  createOrganizerRepository,
  isAtomicOrganizerCommand,
  type OrganizerDatabaseExecutor,
  type OrganizerDatabaseQuery
} from "../src/database.js";
import { OrganizerUnavailableError } from "../src/errors.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JOB_ID = `job_${ULID}`;
const CAPTURE_ID = `cap_${ULID}`;
const NOTE_ID = `note_${ULID}` as const;
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEASE = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-31T20:00:00.000Z";
const controls = Object.freeze({ expansionDisabled: false, explicitDestinationNoteId: null });

function b64(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString("base64url");
}

function envelope(kind: "capture" | "note_content", resourceId: string, recordVersion: number) {
  return {
    version: 1,
    suite: "A256GCM",
    keyId: "ai_assisted.object_wrap.v1",
    context: { tenantId: OWNER_ID, resourceId, recordVersion, kind },
    wrappedDataKey: { nonce: b64(12, 1), ciphertext: b64(48, 2) },
    payload: { nonce: b64(12, 3), ciphertext: b64(16, 4) }
  };
}

function key(purpose: "content_mac" | "object_wrap" = "object_wrap") {
  return {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    keyClass: "ai_assisted",
    purpose,
    keyId: `ai_assisted.${purpose}.v1`,
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: "AQIDBA",
    rootKeyArn: `arn:aws:kms:us-west-2:123456789012:key/${purpose === "object_wrap" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"}`,
    createdAt: NOW,
    activatedAt: NOW,
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 2,
    wrapOperationLimit: 16_777_216,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    }
  };
}

function projection(kind: "capture" | "note_content", resourceId: string, recordVersion: number) {
  const value = envelope(kind, resourceId, recordVersion);
  return {
    resourceId,
    recordVersion,
    envelope: value,
    keyRecord: key(),
    encryptedByteLength: 16,
    serializedBytes: Buffer.byteLength(JSON.stringify(value))
  };
}

function claim(overrides: Record<string, unknown> = {}) {
  const source = projection("capture", CAPTURE_ID, 1);
  const { serializedBytes, ...sourceProjection } = source;
  return {
    jobs: [
      {
        attempt: 1,
        captureId: CAPTURE_ID,
        controls,
        jobId: JOB_ID,
        leaseExpiresAt: NOW,
        leaseToken: LEASE,
        ownerId: OWNER_ID,
        promptVersion: "organization-v1",
        replanCount: 0,
        schemaVersion: 1,
        source: sourceProjection,
        ...overrides
      }
    ],
    sourceEnvelopeBytes: serializedBytes,
    sourceEnvelopeByteBudget: 8_388_608
  };
}

function candidatePage(overrides: Record<string, unknown> = {}) {
  const aggregate = projection("note_content", NOTE_ID, 2);
  const { serializedBytes, ...aggregateProjection } = aggregate;
  return {
    jobId: JOB_ID,
    controls,
    candidates: [
      {
        candidateId: NOTE_ID,
        noteId: NOTE_ID,
        revision: 2,
        type: "list",
        metadata: { isOpen: true, spaceId: null, updatedAt: NOW },
        aggregate: aggregateProjection
      }
    ],
    returnedCount: 1,
    encryptedBytes: serializedBytes,
    encryptedByteBudget: 8_388_608,
    ...overrides
  };
}

function preparation(
  mode: "append" | "create" = "append",
  expectedRevision: number | null = 2,
  replanCount: 0 | 1 = 0
) {
  return {
    expectedRevision,
    ids: {
      decisionId: `dec_${ULID}`,
      mutationId: `mut_${ULID}`,
      reviewItemId: `rvw_${ULID}`,
      revisionId: `rev_${ULID}`
    },
    jobId: JOB_ID,
    keys: { contentMac: key("content_mac"), objectWrap: key() },
    mode,
    noteId: mode === "append" ? NOTE_ID : `note_${ULID}`,
    replanCount,
    replayed: false,
    reservations: {
      decision: { operationCount: 1, reservationId: "22222222-2222-4222-8222-222222222221" },
      noteWrite: { operationCount: 4, reservationId: "22222222-2222-4222-8222-222222222222" },
      receipt: { operationCount: 1, reservationId: "22222222-2222-4222-8222-222222222223" },
      review: { operationCount: 1, reservationId: "22222222-2222-4222-8222-222222222224" }
    },
    targetRevision: (expectedRevision ?? 0) + 1
  };
}

function rpc(result: unknown) {
  return { rows: [{ result }] };
}

function executor(
  responses: readonly unknown[]
): OrganizerDatabaseExecutor & { queries: OrganizerDatabaseQuery[] } {
  const queue = [...responses];
  const queries: OrganizerDatabaseQuery[] = [];
  return {
    queries,
    query(query) {
      queries.push(query);
      const next = queue.shift();
      if (next instanceof Error || (typeof next === "object" && next !== null && "throw" in next)) {
        if (next instanceof Error) return Promise.reject(next);
        const injected = new Error("injected database failure");
        if (typeof next.throw === "object" && next.throw !== null && "code" in next.throw) {
          Object.assign(injected, { code: next.throw.code });
        }
        return Promise.reject(injected);
      }
      return Promise.resolve(next as { rows: readonly unknown[] });
    }
  };
}

const signal = new AbortController().signal;
const command = Object.freeze({
  decision: { sealed: true },
  noteWrite: { sealed: true },
  outcome: "appended" as const,
  receipt: { sealed: true },
  review: { sealed: true },
  reviewReason: null
});

describe("organizer database adapter", () => {
  it("uses only the exact role and eight text-token RPC contracts end to end", async () => {
    const db = executor([
      {
        rows: [{ sessionUser: "unfiled_organizer_worker", currentUser: "unfiled_organizer_worker" }]
      },
      rpc(claim()),
      rpc(candidatePage()),
      rpc({
        candidateCount: 1,
        currentRevision: 1,
        disclosureAuthorized: true,
        jobId: JOB_ID,
        leaseExpiresAt: NOW,
        outcome: "authorized",
        replanCount: 0
      }),
      rpc({ outcome: "prepared", preparation: preparation() }),
      rpc({
        jobId: JOB_ID,
        noteId: NOTE_ID,
        outcome: "appended",
        replayed: false,
        revision: 3,
        replanCount: 0
      })
    ]);
    const repository = createOrganizerRepository(db);
    await repository.preflight(signal);
    const jobs = await repository.claim({
      leaseSeconds: 120,
      limit: 1,
      signal,
      workerId: "worker-1"
    });
    const page = await repository.candidates({
      jobId: JOB_ID,
      leaseToken: LEASE,
      limit: 8,
      signal
    });
    await expect(
      repository.heartbeat({
        candidateManifest: {
          candidates: page.candidates.map(({ candidateId, isOpen, noteId, revision }) => ({
            candidateId,
            isOpen,
            noteId,
            revision
          })),
          controls: page.controls
        },
        jobId: JOB_ID,
        leaseSeconds: 120,
        leaseToken: LEASE,
        signal
      })
    ).resolves.toMatchObject({ outcome: "authorized" });
    await expect(
      repository.prepareAppend({
        expectedRevision: 2,
        jobId: JOB_ID,
        leaseToken: LEASE,
        noteId: NOTE_ID,
        reservationId: "22222222-2222-4222-8222-222222222222",
        signal
      })
    ).resolves.toMatchObject({ outcome: "prepared" });
    await expect(
      repository.commit({ command, jobId: JOB_ID, leaseToken: LEASE, signal })
    ).resolves.toMatchObject({ outcome: "appended", revision: 3 });
    expect(jobs[0]).toMatchObject({ controls, ownerId: OWNER_ID });
    expect(page.candidates[0]).toMatchObject({ isOpen: true, revision: 2 });
    expect(db.queries.map(({ text }) => text)).toEqual([
      ORGANIZER_IDENTITY_SQL,
      ORGANIZER_RPC_SQL.claim,
      ORGANIZER_RPC_SQL.candidates,
      ORGANIZER_RPC_SQL.heartbeat,
      ORGANIZER_RPC_SQL.prepareAppend,
      ORGANIZER_RPC_SQL.commit
    ]);
    expect(ORGANIZER_RPC_SQL.heartbeat).toContain("$2::text");
    expect(ORGANIZER_RPC_SQL.heartbeat).toContain("$4::jsonb");
  });

  it("parses replan, review-required, fail, and exact recovery results", async () => {
    const db = executor([
      rpc(claim()),
      rpc(candidatePage()),
      rpc({
        conflictReason: "revision",
        jobId: JOB_ID,
        noteId: NOTE_ID,
        outcome: "replan",
        replayed: false,
        revision: 3,
        replanCount: 1
      }),
      rpc({
        conflictReason: "candidate_eligibility",
        jobId: JOB_ID,
        noteId: NOTE_ID,
        outcome: "replan",
        replayed: false,
        revision: null,
        replanCount: 1
      }),
      rpc({
        conflictReason: "consent_controls",
        jobId: JOB_ID,
        noteId: null,
        outcome: "review_required",
        replayed: false,
        revision: null,
        replanCount: 1
      }),
      rpc({ jobId: JOB_ID, replayed: false, state: "awaiting_retry" }),
      rpc({ recoveredCount: 2, requeuedCount: 1, deadLetteredCount: 1 })
    ]);
    const repository = createOrganizerRepository(db);
    await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    const page = await repository.candidates({
      jobId: JOB_ID,
      leaseToken: LEASE,
      limit: 8,
      signal
    });
    await expect(
      repository.heartbeat({
        candidateManifest: {
          candidates: page.candidates.map(({ candidateId, isOpen, noteId, revision }) => ({
            candidateId,
            isOpen,
            noteId,
            revision
          })),
          controls
        },
        jobId: JOB_ID,
        leaseSeconds: 120,
        leaseToken: LEASE,
        signal
      })
    ).resolves.toMatchObject({ outcome: "replan", conflictReason: "revision" });
    await expect(
      repository.commit({ command, jobId: JOB_ID, leaseToken: LEASE, signal })
    ).resolves.toMatchObject({
      outcome: "replan",
      conflictReason: "candidate_eligibility",
      revision: null
    });
    await expect(
      repository.commit({ command, jobId: JOB_ID, leaseToken: LEASE, signal })
    ).resolves.toMatchObject({ outcome: "review_required", conflictReason: "consent_controls" });
    await expect(
      repository.fail({
        errorCode: "provider_unavailable",
        jobId: JOB_ID,
        leaseToken: LEASE,
        retryable: true,
        signal
      })
    ).resolves.toEqual({ state: "awaiting_retry" });
    await expect(repository.recoverStale(2, signal)).resolves.toEqual({
      recoveredCount: 2,
      requeuedCount: 1,
      deadLetteredCount: 1
    });
  });

  it("parses the exact SQL append replan and create-mode Review unions", async () => {
    const db = executor([
      rpc(claim()),
      rpc({
        conflictReason: "candidate_eligibility",
        jobId: JOB_ID,
        noteId: NOTE_ID,
        outcome: "replan",
        replayed: false,
        revision: null,
        replanCount: 1
      }),
      rpc({
        conflictReason: "candidate_eligibility",
        outcome: "review",
        preparation: preparation("create", null, 1)
      })
    ]);
    const repository = createOrganizerRepository(db);
    await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    await expect(
      repository.prepareAppend({
        expectedRevision: 2,
        jobId: JOB_ID,
        leaseToken: LEASE,
        noteId: NOTE_ID,
        reservationId: "22222222-2222-4222-8222-222222222222",
        signal
      })
    ).resolves.toMatchObject({
      conflictReason: "candidate_eligibility",
      noteId: NOTE_ID,
      outcome: "replan",
      revision: null
    });
    await expect(
      repository.prepareAppend({
        expectedRevision: 2,
        jobId: JOB_ID,
        leaseToken: LEASE,
        noteId: NOTE_ID,
        reservationId: "22222222-2222-4222-8222-222222222222",
        signal
      })
    ).resolves.toMatchObject({
      conflictReason: "candidate_eligibility",
      outcome: "review",
      preparation: { mode: "create", expectedRevision: null, replanCount: 1 }
    });
  });

  it("parses SQL heartbeat conflicts with a note ID and nullable revision", async () => {
    for (const conflict of [
      {
        conflictReason: "consent_controls",
        jobId: JOB_ID,
        noteId: NOTE_ID,
        outcome: "replan",
        replayed: false,
        revision: null,
        replanCount: 1
      },
      {
        conflictReason: "candidate_eligibility",
        jobId: JOB_ID,
        noteId: NOTE_ID,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 1
      }
    ] as const) {
      const repository = createOrganizerRepository(
        executor([rpc(claim()), rpc(candidatePage()), rpc(conflict)])
      );
      await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
      const page = await repository.candidates({
        jobId: JOB_ID,
        leaseToken: LEASE,
        limit: 8,
        signal
      });
      await expect(
        repository.heartbeat({
          candidateManifest: {
            candidates: page.candidates.map(({ candidateId, isOpen, noteId, revision }) => ({
              candidateId,
              isOpen,
              noteId,
              revision
            })),
            controls
          },
          jobId: JOB_ID,
          leaseSeconds: 120,
          leaseToken: LEASE,
          signal
        })
      ).resolves.toMatchObject(conflict);
    }
  });

  it("rejects legacy or widened conflict response shapes", async () => {
    const widenedReview = createOrganizerRepository(
      executor([
        rpc(claim()),
        rpc({
          conflictReason: "candidate_eligibility",
          noteId: null,
          outcome: "review",
          preparation: preparation("create", null, 1),
          revision: null
        })
      ])
    );
    await widenedReview.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    await expect(
      widenedReview.prepareAppend({
        expectedRevision: 2,
        jobId: JOB_ID,
        leaseToken: LEASE,
        noteId: NOTE_ID,
        reservationId: "22222222-2222-4222-8222-222222222222",
        signal
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);

    const missingCommitReason = createOrganizerRepository(
      executor([
        rpc(claim()),
        rpc({
          jobId: JOB_ID,
          noteId: NOTE_ID,
          outcome: "replan",
          replayed: false,
          revision: 3,
          replanCount: 1
        })
      ])
    );
    await missingCommitReason.claim({
      leaseSeconds: 120,
      limit: 1,
      signal,
      workerId: "worker-1"
    });
    await expect(
      missingCommitReason.commit({ command, jobId: JOB_ID, leaseToken: LEASE, signal })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
  });

  it("rejects identity drift, forged manifests, malformed projections, and response drift", async () => {
    const wrongIdentity = createOrganizerRepository(
      executor([{ rows: [{ sessionUser: "postgres", currentUser: "postgres" }] }])
    );
    await expect(wrongIdentity.preflight(signal)).rejects.toMatchObject({
      code: "identity_denied"
    });

    const malformed = claim({
      source: { ...projection("capture", CAPTURE_ID, 1), encryptedByteLength: 15 }
    });
    const malformedRepository = createOrganizerRepository(executor([rpc(malformed)]));
    await expect(
      malformedRepository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);

    const db = executor([rpc(claim()), rpc(candidatePage())]);
    const repository = createOrganizerRepository(db);
    await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    const page = await repository.candidates({
      jobId: JOB_ID,
      leaseToken: LEASE,
      limit: 8,
      signal
    });
    await expect(
      repository.heartbeat({
        candidateManifest: {
          candidates: page.candidates.map(({ candidateId, isOpen, noteId, revision }) => ({
            candidateId,
            isOpen: !isOpen,
            noteId,
            revision
          })),
          controls
        },
        jobId: JOB_ID,
        leaseSeconds: 120,
        leaseToken: LEASE,
        signal
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
  });

  it("releases claim and candidate state locally without another database call", async () => {
    const db = executor([rpc(claim()), rpc(candidatePage())]);
    const repository = createOrganizerRepository(db);
    await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    const page = await repository.candidates({
      jobId: JOB_ID,
      leaseToken: LEASE,
      limit: 8,
      signal
    });
    repository.release(JOB_ID);

    await expect(
      repository.heartbeat({
        candidateManifest: {
          candidates: page.candidates.map(({ candidateId, isOpen, noteId, revision }) => ({
            candidateId,
            isOpen,
            noteId,
            revision
          })),
          controls
        },
        jobId: JOB_ID,
        leaseSeconds: 120,
        leaseToken: LEASE,
        signal
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
    expect(db.queries).toHaveLength(2);
  });

  it("classifies transport/deadlock errors as retryable and business errors as nonretryable", async () => {
    for (const code of ["08006", "40001", "40P01", "57014"]) {
      const repository = createOrganizerRepository(executor([{ throw: { code } }]));
      await expect(
        repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" })
      ).rejects.toBeInstanceOf(OrganizerUnavailableError);
    }
    const repository = createOrganizerRepository(executor([{ throw: { code: "42501" } }]));
    await expect(
      repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
  });

  it("validates atomic command reason pairing and bounds", () => {
    expect(isAtomicOrganizerCommand(command)).toBe(true);
    expect(isAtomicOrganizerCommand({ ...command, reviewReason: "revision_conflict" })).toBe(false);
    expect(
      isAtomicOrganizerCommand({
        ...command,
        noteWrite: null,
        outcome: "review",
        reviewReason: "expansion_pending"
      })
    ).toBe(true);
    expect(isAtomicOrganizerCommand({ ...command, extra: true })).toBe(false);
  });
});
