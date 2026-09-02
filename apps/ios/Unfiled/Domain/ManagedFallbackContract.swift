import Foundation

/// Managed (app-funded) AI is a deployment capability, not an API field. The build reports it
/// through `AppConfiguration.isManagedAIFallbackAvailable`; when unavailable, the client hides the
/// fallback toggle, stops offering managed mode as a new choice, and never asks the server to
/// enable fallback. Settings that were saved as managed stay visible so the user can leave them.
enum ManagedFallbackContract {
    static func offersManagedMode(isAvailable: Bool, savedMode: ProviderMode) -> Bool {
        isAvailable || savedMode == .appDefault
    }

    static func showsFallbackToggle(isAvailable: Bool) -> Bool {
        isAvailable
    }

    /// The only fallback value a request may carry: the user's choice where the deployment
    /// supports it, and `false` everywhere else.
    static func fallbackValue(requested: Bool, isAvailable: Bool) -> Bool {
        isAvailable && requested
    }
}
