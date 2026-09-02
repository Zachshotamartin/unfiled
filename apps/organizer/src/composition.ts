import { randomUUID } from "node:crypto";

import { createProductionOrganizerCipher } from "./cipher.js";
import type { OrganizerConfig } from "./config.js";
import { createOrganizerRepository } from "./database.js";
import { createOrganizerDrain, type OrganizerCipher } from "./drain.js";
import {
  createLocalHashOrganizerEmbeddingProvider,
  createOpenAIOrganizerEmbeddingProvider
} from "./embedding-provider.js";
import { createOrganizerApp, type OrganizerApp } from "./http.js";
import { createVercelTrustedSourcesInvocationAuth } from "./invocation-auth.js";
import {
  createOrganizerKeyManagementAdapter,
  managedKeyRecordParserForOrganizerBoundary
} from "./key-management.js";
import {
  createDeterministicFirstOrganizerPlanner,
  unavailableProductionPlanner,
  type OrganizerPlanner
} from "./planner.js";
import { createPostgresOrganizerExecutor } from "./postgres.js";
import { createOrganizerProviderPlanner } from "./provider-multiplexer.js";
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
  const repository = createOrganizerRepository(
    postgres.executor,
    managedKeyRecordParserForOrganizerBoundary(config.keyBoundary)
  );
  const planner =
    overrides.planner ??
    (config.planner.kind === "lease-bound-provider-registry-v2"
      ? createDeterministicFirstOrganizerPlanner(createOrganizerProviderPlanner())
      : unavailableProductionPlanner);
  const retrieval =
    config.embedding.kind === "disabled"
      ? undefined
      : createOrganizerCandidateRetrieval({
          embeddingProvider:
            config.embedding.kind === "local-hash-v1"
              ? createLocalHashOrganizerEmbeddingProvider()
              : createOpenAIOrganizerEmbeddingProvider({}),
          repository
        });
  const drain = createOrganizerDrain({
    ...(config.planner.kind === "lease-bound-provider-registry-v2"
      ? { appDefaultProviderApiKeys: config.planner.appDefaultApiKeys }
      : {}),
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
