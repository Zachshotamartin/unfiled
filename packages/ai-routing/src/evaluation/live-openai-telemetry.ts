import {
  EMPTY_PROVIDER_EVALUATION_USAGE,
  LiveEvaluationConfigurationError,
  createProviderEvaluationInstrumentation,
  evaluationSha256,
  isRecord,
  nonnegativeInteger,
  requireExplicitLiveEvaluationKey,
  summarizeProviderEvaluationTelemetry,
  type ProviderEvaluationAttempt,
  type ProviderEvaluationPricing,
  type ProviderEvaluationTelemetrySummary,
  type ProviderEvaluationUsage
} from "./live-provider-telemetry.js";

export { evaluationSha256 };
export type OpenAIEvaluationUsage = ProviderEvaluationUsage;
export type OpenAIEvaluationAttempt = ProviderEvaluationAttempt;
export type OpenAIEvaluationTelemetrySummary = ProviderEvaluationTelemetrySummary;
export type OpenAIEvaluationPricing = ProviderEvaluationPricing;
export const LiveOpenAIEvaluationConfigurationError = LiveEvaluationConfigurationError;

/**
 * Pinned list prices for the `organization-model-registry-v2` OpenAI models,
 * taken from the official model catalog on 2026-09-02. The catalog page did not
 * list a separate cached-input rate, so cached input is charged at the full
 * input rate here; the estimate is therefore an upper bound.
 */
export const OPENAI_ROUTING_EVALUATION_PRICING: Readonly<
  Record<string, ProviderEvaluationPricing>
> = Object.freeze({
  "gpt-5.6-luna": Object.freeze({
    cachedInputUsdPerMillionTokens: 0.2,
    inputUsdPerMillionTokens: 0.2,
    model: "gpt-5.6-luna",
    outputUsdPerMillionTokens: 1.2
  }),
  "gpt-5.6-sol": Object.freeze({
    cachedInputUsdPerMillionTokens: 4,
    inputUsdPerMillionTokens: 4,
    model: "gpt-5.6-sol",
    outputUsdPerMillionTokens: 20
  }),
  "gpt-5.6-terra": Object.freeze({
    cachedInputUsdPerMillionTokens: 2,
    inputUsdPerMillionTokens: 2,
    model: "gpt-5.6-terra",
    outputUsdPerMillionTokens: 12
  })
});
export const OPENAI_ROUTING_EVALUATION_PRICING_METADATA = Object.freeze({
  cachedInputPolicy: "charged at the full input rate (upper bound)",
  effectiveDate: "2026-09-02",
  source: "official-openai-model-catalog"
});

export function openAiEvaluationPricingForModel(model: string): ProviderEvaluationPricing | null {
  return OPENAI_ROUTING_EVALUATION_PRICING[model] ?? null;
}

/** This deliberately has no fallback to OPENAI_API_KEY or an application runtime secret. */
export function requireExplicitLiveOpenAIEvaluationKey(value: string | undefined): string {
  return requireExplicitLiveEvaluationKey(value, "openai");
}

function responseUsage(value: unknown): ProviderEvaluationUsage {
  if (!isRecord(value) || !isRecord(value.usage)) return EMPTY_PROVIDER_EVALUATION_USAGE;
  const inputTokens = nonnegativeInteger(value.usage.input_tokens);
  const outputTokens = nonnegativeInteger(value.usage.output_tokens);
  const suppliedTotal = nonnegativeInteger(value.usage.total_tokens);
  const details = isRecord(value.usage.input_tokens_details)
    ? value.usage.input_tokens_details
    : {};
  const cachedInputTokens = Math.min(inputTokens, nonnegativeInteger(details.cached_tokens));
  return Object.freeze({
    cachedInputTokens,
    inputTokens,
    outputTokens,
    totalTokens: Math.max(suppliedTotal, inputTokens + outputTokens)
  });
}

export function createOpenAIEvaluationInstrumentation(
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
  drain(): readonly OpenAIEvaluationAttempt[];
  fetchImplementation: typeof fetch;
  snapshot(): readonly OpenAIEvaluationAttempt[];
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
        ? openAiEvaluationPricingForModel(model)
        : pricingOverride.model === model
          ? pricingOverride
          : null,
    promptVersion: options.promptVersion,
    readRequest: (body) => ({
      model: typeof body.model === "string" ? body.model : "unknown",
      promptContent: typeof body.instructions === "string" ? body.instructions : "",
      schema:
        isRecord(body.text) && isRecord(body.text.format) ? (body.text.format.schema ?? null) : null
    }),
    readResponse: (value) => ({
      model: isRecord(value) && typeof value.model === "string" ? value.model : null,
      usage: responseUsage(value)
    }),
    schemaVersion: options.schemaVersion
  });
}

export function summarizeOpenAIEvaluationTelemetry(
  attempts: readonly OpenAIEvaluationAttempt[]
): OpenAIEvaluationTelemetrySummary {
  return summarizeProviderEvaluationTelemetry(attempts);
}
