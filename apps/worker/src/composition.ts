import { randomUUID } from "node:crypto";

import type { WorkerConfig } from "./config.js";
import { WorkerConfigurationError } from "./errors.js";
import { createOpenAiEmbeddingProvider } from "./embedding-provider.js";
import { createWorkerApp, type WorkerApp } from "./http.js";
import { createManagedIndexCryptoFactory } from "./index-crypto.js";
import { createNoteIndexRepository } from "./index-database.js";
import { createNoteIndexDrain } from "./index-drain.js";
import { createVercelTrustedSourcesInvocationAuth } from "./invocation-auth-adapter.js";
import { createWorkerKeyManagementAdapter } from "./key-management-adapter.js";
import { createPostgresIndexExecutor } from "./postgres-index-executor.js";

export type WorkerComposition = Readonly<{
  app: WorkerApp;
  close(): Promise<void>;
}>;

export function createWorkerComposition(config: WorkerConfig): WorkerComposition {
  const keyManagement = createWorkerKeyManagementAdapter();
  const productionInvocationAuth =
    config.invocationAuth.kind === "production-verifier"
      ? createVercelTrustedSourcesInvocationAuth({
          trustedSource: config.invocationAuth.trustedSource
        })
      : undefined;

  if (config.indexing.kind === "disabled") {
    return Object.freeze({
      app: createWorkerApp({
        config,
        keyManagement,
        ...(productionInvocationAuth === undefined ? {} : { productionInvocationAuth })
      }),
      close(): Promise<void> {
        return Promise.resolve();
      }
    });
  }

  if (config.runtime !== "production") {
    throw new WorkerConfigurationError(["UNFILED_WORKER_ENV"]);
  }

  const postgres = createPostgresIndexExecutor(config.indexing.database);
  const repository = createNoteIndexRepository(postgres.executor);
  const embedding = createOpenAiEmbeddingProvider(config.indexing.embedding);
  const drain = createNoteIndexDrain({
    claimLimit: config.indexing.claimLimit,
    concurrency: config.indexing.concurrency,
    cryptoForAuthority: createManagedIndexCryptoFactory,
    embedding,
    embeddingDimensions: config.indexing.embedding.dimensions,
    embeddingMaxInputBytes: config.indexing.embedding.maxInputBytes,
    embeddingModelId: config.indexing.embedding.modelId,
    leaseSeconds: config.indexing.leaseSeconds,
    recoveryLimit: config.indexing.recoveryLimit,
    repository,
    workerId: `index-${randomUUID()}`
  });
  return Object.freeze({
    app: createWorkerApp({
      config,
      drain,
      keyManagement,
      ...(productionInvocationAuth === undefined ? {} : { productionInvocationAuth })
    }),
    close: postgres.close
  });
}
