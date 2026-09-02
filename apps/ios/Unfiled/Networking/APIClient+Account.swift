import Foundation

extension APIClient {
    public func streamAccountExport() async throws -> AsyncThrowingStream<Data, any Error> {
        try await authenticatedArchiveStream("/me/export")
    }

    public func deleteAccount(
        _ request: AccountDeleteRequest
    ) async throws -> AccountDeletionReceipt {
        try await deleteBodyOnly("/me", body: request, requirePrivateNoStore: true)
    }

    public func replayAccountDeletionReceipt(
        _ request: AccountDeletionReceiptReplayRequest
    ) async throws -> AccountDeletionReceipt {
        try await post(
            "/me/deletion-receipt",
            body: request,
            authenticated: false,
            requirePrivateNoStore: true
        )
    }
}
