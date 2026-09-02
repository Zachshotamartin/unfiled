import {
  ProviderKeyDeleteResponseSchema,
  ProviderKeyPutResponseSchema,
  ProviderKeyResponseSchema,
  UserSettingsResponseSchema,
  UserSettingsUpdateResponseSchema,
  type ProviderKeyDeleteRequest,
  type ProviderKeyPutRequest,
  type UserSettingsUpdateRequest
} from "@unfiled/contracts";

import {
  ServiceRpcError,
  ServiceRpcErrorCode,
  type ServiceRpcClient
} from "@/server/encryption/service-rpc-client";

export const ownerAiSettingsRpcFunctions = Object.freeze([
  "get_owner_ai_settings",
  "update_owner_ai_settings",
  "get_user_provider_key_status",
  "put_user_provider_key",
  "delete_user_provider_key"
] as const);

type StrictSchema<T> = Readonly<{
  safeParse(
    value: unknown
  ): Readonly<{ data: T; success: true }> | Readonly<{ error: unknown; success: false }>;
}>;

function strictRpcResponse<T>(schema: StrictSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
  }
  return parsed.data;
}

function invalidRpcResponse(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function validateProviderKeyPutResponse(
  response: ReturnType<typeof ProviderKeyPutResponseSchema.parse>,
  request: ProviderKeyPutRequest
) {
  if (
    (request.expectedCredentialRevision !== null &&
      response.providerKey.credentialRevision !== request.expectedCredentialRevision + 1) ||
    response.providerKey.lastFour !== request.apiKey.slice(-4)
  ) {
    return invalidRpcResponse();
  }
  return response;
}

function settingsPatch(request: UserSettingsUpdateRequest): Readonly<Record<string, unknown>> {
  const {
    expectedSettingsRevision: _expectedSettingsRevision,
    idempotencyKey: _idempotencyKey,
    ...patch
  } = request;
  void _expectedSettingsRevision;
  void _idempotencyKey;
  return patch;
}

export function createOwnerAiSettingsRpcAdapter(client: ServiceRpcClient) {
  return Object.freeze({
    async getSettings(userId: string) {
      return strictRpcResponse(
        UserSettingsResponseSchema,
        await client.rpc("get_owner_ai_settings", { p_user_id: userId })
      );
    },

    async updateSettings(userId: string, request: UserSettingsUpdateRequest) {
      const response = strictRpcResponse(
        UserSettingsUpdateResponseSchema,
        await client.rpc("update_owner_ai_settings", {
          p_user_id: userId,
          p_expected_settings_revision: request.expectedSettingsRevision,
          p_idempotency_key: request.idempotencyKey,
          p_patch: settingsPatch(request)
        })
      );
      if (response.settings.settingsRevision !== request.expectedSettingsRevision + 1) {
        return invalidRpcResponse();
      }
      for (const field of [
        "organizationMode",
        "providerMode",
        "byokProvider",
        "byokFallbackToApp",
        "routingEffort",
        "expansionStyle",
        "timezone",
        "locale"
      ] as const) {
        if (request[field] !== undefined && response.settings[field] !== request[field]) {
          return invalidRpcResponse();
        }
      }
      return response;
    },

    async getProviderKey(userId: string) {
      return strictRpcResponse(
        ProviderKeyResponseSchema,
        await client.rpc("get_user_provider_key_status", {
          p_user_id: userId,
          p_provider: "openai"
        })
      );
    },

    async putProviderKey(userId: string, request: ProviderKeyPutRequest) {
      const response = strictRpcResponse(
        ProviderKeyPutResponseSchema,
        await client.rpc("put_user_provider_key", {
          p_user_id: userId,
          p_provider: request.provider,
          p_api_key: request.apiKey,
          p_expected_credential_revision: request.expectedCredentialRevision,
          p_idempotency_key: request.idempotencyKey,
          p_replay_only: false
        })
      );
      return validateProviderKeyPutResponse(response, request);
    },

    async replayProviderKeyPut(userId: string, request: ProviderKeyPutRequest) {
      try {
        const response = strictRpcResponse(
          ProviderKeyPutResponseSchema,
          await client.rpc("put_user_provider_key", {
            p_user_id: userId,
            p_provider: request.provider,
            p_api_key: request.apiKey,
            p_expected_credential_revision: request.expectedCredentialRevision,
            p_idempotency_key: request.idempotencyKey,
            p_replay_only: true
          })
        );
        if (!response.replayed) return invalidRpcResponse();
        return validateProviderKeyPutResponse(response, request);
      } catch (error: unknown) {
        if (error instanceof ServiceRpcError && error.code === ServiceRpcErrorCode.NOT_FOUND) {
          return null;
        }
        throw error;
      }
    },

    async deleteProviderKey(userId: string, request: ProviderKeyDeleteRequest) {
      const response = strictRpcResponse(
        ProviderKeyDeleteResponseSchema,
        await client.rpc("delete_user_provider_key", {
          p_user_id: userId,
          p_provider: request.provider,
          p_expected_credential_revision: request.expectedCredentialRevision,
          p_idempotency_key: request.idempotencyKey
        })
      );
      if (response.deletedCredentialRevision !== request.expectedCredentialRevision) {
        return invalidRpcResponse();
      }
      return response;
    }
  });
}
