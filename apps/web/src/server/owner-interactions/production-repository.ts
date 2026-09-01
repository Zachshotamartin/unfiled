import {
  ManagedEncryptedOwnerInteractionRepository,
  type ManagedEncryptedOwnerInteractionRepositoryOptions
} from "@/server/encryption/managed-encrypted-owner-interaction-repository";

import type { OwnerInteractionRepository } from "./repository";

export type ProductionOwnerInteractionRepositoryOptions =
  ManagedEncryptedOwnerInteractionRepositoryOptions;

/**
 * Production owner interactions are encrypted-only. There is intentionally no
 * rollout-aware or plaintext repository dependency to fall back to.
 */
export function createProductionOwnerInteractionRepository(
  options: ProductionOwnerInteractionRepositoryOptions = {}
): OwnerInteractionRepository {
  return new ManagedEncryptedOwnerInteractionRepository(options);
}
