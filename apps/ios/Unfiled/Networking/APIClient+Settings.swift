import Foundation

extension APIClient {
    private enum AISettingsLimits {
        static let settingsRequestBytes = 4 * 1_024
        static let settingsResponseBytes = 32 * 1_024
        static let providerKeyRequestBytes = 4 * 1_024
        static let providerKeyResponseBytes = 16 * 1_024
    }

    public func getUserSettings() async throws -> UserSettingsResponse {
        try await get(
            "/me/settings",
            maximumResponseBytes: AISettingsLimits.settingsResponseBytes,
            requirePrivateNoStore: true
        )
    }

    public func updateUserSettings(
        _ request: UserSettingsUpdateRequest
    ) async throws -> UserSettingsUpdateResponse {
        try await patch(
            "/me/settings",
            body: request,
            idempotencyKey: request.idempotencyKey,
            maximumRequestBytes: AISettingsLimits.settingsRequestBytes,
            maximumResponseBytes: AISettingsLimits.settingsResponseBytes,
            requirePrivateNoStore: true
        )
    }

    public func getProviderKeyMetadata(
        provider: AIProvider
    ) async throws -> ProviderKeyResponse {
        let response: ProviderKeyResponse = try await get(
            "/me/provider-key",
            query: [URLQueryItem(name: "provider", value: provider.rawValue)],
            maximumResponseBytes: AISettingsLimits.providerKeyResponseBytes,
            requirePrivateNoStore: true
        )
        guard response.providerKey?.provider == provider || response.providerKey == nil else {
            throw APIClientError.malformedResponse(status: 200)
        }
        return response
    }

    public func putProviderKey(
        _ request: ProviderKeyPutRequest
    ) async throws -> ProviderKeyPutResponse {
        let response: ProviderKeyPutResponse = try await put(
            "/me/provider-key",
            body: request,
            idempotencyKey: request.idempotencyKey,
            authenticated: true,
            maximumRequestBytes: AISettingsLimits.providerKeyRequestBytes,
            maximumResponseBytes: AISettingsLimits.providerKeyResponseBytes,
            requirePrivateNoStore: true
        )
        guard response.providerKey.provider == request.provider else {
            throw APIClientError.malformedResponse(status: 200)
        }
        return response
    }

    public func deleteProviderKey(
        _ request: ProviderKeyDeleteRequest
    ) async throws -> ProviderKeyDeleteResponse {
        let response: ProviderKeyDeleteResponse = try await delete(
            "/me/provider-key",
            body: request,
            idempotencyKey: request.idempotencyKey,
            maximumRequestBytes: AISettingsLimits.providerKeyRequestBytes,
            maximumResponseBytes: AISettingsLimits.providerKeyResponseBytes,
            requirePrivateNoStore: true
        )
        guard response.provider == request.provider else {
            throw APIClientError.malformedResponse(status: 200)
        }
        return response
    }
}
