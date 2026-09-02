import { createHash } from "node:crypto";

/**
 * Provider-neutral, content-free instrumentation for optional live routing
 * evaluations. It records only version hashes, HTTP status, latency, token
 * usage, and an estimated cost for a pinned pricing table. Prompt text, schema
 * text, capture text, and candidate content are hashed or discarded.
 */
export type ProviderEvaluationUsage = Readonly<{
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

export type ProviderEvaluationPricing = Readonly<{
  cachedInputUsdPerMillionTokens: number;
  inputUsdPerMillionTokens: number;
  model: string;
  outputUsdPerMillionTokens: number;
}>;

export type ProviderEvaluationAttempt = Readonly<{
  attempt: number;
  estimatedCostUsd: number;
  hashes: Readonly<{
    candidateAlgorithmVersionSha256: string;
    candidateFixtureVersionSha256: string;
    modelVersionSha256: string;
    promptContentSha256: string;
    promptVersionSha256: string;
    schemaContentSha256: string;
    schemaVersionSha256: string;
  }>;
  httpStatus: number | null;
  latencyMs: number;
  pricingModelMatched: boolean;
  requestCompleted: boolean;
  usage: ProviderEvaluationUsage;
  versions: Readonly<{
    candidateAlgorithm: string;
    candidateFixtures: string;
    model: string;
    prompt: string;
    schema: number;
  }>;
}>;

export type ProviderEvaluationTelemetrySummary = Readonly<{
  attempts: number;
  estimatedCostUsd: number;
  latencyMs: Readonly<{ max: number; p50: number; p95: number }>;
  usage: ProviderEvaluationUsage;
}>;

/** Reads the content-free request projection for one provider wire format. */
export type ProviderEvaluationRequestReader = (
  body: Readonly<Record<string, unknown>>
) => Readonly<{ model: string; promptContent: string; schema: unknown }>;

/** Reads usage and the served model from one provider response shape. */
export type ProviderEvaluationResponseReader = (
  value: unknown
) => Readonly<{ model: string | null; usage: ProviderEvaluationUsage }>;

export type LiveEvaluationKeyErrorCode =
  | "invalid_explicit_anthropic_api_key"
  | "invalid_explicit_openai_api_key"
  | "missing_explicit_anthropic_api_key"
  | "missing_explicit_openai_api_key";

export class LiveEvaluationConfigurationError extends Error {
  public readonly code: LiveEvaluationKeyErrorCode;

  public constructor(code: LiveEvaluationKeyErrorCode) {
    super(code);
    this.name = "LiveEvaluationConfigurationError";
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(typeof value);
}

export function evaluationSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function controlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) return true;
  }
  return false;
}

/** This deliberately has no fallback to a generic provider variable or an application runtime secret. */
export function requireExplicitLiveEvaluationKey(
  value: string | undefined,
  provider: "anthropic" | "openai"
): string {
  if (value === undefined || value.length === 0) {
    throw new LiveEvaluationConfigurationError(`missing_explicit_${provider}_api_key`);
  }
  if (
    value.length < 20 ||
    value.length > 512 ||
    value.trim() !== value ||
    controlCharacter(value) ||
    /^(?:change-me|placeholder|test-key)$/iu.test(value)
  ) {
    throw new LiveEvaluationConfigurationError(`invalid_explicit_${provider}_api_key`);
  }
  return value;
}

export function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export const EMPTY_PROVIDER_EVALUATION_USAGE: ProviderEvaluationUsage = Object.freeze({
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0
});

function estimatedCost(usage: ProviderEvaluationUsage, pricing: ProviderEvaluationPricing): number {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (uncachedInput * pricing.inputUsdPerMillionTokens +
      usage.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens +
      usage.outputTokens * pricing.outputUsdPerMillionTokens) /
    1_000_000;
  return Math.round(cost * 1_000_000_000) / 1_000_000_000;
}

function requestBody(value: BodyInit | null | undefined): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function roundedMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

export function createProviderEvaluationInstrumentation(
  options: Readonly<{
    candidateAlgorithmVersion: string;
    candidateFixtureVersion: string;
    fetchImplementation?: typeof fetch;
    now?: () => number;
    pricingForModel: (model: string) => ProviderEvaluationPricing | null;
    promptVersion: string;
    readRequest: ProviderEvaluationRequestReader;
    readResponse: ProviderEvaluationResponseReader;
    schemaVersion: number;
  }>
): Readonly<{
  drain(): readonly ProviderEvaluationAttempt[];
  fetchImplementation: typeof fetch;
  snapshot(): readonly ProviderEvaluationAttempt[];
}> {
  const delegate = options.fetchImplementation ?? fetch;
  const now = options.now ?? performance.now.bind(performance);
  const attempts: ProviderEvaluationAttempt[] = [];
  function hashes(model: string, promptContent: string, schema: unknown) {
    return Object.freeze({
      candidateAlgorithmVersionSha256: evaluationSha256(options.candidateAlgorithmVersion),
      candidateFixtureVersionSha256: evaluationSha256(options.candidateFixtureVersion),
      modelVersionSha256: evaluationSha256(model),
      promptContentSha256: evaluationSha256(promptContent),
      promptVersionSha256: evaluationSha256(options.promptVersion),
      schemaContentSha256: evaluationSha256(schema),
      schemaVersionSha256: evaluationSha256(options.schemaVersion)
    });
  }
  function versions(model: string) {
    return Object.freeze({
      candidateAlgorithm: options.candidateAlgorithmVersion,
      candidateFixtures: options.candidateFixtureVersion,
      model,
      prompt: options.promptVersion,
      schema: options.schemaVersion
    });
  }
  const instrumented: typeof fetch = async (url, init) => {
    const request = options.readRequest(requestBody(init?.body));
    const startedAt = now();
    let response: Response;
    try {
      response = await delegate(url, init);
    } catch (error: unknown) {
      attempts.push(
        Object.freeze({
          attempt: attempts.length + 1,
          estimatedCostUsd: 0,
          hashes: hashes(request.model, request.promptContent, request.schema),
          httpStatus: null,
          latencyMs: roundedMilliseconds(now() - startedAt),
          pricingModelMatched: options.pricingForModel(request.model) !== null,
          requestCompleted: false,
          usage: EMPTY_PROVIDER_EVALUATION_USAGE,
          versions: versions(request.model)
        })
      );
      throw error;
    }

    let responseValue: unknown;
    try {
      responseValue = await response.clone().json();
    } catch {
      responseValue = null;
    }
    const parsed = options.readResponse(responseValue);
    const responseModel = parsed.model ?? request.model;
    const pricing = options.pricingForModel(responseModel);
    attempts.push(
      Object.freeze({
        attempt: attempts.length + 1,
        estimatedCostUsd: pricing === null ? 0 : estimatedCost(parsed.usage, pricing),
        hashes: hashes(responseModel, request.promptContent, request.schema),
        httpStatus: response.status,
        latencyMs: roundedMilliseconds(now() - startedAt),
        pricingModelMatched: pricing !== null,
        requestCompleted: response.ok,
        usage: parsed.usage,
        versions: versions(responseModel)
      })
    );
    return response;
  };

  return Object.freeze({
    drain(): readonly ProviderEvaluationAttempt[] {
      return Object.freeze(attempts.splice(0));
    },
    fetchImplementation: instrumented,
    snapshot(): readonly ProviderEvaluationAttempt[] {
      return Object.freeze([...attempts]);
    }
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

export function summarizeProviderEvaluationTelemetry(
  attempts: readonly ProviderEvaluationAttempt[]
): ProviderEvaluationTelemetrySummary {
  const latencies = attempts.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
  const usage = attempts.reduce<ProviderEvaluationUsage>(
    (total, attempt) => ({
      cachedInputTokens: total.cachedInputTokens + attempt.usage.cachedInputTokens,
      inputTokens: total.inputTokens + attempt.usage.inputTokens,
      outputTokens: total.outputTokens + attempt.usage.outputTokens,
      totalTokens: total.totalTokens + attempt.usage.totalTokens
    }),
    EMPTY_PROVIDER_EVALUATION_USAGE
  );
  return Object.freeze({
    attempts: attempts.length,
    estimatedCostUsd:
      Math.round(
        attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0) * 1_000_000_000
      ) / 1_000_000_000,
    latencyMs: Object.freeze({
      max: latencies.at(-1) ?? 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95)
    }),
    usage: Object.freeze(usage)
  });
}
