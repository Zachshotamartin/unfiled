import { ANTHROPIC_PROVIDER_ADAPTER } from "./anthropic-planner.js";
import { OPENAI_PROVIDER_ADAPTER } from "./openai-planner.js";
import type { OrganizerPlanner } from "./planner.js";
import { createProviderRegistryPlanner } from "./provider-planner.js";

/**
 * Lease-bound multiplexer for managed runtimes. Each attempt resolves the
 * job's live credential; that credential's provider selects exactly one
 * adapter, and its immutable model/effort snapshot selects the request shape.
 * A Claude key can never reach OpenAI and an OpenAI key can never reach
 * Anthropic because the adapter is chosen from the credential itself.
 */
export function createOrganizerProviderPlanner(
  options: Readonly<{ fetchImplementation?: typeof fetch }> = {}
): OrganizerPlanner {
  return createProviderRegistryPlanner([OPENAI_PROVIDER_ADAPTER, ANTHROPIC_PROVIDER_ADAPTER], {
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation })
  });
}
