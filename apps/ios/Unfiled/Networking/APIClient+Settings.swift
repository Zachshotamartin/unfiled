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

    public func getProviderKeyMetadata() async throws -> ProviderKeyResponse {
        try await get(
            "/me/provider-key",
            maximumResponseBytes: AISettingsLimits.providerKeyResponseBytes,
            requirePrivateNoStore: true
        )
    }

    public func putProviderKey(
        _ request: ProviderKeyPutRequest
    ) async throws -> ProviderKeyPutResponse {
        try await put(
            "/me/provider-key",
            body: request,
            idempotencyKey: request.idempotencyKey,
            authenticated: true,
            maximumRequestBytes: AISettingsLimits.providerKeyRequestBytes,
            maximumResponseBytes: AISettingsLimits.providerKeyResponseBytes,
            requirePrivateNoStore: true
        )
    }

    public func deleteProviderKey(
        _ request: ProviderKeyDeleteRequest
    ) async throws -> ProviderKeyDeleteResponse {
        try await delete(
            "/me/provider-key",
            body: request,
            idempotencyKey: request.idempotencyKey,
            maximumRequestBytes: AISettingsLimits.providerKeyRequestBytes,
            maximumResponseBytes: AISettingsLimits.providerKeyResponseBytes,
            requirePrivateNoStore: true
        )
    }
}
