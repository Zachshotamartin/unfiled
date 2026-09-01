import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenAIOrganizerEmbeddingProvider,
  type OrganizerEmbeddingProvider
} from "../src/embedding-provider.js";
import { OrganizerProviderError } from "../src/errors.js";

const API_KEY = "a".repeat(32);
const MODEL_ID = "text-embedding-3-small";
const MAX_INPUT_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 256 * 1_024;

type EmbedInput = Parameters<OrganizerEmbeddingProvider["embed"]>[0];

function input(overrides: Partial<EmbedInput> = {}): EmbedInput {
  return {
    dimensions: 3,
    modelId: MODEL_ID,
    signal: new AbortController().signal,
    text: "A private capture",
    ...overrides
  };
}

function payload(
  overrides: Readonly<{
    embedding?: readonly unknown[];
    modelId?: string;
    root?: Readonly<Record<string, unknown>>;
  }> = {}
): unknown {
  return {
    data: [
      {
        embedding: overrides.embedding ?? [0.25, -0.5, 1],
        index: 0,
        object: "embedding"
      }
    ],
    model: overrides.modelId ?? MODEL_ID,
    object: "list",
    usage: { prompt_tokens: 3, total_tokens: 3 },
    ...overrides.root
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function trackedResponse(
  body: string | Uint8Array,
  status = 200
): Readonly<{
  bytes: Uint8Array;
  cancelled: () => boolean;
  response: Response;
}> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      wasCancelled = true;
    },
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
  return {
    bytes,
    cancelled: () => wasCancelled,
    response: new Response(stream, { status })
  };
}

function service(fetchImplementation: typeof fetch): OrganizerEmbeddingProvider {
  return createOpenAIOrganizerEmbeddingProvider({ apiKey: API_KEY, fetchImplementation });
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((value) => value === 0);
}

afterEach(() => vi.restoreAllMocks());

describe("OpenAI organizer embedding provider", () => {
  it("sends the exact bounded request and returns finite float32 values", async () => {
    const response = trackedResponse(JSON.stringify(payload({ embedding: [1 / 3, -0.5, 1] })));
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response.response);
    const options = { apiKey: API_KEY, fetchImplementation };
    const provider = createOpenAIOrganizerEmbeddingProvider(options);
    options.apiKey = "mutated-after-construction-should-not-be-used";

    const vector = await provider.embed(input());

    expect(Array.from(vector)).toEqual([Math.fround(1 / 3), -0.5, 1]);
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
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    if (typeof request?.body !== "string") throw new Error("Expected a JSON request body.");
    expect(JSON.parse(request.body) as unknown).toEqual({
      dimensions: 3,
      encoding_format: "float",
      input: "A private capture",
      model: MODEL_ID
    });
    expect(allZero(response.bytes)).toBe(true);
  });

  it.each(["short", ` ${API_KEY}`, `${API_KEY} `, `${API_KEY}\n`, "x".repeat(513)])(
    "rejects an unsafe API key without retaining it: %j",
    (apiKey) => {
      let caught: unknown;
      try {
        createOpenAIOrganizerEmbeddingProvider({ apiKey });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({
        retryable: false,
        safeCode: "provider_key_invalid",
        status: null
      });
      expect(String(caught)).not.toContain(apiKey);
    }
  );

  it("rejects invalid model, dimension, empty, and byte-bounded text before fetch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const provider = service(fetchImplementation);
    const invalid: EmbedInput[] = [
      input({ modelId: "" }),
      input({ modelId: "bad model" }),
      input({ modelId: `m${"x".repeat(200)}` }),
      input({ dimensions: 0 }),
      input({ dimensions: 4_097 }),
      input({ dimensions: 1.5 }),
      input({ text: "" }),
      input({ text: " \n\t " }),
      input({ text: `${"é".repeat(MAX_INPUT_BYTES / 2)}x` })
    ];

    for (const request of invalid) {
      await expect(provider.embed(request)).rejects.toMatchObject({
        retryable: false,
        safeCode: "validation_failed",
        status: null
      });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("accepts exact input, model, and dimension boundaries", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request.");
      const request = JSON.parse(init.body) as { dimensions: number; model: string };
      const embedding = Array.from({ length: request.dimensions }, (_value, index) =>
        index === 0 ? 1 : 0
      );
      return Promise.resolve(jsonResponse(payload({ embedding, modelId: request.model })));
    });
    const provider = service(fetchImplementation);
    const maximumModel = `m${"x".repeat(199)}`;

    await expect(
      provider.embed(
        input({ dimensions: 1, modelId: maximumModel, text: "é".repeat(MAX_INPUT_BYTES / 2) })
      )
    ).resolves.toEqual(new Float32Array([1]));
    await expect(provider.embed(input({ dimensions: 4_096 }))).resolves.toHaveLength(4_096);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("maps a pre-aborted caller signal without starting a request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      service(fetchImplementation).embed(input({ signal: AbortSignal.abort() }))
    ).rejects.toMatchObject({
      retryable: true,
      safeCode: "provider_unavailable",
      status: null
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("fails before fetch if the combined deadline wins the request-start race", async () => {
    const any = vi.spyOn(AbortSignal, "any").mockReturnValue(AbortSignal.abort());
    const fetchImplementation = vi.fn<typeof fetch>();

    await expect(service(fetchImplementation).embed(input())).rejects.toMatchObject({
      retryable: true,
      safeCode: "provider_unavailable"
    });
    expect(any).toHaveBeenCalledOnce();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    [400, "validation_failed", false, 1],
    [401, "provider_key_invalid", false, 1],
    [403, "provider_key_invalid", false, 1],
    [404, "validation_failed", false, 1],
    [408, "provider_unavailable", true, 2],
    [409, "provider_unavailable", true, 2],
    [422, "validation_failed", false, 1],
    [429, "rate_limited", true, 2],
    [500, "provider_unavailable", true, 2],
    [503, "provider_unavailable", true, 2]
  ] as const)(
    "maps HTTP %i, cancels its body, and performs only the configured retry",
    async (status, safeCode, retryable, calls) => {
      const responses: ReturnType<typeof trackedResponse>[] = [];
      const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(() => {
        const response = trackedResponse("PRIVATE-PROVIDER-ERROR-CANARY", status);
        responses.push(response);
        return Promise.resolve(response.response);
      });
      let caught: unknown;
      try {
        await service(fetchImplementation).embed(input());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({ retryable, safeCode, status });
      expect(caught).toBeInstanceOf(OrganizerProviderError);
      expect(String(caught)).not.toContain("PRIVATE-PROVIDER-ERROR-CANARY");
      expect(fetchImplementation).toHaveBeenCalledTimes(calls);
      expect(responses).toHaveLength(calls);
      expect(responses.every((response) => response.cancelled())).toBe(true);
    }
  );

  it("uses one outer deadline while retrying one transient response", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(payload()));

    await expect(service(fetchImplementation).embed(input())).resolves.toEqual(
      new Float32Array([0.25, -0.5, 1])
    );

    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal).toBe(
      fetchImplementation.mock.calls[1]?.[1]?.signal
    );
  });

  it("retries one asynchronous or synchronous transport failure without retaining content", async () => {
    for (const fetchImplementation of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error("PRIVATE-ASYNC-TRANSPORT-CANARY")),
      vi.fn<typeof fetch>().mockImplementation(() => {
        throw new Error("PRIVATE-SYNC-TRANSPORT-CANARY");
      })
    ]) {
      let caught: unknown;
      try {
        await service(fetchImplementation).embed(input());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({
        retryable: true,
        safeCode: "provider_unavailable",
        status: null
      });
      expect(String(caught)).not.toContain("CANARY");
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    }
  });

  it("sanitizes an unexpected response-boundary exception", async () => {
    const response = {
      get ok(): boolean {
        throw new Error("PRIVATE-RESPONSE-BOUNDARY-CANARY");
      }
    } as Response;
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response);
    let caught: unknown;
    try {
      await service(fetchImplementation).embed(input());
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({
      retryable: true,
      safeCode: "provider_unavailable",
      status: null
    });
    expect(String(caught)).not.toContain("PRIVATE-RESPONSE-BOUNDARY-CANARY");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("settles promptly on caller cancellation even when fetch ignores its signal", async () => {
    const controller = new AbortController();
    let resolveLate: ((response: Response) => void) | undefined;
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveLate = resolve;
        })
    );
    const pending = service(fetchImplementation).embed(input({ signal: controller.signal }));
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      retryable: true,
      safeCode: "provider_unavailable"
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();

    const late = trackedResponse(JSON.stringify(payload()));
    resolveLate?.(late.response);
    await vi.waitFor(() => expect(late.cancelled()).toBe(true));
  });

  it("enforces the outer deadline even when fetch ignores its signal", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          void resolve;
        })
    );
    const pending = service(fetchImplementation).embed(input());
    deadline.abort();

    await expect(pending).rejects.toMatchObject({
      retryable: true,
      safeCode: "provider_unavailable"
    });
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("cancels a stalled body read and scrubs already-read chunks", async () => {
    const controller = new AbortController();
    const firstChunk = new TextEncoder().encode('{"data":[');
    let markPull: (() => void) | undefined;
    const pullStarted = new Promise<void>((resolve) => {
      markPull = resolve;
    });
    let wasCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        wasCancelled = true;
        return Promise.reject(new Error("PRIVATE-BODY-CANCEL-CANARY"));
      },
      pull() {
        markPull?.();
        return new Promise<void>(() => undefined);
      },
      start(streamController) {
        streamController.enqueue(firstChunk);
      }
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const pending = service(fetchImplementation).embed(input({ signal: controller.signal }));
    await pullStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ safeCode: "provider_unavailable" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(wasCancelled).toBe(true);
    expect(allZero(firstChunk)).toBe(true);
  });

  it("accepts exactly the response byte limit and scrubs its source chunk", async () => {
    const serialized = JSON.stringify(payload());
    const body = `${serialized}${" ".repeat(MAX_RESPONSE_BYTES - serialized.length)}`;
    const response = trackedResponse(body);

    await expect(
      service(vi.fn<typeof fetch>().mockResolvedValue(response.response)).embed(input())
    ).resolves.toEqual(new Float32Array([0.25, -0.5, 1]));
    expect(response.bytes).toHaveLength(MAX_RESPONSE_BYTES);
    expect(allZero(response.bytes)).toBe(true);
  });

  it("rejects oversized response streams, scrubs every attempt, and never parses them", async () => {
    const parsed = vi.spyOn(JSON, "parse");
    const responses: ReturnType<typeof trackedResponse>[] = [];
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(() => {
      const serialized = JSON.stringify(payload());
      const response = trackedResponse(
        `${serialized}${" ".repeat(MAX_RESPONSE_BYTES + 1 - serialized.length)}`
      );
      responses.push(response);
      return Promise.resolve(response.response);
    });

    await expect(service(fetchImplementation).embed(input())).rejects.toMatchObject({
      retryable: true,
      safeCode: "provider_unavailable"
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(parsed).not.toHaveBeenCalled();
    expect(responses.every((response) => allZero(response.bytes))).toBe(true);
  });

  it.each([
    ["null root", null],
    ["array root", []],
    ["missing root fields", {}],
    ["extra root field", payload({ root: { extra: true } })],
    ["wrong root object", payload({ root: { object: "embedding" } })],
    ["wrong model", payload({ modelId: "text-embedding-3-large" })],
    ["empty data", payload({ root: { data: [] } })],
    ["multiple data", payload({ root: { data: [{}, {}] } })],
    ["missing usage", payload({ root: { usage: null } })],
    [
      "extra usage field",
      payload({ root: { usage: { extra: 1, prompt_tokens: 3, total_tokens: 3 } } })
    ],
    ["zero token usage", payload({ root: { usage: { prompt_tokens: 0, total_tokens: 0 } } })],
    [
      "fractional token usage",
      payload({ root: { usage: { prompt_tokens: 1.5, total_tokens: 2 } } })
    ],
    ["inverted token usage", payload({ root: { usage: { prompt_tokens: 4, total_tokens: 3 } } })],
    ["null item", payload({ root: { data: [null] } })],
    [
      "extra item field",
      payload({
        root: {
          data: [{ embedding: [0.25, -0.5, 1], extra: true, index: 0, object: "embedding" }]
        }
      })
    ],
    [
      "wrong item index",
      payload({ root: { data: [{ embedding: [0.25, -0.5, 1], index: 1, object: "embedding" }] } })
    ],
    [
      "wrong item object",
      payload({ root: { data: [{ embedding: [0.25, -0.5, 1], index: 0, object: "vector" }] } })
    ],
    ["wrong dimensions", payload({ embedding: [1, 2] })],
    ["non-number component", payload({ embedding: [1, "2", 3] })],
    ["null component", payload({ embedding: [1, null, 3] })],
    ["float32 overflow", payload({ embedding: [1, 3.4028236e38, 3] })],
    ["zero norm", payload({ embedding: [0, -0, 0] })]
  ] as const)("strictly rejects malformed response shape: %s", async (_label, value) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(value)));
    await expect(service(fetchImplementation).embed(input())).rejects.toMatchObject({
      retryable: true,
      safeCode: "provider_unavailable",
      status: null
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("rejects missing, invalid-UTF8, and invalid-JSON bodies without retaining content", async () => {
    const cases: readonly (() => Response)[] = [
      () => new Response(null, { status: 200 }),
      () => trackedResponse(new Uint8Array([0xff])).response,
      () => trackedResponse("PRIVATE-INVALID-JSON-CANARY").response
    ];
    for (const response of cases) {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(response()));
      let caught: unknown;
      try {
        await service(fetchImplementation).embed(input());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({ safeCode: "provider_unavailable" });
      expect(String(caught)).not.toContain("PRIVATE-INVALID-JSON-CANARY");
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    }
  });

  it("scrubs the parsed provider embedding while preserving the returned copy", async () => {
    const source = [0.25, -0.5, 1];
    const parsed = payload({ embedding: source });
    const parse = vi.spyOn(JSON, "parse").mockReturnValue(parsed);
    const response = trackedResponse("{}");

    const result = await service(vi.fn<typeof fetch>().mockResolvedValue(response.response)).embed(
      input()
    );
    parse.mockRestore();

    expect(result).toEqual(new Float32Array([0.25, -0.5, 1]));
    expect(source).toEqual([0, 0, 0]);
    expect(allZero(response.bytes)).toBe(true);
  });

  it("uses the platform fetch implementation when no test transport is supplied", async () => {
    const fetchImplementation = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(payload()));

    await expect(
      createOpenAIOrganizerEmbeddingProvider({ apiKey: API_KEY }).embed(input())
    ).resolves.toEqual(new Float32Array([0.25, -0.5, 1]));
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("preserves an already-safe parser failure without retrying", async () => {
    const safe = new OrganizerProviderError("validation_failed", false, 418);
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw safe;
    });
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));

    await expect(service(fetchImplementation).embed(input())).rejects.toBe(safe);
    parse.mockRestore();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("scrubs malformed parsed embedding arrays on every failed attempt", async () => {
    const sources: unknown[][] = [];
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      const source = [1, "PRIVATE-EMBEDDING-CANARY", 3];
      sources.push(source);
      return payload({ embedding: source });
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse({})));

    await expect(service(fetchImplementation).embed(input())).rejects.toMatchObject({
      safeCode: "provider_unavailable"
    });
    parse.mockRestore();

    expect(sources).toHaveLength(2);
    expect(sources).toEqual([
      [0, 0, 0],
      [0, 0, 0]
    ]);
  });

  it("fails closed if cancellation races response parsing", async () => {
    const controller = new AbortController();
    const fill = vi.spyOn(Float32Array.prototype, "fill");
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      controller.abort();
      return payload();
    });

    await expect(
      service(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}))).embed(
        input({ signal: controller.signal })
      )
    ).rejects.toMatchObject({ safeCode: "provider_unavailable" });
    parse.mockRestore();

    expect(fill).toHaveBeenCalledWith(0);
  });

  it("preserves the safe status mapping when cancellation of an error body fails", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error("PRIVATE-CANCEL-CANARY");
        }
      }),
      { status: 400 }
    );
    await expect(
      service(vi.fn<typeof fetch>().mockResolvedValue(response)).embed(input())
    ).rejects.toMatchObject({
      retryable: false,
      safeCode: "validation_failed",
      status: 400
    });
  });
});
