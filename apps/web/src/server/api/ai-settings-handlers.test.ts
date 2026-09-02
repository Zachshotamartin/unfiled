import { ApiErrorCode } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  AiSettingsRepository,
  AiSettingsRepositoryContext
} from "@/server/ai-settings/repository";
import type { AuthenticatedRequest } from "@/server/auth/session";

import { createAiSettingsHandlers } from "./ai-settings-handlers";
import { HttpError } from "./errors";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-09-01T18:30:00.000Z";
const OPENAI_KEY = "sk-test-example-not-a-real-key-1234";
const ANTHROPIC_KEY = "sk-ant-test-example-not-a-real-key-wxyz";

const settings = Object.freeze({
  settingsRevision: 3,
  organizationMode: "balanced" as const,
  providerMode: "app_default" as const,
  byokProvider: null,
  modelSelection: "auto" as const,
  byokFallbackToApp: false,
  routingEffort: "standard" as const,
  expansionStyle: "brief" as const,
  timezone: "America/Los_Angeles",
  locale: "en-US",
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

const anthropicKey = Object.freeze({
  provider: "anthropic" as const,
  lastFour: "wxyz",
  status: "active" as const,
  credentialRevision: 2,
  validatedAt: NOW,
  updatedAt: NOW
});

function authenticated(): Promise<AuthenticatedRequest> {
  return Promise.resolve({
    accessToken: "test-access-token",
    cookies: ["refreshed=true; HttpOnly"],
    user: { id: USER_ID, email: "person@example.com" }
  });
}

function repository() {
  const spies = {
    getSettings: vi.fn<AiSettingsRepository["getSettings"]>().mockResolvedValue({ settings }),
    updateSettings: vi.fn<AiSettingsRepository["updateSettings"]>().mockResolvedValue({
      settings: { ...settings, settingsRevision: 4, routingEffort: "thorough" as const },
      replayed: false
    }),
    getProviderKey: vi
      .fn<AiSettingsRepository["getProviderKey"]>()
      .mockResolvedValue({ providerKey: null }),
    putProviderKey: vi
      .fn<AiSettingsRepository["putProviderKey"]>()
      .mockResolvedValue({ providerKey: openAiKey, replayed: false }),
    deleteProviderKey: vi.fn<AiSettingsRepository["deleteProviderKey"]>().mockResolvedValue({
      provider: "openai" as const,
      deleted: true as const,
      deletedCredentialRevision: 1,
      replayed: false
    })
  };
  return Object.freeze({
    value: spies satisfies AiSettingsRepository,
    spies
  });
}

function handlersFor(data: ReturnType<typeof repository>) {
  return createAiSettingsHandlers({ authenticate: authenticated, repository: data.value });
}

function request(
  path: "/me/provider-key" | "/me/settings",
  method: string,
  body?: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {}
): Request {
  return new Request(`https://unfiled.test/api/v1${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(typeof body?.idempotencyKey === "string"
        ? { "idempotency-key": body.idempotencyKey }
        : {})
    }
  });
}

function providerKeyGet(search: string): Request {
  return new Request(`https://unfiled.test/api/v1/me/provider-key${search}`);
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

describe("owner AI settings handlers", () => {
  it("reads and updates settings only through the authenticated owner repository", async () => {
    const data = repository();
    const handlers = handlersFor(data);
    const read = await handlers.getSettings(request("/me/settings", "GET"));
    const updateInput = {
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-update-01",
      routingEffort: "thorough"
    } as const;
    const updated = await handlers.updateSettings(request("/me/settings", "PATCH", updateInput));

    expect(read.status).toBe(200);
    expect(updated.status).toBe(200);
    expect(await read.json()).toEqual({ settings });
    expect(data.spies.getSettings).toHaveBeenCalledWith({
      accessToken: "test-access-token",
      userId: USER_ID
    } satisfies AiSettingsRepositoryContext);
    expect(data.spies.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      updateInput
    );
    expect(updated.headers.get("set-cookie")).toContain("refreshed=true");
    expectPrivate(read);
    expectPrivate(updated);
  });

  it("passes provider and model selection through settings updates", async () => {
    const data = repository();
    data.spies.updateSettings.mockResolvedValueOnce({
      settings: {
        ...settings,
        settingsRevision: 4,
        providerMode: "byok",
        byokProvider: "anthropic",
        modelSelection: "claude-opus-5"
      },
      replayed: false
    });
    const handlers = handlersFor(data);
    const input = {
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-model-01",
      providerMode: "byok",
      byokProvider: "anthropic",
      modelSelection: "claude-opus-5"
    } as const;

    const updated = await handlers.updateSettings(request("/me/settings", "PATCH", input));

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      settings: { byokProvider: "anthropic", modelSelection: "claude-opus-5" }
    });
    expect(data.spies.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      input
    );
  });

  it("rejects cross-provider, unknown, and app-default exact model selections", async () => {
    const data = repository();
    const handlers = handlersFor(data);
    const responses = await Promise.all([
      handlers.updateSettings(
        request("/me/settings", "PATCH", {
          expectedSettingsRevision: 3,
          idempotencyKey: "settings-cross-provider",
          byokProvider: "openai",
          modelSelection: "claude-sonnet-5"
        })
      ),
      handlers.updateSettings(
        request("/me/settings", "PATCH", {
          expectedSettingsRevision: 3,
          idempotencyKey: "settings-unknown-model",
          modelSelection: "gpt-5.5-retired-example"
        })
      ),
      handlers.updateSettings(
        request("/me/settings", "PATCH", {
          expectedSettingsRevision: 3,
          idempotencyKey: "settings-app-default-model",
          providerMode: "app_default",
          byokProvider: null,
          modelSelection: "gpt-5.6-sol"
        })
      )
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: ApiErrorCode.VALIDATION_FAILED });
      expectPrivate(response);
    }
    expect(data.spies.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects settings output that omits the model selection", async () => {
    const data = repository();
    const { modelSelection: _omitted, ...legacy } = settings;
    void _omitted;
    data.spies.getSettings.mockResolvedValueOnce({ settings: legacy } as never);
    const handlers = handlersFor(data);

    const read = await handlers.getSettings(request("/me/settings", "GET"));

    expect(read.status).toBe(503);
    expect(await read.json()).toMatchObject({ code: ApiErrorCode.PROVIDER_UNAVAILABLE });
    expectPrivate(read);
  });

  it("keeps the pasted provider key out of responses and clears parsed request references", async () => {
    const data = repository();
    const handlers = handlersFor(data);
    const stored = await handlers.putProviderKey(
      request("/me/provider-key", "PUT", {
        idempotencyKey: "provider-put-01",
        provider: "openai",
        expectedCredentialRevision: null,
        apiKey: OPENAI_KEY
      })
    );

    expect(stored.status).toBe(200);
    expect(JSON.stringify(await stored.json())).not.toContain(OPENAI_KEY);
    expect(data.spies.putProviderKey.mock.calls[0]?.[1].apiKey).toBe("");
    expectPrivate(stored);
  });

  it("stores and deletes an Anthropic key through the same provider-addressed repository", async () => {
    const data = repository();
    data.spies.putProviderKey.mockResolvedValueOnce({ providerKey: anthropicKey, replayed: false });
    data.spies.deleteProviderKey.mockResolvedValueOnce({
      provider: "anthropic",
      deleted: true,
      deletedCredentialRevision: 2,
      replayed: false
    });
    const handlers = handlersFor(data);

    const stored = await handlers.putProviderKey(
      request("/me/provider-key", "PUT", {
        idempotencyKey: "provider-put-anthropic-01",
        provider: "anthropic",
        expectedCredentialRevision: 1,
        apiKey: ANTHROPIC_KEY
      })
    );
    const deleted = await handlers.deleteProviderKey(
      request("/me/provider-key", "DELETE", {
        idempotencyKey: "provider-delete-anthropic-01",
        provider: "anthropic",
        expectedCredentialRevision: 2
      })
    );

    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ providerKey: anthropicKey, replayed: false });
    expect(data.spies.putProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      expect.objectContaining({ provider: "anthropic", expectedCredentialRevision: 1 })
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ provider: "anthropic", deleted: true });
    expect(data.spies.deleteProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      {
        idempotencyKey: "provider-delete-anthropic-01",
        provider: "anthropic",
        expectedCredentialRevision: 2
      }
    );
    expectPrivate(stored);
    expectPrivate(deleted);
  });

  it("reads provider-key metadata for exactly one supported provider", async () => {
    const data = repository();
    data.spies.getProviderKey
      .mockResolvedValueOnce({ providerKey: openAiKey })
      .mockResolvedValueOnce({ providerKey: anthropicKey })
      .mockResolvedValueOnce({ providerKey: null });
    const handlers = handlersFor(data);

    const openai = await handlers.getProviderKey(providerKeyGet("?provider=openai"));
    const anthropic = await handlers.getProviderKey(providerKeyGet("?provider=anthropic"));
    const missing = await handlers.getProviderKey(providerKeyGet("?provider=anthropic"));

    expect(openai.status).toBe(200);
    expect(await openai.json()).toEqual({ providerKey: openAiKey });
    expect(anthropic.status).toBe(200);
    expect(await anthropic.json()).toEqual({ providerKey: anthropicKey });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ providerKey: null });
    expect(data.spies.getProviderKey.mock.calls.map(([, provider]) => provider)).toEqual([
      "openai",
      "anthropic",
      "anthropic"
    ]);
    for (const response of [openai, anthropic, missing]) expectPrivate(response);
  });

  it.each([
    ["no provider", ""],
    ["an empty provider", "?provider="],
    ["an unsupported provider", "?provider=google"],
    ["a mixed-case provider", "?provider=OpenAI"],
    ["two providers", "?provider=openai&provider=anthropic"],
    ["a repeated provider", "?provider=openai&provider=openai"],
    ["an extra parameter", "?provider=openai&status=active"],
    ["an unknown parameter only", "?status=active"]
  ])("rejects a provider-key read with %s", async (_label, search) => {
    const data = repository();
    const handlers = handlersFor(data);

    const response = await handlers.getProviderKey(providerKeyGet(search));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: ApiErrorCode.VALIDATION_FAILED });
    expect(data.spies.getProviderKey).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it("fails closed when the repository returns metadata for a different provider", async () => {
    const data = repository();
    data.spies.getProviderKey
      .mockResolvedValueOnce({ providerKey: anthropicKey })
      .mockResolvedValueOnce({ providerKey: openAiKey });
    const handlers = handlersFor(data);

    const swappedForOpenAi = await handlers.getProviderKey(providerKeyGet("?provider=openai"));
    const swappedForAnthropic = await handlers.getProviderKey(
      providerKeyGet("?provider=anthropic")
    );

    for (const response of [swappedForOpenAi, swappedForAnthropic]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: ApiErrorCode.PROVIDER_UNAVAILABLE });
      expectPrivate(response);
    }
  });

  it("enforces supported providers, CAS, exact idempotency, no query, and tight body limits", async () => {
    const data = repository();
    const handlers = handlersFor(data);
    const hiddenProvider = await handlers.putProviderKey(
      request("/me/provider-key", "PUT", {
        idempotencyKey: "provider-hidden-01",
        provider: "google",
        expectedCredentialRevision: null,
        apiKey: "sk-test-example-not-a-real-key-9999"
      })
    );
    const missingProvider = await handlers.putProviderKey(
      request("/me/provider-key", "PUT", {
        idempotencyKey: "provider-missing-01",
        expectedCredentialRevision: null,
        apiKey: OPENAI_KEY
      })
    );
    const noCas = await handlers.deleteProviderKey(
      request("/me/provider-key", "DELETE", {
        idempotencyKey: "provider-delete-no-cas",
        provider: "openai"
      })
    );
    const mismatch = await handlers.updateSettings(
      new Request("https://unfiled.test/api/v1/me/settings", {
        method: "PATCH",
        body: JSON.stringify({
          expectedSettingsRevision: 3,
          idempotencyKey: "body-key",
          routingEffort: "economical"
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "different-key"
        }
      })
    );
    const queriedWrite = await handlers.putProviderKey(
      new Request("https://unfiled.test/api/v1/me/provider-key?provider=openai", {
        method: "PUT",
        body: JSON.stringify({
          idempotencyKey: "provider-put-query",
          provider: "openai",
          expectedCredentialRevision: null,
          apiKey: OPENAI_KEY
        }),
        headers: { "content-type": "application/json", "idempotency-key": "provider-put-query" }
      })
    );
    const queriedSettings = await handlers.getSettings(
      new Request("https://unfiled.test/api/v1/me/settings?provider=openai")
    );
    const oversized = await handlers.putProviderKey(
      request(
        "/me/provider-key",
        "PUT",
        {
          idempotencyKey: "provider-oversized-01",
          provider: "openai",
          expectedCredentialRevision: null,
          apiKey: OPENAI_KEY
        },
        { "content-length": "4097" }
      )
    );

    expect(hiddenProvider.status).toBe(400);
    expect(missingProvider.status).toBe(400);
    expect(noCas.status).toBe(400);
    expect(mismatch.status).toBe(409);
    expect(queriedWrite.status).toBe(400);
    expect(queriedSettings.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(data.spies.putProviderKey).not.toHaveBeenCalled();
    expect(data.spies.deleteProviderKey).not.toHaveBeenCalled();
    expect(data.spies.getSettings).not.toHaveBeenCalled();
    for (const response of [
      hiddenProvider,
      missingProvider,
      noCas,
      mismatch,
      queriedWrite,
      queriedSettings,
      oversized
    ]) {
      expectPrivate(response);
    }
  });

  it("rejects secret-bearing repository output and sanitizes auth failures", async () => {
    const data = repository();
    data.spies.getProviderKey.mockResolvedValueOnce({
      providerKey: { ...openAiKey, apiKey: "response-secret-canary" }
    } as never);
    const handlers = handlersFor(data);
    const malformed = await handlers.getProviderKey(providerKeyGet("?provider=openai"));
    const unauthorizedHandlers = createAiSettingsHandlers({
      authenticate: () =>
        Promise.reject(new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.")),
      repository: data.value
    });
    const unauthorized = await unauthorizedHandlers.getSettings(request("/me/settings", "GET"));
    const unauthorizedKey = await unauthorizedHandlers.getProviderKey(
      providerKeyGet("?provider=anthropic")
    );

    expect(malformed.status).toBe(503);
    expect(await malformed.text()).not.toContain("response-secret-canary");
    expect(unauthorized.status).toBe(401);
    expect(unauthorizedKey.status).toBe(401);
    expect(data.spies.getSettings).not.toHaveBeenCalled();
    expect(data.spies.getProviderKey).toHaveBeenCalledTimes(1);
    expectPrivate(malformed);
    expectPrivate(unauthorized);
    expectPrivate(unauthorizedKey);
  });
});
