import { ConfigurationError } from "@/server/api/errors";
import {
  createServiceRpcClient,
  type ServiceRpcClient,
  type ServiceRpcClientOptions
} from "@/server/encryption/service-rpc-client";

import {
  createEnvironmentIndexVerifierClient,
  type IndexVerifierClient
} from "./index-verifier-client";
import { createEnvironmentIndexWorkerClient, type IndexWorkerClient } from "./index-worker-client";
import {
  runRagGenerationMaintenance,
  type RagGenerationMaintenanceBounds,
  type RagGenerationMaintenanceResult
} from "./rag-generation-lifecycle-controller";
import {
  RagGenerationLifecycleRpcStore,
  ragGenerationLifecycleRpcFunctions,
  type RagGenerationTarget
} from "./rag-generation-lifecycle-store";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type RagGenerationMaintenanceEnvironment = Readonly<Record<string, string | undefined>>;

export type RagGenerationMaintenanceRunner = Readonly<{
  run(signal: AbortSignal): Promise<RagGenerationMaintenanceResult>;
}>;

export type RagGenerationMaintenanceCompositionDependencies = Readonly<{
  bounds?: Partial<RagGenerationMaintenanceBounds>;
  createBatchId?: () => string;
  createGenerationId?: () => string;
  createServiceClient?: (options: ServiceRpcClientOptions) => ServiceRpcClient;
  verifier?: IndexVerifierClient;
  worker?: IndexWorkerClient;
}>;

function targetFromEnvironment(
  environment: RagGenerationMaintenanceEnvironment
): RagGenerationTarget {
  if (
    environment.NODE_ENV !== "production" ||
    environment.VERCEL !== "1" ||
    environment.VERCEL_ENV !== "production" ||
    (environment.UNFILED_OPENAI_EMBEDDING_API_KEY?.trim().length ?? 0) > 0
  ) {
    throw new ConfigurationError();
  }
  const embeddingModelId = environment.UNFILED_EMBEDDING_MODEL_ID?.trim();
  const rawDimensions = environment.UNFILED_EMBEDDING_DIMENSIONS?.trim();
  if (
    embeddingModelId === undefined ||
    !MODEL_ID_PATTERN.test(embeddingModelId) ||
    rawDimensions === undefined ||
    !/^\d+$/u.test(rawDimensions)
  ) {
    throw new ConfigurationError();
  }
  const embeddingDimensions = Number(rawDimensions);
  if (
    !Number.isSafeInteger(embeddingDimensions) ||
    embeddingDimensions < 1 ||
    embeddingDimensions > 4_096
  ) {
    throw new ConfigurationError();
  }
  return Object.freeze({ embeddingModelId, embeddingDimensions, envelopeSchemaVersion: 1 });
}

export function createEnvironmentRagGenerationMaintenanceRunner(
  environment: RagGenerationMaintenanceEnvironment = process.env,
  dependencies: RagGenerationMaintenanceCompositionDependencies = {}
): RagGenerationMaintenanceRunner {
  const target = targetFromEnvironment(environment);
  const worker = dependencies.worker ?? createEnvironmentIndexWorkerClient(environment);
  const verifier = dependencies.verifier ?? createEnvironmentIndexVerifierClient(environment);
  const createClient = dependencies.createServiceClient ?? createServiceRpcClient;
  return Object.freeze({
    run(signal): Promise<RagGenerationMaintenanceResult> {
      const client = createClient({
        allowedFunctions: ragGenerationLifecycleRpcFunctions,
        environment,
        signal
      });
      return runRagGenerationMaintenance({
        lifecycle: new RagGenerationLifecycleRpcStore(client),
        target,
        worker,
        verifier,
        signal,
        ...(dependencies.bounds === undefined ? {} : { bounds: dependencies.bounds }),
        ...(dependencies.createBatchId === undefined
          ? {}
          : { createBatchId: dependencies.createBatchId }),
        ...(dependencies.createGenerationId === undefined
          ? {}
          : { createGenerationId: dependencies.createGenerationId })
      });
    }
  });
}

export const environmentRagGenerationMaintenanceRunner: RagGenerationMaintenanceRunner =
  Object.freeze({
    run(signal) {
      return createEnvironmentRagGenerationMaintenanceRunner().run(signal);
    }
  });
