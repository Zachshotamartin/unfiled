import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_HASH_EMBEDDING_DIMENSIONS,
  MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES
} from "@unfiled/search";

import { SEARCH_EMBEDDING_DIMENSIONS, SEARCH_EMBEDDING_MODEL_ID } from "../src/config.js";
import {
  createLocalHashSearchEmbeddingProvider,
  createOpenAISearchEmbeddingProvider,
  type SearchEmbeddingProvider
} from "../src/embedding-provider.js";

const API_KEY = "sk-search-dedicated-abcdefghijklmnopqrstuvwxyz";
const MAX_INPUT_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 256 * 1_024;

type EmbedInput = Parameters<SearchEmbeddingProvider["embed"]>[0];

function input(overrides: Partial<EmbedInput> = {}): EmbedInput {
  return {
    signal: new AbortController().signal,
    text: "private search query",
    ...overrides
  };
}

function embedding(first = 1): number[] {
  return Array.from({ length: SEARCH_EMBEDDING_DIMENSIONS }, (_value, index) =>
    index === 0 ? first : 0
  );
}

function payload(vector: readonly unknown[] = embedding()): unknown {
  return {
    data: [{ embedding: vector, index: 0, object: "embedding" }],
    model: SEARCH_EMBEDDING_MODEL_ID,
    object: "list",
    usage: { prompt_tokens: 3, total_tokens: 3 }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function trackedResponse(
  body: string | Uint8Array,
  status = 200
): Readonly<{
  bytes: Uint8Array;
  cancelled(): boolean;
  response: Response;
}> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let cancelled = false;
  return {
    bytes,
    cancelled: () => cancelled,
    response: new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        }
      }),
      { status }
    )
  };
}

function provider(fetchImplementation: typeof fetch): SearchEmbeddingProvider {
  return createOpenAISearchEmbeddingProvider({ apiKey: API_KEY, fetchImplementation });
}

function allZero(values: Uint8Array | readonly unknown[]): boolean {
  return values.every((value) => value === 0);
}

afterEach(() => vi.restoreAllMocks());

describe("provider-free local hash search embedding provider", () => {
  it("embeds deterministically without network access", async () => {
    const service = createLocalHashSearchEmbeddingProvider();

    const first = await service.embed(input({ text: "oats milk apples" }));
    const second = await service.embed(input({ text: "oats milk apples" }));

    expect(first).toHaveLength(LOCAL_HASH_EMBEDDING_DIMENSIONS);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it("rejects cancellation, blank text, and oversized text", async () => {
    const service = createLocalHashSearchEmbeddingProvider();
    const controller = new AbortController();
    controller.abort();

    await expect(service.embed(input({ signal: controller.signal }))).rejects.toMatchObject({
      code: "provider_unavailable"
    });
    await expect(service.embed(input({ text: "  " }))).rejects.toMatchObject({
      code: "validation_failed"
    });
    await expect(
      service.embed(input({ text: "x".repeat(MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES + 1) }))
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("dedicated OpenAI search embedding provider", () => {
  it("uses only the fixed model and dimensions and scrubs response bytes", async () => {
    const response = trackedResponse(JSON.stringify(payload(embedding(1 / 3))));
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response.response);
    const options = { apiKey: API_KEY, fetchImplementation };
    const service = createOpenAISearchEmbeddingProvider(options);
    options.apiKey = "mutated-key-that-must-never-be-used";

    const result = await service.embed(input());

    expect(result).toHaveLength(SEARCH_EMBEDDING_DIMENSIONS);
    expect(result[0]).toBe(Math.fround(1 / 3));
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, request] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(request).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json"
      },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    if (typeof request?.body !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(request.body) as unknown).toEqual({
      dimensions: SEARCH_EMBEDDING_DIMENSIONS,
      encoding_format: "float",
      input: "private search query",
      model: SEARCH_EMBEDDING_MODEL_ID
    });
    expect(allZero(response.bytes)).toBe(true);
  });

  it.each(["short", ` ${API_KEY}`, `${API_KEY} `, `${API_KEY}\n`, "x".repeat(513)])(
    "rejects an unsafe dedicated key without retaining it: %j",
    (apiKey) => {
      let caught: unknown;
      try {
        createOpenAISearchEmbeddingProvider({ apiKey });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "provider_unavailable", retryable: false, status: 503 });
      expect(String(caught)).not.toContain(apiKey);
    }
  );

  it("rejects empty and byte-oversized query text before fetch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const service = provider(fetchImplementation);
    for (const text of ["", " \n\t ", `${"é".repeat(MAX_INPUT_BYTES / 2)}x`]) {
      await expect(service.embed(input({ text }))).rejects.toMatchObject({
        code: "validation_failed",
        retryable: false,
        status: 400
      });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    [400, "validation_failed", false, 1],
    [401, "provider_unavailable", false, 1],
    [408, "provider_unavailable", true, 2],
    [429, "rate_limited", true, 2],
    [503, "provider_unavailable", true, 2]
  ] as const)(
    "maps HTTP %i, discards its body, and retries only transient failures",
    async (status, code, retryable, attempts) => {
      const responses: ReturnType<typeof trackedResponse>[] = [];
      const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(() => {
        const response = trackedResponse("PRIVATE-PROVIDER-ERROR-CANARY", status);
        responses.push(response);
        return Promise.resolve(response.response);
      });
      let caught: unknown;
      try {
        await provider(fetchImplementation).embed(input());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({ code, retryable });
      expect(String(caught)).not.toContain("PRIVATE-PROVIDER-ERROR-CANARY");
      expect(fetchImplementation).toHaveBeenCalledTimes(attempts);
      expect(responses.every((response) => response.cancelled())).toBe(true);
    }
  );

  it("uses one outer deadline across its single retry", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(payload()));

    await expect(provider(fetchImplementation).embed(input())).resolves.toHaveLength(
      SEARCH_EMBEDDING_DIMENSIONS
    );
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal).toBe(
      fetchImplementation.mock.calls[1]?.[1]?.signal
    );
  });

  it("settles on cancellation even when fetch ignores its signal", async () => {
    const controller = new AbortController();
    let resolveLate: ((response: Response) => void) | undefined;
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveLate = resolve;
        })
    );
    const pending = provider(fetchImplementation).embed(input({ signal: controller.signal }));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "provider_unavailable" });
    const late = trackedResponse(JSON.stringify(payload()));
    resolveLate?.(late.response);
    await vi.waitFor(() => expect(late.cancelled()).toBe(true));
  });

  it("cancels a stalled body read and scrubs every received chunk", async () => {
    const controller = new AbortController();
    const firstChunk = new TextEncoder().encode('{"data":[');
    let markPull: (() => void) | undefined;
    const pullStarted = new Promise<void>((resolve) => {
      markPull = resolve;
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("PRIVATE-CANCEL-CANARY"));
      },
      pull() {
        markPull?.();
        return new Promise<void>(() => undefined);
      },
      start(streamController) {
        streamController.enqueue(firstChunk);
      }
    });
    const pending = provider(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }))
    ).embed(input({ signal: controller.signal }));
    await pullStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(cancelled).toBe(true);
    expect(allZero(firstChunk)).toBe(true);
  });

  it("rejects oversized responses without parsing and scrubs both attempts", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const responses: ReturnType<typeof trackedResponse>[] = [];
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(() => {
      const serialized = JSON.stringify(payload());
      const response = trackedResponse(
        `${serialized}${" ".repeat(MAX_RESPONSE_BYTES + 1 - serialized.length)}`
      );
      responses.push(response);
      return Promise.resolve(response.response);
    });

    await expect(provider(fetchImplementation).embed(input())).rejects.toMatchObject({
      code: "provider_unavailable"
    });
    expect(parse).not.toHaveBeenCalled();
    expect(responses).toHaveLength(2);
    expect(responses.every((response) => allZero(response.bytes))).toBe(true);
  });

  it("strictly rejects malformed embeddings and zeroes the parsed provider array", async () => {
    const source: unknown[] = embedding();
    source[10] = "PRIVATE-EMBEDDING-CANARY";
    const parse = vi.spyOn(JSON, "parse").mockReturnValue(payload(source));
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ignored: true }));

    await expect(provider(fetchImplementation).embed(input())).rejects.toMatchObject({
      code: "provider_unavailable"
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(allZero(source)).toBe(true);
    parse.mockRestore();
  });

  it("wipes a parsed output if cancellation wins response parsing", async () => {
    const controller = new AbortController();
    const fill = vi.spyOn(Float32Array.prototype, "fill");
    vi.spyOn(JSON, "parse").mockImplementation(() => {
      controller.abort();
      return payload();
    });

    await expect(
      provider(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}))).embed(
        input({ signal: controller.signal })
      )
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(fill).toHaveBeenCalledWith(0);
  });
});
