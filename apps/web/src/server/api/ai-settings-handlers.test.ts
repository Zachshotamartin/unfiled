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

const settings = Object.freeze({
  settingsRevision: 3,
  organizationMode: "balanced" as const,
  providerMode: "app_default" as const,
  byokProvider: null,
  byokFallbackToApp: false,
  routingEffort: "standard" as const,
  expansionStyle: "brief" as const,
  timezone: "America/Los_Angeles",
  locale: "en-US",
  updatedAt: NOW
});

const providerKey = Object.freeze({
  provider: "openai" as const,
  lastFour: "1234",
  status: "active" as const,
  credentialRevision: 1,
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
      .mockResolvedValue({ providerKey, replayed: false }),
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

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

describe("owner AI settings handlers", () => {
  it("reads and updates settings only through the authenticated owner repository", async () => {
    const data = repository();
    const handlers = createAiSettingsHandlers({
      authenticate: authenticated,
      repository: data.value
    });
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

  it("keeps the pasted provider key out of responses and clears parsed request references", async () => {
    const data = repository();
    const handlers = createAiSettingsHandlers({
      authenticate: authenticated,
      repository: data.value
    });
    const apiKey = "sk-example-not-a-real-key-1234";
    const stored = await handlers.putProviderKey(
      request("/me/provider-key", "PUT", {
        idempotencyKey: "provider-put-01",
        provider: "openai",
        expectedCredentialRevision: null,
        apiKey
      })
    );

    expect(stored.status).toBe(200);
    expect(JSON.stringify(await stored.json())).not.toContain(apiKey);
    expect(data.spies.putProviderKey.mock.calls[0]?.[1].apiKey).toBe("");
    expectPrivate(stored);
  });

  it("enforces OpenAI-only input, CAS, exact idempotency, no query, and tight body limits", async () => {
    const data = repository();
    const handlers = createAiSettingsHandlers({
      authenticate: authenticated,
      repository: data.value
    });
    const hiddenProvider = await handlers.putProviderKey(
      request("/me/provider-key", "PUT", {
        idempotencyKey: "provider-hidden-01",
        provider: "anthropic",
        expectedCredentialRevision: null,
        apiKey: "sk-ant-example-not-a-real-key-1234"
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
    const query = await handlers.getProviderKey(
      new Request("https://unfiled.test/api/v1/me/provider-key?provider=openai")
    );
    const oversized = await handlers.putProviderKey(
      request(
        "/me/provider-key",
        "PUT",
        {
          idempotencyKey: "provider-oversized-01",
          provider: "openai",
          expectedCredentialRevision: null,
          apiKey: "sk-example-not-a-real-key-1234"
        },
        { "content-length": "4097" }
      )
    );

    expect(hiddenProvider.status).toBe(400);
    expect(noCas.status).toBe(400);
    expect(mismatch.status).toBe(409);
    expect(query.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(data.spies.putProviderKey).not.toHaveBeenCalled();
    expect(data.spies.deleteProviderKey).not.toHaveBeenCalled();
    for (const response of [hiddenProvider, noCas, mismatch, query, oversized]) {
      expectPrivate(response);
    }
  });

  it("rejects secret-bearing repository output and sanitizes auth failures", async () => {
    const data = repository();
    data.spies.getProviderKey.mockResolvedValueOnce({
      providerKey: { ...providerKey, apiKey: "response-secret-canary" }
    } as never);
    const handlers = createAiSettingsHandlers({
      authenticate: authenticated,
      repository: data.value
    });
    const malformed = await handlers.getProviderKey(request("/me/provider-key", "GET"));
    const unauthorizedHandlers = createAiSettingsHandlers({
      authenticate: () =>
        Promise.reject(new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.")),
      repository: data.value
    });
    const unauthorized = await unauthorizedHandlers.getSettings(request("/me/settings", "GET"));

    expect(malformed.status).toBe(503);
    expect(await malformed.text()).not.toContain("response-secret-canary");
    expect(unauthorized.status).toBe(401);
    expect(data.spies.getSettings).not.toHaveBeenCalled();
    expectPrivate(malformed);
    expectPrivate(unauthorized);
  });
});
