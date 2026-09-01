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
}>;

/** Creates one request-scoped capture composition with no fallback path. */
export function createProductionCaptureComposition(
  options: ProductionCaptureCompositionOptions
): CaptureRepository {
  const rolloutClient = createServiceRpcClient({
    allowedFunctions: rolloutRpcFunctions,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const encrypted =
    options.encrypted ??
    new ManagedEncryptedCaptureRepository({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signalForOperation: () => options.signal })
    });
  return new RolloutAwareCaptureRepository(
    new ContentEncryptionRolloutRpcSource(rolloutClient),
    options.legacy,
    encrypted
  );
}
