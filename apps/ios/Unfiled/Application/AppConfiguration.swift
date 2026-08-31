import Foundation

enum AppConfigurationError: Error, Equatable {
    case missingBundleIdentifier
    case invalidAPIBaseURL
}

struct AppConfiguration: Sendable {
    let apiBaseURL: URL
    let bundleIdentifier: String

    static func load(bundle: Bundle = .main) throws -> AppConfiguration {
        guard let bundleIdentifier = bundle.bundleIdentifier, !bundleIdentifier.isEmpty else {
            throw AppConfigurationError.missingBundleIdentifier
        }
        guard let rawURL = bundle.object(forInfoDictionaryKey: "UnfiledAPIBaseURL") as? String else {
            throw AppConfigurationError.invalidAPIBaseURL
        }
        return try validated(apiBaseURLString: rawURL, bundleIdentifier: bundleIdentifier)
    }

    static func validated(
        apiBaseURLString: String,
        bundleIdentifier: String
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
            bundleIdentifier: bundleIdentifier
        )
    }

    private static func isLoopback(_ host: String) -> Bool {
        host == "127.0.0.1" || host == "localhost" || host == "::1"
    }
}
