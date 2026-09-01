import { randomUUID } from "node:crypto";

import { createProductionOrganizerCipher } from "./cipher.js";
import type { OrganizerConfig } from "./config.js";
import { createOrganizerRepository } from "./database.js";
import { createOrganizerDrain, type OrganizerCipher } from "./drain.js";
import { createOpenAIOrganizerEmbeddingProvider } from "./embedding-provider.js";
import { createOrganizerApp, type OrganizerApp } from "./http.js";
import { createVercelTrustedSourcesInvocationAuth } from "./invocation-auth.js";
import { createOrganizerKeyManagementAdapter } from "./key-management.js";
import { createOpenAIOrganizerPlanner } from "./openai-planner.js";
import {
  createDeterministicFirstOrganizerPlanner,
  unavailableProductionPlanner,
  type OrganizerPlanner
} from "./planner.js";
import { createPostgresOrganizerExecutor } from "./postgres.js";
import { createOrganizerCandidateRetrieval } from "./retrieval.js";

export type OrganizerComposition = Readonly<{ app: OrganizerApp; close(): Promise<void> }>;
export type OrganizerCompositionOverrides = Readonly<{
  cipher?: OrganizerCipher;
  planner?: OrganizerPlanner;
}>;

export function createOrganizerComposition(
  config: OrganizerConfig,
  overrides: OrganizerCompositionOverrides = {}
): OrganizerComposition {
  const keyManagement = createOrganizerKeyManagementAdapter();
  const appConfig: OrganizerConfig =
    config.planner.kind === "disabled"
      ? config
      : Object.freeze({ ...config, planner: Object.freeze({ kind: "disabled" }) });
  const productionInvocationAuth =
    config.invocationAuth.kind === "production-trusted-source"
      ? createVercelTrustedSourcesInvocationAuth({
          trustedSource: config.invocationAuth.trustedSource
        })
      : undefined;
  if (config.pipeline.kind === "disabled") {
    return Object.freeze({
      app: createOrganizerApp({
        config: appConfig,
        keyManagement,
        ...(productionInvocationAuth === undefined ? {} : { productionInvocationAuth })
      }),
      close: () => Promise.resolve()
    });
  }
  const postgres = createPostgresOrganizerExecutor(config.pipeline.database);
  const repository = createOrganizerRepository(postgres.executor);
  const planner =
    overrides.planner ??
    (config.planner.kind === "openai-responses"
      ? createDeterministicFirstOrganizerPlanner(
          createOpenAIOrganizerPlanner({ apiKey: config.planner.apiKey })
        )
      : unavailableProductionPlanner);
  const retrieval =
    config.planner.kind === "openai-responses"
      ? createOrganizerCandidateRetrieval({
          embeddingProvider: createOpenAIOrganizerEmbeddingProvider({
            apiKey: config.planner.apiKey
          }),
          repository
        })
      : undefined;
  const drain = createOrganizerDrain({
    cipher: overrides.cipher ?? createProductionOrganizerCipher(),
    claimLimit: config.pipeline.claimLimit,
    concurrency: config.pipeline.concurrency,
    leaseSeconds: config.pipeline.leaseSeconds,
    planner,
    recoveryLimit: config.pipeline.recoveryLimit,
    repository,
    ...(retrieval === undefined ? {} : { retrieval }),
    workerId: `organizer-${randomUUID()}`
  });
  return Object.freeze({
    app: createOrganizerApp({
      config: appConfig,
      drain,
      keyManagement,
      ...(productionInvocationAuth === undefined ? {} : { productionInvocationAuth })
    }),
    async close() {
      retrieval?.close();
      await postgres.close();
    }
  });
}
