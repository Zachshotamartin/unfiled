import Foundation
import XCTest
@testable import Unfiled

/// Pins the decisions the redesigned Settings screen makes without a view: the caption above the
/// key field, what a provider chip does, which draft follows a validated key, and row values.
final class SettingsPresentationTests: XCTestCase {
    func testKeyCaptionExplainsThatTheBetaNeedsAPersonalKeyWhenManagedIsSavedButUnfunded() {
        let caption = ProviderKeyGroupPresentation.caption(
            mode: .appDefault,
            isManagedFallbackAvailable: false,
            provider: .openai,
            keyStatus: nil,
            fallbackAllowed: false
        )
        XCTAssertEqual(
            caption,
            "This free beta does not fund AI. Add your own OpenAI or Claude key to organize new captures."
        )
        XCTAssertNil(
            ProviderKeyGroupPresentation.caption(
                mode: .appDefault,
                isManagedFallbackAvailable: true,
                provider: .openai,
                keyStatus: nil,
                fallbackAllowed: false
            ),
            "A funded deployment needs no explanation"
        )
        XCTAssertNil(
            ProviderKeyGroupPresentation.caption(
                mode: nil,
                isManagedFallbackAvailable: false,
                provider: .openai,
                keyStatus: nil,
                fallbackAllowed: false
            ),
            "Unknown settings never claim a mode"
        )
    }

    func testKeyCaptionWarnsWhenTheProviderInUseHasNoActiveKey() {
        for status in [ProviderKeyStatus.invalid, .revoked, nil] {
            XCTAssertEqual(
                ProviderKeyGroupPresentation.caption(
                    mode: .byok,
                    isManagedFallbackAvailable: false,
                    provider: .anthropic,
                    keyStatus: status,
                    fallbackAllowed: false
                ),
                "No active Claude key is saved. New captures wait in the queue until one is."
            )
        }
        XCTAssertNil(
            ProviderKeyGroupPresentation.caption(
                mode: .byok,
                isManagedFallbackAvailable: false,
                provider: .anthropic,
                keyStatus: .active,
                fallbackAllowed: false
            )
        )
        XCTAssertNil(
            ProviderKeyGroupPresentation.caption(
                mode: .byok,
                isManagedFallbackAvailable: true,
                provider: .anthropic,
                keyStatus: nil,
                fallbackAllowed: true
            ),
            "An allowed fallback keeps captures moving"
        )
    }

    func testProviderChipAppliesImmediatelyOnlyWhenThatKeyIsActive() {
        XCTAssertTrue(ProviderKeyGroupPresentation.selectsProviderImmediately(keyStatus: .active))
        XCTAssertFalse(ProviderKeyGroupPresentation.selectsProviderImmediately(keyStatus: .invalid))
        XCTAssertFalse(ProviderKeyGroupPresentation.selectsProviderImmediately(keyStatus: .revoked))
        XCTAssertFalse(ProviderKeyGroupPresentation.selectsProviderImmediately(keyStatus: nil))
    }

    func testDraftUsingKeySelectsMyKeyModeForThatProviderThroughTheSettingsContract() throws {
        let managed = try Self.decodeSettings(Self.managedSettingsJSON)
        let draft = AISettingsDraft(settings: managed)
        let next = ProviderKeyGroupPresentation.draftUsingKey(draft, for: .anthropic)
        XCTAssertEqual(next.providerMode, .byok)
        XCTAssertEqual(next.byokProvider, .anthropic)
        XCTAssertEqual(next.modelSelection, .automatic)
        XCTAssertEqual(draft.providerMode, .appDefault, "The original draft is left untouched")

        let request = try XCTUnwrap(next.makeUpdateRequest(
            comparedTo: managed,
            idempotencyKey: "key-save-selects-byok",
            managedFallbackAvailable: false
        ))
        let body = try Self.jsonObject(request)
        XCTAssertEqual(body["providerMode"] as? String, "byok")
        XCTAssertEqual(body["byokProvider"] as? String, "anthropic")
        XCTAssertNil(body["byokFallbackToApp"], "Fallback stays off on an unfunded deployment")
    }

    func testDraftUsingKeyKeepsACompatibleExactModelAndResetsTheOtherProviders() throws {
        let openAISol = try Self.decodeSettings(Self.openAISolSettingsJSON)
        let draft = AISettingsDraft(settings: openAISol)
        XCTAssertEqual(
            ProviderKeyGroupPresentation.draftUsingKey(draft, for: .openai).modelSelection,
            .gpt56Sol
        )
        XCTAssertEqual(
            ProviderKeyGroupPresentation.draftUsingKey(draft, for: .anthropic).modelSelection,
            .automatic
        )
        XCTAssertNil(
            try ProviderKeyGroupPresentation.draftUsingKey(draft, for: .openai).makeUpdateRequest(
                comparedTo: openAISol,
                idempotencyKey: "key-save-no-change",
                managedFallbackAvailable: false
            ),
            "Re-saving the key of the provider already in use changes nothing"
        )
    }

    func testRowValuesReadTheDraft() throws {
        let claude = try Self.decodeSettings(Self.claudeSettingsJSON)
        let draft = AISettingsDraft(settings: claude)
        XCTAssertEqual(SettingsRowPresentation.accessValue(draft), "My API key")
        XCTAssertEqual(SettingsRowPresentation.effortValue(draft), "Thorough")
        XCTAssertEqual(SettingsRowPresentation.modelValue(draft), "Claude Opus 5")
        XCTAssertEqual(SettingsRowPresentation.expansionValue(draft), "Detailed")
        XCTAssertEqual(SettingsRowPresentation.behaviorValue(draft), "Cautious")
        XCTAssertEqual(SettingsRowPresentation.timezoneValue(draft), "Europe/London")

        let managed = AISettingsDraft(settings: try Self.decodeSettings(Self.managedSettingsJSON))
        XCTAssertEqual(SettingsRowPresentation.accessValue(managed), "Unfiled managed")
        XCTAssertEqual(SettingsRowPresentation.modelValue(managed), "Automatic")
    }

    func testModelDetailNamesTheResolvedAutomaticModelAndHigherCostChoices() throws {
        let claude = try Self.decodeSettings(Self.claudeSettingsJSON)
        let draft = AISettingsDraft(settings: claude)
        XCTAssertEqual(
            SettingsRowPresentation.modelDetail(.automatic, draft: draft),
            "Follows effort · now Claude Opus 5"
        )
        XCTAssertEqual(
            SettingsRowPresentation.modelDetail(.claudeOpus5, draft: draft),
            "Most capable Claude choice with higher latency and cost. Higher cost on your key."
        )
        XCTAssertEqual(
            SettingsRowPresentation.modelDetail(.claudeSonnet5, draft: draft),
            "Balanced Claude quality, latency, and cost."
        )
    }

    func testKeyStatusLineShowsOnlyTheLastFourAndTheValidationDate() throws {
        let active = try Self.decodeMetadata(provider: .openai, lastFour: "7890", status: "active")
        let line = ProviderKeyGroupPresentation.statusLine(active)
        XCTAssertTrue(line.hasPrefix("Ends 7890 · "), line)
        XCTAssertTrue(line.contains("2026"), "The validation date follows the last four: \(line)")
        XCTAssertFalse(line.contains("revision"))

        let rejected = try Self.decodeMetadata(provider: .anthropic, lastFour: "4321", status: "invalid")
        XCTAssertEqual(ProviderKeyGroupPresentation.statusLine(rejected), "Rejected · ends 4321")
        let revoked = try Self.decodeMetadata(provider: .anthropic, lastFour: "4321", status: "revoked")
        XCTAssertEqual(ProviderKeyGroupPresentation.statusLine(revoked), "Revoked · ends 4321")
    }

    func testRowIdentifiersDeriveFromTheChoiceIdentifiers() {
        XCTAssertEqual(
            AISettingsAccessibilityIdentifier.row(AISettingsAccessibilityIdentifier.routingEffort),
            "settings.ai.routing-effort.row"
        )
        XCTAssertGreaterThanOrEqual(
            AISettingsControlLayout.rowMinimumHeight,
            UnfiledTheme.minimumTouchTarget
        )
    }

    // MARK: Fixtures

    private static func decodeSettings(_ json: String) throws -> UserSettings {
        try APIJSON.makeDecoder().decode(UserSettings.self, from: Data(json.utf8))
    }

    private static func decodeMetadata(
        provider: AIProvider,
        lastFour: String,
        status: String
    ) throws -> ProviderKeyMetadata {
        let validatedAt = status == "active" ? #""2026-09-01T12:00:00Z""# : "null"
        let json = #"{"providerKey":{"provider":"\#(provider.rawValue)","lastFour":"\#(lastFour)","status":"\#(status)","credentialRevision":2,"validatedAt":\#(validatedAt),"updatedAt":"2026-09-01T12:00:01Z"}}"#
        let response = try APIJSON.makeDecoder().decode(ProviderKeyResponse.self, from: Data(json.utf8))
        return try XCTUnwrap(response.providerKey)
    }

    private static func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIJSON.makeEncoder().encode(value))
                as? [String: Any]
        )
    }

    private static let managedSettingsJSON = #"{"settingsRevision":4,"organizationMode":"balanced","providerMode":"app_default","byokProvider":null,"modelSelection":"auto","byokFallbackToApp":false,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let openAISolSettingsJSON = #"{"settingsRevision":5,"organizationMode":"balanced","providerMode":"byok","byokProvider":"openai","modelSelection":"gpt-5.6-sol","byokFallbackToApp":false,"routingEffort":"thorough","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let claudeSettingsJSON = #"{"settingsRevision":9,"organizationMode":"cautious","providerMode":"byok","byokProvider":"anthropic","modelSelection":"claude-opus-5","byokFallbackToApp":false,"routingEffort":"thorough","expansionStyle":"detailed","timezone":"Europe/London","locale":"en-GB","updatedAt":"2026-09-01T12:00:00Z"}"#
}
