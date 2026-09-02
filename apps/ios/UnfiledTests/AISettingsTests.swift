import Foundation
import XCTest
@testable import Unfiled

final class AISettingsTests: XCTestCase {
    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testPublicProviderContractAcceptsBothProvidersAndRejectsUnknownOnes() throws {
        XCTAssertEqual(AIProvider.allCases, [.openai, .anthropic])
        let decoder = APIJSON.makeDecoder()

        let anthropic = try decoder.decode(
            UserSettingsResponse.self,
            from: Data(Self.anthropicSettingsResponseJSON.utf8)
        )
        XCTAssertEqual(anthropic.settings.byokProvider, .anthropic)
        XCTAssertEqual(anthropic.settings.modelSelection, .claudeOpus5)

        XCTAssertThrowsError(
            try decoder.decode(
                UserSettingsResponse.self,
                from: Data(Self.byokSettingsResponseJSON.replacingOccurrences(
                    of: #""byokProvider":"openai""#,
                    with: #""byokProvider":"google""#
                ).utf8)
            )
        )
        XCTAssertThrowsError(
            try decoder.decode(
                ProviderKeyResponse.self,
                from: Data(Self.providerKeyResponseJSON.replacingOccurrences(
                    of: #""provider":"openai""#,
                    with: #""provider":"google""#
                ).utf8)
            )
        )
    }

    func testModelRegistryMirrorsContractCatalogV2() {
        XCTAssertEqual(AIModelRegistry.version, "organization-model-registry-v2")
        XCTAssertEqual(
            AIModelSelection.allCases.map(\.rawValue),
            ["auto", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-5", "claude-opus-5"]
        )
        XCTAssertEqual(
            AIModelRegistry.selections(for: .openai),
            [.automatic, .gpt56Luna, .gpt56Terra, .gpt56Sol]
        )
        XCTAssertEqual(
            AIModelRegistry.selections(for: .anthropic),
            [.automatic, .claudeSonnet5, .claudeOpus5]
        )

        XCTAssertEqual(AIModelRegistry.automaticModel(for: .openai, effort: .economical), .gpt56Luna)
        XCTAssertEqual(AIModelRegistry.automaticModel(for: .openai, effort: .standard), .gpt56Terra)
        XCTAssertEqual(AIModelRegistry.automaticModel(for: .openai, effort: .thorough), .gpt56Sol)
        XCTAssertEqual(
            AIModelRegistry.automaticModel(for: .anthropic, effort: .economical),
            .claudeSonnet5
        )
        XCTAssertEqual(
            AIModelRegistry.automaticModel(for: .anthropic, effort: .standard),
            .claudeSonnet5
        )
        XCTAssertEqual(
            AIModelRegistry.automaticModel(for: .anthropic, effort: .thorough),
            .claudeOpus5
        )

        for provider in AIProvider.allCases {
            for model in AIModelRegistry.selections(for: provider) {
                XCTAssertTrue(model.isCompatible(with: provider), "\(model) should suit \(provider)")
            }
        }
        XCTAssertFalse(AIModelSelection.claudeOpus5.isCompatible(with: .openai))
        XCTAssertFalse(AIModelSelection.gpt56Luna.isCompatible(with: .anthropic))
        XCTAssertTrue(AIModelSelection.automatic.isCompatible(with: .anthropic))

        XCTAssertEqual(
            AIModelSelection.allCases.filter(AIModelRegistry.isHigherCost),
            [.gpt56Sol, .claudeOpus5]
        )
        XCTAssertEqual(AIModelRegistry.label(for: .automatic), "Automatic")
        XCTAssertEqual(
            Set(AIModelSelection.allCases.map(AIModelRegistry.label(for:))).count,
            AIModelSelection.allCases.count
        )
    }

    func testSettingsDraftBuildsCoherentSparseCASAcrossAllChoices() throws {
        let current = try Self.decodeSettings(Self.appDefaultSettingsJSON)
        var draft = AISettingsDraft(settings: current)
        draft.organizationMode = .automatic
        draft.providerMode = .byok
        draft.byokProvider = .anthropic
        draft.modelSelection = .claudeOpus5
        draft.byokFallbackToApp = true
        draft.routingEffort = .thorough
        draft.expansionStyle = .off
        draft.timezone = "  UTC  "
        draft.locale = "en-GB"

        let request = try XCTUnwrap(
            draft.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-cas-1", managedFallbackAvailable: true)
        )
        let body = try Self.jsonObject(request)
        XCTAssertEqual(body["expectedSettingsRevision"] as? Int, 4)
        XCTAssertEqual(body["idempotencyKey"] as? String, "settings-cas-1")
        XCTAssertEqual(body["organizationMode"] as? String, "automatic")
        XCTAssertEqual(body["providerMode"] as? String, "byok")
        XCTAssertEqual(body["byokProvider"] as? String, "anthropic")
        XCTAssertEqual(body["modelSelection"] as? String, "claude-opus-5")
        XCTAssertEqual(body["byokFallbackToApp"] as? Bool, true)
        XCTAssertEqual(body["routingEffort"] as? String, "thorough")
        XCTAssertEqual(body["expansionStyle"] as? String, "off")
        XCTAssertEqual(body["timezone"] as? String, "UTC")
        XCTAssertEqual(body["locale"] as? String, "en-GB")

        let byokCurrent = try Self.decodeSettings(Self.byokSettingsJSON)
        let appDraft = AISettingsDraft(settings: byokCurrent).selectingProviderMode(.appDefault)
        let appRequest = try XCTUnwrap(
            appDraft.makeUpdateRequest(comparedTo: byokCurrent, idempotencyKey: "settings-cas-2", managedFallbackAvailable: true)
        )
        let appBody = try Self.jsonObject(appRequest)
        XCTAssertEqual(appBody["providerMode"] as? String, "app_default")
        XCTAssertTrue(appBody["byokProvider"] is NSNull)
        XCTAssertEqual(appBody["modelSelection"] as? String, "auto")
        XCTAssertEqual(appBody["byokFallbackToApp"] as? Bool, false)
    }

    func testSettingsDraftPatchContainsOnlyChangedFields() throws {
        let current = try Self.decodeSettings(Self.byokSettingsJSON)
        var modelOnly = AISettingsDraft(settings: current)
        modelOnly.modelSelection = .gpt56Sol
        let modelRequest = try XCTUnwrap(
            modelOnly.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-patch-1", managedFallbackAvailable: true)
        )
        let modelBody = try Self.jsonObject(modelRequest)
        XCTAssertEqual(
            Set(modelBody.keys),
            ["expectedSettingsRevision", "idempotencyKey", "modelSelection"]
        )
        XCTAssertEqual(modelBody["modelSelection"] as? String, "gpt-5.6-sol")
        XCTAssertEqual(modelBody["expectedSettingsRevision"] as? Int, 7)

        var effortOnly = AISettingsDraft(settings: current)
        effortOnly.routingEffort = .economical
        let effortBody = try Self.jsonObject(XCTUnwrap(
            effortOnly.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-patch-2", managedFallbackAvailable: true)
        ))
        XCTAssertEqual(
            Set(effortBody.keys),
            ["expectedSettingsRevision", "idempotencyKey", "routingEffort"]
        )

        XCTAssertNil(
            try AISettingsDraft(settings: current)
                .makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-patch-noop", managedFallbackAvailable: true)
        )
    }

    func testSwitchingProviderResetsIncompatibleModelToAutomaticAndKeepsCompatibleChoices() throws {
        let current = try Self.decodeSettings(Self.byokSettingsJSON)
        let draft = AISettingsDraft(settings: current)
        XCTAssertEqual(draft.modelSelection, .gpt56Terra)

        let switched = draft.selectingProvider(.anthropic)
        XCTAssertEqual(switched.byokProvider, .anthropic)
        XCTAssertEqual(switched.modelSelection, .automatic)
        XCTAssertEqual(
            draft.modelSelection,
            .gpt56Terra,
            "Selecting a provider returns a new draft and leaves the original untouched"
        )
        XCTAssertEqual(draft.selectingProvider(.openai).modelSelection, .gpt56Terra)

        var exactClaude = switched
        exactClaude.modelSelection = .claudeSonnet5
        XCTAssertEqual(exactClaude.selectingProvider(.anthropic).modelSelection, .claudeSonnet5)
        XCTAssertEqual(exactClaude.selectingProvider(.openai).modelSelection, .automatic)

        let request = try XCTUnwrap(
            switched.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-switch-1", managedFallbackAvailable: true)
        )
        let body = try Self.jsonObject(request)
        XCTAssertEqual(body["byokProvider"] as? String, "anthropic")
        XCTAssertEqual(body["modelSelection"] as? String, "auto")
        XCTAssertNil(body["providerMode"])
        XCTAssertEqual(
            Set(body.keys),
            ["expectedSettingsRevision", "idempotencyKey", "byokProvider", "modelSelection"],
            "A provider switch is a settings patch and never carries credential fields"
        )
    }

    func testAppDefaultModeForcesAutomaticModelAndDisablesFallback() throws {
        let current = try Self.decodeSettings(Self.byokSettingsJSON)
        let draft = AISettingsDraft(settings: current).selectingProviderMode(.appDefault)
        XCTAssertEqual(draft.modelSelection, .automatic)
        XCTAssertFalse(draft.byokFallbackToApp)
        XCTAssertEqual(
            draft.selectingProviderMode(.byok).modelSelection,
            .automatic,
            "Returning to BYOK does not resurrect the previous exact model"
        )

        XCTAssertThrowsError(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-app-default-model",
                providerMode: .appDefault,
                byokProvider: .null,
                modelSelection: .gpt56Terra
            )
        )
        XCTAssertNoThrow(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-app-default-auto",
                providerMode: .appDefault,
                byokProvider: .null,
                modelSelection: .automatic
            )
        )
        XCTAssertThrowsError(
            try Self.decodeSettings(Self.appDefaultSettingsJSON.replacingOccurrences(
                of: #""modelSelection":"auto""#,
                with: #""modelSelection":"gpt-5.6-luna""#
            ))
        )
    }

    func testDraftRejectsCrossProviderModelBeforeBuildingARequest() throws {
        let current = try Self.decodeSettings(Self.byokSettingsJSON)
        var draft = AISettingsDraft(settings: current)
        draft.modelSelection = .claudeOpus5
        XCTAssertThrowsError(
            try draft.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-cross-1", managedFallbackAvailable: true)
        )
        XCTAssertThrowsError(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-cross-2",
                byokProvider: .value(.openai),
                modelSelection: .claudeSonnet5
            )
        )
        XCTAssertNoThrow(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-cross-3",
                byokProvider: .value(.anthropic),
                modelSelection: .claudeSonnet5
            )
        )
    }

    func testAutomaticModelPreviewFollowsProviderAndEffort() throws {
        let current = try Self.decodeSettings(Self.byokSettingsJSON)
        var openAI = AISettingsDraft(settings: current)
        openAI.modelSelection = .automatic
        openAI.routingEffort = .economical
        XCTAssertEqual(openAI.resolvedAutomaticModel, .gpt56Luna)
        openAI.routingEffort = .standard
        XCTAssertEqual(openAI.resolvedAutomaticModel, .gpt56Terra)
        openAI.routingEffort = .thorough
        XCTAssertEqual(openAI.resolvedAutomaticModel, .gpt56Sol)

        var claude = openAI.selectingProvider(.anthropic)
        claude.routingEffort = .economical
        XCTAssertEqual(claude.resolvedAutomaticModel, .claudeSonnet5)
        claude.routingEffort = .standard
        XCTAssertEqual(claude.resolvedAutomaticModel, .claudeSonnet5)
        claude.routingEffort = .thorough
        XCTAssertEqual(claude.resolvedAutomaticModel, .claudeOpus5)
    }

    func testSettingsDraftRejectsInvalidTimezoneAndLocaleAndOmitsNoop() throws {
        let current = try Self.decodeSettings(Self.appDefaultSettingsJSON)
        var draft = AISettingsDraft(settings: current)
        XCTAssertNil(
            try draft.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-noop-1", managedFallbackAvailable: true)
        )

        draft.timezone = "Los Angeles"
        XCTAssertEqual(
            draft.validationMessage,
            "Enter a valid IANA timezone, such as America/Los_Angeles."
        )
        XCTAssertThrowsError(
            try draft.makeUpdateRequest(comparedTo: current, idempotencyKey: "settings-invalid-1", managedFallbackAvailable: true)
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

        var differentModel = draft
        differentModel.providerMode = .byok
        differentModel.byokProvider = .openai
        differentModel.modelSelection = .gpt56Luna
        XCTAssertFalse(
            AISettingsMutationContract.accepts(valid, replacing: current, with: differentModel),
            "A response whose model selection differs from the draft is not the requested snapshot"
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

        for provider in AIProvider.allCases {
            let request = try ProviderKeyPutRequest(
                idempotencyKey: "key-put-redaction-\(provider.rawValue)",
                provider: provider,
                expectedCredentialRevision: 7,
                apiKey: secret
            )
            let body = try Self.jsonObject(request)
            XCTAssertEqual(body["provider"] as? String, provider.rawValue)
            XCTAssertEqual(body["expectedCredentialRevision"] as? Int, 7)
            XCTAssertEqual(body["apiKey"] as? String, secret)
            XCTAssertEqual(String(describing: request), "ProviderKeyPutRequest(<redacted>)")
            XCTAssertFalse(String(describing: request).contains(secret))
            XCTAssertFalse(String(reflecting: request).contains(secret))
        }
        XCTAssertThrowsError(
            try ProviderKeyPutRequest(
                idempotencyKey: "invalid retry key",
                provider: .openai,
                expectedCredentialRevision: nil,
                apiKey: secret
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
                .getProviderKeyMetadata(provider: .openai)
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
        let shared = [
            AISettingsAccessibilityIdentifier.screen,
            AISettingsAccessibilityIdentifier.loading,
            AISettingsAccessibilityIdentifier.settingsError,
            AISettingsAccessibilityIdentifier.providerMode,
            AISettingsAccessibilityIdentifier.provider,
            AISettingsAccessibilityIdentifier.model,
            AISettingsAccessibilityIdentifier.routingEffort,
            AISettingsAccessibilityIdentifier.organizationMode,
            AISettingsAccessibilityIdentifier.expansionStyle,
            AISettingsAccessibilityIdentifier.fallback,
            AISettingsAccessibilityIdentifier.timezone,
            AISettingsAccessibilityIdentifier.locale,
            AISettingsAccessibilityIdentifier.save,
            AISettingsAccessibilityIdentifier.settingsRetryDiscard
        ]
        let keyBases = [
            AISettingsAccessibilityIdentifier.keySection,
            AISettingsAccessibilityIdentifier.keyStatus,
            AISettingsAccessibilityIdentifier.keyInput,
            AISettingsAccessibilityIdentifier.keyError,
            AISettingsAccessibilityIdentifier.keySave,
            AISettingsAccessibilityIdentifier.keyRetryDiscard,
            AISettingsAccessibilityIdentifier.keyDelete
        ]
        let scoped = AIProvider.allCases.flatMap { provider in
            keyBases.map { AISettingsAccessibilityIdentifier.scoped($0, provider) }
        }
        let values = shared + keyBases + scoped
        XCTAssertEqual(Set(values).count, values.count)
        XCTAssertTrue(values.allSatisfy { $0.hasPrefix("settings.ai.") })
        XCTAssertEqual(
            AISettingsAccessibilityIdentifier.scoped(AISettingsAccessibilityIdentifier.keySave, .anthropic),
            "settings.ai.key-save.anthropic"
        )
    }

    func testCredentialControlsHaveIntentionalSpacingAndAccessibleHitTargets() {
        XCTAssertGreaterThanOrEqual(AISettingsControlLayout.credentialFieldActionGap, 12)
        XCTAssertGreaterThanOrEqual(AISettingsControlLayout.credentialActionSpacing, 8)
        XCTAssertGreaterThanOrEqual(AISettingsControlLayout.fieldHelpSpacing, 4)
        XCTAssertGreaterThanOrEqual(AISettingsControlLayout.optionSpacing, 8)
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

    private static let appDefaultSettingsJSON = #"{"settingsRevision":4,"organizationMode":"balanced","providerMode":"app_default","byokProvider":null,"modelSelection":"auto","byokFallbackToApp":false,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let byokSettingsJSON = #"{"settingsRevision":7,"organizationMode":"balanced","providerMode":"byok","byokProvider":"openai","modelSelection":"gpt-5.6-terra","byokFallbackToApp":true,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let anthropicSettingsJSON = #"{"settingsRevision":9,"organizationMode":"cautious","providerMode":"byok","byokProvider":"anthropic","modelSelection":"claude-opus-5","byokFallbackToApp":false,"routingEffort":"thorough","expansionStyle":"detailed","timezone":"Europe/London","locale":"en-GB","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let byokSettingsResponseJSON = #"{"settings":\#(byokSettingsJSON)}"#
    private static let anthropicSettingsResponseJSON = #"{"settings":\#(anthropicSettingsJSON)}"#
    private static let updatedSettingsResponseJSON = #"{"settings":{"settingsRevision":5,"organizationMode":"cautious","providerMode":"app_default","byokProvider":null,"modelSelection":"auto","byokFallbackToApp":false,"routingEffort":"economical","expansionStyle":"detailed","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:01:00Z"},"replayed":false}"#
    private static let updatedSettingsSnapshotJSON = #"{"settings":{"settingsRevision":5,"organizationMode":"cautious","providerMode":"app_default","byokProvider":null,"modelSelection":"auto","byokFallbackToApp":false,"routingEffort":"economical","expansionStyle":"detailed","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:01:00Z"}}"#
    private static let providerKeyResponseJSON = #"{"providerKey":{"provider":"openai","lastFour":"7890","status":"active","credentialRevision":8,"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"}}"#
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
