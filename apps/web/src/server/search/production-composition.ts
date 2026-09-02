import type { RepositoryContext } from "@/server/product/repository";

import {
  createEncryptedUserSearchCapabilityRpcAdapter,
  createEncryptedUserSearchCapabilityRpcClient
} from "./capability-rpc-adapter";
import { createEnvironmentEncryptedUserSearchClient } from "./search-client";
import { SemanticSearchCoordinator } from "./semantic-search-coordinator";

/** Request-scoped Production/Preview composition; no search authority is cached. */
export function createProductionSemanticSearchCoordinator(
  context: RepositoryContext,
  signal: AbortSignal
): SemanticSearchCoordinator {
  const capability = createEncryptedUserSearchCapabilityRpcAdapter(
    createEncryptedUserSearchCapabilityRpcClient({ signal })
  );
  return new SemanticSearchCoordinator({
    capability,
    client: createEnvironmentEncryptedUserSearchClient(),
    ownerId: context.userId
  });
}
