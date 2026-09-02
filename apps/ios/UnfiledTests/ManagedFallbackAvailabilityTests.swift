import Foundation
import XCTest
@testable import Unfiled

/// Managed (app-funded) AI is a deployment capability read from the build configuration
/// (`UNFILED_MANAGED_AI_FALLBACK_AVAILABLE` → Info.plist `UnfiledManagedAIFallbackAvailable`).
/// These tests pin both flag states without any new API field.
final class ManagedFallbackAvailabilityTests: XCTestCase {
    func testBuildFlagParsesXcconfigBooleansAndFailsClosed() throws {
        for raw in ["YES", "yes", " Yes ", "true", "TRUE", "1"] {
            XCTAssertTrue(AppConfiguration.managedAIFallbackAvailability(from: raw), raw)
        }
        for raw in ["NO", "no", "false", "0", "", "  ", "maybe", "$(UNFILED_MANAGED_AI_FALLBACK_AVAILABLE)"] {
            XCTAssertFalse(AppConfiguration.managedAIFallbackAvailability(from: raw), raw)
        }
        XCTAssertFalse(AppConfiguration.managedAIFallbackAvailability(from: nil))
        XCTAssertEqual(AppConfiguration.managedAIFallbackInfoKey, "UnfiledManagedAIFallbackAvailable")

        let unavailable = try AppConfiguration.validated(
            apiBaseURLString: "https://api.example.test/api/v1",
            bundleIdentifier: "test.bundle"
        )
        XCTAssertFalse(unavailable.isManagedAIFallbackAvailable, "The default is unavailable")

        let available = try AppConfiguration.validated(
            apiBaseURLString: "https://api.example.test/api/v1",
            bundleIdentifier: "test.bundle",
            isManagedAIFallbackAvailable: true
        )
        XCTAssertTrue(available.isManagedAIFallbackAvailable)
    }

    func testUnavailableDeploymentHidesFallbackAndOffersManagedModeOnlyWhenAlreadySaved() {
        XCTAssertFalse(ManagedFallbackContract.showsFallbackToggle(isAvailable: false))
        XCTAssertTrue(ManagedFallbackContract.showsFallbackToggle(isAvailable: true))

        XCTAssertFalse(ManagedFallbackContract.offersManagedMode(isAvailable: false, savedMode: .byok))
        XCTAssertTrue(
            ManagedFallbackContract.offersManagedMode(isAvailable: false, savedMode: .appDefault),
            "Settings saved as managed stay visible so the user can move to a key"
        )
        XCTAssertTrue(ManagedFallbackContract.offersManagedMode(isAvailable: true, savedMode: .byok))
        XCTAssertTrue(ManagedFallbackContract.offersManagedMode(isAvailable: true, savedMode: .appDefault))

        XCTAssertFalse(ManagedFallbackContract.fallbackValue(requested: true, isAvailable: false))
        XCTAssertTrue(ManagedFallbackContract.fallbackValue(requested: true, isAvailable: true))
        XCTAssertFalse(ManagedFallbackContract.fallbackValue(requested: false, isAvailable: true))
    }

    func testUnavailableDeploymentNeverSendsFallbackTrue() throws {
        let savedWithFallback = try Self.decodeSettings(Self.byokSettingsJSON(fallback: true))
        var draft = AISettingsDraft(settings: savedWithFallback)
        draft.routingEffort = .thorough

        let request = try XCTUnwrap(draft.makeUpdateRequest(
            comparedTo: savedWithFallback,
            idempotencyKey: "fallback-off-1",
            managedFallbackAvailable: false
        ))
        let body = try Self.jsonObject(request)
        XCTAssertEqual(body["byokFallbackToApp"] as? Bool, false, "A stored true is turned off")
        XCTAssertEqual(body["routingEffort"] as? String, "thorough")

        let applied = draft.applyingManagedFallbackAvailability(false)
        XCTAssertFalse(applied.byokFallbackToApp)
        XCTAssertTrue(draft.byokFallbackToApp, "Applying returns a new draft and leaves the original")
        XCTAssertTrue(draft.applyingManagedFallbackAvailability(true).byokFallbackToApp)

        let savedWithoutFallback = try Self.decodeSettings(Self.byokSettingsJSON(fallback: false))
        var wantsFallback = AISettingsDraft(settings: savedWithoutFallback)
        wantsFallback.byokFallbackToApp = true
        XCTAssertNil(
            try wantsFallback.makeUpdateRequest(
                comparedTo: savedWithoutFallback,
                idempotencyKey: "fallback-off-2",
                managedFallbackAvailable: false
            ),
            "Requesting fallback on an unavailable deployment is not a change at all"
        )
    }

    func testAvailableDeploymentSendsTheUsersFallbackChoice() throws {
        let saved = try Self.decodeSettings(Self.byokSettingsJSON(fallback: false))
        var wantsFallback = AISettingsDraft(settings: saved)
        wantsFallback.byokFallbackToApp = true

        let request = try XCTUnwrap(wantsFallback.makeUpdateRequest(
            comparedTo: saved,
            idempotencyKey: "fallback-on-1",
            managedFallbackAvailable: true
        ))
        let body = try Self.jsonObject(request)
        XCTAssertEqual(body["byokFallbackToApp"] as? Bool, true)
        XCTAssertEqual(
            Set(body.keys),
            ["expectedSettingsRevision", "idempotencyKey", "byokFallbackToApp"]
        )

        let managed = AISettingsDraft(settings: saved).selectingProviderMode(.appDefault)
        let managedBody = try Self.jsonObject(XCTUnwrap(managed.makeUpdateRequest(
            comparedTo: saved,
            idempotencyKey: "fallback-managed-1",
            managedFallbackAvailable: true
        )))
        XCTAssertEqual(managedBody["providerMode"] as? String, "app_default")
        XCTAssertTrue(managedBody["byokProvider"] is NSNull)
        XCTAssertNil(managedBody["byokFallbackToApp"], "App-default mode has no fallback to send")
    }

    private static func decodeSettings(_ json: String) throws -> UserSettings {
        try APIJSON.makeDecoder().decode(UserSettings.self, from: Data(json.utf8))
    }

    private static func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIJSON.makeEncoder().encode(value))
                as? [String: Any]
        )
    }

    private static func byokSettingsJSON(fallback: Bool) -> String {
        #"{"settingsRevision":7,"organizationMode":"balanced","providerMode":"byok","byokProvider":"openai","modelSelection":"auto","byokFallbackToApp":\#(fallback),"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    }
}
