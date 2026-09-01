import {
  ManagedEncryptedRoutingRuleRepository,
  type ManagedEncryptedRoutingRuleRepositoryOptions
} from "@/server/encryption/managed-encrypted-routing-rule-repository";

import type { RoutingRuleRepository } from "./repository";

export type ProductionRoutingRuleRepositoryOptions = ManagedEncryptedRoutingRuleRepositoryOptions;

/** Routing rules are encrypted-only and never fall back to a plaintext store. */
export function createProductionRoutingRuleRepository(
  options: ProductionRoutingRuleRepositoryOptions = {}
): RoutingRuleRepository {
  return new ManagedEncryptedRoutingRuleRepository(options);
}
