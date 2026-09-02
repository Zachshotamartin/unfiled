import Foundation

enum ProviderKeyAction: Equatable, Sendable {
    case save, delete
}

/// The provider-key request currently in flight. Each provider owns its own section, so the UI
/// needs to know which credential is being validated or deleted, not only that one is.
struct ProviderKeyMutation: Equatable, Sendable {
    let provider: AIProvider
    let action: ProviderKeyAction
}

/// Non-secret coordinates that let an ambiguous provider-key save be retried with the exact same
/// idempotency key and compare-and-set revision.
///
/// The submitted key is never stored here: the type has no field for it, so a retained value
/// cannot leak credential material. The user pastes the same key again and the retry binds to
/// the provider that started it.
struct ProviderKeyRetryCoordinates: Equatable, Sendable {
    let provider: AIProvider
    let expectedCredentialRevision: Int?
    let idempotencyKey: String

    /// Builds the exact request to replay. The key passes straight through to the request value
    /// and is not kept by the coordinates.
    func makeRequest(apiKey: String) throws -> ProviderKeyPutRequest {
        try ProviderKeyPutRequest(
            idempotencyKey: idempotencyKey,
            provider: provider,
            expectedCredentialRevision: expectedCredentialRevision,
            apiKey: apiKey
        )
    }
}

extension ProviderKeyRetryCoordinates: CustomStringConvertible, CustomDebugStringConvertible {
    var description: String {
        let revision = expectedCredentialRevision.map(String.init) ?? "nil"
        return "ProviderKeyRetryCoordinates(provider: \(provider.rawValue), expectedCredentialRevision: \(revision))"
    }

    var debugDescription: String { description }
}

enum ProviderKeyRetryContract {
    /// A pending retry locks key saves to the provider it belongs to. The other provider waits until
    /// the retry is resolved or discarded, so two credentials never share idempotency coordinates.
    static func permitsSave(pending: ProviderKeyRetryCoordinates?, provider: AIProvider) -> Bool {
        pending.map { $0.provider == provider } ?? true
    }

    /// Reuses the pending coordinates for the same provider, otherwise starts a fresh attempt
    /// against the currently known credential revision (`nil` creates a key).
    static func coordinates(
        resuming pending: ProviderKeyRetryCoordinates?,
        provider: AIProvider,
        currentCredentialRevision: Int?,
        freshIdempotencyKey: () -> String
    ) -> ProviderKeyRetryCoordinates {
        if let pending, pending.provider == provider {
            return pending
        }
        return ProviderKeyRetryCoordinates(
            provider: provider,
            expectedCredentialRevision: currentCredentialRevision,
            idempotencyKey: freshIdempotencyKey()
        )
    }
}
