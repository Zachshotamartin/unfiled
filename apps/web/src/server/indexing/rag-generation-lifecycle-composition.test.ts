/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/server/api/errors";
import type {
  ServiceRpcClient,
  ServiceRpcClientOptions
} from "@/server/encryption/service-rpc-client";

import type { IndexVerifierClient } from "./index-verifier-client";
import type { IndexWorkerClient } from "./index-worker-client";
import { createEnvironmentRagGenerationMaintenanceRunner } from "./rag-generation-lifecycle-composition";
import { ragGenerationLifecycleRpcFunctions } from "./rag-generation-lifecycle-store";

const ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "production",
  UNFILED_EMBEDDING_MODEL_ID: "text-embedding-3-small",
  UNFILED_EMBEDDING_DIMENSIONS: "1536"
});

const worker: IndexWorkerClient = { drain: vi.fn() };
const verifier: IndexVerifierClient = { verify: vi.fn() };

describe("RAG generation lifecycle production composition", () => {
  it.each([
    [{ ...ENVIRONMENT, NODE_ENV: "test" }],
    [{ ...ENVIRONMENT, VERCEL: "0" }],
    [{ ...ENVIRONMENT, VERCEL_ENV: "preview" }],
    [{ ...ENVIRONMENT, UNFILED_EMBEDDING_MODEL_ID: "bad model" }],
    [{ ...ENVIRONMENT, UNFILED_EMBEDDING_DIMENSIONS: "0" }],
    [{ ...ENVIRONMENT, UNFILED_EMBEDDING_DIMENSIONS: "1536.5" }],
    [{ ...ENVIRONMENT, UNFILED_OPENAI_EMBEDDING_API_KEY: "must-not-enter-web" }]
  ])("rejects non-production or worker-incompatible target config", (environment) => {
    expect(() =>
      createEnvironmentRagGenerationMaintenanceRunner(environment, { worker, verifier })
    ).toThrow(ConfigurationError);
  });

  it("binds the service role client to only the exact five lifecycle RPCs and worker target", async () => {
    const createServiceClient = vi.fn<(options: ServiceRpcClientOptions) => ServiceRpcClient>(
      () => ({
        rpc: vi.fn(
          async (
            functionName: string,
            parameters: Readonly<Record<string, unknown>>
          ): Promise<unknown> => {
            expect(functionName).toBe("list_rag_index_maintenance_candidates");
            expect(parameters).toMatchObject({
              p_embedding_model_id: "text-embedding-3-small",
              p_embedding_dimensions: 1_536,
              p_cursor: null,
              p_limit: 10
            });
            const phase = parameters.p_phase;
            const pageRequestId = parameters.p_page_request_id;
            if ((phase !== "seed" && phase !== "verify") || typeof pageRequestId !== "string") {
              throw new Error("invalid lifecycle paging request");
            }
            expect(pageRequestId).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
            );
            return {
              target: {
                embeddingModelId: "text-embedding-3-small",
                embeddingDimensions: 1_536,
                envelopeSchemaVersion: 1,
                phase
              },
              candidates: [],
              page: {
                requestId: pageRequestId,
                checkpointRevision: "1",
                limit: 10,
                returnedCount: 0,
                hasMore: false,
                nextCursor: null,
                replayed: false
              }
            };
          }
        )
      })
    );
    const signal = new AbortController().signal;
    const runner = createEnvironmentRagGenerationMaintenanceRunner(ENVIRONMENT, {
      worker,
      verifier,
      createServiceClient
    });

    const result = await runner.run(signal);

    expect(result.candidatesSeen).toBe(0);
    expect(createServiceClient).toHaveBeenCalledOnce();
    const options = createServiceClient.mock.calls[0]?.[0];
    expect(options?.allowedFunctions).toEqual(ragGenerationLifecycleRpcFunctions);
    expect(options?.allowedFunctions).toHaveLength(5);
    expect(options?.signal).toBe(signal);
    expect(new Set(options?.allowedFunctions)).toEqual(
      new Set([
        "list_rag_index_maintenance_candidates",
        "ensure_rag_index_generation",
        "seed_rag_index_generation",
        "fail_rag_index_generation",
        "activate_rag_index_generation"
      ])
    );
  });
});
