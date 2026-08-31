const OPENAI_EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1/embeddings";
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MIN_API_KEY_LENGTH = 20;
const MAX_API_KEY_LENGTH = 512;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type EmbeddingProviderErrorCode =
  "provider_key_invalid" | "provider_unavailable" | "rate_limited" | "validation_failed";

export class EmbeddingProviderError extends Error {
  public readonly safeCode: EmbeddingProviderErrorCode;
  public readonly retryable: boolean;

  public constructor(safeCode: EmbeddingProviderErrorCode, retryable: boolean) {
    super("Embedding provider request failed.");
    this.name = "EmbeddingProviderError";
    this.safeCode = safeCode;
    this.retryable = retryable;
  }
}

export type EmbeddingProvider = Readonly<{
  embed(
    input: Readonly<{
      dimensions: number;
      modelId: string;
      signal: AbortSignal;
      text: string;
    }>
  ): Promise<Float32Array>;
}>;

export type OpenAiEmbeddingProviderOptions = Readonly<{
  apiKey: string;
  dimensions: number;
  fetchImplementation?: typeof fetch;
  maxInputBytes: number;
  maxResponseBytes?: number;
  modelId: string;
  timeoutMs: number;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function finitePositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function assertConfiguration(options: OpenAiEmbeddingProviderOptions): void {
  const keyIsValid =
    options.apiKey.length >= MIN_API_KEY_LENGTH &&
    options.apiKey.length <= MAX_API_KEY_LENGTH &&
    options.apiKey.trim() === options.apiKey &&
    !hasAsciiControlCharacter(options.apiKey) &&
    !/\s/u.test(options.apiKey);
  if (
    !keyIsValid ||
    !MODEL_ID_PATTERN.test(options.modelId) ||
    !finitePositiveInteger(options.dimensions, 4_096) ||
    !finitePositiveInteger(options.maxInputBytes, 200_000) ||
    !finitePositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      2 * 1024 * 1024
    ) ||
    !finitePositiveInteger(options.timeoutMs, 55_000)
  ) {
    throw new EmbeddingProviderError("validation_failed", false);
  }
}

function assertRequest(
  options: OpenAiEmbeddingProviderOptions,
  input: Parameters<EmbeddingProvider["embed"]>[0]
): void {
  const textBytes = new TextEncoder().encode(input.text).byteLength;
  if (
    input.signal.aborted ||
    input.modelId !== options.modelId ||
    input.dimensions !== options.dimensions ||
    input.text.trim().length === 0 ||
    textBytes > options.maxInputBytes
  ) {
    throw new EmbeddingProviderError("validation_failed", false);
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal
): Promise<unknown> {
  if (response.body === null) throw new EmbeddingProviderError("provider_unavailable", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (): void => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let part = await reader.read();
    while (!part.done) {
      if (signal.aborted) throw new EmbeddingProviderError("provider_unavailable", true);
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new EmbeddingProviderError("provider_unavailable", true);
      }
      chunks.push(part.value);
      part = await reader.read();
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  try {
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    if (error instanceof EmbeddingProviderError) throw error;
    throw new EmbeddingProviderError("provider_unavailable", true);
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function parseEmbeddingResponse(
  value: unknown,
  expected: Readonly<{ dimensions: number; modelId: string }>
): Float32Array {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["data", "model", "object", "usage"]) ||
    value.object !== "list" ||
    value.model !== expected.modelId ||
    !isUnknownArray(value.data) ||
    value.data.length !== 1 ||
    !isRecord(value.usage) ||
    !exactKeys(value.usage, ["prompt_tokens", "total_tokens"]) ||
    !finitePositiveInteger(value.usage.prompt_tokens, Number.MAX_SAFE_INTEGER) ||
    !finitePositiveInteger(value.usage.total_tokens, Number.MAX_SAFE_INTEGER)
  ) {
    throw new EmbeddingProviderError("provider_unavailable", true);
  }
  const item = value.data[0];
  if (
    !isRecord(item) ||
    !exactKeys(item, ["embedding", "index", "object"]) ||
    item.index !== 0 ||
    item.object !== "embedding" ||
    !isUnknownArray(item.embedding) ||
    item.embedding.length !== expected.dimensions
  ) {
    throw new EmbeddingProviderError("provider_unavailable", true);
  }
  const output = new Float32Array(expected.dimensions);
  for (let index = 0; index < item.embedding.length; index += 1) {
    const component = item.embedding[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      output.fill(0);
      throw new EmbeddingProviderError("provider_unavailable", true);
    }
    const rounded = Math.fround(component);
    if (!Number.isFinite(rounded)) {
      output.fill(0);
      throw new EmbeddingProviderError("provider_unavailable", true);
    }
    output[index] = rounded;
  }
  return output;
}

function responseFailure(status: number): EmbeddingProviderError {
  if (status === 401 || status === 403) {
    return new EmbeddingProviderError("provider_key_invalid", true);
  }
  if (status === 429) return new EmbeddingProviderError("rate_limited", true);
  return new EmbeddingProviderError("provider_unavailable", status >= 500 || status === 408);
}

export function createOpenAiEmbeddingProvider(
  options: OpenAiEmbeddingProviderOptions
): EmbeddingProvider {
  assertConfiguration(options);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const maximumResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return Object.freeze({
    async embed(input): Promise<Float32Array> {
      assertRequest(options, input);
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = AbortSignal.any([input.signal, timeout]);
      let response: Response;
      try {
        response = await fetchImplementation(OPENAI_EMBEDDINGS_ENDPOINT, {
          body: JSON.stringify({
            dimensions: options.dimensions,
            encoding_format: "float",
            input: input.text,
            model: options.modelId
          }),
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json"
          },
          method: "POST",
          redirect: "error",
          signal
        });
      } catch {
        throw new EmbeddingProviderError("provider_unavailable", true);
      }
      if (!response.ok) {
        void response.body?.cancel();
        throw responseFailure(response.status);
      }
      return parseEmbeddingResponse(
        await readBoundedResponse(response, maximumResponseBytes, signal),
        { dimensions: options.dimensions, modelId: options.modelId }
      );
    }
  });
}
