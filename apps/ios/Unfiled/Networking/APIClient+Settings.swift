import Foundation

extension APIClient {
    public func getUserSettings() async throws -> UserSettingsResponse {
        try await get("/me/settings")
    }

    public func updateUserSettings(
        _ request: UserSettingsUpdateRequest
    ) async throws -> UserSettingsUpdateResponse {
        try await patch(
            "/me/settings",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }

    public func getProviderKeyMetadata() async throws -> ProviderKeyResponse {
        try await get("/me/provider-key")
    }

    public func putProviderKey(
        _ request: ProviderKeyPutRequest
    ) async throws -> ProviderKeyPutResponse {
        try await put(
            "/me/provider-key",
            body: request,
            idempotencyKey: request.idempotencyKey,
            authenticated: true
        )
    }

    public func deleteProviderKey(
        _ request: ProviderKeyDeleteRequest
    ) async throws -> ProviderKeyDeleteResponse {
        try await delete(
            "/me/provider-key",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }
}
