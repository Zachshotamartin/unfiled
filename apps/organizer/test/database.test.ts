import { UtcInstantSchema } from "@unfiled/contracts";
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
const SECOND_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const JOB_ID = `job_${ULID}`;
const CAPTURE_ID = `cap_${ULID}`;
const NOTE_ID = `note_${ULID}` as const;
const SECOND_NOTE_ID = `note_${SECOND_ULID}` as const;
const INDEX_ID = `irw_${ULID}`;
const SECOND_INDEX_ID = `irw_${SECOND_ULID}`;
const GENERATION_ID = `igen_${ULID}`;
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEASE = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-31T20:00:00.000Z";
const POSTGRES_OFFSET_TIMESTAMP = "2026-09-01T01:30:00.123456+05:30";
const CANONICAL_OFFSET_TIMESTAMP = "2026-08-31T20:00:00.123456Z";
const controls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: null
});
const RAG_PAGE_BYTES = 262_160;
const ragSnapshot = Object.freeze({
  dimensions: 3,
  expectedNoteCount: 2,
  generationId: GENERATION_ID,
  indexedNoteCount: 2,
  modelId: "text-embedding-3-small",
  revisionToken: "7"
});

function b64(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString("base64url");
}

function envelope(
  kind: "capture" | "note_content" | "note_rag_index",
  resourceId: string,
  recordVersion: number
) {
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

function projection(
  kind: "capture" | "note_content" | "note_rag_index",
  resourceId: string,
  recordVersion: number
) {
  const value = envelope(kind, resourceId, recordVersion);
  const base = {
    resourceId,
    recordVersion,
    envelope: value,
    keyRecord: key(),
    encryptedByteLength: 16,
    serializedBytes: Buffer.byteLength(JSON.stringify(value))
  };
  return kind === "capture"
    ? {
        ...base,
        contentMac: {
          mac: "a".repeat(64),
          keyId: "ai_assisted.content_mac.v1",
          keyClass: "ai_assisted",
          keyPurpose: "content_mac",
          keyVersion: 1
        },
        contentMacKeyRecord: key("content_mac")
      }
    : base;
}

function claim(overrides: Record<string, unknown> = {}) {
  const source = projection("capture", CAPTURE_ID, 1);
  const { serializedBytes, ...sourceProjection } = source;
  return {
    jobs: [
      {
        accountCaptureOrdinal: 6,
        attempt: 1,
        captureId: CAPTURE_ID,
        clientTimezone: "UTC",
        controls,
        jobId: JOB_ID,
        leaseExpiresAt: NOW,
        leaseToken: LEASE,
        modelId: "gpt-5.4-mini-2026-03-17",
        occurredAt: NOW,
        ownerId: OWNER_ID,
        promptVersion: "organization-v1",
        replanCount: 0,
        routingMode: "balanced",
        schemaVersion: 1,
        source: sourceProjection,
        commandProjection: "encrypted_only",
        ...overrides
      }
    ],
    sourceEnvelopeBytes: serializedBytes,
    sourceEnvelopeByteBudget: 8_388_608
  };
}

function candidateEntry(
  noteId: typeof NOTE_ID | typeof SECOND_NOTE_ID,
  revision: number,
  updatedAt = NOW
) {
  const aggregate = projection("note_content", noteId, revision);
  const { serializedBytes, ...aggregateProjection } = aggregate;
  return {
    candidate: {
      candidateId: noteId,
      noteId,
      revision,
      type: "list",
      metadata: {
        archivedAt: null,
        dailyDate: null,
        deletedAt: null,
        isOpen: true,
        links: [],
        pinnedAt: null,
        spaceId: null,
        tagIds: [],
        updatedAt
      },
      aggregate: aggregateProjection
    },
    serializedBytes
  };
}

function candidatePage(overrides: Record<string, unknown> = {}) {
  const { candidate, serializedBytes } = candidateEntry(NOTE_ID, 2);
  return {
    jobId: JOB_ID,
    controls,
    candidates: [candidate],
    returnedCount: 1,
    encryptedBytes: serializedBytes,
    encryptedByteBudget: 8_388_608,
    ...overrides
  };
}

function ragItem(
  indexId: typeof INDEX_ID | typeof SECOND_INDEX_ID,
  noteId: typeof NOTE_ID | typeof SECOND_NOTE_ID,
  indexedRevision: number
) {
  const record = projection("note_rag_index", indexId, indexedRevision);
  return {
    cipher: {
      envelope: record.envelope,
      keyClass: "ai_assisted",
      keyId: record.keyRecord.keyId,
      keyPurpose: "object_wrap",
      keyVersion: record.keyRecord.keyVersion
    },
    encryptedByteLength: record.encryptedByteLength,
    indexId,
    indexedRevision,
    noteId
  };
}

function ragPageResult(
  items: readonly ReturnType<typeof ragItem>[],
  options: Readonly<{
    hasMore?: boolean;
    limit?: number;
    maxBytes?: number;
    overrides?: Record<string, unknown>;
  }> = {}
) {
  const hasMore = options.hasMore ?? false;
  const last = items.at(-1);
  return {
    jobId: JOB_ID,
    result: {
      coverage: {
        complete: true,
        coveredNoteCount: 2,
        eligibleNoteCount: 2,
        expectedNoteCount: 2,
        indexedNoteCount: 2,
        pendingJobCount: 0,
        repairCandidates: [],
        repairCount: 0,
        repairLimitExceeded: false,
        verified: true
      },
      generation: {
        embeddingDimensions: ragSnapshot.dimensions,
        embeddingModelId: ragSnapshot.modelId,
        envelopeSchemaVersion: 1,
        generationId: ragSnapshot.generationId,
        revisionToken: Number(ragSnapshot.revisionToken)
      },
      items,
      keys: items.length === 0 ? [] : [key()],
      ownerId: OWNER_ID,
      page: {
        ciphertextByteBudget: options.maxBytes ?? RAG_PAGE_BYTES,
        ciphertextBytes: items.reduce((sum, item) => sum + item.encryptedByteLength, 0),
        hasMore,
        limit: options.limit ?? 1,
        nextCursor:
          hasMore && last !== undefined
            ? {
                afterIndexId: last.indexId,
                generationId: ragSnapshot.generationId,
                revisionToken: Number(ragSnapshot.revisionToken)
              }
            : null,
        returnedCount: items.length
      },
      ...options.overrides
    }
  };
}

function selectedCandidatePage(
  entries: readonly ReturnType<typeof candidateEntry>[],
  overrides: Record<string, unknown> = {}
) {
  return {
    candidates: entries.map(({ candidate }) => candidate),
    controls,
    encryptedByteBudget: 8_388_608,
    encryptedBytes: entries.reduce((sum, entry) => sum + entry.serializedBytes, 0),
    generationId: ragSnapshot.generationId,
    jobId: JOB_ID,
    returnedCount: entries.length,
    revisionToken: Number(ragSnapshot.revisionToken),
    ...overrides
  };
}

function ragSelection() {
  return {
    candidates: [
      { indexedRevision: 2, noteId: NOTE_ID },
      { indexedRevision: 3, noteId: SECOND_NOTE_ID }
    ],
    snapshot: ragSnapshot
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
      generatedBlockId: `blk_${ULID}`,
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
      generatedBlock: {
        operationCount: 1,
        reservationId: "22222222-2222-4222-8222-222222222225"
      },
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
  generatedBlock: null,
  noteWrite: { sealed: true },
  outcome: "appended" as const,
  receipt: { sealed: true },
  review: null,
  reviewReason: null
});

describe("organizer database adapter", () => {
  it("strictly decodes content-free note and space rule snapshots", async () => {
    const noteRuleMatch = {
      destinationId: NOTE_ID,
      destinationKind: "note",
      matched: true,
      priority: 900,
      ruleId: "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE",
      ruleRevision: 4
    } as const;
    const spaceRuleMatch = {
      ...noteRuleMatch,
      destinationId: "spc_01ARZ3NDEKTSV4RRFFQ69G5FAF",
      destinationKind: "space"
    } as const;

    for (const ruleMatch of [noteRuleMatch, spaceRuleMatch]) {
      const repository = createOrganizerRepository(
        executor([rpc(claim({ controls: { ...controls, ruleMatch } }))])
      );
      await expect(
        repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" })
      ).resolves.toMatchObject([{ controls: { ruleMatch } }]);
    }

    for (const ruleMatch of [
      { ...noteRuleMatch, condition: "private plaintext must not cross this boundary" },
      { ...noteRuleMatch, destinationId: "spc_01ARZ3NDEKTSV4RRFFQ69G5FAF" },
      { ...noteRuleMatch, matched: false },
      { ...noteRuleMatch, ruleRevision: 0 }
    ]) {
      const repository = createOrganizerRepository(
        executor([rpc(claim({ controls: { ...controls, ruleMatch } }))])
      );
      await expect(
        repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" })
      ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
    }
  });

  it("uses only the exact role and text-token RPC contracts end to end", async () => {
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

  it("canonicalizes PostgreSQL offset timestamps before exposing organizer contracts", async () => {
    const source = projection("capture", CAPTURE_ID, 1);
    const { serializedBytes, ...sourceProjection } = source;
    const offsetCandidate = candidateEntry(NOTE_ID, 2, POSTGRES_OFFSET_TIMESTAMP);
    const candidate = {
      ...offsetCandidate.candidate,
      metadata: {
        ...offsetCandidate.candidate.metadata,
        pinnedAt: POSTGRES_OFFSET_TIMESTAMP
      }
    };
    const db = executor([
      rpc({
        ...claim({
          leaseExpiresAt: POSTGRES_OFFSET_TIMESTAMP,
          occurredAt: POSTGRES_OFFSET_TIMESTAMP,
          source: sourceProjection
        }),
        sourceEnvelopeBytes: serializedBytes
      }),
      rpc(
        candidatePage({
          candidates: [candidate]
        })
      ),
      rpc({
        candidateCount: 1,
        currentRevision: 2,
        disclosureAuthorized: true,
        jobId: JOB_ID,
        leaseExpiresAt: POSTGRES_OFFSET_TIMESTAMP,
        outcome: "authorized",
        replanCount: 0
      })
    ]);
    const repository = createOrganizerRepository(db);
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
    const heartbeat = await repository.heartbeat({
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
    });
    expect(jobs[0]).toMatchObject({
      leaseExpiresAt: CANONICAL_OFFSET_TIMESTAMP,
      occurredAt: CANONICAL_OFFSET_TIMESTAMP,
      source: { key: { createdAt: NOW } }
    });
    expect(UtcInstantSchema.parse(jobs[0]?.occurredAt)).toBe(CANONICAL_OFFSET_TIMESTAMP);
    expect(page.candidates[0]).toMatchObject({
      pinnedAt: CANONICAL_OFFSET_TIMESTAMP,
      source: { key: { createdAt: NOW } },
      updatedAt: CANONICAL_OFFSET_TIMESTAMP
    });
    expect(UtcInstantSchema.parse(page.candidates[0]?.updatedAt)).toBe(CANONICAL_OFFSET_TIMESTAMP);
    expect(heartbeat).toMatchObject({ leaseExpiresAt: CANONICAL_OFFSET_TIMESTAMP });
  });

  it("parses encrypted RAG pages and sends the exact lease-bound paging parameters", async () => {
    const firstItem = ragItem(INDEX_ID, NOTE_ID, 2);
    const secondItem = ragItem(SECOND_INDEX_ID, SECOND_NOTE_ID, 3);
    const db = executor([
      rpc(claim()),
      rpc(ragPageResult([firstItem], { hasMore: true })),
      rpc(ragPageResult([secondItem]))
    ]);
    const repository = createOrganizerRepository(db);
    await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });

    const first = await repository.ragPage({
      cursor: null,
      jobId: JOB_ID,
      leaseToken: LEASE,
      limit: 1,
      maxBytes: RAG_PAGE_BYTES,
      signal
    });
    expect(first.status).toBe("page");
    if (first.status !== "page") throw new Error("expected an encrypted RAG page");
    expect(first.page).toMatchObject({
      coverage: { missingOrStaleCount: 0, repairOverflow: false, status: "complete" },
      items: [
        {
          ciphertextBytes: 16,
          indexId: INDEX_ID,
          indexedRevision: 2,
          noteId: NOTE_ID,
          record: { recordVersion: 2, resourceId: INDEX_ID }
        }
      ],
      snapshot: ragSnapshot
    });
    expect(first.page.nextCursor).toBe(
      JSON.stringify({
        afterIndexId: INDEX_ID,
        generationId: GENERATION_ID,
        revisionToken: 7
      })
    );

    const second = await repository.ragPage({
      cursor: first.page.nextCursor,
      jobId: JOB_ID,
      leaseToken: LEASE,
      limit: 1,
      maxBytes: RAG_PAGE_BYTES,
      signal
    });
    expect(second).toMatchObject({
      status: "page",
      page: { items: [{ indexId: SECOND_INDEX_ID, noteId: SECOND_NOTE_ID }], nextCursor: null }
    });
    expect(db.queries.slice(1).map(({ text, values }) => ({ text, values }))).toEqual([
      {
        text: ORGANIZER_RPC_SQL.ragPage,
        values: [JOB_ID, LEASE, null, 1, RAG_PAGE_BYTES]
      },
      {
        text: ORGANIZER_RPC_SQL.ragPage,
        values: [
          JOB_ID,
          LEASE,
          { afterIndexId: INDEX_ID, generationId: GENERATION_ID, revisionToken: 7 },
          1,
          RAG_PAGE_BYTES
        ]
      }
    ]);
  });

  it("parses the explicit no-active-generation RAG result", async () => {
    const db = executor([
      rpc(claim()),
      rpc({
        jobId: JOB_ID,
        result: {
          coverage: {
            complete: false,
            coveredNoteCount: 0,
            eligibleNoteCount: 0,
            expectedNoteCount: 0,
            indexedNoteCount: 0,
            pendingJobCount: 0,
            repairCandidates: [],
            repairCount: 0,
            repairLimitExceeded: false,
            verified: false
          },
          generation: null,
          items: [],
          keys: [],
          ownerId: OWNER_ID,
          page: {
            ciphertextByteBudget: RAG_PAGE_BYTES,
            ciphertextBytes: 0,
            hasMore: false,
            limit: 1,
            nextCursor: null,
            returnedCount: 0
          }
        }
      })
    ]);
    const repository = createOrganizerRepository(db);
    await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    await expect(
      repository.ragPage({
        cursor: null,
        jobId: JOB_ID,
        leaseToken: LEASE,
        limit: 1,
        maxBytes: RAG_PAGE_BYTES,
        signal
      })
    ).resolves.toEqual({ status: "no_active_generation" });
  });

  it("parses selected encrypted candidates in caller order with exact snapshot bindings", async () => {
    const first = candidateEntry(NOTE_ID, 2);
    const second = candidateEntry(SECOND_NOTE_ID, 3);
    const db = executor([rpc(claim()), rpc(selectedCandidatePage([first, second]))]);
    const repository = createOrganizerRepository(db);
    await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });

    const page = await repository.selectCandidates({
      jobId: JOB_ID,
      leaseToken: LEASE,
      selection: ragSelection(),
      signal
    });
    expect(page.snapshot).toEqual(ragSnapshot);
    expect(page.candidates.map(({ noteId, revision }) => ({ noteId, revision }))).toEqual([
      { noteId: NOTE_ID, revision: 2 },
      { noteId: SECOND_NOTE_ID, revision: 3 }
    ]);
    expect(db.queries[1]).toMatchObject({
      text: ORGANIZER_RPC_SQL.selectCandidates,
      values: [
        JOB_ID,
        LEASE,
        {
          candidates: ragSelection().candidates,
          generationId: GENERATION_ID,
          revisionToken: 7
        }
      ]
    });
  });

  it("rejects malformed RAG records and reordered or revision-drifted selections", async () => {
    const malformedRag = createOrganizerRepository(
      executor([
        rpc(claim()),
        rpc(ragPageResult([ragItem(INDEX_ID, NOTE_ID, 2)], { overrides: { keys: [] } }))
      ])
    );
    await malformedRag.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    await expect(
      malformedRag.ragPage({
        cursor: null,
        jobId: JOB_ID,
        leaseToken: LEASE,
        limit: 1,
        maxBytes: RAG_PAGE_BYTES,
        signal
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);

    for (const returned of [
      [candidateEntry(SECOND_NOTE_ID, 3), candidateEntry(NOTE_ID, 2)],
      [candidateEntry(NOTE_ID, 2), candidateEntry(SECOND_NOTE_ID, 4)]
    ]) {
      const repository = createOrganizerRepository(
        executor([rpc(claim()), rpc(selectedCandidatePage(returned))])
      );
      await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
      await expect(
        repository.selectCandidates({
          jobId: JOB_ID,
          leaseToken: LEASE,
          selection: ragSelection(),
          signal
        })
      ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
    }
  });

  it("rejects malformed RAG requests before disclosure and normalizes retrieval transport errors", async () => {
    const invalidDb = executor([rpc(claim())]);
    const invalid = createOrganizerRepository(invalidDb);
    await invalid.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    await expect(
      invalid.ragPage({
        cursor: '{"generationId":"forged"}',
        jobId: JOB_ID,
        leaseToken: LEASE,
        limit: 1,
        maxBytes: RAG_PAGE_BYTES,
        signal
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
    await expect(
      invalid.selectCandidates({
        jobId: JOB_ID,
        leaseToken: LEASE,
        selection: {
          candidates: [
            { indexedRevision: 2, noteId: NOTE_ID },
            { indexedRevision: 2, noteId: NOTE_ID }
          ],
          snapshot: ragSnapshot
        },
        signal
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
    expect(invalidDb.queries).toHaveLength(1);

    for (const operation of ["ragPage", "selectCandidates"] as const) {
      const repository = createOrganizerRepository(
        executor([rpc(claim()), { throw: { code: "08006" } }])
      );
      await repository.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
      const pending =
        operation === "ragPage"
          ? repository.ragPage({
              cursor: null,
              jobId: JOB_ID,
              leaseToken: LEASE,
              limit: 1,
              maxBytes: RAG_PAGE_BYTES,
              signal
            })
          : repository.selectCandidates({
              jobId: JOB_ID,
              leaseToken: LEASE,
              selection: ragSelection(),
              signal
            });
      await expect(pending).rejects.toBeInstanceOf(OrganizerUnavailableError);
    }
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

    const { candidate: mismatchedCandidate } = candidateEntry(NOTE_ID, 2);
    const mismatchedIds = createOrganizerRepository(
      executor([
        rpc(claim()),
        rpc(
          candidatePage({
            candidates: [{ ...mismatchedCandidate, candidateId: SECOND_NOTE_ID }]
          })
        )
      ])
    );
    await mismatchedIds.claim({ leaseSeconds: 120, limit: 1, signal, workerId: "worker-1" });
    await expect(
      mismatchedIds.candidates({ jobId: JOB_ID, leaseToken: LEASE, limit: 8, signal })
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
    await expect(
      repository.heartbeat({
        candidateManifest: {
          candidates: page.candidates.map(({ candidateId, isOpen, noteId, revision }) => ({
            candidateId,
            isOpen,
            noteId,
            revision
          })),
          controls: {
            ...controls,
            ruleMatch: {
              destinationId: NOTE_ID,
              destinationKind: "note",
              matched: true,
              priority: 900,
              ruleId: "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE",
              ruleRevision: 4
            }
          }
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
        review: { sealed: true },
        reviewReason: "expansion_pending"
      })
    ).toBe(true);
    expect(
      isAtomicOrganizerCommand({
        ...command,
        generatedBlock: { sealed: true },
        review: { sealed: true },
        reviewReason: "expansion_pending"
      })
    ).toBe(true);
    expect(
      isAtomicOrganizerCommand({
        ...command,
        generatedBlock: { sealed: true },
        reviewReason: "expansion_pending"
      })
    ).toBe(false);
    expect(
      isAtomicOrganizerCommand({
        ...command,
        noteWrite: null,
        outcome: "review",
        review: { sealed: true },
        reviewReason: "duplicate_suggestion"
      })
    ).toBe(true);
    expect(isAtomicOrganizerCommand({ ...command, extra: true })).toBe(false);
  });
});
