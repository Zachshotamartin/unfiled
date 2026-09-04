import {
  ORGANIZER_DESCRIPTOR_PROMPT,
  ORGANIZER_DESCRIPTOR_SCHEMA,
  ORGANIZER_DESCRIPTOR_SCHEMA_NAME
} from "./descriptor.js";
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

/** One bounded sentence, plus room for the strict-JSON envelope around it. */
const OPENAI_DESCRIPTOR_MAX_OUTPUT_TOKENS = 1_024;

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
    const describing = input.task === "describe";
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
        instructions: describing ? ORGANIZER_DESCRIPTOR_PROMPT : ORGANIZER_ROUTING_PROMPT,
        // One sentence needs no room to reason; the routing call still gets the full budget.
        max_output_tokens: describing
          ? OPENAI_DESCRIPTOR_MAX_OUTPUT_TOKENS
          : effort.maxOutputTokens,
        model: input.modelId,
        parallel_tool_calls: false,
        reasoning: { effort: describing ? "low" : effort.reasoningEffort },
        store: false,
        stream: false,
        text: {
          format: {
            name: describing
              ? ORGANIZER_DESCRIPTOR_SCHEMA_NAME
              : OPENAI_ORGANIZATION_PLAN_SCHEMA_NAME,
            schema: describing ? ORGANIZER_DESCRIPTOR_SCHEMA : OPENAI_ORGANIZATION_PLAN_SCHEMA,
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
