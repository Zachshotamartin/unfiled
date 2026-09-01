import { randomUUID } from "node:crypto";

import type { OrganizerConfig } from "./config.js";
import { createOrganizerRepository } from "./database.js";
import { createOrganizerDrain, unavailableOrganizerCipher, type OrganizerCipher } from "./drain.js";
import { createOrganizerApp, type OrganizerApp } from "./http.js";
import { createVercelTrustedSourcesInvocationAuth } from "./invocation-auth.js";
import { createOrganizerKeyManagementAdapter } from "./key-management.js";
import { unavailableProductionPlanner, type OrganizerPlanner } from "./planner.js";
import { createPostgresOrganizerExecutor } from "./postgres.js";

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
  const productionInvocationAuth =
    config.invocationAuth.kind === "production-trusted-source"
      ? createVercelTrustedSourcesInvocationAuth({
          trustedSource: config.invocationAuth.trustedSource
        })
      : undefined;
  if (config.pipeline.kind === "disabled") {
    return Object.freeze({
      app: createOrganizerApp({
        config,
        keyManagement,
        ...(productionInvocationAuth === undefined ? {} : { productionInvocationAuth })
      }),
      close: () => Promise.resolve()
    });
  }
  const postgres = createPostgresOrganizerExecutor(config.pipeline.database);
  const repository = createOrganizerRepository(postgres.executor);
  const drain = createOrganizerDrain({
    cipher: overrides.cipher ?? unavailableOrganizerCipher,
    claimLimit: config.pipeline.claimLimit,
    concurrency: config.pipeline.concurrency,
    leaseSeconds: config.pipeline.leaseSeconds,
    planner: overrides.planner ?? unavailableProductionPlanner,
    recoveryLimit: config.pipeline.recoveryLimit,
    repository,
    workerId: `organizer-${randomUUID()}`
  });
  return Object.freeze({
    app: createOrganizerApp({
      config,
      drain,
      keyManagement,
      ...(productionInvocationAuth === undefined ? {} : { productionInvocationAuth })
    }),
    close: postgres.close
  });
}
