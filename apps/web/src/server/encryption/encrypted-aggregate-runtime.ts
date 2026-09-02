import {
  authorizeAggregateOwner,
  createEncryptedAggregateService,
  EncryptedAggregateError,
  EncryptedAggregateErrorCode,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateService,
  type ObjectWrapReservation
} from "@unfiled/encrypted-aggregate";
import { createManagedKeyResolver, parseManagedKeyRecordV2 } from "@unfiled/key-management";

import { ensureOwnerContentKeys, managedKeyBootstrapRpcFunctions } from "./managed-key-bootstrap";
import {
  createManagedKeyRpcStore,
  createObjectWrapReservationPort,
  managedKeyRpcFunctions
} from "./managed-key-rpc-store";
import type { ManagedKeyRecordSchemaVersion } from "./managed-key-record";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";
import type { InteractiveWebKeyRuntime } from "./web-key-runtime";

export type OwnerEncryptedAggregateRuntime = Readonly<{
  access: AuthorizedOwnerAccess;
  createPreparedService(
    reservations: readonly ObjectWrapReservation[]
  ): PreparedOwnerEncryptedAggregateService;
  service: EncryptedAggregateService;
}>;

export type PreparedOwnerEncryptedAggregateService = Readonly<{
  assertConsumed(): void;
  service: EncryptedAggregateService;
}>;

export type WithOwnerEncryptedAggregateRuntimeOptions = Readonly<{
  signal: AbortSignal;
}>;

function aggregateRuntime(
  ownerId: string,
  keyResolver: Parameters<typeof createEncryptedAggregateService>[0]["keyResolver"],
  client: ServiceRpcClient,
  schemaVersion: ManagedKeyRecordSchemaVersion = 1
): OwnerEncryptedAggregateRuntime {
  const store = createManagedKeyRpcStore(client, { schemaVersion });
  const createPreparedService = (
    reservations: readonly ObjectWrapReservation[]
  ): PreparedOwnerEncryptedAggregateService => {
    const plan = reservations.map((reservation) =>
      Object.freeze({
        reservationId: reservation.reservationId,
        reference: Object.freeze({ ...reservation.reference }),
        ...(reservation.groupUse === undefined
          ? {}
          : { groupUse: Object.freeze({ ...reservation.groupUse }) })
      })
    ) as readonly ObjectWrapReservation[];
    let index = 0;
    let asserted = false;
    const service = createEncryptedAggregateService({
      keyResolver,
      objectWrapReservations: Object.freeze({
        reserveObjectWrappingKey(): Promise<ObjectWrapReservation> {
          if (asserted || index >= plan.length) {
            return Promise.reject(
              new EncryptedAggregateError(
                EncryptedAggregateErrorCode.RESERVATION_INVALID,
                "Prepared reservation plan is unavailable"
              )
            );
          }
          const reservation = plan[index];
          if (reservation === undefined) {
            return Promise.reject(
              new EncryptedAggregateError(
                EncryptedAggregateErrorCode.RESERVATION_INVALID,
                "Prepared reservation plan is unavailable"
              )
            );
          }
          index += 1;
          return Promise.resolve(reservation);
        }
      })
    });
    return Object.freeze({
      service,
      assertConsumed(): void {
        if (asserted || index !== plan.length) {
          throw new EncryptedAggregateError(
            EncryptedAggregateErrorCode.RESERVATION_INVALID,
            "Prepared reservation plan was not consumed exactly"
          );
        }
        asserted = true;
      }
    });
  };
  return Object.freeze({
    access: authorizeAggregateOwner({
      authenticatedOwnerId: ownerId,
      resourceOwnerId: ownerId
    }),
    createPreparedService,
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

  if (runtime.kind === "aws-oidc") {
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

  return runtime.withInteractiveCustodian(options.signal, async (custodian) => {
    const store = createManagedKeyRpcStore(client, { schemaVersion: 2 });
    await ensureOwnerContentKeys(client, custodian, store, ownerId, {
      schemaVersion: 2,
      signal: options.signal
    });
    const keyResolver = createManagedKeyResolver({
      custodian,
      parseRecord: parseManagedKeyRecordV2,
      store,
      workload: "interactive_api"
    });
    return use(aggregateRuntime(ownerId, keyResolver, client, 2));
  });
}

export const encryptedAggregateRuntimeRpcFunctions = Object.freeze([
  ...managedKeyRpcFunctions,
  ...managedKeyBootstrapRpcFunctions
] as const);
