import { encryptedAggregateRuntimeRpcFunctions } from "@/server/encryption/encrypted-aggregate-runtime";
import {
  createManagedOwnerKeyBootstrap,
  freshOwnerOnboardingEnabled,
  freshOwnerOnboardingRpcFunctions,
  FreshOwnerOnboardingRolloutSource
} from "@/server/encryption/fresh-owner-onboarding";
import { ManagedEncryptedCaptureRepository } from "@/server/encryption/managed-encrypted-capture-repository";
import {
  ContentEncryptionRolloutRpcSource,
  rolloutRpcFunctions
} from "@/server/encryption/rollout-rpc-source";
import { createServiceRpcClient } from "@/server/encryption/service-rpc-client";
import type { WebKeyRuntimeEnvironment } from "@/server/encryption/web-key-runtime";

import type { CaptureRepository } from "./repository";
import { RolloutAwareCaptureRepository } from "./rollout-aware-repository";

export type ProductionCaptureCompositionOptions = Readonly<{
  legacy: CaptureRepository;
  encrypted?: CaptureRepository;
  environment?: WebKeyRuntimeEnvironment;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Drives owners with no legacy objects through the official rollout on first
   * use. Defaults to "no legacy content key is configured"; test seam otherwise.
   */
  freshOwnerOnboarding?: boolean;
}>;

/** Creates one request-scoped capture composition with no fallback path. */
export function createProductionCaptureComposition(
  options: ProductionCaptureCompositionOptions
): CaptureRepository {
  const clientOptions = {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  };
  const rolloutClient = createServiceRpcClient({
    allowedFunctions: rolloutRpcFunctions,
    ...clientOptions
  });
  const rollout = new FreshOwnerOnboardingRolloutSource({
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
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }),
    enabled:
      options.freshOwnerOnboarding ??
      freshOwnerOnboardingEnabled(options.environment ?? process.env)
  });
  const encrypted =
    options.encrypted ??
    new ManagedEncryptedCaptureRepository({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signalForOperation: () => options.signal })
    });
  return new RolloutAwareCaptureRepository(rollout, options.legacy, encrypted);
}
