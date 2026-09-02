import { describe, expect, it, vi } from "vitest";

import { createOpenAiProviderKeyValidator } from "./provider-key-validator";

const API_KEY = "sk-example-not-a-real-key-1234";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("OpenAI provider-key validator", () => {
  it("uses one body-free no-store model lookup and never puts the key in the URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const validator = createOpenAiProviderKeyValidator({ fetch: fetcher });

    await validator.validate("openai", API_KEY, new AbortController().signal);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl(url ?? "")).toBe("https://api.openai.com/v1/models/gpt-5.4-mini-2026-03-17");
    expect(requestUrl(url ?? "")).not.toContain(API_KEY);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("accepts an explicit loopback validation endpoint only in the isolated test identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const validator = createOpenAiProviderKeyValidator({
      environment: {
        CI: "true",
        NODE_ENV: "test",
        UNFILED_ALLOW_TEST_PROVIDER_VALIDATION_OVERRIDE: "1",
        UNFILED_TEST_OPENAI_VALIDATION_URL:
          "http://127.0.0.1:3101/v1/models/gpt-5.4-mini-2026-03-17"
      },
      fetch: fetcher
    });

    await validator.validate("openai", API_KEY, new AbortController().signal);

    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(
      "http://127.0.0.1:3101/v1/models/gpt-5.4-mini-2026-03-17"
    );
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
  ] as const)("rejects a loopback override in the %s", async (_label, environment) => {
    const fetcher = vi.fn<typeof fetch>();
    const validator = createOpenAiProviderKeyValidator({
      environment: {
        ...environment,
        UNFILED_TEST_OPENAI_VALIDATION_URL:
          "http://127.0.0.1:3101/v1/models/gpt-5.4-mini-2026-03-17"
      },
      fetch: fetcher
    });

    await expect(
      validator.validate("openai", API_KEY, new AbortController().signal)
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1:3101/v1/models/gpt-5.4-mini-2026-03-17",
    "http://localhost:3101/v1/models/gpt-5.4-mini-2026-03-17",
    "http://127.0.0.1:3101/v1/models/gpt-5.4-mini-2026-03-17?redirect=1",
    "http://127.0.0.1:3101/v1/models/other"
  ])("rejects the non-canonical test validation URL %s", async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    const validator = createOpenAiProviderKeyValidator({
      environment: {
        CI: "true",
        NODE_ENV: "test",
        UNFILED_ALLOW_TEST_PROVIDER_VALIDATION_OVERRIDE: "1",
        UNFILED_TEST_OPENAI_VALIDATION_URL: url
      },
      fetch: fetcher
    });

    await expect(
      validator.validate("openai", API_KEY, new AbortController().signal)
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, 400, "provider_key_invalid"],
    [403, 400, "provider_key_invalid"],
    [429, 429, "rate_limited"],
    [500, 503, "provider_unavailable"]
  ] as const)("maps OpenAI %s without reflecting its response body", async (status, http, code) => {
    const canary = "provider-secret-response-canary";
    const validator = createOpenAiProviderKeyValidator({
      fetch: vi.fn(() => Promise.resolve(new Response(canary, { status })))
    });

    let failure: unknown;
    try {
      await validator.validate("openai", API_KEY, new AbortController().signal);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code, status: http });
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(API_KEY);
  });

  it("maps transport failures to a content-free retryable error", async () => {
    const validator = createOpenAiProviderKeyValidator({
      fetch: vi.fn(() => Promise.reject(new Error(`network ${API_KEY}`)))
    });

    await expect(
      validator.validate("openai", API_KEY, new AbortController().signal)
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
  });
});
