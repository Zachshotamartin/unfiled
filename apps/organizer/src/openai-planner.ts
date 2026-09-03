import { OrganizerPlannerReviewError, OrganizerProviderError } from "./errors.js";
import {
  OPENAI_MODEL_IDS,
  ORGANIZER_MODEL_REGISTRY_VERSION,
  providerNativeEffort,
  type OrganizerRoutingEffort
} from "./model-registry.js";
import {
  OPENAI_ORGANIZATION_PLAN_SCHEMA,
  OPENAI_ORGANIZATION_PLAN_SCHEMA_NAME
} from "./openai-schema.js";
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

export const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses" as const;

/**
 * Code-pinned OpenAI routing profile. The exact model is no longer a single
 * pin: the immutable job snapshot carries one `organization-model-registry-v2`
 * OpenAI model resolved by the database, and this adapter refuses any other.
 */
export const OPENAI_ROUTING_PROFILE = Object.freeze({
  deadlineMs: PROVIDER_ROUTING_PROFILE.deadlineMs,
  maxOutputTokens: 12_288,
  maxRetries: PROVIDER_ROUTING_PROFILE.maxRetries,
  models: OPENAI_MODEL_IDS,
  promptVersion: ORGANIZER_PROMPT_VERSION,
  registryVersion: ORGANIZER_MODEL_REGISTRY_VERSION,
  schemaVersion: ORGANIZER_SCHEMA_VERSION
} as const);

export const OPENAI_ROUTING_EFFORT_PROFILES = Object.freeze({
  economical: Object.freeze({ maxOutputTokens: 8_192, reasoningEffort: "low" as const }),
  standard: Object.freeze({
    maxOutputTokens: OPENAI_ROUTING_PROFILE.maxOutputTokens,
    reasoningEffort: "medium" as const
  }),
  thorough: Object.freeze({ maxOutputTokens: 16_384, reasoningEffort: "high" as const })
});

export type OpenAIOrganizerPlannerOptions = OrganizerProviderPlannerOptions;

function effortProfile(routingEffort: OrganizerRoutingEffort) {
  const profile = OPENAI_ROUTING_EFFORT_PROFILES[routingEffort];
  if (profile.reasoningEffort !== providerNativeEffort(routingEffort)) {
    throw new OrganizerProviderError("validation_failed", false);
  }
  return profile;
}

function parseCompletedResponse(value: unknown): unknown {
  if (!isRecord(value)) throw new OrganizerPlannerReviewError("invalid_output");
  if (value.status === "incomplete" || value.status === "cancelled")
    throw new OrganizerPlannerReviewError("incomplete");
  if (value.status !== "completed")
    throw new OrganizerProviderError("provider_unavailable", true, 200);
  if (!Array.isArray(value.output)) throw new OrganizerPlannerReviewError("invalid_output");

  const outputTexts: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item)) throw new OrganizerPlannerReviewError("invalid_output");
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
      throw new OrganizerPlannerReviewError("invalid_output");
    for (const content of item.content) {
      if (!isRecord(content)) throw new OrganizerPlannerReviewError("invalid_output");
      if (content.type === "refusal") throw new OrganizerPlannerReviewError("refusal");
      if (content.type !== "output_text" || typeof content.text !== "string")
        throw new OrganizerPlannerReviewError("invalid_output");
      outputTexts.push(content.text);
    }
  }
  if (outputTexts.length !== 1) throw new OrganizerPlannerReviewError("invalid_output");
  try {
    const plan = JSON.parse(outputTexts[0] ?? "") as unknown;
    if (!isRecord(plan)) throw new OrganizerPlannerReviewError("invalid_output");
    return plan;
  } catch (error: unknown) {
    if (error instanceof OrganizerPlannerReviewError) throw error;
    throw new OrganizerPlannerReviewError("invalid_output");
  }
}

export const OPENAI_PROVIDER_ADAPTER: OrganizerProviderAdapter = Object.freeze({
  provider: "openai",
  buildRequest(input) {
    const effort = effortProfile(input.routingEffort);
    return Object.freeze({
      body: JSON.stringify({
        background: false,
        input: [
          {
            content: [
              { text: input.serializedInput, type: "input_text" },
              ...input.images.map((image) => ({
                detail: "high",
                image_url: `data:${image.mediaType};base64,${image.dataBase64}`,
                type: "input_image"
              }))
            ],
            role: "user"
          }
        ],
        instructions: ORGANIZER_ROUTING_PROMPT,
        max_output_tokens: effort.maxOutputTokens,
        model: input.modelId,
        parallel_tool_calls: false,
        reasoning: { effort: effort.reasoningEffort },
        store: false,
        stream: false,
        text: {
          format: {
            name: OPENAI_ORGANIZATION_PLAN_SCHEMA_NAME,
            schema: OPENAI_ORGANIZATION_PLAN_SCHEMA,
            strict: true,
            type: "json_schema"
          }
        },
        tool_choice: "none",
        tools: [],
        truncation: "disabled"
      }),
      endpoint: OPENAI_RESPONSES_ENDPOINT,
      headers: (apiKey) =>
        Object.freeze({
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        })
    });
  },
  parseResponse: parseCompletedResponse
});

/** Strict OpenAI Responses planner. It only ever serves OpenAI credentials and OpenAI models. */
export function createOpenAIOrganizerPlanner(
  options: OpenAIOrganizerPlannerOptions = {}
): OrganizerPlanner {
  return createProviderRegistryPlanner([OPENAI_PROVIDER_ADAPTER], options);
}
