import { OrganizerPlannerReviewError, OrganizerProviderError } from "./errors.js";

/**
 * Provider-neutral HTTP transport helpers shared by the OpenAI and Anthropic
 * planners. Every helper is bounded, cancellation-aware, and content-free in
 * its failures: provider bodies are never retained, logged, or rethrown.
 */
export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1_024;

export type ProviderRequestHeaders = Readonly<Record<string, string>>;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertProviderApiKey(apiKey: string): void {
  let hasUnsafeCharacter = false;
  for (let index = 0; index < apiKey.length; index += 1) {
    const codeUnit = apiKey.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) hasUnsafeCharacter = true;
  }
  if (apiKey.length < 20 || apiKey.length > 512 || apiKey.trim() !== apiKey || hasUnsafeCharacter) {
    throw new OrganizerProviderError("provider_key_invalid", false);
  }
}

/** Shared HTTP status policy. 529 is Anthropic's documented overload status. */
export function providerResponseFailure(status: number): OrganizerProviderError {
  if (status === 401 || status === 403)
    return new OrganizerProviderError("provider_key_invalid", false, status);
  if (status === 429) return new OrganizerProviderError("rate_limited", true, status);
  if (status === 408 || status === 409 || status === 529 || status >= 500)
    return new OrganizerProviderError("provider_unavailable", true, status);
  return new OrganizerProviderError("validation_failed", false, status);
}

export async function discardProviderResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider error bodies are deliberately neither retained nor logged.
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

/** Reads at most {@link MAX_PROVIDER_RESPONSE_BYTES} and zeroes every buffer afterwards. */
export async function readBoundedProviderJson(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  if (response.body === null) throw new OrganizerProviderError("provider_unavailable", true, 200);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let readCompleted = false;
  try {
    for (;;) {
      const part = await readStreamPart(reader, signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        part.value.fill(0);
        await reader.cancel();
        throw new OrganizerPlannerReviewError("invalid_output");
      }
      chunks.push(part.value);
    }
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
    if (error instanceof OrganizerPlannerReviewError) throw error;
    throw new OrganizerProviderError("provider_unavailable", true, 200);
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function fetchProviderWithAbort(
  fetchImplementation: typeof fetch,
  endpoint: string,
  headers: ProviderRequestHeaders,
  body: string,
  signal: AbortSignal
): Promise<Response> {
  if (signal.aborted)
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void fetchImplementation(endpoint, {
      body,
      cache: "no-store",
      credentials: "omit",
      headers,
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal
    }).then(
      (response) => {
        signal.removeEventListener("abort", aborted);
        if (settled || signal.aborted) {
          settled = true;
          void discardProviderResponse(response);
          return;
        }
        settled = true;
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        if (settled) return;
        settled = true;
        reject(
          error instanceof Error ? error : new OrganizerProviderError("provider_unavailable", true)
        );
      }
    );
  });
}

export function providerNetworkFailure(
  error: unknown
): OrganizerProviderError | OrganizerPlannerReviewError {
  if (error instanceof OrganizerProviderError || error instanceof OrganizerPlannerReviewError)
    return error;
  return new OrganizerProviderError("provider_unavailable", true);
}

export function providerFailureRetryable(
  error: unknown,
  attempt: number,
  maxRetries: number,
  signal: AbortSignal
): boolean {
  if (attempt >= maxRetries || signal.aborted) return false;
  if (error instanceof OrganizerPlannerReviewError) return false;
  return !(error instanceof OrganizerProviderError) || error.retryable;
}
