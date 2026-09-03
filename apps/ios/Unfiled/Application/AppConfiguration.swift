import Foundation

enum AppConfigurationError: Error, Equatable {
    case missingBundleIdentifier
    case invalidAPIBaseURL
}

struct AppConfiguration: Sendable {
    /// Info.plist key populated from the `UNFILED_MANAGED_AI_FALLBACK_AVAILABLE` xcconfig value.
    static let managedAIFallbackInfoKey = "UnfiledManagedAIFallbackAvailable"

    let apiBaseURL: URL
    let bundleIdentifier: String
    /// Whether this deployment funds managed (app-default) AI. Unset, blank, or unexpanded values
    /// mean unavailable, which is the free private-beta default.
    let isManagedAIFallbackAvailable: Bool

    static func load(bundle: Bundle = .main) throws -> AppConfiguration {
        guard let bundleIdentifier = bundle.bundleIdentifier, !bundleIdentifier.isEmpty else {
            throw AppConfigurationError.missingBundleIdentifier
        }
        guard let rawURL = liveGateOverride() ?? bundle.object(forInfoDictionaryKey: "UnfiledAPIBaseURL") as? String else {
            throw AppConfigurationError.invalidAPIBaseURL
        }
        return try validated(
            apiBaseURLString: rawURL,
            bundleIdentifier: bundleIdentifier,
            isManagedAIFallbackAvailable: managedAIFallbackAvailability(
                from: bundle.object(forInfoDictionaryKey: managedAIFallbackInfoKey) as? String
            )
        )
    }

    static func validated(
        apiBaseURLString: String,
        bundleIdentifier: String,
        isManagedAIFallbackAvailable: Bool = false
    ) throws -> AppConfiguration {
        guard !bundleIdentifier.isEmpty else {
            throw AppConfigurationError.missingBundleIdentifier
        }
        guard let rawAPIBaseURL = URL(string: apiBaseURLString),
              let apiBaseURL = APIEndpointConfiguration.normalizedVersionedBaseURL(rawAPIBaseURL),
              let scheme = apiBaseURL.scheme?.lowercased(),
              let host = apiBaseURL.host,
              !host.isEmpty,
              scheme == "https" || (scheme == "http" && Self.isLoopback(host))
        else {
            throw AppConfigurationError.invalidAPIBaseURL
        }
        return AppConfiguration(
            apiBaseURL: apiBaseURL,
            bundleIdentifier: bundleIdentifier,
            isManagedAIFallbackAvailable: isManagedAIFallbackAvailable
        )
    }

    /// Accepts the xcconfig booleans `YES`/`NO` (plus `true`/`false` and `1`/`0`). Anything else,
    /// including a missing key or an unexpanded `$(…)` placeholder, fails closed to unavailable.
    static func managedAIFallbackAvailability(from rawValue: String?) -> Bool {
        guard let rawValue else { return false }
        switch rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "yes", "true", "1": return true
        default: return false
        }
    }

    private static func isLoopback(_ host: String) -> Bool {
        host == "127.0.0.1" || host == "localhost" || host == "::1"
    }
}

extension AppConfiguration {
    /// The live gate runs the app's own code against a deployed origin. The override is read only
    /// inside a test process of a debug build, so a shipped app never honors it.
    static func liveGateOverride() -> String? {
        #if DEBUG
        guard NSClassFromString("XCTestCase") != nil,
              let value = ProcessInfo.processInfo.environment["UNFILED_LIVE_GATE_API_BASE_URL"],
              !value.isEmpty else { return nil }
        return value
        #else
        return nil
        #endif
    }
}
