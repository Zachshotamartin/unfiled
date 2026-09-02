import { describe, expect, it, vi } from "vitest";

import {
  MAX_AI_SETTINGS_RESPONSE_BYTES,
  MAX_PROVIDER_KEY_RESPONSE_BYTES
} from "@unfiled/contracts";

import { HttpError } from "@/server/api/errors";

import type { ProviderKeyValidator } from "./provider-key-validator";
import { createProductionAiSettingsRepository } from "./production-repository";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-09-01T18:30:00.000Z";
const environment = Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co/",
  NODE_ENV: "test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value-with-safe-length"
});
const context = Object.freeze({ accessToken: "owner-session-token", userId: USER_ID });

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("production AI settings repository", () => {
  it("validates a key before the exact owner RPC and returns metadata only", async () => {
    const validate = vi.fn<ProviderKeyValidator["validate"]>().mockResolvedValue(undefined);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: "not_found" }, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          providerKey: {
            provider: "openai",
            lastFour: "1234",
            status: "active",
            credentialRevision: 1,
            validatedAt: NOW,
            updatedAt: NOW
          },
          replayed: false
        })
      );
    const repository = createProductionAiSettingsRepository({
      environment,
      fetch: fetcher,
      providerKeyValidator: { validate }
    });
    const apiKey = "sk-example-not-a-real-key-1234";

    const output = await repository.putProviderKey(context, {
      idempotencyKey: "provider-put-01",
      provider: "openai",
      expectedCredentialRevision: null,
      apiKey
    });

    expect(validate).toHaveBeenCalledOnce();
    expect(validate.mock.calls[0]?.slice(0, 2)).toEqual(["openai", apiKey]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [replayUrl, replayInit] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl(replayUrl ?? "")).toBe(
      "https://project.supabase.co/rest/v1/rpc/put_user_provider_key"
    );
    const replayBody = replayInit?.body;
    if (typeof replayBody !== "string") throw new TypeError("Expected an RPC JSON body");
    expect(JSON.parse(replayBody)).toMatchObject({ p_replay_only: true, p_api_key: apiKey });
    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(requestUrl(url ?? "")).toBe(
      "https://project.supabase.co/rest/v1/rpc/put_user_provider_key"
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer service-role-test-value-with-safe-length"
    );
    expect(new Headers(init?.headers).get("authorization")).not.toContain("owner-session-token");
    const serializedBody = init?.body;
    if (typeof serializedBody !== "string") throw new TypeError("Expected an RPC JSON body");
    expect(JSON.parse(serializedBody)).toEqual({
      p_user_id: USER_ID,
      p_provider: "openai",
      p_api_key: apiKey,
      p_expected_credential_revision: null,
      p_idempotency_key: "provider-put-01",
      p_replay_only: false
    });
    expect(output).not.toHaveProperty("apiKey");
    expect(output.providerKey).not.toHaveProperty("apiKey");
  });

  it("stores nothing when provider validation fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: "not_found" }, { status: 404 }));
    const validate = vi
      .fn<ProviderKeyValidator["validate"]>()
      .mockRejectedValue(
        new HttpError(
          400,
          "provider_key_invalid",
          "OpenAI did not accept that key. Check it and try again."
        )
      );
    const repository = createProductionAiSettingsRepository({
      environment,
      fetch: fetcher,
      providerKeyValidator: { validate }
    });

    await expect(
      repository.putProviderKey(context, {
        idempotencyKey: "provider-invalid-01",
        provider: "openai",
        expectedCredentialRevision: null,
        apiKey: "sk-invalid-example-not-a-real-key"
      })
    ).rejects.toMatchObject({ code: "provider_key_invalid", status: 400 });
    expect(fetcher).toHaveBeenCalledOnce();
    const replayBody = fetcher.mock.calls[0]?.[1]?.body;
    if (typeof replayBody !== "string") throw new TypeError("Expected an RPC JSON body");
    expect(JSON.parse(replayBody)).toMatchObject({ p_replay_only: true });
  });

  it("recovers an exact committed PUT receipt without revalidating against OpenAI", async () => {
    const validate = vi.fn<ProviderKeyValidator["validate"]>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        providerKey: {
          provider: "openai",
          lastFour: "1234",
          status: "active",
          credentialRevision: 4,
          validatedAt: NOW,
          updatedAt: NOW
        },
        replayed: true
      })
    );
    const repository = createProductionAiSettingsRepository({
      environment,
      fetch: fetcher,
      providerKeyValidator: { validate }
    });

    await expect(
      repository.putProviderKey(context, {
        idempotencyKey: "provider-replay-01",
        provider: "openai",
        expectedCredentialRevision: 3,
        apiKey: "sk-example-not-a-real-key-1234"
      })
    ).resolves.toMatchObject({ replayed: true, providerKey: { credentialRevision: 4 } });
    expect(validate).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects malformed owner context before constructing a database capability", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const repository = createProductionAiSettingsRepository({ environment, fetch: fetcher });

    await expect(
      repository.getSettings({ accessToken: "owner-session-token", userId: "not-an-owner" })
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("applies the small owner-response ceiling to its service RPC capability", async () => {
    const cancelled = vi.fn();
    const repository = createProductionAiSettingsRepository({
      environment,
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: cancelled,
              start(controller) {
                controller.enqueue(new Uint8Array(MAX_AI_SETTINGS_RESPONSE_BYTES + 1));
              }
            })
          )
        )
      )
    });

    await expect(repository.getSettings(context)).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("applies the tighter response ceiling to provider-key RPCs", async () => {
    const cancelled = vi.fn();
    const repository = createProductionAiSettingsRepository({
      environment,
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: cancelled,
              start(controller) {
                controller.enqueue(new Uint8Array(MAX_PROVIDER_KEY_RESPONSE_BYTES + 1));
              }
            })
          )
        )
      )
    });

    await expect(repository.getProviderKey(context)).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
