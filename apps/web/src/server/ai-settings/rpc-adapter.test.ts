import { describe, expect, it, vi } from "vitest";

import {
  ServiceRpcError,
  ServiceRpcErrorCode,
  type ServiceRpcClient
} from "@/server/encryption/service-rpc-client";

import { createOwnerAiSettingsRpcAdapter, ownerAiSettingsRpcFunctions } from "./rpc-adapter";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-09-01T18:30:00.000Z";

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

describe("owner AI settings RPC adapter", () => {
  it("uses only the five frozen owner functions and exact parameter names", async () => {
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({ settings })
      .mockResolvedValueOnce({
        settings: { ...settings, settingsRevision: 4, routingEffort: "thorough" },
        replayed: false
      })
      .mockResolvedValueOnce({ providerKey: null })
      .mockResolvedValueOnce({
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
      .mockResolvedValueOnce({
        provider: "openai",
        deleted: true,
        deletedCredentialRevision: 1,
        replayed: false
      });
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });

    await adapter.getSettings(USER_ID);
    await adapter.updateSettings(USER_ID, {
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-update-01",
      routingEffort: "thorough"
    });
    await adapter.getProviderKey(USER_ID, "anthropic");
    await adapter.putProviderKey(USER_ID, {
      idempotencyKey: "provider-put-01",
      provider: "openai",
      expectedCredentialRevision: null,
      apiKey: "sk-example-not-a-real-key-1234"
    });
    await adapter.deleteProviderKey(USER_ID, {
      idempotencyKey: "provider-delete-01",
      provider: "openai",
      expectedCredentialRevision: 1
    });

    expect(ownerAiSettingsRpcFunctions).toEqual([
      "get_owner_ai_settings",
      "update_owner_ai_settings",
      "get_user_provider_key_status",
      "put_user_provider_key",
      "delete_user_provider_key"
    ]);
    expect(rpc.mock.calls).toEqual([
      ["get_owner_ai_settings", { p_user_id: USER_ID }],
      [
        "update_owner_ai_settings",
        {
          p_user_id: USER_ID,
          p_expected_settings_revision: 3,
          p_idempotency_key: "settings-update-01",
          p_patch: { routingEffort: "thorough" }
        }
      ],
      ["get_user_provider_key_status", { p_user_id: USER_ID, p_provider: "anthropic" }],
      [
        "put_user_provider_key",
        {
          p_user_id: USER_ID,
          p_provider: "openai",
          p_api_key: "sk-example-not-a-real-key-1234",
          p_expected_credential_revision: null,
          p_idempotency_key: "provider-put-01",
          p_replay_only: false
        }
      ],
      [
        "delete_user_provider_key",
        {
          p_user_id: USER_ID,
          p_provider: "openai",
          p_expected_credential_revision: 1,
          p_idempotency_key: "provider-delete-01"
        }
      ]
    ]);
  });

  it("fails closed when an RPC response adds secret or Vault fields", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      providerKey: {
        provider: "openai",
        lastFour: "1234",
        status: "active",
        credentialRevision: 1,
        validatedAt: NOW,
        updatedAt: NOW,
        vaultSecretId: "must-not-cross"
      }
    });
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });

    await expect(adapter.getProviderKey(USER_ID, "openai")).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
  });

  it("fails closed when a mutation response substitutes CAS coordinates", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      settings: { ...settings, settingsRevision: 9, routingEffort: "thorough" },
      replayed: false
    });
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });

    await expect(
      adapter.updateSettings(USER_ID, {
        expectedSettingsRevision: 3,
        idempotencyKey: "settings-substitution-01",
        routingEffort: "thorough"
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("binds provider-key mutation responses to the submitted secret and CAS revision", async () => {
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({
        providerKey: {
          provider: "openai",
          lastFour: "9999",
          status: "active",
          credentialRevision: 1,
          validatedAt: NOW,
          updatedAt: NOW
        },
        replayed: true
      })
      .mockResolvedValueOnce({
        providerKey: {
          provider: "openai",
          lastFour: "1234",
          status: "active",
          credentialRevision: 3,
          validatedAt: NOW,
          updatedAt: NOW
        },
        replayed: false
      });
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });

    await expect(
      adapter.putProviderKey(USER_ID, {
        idempotencyKey: "provider-secret-substitution-01",
        provider: "openai",
        expectedCredentialRevision: null,
        apiKey: "sk-example-not-a-real-key-1234"
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    await expect(
      adapter.putProviderKey(USER_ID, {
        idempotencyKey: "provider-revision-substitution-01",
        provider: "openai",
        expectedCredentialRevision: 1,
        apiKey: "sk-example-not-a-real-key-1234"
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("accepts a positive non-ABA revision when a deleted key is recreated", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      providerKey: {
        provider: "openai",
        lastFour: "1234",
        status: "active",
        credentialRevision: 7,
        validatedAt: NOW,
        updatedAt: NOW
      },
      replayed: false
    });
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });

    await expect(
      adapter.putProviderKey(USER_ID, {
        idempotencyKey: "provider-recreate-01",
        provider: "openai",
        expectedCredentialRevision: null,
        apiKey: "sk-example-not-a-real-key-1234"
      })
    ).resolves.toMatchObject({ providerKey: { credentialRevision: 7 } });
  });

  it("distinguishes an exact durable replay from a replay miss", async () => {
    const response = {
      providerKey: {
        provider: "openai" as const,
        lastFour: "1234",
        status: "active" as const,
        credentialRevision: 4,
        validatedAt: NOW,
        updatedAt: NOW
      },
      replayed: true
    };
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockRejectedValueOnce(new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND))
      .mockResolvedValueOnce(response);
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });
    const request = {
      idempotencyKey: "provider-replay-01",
      provider: "openai" as const,
      expectedCredentialRevision: 3,
      apiKey: "sk-example-not-a-real-key-1234"
    };

    await expect(adapter.replayProviderKeyPut(USER_ID, request)).resolves.toBeNull();
    await expect(adapter.replayProviderKeyPut(USER_ID, request)).resolves.toEqual(response);
    expect(rpc).toHaveBeenNthCalledWith(1, "put_user_provider_key", {
      p_user_id: USER_ID,
      p_provider: "openai",
      p_api_key: request.apiKey,
      p_expected_credential_revision: 3,
      p_idempotency_key: request.idempotencyKey,
      p_replay_only: true
    });
  });

  it("addresses each provider independently with the exact RPC parameter shapes", async () => {
    const anthropicKey = {
      provider: "anthropic" as const,
      lastFour: "wxyz",
      status: "active" as const,
      credentialRevision: 2,
      validatedAt: NOW,
      updatedAt: NOW
    };
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({ providerKey: anthropicKey })
      .mockResolvedValueOnce({
        providerKey: { ...anthropicKey, credentialRevision: 3 },
        replayed: false
      })
      .mockResolvedValueOnce({
        provider: "anthropic",
        deleted: true,
        deletedCredentialRevision: 3,
        replayed: false
      })
      .mockResolvedValueOnce({
        settings: {
          ...settings,
          settingsRevision: 4,
          providerMode: "byok",
          byokProvider: "anthropic",
          modelSelection: "claude-opus-5"
        },
        replayed: false
      });
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });
    const apiKey = "sk-ant-test-example-not-a-real-key-wxyz";

    await expect(adapter.getProviderKey(USER_ID, "anthropic")).resolves.toEqual({
      providerKey: anthropicKey
    });
    await expect(
      adapter.putProviderKey(USER_ID, {
        idempotencyKey: "provider-put-anthropic-01",
        provider: "anthropic",
        expectedCredentialRevision: 2,
        apiKey
      })
    ).resolves.toMatchObject({ providerKey: { provider: "anthropic", credentialRevision: 3 } });
    await expect(
      adapter.deleteProviderKey(USER_ID, {
        idempotencyKey: "provider-delete-anthropic-01",
        provider: "anthropic",
        expectedCredentialRevision: 3
      })
    ).resolves.toMatchObject({ provider: "anthropic", deletedCredentialRevision: 3 });
    await expect(
      adapter.updateSettings(USER_ID, {
        expectedSettingsRevision: 3,
        idempotencyKey: "settings-model-01",
        providerMode: "byok",
        byokProvider: "anthropic",
        modelSelection: "claude-opus-5"
      })
    ).resolves.toMatchObject({ settings: { modelSelection: "claude-opus-5" } });

    expect(rpc.mock.calls).toEqual([
      ["get_user_provider_key_status", { p_user_id: USER_ID, p_provider: "anthropic" }],
      [
        "put_user_provider_key",
        {
          p_user_id: USER_ID,
          p_provider: "anthropic",
          p_api_key: apiKey,
          p_expected_credential_revision: 2,
          p_idempotency_key: "provider-put-anthropic-01",
          p_replay_only: false
        }
      ],
      [
        "delete_user_provider_key",
        {
          p_user_id: USER_ID,
          p_provider: "anthropic",
          p_expected_credential_revision: 3,
          p_idempotency_key: "provider-delete-anthropic-01"
        }
      ],
      [
        "update_owner_ai_settings",
        {
          p_user_id: USER_ID,
          p_expected_settings_revision: 3,
          p_idempotency_key: "settings-model-01",
          p_patch: {
            providerMode: "byok",
            byokProvider: "anthropic",
            modelSelection: "claude-opus-5"
          }
        }
      ]
    ]);
  });

  it("fails closed when a provider-key response names a different provider", async () => {
    const openAiKey = {
      provider: "openai" as const,
      lastFour: "wxyz",
      status: "active" as const,
      credentialRevision: 3,
      validatedAt: NOW,
      updatedAt: NOW
    };
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({ providerKey: openAiKey })
      .mockResolvedValueOnce({ providerKey: openAiKey, replayed: false })
      .mockResolvedValueOnce({
        provider: "openai",
        deleted: true,
        deletedCredentialRevision: 3,
        replayed: false
      })
      .mockResolvedValueOnce({ providerKey: null });
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });

    await expect(adapter.getProviderKey(USER_ID, "anthropic")).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    await expect(
      adapter.putProviderKey(USER_ID, {
        idempotencyKey: "provider-put-anthropic-swap",
        provider: "anthropic",
        expectedCredentialRevision: 2,
        apiKey: "sk-ant-test-example-not-a-real-key-wxyz"
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    await expect(
      adapter.deleteProviderKey(USER_ID, {
        idempotencyKey: "provider-delete-anthropic-swap",
        provider: "anthropic",
        expectedCredentialRevision: 3
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    await expect(adapter.getProviderKey(USER_ID, "anthropic")).resolves.toEqual({
      providerKey: null
    });
  });

  it("fails closed when the settings response drops or substitutes the model selection", async () => {
    const { modelSelection: _omitted, ...legacy } = settings;
    void _omitted;
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({ settings: legacy })
      .mockResolvedValueOnce({
        settings: { ...settings, settingsRevision: 4, modelSelection: "gpt-5.6-luna" },
        replayed: false
      });
    const adapter = createOwnerAiSettingsRpcAdapter({ rpc });

    await expect(adapter.getSettings(USER_ID)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    await expect(
      adapter.updateSettings(USER_ID, {
        expectedSettingsRevision: 3,
        idempotencyKey: "settings-model-substituted",
        byokProvider: "openai",
        modelSelection: "gpt-5.6-sol"
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });
});
