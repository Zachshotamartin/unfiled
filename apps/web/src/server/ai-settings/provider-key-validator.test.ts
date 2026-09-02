import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_KEY_VALIDATION_URL,
  createOpenAiProviderKeyValidator,
  createProviderKeyValidator,
  OPENAI_KEY_VALIDATION_MODEL,
  OPENAI_KEY_VALIDATION_URL
} from "./provider-key-validator";

const OPENAI_KEY = "sk-test-example-not-a-real-key-1234";
const ANTHROPIC_KEY = "sk-ant-test-example-not-a-real-key-wxyz";
const LOOPBACK_OPENAI_URL = `http://127.0.0.1:3101/v1/models/${OPENAI_KEY_VALIDATION_MODEL}`;
const LOOPBACK_ANTHROPIC_URL = "http://127.0.0.1:3102/v1/models?limit=1";
const TEST_IDENTITY = Object.freeze({
  CI: "true",
  NODE_ENV: "test",
  UNFILED_ALLOW_TEST_PROVIDER_VALIDATION_OVERRIDE: "1"
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

async function failureOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the validator to reject");
}

function consoleSpies() {
  return {
    debug: vi.spyOn(console, "debug").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined)
  };
}

function loggedText(spies: ReturnType<typeof consoleSpies>): string {
  return Object.values(spies)
    .flatMap((spy) => spy.mock.calls)
    .map((call) => call.map((value) => String(value)).join(" "))
    .join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider-key validator routing", () => {
  it("publishes registry-v2 validation targets for both providers", () => {
    expect(OPENAI_KEY_VALIDATION_MODEL).toBe("gpt-5.6-terra");
    expect(OPENAI_KEY_VALIDATION_URL).toBe("https://api.openai.com/v1/models/gpt-5.6-terra");
    expect(ANTHROPIC_KEY_VALIDATION_URL).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(ANTHROPIC_API_VERSION).toBe("2023-06-01");
  });

  it("sends an OpenAI key only to OpenAI with a bearer header and no body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const validator = createProviderKeyValidator({ fetch: fetcher });

    await validator.validate("openai", OPENAI_KEY, signal());

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl(url ?? "")).toBe("https://api.openai.com/v1/models/gpt-5.6-terra");
    expect(requestUrl(url ?? "")).not.toContain(OPENAI_KEY);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("anthropic-version")).toBeNull();
    expect(headers.get("cache-control")).toBe("no-store");
  });

  it("sends an Anthropic key only to Anthropic with x-api-key and anthropic-version", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const validator = createProviderKeyValidator({ fetch: fetcher });

    await validator.validate("anthropic", ANTHROPIC_KEY, signal());

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl(url ?? "")).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(requestUrl(url ?? "")).not.toContain(ANTHROPIC_KEY);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(ANTHROPIC_KEY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBeNull();
  });

  it("never crosses providers even when both keys are validated back to back", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const validator = createProviderKeyValidator({ fetch: fetcher });

    await validator.validate("openai", OPENAI_KEY, signal());
    await validator.validate("anthropic", ANTHROPIC_KEY, signal());

    const calls = fetcher.mock.calls.map(([url, init]) => ({
      headers: new Headers(init?.headers),
      host: new URL(requestUrl(url)).host
    }));
    expect(calls.map((call) => call.host)).toEqual(["api.openai.com", "api.anthropic.com"]);
    expect(calls[0]?.headers.get("authorization")).toContain(OPENAI_KEY);
    expect(calls[0]?.headers.get("x-api-key")).toBeNull();
    expect(calls[1]?.headers.get("x-api-key")).toBe(ANTHROPIC_KEY);
    expect(calls[1]?.headers.get("authorization")).toBeNull();
    expect(JSON.stringify([...(calls[0]?.headers.entries() ?? [])])).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify([...(calls[1]?.headers.entries() ?? [])])).not.toContain(OPENAI_KEY);
  });

  it("rejects an unsupported provider before any request is sent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const validator = createProviderKeyValidator({ fetch: fetcher });

    await expect(validator.validate("google" as never, OPENAI_KEY, signal())).rejects.toMatchObject(
      { code: "validation_failed", status: 400 }
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the OpenAI-only constructor as an alias of the shared validator", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const validator = createOpenAiProviderKeyValidator({ fetch: fetcher });

    await validator.validate("anthropic", ANTHROPIC_KEY, signal());

    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(ANTHROPIC_KEY_VALIDATION_URL);
  });
});

describe.each([
  ["openai", OPENAI_KEY, "OpenAI"],
  ["anthropic", ANTHROPIC_KEY, "Anthropic"]
] as const)("%s validation outcomes", (provider, apiKey, label) => {
  it("accepts a 200 without reading or reflecting the response body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel,
          pull,
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":[{"id":"model"}]}'));
          }
        }),
        { status: 200 }
      )
    );
    const validator = createProviderKeyValidator({ fetch: fetcher });

    await expect(validator.validate(provider, apiKey, signal())).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });

  it("treats malformed JSON as irrelevant because only the status is trusted", async () => {
    const validator = createProviderKeyValidator({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("{not json", {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
        .mockResolvedValueOnce(
          new Response("<html>oops</html>", {
            status: 401,
            headers: { "content-type": "application/json" }
          })
        )
    });

    await expect(validator.validate(provider, apiKey, signal())).resolves.toBeUndefined();
    await expect(validator.validate(provider, apiKey, signal())).rejects.toMatchObject({
      code: "provider_key_invalid",
      status: 400
    });
  });

  it("cancels an unbounded response body instead of buffering it", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel,
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
          }
        }),
        { status: 500 }
      )
    );
    const validator = createProviderKeyValidator({ fetch: fetcher });

    await expect(validator.validate(provider, apiKey, signal())).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it.each([
    [401, 400, "provider_key_invalid"],
    [403, 400, "provider_key_invalid"],
    [429, 429, "rate_limited"],
    [500, 503, "provider_unavailable"],
    [502, 503, "provider_unavailable"],
    [503, 503, "provider_unavailable"],
    [404, 503, "provider_unavailable"],
    [302, 503, "provider_unavailable"]
  ] as const)(
    `maps ${label} %s without reflecting its response body`,
    async (status, http, code) => {
      const canary = "provider-secret-response-canary";
      const spies = consoleSpies();
      const validator = createProviderKeyValidator({
        fetch: vi.fn(() => Promise.resolve(new Response(canary, { status })))
      });

      const failure = await failureOf(() => validator.validate(provider, apiKey, signal()));

      expect(failure).toMatchObject({ code, status: http });
      expect(failure).toBeInstanceOf(Error);
      const serialized = `${JSON.stringify(failure)} ${(failure as Error).message} ${
        (failure as Error).stack ?? ""
      }`;
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(apiKey);
      expect(serialized).toContain(label);
      expect(loggedText(spies)).not.toContain(apiKey);
      expect(loggedText(spies)).not.toContain(canary);
    }
  );

  it("maps transport failures to a content-free retryable error", async () => {
    const spies = consoleSpies();
    const validator = createProviderKeyValidator({
      fetch: vi.fn(() => Promise.reject(new Error(`network ${apiKey}`)))
    });

    const failure = await failureOf(() => validator.validate(provider, apiKey, signal()));

    expect(failure).toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(`${JSON.stringify(failure)} ${(failure as Error).message}`).not.toContain(apiKey);
    expect(loggedText(spies)).not.toContain(apiKey);
  });

  it("maps an aborted or timed-out request to a content-free retryable error", async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      const requestSignal = init?.signal;
      if (requestSignal?.aborted === true) {
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      }
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true }
        );
      });
    });
    const validator = createProviderKeyValidator({ fetch: fetcher });

    await expect(validator.validate(provider, apiKey, abortedSignal())).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });

    const controller = new AbortController();
    const pending = validator.validate(provider, apiKey, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal !== undefined)).toBe(true);
  });
});

describe("loopback validation overrides", () => {
  it("accepts an explicit loopback endpoint per provider only in the isolated test identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const validator = createProviderKeyValidator({
      environment: {
        ...TEST_IDENTITY,
        UNFILED_TEST_ANTHROPIC_VALIDATION_URL: LOOPBACK_ANTHROPIC_URL,
        UNFILED_TEST_OPENAI_VALIDATION_URL: LOOPBACK_OPENAI_URL
      },
      fetch: fetcher
    });

    await validator.validate("openai", OPENAI_KEY, signal());
    await validator.validate("anthropic", ANTHROPIC_KEY, signal());

    expect(fetcher.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      LOOPBACK_OPENAI_URL,
      LOOPBACK_ANTHROPIC_URL
    ]);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("x-api-key")).toBe(ANTHROPIC_KEY);
  });

  it("does not let one provider's override redirect the other provider", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const validator = createProviderKeyValidator({
      environment: {
        ...TEST_IDENTITY,
        UNFILED_TEST_OPENAI_VALIDATION_URL: LOOPBACK_OPENAI_URL
      },
      fetch: fetcher
    });

    await validator.validate("anthropic", ANTHROPIC_KEY, signal());

    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(ANTHROPIC_KEY_VALIDATION_URL);
  });

  it.each([
    [
      "production identity",
      {
        NODE_ENV: "production",
        CI: "true",
        UNFILED_ALLOW_TEST_PROVIDER_VALIDATION_OVERRIDE: "1"
      }
    ],
    [
      "missing CI identity",
      { NODE_ENV: "test", UNFILED_ALLOW_TEST_PROVIDER_VALIDATION_OVERRIDE: "1" }
    ],
    ["missing explicit opt-in", { NODE_ENV: "test", CI: "true" }],
    [
      "Vercel identity",
      {
        NODE_ENV: "test",
        CI: "true",
        UNFILED_ALLOW_TEST_PROVIDER_VALIDATION_OVERRIDE: "1",
        VERCEL_ENV: "preview"
      }
    ]
  ] as const)("rejects loopback overrides in the %s", async (_label, environment) => {
    const fetcher = vi.fn<typeof fetch>();
    const validator = createProviderKeyValidator({
      environment: {
        ...environment,
        UNFILED_TEST_ANTHROPIC_VALIDATION_URL: LOOPBACK_ANTHROPIC_URL,
        UNFILED_TEST_OPENAI_VALIDATION_URL: LOOPBACK_OPENAI_URL
      },
      fetch: fetcher
    });

    await expect(validator.validate("openai", OPENAI_KEY, signal())).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
    await expect(validator.validate("anthropic", ANTHROPIC_KEY, signal())).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["openai", `https://127.0.0.1:3101/v1/models/${OPENAI_KEY_VALIDATION_MODEL}`],
    ["openai", `http://localhost:3101/v1/models/${OPENAI_KEY_VALIDATION_MODEL}`],
    ["openai", `http://127.0.0.1:3101/v1/models/${OPENAI_KEY_VALIDATION_MODEL}?redirect=1`],
    ["openai", "http://127.0.0.1:3101/v1/models/other"],
    ["openai", "http://127.0.0.1/v1/models/gpt-5.6-terra"],
    ["openai", "http://user:pw@127.0.0.1:3101/v1/models/gpt-5.6-terra"],
    ["anthropic", "https://127.0.0.1:3102/v1/models?limit=1"],
    ["anthropic", "http://localhost:3102/v1/models?limit=1"],
    ["anthropic", "http://127.0.0.1:3102/v1/models"],
    ["anthropic", "http://127.0.0.1:3102/v1/models?limit=100"],
    ["anthropic", "http://127.0.0.1:3102/v1/messages?limit=1"],
    ["anthropic", "not a url"]
  ] as const)("rejects the non-canonical %s test validation URL %s", async (provider, url) => {
    const fetcher = vi.fn<typeof fetch>();
    const validator = createProviderKeyValidator({
      environment: {
        ...TEST_IDENTITY,
        ...(provider === "openai"
          ? { UNFILED_TEST_OPENAI_VALIDATION_URL: url }
          : { UNFILED_TEST_ANTHROPIC_VALIDATION_URL: url })
      },
      fetch: fetcher
    });

    await expect(
      validator.validate(provider, provider === "openai" ? OPENAI_KEY : ANTHROPIC_KEY, signal())
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
