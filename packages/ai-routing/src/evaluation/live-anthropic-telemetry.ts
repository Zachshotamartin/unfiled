import {
  EMPTY_PROVIDER_EVALUATION_USAGE,
  createProviderEvaluationInstrumentation,
  isRecord,
  nonnegativeInteger,
  requireExplicitLiveEvaluationKey,
  summarizeProviderEvaluationTelemetry,
  type ProviderEvaluationAttempt,
  type ProviderEvaluationPricing,
  type ProviderEvaluationTelemetrySummary,
  type ProviderEvaluationUsage
} from "./live-provider-telemetry.js";

export type AnthropicEvaluationAttempt = ProviderEvaluationAttempt;
export type AnthropicEvaluationTelemetrySummary = ProviderEvaluationTelemetrySummary;

/**
 * Pinned list prices for the `organization-model-registry-v2` Claude models,
 * taken from the official models overview on 2026-09-02. Prompt-cache reads
 * are 10% of the base input price on these models; cache writes are charged
 * here at the full input rate, so the estimate is an upper bound.
 */
export const ANTHROPIC_ROUTING_EVALUATION_PRICING: Readonly<
  Record<string, ProviderEvaluationPricing>
> = Object.freeze({
  "claude-opus-5": Object.freeze({
    cachedInputUsdPerMillionTokens: 0.5,
    inputUsdPerMillionTokens: 5,
    model: "claude-opus-5",
    outputUsdPerMillionTokens: 25
  }),
  "claude-sonnet-5": Object.freeze({
    cachedInputUsdPerMillionTokens: 0.2,
    inputUsdPerMillionTokens: 2,
    model: "claude-sonnet-5",
    outputUsdPerMillionTokens: 10
  })
});
export const ANTHROPIC_ROUTING_EVALUATION_PRICING_METADATA = Object.freeze({
  cacheReadPolicy: "10% of the base input price",
  cacheWritePolicy: "charged at the full input rate (upper bound)",
  effectiveDate: "2026-09-02",
  source: "official-claude-models-overview"
});

export function anthropicEvaluationPricingForModel(
  model: string
): ProviderEvaluationPricing | null {
  return ANTHROPIC_ROUTING_EVALUATION_PRICING[model] ?? null;
}

/** This deliberately has no fallback to ANTHROPIC_API_KEY or an application runtime secret. */
export function requireExplicitLiveAnthropicEvaluationKey(value: string | undefined): string {
  return requireExplicitLiveEvaluationKey(value, "anthropic");
}

function responseUsage(value: unknown): ProviderEvaluationUsage {
  if (!isRecord(value) || !isRecord(value.usage)) return EMPTY_PROVIDER_EVALUATION_USAGE;
  const uncachedInput = nonnegativeInteger(value.usage.input_tokens);
  const cacheRead = nonnegativeInteger(value.usage.cache_read_input_tokens);
  const cacheCreation = nonnegativeInteger(value.usage.cache_creation_input_tokens);
  const outputTokens = nonnegativeInteger(value.usage.output_tokens);
  // Anthropic reports uncached, cache-read, and cache-write input separately.
  const inputTokens = uncachedInput + cacheRead + cacheCreation;
  return Object.freeze({
    cachedInputTokens: cacheRead,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  });
}

function toolSchema(body: Readonly<Record<string, unknown>>): unknown {
  if (!Array.isArray(body.tools)) return null;
  const tool: unknown = body.tools[0];
  return isRecord(tool) ? (tool.input_schema ?? null) : null;
}

export function createAnthropicEvaluationInstrumentation(
  options: Readonly<{
    candidateAlgorithmVersion: string;
    candidateFixtureVersion: string;
    fetchImplementation?: typeof fetch;
    now?: () => number;
    pricing?: ProviderEvaluationPricing;
    promptVersion: string;
    schemaVersion: number;
  }>
): Readonly<{
  drain(): readonly AnthropicEvaluationAttempt[];
  fetchImplementation: typeof fetch;
  snapshot(): readonly AnthropicEvaluationAttempt[];
}> {
  const pricingOverride = options.pricing;
  return createProviderEvaluationInstrumentation({
    candidateAlgorithmVersion: options.candidateAlgorithmVersion,
    candidateFixtureVersion: options.candidateFixtureVersion,
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
    ...(options.now === undefined ? {} : { now: options.now }),
    pricingForModel: (model) =>
      pricingOverride === undefined
        ? anthropicEvaluationPricingForModel(model)
        : pricingOverride.model === model
          ? pricingOverride
          : null,
    promptVersion: options.promptVersion,
    readRequest: (body) => ({
      model: typeof body.model === "string" ? body.model : "unknown",
      promptContent: typeof body.system === "string" ? body.system : "",
      schema: toolSchema(body)
    }),
    readResponse: (value) => ({
      model: isRecord(value) && typeof value.model === "string" ? value.model : null,
      usage: responseUsage(value)
    }),
    schemaVersion: options.schemaVersion
  });
}

export function summarizeAnthropicEvaluationTelemetry(
  attempts: readonly AnthropicEvaluationAttempt[]
): AnthropicEvaluationTelemetrySummary {
  return summarizeProviderEvaluationTelemetry(attempts);
}
