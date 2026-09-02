import { encryptedAggregateRuntimeRpcFunctions } from "@/server/encryption/encrypted-aggregate-runtime";
import {
  createManagedOwnerKeyBootstrap,
  freshOwnerOnboardingEnabled,
  freshOwnerOnboardingRpcFunctions,
  FreshOwnerOnboardingRolloutSource
} from "@/server/encryption/fresh-owner-onboarding";
import { ManagedEncryptedNoteRepository } from "@/server/encryption/managed-encrypted-note-repository";
import {
  ContentEncryptionRolloutRpcSource,
  rolloutRpcFunctions
} from "@/server/encryption/rollout-rpc-source";
import { createServiceRpcClient } from "@/server/encryption/service-rpc-client";
import type { WebKeyRuntimeEnvironment } from "@/server/encryption/web-key-runtime";

import type { ManualNotesRepository } from "./repository";
import {
  CapabilityGuardedEncryptionRolloutStateSource,
  RolloutAwareManualNotesRepository,
  type RepositoryMethod
} from "./rollout-aware-repository";

export const productionManualNotesUnavailableEncryptedMethods = Object.freeze(
  [] as const satisfies readonly RepositoryMethod[]
);

export const productionManualNotesCapabilityReadiness = Object.freeze({
  unavailableMethods: productionManualNotesUnavailableEncryptedMethods
});

export type ProductionManualNotesCompositionOptions = Readonly<{
  /** The expanded/dual-write read adapter retained only for the rollback window. */
  legacy: ManualNotesRepository;
  /** Test seam; production always constructs the managed, no-fallback adapter. */
  encrypted?: ManualNotesRepository;
  environment?: WebKeyRuntimeEnvironment;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Drives owners with no legacy objects through the official rollout on first
   * use. Defaults to "no legacy content key is configured"; test seam otherwise.
   */
  freshOwnerOnboarding?: boolean;
}>;

/**
 * Composes one request-scoped manual-note repository. Rollout is read through a
 * separately allowlisted service client for every operation, and any lookup,
 * KMS, RPC, or capability-readiness failure propagates without legacy fallback.
 */
export function createProductionManualNotesComposition(
  options: ProductionManualNotesCompositionOptions
): ManualNotesRepository {
  const signal = options.signal;
  const clientOptions = {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(signal === undefined ? {} : { signal })
  };
  const rolloutClient = createServiceRpcClient({
    allowedFunctions: rolloutRpcFunctions,
    ...clientOptions
  });
  const onboarding = new FreshOwnerOnboardingRolloutSource({
    rollout: new ContentEncryptionRolloutRpcSource(rolloutClient),
    client: createServiceRpcClient({
      allowedFunctions: freshOwnerOnboardingRpcFunctions,
      ...clientOptions
    }),
    ensureOwnerKeys: createManagedOwnerKeyBootstrap({
      client: createServiceRpcClient({
        allowedFunctions: encryptedAggregateRuntimeRpcFunctions,
        ...clientOptions
      }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(signal === undefined ? {} : { signal })
    }),
    enabled:
      options.freshOwnerOnboarding ??
      freshOwnerOnboardingEnabled(options.environment ?? process.env)
  });
  const rollout = new CapabilityGuardedEncryptionRolloutStateSource(
    onboarding,
    productionManualNotesCapabilityReadiness
  );
  const encrypted =
    options.encrypted ??
    new ManagedEncryptedNoteRepository({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(signal === undefined ? {} : { signalForOperation: () => signal })
    });
  return new RolloutAwareManualNotesRepository(rollout, options.legacy, encrypted);
}
