import {
  ANTHROPIC_ORGANIZATION_PLAN_SCHEMA,
  ANTHROPIC_ORGANIZATION_TOOL_DESCRIPTION,
  ANTHROPIC_ORGANIZATION_TOOL_NAME
} from "./anthropic-schema.js";
import { OrganizerPlannerReviewError, OrganizerProviderError } from "./errors.js";
import {
  ANTHROPIC_MODEL_IDS,
  ORGANIZER_MODEL_REGISTRY_VERSION,
  providerNativeEffort,
  type OrganizerRoutingEffort
} from "./model-registry.js";
import type { OrganizerPlanner } from "./planner.js";
import {
  ORGANIZER_PROMPT_VERSION,
  ORGANIZER_ROUTING_PROMPT,
  ORGANIZER_SCHEMA_VERSION
} from "./prompt.js";
import {
  PROVIDER_ROUTING_PROFILE,
  createProviderRegistryPlanner,
  type OrganizerProviderAdapter,
  type OrganizerProviderPlannerOptions
} from "./provider-planner.js";
import { isRecord } from "./provider-transport.js";

export const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages" as const;
/** Reviewed stable Messages API version; effort and strict tools need no beta header. */
export const ANTHROPIC_API_VERSION = "2023-06-01" as const;

/**
 * Code-pinned Claude routing profile. The exact model comes from the immutable
 * job snapshot (`organization-model-registry-v2`); this adapter refuses any
 * model outside the Claude registry and never sees an OpenAI credential.
 */
export const ANTHROPIC_ROUTING_PROFILE = Object.freeze({
  apiVersion: ANTHROPIC_API_VERSION,
  deadlineMs: PROVIDER_ROUTING_PROFILE.deadlineMs,
  maxOutputTokens: 12_288,
  maxRetries: PROVIDER_ROUTING_PROFILE.maxRetries,
  models: ANTHROPIC_MODEL_IDS,
  promptVersion: ORGANIZER_PROMPT_VERSION,
  registryVersion: ORGANIZER_MODEL_REGISTRY_VERSION,
  schemaVersion: ORGANIZER_SCHEMA_VERSION,
  toolName: ANTHROPIC_ORGANIZATION_TOOL_NAME
} as const);

export const ANTHROPIC_ROUTING_EFFORT_PROFILES = Object.freeze({
  economical: Object.freeze({ effort: "low" as const, maxTokens: 8_192 }),
  standard: Object.freeze({
    effort: "medium" as const,
    maxTokens: ANTHROPIC_ROUTING_PROFILE.maxOutputTokens
  }),
  thorough: Object.freeze({ effort: "high" as const, maxTokens: 16_384 })
});

export type AnthropicOrganizerPlannerOptions = OrganizerProviderPlannerOptions;

function effortProfile(routingEffort: OrganizerRoutingEffort) {
  const profile = ANTHROPIC_ROUTING_EFFORT_PROFILES[routingEffort];
  if (profile.effort !== providerNativeEffort(routingEffort)) {
    throw new OrganizerProviderError("validation_failed", false);
  }
  return profile;
}

/**
 * Accepts exactly one `tool_use` block for the forced organization tool. Plain
 * text, zero or multiple tool calls, another tool name, a truncated response,
 * a refusal, or a non-object input all become Review, never a note write.
 */
function parseMessagesResponse(value: unknown): unknown {
  if (!isRecord(value)) throw new OrganizerPlannerReviewError("invalid_output");
  if (value.type === "error") throw new OrganizerProviderError("provider_unavailable", true, 200);
  if (value.type !== "message" || value.role !== "assistant")
    throw new OrganizerPlannerReviewError("invalid_output");
  if (value.stop_reason === "max_tokens") throw new OrganizerPlannerReviewError("incomplete");
  if (value.stop_reason === "refusal") throw new OrganizerPlannerReviewError("refusal");
  if (value.stop_reason !== "tool_use" || !Array.isArray(value.content))
    throw new OrganizerPlannerReviewError("invalid_output");
  const blocks: readonly unknown[] = value.content;
  if (blocks.length !== 1) throw new OrganizerPlannerReviewError("invalid_output");
  const block = blocks[0];
  if (
    !isRecord(block) ||
    block.type !== "tool_use" ||
    block.name !== ANTHROPIC_ORGANIZATION_TOOL_NAME ||
    typeof block.id !== "string" ||
    !isRecord(block.input)
  ) {
    throw new OrganizerPlannerReviewError("invalid_output");
  }
  return Object.freeze({ ...block.input });
}

export const ANTHROPIC_PROVIDER_ADAPTER: OrganizerProviderAdapter = Object.freeze({
  provider: "anthropic",
  buildRequest(input) {
    const effort = effortProfile(input.routingEffort);
    return Object.freeze({
      body: JSON.stringify({
        max_tokens: effort.maxTokens,
        messages: [
          {
            content: [{ text: input.serializedInput, type: "text" }],
            role: "user"
          }
        ],
        model: input.modelId,
        output_config: { effort: effort.effort },
        stream: false,
        system: ORGANIZER_ROUTING_PROMPT,
        tool_choice: {
          disable_parallel_tool_use: true,
          name: ANTHROPIC_ORGANIZATION_TOOL_NAME,
          type: "tool"
        },
        tools: [
          {
            description: ANTHROPIC_ORGANIZATION_TOOL_DESCRIPTION,
            input_schema: ANTHROPIC_ORGANIZATION_PLAN_SCHEMA,
            name: ANTHROPIC_ORGANIZATION_TOOL_NAME,
            strict: true
          }
        ]
      }),
      endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
      headers: (apiKey) =>
        Object.freeze({
          accept: "application/json",
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "x-api-key": apiKey
        })
    });
  },
  parseResponse: parseMessagesResponse
});

/** Strict Claude Messages planner. It only ever serves Claude credentials and Claude models. */
export function createAnthropicOrganizerPlanner(
  options: AnthropicOrganizerPlannerOptions = {}
): OrganizerPlanner {
  return createProviderRegistryPlanner([ANTHROPIC_PROVIDER_ADAPTER], options);
}
