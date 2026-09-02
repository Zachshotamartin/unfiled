import Foundation
import XCTest
@testable import Unfiled

final class AISettingsTests: XCTestCase {
    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testPublicProviderContractRejectsAnthropicEverywhere() throws {
        XCTAssertEqual(AIProvider.allCases, [.openai])
        XCTAssertThrowsError(
            try APIJSON.makeDecoder().decode(
                UserSettingsResponse.self,
                from: Data(Self.byokSettingsResponseJSON.replacingOccurrences(
                    of: #""byokProvider":"openai""#,
                    with: #""byokProvider":"anthropic""#
                ).utf8)
            )
        )
        XCTAssertThrowsError(
            try APIJSON.makeDecoder().decode(
                ProviderKeyResponse.self,
                from: Data(Self.providerKeyResponseJSON.replacingOccurrences(
                    of: #""provider":"openai""#,
                    with: #""provider":"anthropic""#
                ).utf8)
            )
        )
    }

    func testSettingsDraftBuildsCoherentSparseCASAcrossAllChoices() throws {
        let current = try Self.decodeSettings(Self.appDefaultSettingsJSON)
        var draft = AISettingsDraft(settings: current)
        draft.organizationMode = .automatic
        draft.providerMode = .byok
        draft.byokFallbackToApp = true
        draft.routingEffort = .thorough
        draft.expansionStyle = .off
        draft.timezone = "  UTC  "
        draft.locale = "en-GB"

        let request = try XCTUnwrap(
            draft.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-cas-1")
        )
        let body = try Self.jsonObject(request)
        XCTAssertEqual(body["expectedSettingsRevision"] as? Int, 4)
        XCTAssertEqual(body["idempotencyKey"] as? String, "settings-cas-1")
        XCTAssertEqual(body["organizationMode"] as? String, "automatic")
        XCTAssertEqual(body["providerMode"] as? String, "byok")
        XCTAssertEqual(body["byokProvider"] as? String, "openai")
        XCTAssertEqual(body["byokFallbackToApp"] as? Bool, true)
        XCTAssertEqual(body["routingEffort"] as? String, "thorough")
        XCTAssertEqual(body["expansionStyle"] as? String, "off")
        XCTAssertEqual(body["timezone"] as? String, "UTC")
        XCTAssertEqual(body["locale"] as? String, "en-GB")

        let byokCurrent = try Self.decodeSettings(Self.byokSettingsJSON)
        var appDraft = AISettingsDraft(settings: byokCurrent)
        appDraft.providerMode = .appDefault
        appDraft.byokFallbackToApp = true
        let appRequest = try XCTUnwrap(
            appDraft.makeUpdateRequest(comparedTo: byokCurrent, idempotencyKey: "settings-cas-2")
        )
        let appBody = try Self.jsonObject(appRequest)
        XCTAssertEqual(appBody["providerMode"] as? String, "app_default")
        XCTAssertTrue(appBody["byokProvider"] is NSNull)
        XCTAssertEqual(appBody["byokFallbackToApp"] as? Bool, false)
    }

    func testSettingsDraftRejectsInvalidTimezoneAndLocaleAndOmitsNoop() throws {
        let current = try Self.decodeSettings(Self.appDefaultSettingsJSON)
        var draft = AISettingsDraft(settings: current)
        XCTAssertNil(
            try draft.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-noop-1")
        )

        draft.timezone = "Los Angeles"
        XCTAssertEqual(
            draft.validationMessage,
            "Enter a valid IANA timezone, such as America/Los_Angeles."
        )
        XCTAssertThrowsError(
            try draft.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-invalid-1")
        )

        draft.timezone = "UTC"
        draft.locale = "not_a_locale"
        XCTAssertEqual(draft.validationMessage, "Enter a valid locale, such as en-US.")
    }

    func testAmbiguousSettingsRetryLocksControlsAndPermitsOnlyTheExactDraft() throws {
        let current = try Self.decodeSettings(Self.appDefaultSettingsJSON)
        var attempted = AISettingsDraft(settings: current)
        attempted.routingEffort = .thorough
        var changed = attempted
        changed.expansionStyle = .detailed

        XCTAssertFalse(
            AISettingsRetryContract.controlsAreLocked(
                isLoading: false,
                isSaving: false,
                hasPendingRetry: false
            )
        )
        XCTAssertTrue(
            AISettingsRetryContract.controlsAreLocked(
                isLoading: false,
                isSaving: false,
                hasPendingRetry: true
            )
        )
        XCTAssertTrue(
            AISettingsRetryContract.permitsSave(
                hasPendingRetry: true,
                pendingDraft: attempted,
                submittedDraft: attempted
            )
        )
        XCTAssertFalse(
            AISettingsRetryContract.permitsSave(
                hasPendingRetry: true,
                pendingDraft: attempted,
                submittedDraft: changed
            )
        )
        XCTAssertFalse(
            AISettingsRetryContract.permitsSave(
                hasPendingRetry: true,
                pendingDraft: nil,
                submittedDraft: attempted
            )
        )
    }

    func testDiscardAfterAmbiguousCommitReloadsAuthoritativeDraftBeforeUnlocking() async throws {
        let current = try Self.decodeSettings(Self.appDefaultSettingsJSON)
        let authoritativeResponse = try APIJSON.makeDecoder().decode(
            UserSettingsResponse.self,
            from: Data(Self.updatedSettingsSnapshotJSON.utf8)
        )
        var draft = AISettingsDraft(settings: current)
        draft.routingEffort = .thorough

        let reconciliation = await AISettingsRetryContract.reconcile(current: current) {
            authoritativeResponse
        }
        let authoritative = try XCTUnwrap(reconciliation.authoritativeSettings)
        var hasPendingRetry = reconciliation.retainsRetryLock
        var isReconcilingRetry = true

        XCTAssertTrue(
            AISettingsRetryContract.controlsAreLocked(
                isLoading: false,
                isSaving: false,
                hasPendingRetry: hasPendingRetry,
                isReconcilingRetry: isReconcilingRetry
            ),
            "The view-local reconciliation lock must cover the model publishing its success"
        )

        draft = AISettingsDraft(settings: authoritative)
        isReconcilingRetry = false
        hasPendingRetry = false

        XCTAssertEqual(draft, AISettingsDraft(settings: authoritativeResponse.settings))
        XCTAssertFalse(
            AISettingsRetryContract.controlsAreLocked(
                isLoading: false,
                isSaving: false,
                hasPendingRetry: hasPendingRetry,
                isReconcilingRetry: isReconcilingRetry
            )
        )
    }

    func testDiscardReconciliationFailureRetainsRetryLock() async throws {
        let current = try Self.decodeSettings(Self.appDefaultSettingsJSON)
        let reconciliation = await AISettingsRetryContract.reconcile(current: current) {
            throw URLError(.timedOut)
        }

        XCTAssertNil(reconciliation.authoritativeSettings)
        XCTAssertTrue(reconciliation.retainsRetryLock)
        XCTAssertTrue(
            AISettingsRetryContract.controlsAreLocked(
                isLoading: false,
                isSaving: false,
                hasPendingRetry: reconciliation.retainsRetryLock,
                isReconcilingRetry: false
            )
        )
    }

    func testSettingsMutationAcceptsOnlyExactNextRevisionAndRequestedSnapshot() throws {
        let current = try Self.decodeSettings(Self.appDefaultSettingsJSON)
        var draft = AISettingsDraft(settings: current)
        draft.organizationMode = .cautious
        draft.routingEffort = .economical
        draft.expansionStyle = .detailed

        let valid = try APIJSON.makeDecoder().decode(
            UserSettingsUpdateResponse.self,
            from: Data(Self.updatedSettingsResponseJSON.utf8)
        )
        XCTAssertTrue(
            AISettingsMutationContract.accepts(valid, replacing: current, with: draft)
        )

        let stale = try APIJSON.makeDecoder().decode(
            UserSettingsUpdateResponse.self,
            from: Data(Self.updatedSettingsResponseJSON.replacingOccurrences(
                of: #""settingsRevision":5"#,
                with: #""settingsRevision":6"#
            ).utf8)
        )
        XCTAssertFalse(
            AISettingsMutationContract.accepts(stale, replacing: current, with: draft)
        )

        var mismatched = draft
        mismatched.expansionStyle = .off
        XCTAssertFalse(
            AISettingsMutationContract.accepts(valid, replacing: current, with: mismatched)
        )
    }

    func testProviderKeyInputIsStrictAndRequestDescriptionIsAlwaysRedacted() throws {
        let secret = Self.syntheticProviderKey("12345678901234567890")
        XCTAssertTrue(ProviderKeyInputRules.isValid(secret))
        XCTAssertFalse(ProviderKeyInputRules.isValid(" \(secret)"))
        XCTAssertFalse(ProviderKeyInputRules.isValid("\(secret)\n"))
        XCTAssertFalse(
            ProviderKeyInputRules.isValid(Self.syntheticProviderKey("1234567890\u{200B}123456"))
        )
        XCTAssertFalse(ProviderKeyInputRules.isValid(Self.syntheticProviderKey("1234567890123456é")))
        XCTAssertFalse(ProviderKeyInputRules.isValid(Self.syntheticProviderKey("1234567890123456🔐")))
        XCTAssertFalse(ProviderKeyInputRules.isValid(String(repeating: "k", count: 19)))
        XCTAssertFalse(ProviderKeyInputRules.isValid(String(repeating: "k", count: 501)))

        let request = try ProviderKeyPutRequest(
            idempotencyKey: "key-put-redaction-1",
            provider: .openai,
            expectedCredentialRevision: 7,
            apiKey: secret
        )
        let body = try Self.jsonObject(request)
        XCTAssertEqual(body["expectedCredentialRevision"] as? Int, 7)
        XCTAssertEqual(body["apiKey"] as? String, secret)
        XCTAssertEqual(String(describing: request), "ProviderKeyPutRequest(<redacted>)")
        XCTAssertFalse(String(describing: request).contains(secret))
        XCTAssertFalse(String(reflecting: request).contains(secret))
        XCTAssertThrowsError(
            try ProviderKeyPutRequest(
                idempotencyKey: "invalid retry key",
                provider: .openai,
                expectedCredentialRevision: nil,
                apiKey: secret
            )
        )
    }

    func testProviderPutMutationChecksRevisionStatusValidationAndLastFour() throws {
        let secret = Self.syntheticProviderKey("12345678901234567890")
        let valid = try APIJSON.makeDecoder().decode(
            ProviderKeyPutResponse.self,
            from: Data(Self.providerPutResponseJSON.utf8)
        )
        XCTAssertTrue(
            AISettingsMutationContract.accepts(
                valid,
                expectedCredentialRevision: 7,
                submittedKey: secret
            )
        )

        let invalidStatus = try APIJSON.makeDecoder().decode(
            ProviderKeyPutResponse.self,
            from: Data(Self.providerPutResponseJSON.replacingOccurrences(
                of: #""status":"active""#,
                with: #""status":"invalid""#
            ).utf8)
        )
        XCTAssertFalse(
            AISettingsMutationContract.accepts(
                invalidStatus,
                expectedCredentialRevision: 7,
                submittedKey: secret
            )
        )
        XCTAssertFalse(
            AISettingsMutationContract.accepts(
                valid,
                expectedCredentialRevision: 6,
                submittedKey: secret
            )
        )
        XCTAssertFalse(
            AISettingsMutationContract.accepts(
                valid,
                expectedCredentialRevision: 7,
                submittedKey: Self.syntheticProviderKey("12345678901234561111")
            ),
            "An idempotent replay must not bind old last-four metadata to a changed key body"
        )

        XCTAssertTrue(
            AISettingsMutationContract.accepts(
                valid,
                expectedCredentialRevision: nil,
                submittedKey: secret
            ),
            "A create after deletion uses the owner's monotonic counter and need not restart at one"
        )
    }

    func testProviderDeleteUsesCredentialCASAndStrictConfirmation() async throws {
        let tokenProvider = APITokenProviderStub()
        let request = try ProviderKeyDeleteRequest(
            idempotencyKey: "provider-delete-1",
            provider: .openai,
            expectedCredentialRevision: 8
        )
        APIURLProtocolStub.install { urlRequest in
            XCTAssertEqual(urlRequest.httpMethod, "DELETE")
            XCTAssertEqual(urlRequest.url?.path, "/api/v1/me/provider-key")
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Idempotency-Key"), "provider-delete-1")
            let body = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(urlRequest)) as? [String: Any]
            )
            XCTAssertEqual(body["provider"] as? String, "openai")
            XCTAssertEqual(body["expectedCredentialRevision"] as? Int, 8)
            return apiResponse(
                for: urlRequest,
                json: Self.providerDeleteResponseJSON,
                privateNoStore: true
            )
        }

        let response = try await makeStubbedAPIClient(tokenProvider: tokenProvider)
            .deleteProviderKey(request)
        XCTAssertTrue(
            AISettingsMutationContract.accepts(response, expectedCredentialRevision: 8)
        )
        XCTAssertThrowsError(
            try ProviderKeyDeleteRequest(
                idempotencyKey: "provider-delete-invalid",
                provider: .openai,
                expectedCredentialRevision: 0
            )
        )
    }

    func testSettingsEndpointsEnforceNarrowResponseBounds() async throws {
        let tokenProvider = APITokenProviderStub()
        APIURLProtocolStub.install { request in
            apiResponse(
                for: request,
                json: #"{"oversized":"\#(String(repeating: "x", count: 40_000))"}"#,
                privateNoStore: true
            )
        }

        await XCTAssertAISettingsThrowsAsync(
            try await makeStubbedAPIClient(tokenProvider: tokenProvider).getUserSettings()
        ) { error in
            XCTAssertEqual(error as? APIClientError, .responseBodyTooLarge(limit: 32 * 1_024))
        }
    }

    func testSettingsEndpointsRequirePrivateNoStoreResponseHeaders() async throws {
        let tokenProvider = APITokenProviderStub()
        APIURLProtocolStub.install { request in
            apiResponse(for: request, json: Self.providerKeyResponseJSON)
        }

        await XCTAssertAISettingsThrowsAsync(
            try await makeStubbedAPIClient(tokenProvider: tokenProvider)
                .getProviderKeyMetadata()
        ) { error in
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }
    }

    func testSettingsErrorsAreSanitizedAndNeverContainServerOrCredentialText() {
        let secret = Self.syntheticProviderKey("do-not-show-1234567890")
        let error = APIClientError.http(
            status: 409,
            code: .staleRevision,
            requestId: secret,
            retryAfterSeconds: nil
        )
        let message = AppModel.aiSettingsFailureMessage(error)
        XCTAssertEqual(
            message,
            "Settings changed on another device. The latest copy is shown; review it before saving."
        )
        XCTAssertFalse(message.contains(secret))
    }

    func testSettingsAccessibilityIdentifiersAreStableAndUnique() {
        let values = [
            AISettingsAccessibilityIdentifier.screen,
            AISettingsAccessibilityIdentifier.loading,
            AISettingsAccessibilityIdentifier.settingsError,
            AISettingsAccessibilityIdentifier.organizationMode,
            AISettingsAccessibilityIdentifier.providerMode,
            AISettingsAccessibilityIdentifier.fallback,
            AISettingsAccessibilityIdentifier.routingEffort,
            AISettingsAccessibilityIdentifier.expansionStyle,
            AISettingsAccessibilityIdentifier.timezone,
            AISettingsAccessibilityIdentifier.locale,
            AISettingsAccessibilityIdentifier.save,
            AISettingsAccessibilityIdentifier.settingsRetryDiscard,
            AISettingsAccessibilityIdentifier.keyStatus,
            AISettingsAccessibilityIdentifier.keyInput,
            AISettingsAccessibilityIdentifier.keySave,
            AISettingsAccessibilityIdentifier.keyRetryDiscard,
            AISettingsAccessibilityIdentifier.keyDelete
        ]
        XCTAssertEqual(Set(values).count, values.count)
        XCTAssertTrue(values.allSatisfy { $0.hasPrefix("settings.ai.") })
    }

    func testCredentialControlsHaveIntentionalSpacingAndAccessibleHitTargets() {
        XCTAssertGreaterThanOrEqual(AISettingsControlLayout.credentialFieldActionGap, 12)
        XCTAssertGreaterThanOrEqual(AISettingsControlLayout.credentialActionSpacing, 8)
        XCTAssertGreaterThanOrEqual(
            AISettingsControlLayout.credentialActionMinimumHeight,
            UnfiledTheme.minimumTouchTarget
        )
        XCTAssertGreaterThanOrEqual(
            AISettingsControlLayout.destructiveActionMinimumWidth,
            UnfiledTheme.minimumTouchTarget
        )
        XCTAssertNotEqual(
            AISettingsAccessibilityIdentifier.keyInput,
            AISettingsAccessibilityIdentifier.keySave
        )
        XCTAssertNotEqual(
            AISettingsAccessibilityIdentifier.keyInput,
            AISettingsAccessibilityIdentifier.keyDelete
        )
        XCTAssertNotEqual(
            AISettingsAccessibilityIdentifier.keySave,
            AISettingsAccessibilityIdentifier.keyDelete
        )
        XCTAssertNotEqual(
            AISettingsAccessibilityIdentifier.keySave,
            AISettingsAccessibilityIdentifier.keyRetryDiscard
        )
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

    private static func syntheticProviderKey(_ suffix: String) -> String {
        "s" + "k-test-" + suffix
    }

    private static let appDefaultSettingsJSON = #"{"settingsRevision":4,"organizationMode":"balanced","providerMode":"app_default","byokProvider":null,"byokFallbackToApp":false,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let byokSettingsJSON = #"{"settingsRevision":7,"organizationMode":"balanced","providerMode":"byok","byokProvider":"openai","byokFallbackToApp":true,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let byokSettingsResponseJSON = #"{"settings":\#(byokSettingsJSON)}"#
    private static let updatedSettingsResponseJSON = #"{"settings":{"settingsRevision":5,"organizationMode":"cautious","providerMode":"app_default","byokProvider":null,"byokFallbackToApp":false,"routingEffort":"economical","expansionStyle":"detailed","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:01:00Z"},"replayed":false}"#
    private static let updatedSettingsSnapshotJSON = #"{"settings":{"settingsRevision":5,"organizationMode":"cautious","providerMode":"app_default","byokProvider":null,"byokFallbackToApp":false,"routingEffort":"economical","expansionStyle":"detailed","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:01:00Z"}}"#
    private static let providerKeyResponseJSON = #"{"providerKey":{"provider":"openai","lastFour":"7890","status":"active","credentialRevision":8,"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"}}"#
    private static let providerPutResponseJSON = #"{"providerKey":{"provider":"openai","lastFour":"7890","status":"active","credentialRevision":8,"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"},"replayed":false}"#
    private static let providerDeleteResponseJSON = #"{"provider":"openai","deleted":true,"deletedCredentialRevision":8,"replayed":false}"#
}

private func XCTAssertAISettingsThrowsAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ verify: (Error) -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error", file: file, line: line)
    } catch {
        verify(error)
    }
}
