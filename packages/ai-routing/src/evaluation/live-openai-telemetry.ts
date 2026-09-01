import { createHash } from "node:crypto";

export const OPENAI_GPT_5_4_MINI_EVALUATION_PRICING = Object.freeze({
  cachedInputUsdPerMillionTokens: 0.075,
  effectiveDate: "2026-09-01",
  inputUsdPerMillionTokens: 0.75,
  model: "gpt-5.4-mini-2026-03-17",
  outputUsdPerMillionTokens: 4.5,
  source: "official-openai-model-page"
});

export type OpenAIEvaluationUsage = Readonly<{
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

export type OpenAIEvaluationAttempt = Readonly<{
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
  usage: OpenAIEvaluationUsage;
  versions: Readonly<{
    candidateAlgorithm: string;
    candidateFixtures: string;
    model: string;
    prompt: string;
    schema: number;
  }>;
}>;

export type OpenAIEvaluationTelemetrySummary = Readonly<{
  attempts: number;
  estimatedCostUsd: number;
  latencyMs: Readonly<{
    max: number;
    p50: number;
    p95: number;
  }>;
  usage: OpenAIEvaluationUsage;
}>;

type OpenAIEvaluationPricing = Readonly<{
  cachedInputUsdPerMillionTokens: number;
  inputUsdPerMillionTokens: number;
  model: string;
  outputUsdPerMillionTokens: number;
}>;

export class LiveOpenAIEvaluationConfigurationError extends Error {
  public readonly code: "invalid_explicit_openai_api_key" | "missing_explicit_openai_api_key";

  public constructor(code: "invalid_explicit_openai_api_key" | "missing_explicit_openai_api_key") {
    super(code);
    this.name = "LiveOpenAIEvaluationConfigurationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
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

/** This deliberately has no fallback to OPENAI_API_KEY or an application runtime secret. */
export function requireExplicitLiveOpenAIEvaluationKey(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new LiveOpenAIEvaluationConfigurationError("missing_explicit_openai_api_key");
  }
  if (
    value.length < 20 ||
    value.length > 512 ||
    value.trim() !== value ||
    controlCharacter(value) ||
    /^(?:change-me|placeholder|test-key)$/iu.test(value)
  ) {
    throw new LiveOpenAIEvaluationConfigurationError("invalid_explicit_openai_api_key");
  }
  return value;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function responseUsage(value: unknown): OpenAIEvaluationUsage {
  if (!isRecord(value) || !isRecord(value.usage)) {
    return { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
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

function estimatedCost(usage: OpenAIEvaluationUsage, pricing: OpenAIEvaluationPricing): number {
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

function schemaFromBody(body: Readonly<Record<string, unknown>>): unknown {
  if (!isRecord(body.text) || !isRecord(body.text.format)) return null;
  return body.text.format.schema ?? null;
}

function roundedMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

export function createOpenAIEvaluationInstrumentation(
  options: Readonly<{
    candidateAlgorithmVersion: string;
    candidateFixtureVersion: string;
    fetchImplementation?: typeof fetch;
    now?: () => number;
    pricing?: OpenAIEvaluationPricing;
    promptVersion: string;
    schemaVersion: number;
  }>
): Readonly<{
  drain(): readonly OpenAIEvaluationAttempt[];
  fetchImplementation: typeof fetch;
  snapshot(): readonly OpenAIEvaluationAttempt[];
}> {
  const delegate = options.fetchImplementation ?? fetch;
  const now = options.now ?? performance.now.bind(performance);
  const pricing = options.pricing ?? OPENAI_GPT_5_4_MINI_EVALUATION_PRICING;
  const attempts: OpenAIEvaluationAttempt[] = [];
  const instrumented: typeof fetch = async (url, init) => {
    const body = requestBody(init?.body);
    const model = typeof body.model === "string" ? body.model : "unknown";
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    const schema = schemaFromBody(body);
    const startedAt = now();
    let response: Response;
    try {
      response = await delegate(url, init);
    } catch (error: unknown) {
      attempts.push(
        Object.freeze({
          attempt: attempts.length + 1,
          estimatedCostUsd: 0,
          hashes: Object.freeze({
            candidateAlgorithmVersionSha256: evaluationSha256(options.candidateAlgorithmVersion),
            candidateFixtureVersionSha256: evaluationSha256(options.candidateFixtureVersion),
            modelVersionSha256: evaluationSha256(model),
            promptContentSha256: evaluationSha256(instructions),
            promptVersionSha256: evaluationSha256(options.promptVersion),
            schemaContentSha256: evaluationSha256(schema),
            schemaVersionSha256: evaluationSha256(options.schemaVersion)
          }),
          httpStatus: null,
          latencyMs: roundedMilliseconds(now() - startedAt),
          pricingModelMatched: model === pricing.model,
          requestCompleted: false,
          usage: responseUsage(null),
          versions: Object.freeze({
            candidateAlgorithm: options.candidateAlgorithmVersion,
            candidateFixtures: options.candidateFixtureVersion,
            model,
            prompt: options.promptVersion,
            schema: options.schemaVersion
          })
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
    const usage = responseUsage(responseValue);
    const responseModel =
      isRecord(responseValue) && typeof responseValue.model === "string"
        ? responseValue.model
        : model;
    const pricingModelMatched = responseModel === pricing.model;
    attempts.push(
      Object.freeze({
        attempt: attempts.length + 1,
        estimatedCostUsd: pricingModelMatched ? estimatedCost(usage, pricing) : 0,
        hashes: Object.freeze({
          candidateAlgorithmVersionSha256: evaluationSha256(options.candidateAlgorithmVersion),
          candidateFixtureVersionSha256: evaluationSha256(options.candidateFixtureVersion),
          modelVersionSha256: evaluationSha256(responseModel),
          promptContentSha256: evaluationSha256(instructions),
          promptVersionSha256: evaluationSha256(options.promptVersion),
          schemaContentSha256: evaluationSha256(schema),
          schemaVersionSha256: evaluationSha256(options.schemaVersion)
        }),
        httpStatus: response.status,
        latencyMs: roundedMilliseconds(now() - startedAt),
        pricingModelMatched,
        requestCompleted: response.ok,
        usage,
        versions: Object.freeze({
          candidateAlgorithm: options.candidateAlgorithmVersion,
          candidateFixtures: options.candidateFixtureVersion,
          model: responseModel,
          prompt: options.promptVersion,
          schema: options.schemaVersion
        })
      })
    );
    return response;
  };

  return Object.freeze({
    drain(): readonly OpenAIEvaluationAttempt[] {
      return Object.freeze(attempts.splice(0));
    },
    fetchImplementation: instrumented,
    snapshot(): readonly OpenAIEvaluationAttempt[] {
      return Object.freeze([...attempts]);
    }
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

export function summarizeOpenAIEvaluationTelemetry(
  attempts: readonly OpenAIEvaluationAttempt[]
): OpenAIEvaluationTelemetrySummary {
  const latencies = attempts.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
  const usage = attempts.reduce<OpenAIEvaluationUsage>(
    (total, attempt) => ({
      cachedInputTokens: total.cachedInputTokens + attempt.usage.cachedInputTokens,
      inputTokens: total.inputTokens + attempt.usage.inputTokens,
      outputTokens: total.outputTokens + attempt.usage.outputTokens,
      totalTokens: total.totalTokens + attempt.usage.totalTokens
    }),
    { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
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
