import type {
  ProviderKeyDeleteRequest,
  ProviderKeyDeleteResponse,
  ProviderKeyPutRequest,
  ProviderKeyPutResponse,
  ProviderKeyResponse,
  UserSettingsResponse,
  UserSettingsUpdateRequest,
  UserSettingsUpdateResponse
} from "@unfiled/contracts";

export type AiSettingsRepositoryContext = Readonly<{
  accessToken: string;
  userId: string;
}>;

export interface AiSettingsRepository {
  getSettings(context: AiSettingsRepositoryContext): Promise<UserSettingsResponse>;
  updateSettings(
    context: AiSettingsRepositoryContext,
    request: UserSettingsUpdateRequest
  ): Promise<UserSettingsUpdateResponse>;
  getProviderKey(context: AiSettingsRepositoryContext): Promise<ProviderKeyResponse>;
  putProviderKey(
    context: AiSettingsRepositoryContext,
    request: ProviderKeyPutRequest
  ): Promise<ProviderKeyPutResponse>;
  deleteProviderKey(
    context: AiSettingsRepositoryContext,
    request: ProviderKeyDeleteRequest
  ): Promise<ProviderKeyDeleteResponse>;
}
