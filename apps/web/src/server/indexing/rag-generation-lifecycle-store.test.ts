import { describe, expect, it, vi } from "vitest";

import { ServiceRpcError, ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";

import {
  RagGenerationLifecycleContractError,
  RagGenerationLifecycleRpcStore,
  ragGenerationLifecycleRpcFunctions,
  RagMaintenanceAction,
  RagMaintenancePhase,
  type RagMaintenancePage
} from "./rag-generation-lifecycle-store";

const OWNER = "11111111-1111-4111-8111-111111111111";
const GENERATION = "igen_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOTE = "note_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BATCH = "22222222-2222-4222-8222-222222222222";
const PAGE_REQUEST = "33333333-3333-4333-8333-333333333333";

function maintenancePage(): RagMaintenancePage {
  return {
    target: {
      embeddingModelId: "text-embedding-3-small",
      embeddingDimensions: 1536,
      envelopeSchemaVersion: 1,
      phase: RagMaintenancePhase.SEED
    },
    candidates: [
      {
        ownerId: OWNER,
        rolloutState: "encrypted_read",
        eligibleNoteCount: 2,
        aiObjectWrapKeyReady: true,
        action: RagMaintenanceAction.RESUME_BUILD,
        activeGeneration: null,
        buildingGeneration: {
          generationId: GENERATION,
          embeddingModelId: "text-embedding-3-small",
          embeddingDimensions: 1536,
          expectedNoteCount: 2,
          indexedNoteCount: 1,
          revisionToken: "9223372036854775807"
        }
      }
    ],
    page: {
      requestId: PAGE_REQUEST,
      checkpointRevision: "1",
      limit: 10,
      returnedCount: 1,
      hasMore: true,
      nextCursor: {
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        phase: RagMaintenancePhase.SEED,
        checkpointRevision: "1",
        afterOwnerId: OWNER
      },
      replayed: false
    }
  };
}

describe("RAG generation lifecycle RPC store", () => {
  it("has the exact service-role lifecycle allowlist", () => {
    expect(ragGenerationLifecycleRpcFunctions).toEqual([
      "list_rag_index_maintenance_candidates",
      "ensure_rag_index_generation",
      "seed_rag_index_generation",
      "fail_rag_index_generation",
      "activate_rag_index_generation"
    ]);
  });

  it("strictly parses a maintenance page and binds the target cursor", async () => {
    const response = maintenancePage();
    const rpc = vi.fn().mockResolvedValue(response);
    const store = new RagGenerationLifecycleRpcStore({ rpc });

    await expect(
      store.listMaintenanceCandidates({
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        phase: RagMaintenancePhase.SEED,
        pageRequestId: PAGE_REQUEST,
        cursor: null,
        limit: 10
      })
    ).resolves.toEqual(response);
    expect(rpc).toHaveBeenCalledWith("list_rag_index_maintenance_candidates", {
      p_embedding_model_id: "text-embedding-3-small",
      p_embedding_dimensions: 1536,
      p_phase: "seed",
      p_page_request_id: PAGE_REQUEST,
      p_cursor: null,
      p_limit: 10
    });
  });

  it("preserves a transport ambiguity as retryable without classifying it as contract drift", async () => {
    const transportFailure = new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
    const store = new RagGenerationLifecycleRpcStore({
      rpc: vi.fn().mockRejectedValue(transportFailure)
    });

    await expect(
      store.listMaintenanceCandidates({
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        phase: RagMaintenancePhase.SEED,
        pageRequestId: PAGE_REQUEST,
        cursor: null,
        limit: 10
      })
    ).rejects.toBe(transportFailure);
  });

  it("requires an explicit cursor page to advance its durable checkpoint exactly once", async () => {
    const first = maintenancePage();
    const firstCursor = first.page.nextCursor;
    if (firstCursor === null) throw new Error("expected a maintenance cursor");
    const response: RagMaintenancePage = {
      ...first,
      page: {
        ...first.page,
        checkpointRevision: "2",
        nextCursor: {
          ...firstCursor,
          checkpointRevision: "2"
        },
        replayed: true
      }
    };
    const rpc = vi.fn().mockResolvedValue(response);
    const store = new RagGenerationLifecycleRpcStore({ rpc });

    await expect(
      store.listMaintenanceCandidates({
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        phase: RagMaintenancePhase.SEED,
        pageRequestId: PAGE_REQUEST,
        cursor: firstCursor,
        limit: 10
      })
    ).resolves.toEqual(response);

    const staleJump = {
      ...response,
      page: {
        ...response.page,
        checkpointRevision: "3",
        nextCursor: { ...firstCursor, checkpointRevision: "3" }
      }
    };
    const staleStore = new RagGenerationLifecycleRpcStore({
      rpc: vi.fn().mockResolvedValue(staleJump)
    });
    await expect(
      staleStore.listMaintenanceCandidates({
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        phase: RagMaintenancePhase.SEED,
        pageRequestId: PAGE_REQUEST,
        cursor: firstCursor,
        limit: 10
      })
    ).rejects.toBeInstanceOf(RagGenerationLifecycleContractError);
  });

  it("maps ensure, seed, fail, and activate without numeric revision coercion", async () => {
    const responses = [
      {
        generationId: GENERATION,
        state: "building",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        envelopeSchemaVersion: 1,
        expectedNoteCount: 2,
        indexedNoteCount: 0,
        revisionToken: "9223372036854775806",
        replayed: false
      },
      {
        batchId: BATCH,
        generationId: GENERATION,
        revisionToken: "9223372036854775807",
        eligibleNoteCount: 2,
        examinedCount: 1,
        enqueuedCount: 1,
        hasMore: true,
        complete: false,
        nextCursor: {
          generationId: GENERATION,
          revisionToken: "9223372036854775807",
          afterNoteId: NOTE
        },
        blocked: false,
        failureCode: null,
        replayed: false
      },
      {
        generationId: GENERATION,
        state: "failed",
        revisionToken: "12",
        failureCode: "validation_failed",
        replayed: false
      },
      {
        generationId: GENERATION,
        revisionToken: "13",
        coverageVerified: true,
        replayed: false
      }
    ];
    const rpc = vi.fn();
    for (const response of responses) rpc.mockResolvedValueOnce(response);
    const store = new RagGenerationLifecycleRpcStore({ rpc });

    await expect(
      store.ensureGeneration({
        ownerId: OWNER,
        generationId: GENERATION,
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1536
      })
    ).resolves.toEqual(responses[0]);
    await expect(
      store.seedGeneration({
        ownerId: OWNER,
        generationId: GENERATION,
        expectedRevisionToken: "9223372036854775806",
        batchId: BATCH,
        cursor: null,
        limit: 1
      })
    ).resolves.toEqual(responses[1]);
    await expect(
      store.failGeneration({
        ownerId: OWNER,
        generationId: GENERATION,
        expectedRevisionToken: "11",
        failureCode: "validation_failed"
      })
    ).resolves.toEqual(responses[2]);
    await expect(
      store.activateGeneration({
        ownerId: OWNER,
        generationId: GENERATION,
        expectedRevisionToken: "12"
      })
    ).resolves.toEqual(responses[3]);

    expect(rpc.mock.calls).toEqual([
      [
        "ensure_rag_index_generation",
        {
          p_owner_id: OWNER,
          p_generation_id: GENERATION,
          p_embedding_model_id: "text-embedding-3-small",
          p_embedding_dimensions: 1536
        }
      ],
      [
        "seed_rag_index_generation",
        {
          p_owner_id: OWNER,
          p_generation_id: GENERATION,
          p_expected_revision_token: "9223372036854775806",
          p_batch_id: BATCH,
          p_cursor: null,
          p_limit: 1
        }
      ],
      [
        "fail_rag_index_generation",
        {
          p_owner_id: OWNER,
          p_generation_id: GENERATION,
          p_expected_revision_token: "11",
          p_failure_code: "validation_failed"
        }
      ],
      [
        "activate_rag_index_generation",
        {
          p_owner_id: OWNER,
          p_generation_id: GENERATION,
          p_expected_revision_token: "12"
        }
      ]
    ]);
  });

  it("rejects shape drift, incoherent counts/cursors, and unsafe bigint transport", async () => {
    const base = maintenancePage();
    const invalidValues: readonly unknown[] = [
      { ...base, extra: "private-canary" },
      { ...base, target: { ...base.target, envelopeSchemaVersion: 2 } },
      { ...base, target: { ...base.target, phase: RagMaintenancePhase.VERIFY } },
      { ...base, page: { ...base.page, requestId: BATCH } },
      {
        ...base,
        candidates: [
          {
            ...base.candidates[0],
            buildingGeneration: {
              ...base.candidates[0]?.buildingGeneration,
              indexedNoteCount: 3,
              expectedNoteCount: 2
            }
          }
        ]
      },
      {
        ...base,
        page: { ...base.page, returnedCount: 0 }
      },
      {
        ...base,
        page: { ...base.page, hasMore: false }
      },
      {
        ...base,
        candidates: [
          {
            ...base.candidates[0],
            buildingGeneration: {
              ...base.candidates[0]?.buildingGeneration,
              revisionToken: Number.MAX_SAFE_INTEGER
            }
          }
        ]
      }
    ];
    for (const value of invalidValues) {
      const store = new RagGenerationLifecycleRpcStore({ rpc: vi.fn().mockResolvedValue(value) });
      const reason = await store
        .listMaintenanceCandidates({
          embeddingModelId: "text-embedding-3-small",
          embeddingDimensions: 1536,
          phase: RagMaintenancePhase.SEED,
          pageRequestId: PAGE_REQUEST,
          cursor: null,
          limit: 10
        })
        .catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(RagGenerationLifecycleContractError);
      expect(String(reason)).not.toContain("private-canary");
    }
  });

  it("requires seed pagination and replay fields to remain mutually coherent", async () => {
    const invalidSeeds = [
      {
        batchId: BATCH,
        generationId: GENERATION,
        revisionToken: "1",
        eligibleNoteCount: 1,
        examinedCount: 1,
        enqueuedCount: 2,
        hasMore: false,
        complete: true,
        nextCursor: null,
        blocked: false,
        failureCode: null,
        replayed: false
      },
      {
        batchId: BATCH,
        generationId: GENERATION,
        revisionToken: "1",
        eligibleNoteCount: 1,
        examinedCount: 1,
        enqueuedCount: 1,
        hasMore: true,
        complete: true,
        nextCursor: {
          generationId: GENERATION,
          revisionToken: "1",
          afterNoteId: NOTE
        },
        blocked: false,
        failureCode: null,
        replayed: false
      },
      {
        batchId: BATCH,
        generationId: GENERATION,
        revisionToken: "1",
        eligibleNoteCount: 1,
        examinedCount: 1,
        enqueuedCount: 1,
        hasMore: false,
        complete: true,
        nextCursor: {
          generationId: GENERATION,
          revisionToken: "1",
          afterNoteId: NOTE
        },
        blocked: false,
        failureCode: null,
        replayed: false
      },
      {
        batchId: BATCH,
        generationId: GENERATION,
        revisionToken: "1",
        eligibleNoteCount: 1,
        examinedCount: 0,
        enqueuedCount: 0,
        hasMore: false,
        complete: false,
        nextCursor: null,
        blocked: false,
        failureCode: "validation_failed",
        replayed: false
      },
      {
        batchId: BATCH,
        generationId: GENERATION,
        revisionToken: "1",
        eligibleNoteCount: 1,
        examinedCount: 1,
        enqueuedCount: 0,
        hasMore: false,
        complete: false,
        nextCursor: null,
        blocked: true,
        failureCode: "validation_failed",
        replayed: false
      }
    ];
    for (const value of invalidSeeds) {
      const store = new RagGenerationLifecycleRpcStore({ rpc: vi.fn().mockResolvedValue(value) });
      await expect(
        store.seedGeneration({
          ownerId: OWNER,
          generationId: GENERATION,
          expectedRevisionToken: "0",
          batchId: BATCH,
          cursor: null,
          limit: 10
        })
      ).rejects.toBeInstanceOf(RagGenerationLifecycleContractError);
    }

    const blocked = {
      batchId: BATCH,
      generationId: GENERATION,
      revisionToken: "1",
      eligibleNoteCount: 1,
      examinedCount: 0,
      enqueuedCount: 0,
      hasMore: false,
      complete: false,
      nextCursor: null,
      blocked: true,
      failureCode: "validation_failed",
      replayed: true
    };
    const store = new RagGenerationLifecycleRpcStore({
      rpc: vi.fn().mockResolvedValue(blocked)
    });
    await expect(
      store.seedGeneration({
        ownerId: OWNER,
        generationId: GENERATION,
        expectedRevisionToken: "1",
        batchId: BATCH,
        cursor: null,
        limit: 10
      })
    ).resolves.toEqual(blocked);
  });
});
