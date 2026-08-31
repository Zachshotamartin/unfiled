import { describe, expect, it, vi } from "vitest";

import { createOpenAiEmbeddingProvider, EmbeddingProviderError } from "../src/embedding-provider";

const API_KEY = "sk-test-key-with-enough-random-looking-characters";

function provider(fetchImplementation: typeof fetch, overrides = {}) {
  return createOpenAiEmbeddingProvider({
    apiKey: API_KEY,
    dimensions: 3,
    fetchImplementation,
    maxInputBytes: 128,
    modelId: "text-embedding-3-small",
    timeoutMs: 1_000,
    ...overrides
  });
}

function success(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    data: [{ embedding: [0.25, -0.5, 1], index: 0, object: "embedding" }],
    model: "text-embedding-3-small",
    object: "list",
    usage: { prompt_tokens: 2, total_tokens: 2 },
    ...overrides
  });
}

describe("OpenAI embedding provider boundary", () => {
  it("sends one bounded, non-stored embedding request and parses finite float32", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(success());
    const signal = new AbortController().signal;

    const vector = await provider(fetchImplementation).embed({
      dimensions: 3,
      modelId: "text-embedding-3-small",
      signal,
      text: "An encrypted note"
    });

    expect(Array.from(vector)).toEqual([0.25, -0.5, 1]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    if (typeof request?.body !== "string") throw new Error("Expected a JSON request body.");
    expect(JSON.parse(request.body) as unknown).toEqual({
      dimensions: 3,
      encoding_format: "float",
      input: "An encrypted note",
      model: "text-embedding-3-small"
    });
    expect(request.headers).toMatchObject({ authorization: `Bearer ${API_KEY}` });
  });

  it("rejects mismatched model, dimensions, empty, oversized, and aborted input before fetch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const active = new AbortController().signal;
    const aborted = AbortSignal.abort();
    const service = provider(fetchImplementation);
    const inputs = [
      { dimensions: 2, modelId: "text-embedding-3-small", signal: active, text: "valid" },
      { dimensions: 3, modelId: "other", signal: active, text: "valid" },
      { dimensions: 3, modelId: "text-embedding-3-small", signal: active, text: "   " },
      {
        dimensions: 3,
        modelId: "text-embedding-3-small",
        signal: active,
        text: "x".repeat(129)
      },
      { dimensions: 3, modelId: "text-embedding-3-small", signal: aborted, text: "valid" }
    ];

    for (const input of inputs) {
      await expect(service.embed(input)).rejects.toMatchObject({
        safeCode: "validation_failed",
        retryable: false
      });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("strictly rejects response drift, model/dimension mismatch, and non-finite values", async () => {
    const malformed = [
      success({ extra: true }),
      success({ model: "text-embedding-3-large" }),
      success({ data: [{ embedding: [1, 2], index: 0, object: "embedding" }] }),
      success({ data: [{ embedding: [1, null, 3], index: 0, object: "embedding" }] }),
      success({ usage: { prompt_tokens: 0, total_tokens: 0 } })
    ];
    for (const response of malformed) {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        provider(fetchImplementation).embed({
          dimensions: 3,
          modelId: "text-embedding-3-small",
          signal: new AbortController().signal,
          text: "valid"
        })
      ).rejects.toBeInstanceOf(EmbeddingProviderError);
    }
  });

  it("maps only safe provider status classes and never includes a response canary", async () => {
    for (const [status, safeCode] of [
      [401, "provider_key_invalid"],
      [429, "rate_limited"],
      [503, "provider_unavailable"]
    ] as const) {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private-plaintext-canary", { status }));
      let caught: unknown;
      try {
        await provider(fetchImplementation).embed({
          dimensions: 3,
          modelId: "text-embedding-3-small",
          signal: new AbortController().signal,
          text: "valid"
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({ safeCode });
      expect(String(caught)).not.toContain("private-plaintext-canary");
    }
  });

  it("bounds the response stream and maps network/abort failures generically", async () => {
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(1_025), { status: 200 }));
    await expect(
      provider(oversized, { maxResponseBytes: 1_024 }).embed({
        dimensions: 3,
        modelId: "text-embedding-3-small",
        signal: new AbortController().signal,
        text: "valid"
      })
    ).rejects.toMatchObject({ safeCode: "provider_unavailable" });

    const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-canary"));
    await expect(
      provider(failed).embed({
        dimensions: 3,
        modelId: "text-embedding-3-small",
        signal: new AbortController().signal,
        text: "valid"
      })
    ).rejects.toMatchObject({ safeCode: "provider_unavailable" });
  });

  it("fails closed for unsafe provider configuration without revealing the key", () => {
    const canary = "short";
    expect(() =>
      createOpenAiEmbeddingProvider({
        apiKey: canary,
        dimensions: 0,
        maxInputBytes: 0,
        modelId: "bad model",
        timeoutMs: 0
      })
    ).toThrow(EmbeddingProviderError);
    try {
      createOpenAiEmbeddingProvider({
        apiKey: canary,
        dimensions: 0,
        maxInputBytes: 0,
        modelId: "bad model",
        timeoutMs: 0
      });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(canary);
    }
  });
});
