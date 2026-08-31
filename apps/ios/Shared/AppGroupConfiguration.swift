import Foundation

enum AppGroupConfiguration {
    static let pendingCaptureCountKey = "pendingCaptureCount"
    static let quickCaptureIntentKey = "quickCaptureIntentNonce"
    static let schemaVersion = 1
    static let schemaVersionKey = "widgetSnapshotSchemaVersion"

    static var appGroupIdentifier: String? {
        configuredString(named: "UnfiledAppGroupIdentifier")
    }

    static var urlScheme: String? {
        configuredString(named: "UnfiledURLScheme")
    }

    static var captureURL: URL? {
        guard let urlScheme else { return nil }
        var components = URLComponents()
        components.scheme = urlScheme
        components.host = "capture"
        components.queryItems = [URLQueryItem(name: "source", value: "ios_lock_screen_widget")]
        return components.url
    }

    static var sharedDefaults: UserDefaults? {
        guard let appGroupIdentifier else { return nil }
        return UserDefaults(suiteName: appGroupIdentifier)
    }

    static func signalQuickCapture() {
        guard let defaults = sharedDefaults else { return }
        signalQuickCapture(in: defaults)
    }

    static func signalQuickCapture(in defaults: UserDefaults) {
        defaults.set(UUID().uuidString, forKey: quickCaptureIntentKey)
    }

    static func consumeQuickCaptureSignal() -> Bool {
        guard let defaults = sharedDefaults else { return false }
        return consumeQuickCaptureSignal(in: defaults)
    }

    static func consumeQuickCaptureSignal(in defaults: UserDefaults) -> Bool {
        guard defaults.string(forKey: quickCaptureIntentKey) != nil else { return false }
        defaults.removeObject(forKey: quickCaptureIntentKey)
        return true
    }

    static func isValidQuickCaptureURL(_ url: URL, expectedScheme: String) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == expectedScheme.lowercased(),
              components.host?.lowercased() == "capture",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.path.isEmpty,
              components.fragment == nil,
              components.queryItems == [
                URLQueryItem(name: "source", value: "ios_lock_screen_widget")
              ] else {
            return false
        }
        return true
    }

    private static func configuredString(named key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { return nil }
        return trimmed
    }
}
