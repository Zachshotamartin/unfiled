/* eslint-disable @typescript-eslint/require-await */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { maxDuration } from "@/app/api/internal/indexing/maintenance/route";
import type { ServiceRpcClient } from "@/server/encryption/service-rpc-client";

import type { IndexVerifierClient } from "./index-verifier-client";
import type { IndexWorkerClient } from "./index-worker-client";
import { createEnvironmentRagGenerationMaintenanceRunner } from "./rag-generation-lifecycle-composition";
import type { RagGenerationMaintenanceRunner } from "./rag-generation-lifecycle-composition";
import type { RagGenerationMaintenanceResult } from "./rag-generation-lifecycle-controller";
import {
  INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS,
  INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS,
  INDEX_VERIFIER_SERVER_TIMEOUT_MS
} from "./index-verifier-client";
import {
  createRagGenerationMaintenanceCronHandler,
  RAG_GENERATION_MAINTENANCE_TIMEOUT_MS,
  type RagGenerationMaintenanceLogEvent
} from "./rag-generation-maintenance-cron-handler";

const AUTH_FIXTURE = "fixture-value-".repeat(4);
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const GENERATION_A = "igen_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const GENERATION_B = "igen_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const GENERATED = "igen_01J6M9Q7G4BMKB33GSG3NJ6D1Z";
const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTRACT_CANARY = "private-note-body-contract-canary";
const ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "production",
  UNFILED_EMBEDDING_MODEL_ID: "text-embedding-3-small",
  UNFILED_EMBEDDING_DIMENSIONS: "1536"
});
const RESULT: RagGenerationMaintenanceResult = Object.freeze({
  activatedGenerations: 1,
  capacityDeferrals: 0,
  capacityGenerationsFailed: 0,
  candidatePages: 1,
  candidatesDeferred: 0,
  candidatesSeen: 1,
  createdGenerations: 1,
  drainClaimed: 1,
  drainCompleted: 1,
  drainFailed: 0,
  drainRetryScheduled: 0,
  drainWaves: 2,
  invalidGenerationsFailed: 0,
  readinessGenerationsFailed: 0,
  replacedGenerations: 0,
  resumedGenerations: 0,
  seedCandidateRetryFailures: 0,
  seedCandidatePagesTruncated: 0,
  seedEnqueued: 1,
  seedExamined: 1,
  seedGenerationsBlocked: 0,
  seedGenerationsComplete: 1,
  seedGenerationsTruncated: 0,
  seedPages: 1,
  verificationCandidatePagesTruncated: 0,
  verificationCandidateRetryFailures: 0,
  verificationDeferred: 0,
  verificationPages: 1,
  verifiedGenerations: 1
});

function request(authorization?: string): Request {
  return new Request("https://unfiled.test/api/internal/indexing/maintenance", {
    headers: authorization === undefined ? {} : { authorization }
  });
}

type ContractDriftOperation = "ensure" | "seed" | "activate";

function lifecycleCandidate(ownerId: string, generationId: string, create: boolean): unknown {
  return {
    ownerId,
    rolloutState: "encrypted_read",
    eligibleNoteCount: 0,
    aiObjectWrapKeyReady: true,
    action: create ? "create_build" : "resume_build",
    activeGeneration: null,
    buildingGeneration: create
      ? null
      : {
          generationId,
          embeddingModelId: "text-embedding-3-small",
          embeddingDimensions: 1_536,
          expectedNoteCount: 0,
          indexedNoteCount: 0,
          revisionToken: "0"
        }
  };
}

function maintenancePage(
  phase: "seed" | "verify",
  requestId: string,
  limit: number,
  operation: ContractDriftOperation
): unknown {
  const visitCandidates =
    (phase === "seed" && operation !== "activate") ||
    (phase === "verify" && operation === "activate");
  const create = operation === "ensure";
  const candidates = visitCandidates
    ? [
        lifecycleCandidate(OWNER_A, GENERATION_A, create),
        lifecycleCandidate(OWNER_B, GENERATION_B, create)
      ]
    : [];
  return {
    target: {
      embeddingModelId: "text-embedding-3-small",
      embeddingDimensions: 1_536,
      envelopeSchemaVersion: 1,
      phase
    },
    candidates,
    page: {
      requestId,
      checkpointRevision: "1",
      limit,
      returnedCount: candidates.length,
      hasMore: false,
      nextCursor: null,
      replayed: false
    }
  };
}

function contractDriftRunner(operation: ContractDriftOperation): Readonly<{
  actionRpc: ReturnType<typeof vi.fn<ServiceRpcClient["rpc"]>>;
  runner: RagGenerationMaintenanceRunner;
  verifier: IndexVerifierClient;
  worker: IndexWorkerClient;
}> {
  const actionFunction =
    operation === "ensure"
      ? "ensure_rag_index_generation"
      : operation === "seed"
        ? "seed_rag_index_generation"
        : "activate_rag_index_generation";
  const actionRpc = vi.fn<ServiceRpcClient["rpc"]>(async (functionName, parameters) => {
    if (functionName === "list_rag_index_maintenance_candidates") {
      const phase = parameters.p_phase;
      const requestId = parameters.p_page_request_id;
      const limit = parameters.p_limit;
      if (
        (phase !== "seed" && phase !== "verify") ||
        typeof requestId !== "string" ||
        typeof limit !== "number"
      ) {
        throw new Error("invalid test lifecycle page request");
      }
      return maintenancePage(phase, requestId, limit, operation);
    }
    if (functionName === actionFunction) return { unexpected: CONTRACT_CANARY };
    throw new Error(`unexpected lifecycle function ${functionName}`);
  });
  const worker: IndexWorkerClient = {
    drain: vi.fn(async () => ({
      claimed: 0,
      completed: 0,
      failed: 0,
      retryScheduled: 0
    }))
  };
  const verifier: IndexVerifierClient = {
    verify: vi.fn<IndexVerifierClient["verify"]>(async (input) => ({
      generationId: input.generationId,
      revisionToken: input.revisionToken,
      verifiedNoteCount: 0,
      verified: true
    }))
  };
  return {
    actionRpc,
    worker,
    verifier,
    runner: createEnvironmentRagGenerationMaintenanceRunner(ENVIRONMENT, {
      worker,
      verifier,
      createServiceClient: () => ({ rpc: actionRpc }),
      createGenerationId: () => GENERATED,
      createBatchId: () => BATCH
    })
  };
}

describe("RAG generation maintenance cron", () => {
  it("rejects missing and incorrect authorization before running maintenance", async () => {
    const runner: RagGenerationMaintenanceRunner = { run: vi.fn() };
    const handler = createRagGenerationMaintenanceCronHandler({
      runner,
      getSecret: () => AUTH_FIXTURE,
      log: vi.fn()
    });

    const missing = await handler(request());
    const incorrect = await handler(request(`Bearer ${"x".repeat(4_000)}`));

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(incorrect.headers.get("cache-control")).toBe("no-store");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("fails closed with no-store when the cron secret is not configured", async () => {
    const runner: RagGenerationMaintenanceRunner = { run: vi.fn() };
    const handler = createRagGenerationMaintenanceCronHandler({
      runner,
      getSecret: () => undefined,
      log: vi.fn()
    });

    const response = await handler(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("returns and logs only content-free aggregate counters", async () => {
    const events: RagGenerationMaintenanceLogEvent[] = [];
    const runner: RagGenerationMaintenanceRunner = { run: vi.fn(async () => RESULT) };
    const handler = createRagGenerationMaintenanceCronHandler({
      runner,
      getSecret: () => AUTH_FIXTURE,
      log: (event) => events.push(event),
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_025)
    });

    const response = await handler(request(`Bearer ${AUTH_FIXTURE}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(RESULT);
    expect(events).toEqual([
      {
        ...RESULT,
        durationMs: 25,
        event: "rag_generation_maintenance.completed",
        outcome: "ok",
        status: 200
      }
    ]);
    expect(JSON.stringify(events)).not.toContain(AUTH_FIXTURE);
    expect(runner.run).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("redacts dependency details from both its response and operational log", async () => {
    const sensitive = "note body and service-role-secret";
    const events: RagGenerationMaintenanceLogEvent[] = [];
    const runner: RagGenerationMaintenanceRunner = {
      run: vi.fn().mockRejectedValue(new Error(sensitive))
    };
    const handler = createRagGenerationMaintenanceCronHandler({
      runner,
      getSecret: () => AUTH_FIXTURE,
      log: (event) => events.push(event)
    });

    const response = await handler(request(`Bearer ${AUTH_FIXTURE}`));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(serialized).not.toContain(sensitive);
    expect(JSON.stringify(events)).not.toContain(sensitive);
    expect(events[0]).toMatchObject({ outcome: "error", errorClass: "unknown", status: 500 });
  });

  it.each(["ensure", "seed", "activate"] as const)(
    "fails the cron closed when a real lifecycle %s response drifts before the later owner",
    async (operation) => {
      const events: RagGenerationMaintenanceLogEvent[] = [];
      const fixture = contractDriftRunner(operation);
      const handler = createRagGenerationMaintenanceCronHandler({
        runner: fixture.runner,
        getSecret: () => AUTH_FIXTURE,
        log: (event) => events.push(event)
      });

      const response = await handler(request(`Bearer ${AUTH_FIXTURE}`));
      const serializedResponse = JSON.stringify(await response.json());
      const actionFunction =
        operation === "ensure"
          ? "ensure_rag_index_generation"
          : operation === "seed"
            ? "seed_rag_index_generation"
            : "activate_rag_index_generation";
      const actionCalls = fixture.actionRpc.mock.calls.filter(
        ([functionName]) => functionName === actionFunction
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(serializedResponse).not.toContain(CONTRACT_CANARY);
      expect(JSON.stringify(events)).not.toContain(CONTRACT_CANARY);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        outcome: "error",
        errorClass: "dependency",
        status: 503
      });
      expect(actionCalls).toHaveLength(1);
      expect(actionCalls[0]?.[1]).toMatchObject({ p_owner_id: OWNER_A });
      expect(actionCalls[0]?.[1]).not.toMatchObject({ p_owner_id: OWNER_B });
      expect(fixture.worker.drain).not.toHaveBeenCalled();
      if (operation === "activate") {
        expect(fixture.verifier.verify).toHaveBeenCalledOnce();
        expect(fixture.verifier.verify).toHaveBeenCalledWith(
          expect.objectContaining({ ownerId: OWNER_A }),
          expect.any(AbortSignal)
        );
      } else {
        expect(fixture.verifier.verify).not.toHaveBeenCalled();
      }
    }
  );

  it("orders verifier, caller, maintenance, and function deadlines with headroom", () => {
    expect(maxDuration).toBe(60);
    expect(INDEX_VERIFIER_SERVER_TIMEOUT_MS).toBe(49_000);
    expect(INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS).toBe(54_000);
    expect(INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS).toBe(54_000);
    expect(RAG_GENERATION_MAINTENANCE_TIMEOUT_MS).toBe(55_000);
    expect(INDEX_VERIFIER_SERVER_TIMEOUT_MS).toBeLessThan(INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS);
    expect(INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS).toBeLessThan(
      RAG_GENERATION_MAINTENANCE_TIMEOUT_MS
    );
    expect(RAG_GENERATION_MAINTENANCE_TIMEOUT_MS).toBeLessThan(maxDuration * 1_000);
  });

  it("separates daily maintenance from recovery by an hour", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8")
    ) as Readonly<{ crons: readonly Readonly<{ path: string; schedule: string }>[] }>;
    expect(
      config.crons.find(({ path }) => path === "/api/internal/indexing/maintenance")?.schedule
    ).toBe("22 2 * * *");
    expect(config.crons.find(({ path }) => path === "/api/internal/indexing/drain")?.schedule).toBe(
      "27 3 * * *"
    );
  });
});
