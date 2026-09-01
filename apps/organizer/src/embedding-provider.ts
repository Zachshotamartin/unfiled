import { OrganizerProviderError } from "./errors.js";

const ENDPOINT = "https://api.openai.com/v1/embeddings";
const MAX_INPUT_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_DIMENSIONS = 4_096;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type OrganizerEmbeddingProvider = Readonly<{
  embed(
    input: Readonly<{
      dimensions: number;
      modelId: string;
      signal: AbortSignal;
      text: string;
    }>
  ): Promise<Float32Array>;
}>;

export type OpenAIOrganizerEmbeddingProviderOptions = Readonly<{
  apiKey: string;
  fetchImplementation?: typeof fetch;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new OrganizerProviderError("provider_unavailable", true);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const row = record(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index]))
    throw new OrganizerProviderError("provider_unavailable", true);
  return row;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
    throw new OrganizerProviderError("provider_unavailable", true);
  return Number(value);
}

function assertApiKey(value: string): void {
  let hasUnsafeCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) hasUnsafeCharacter = true;
  }
  if (value.length < 20 || value.length > 512 || value.trim() !== value || hasUnsafeCharacter)
    throw new OrganizerProviderError("provider_key_invalid", false);
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new OrganizerProviderError("provider_unavailable", true);
}

function providerFailure(status: number): OrganizerProviderError {
  if (status === 401 || status === 403)
    return new OrganizerProviderError("provider_key_invalid", false, status);
  if (status === 429) return new OrganizerProviderError("rate_limited", true, status);
  return new OrganizerProviderError(
    status === 408 || status === 409 || status >= 500
      ? "provider_unavailable"
      : "validation_failed",
    status === 408 || status === 409 || status === 429 || status >= 500,
    status
  );
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider error bodies are deliberately neither retained nor logged.
  }
}

function fetchWithAbort(
  fetchImplementation: typeof fetch,
  body: string,
  apiKey: string,
  signal: AbortSignal
): Promise<Response> {
  if (signal.aborted) {
    return Promise.reject(new OrganizerProviderError("provider_unavailable", true));
  }
  return new Promise<Response>((resolve, reject) => {
    let wasAborted = false;
    const aborted = (): void => {
      wasAborted = true;
      reject(new OrganizerProviderError("provider_unavailable", true));
    };
    signal.addEventListener("abort", aborted, { once: true });

    let request: Promise<Response>;
    try {
      request = fetchImplementation(ENDPOINT, {
        body,
        cache: "no-store",
        credentials: "omit",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal
      });
    } catch {
      signal.removeEventListener("abort", aborted);
      reject(new OrganizerProviderError("provider_unavailable", true));
      return;
    }

    void request.then(
      (response) => {
        signal.removeEventListener("abort", aborted);
        if (wasAborted || signal.aborted) {
          void discardResponse(response);
          return;
        }
        resolve(response);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        reject(new OrganizerProviderError("provider_unavailable", true));
      }
    );
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw new OrganizerProviderError("provider_unavailable", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let readCompleted = false;
  try {
    for (;;) {
      const part = await readStreamPart(reader, signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        part.value.fill(0);
        try {
          await reader.cancel();
        } catch {
          // The bounded provider failure below is the only surfaced error.
        }
        throw new OrganizerProviderError("provider_unavailable", true);
      }
      chunks.push(part.value);
    }
    assertActive(signal);
    readCompleted = true;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-conforming transport may leave a read pending after cancellation.
    }
    if (!readCompleted) for (const chunk of chunks) chunk.fill(0);
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
    if (error instanceof OrganizerProviderError) throw error;
    throw new OrganizerProviderError("provider_unavailable", true);
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readStreamPart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(new OrganizerProviderError("provider_unavailable", true));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", aborted);
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(new OrganizerProviderError("provider_unavailable", true));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void reader.read().then(
      (part) => {
        if (settled) {
          part.value?.fill(0);
          return;
        }
        settled = true;
        cleanup();
        resolve(part);
      },
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new OrganizerProviderError("provider_unavailable", true));
      }
    );
  });
}

function zeroParsedEmbedding(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const data = (value as Readonly<Record<string, unknown>>).data;
  if (!Array.isArray(data)) return;
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const embedding = (item as Readonly<Record<string, unknown>>).embedding;
    if (Array.isArray(embedding)) embedding.fill(0);
  }
}

function parseEmbedding(
  value: unknown,
  expected: Readonly<{ dimensions: number; modelId: string }>
): Float32Array {
  const root = exact(value, ["data", "model", "object", "usage"]);
  const usage = exact(root.usage, ["prompt_tokens", "total_tokens"]);
  if (
    root.object !== "list" ||
    root.model !== expected.modelId ||
    !Array.isArray(root.data) ||
    root.data.length !== 1 ||
    positiveInteger(usage.prompt_tokens) > positiveInteger(usage.total_tokens)
  )
    throw new OrganizerProviderError("provider_unavailable", true);
  const item = exact(root.data[0], ["embedding", "index", "object"]);
  if (
    item.index !== 0 ||
    item.object !== "embedding" ||
    !Array.isArray(item.embedding) ||
    item.embedding.length !== expected.dimensions
  )
    throw new OrganizerProviderError("provider_unavailable", true);
  const embedding = item.embedding as readonly unknown[];
  const output = new Float32Array(expected.dimensions);
  let norm = 0;
  for (let index = 0; index < embedding.length; index += 1) {
    const component = embedding[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      output.fill(0);
      throw new OrganizerProviderError("provider_unavailable", true);
    }
    const rounded = Math.fround(component);
    output[index] = rounded;
    norm += rounded * rounded;
  }
  if (!Number.isFinite(norm) || norm <= 0) {
    output.fill(0);
    throw new OrganizerProviderError("provider_unavailable", true);
  }
  return output;
}

export function createOpenAIOrganizerEmbeddingProvider(
  options: OpenAIOrganizerEmbeddingProviderOptions
): OrganizerEmbeddingProvider {
  const apiKey = options.apiKey;
  assertApiKey(apiKey);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Object.freeze({
    async embed(input): Promise<Float32Array> {
      if (input.signal.aborted) throw new OrganizerProviderError("provider_unavailable", true);
      if (
        typeof input.modelId !== "string" ||
        typeof input.text !== "string" ||
        !MODEL.test(input.modelId) ||
        !Number.isSafeInteger(input.dimensions) ||
        input.dimensions < 1 ||
        input.dimensions > MAX_DIMENSIONS ||
        input.text.trim().length === 0 ||
        new TextEncoder().encode(input.text).byteLength > MAX_INPUT_BYTES
      )
        throw new OrganizerProviderError("validation_failed", false);
      const body = JSON.stringify({
        dimensions: input.dimensions,
        encoding_format: "float",
        input: input.text,
        model: input.modelId
      });
      const deadline = AbortSignal.timeout(20_000);
      const signal = AbortSignal.any([input.signal, deadline]);
      let attempt = 0;
      for (;;) {
        try {
          const response = await fetchWithAbort(fetchImplementation, body, apiKey, signal);
          if (!response.ok) {
            await discardResponse(response);
            throw providerFailure(response.status);
          }
          const parsed = await readJson(response, signal);
          let output: Float32Array;
          try {
            output = parseEmbedding(parsed, input);
          } finally {
            zeroParsedEmbedding(parsed);
          }
          if (signal.aborted) {
            output.fill(0);
            throw new OrganizerProviderError("provider_unavailable", true);
          }
          return output;
        } catch (error: unknown) {
          const failure =
            error instanceof OrganizerProviderError
              ? error
              : new OrganizerProviderError("provider_unavailable", true);
          if (attempt >= 1 || !failure.retryable || signal.aborted) throw failure;
          attempt += 1;
        }
      }
    }
  });
}
