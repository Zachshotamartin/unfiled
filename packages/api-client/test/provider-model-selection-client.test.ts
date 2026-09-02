import { describe, expect, it, vi } from "vitest";

import { ApiClientMalformedResponseError, createApiClient } from "../src/index.js";

const NOW = "2026-09-02T18:30:00.000Z";
const OPENAI_KEY = "sk-test-example-not-a-real-key-1234";
const ANTHROPIC_KEY = "sk-ant-test-example-not-a-real-key-wxyz";

const settings = Object.freeze({
  settingsRevision: 3,
  organizationMode: "balanced" as const,
  providerMode: "byok" as const,
  byokProvider: "openai" as const,
  modelSelection: "auto" as const,
  byokFallbackToApp: false,
  routingEffort: "standard" as const,
  expansionStyle: "brief" as const,
  timezone: "America/Los_Angeles",
  locale: "en-US",
  updatedAt: NOW
});

const anthropicKey = Object.freeze({
  provider: "anthropic" as const,
  lastFour: "wxyz",
  status: "active" as const,
  credentialRevision: 2,
  validatedAt: NOW,
  updatedAt: NOW
});

const openAiKey = Object.freeze({
  provider: "openai" as const,
  lastFour: "1234",
  status: "active" as const,
  credentialRevision: 1,
  validatedAt: NOW,
  updatedAt: NOW
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
      pragma: "no-cache"
    },
    status
  });
}

function makeClient(fetcher: typeof fetch) {
  return createApiClient({
    baseUrl: "https://example.test/",
    fetch: fetcher,
    getAccessToken: () => Promise.resolve("access-token")
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestJsonBody(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number): unknown {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new TypeError("Expected a JSON request body");
  return JSON.parse(body) as unknown;
}

describe("provider-addressed key metadata", () => {
  it("sends exactly one provider query parameter per lookup", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ providerKey: openAiKey }))
      .mockResolvedValueOnce(jsonResponse({ providerKey: anthropicKey }))
      .mockResolvedValueOnce(jsonResponse({ providerKey: null }));
    const client = makeClient(fetcher);

    await expect(client.getProviderKeyMetadata("openai")).resolves.toEqual({
      providerKey: openAiKey
    });
    await expect(client.getProviderKeyMetadata("anthropic")).resolves.toEqual({
      providerKey: anthropicKey
    });
    await expect(client.getProviderKeyMetadata("anthropic")).resolves.toEqual({
      providerKey: null
    });

    const urls = fetcher.mock.calls.map(([input]) => new URL(requestUrl(input)));
    expect(urls.map((url) => url.pathname)).toEqual([
      "/api/v1/me/provider-key",
      "/api/v1/me/provider-key",
      "/api/v1/me/provider-key"
    ]);
    expect(urls.map((url) => [...url.searchParams.entries()])).toEqual([
      [["provider", "openai"]],
      [["provider", "anthropic"]],
      [["provider", "anthropic"]]
    ]);
    expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(fetcher.mock.calls.every(([, init]) => init?.body === undefined)).toBe(true);
  });

  it("rejects an unsupported provider before any request is sent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = makeClient(fetcher);

    await expect(
      // @ts-expect-error The runtime boundary must reject unsupported callers too.
      client.getProviderKeyMetadata("google")
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects metadata whose provider differs from the queried provider", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ providerKey: anthropicKey }))
      .mockResolvedValueOnce(jsonResponse({ providerKey: openAiKey }));
    const client = makeClient(fetcher);

    await expect(client.getProviderKeyMetadata("openai")).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
    await expect(client.getProviderKeyMetadata("anthropic")).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
  });
});

describe("Anthropic key custody", () => {
  it("stores and deletes an Anthropic key with provider-bound receipts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ providerKey: anthropicKey, replayed: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          provider: "anthropic",
          deleted: true,
          deletedCredentialRevision: 2,
          replayed: false
        })
      );
    const client = makeClient(fetcher);

    await expect(
      client.putProviderKey({
        idempotencyKey: "provider-put-anthropic-01",
        provider: "anthropic",
        expectedCredentialRevision: 1,
        apiKey: ANTHROPIC_KEY
      })
    ).resolves.toEqual({ providerKey: anthropicKey, replayed: false });
    await expect(
      client.deleteProviderKey({
        idempotencyKey: "provider-delete-anthropic-01",
        provider: "anthropic",
        expectedCredentialRevision: 2
      })
    ).resolves.toMatchObject({ provider: "anthropic", deleted: true });

    expect(fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method])).toEqual([
      ["https://example.test/api/v1/me/provider-key", "PUT"],
      ["https://example.test/api/v1/me/provider-key", "DELETE"]
    ]);
    expect(requestJsonBody(fetcher, 0)).toEqual({
      idempotencyKey: "provider-put-anthropic-01",
      provider: "anthropic",
      expectedCredentialRevision: 1,
      apiKey: ANTHROPIC_KEY
    });
    expect(requestJsonBody(fetcher, 1)).toEqual({
      idempotencyKey: "provider-delete-anthropic-01",
      provider: "anthropic",
      expectedCredentialRevision: 2
    });
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("idempotency-key")).toMatch(/^provider-(?:put|delete)-anthropic-01$/u);
      expect(headers.get("cache-control")).toBe("no-store");
    }
  });

  it("rejects a stored-key receipt that names the other provider", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ providerKey: { ...openAiKey, lastFour: "wxyz" }, replayed: false })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          provider: "openai",
          deleted: true,
          deletedCredentialRevision: 2,
          replayed: false
        })
      );
    const client = makeClient(fetcher);

    await expect(
      client.putProviderKey({
        idempotencyKey: "provider-put-anthropic-swap",
        provider: "anthropic",
        expectedCredentialRevision: null,
        apiKey: ANTHROPIC_KEY
      })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
    await expect(
      client.deleteProviderKey({
        idempotencyKey: "provider-delete-anthropic-swap",
        provider: "anthropic",
        expectedCredentialRevision: 2
      })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
  });

  it("never sends an OpenAI-shaped request for an Anthropic key or vice versa", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ providerKey: openAiKey, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ providerKey: anthropicKey, replayed: false }));
    const client = makeClient(fetcher);

    await client.putProviderKey({
      idempotencyKey: "provider-put-openai-01",
      provider: "openai",
      expectedCredentialRevision: null,
      apiKey: OPENAI_KEY
    });
    await client.putProviderKey({
      idempotencyKey: "provider-put-anthropic-02",
      provider: "anthropic",
      expectedCredentialRevision: null,
      apiKey: ANTHROPIC_KEY
    });

    expect(requestJsonBody(fetcher, 0)).toMatchObject({ provider: "openai", apiKey: OPENAI_KEY });
    expect(requestJsonBody(fetcher, 1)).toMatchObject({
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY
    });
    expect(JSON.stringify(requestJsonBody(fetcher, 0))).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify(requestJsonBody(fetcher, 1))).not.toContain(OPENAI_KEY);
  });
});

describe("model selection settings", () => {
  it("updates provider and model together and verifies the echoed selection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        settings: {
          ...settings,
          settingsRevision: 4,
          byokProvider: "anthropic",
          modelSelection: "claude-opus-5",
          routingEffort: "thorough"
        },
        replayed: false
      })
    );
    const client = makeClient(fetcher);

    await expect(
      client.updateUserSettings({
        expectedSettingsRevision: 3,
        idempotencyKey: "settings-model-01",
        byokProvider: "anthropic",
        modelSelection: "claude-opus-5",
        routingEffort: "thorough"
      })
    ).resolves.toMatchObject({
      settings: { byokProvider: "anthropic", modelSelection: "claude-opus-5" }
    });
    expect(requestJsonBody(fetcher, 0)).toEqual({
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-model-01",
      byokProvider: "anthropic",
      modelSelection: "claude-opus-5",
      routingEffort: "thorough"
    });
  });

  it("rejects a cross-provider model before any request is sent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = makeClient(fetcher);

    await expect(
      client.updateUserSettings({
        expectedSettingsRevision: 3,
        idempotencyKey: "settings-model-cross",
        byokProvider: "openai",
        modelSelection: "claude-sonnet-5"
      })
    ).rejects.toThrow();
    await expect(
      client.updateUserSettings({
        expectedSettingsRevision: 3,
        idempotencyKey: "settings-model-app-default",
        providerMode: "app_default",
        byokProvider: null,
        modelSelection: "gpt-5.6-sol"
      })
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a response that substitutes a different model than requested", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        settings: { ...settings, settingsRevision: 4, modelSelection: "gpt-5.6-luna" },
        replayed: false
      })
    );
    const client = makeClient(fetcher);

    await expect(
      client.updateUserSettings({
        expectedSettingsRevision: 3,
        idempotencyKey: "settings-model-substituted",
        modelSelection: "gpt-5.6-sol"
      })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
  });

  it("requires modelSelection on settings reads", async () => {
    const { modelSelection: _omitted, ...legacy } = settings;
    void _omitted;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ settings: legacy }))
      .mockResolvedValueOnce(jsonResponse({ settings }));
    const client = makeClient(fetcher);

    await expect(client.getUserSettings()).rejects.toThrow();
    await expect(client.getUserSettings()).resolves.toEqual({ settings });
  });
});
