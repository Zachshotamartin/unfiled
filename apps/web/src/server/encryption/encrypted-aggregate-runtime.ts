import {
  authorizeAggregateOwner,
  createEncryptedAggregateService,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";
import { createManagedKeyResolver } from "@unfiled/key-management";

import { ensureOwnerContentKeys, managedKeyBootstrapRpcFunctions } from "./managed-key-bootstrap";
import {
  createManagedKeyRpcStore,
  createObjectWrapReservationPort,
  managedKeyRpcFunctions
} from "./managed-key-rpc-store";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";
import type { InteractiveWebKeyRuntime } from "./web-key-runtime";

export type OwnerEncryptedAggregateRuntime = Readonly<{
  access: AuthorizedOwnerAccess;
  service: EncryptedAggregateService;
}>;

export type WithOwnerEncryptedAggregateRuntimeOptions = Readonly<{
  signal: AbortSignal;
}>;

function aggregateRuntime(
  ownerId: string,
  keyResolver: Parameters<typeof createEncryptedAggregateService>[0]["keyResolver"],
  client: ServiceRpcClient
): OwnerEncryptedAggregateRuntime {
  const store = createManagedKeyRpcStore(client);
  return Object.freeze({
    access: authorizeAggregateOwner({
      authenticatedOwnerId: ownerId,
      resourceOwnerId: ownerId
    }),
    service: createEncryptedAggregateService({
      keyResolver,
      objectWrapReservations: createObjectWrapReservationPort(client, store)
    })
  });
}

/**
 * Scopes production KMS credentials and plaintext intermediate-key access to a
 * single authenticated operation. The returned aggregate service is usable
 * only inside `use`; the production custodian lease is revoked afterward.
 */
export async function withOwnerEncryptedAggregateRuntime<Result>(
  runtime: InteractiveWebKeyRuntime,
  client: ServiceRpcClient,
  ownerId: string,
  options: WithOwnerEncryptedAggregateRuntimeOptions,
  use: (runtime: OwnerEncryptedAggregateRuntime) => Promise<Result>
): Promise<Result> {
  if (runtime.kind === "local") {
    if (options.signal.aborted) {
      throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
    }
    return use(aggregateRuntime(ownerId, runtime.keyResolver, client));
  }

  return runtime.withInteractiveCustodian(options.signal, async (custodian) => {
    const store = createManagedKeyRpcStore(client);
    await ensureOwnerContentKeys(client, custodian, store, ownerId, {
      signal: options.signal
    });
    const keyResolver = createManagedKeyResolver({
      custodian,
      store,
      workload: "interactive_api"
    });
    return use(aggregateRuntime(ownerId, keyResolver, client));
  });
}

export const encryptedAggregateRuntimeRpcFunctions = Object.freeze([
  ...managedKeyRpcFunctions,
  ...managedKeyBootstrapRpcFunctions
] as const);
