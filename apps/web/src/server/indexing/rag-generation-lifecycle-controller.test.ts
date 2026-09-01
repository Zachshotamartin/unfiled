/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";

import { RAG_GENERATION_VERIFICATION_NOTE_CAPACITY } from "@unfiled/contracts";

import { ServiceRpcError, ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";

import {
  IndexVerifierGenerationInvalidError,
  IndexVerifierInvocationError,
  type IndexVerifierClient
} from "./index-verifier-client";
import type { IndexWorkerClient } from "./index-worker-client";
import {
  createRagGenerationId,
  RagGenerationMaintenanceError,
  runRagGenerationMaintenance
} from "./rag-generation-lifecycle-controller";
import {
  RagMaintenanceAction,
  RagMaintenancePhase,
  type BuildingRagGeneration,
  type RagGenerationLifecycleStore,
  type RagMaintenanceCandidate,
  type RagMaintenancePage,
  type SeededRagGeneration
} from "./rag-generation-lifecycle-store";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const GEN_A = "igen_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const GEN_B = "igen_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const GEN_NEW = "igen_01J6M9Q7G4BMKB33GSG3NJ6D1Z";
const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const BATCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BATCH_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BATCH_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const TARGET = Object.freeze({
  embeddingModelId: "text-embedding-3-small",
  embeddingDimensions: 1_536,
  envelopeSchemaVersion: 1 as const
});

function building(
  generationId = GEN_A,
  values: Partial<BuildingRagGeneration> = {}
): BuildingRagGeneration {
  return Object.freeze({
    generationId,
    embeddingModelId: TARGET.embeddingModelId,
    embeddingDimensions: TARGET.embeddingDimensions,
    expectedNoteCount: 0,
    indexedNoteCount: 0,
    revisionToken: "0",
    ...values
  });
}

function candidate(
  ownerId: string,
  action: (typeof RagMaintenanceAction)[keyof typeof RagMaintenanceAction],
  generation: BuildingRagGeneration | null,
  values: Partial<RagMaintenanceCandidate> = {}
): RagMaintenanceCandidate {
  return Object.freeze({
    ownerId,
    rolloutState: "dual_write",
    eligibleNoteCount: generation?.expectedNoteCount ?? 0,
    aiObjectWrapKeyReady: true,
    action,
    activeGeneration: null,
    buildingGeneration: generation,
    ...values
  });
}

function page(
  candidates: readonly RagMaintenanceCandidate[],
  nextOwnerId: string | null = null,
  values: Readonly<{
    checkpointRevision?: string;
    phase?: "seed" | "verify";
    replayed?: boolean;
    requestId?: string;
  }> = {}
): RagMaintenancePage {
  const checkpointRevision = values.checkpointRevision ?? "1";
  const phase = values.phase ?? RagMaintenancePhase.SEED;
  return Object.freeze({
    target: Object.freeze({ ...TARGET, phase }),
    candidates: Object.freeze([...candidates]),
    page: Object.freeze({
      requestId: values.requestId ?? BATCH_A,
      checkpointRevision,
      limit: 10,
      returnedCount: candidates.length,
      hasMore: nextOwnerId !== null,
      nextCursor:
        nextOwnerId === null
          ? null
          : Object.freeze({
              embeddingModelId: TARGET.embeddingModelId,
              embeddingDimensions: TARGET.embeddingDimensions,
              phase,
              checkpointRevision,
              afterOwnerId: nextOwnerId
            }),
      replayed: values.replayed ?? false
    })
  });
}

function seeded(
  input: Parameters<RagGenerationLifecycleStore["seedGeneration"]>[0],
  values: Partial<SeededRagGeneration> = {}
): SeededRagGeneration {
  return Object.freeze({
    batchId: input.batchId,
    generationId: input.generationId,
    revisionToken: input.expectedRevisionToken,
    eligibleNoteCount: 0,
    examinedCount: 0,
    enqueuedCount: 0,
    hasMore: false,
    complete: true,
    nextCursor: null,
    blocked: false,
    failureCode: null,
    replayed: false,
    ...values
  });
}

function lifecycle(): RagGenerationLifecycleStore {
  return {
    listMaintenanceCandidates: vi.fn<RagGenerationLifecycleStore["listMaintenanceCandidates"]>(),
    ensureGeneration: vi.fn<RagGenerationLifecycleStore["ensureGeneration"]>(),
    seedGeneration: vi.fn<RagGenerationLifecycleStore["seedGeneration"]>(),
    failGeneration: vi.fn<RagGenerationLifecycleStore["failGeneration"]>(),
    activateGeneration: vi.fn<RagGenerationLifecycleStore["activateGeneration"]>()
  };
}

function idleWorker(events?: string[]): IndexWorkerClient {
  return {
    drain: vi.fn<IndexWorkerClient["drain"]>(async () => {
      events?.push("drain");
      return { claimed: 0, completed: 0, failed: 0, retryScheduled: 0 };
    })
  };
}

function verifier(events?: string[], verifiedNoteCount = 0): IndexVerifierClient {
  return {
    verify: vi.fn<IndexVerifierClient["verify"]>(async (input) => {
      events?.push("verify");
      return {
        generationId: input.generationId,
        revisionToken: input.revisionToken,
        verifiedNoteCount,
        verified: true as const
      };
    })
  };
}

describe("RAG generation lifecycle controller", () => {
  it("creates, durably seeds, drains, verifies, and activates an empty generation in order", async () => {
    const events: string[] = [];
    const store = lifecycle();
    vi.mocked(store.listMaintenanceCandidates)
      .mockImplementationOnce(async () => {
        events.push("list-seed");
        return page([candidate(OWNER_A, RagMaintenanceAction.CREATE_BUILD, null)]);
      })
      .mockImplementationOnce(async () => {
        events.push("list-verify");
        return page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, building(GEN_NEW))]);
      });
    vi.mocked(store.ensureGeneration).mockImplementation(async () => {
      events.push("ensure");
      return {
        ...building(GEN_NEW),
        state: "building",
        envelopeSchemaVersion: 1,
        replayed: false
      };
    });
    vi.mocked(store.seedGeneration).mockImplementation(async (input) => {
      events.push("seed");
      return seeded(input);
    });
    vi.mocked(store.activateGeneration).mockImplementation(async (input) => {
      events.push("activate");
      return {
        generationId: input.generationId,
        revisionToken: "1",
        coverageVerified: true,
        replayed: false
      };
    });

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(events),
      verifier: verifier(events),
      signal: new AbortController().signal,
      createGenerationId: () => GEN_NEW,
      createBatchId: () => BATCH_A
    });

    expect(events).toEqual([
      "list-seed",
      "ensure",
      "seed",
      "drain",
      "list-verify",
      "verify",
      "activate"
    ]);
    expect(result).toMatchObject({
      createdGenerations: 1,
      seedGenerationsComplete: 1,
      verifiedGenerations: 1,
      activatedGenerations: 1
    });
  });

  it("resumes a matching build without ensuring a second generation", async () => {
    const store = lifecycle();
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(
        page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, building())])
      )
      .mockResolvedValueOnce(
        page([
          candidate(
            OWNER_A,
            RagMaintenanceAction.RESUME_BUILD,
            building(GEN_A, { expectedNoteCount: 1, indexedNoteCount: 0 })
          )
        ])
      );
    vi.mocked(store.seedGeneration).mockImplementation(async (input) => seeded(input));

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifier(),
      signal: new AbortController().signal,
      createBatchId: () => BATCH_A
    });

    expect(result.resumedGenerations).toBe(1);
    expect(result.verificationDeferred).toBe(1);
    expect(store.ensureGeneration).not.toHaveBeenCalled();
  });

  it("fails a mismatched build by exact CAS before ensuring its replacement", async () => {
    const events: string[] = [];
    const store = lifecycle();
    const old = building(GEN_A, {
      embeddingModelId: "text-embedding-old",
      embeddingDimensions: 768,
      revisionToken: "7"
    });
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(page([candidate(OWNER_A, RagMaintenanceAction.REPLACE_BUILD, old)]))
      .mockResolvedValueOnce(page([]));
    vi.mocked(store.failGeneration).mockImplementation(async (input) => {
      events.push("fail");
      expect(input).toEqual({
        ownerId: OWNER_A,
        generationId: GEN_A,
        expectedRevisionToken: "7",
        failureCode: "validation_failed"
      });
      return {
        generationId: GEN_A,
        state: "failed",
        revisionToken: "8",
        failureCode: "validation_failed",
        replayed: false
      };
    });
    vi.mocked(store.ensureGeneration).mockImplementation(async () => {
      events.push("ensure");
      return {
        ...building(GEN_NEW),
        state: "building",
        envelopeSchemaVersion: 1,
        replayed: false
      };
    });
    vi.mocked(store.seedGeneration).mockImplementation(async (input) => seeded(input));

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifier(),
      signal: new AbortController().signal,
      createGenerationId: () => GEN_NEW,
      createBatchId: () => BATCH_A
    });

    expect(events).toEqual(["fail", "ensure"]);
    expect(result.replacedGenerations).toBe(1);
  });

  it("bounds candidate and seed pages while using a distinct UUID for every replayable page", async () => {
    const store = lifecycle();
    const ownerAGeneration = building(GEN_A, { expectedNoteCount: 10 });
    const ownerBGeneration = building(GEN_B, { expectedNoteCount: 10 });
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(
        page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, ownerAGeneration)], OWNER_A)
      )
      .mockResolvedValueOnce(
        page([candidate(OWNER_B, RagMaintenanceAction.RESUME_BUILD, ownerBGeneration)], OWNER_B, {
          checkpointRevision: "2"
        })
      )
      .mockResolvedValueOnce(page([]));
    let seedCall = 0;
    vi.mocked(store.seedGeneration).mockImplementation(async (input) => {
      seedCall += 1;
      const nextRevisionToken = String(BigInt(input.expectedRevisionToken) + 1n);
      return seeded(input, {
        revisionToken: nextRevisionToken,
        eligibleNoteCount: 10,
        examinedCount: 1,
        enqueuedCount: 1,
        hasMore: true,
        complete: false,
        nextCursor: {
          generationId: input.generationId,
          revisionToken: nextRevisionToken,
          afterNoteId: seedCall % 2 === 0 ? NOTE_B : NOTE_A
        }
      });
    });
    const batchIds = [BATCH_A, BATCH_B, BATCH_C, BATCH_D];

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifier(),
      signal: new AbortController().signal,
      bounds: { maxCandidatePages: 2, maxSeedPagesPerGeneration: 2 },
      createBatchId: () => batchIds.shift() ?? BATCH_A
    });

    expect(store.listMaintenanceCandidates).toHaveBeenCalledTimes(3);
    const candidateCalls = vi
      .mocked(store.listMaintenanceCandidates)
      .mock.calls.map(([input]) => input);
    expect(candidateCalls.map(({ phase }) => phase)).toEqual(["seed", "seed", "verify"]);
    expect(new Set(candidateCalls.map(({ pageRequestId }) => pageRequestId)).size).toBe(3);
    expect(candidateCalls.map(({ cursor }) => cursor)).toEqual([
      null,
      {
        embeddingModelId: TARGET.embeddingModelId,
        embeddingDimensions: TARGET.embeddingDimensions,
        phase: "seed",
        checkpointRevision: "1",
        afterOwnerId: OWNER_A
      },
      null
    ]);
    expect(store.seedGeneration).toHaveBeenCalledTimes(4);
    expect(vi.mocked(store.seedGeneration).mock.calls.map(([input]) => input.batchId)).toEqual([
      BATCH_A,
      BATCH_B,
      BATCH_C,
      BATCH_D
    ]);
    expect(result).toMatchObject({
      seedCandidatePagesTruncated: 1,
      seedGenerationsTruncated: 2,
      seedPages: 4,
      verificationCandidatePagesTruncated: 0
    });
  });

  it("replays an ambiguous maintenance page with one request ID and advances phases with fresh IDs", async () => {
    const store = lifecycle();
    let seedAttempts = 0;
    vi.mocked(store.listMaintenanceCandidates).mockImplementation(async (input) => {
      if (input.phase === RagMaintenancePhase.SEED && seedAttempts++ === 0) {
        throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
      }
      return page([], null, {
        phase: input.phase,
        requestId: input.pageRequestId,
        checkpointRevision: input.phase === RagMaintenancePhase.SEED ? "4" : "9",
        replayed: input.phase === RagMaintenancePhase.SEED
      });
    });
    const pageRequestIds = [BATCH_C, BATCH_D];

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifier(),
      signal: new AbortController().signal,
      createPageRequestId: () => pageRequestIds.shift() ?? BATCH_A
    });

    const calls = vi.mocked(store.listMaintenanceCandidates).mock.calls.map(([input]) => input);
    expect(calls.map(({ phase, pageRequestId }) => ({ phase, pageRequestId }))).toEqual([
      { phase: "seed", pageRequestId: BATCH_C },
      { phase: "seed", pageRequestId: BATCH_C },
      { phase: "verify", pageRequestId: BATCH_D }
    ]);
    expect(calls.every(({ cursor }) => cursor === null)).toBe(true);
    expect(result).toMatchObject({ candidatePages: 1, verificationPages: 1 });
  });

  it.each([
    ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY,
    ServiceRpcErrorCode.STALE_MAINTENANCE_CURSOR
  ])("fails closed without mutating generations for %s paging failures", async (code) => {
    const store = lifecycle();
    vi.mocked(store.listMaintenanceCandidates).mockRejectedValue(new ServiceRpcError(code));

    await expect(
      runRagGenerationMaintenance({
        lifecycle: store,
        target: TARGET,
        worker: idleWorker(),
        verifier: verifier(),
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code });
    expect(store.listMaintenanceCandidates).toHaveBeenCalledOnce();
    expect(store.ensureGeneration).not.toHaveBeenCalled();
    expect(store.seedGeneration).not.toHaveBeenCalled();
    expect(store.failGeneration).not.toHaveBeenCalled();
    expect(store.activateGeneration).not.toHaveBeenCalled();
  });

  it("never activates when verifier coverage disagrees with expected coverage", async () => {
    const store = lifecycle();
    const incomplete = building(GEN_A, { expectedNoteCount: 2, indexedNoteCount: 1 });
    const complete = building(GEN_A, { expectedNoteCount: 2, indexedNoteCount: 2 });
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(
        page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, incomplete)])
      )
      .mockResolvedValueOnce(
        page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, complete)])
      );
    vi.mocked(store.seedGeneration).mockImplementation(async (input) =>
      seeded(input, { eligibleNoteCount: 2 })
    );

    await expect(
      runRagGenerationMaintenance({
        lifecycle: store,
        target: TARGET,
        worker: idleWorker(),
        verifier: verifier(undefined, 1),
        signal: new AbortController().signal,
        createBatchId: () => BATCH_A
      })
    ).rejects.toBeInstanceOf(RagGenerationMaintenanceError);
    expect(store.activateGeneration).not.toHaveBeenCalled();
  });

  it("fails a deterministically invalid generation and continues verifying later owners", async () => {
    const events: string[] = [];
    const store = lifecycle();
    const generationA = building(GEN_A);
    const generationB = building(GEN_B);
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(
        page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, generationA)])
      )
      .mockResolvedValueOnce(
        page([
          candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, generationA),
          candidate(OWNER_B, RagMaintenanceAction.RESUME_BUILD, generationB)
        ])
      );
    vi.mocked(store.seedGeneration).mockImplementation(async (input) => seeded(input));
    vi.mocked(store.failGeneration).mockImplementation(async (input) => {
      events.push("fail-invalid");
      return {
        generationId: input.generationId,
        state: "failed",
        revisionToken: "1",
        failureCode: "validation_failed",
        replayed: false
      };
    });
    vi.mocked(store.activateGeneration).mockImplementation(async (input) => {
      events.push("activate-valid");
      return {
        generationId: input.generationId,
        revisionToken: "1",
        coverageVerified: true,
        replayed: false
      };
    });
    const verifyClient: IndexVerifierClient = {
      verify: vi.fn<IndexVerifierClient["verify"]>(async (target) => {
        if (target.ownerId === OWNER_A) {
          events.push("verify-invalid");
          throw new IndexVerifierGenerationInvalidError();
        }
        events.push("verify-valid");
        return {
          generationId: target.generationId,
          revisionToken: target.revisionToken,
          verifiedNoteCount: 0,
          verified: true
        };
      })
    };

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifyClient,
      signal: new AbortController().signal,
      createBatchId: () => BATCH_A
    });

    expect(events).toEqual(["verify-invalid", "fail-invalid", "verify-valid", "activate-valid"]);
    expect(result).toMatchObject({
      invalidGenerationsFailed: 1,
      verificationDeferred: 1,
      verifiedGenerations: 1,
      activatedGenerations: 1
    });
  });

  it("continues verification after an early candidate exhausts transient verifier retries", async () => {
    const store = lifecycle();
    const generationA = building(GEN_A);
    const generationB = building(GEN_B);
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        page([
          candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, generationA),
          candidate(OWNER_B, RagMaintenanceAction.RESUME_BUILD, generationB)
        ])
      );
    vi.mocked(store.activateGeneration).mockImplementation(async (input) => ({
      generationId: input.generationId,
      revisionToken: String(BigInt(input.expectedRevisionToken) + 1n),
      coverageVerified: true,
      replayed: false
    }));
    const verifyClient: IndexVerifierClient = {
      verify: vi.fn<IndexVerifierClient["verify"]>(async (target) => {
        if (target.ownerId === OWNER_A) throw new IndexVerifierInvocationError();
        return {
          generationId: target.generationId,
          revisionToken: target.revisionToken,
          verifiedNoteCount: 0,
          verified: true
        };
      })
    };

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifyClient,
      signal: new AbortController().signal
    });

    expect(vi.mocked(verifyClient.verify).mock.calls.map(([target]) => target.ownerId)).toEqual([
      OWNER_A,
      OWNER_A,
      OWNER_B
    ]);
    expect(store.activateGeneration).toHaveBeenCalledOnce();
    expect(store.activateGeneration).toHaveBeenCalledWith({
      ownerId: OWNER_B,
      generationId: GEN_B,
      expectedRevisionToken: "0"
    });
    expect(store.failGeneration).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      verificationCandidateRetryFailures: 1,
      verifiedGenerations: 1,
      activatedGenerations: 1
    });
  });

  it("defers owners above verifier capacity before create or seed and fails an over-cap build once", async () => {
    const store = lifecycle();
    const overCapacity = building(GEN_B, {
      expectedNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY + 1
    });
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(
        page([
          candidate(OWNER_A, RagMaintenanceAction.CREATE_BUILD, null, {
            eligibleNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY + 1
          }),
          candidate(OWNER_B, RagMaintenanceAction.RESUME_BUILD, overCapacity)
        ])
      )
      .mockResolvedValueOnce(page([]));
    vi.mocked(store.failGeneration).mockImplementation(async (input) => ({
      generationId: input.generationId,
      state: "failed",
      revisionToken: "1",
      failureCode: "validation_failed",
      replayed: false
    }));
    const worker = idleWorker();
    const verifyClient = verifier();

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker,
      verifier: verifyClient,
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      capacityDeferrals: 2,
      capacityGenerationsFailed: 1,
      candidatesDeferred: 2,
      seedPages: 0,
      drainWaves: 0
    });
    expect(store.failGeneration).toHaveBeenCalledOnce();
    expect(store.ensureGeneration).not.toHaveBeenCalled();
    expect(store.seedGeneration).not.toHaveBeenCalled();
    expect(worker.drain).not.toHaveBeenCalled();
    expect(verifyClient.verify).not.toHaveBeenCalled();
  });

  it("applies the shared capacity guard again before verification", async () => {
    const store = lifecycle();
    const overCapacity = building(GEN_A, {
      expectedNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY + 1,
      indexedNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY + 1
    });
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        page([
          candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, overCapacity, {
            eligibleNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY + 1
          })
        ])
      );
    vi.mocked(store.failGeneration).mockImplementation(async (input) => ({
      generationId: input.generationId,
      state: "failed",
      revisionToken: "1",
      failureCode: "validation_failed",
      replayed: false
    }));
    const verifyClient = verifier();

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifyClient,
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      capacityDeferrals: 1,
      capacityGenerationsFailed: 1,
      verificationDeferred: 1
    });
    expect(store.failGeneration).toHaveBeenCalledOnce();
    expect(verifyClient.verify).not.toHaveBeenCalled();
  });

  it("fails an existing build once when its encrypted indexing prerequisites are not ready", async () => {
    const store = lifecycle();
    const current = building(GEN_A, { revisionToken: "6" });
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(
        page([
          candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, current, {
            aiObjectWrapKeyReady: false
          })
        ])
      )
      .mockResolvedValueOnce(page([]));
    vi.mocked(store.failGeneration).mockImplementation(async (input) => ({
      generationId: input.generationId,
      state: "failed",
      revisionToken: "7",
      failureCode: "validation_failed",
      replayed: false
    }));

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifier(),
      signal: new AbortController().signal
    });

    expect(store.failGeneration).toHaveBeenCalledWith({
      ownerId: OWNER_A,
      generationId: GEN_A,
      expectedRevisionToken: "6",
      failureCode: "validation_failed"
    });
    expect(store.failGeneration).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      candidatesDeferred: 1,
      readinessGenerationsFailed: 1,
      seedPages: 0,
      verificationDeferred: 0
    });
  });

  it("replays an ambiguous seed response once with the identical UUID", async () => {
    const store = lifecycle();
    const current = building(GEN_A, { expectedNoteCount: 1 });
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, current)]))
      .mockResolvedValueOnce(
        page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, current)])
      );
    vi.mocked(store.seedGeneration)
      .mockRejectedValueOnce(new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE))
      .mockImplementationOnce(async (input) => seeded(input, { eligibleNoteCount: 1 }));

    await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker: idleWorker(),
      verifier: verifier(),
      signal: new AbortController().signal,
      createBatchId: () => BATCH_A
    });

    const calls = vi.mocked(store.seedGeneration).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0].batchId).toBe(BATCH_A);
    expect(calls[1]?.[0].batchId).toBe(BATCH_A);
  });

  it("continues seeding after an early candidate exhausts transient RPC retries", async () => {
    const store = lifecycle();
    const worker = idleWorker();
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(
        page([
          candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, building(GEN_A)),
          candidate(OWNER_B, RagMaintenanceAction.RESUME_BUILD, building(GEN_B))
        ])
      )
      .mockResolvedValueOnce(page([]));
    vi.mocked(store.seedGeneration).mockImplementation(async (input) => {
      if (input.ownerId === OWNER_A) {
        throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
      }
      return seeded(input);
    });

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker,
      verifier: verifier(),
      signal: new AbortController().signal,
      createBatchId: () => BATCH_A
    });

    expect(vi.mocked(store.seedGeneration).mock.calls.map(([input]) => input.ownerId)).toEqual([
      OWNER_A,
      OWNER_A,
      OWNER_B
    ]);
    expect(worker.drain).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      candidatesSeen: 2,
      seedCandidateRetryFailures: 1,
      seedGenerationsComplete: 1
    });
  });

  it("aborts the page on a nonretryable candidate contract error", async () => {
    const store = lifecycle();
    vi.mocked(store.listMaintenanceCandidates).mockResolvedValueOnce(
      page([
        candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, building(GEN_A)),
        candidate(OWNER_B, RagMaintenanceAction.RESUME_BUILD, building(GEN_B))
      ])
    );
    vi.mocked(store.seedGeneration).mockRejectedValue(
      new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED)
    );

    await expect(
      runRagGenerationMaintenance({
        lifecycle: store,
        target: TARGET,
        worker: idleWorker(),
        verifier: verifier(),
        signal: new AbortController().signal,
        createBatchId: () => BATCH_A
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    expect(store.seedGeneration).toHaveBeenCalledOnce();
    expect(store.seedGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER_A })
    );
    expect(store.listMaintenanceCandidates).toHaveBeenCalledOnce();
  });

  it("fails a blocked seed by exact CAS and defers rebuild without draining or verifying it", async () => {
    const store = lifecycle();
    const current = building(GEN_A, { expectedNoteCount: 1, revisionToken: "4" });
    vi.mocked(store.listMaintenanceCandidates)
      .mockResolvedValueOnce(page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, current)]))
      .mockResolvedValueOnce(page([]));
    vi.mocked(store.seedGeneration).mockImplementation(async (input) =>
      seeded(input, {
        eligibleNoteCount: 1,
        complete: false,
        blocked: true,
        failureCode: "validation_failed"
      })
    );
    vi.mocked(store.failGeneration).mockImplementation(async (input) => {
      expect(input).toEqual({
        ownerId: OWNER_A,
        generationId: GEN_A,
        expectedRevisionToken: "4",
        failureCode: "validation_failed"
      });
      return {
        generationId: GEN_A,
        state: "failed",
        revisionToken: "5",
        failureCode: "validation_failed",
        replayed: false
      };
    });
    const worker = idleWorker();
    const verifyClient = verifier();

    const result = await runRagGenerationMaintenance({
      lifecycle: store,
      target: TARGET,
      worker,
      verifier: verifyClient,
      signal: new AbortController().signal,
      createBatchId: () => BATCH_A
    });

    expect(result).toMatchObject({
      candidatesDeferred: 1,
      seedGenerationsBlocked: 1,
      seedGenerationsComplete: 0,
      seedGenerationsTruncated: 0,
      drainWaves: 0
    });
    expect(worker.drain).not.toHaveBeenCalled();
    expect(verifyClient.verify).not.toHaveBeenCalled();
    expect(store.ensureGeneration).not.toHaveBeenCalled();
  });

  it("stops after a durable seed when the request aborts and leaves later phases untouched", async () => {
    const controller = new AbortController();
    const store = lifecycle();
    vi.mocked(store.listMaintenanceCandidates).mockResolvedValueOnce(
      page([candidate(OWNER_A, RagMaintenanceAction.RESUME_BUILD, building())])
    );
    vi.mocked(store.seedGeneration).mockImplementation(async (input) => {
      controller.abort();
      return seeded(input);
    });
    const worker = idleWorker();
    const verifyClient = verifier();

    await expect(
      runRagGenerationMaintenance({
        lifecycle: store,
        target: TARGET,
        worker,
        verifier: verifyClient,
        signal: controller.signal,
        createBatchId: () => BATCH_A
      })
    ).rejects.toBeInstanceOf(RagGenerationMaintenanceError);
    expect(store.seedGeneration).toHaveBeenCalledOnce();
    expect(worker.drain).not.toHaveBeenCalled();
    expect(verifyClient.verify).not.toHaveBeenCalled();
  });

  it("creates a timestamp-prefixed ULID generation identifier", () => {
    expect(createRagGenerationId(0)).toMatch(/^igen_0000000000[0-9A-HJKMNP-TV-Z]{16}$/u);
  });
});
