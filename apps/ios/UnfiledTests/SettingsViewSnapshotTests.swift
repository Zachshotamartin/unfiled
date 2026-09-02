import SwiftUI
import UIKit
import XCTest
@testable import Unfiled

/// Renders content-free settings states to PNG files for human visual review.
///
/// The test is skipped unless `UNFILED_SETTINGS_SNAPSHOT_DIR` names a writable directory
/// (pass it through xcodebuild as `TEST_RUNNER_UNFILED_SETTINGS_SNAPSHOT_DIR`), so CI never
/// depends on host paths. Every fixture is synthetic: no real account, key, or note content.
@MainActor
final class SettingsViewSnapshotTests: XCTestCase {
    private static let phoneWidth: CGFloat = 393
    private static let phoneHeight: CGFloat = 852
    private static let canvasHeight: CGFloat = 7_000
    private static let environmentKey = "UNFILED_SETTINGS_SNAPSHOT_DIR"

    func testRendersEverySettingsStateForVisualReview() async throws {
        guard let path = ProcessInfo.processInfo.environment[Self.environmentKey], !path.isEmpty else {
            throw XCTSkip("Set \(Self.environmentKey) to write review snapshots")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        for scenario in try Self.scenarios() {
            try await render(scenario, into: directory)
        }
    }

    // MARK: Rendering

    private struct Scenario {
        let name: String
        let view: AnyView
    }

    private func render(_ scenario: Scenario, into directory: URL) async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
            "The test host needs a window scene to lay out SwiftUI"
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: Self.phoneWidth, height: Self.phoneHeight)
        window.overrideUserInterfaceStyle = .dark
        let host = UIHostingController(rootView: scenario.view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }

        // Pass 1 at phone height: let `.task` adopt the fixture draft and measure the real
        // scroll content height. Pass 2 grows the window to that height so the whole page is
        // laid out on one canvas before it is drawn.
        try await Task.sleep(for: .milliseconds(450))
        host.view.layoutIfNeeded()
        let contentHeight = Self.scrollContentHeight(in: host.view) ?? Self.phoneHeight
        let height = min(max(contentHeight.rounded(.up), Self.phoneHeight), Self.canvasHeight)
        window.frame = CGRect(x: 0, y: 0, width: Self.phoneWidth, height: height)
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        try await Task.sleep(for: .milliseconds(250))
        host.view.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        let data = try XCTUnwrap(image.pngData(), "\(scenario.name) produced no image data")
        try data.write(to: directory.appendingPathComponent("\(scenario.name).png"), options: .atomic)
    }

    private static func scrollContentHeight(in view: UIView) -> CGFloat? {
        if let scrollView = view as? UIScrollView {
            let insets = scrollView.adjustedContentInset
            return scrollView.contentSize.height + insets.top + insets.bottom
        }
        for subview in view.subviews {
            if let height = scrollContentHeight(in: subview) { return height }
        }
        return nil
    }

    // MARK: Fixtures

    private struct Fixture {
        var aiSettings: UserSettings?
        var providerKeys: [AIProvider: ProviderKeyMetadata] = [:]
        var isLoading = false
        var hasLoaded = true
        var isSaving = false
        var hasPendingSettingsRetry = false
        var mutation: ProviderKeyMutation?
        var pendingRetry: AIProvider?
        var settingsError: String?
        var keyErrors: [AIProvider: String] = [:]
        var dynamicTypeSize: DynamicTypeSize = .large
        var isManagedFallbackAvailable = false
    }

    private static func scenarios() throws -> [Scenario] {
        let appDefault = try settings(mode: "app_default", provider: nil, model: "auto")
        let openAIAuto = try settings(mode: "byok", provider: "openai", model: "auto")
        let openAISol = try settings(
            mode: "byok",
            provider: "openai",
            model: "gpt-5.6-sol",
            effort: "thorough"
        )
        let claudeOpus = try settings(mode: "byok", provider: "anthropic", model: "claude-opus-5")
        let openAIKey = try metadata(provider: .openai, lastFour: "7890", status: "active", revision: 8)
        let claudeKey = try metadata(provider: .anthropic, lastFour: "4321", status: "active", revision: 3)
        let rejectedClaudeKey = try metadata(
            provider: .anthropic,
            lastFour: "4321",
            status: "invalid",
            revision: 4
        )
        let bothKeys: [AIProvider: ProviderKeyMetadata] = [.openai: openAIKey, .anthropic: claudeKey]

        let staleSettingsMessage = AppModel.aiSettingsFailureMessage(
            APIClientError.http(status: 409, code: .staleRevision, requestId: nil, retryAfterSeconds: nil)
        )
        let staleKeyMessage = AppModel.providerKeyFailureMessage(
            APIClientError.http(status: 409, code: .staleRevision, requestId: nil, retryAfterSeconds: nil),
            provider: .openai,
            action: .save
        )

        return [
            Scenario(name: "ios-settings-loading", view: makeView(Fixture(isLoading: true, hasLoaded: false))),
            Scenario(name: "ios-settings-empty", view: makeView(Fixture(aiSettings: appDefault))),
            Scenario(
                name: "ios-settings-success",
                view: makeView(Fixture(aiSettings: openAIAuto, providerKeys: bothKeys))
            ),
            Scenario(
                name: "ios-settings-invalid-key",
                view: makeView(Fixture(
                    aiSettings: claudeOpus,
                    providerKeys: [.openai: openAIKey, .anthropic: rejectedClaudeKey],
                    keyErrors: [.anthropic: "Claude rejected this saved key. Replace it before using BYOK."]
                ))
            ),
            Scenario(
                name: "ios-settings-stale-revision",
                view: makeView(Fixture(
                    aiSettings: openAIAuto,
                    providerKeys: bothKeys,
                    settingsError: staleSettingsMessage,
                    keyErrors: [.openai: staleKeyMessage]
                ))
            ),
            Scenario(
                name: "ios-settings-ambiguous-retry",
                view: makeView(Fixture(
                    aiSettings: openAIAuto,
                    providerKeys: [.anthropic: claudeKey],
                    hasPendingSettingsRetry: true,
                    pendingRetry: .openai,
                    settingsError: "Unfiled could not confirm the change. Try Save again to safely retry it.",
                    keyErrors: [.openai: "The storage result is unknown. Paste the exact same key to retry this request, or start over."]
                ))
            ),
            Scenario(
                name: "ios-settings-replacement",
                view: makeView(Fixture(
                    aiSettings: openAISol,
                    providerKeys: bothKeys,
                    mutation: ProviderKeyMutation(provider: .openai, action: .save)
                ))
            ),
            Scenario(
                name: "ios-settings-deletion",
                view: makeView(Fixture(
                    aiSettings: claudeOpus,
                    providerKeys: bothKeys,
                    mutation: ProviderKeyMutation(provider: .anthropic, action: .delete)
                ))
            ),
            Scenario(
                name: "ios-settings-unavailable",
                view: makeView(Fixture(
                    providerKeys: [.openai: openAIKey],
                    settingsError: "AI settings could not be loaded. Pull down to try again."
                ))
            ),
            Scenario(
                name: "ios-settings-accessibility-xxl",
                view: makeView(Fixture(
                    aiSettings: openAIAuto,
                    providerKeys: bothKeys,
                    dynamicTypeSize: .accessibility2
                ))
            ),
            Scenario(
                name: "ios-settings-managed-available",
                view: makeView(Fixture(
                    aiSettings: openAIAuto,
                    providerKeys: bothKeys,
                    isManagedFallbackAvailable: true
                ))
            )
        ]
    }

    private static func makeView(_ fixture: Fixture) -> AnyView {
        AnyView(
            SettingsView(
                email: "reviewer@example.test",
                apiHost: "api.example.test",
                aiSettings: fixture.aiSettings,
                providerKeys: fixture.providerKeys,
                isManagedFallbackAvailable: fixture.isManagedFallbackAvailable,
                isLoadingAISettings: fixture.isLoading,
                hasLoadedAISettings: fixture.hasLoaded,
                isSavingAISettings: fixture.isSaving,
                hasPendingAISettingsRetry: fixture.hasPendingSettingsRetry,
                providerKeyMutation: fixture.mutation,
                pendingProviderKeyRetry: fixture.pendingRetry,
                aiSettingsError: fixture.settingsError,
                providerKeyErrors: fixture.keyErrors,
                accountExportArtifact: nil,
                isPreparingAccountExport: false,
                accountExportError: nil,
                isDeletingAccount: false,
                hasPendingAccountDeletionReplay: false,
                accountDeletionError: nil,
                onRefreshAISettings: {},
                onSaveAISettings: { _ in true },
                onDiscardAISettingsRetry: { nil },
                onSaveProviderKey: { _, _ in true },
                onDiscardProviderKeyRetry: {},
                onDeleteProviderKey: { _ in true },
                onPrepareAccountExport: {},
                onDiscardAccountExport: { _ in },
                onDeleteAccount: { true },
                onOpenRoutingRules: {},
                onSignOut: {}
            )
            .environment(\.dynamicTypeSize, fixture.dynamicTypeSize)
            .environment(\.colorScheme, .dark)
        )
    }

    private static func settings(
        mode: String,
        provider: String?,
        model: String,
        effort: String = "standard"
    ) throws -> UserSettings {
        let providerJSON = provider.map { #""\#($0)""# } ?? "null"
        let json = #"{"settingsRevision":4,"organizationMode":"balanced","providerMode":"\#(mode)","byokProvider":\#(providerJSON),"modelSelection":"\#(model)","byokFallbackToApp":false,"routingEffort":"\#(effort)","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
        return try APIJSON.makeDecoder().decode(UserSettings.self, from: Data(json.utf8))
    }

    private static func metadata(
        provider: AIProvider,
        lastFour: String,
        status: String,
        revision: Int
    ) throws -> ProviderKeyMetadata {
        let validatedAt = status == "active" ? #""2026-09-01T12:00:00Z""# : "null"
        let json = #"{"providerKey":{"provider":"\#(provider.rawValue)","lastFour":"\#(lastFour)","status":"\#(status)","credentialRevision":\#(revision),"validatedAt":\#(validatedAt),"updatedAt":"2026-09-01T12:00:01Z"}}"#
        let response = try APIJSON.makeDecoder().decode(ProviderKeyResponse.self, from: Data(json.utf8))
        return try XCTUnwrap(response.providerKey)
    }
}
