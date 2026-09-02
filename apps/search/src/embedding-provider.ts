import {
  createLocalHashEmbedding,
  LOCAL_HASH_EMBEDDING_DIMENSIONS,
  MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES
} from "@unfiled/search";

import { SEARCH_EMBEDDING_DIMENSIONS, SEARCH_EMBEDDING_MODEL_ID } from "./config.js";
import { SearchServiceError } from "./errors.js";

const OPENAI_EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1/embeddings";
const MAX_INPUT_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_API_KEY_LENGTH = 20;
const MAX_API_KEY_LENGTH = 512;

export type SearchEmbeddingProvider = Readonly<{
  embed(
    input: Readonly<{
      signal: AbortSignal;
      text: string;
    }>
  ): Promise<Float32Array>;
}>;

export type OpenAISearchEmbeddingProviderOptions = Readonly<{
  apiKey: string;
  fetchImplementation?: typeof fetch;
}>;

function localHashEmbedding(text: string): Float32Array {
  let embedding: Float32Array;
  try {
    embedding = createLocalHashEmbedding(text);
  } catch {
    throw providerError("validation_failed", false);
  }
  if (embedding.length !== LOCAL_HASH_EMBEDDING_DIMENSIONS) {
    embedding.fill(0);
    throw providerError("provider_unavailable", false);
  }
  return embedding;
}

/**
 * Provider-free query embedding for the zero-cost beta. It is a deterministic
 * lexical feature hash, not a semantic embedding, and never contacts a provider.
 */
export function createLocalHashSearchEmbeddingProvider(): SearchEmbeddingProvider {
  return Object.freeze({
    embed(input): Promise<Float32Array> {
      try {
        assertActive(input.signal);
        if (
          typeof input.text !== "string" ||
          input.text.trim().length === 0 ||
          new TextEncoder().encode(input.text).byteLength > MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES
        ) {
          throw providerError("validation_failed", false);
        }
        return Promise.resolve(localHashEmbedding(input.text));
      } catch (error: unknown) {
        return Promise.reject(
          error instanceof SearchServiceError ? error : providerError("validation_failed", false)
        );
      }
    }
  });
}

function providerError(
  code: "provider_unavailable" | "rate_limited" | "validation_failed",
  retryable: boolean
): SearchServiceError {
  return new SearchServiceError(code === "validation_failed" ? 400 : 503, code, { retryable });
}

function assertApiKey(value: string): void {
  let unsafe = false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) unsafe = true;
  }
  if (
    value.length < MIN_API_KEY_LENGTH ||
    value.length > MAX_API_KEY_LENGTH ||
    value.trim() !== value ||
    unsafe
  ) {
    throw providerError("provider_unavailable", false);
  }
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw providerError("provider_unavailable", true);
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw providerError("provider_unavailable", true);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const row = object(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    throw providerError("provider_unavailable", true);
  }
  return row;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw providerError("provider_unavailable", true);
  }
  return Number(value);
}

function failureForStatus(status: number): SearchServiceError {
  if (status === 429) return providerError("rate_limited", true);
  if (status === 408 || status === 409 || status >= 500) {
    return providerError("provider_unavailable", true);
  }
  if (status === 400 || status === 404 || status === 422) {
    return providerError("validation_failed", false);
  }
  return providerError("provider_unavailable", false);
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider response bodies are intentionally never retained or surfaced.
  }
}

function fetchWithAbort(
  fetchImplementation: typeof fetch,
  body: string,
  apiKey: string,
  signal: AbortSignal
): Promise<Response> {
  assertActive(signal);
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(providerError("provider_unavailable", true));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let pending: Promise<Response>;
    try {
      pending = fetchImplementation(OPENAI_EMBEDDINGS_ENDPOINT, {
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
      cleanup();
      settled = true;
      reject(providerError("provider_unavailable", true));
      return;
    }

    void pending.then(
      (response) => {
        if (settled || signal.aborted) {
          void discardResponse(response);
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      },
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(providerError("provider_unavailable", true));
      }
    );
  });
}

function readPart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(providerError("provider_unavailable", true));
    };
    signal.addEventListener("abort", onAbort, { once: true });
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
        reject(providerError("provider_unavailable", true));
      }
    );
  });
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw providerError("provider_unavailable", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const part = await readPart(reader, signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        part.value.fill(0);
        try {
          await reader.cancel();
        } catch {
          // The bounded, redacted error below is authoritative.
        }
        throw providerError("provider_unavailable", true);
      }
      chunks.push(part.value);
    }
    assertActive(signal);
    completed = true;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-conforming stream may retain a pending read after cancellation.
    }
    if (!completed) for (const chunk of chunks) chunk.fill(0);
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
    if (error instanceof SearchServiceError) throw error;
    throw providerError("provider_unavailable", true);
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function wipeParsedEmbedding(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const data = (value as Readonly<Record<string, unknown>>).data;
  if (!Array.isArray(data)) return;
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const embedding = (item as Readonly<Record<string, unknown>>).embedding;
    if (Array.isArray(embedding)) embedding.fill(0);
  }
}

function parseEmbedding(value: unknown): Float32Array {
  const root = exact(value, ["data", "model", "object", "usage"]);
  const usage = exact(root.usage, ["prompt_tokens", "total_tokens"]);
  if (
    root.object !== "list" ||
    root.model !== SEARCH_EMBEDDING_MODEL_ID ||
    !Array.isArray(root.data) ||
    root.data.length !== 1 ||
    positiveInteger(usage.prompt_tokens) > positiveInteger(usage.total_tokens)
  ) {
    throw providerError("provider_unavailable", true);
  }
  const item = exact(root.data[0], ["embedding", "index", "object"]);
  if (
    item.index !== 0 ||
    item.object !== "embedding" ||
    !Array.isArray(item.embedding) ||
    item.embedding.length !== SEARCH_EMBEDDING_DIMENSIONS
  ) {
    throw providerError("provider_unavailable", true);
  }

  const embedding = item.embedding as readonly unknown[];
  const output = new Float32Array(SEARCH_EMBEDDING_DIMENSIONS);
  let norm = 0;
  for (let index = 0; index < embedding.length; index += 1) {
    const component = embedding[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      output.fill(0);
      throw providerError("provider_unavailable", true);
    }
    const rounded = Math.fround(component);
    if (!Number.isFinite(rounded)) {
      output.fill(0);
      throw providerError("provider_unavailable", true);
    }
    output[index] = rounded;
    norm += rounded * rounded;
  }
  if (!Number.isFinite(norm) || norm <= 0) {
    output.fill(0);
    throw providerError("provider_unavailable", true);
  }
  return output;
}

export function createOpenAISearchEmbeddingProvider(
  options: OpenAISearchEmbeddingProviderOptions
): SearchEmbeddingProvider {
  const apiKey = options.apiKey;
  assertApiKey(apiKey);
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return Object.freeze({
    async embed(input): Promise<Float32Array> {
      assertActive(input.signal);
      if (
        typeof input.text !== "string" ||
        input.text.trim().length === 0 ||
        new TextEncoder().encode(input.text).byteLength > MAX_INPUT_BYTES
      ) {
        throw providerError("validation_failed", false);
      }
      const request = Object.freeze({
        body: JSON.stringify({
          dimensions: SEARCH_EMBEDDING_DIMENSIONS,
          encoding_format: "float",
          input: input.text,
          model: SEARCH_EMBEDDING_MODEL_ID
        }),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      });
      let attempt = 0;
      for (;;) {
        try {
          const response = await fetchWithAbort(
            fetchImplementation,
            request.body,
            apiKey,
            request.signal
          );
          if (!response.ok) {
            await discardResponse(response);
            throw failureForStatus(response.status);
          }
          const parsed = await readBoundedJson(response, request.signal);
          let output: Float32Array;
          try {
            output = parseEmbedding(parsed);
          } finally {
            wipeParsedEmbedding(parsed);
          }
          if (request.signal.aborted) {
            output.fill(0);
            throw providerError("provider_unavailable", true);
          }
          return output;
        } catch (error: unknown) {
          const failure =
            error instanceof SearchServiceError
              ? error
              : providerError("provider_unavailable", true);
          if (attempt >= 1 || !failure.retryable || request.signal.aborted) throw failure;
          attempt += 1;
        }
      }
    }
  });
}
