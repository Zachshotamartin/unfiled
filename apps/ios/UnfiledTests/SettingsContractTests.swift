import Foundation
import XCTest
@testable import Unfiled

final class SettingsContractTests: XCTestCase {
    private static var syntheticProviderKey: String {
        String(repeating: "k", count: 24)
    }

    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testSettingsDecodeEveryProviderAndModelCombinationInTheRegistry() throws {
        let decoder = APIJSON.makeDecoder()
        let openAI = try decoder.decode(
            UserSettingsResponse.self,
            from: Data(Self.settingsResponseJSON.utf8)
        )
        XCTAssertEqual(openAI.settings.byokProvider, .openai)
        XCTAssertEqual(openAI.settings.modelSelection, .automatic)

        for provider in AIProvider.allCases {
            for model in AIModelRegistry.selections(for: provider) {
                let json = Self.byokSettingsJSON(provider: provider, model: model)
                let settings = try decoder.decode(UserSettings.self, from: Data(json.utf8))
                XCTAssertEqual(settings.byokProvider, provider)
                XCTAssertEqual(settings.modelSelection, model)
            }
        }
    }

    func testSettingsRejectMissingUnknownAndCrossProviderModelSelection() throws {
        let decoder = APIJSON.makeDecoder()

        let missingModel = Self.settingsJSON.replacingOccurrences(
            of: #""modelSelection":"auto","#,
            with: ""
        )
        XCTAssertFalse(missingModel.contains("modelSelection"))
        XCTAssertThrowsError(
            try decoder.decode(UserSettings.self, from: Data(missingModel.utf8)),
            "modelSelection is a required field of the settings DTO"
        )

        let unknownModel = Self.settingsJSON.replacingOccurrences(
            of: #""modelSelection":"auto""#,
            with: #""modelSelection":"gpt-6-nova""#
        )
        XCTAssertThrowsError(try decoder.decode(UserSettings.self, from: Data(unknownModel.utf8)))

        let claudeOnOpenAI = Self.byokSettingsJSON(provider: .openai, model: .claudeOpus5)
        XCTAssertThrowsError(try decoder.decode(UserSettings.self, from: Data(claudeOnOpenAI.utf8)))

        let gptOnAnthropic = Self.byokSettingsJSON(provider: .anthropic, model: .gpt56Luna)
        XCTAssertThrowsError(try decoder.decode(UserSettings.self, from: Data(gptOnAnthropic.utf8)))

        let exactModelInAppDefault = Self.appDefaultSettingsJSON.replacingOccurrences(
            of: #""modelSelection":"auto""#,
            with: #""modelSelection":"claude-sonnet-5""#
        )
        XCTAssertThrowsError(
            try decoder.decode(UserSettings.self, from: Data(exactModelInAppDefault.utf8))
        )
    }

    func testSettingsRequireCoherentProviderSelectionAndExactKeys() throws {
        let decoder = APIJSON.makeDecoder()
        XCTAssertNoThrow(try decoder.decode(UserSettingsResponse.self, from: Data(Self.settingsResponseJSON.utf8)))

        let missingProvider = Self.settingsResponseJSON.replacingOccurrences(
            of: #""providerMode":"byok","byokProvider":"openai""#,
            with: #""providerMode":"byok","byokProvider":null"#
        )
        XCTAssertThrowsError(try decoder.decode(UserSettingsResponse.self, from: Data(missingProvider.utf8)))

        let unexpectedProvider = Self.settingsResponseJSON.replacingOccurrences(
            of: #""providerMode":"byok","byokProvider":"openai""#,
            with: #""providerMode":"app_default","byokProvider":"openai""#
        )
        XCTAssertThrowsError(try decoder.decode(UserSettingsResponse.self, from: Data(unexpectedProvider.utf8)))

        let invalidFallback = Self.appDefaultSettingsJSON.replacingOccurrences(
            of: #""byokFallbackToApp":false"#,
            with: #""byokFallbackToApp":true"#
        )
        XCTAssertThrowsError(
            try decoder.decode(
                UserSettings.self,
                from: Data(invalidFallback.utf8)
            )
        )

        let unknownKey = Self.settingsResponseJSON.dropLast() + #", "apiKey":"must-not-appear"}"#
        XCTAssertThrowsError(try decoder.decode(UserSettingsResponse.self, from: Data(unknownKey.utf8)))
    }

    func testSettingsMutationsRejectIncoherentProviderChangesAndInvalidIdempotency() {
        XCTAssertThrowsError(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-invalid-provider",
                providerMode: .appDefault,
                byokProvider: .value(.openai)
            )
        )
        XCTAssertThrowsError(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-invalid-byok",
                providerMode: .byok,
                byokProvider: .null
            )
        )
        XCTAssertThrowsError(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-invalid-fallback",
                byokProvider: .null,
                byokFallbackToApp: true
            )
        )
        XCTAssertThrowsError(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "contains spaces",
                routingEffort: .standard
            )
        )
        XCTAssertThrowsError(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-invalid-model-provider",
                byokProvider: .value(.anthropic),
                modelSelection: .gpt56Sol
            )
        )
        XCTAssertNoThrow(
            try UserSettingsUpdateRequest(
                expectedSettingsRevision: 1,
                idempotencyKey: "settings-model-only",
                modelSelection: .claudeOpus5
            ),
            "A model-only patch is validated against the stored provider by the server"
        )
    }

    func testProviderMetadataResponseCannotContainCredentialMaterial() throws {
        let decoder = APIJSON.makeDecoder()
        for provider in AIProvider.allCases {
            let valid = Self.metadataResponseJSON(provider: provider)
            let response = try decoder.decode(ProviderKeyResponse.self, from: Data(valid.utf8))
            XCTAssertEqual(response.providerKey?.provider, provider)
            XCTAssertEqual(response.providerKey?.lastFour, "1234")

            let leakedKey = valid.replacingOccurrences(
                of: #""lastFour":"1234""#,
                with: #""lastFour":"1234","apiKey":"sk-secret-value-that-must-never-return""#
            )
            let leakedCiphertext = valid.replacingOccurrences(
                of: #""lastFour":"1234""#,
                with: #""lastFour":"1234","encryptedApiKey":"ciphertext""#
            )
            let invalidRevision = valid.replacingOccurrences(
                of: #""credentialRevision":1"#,
                with: #""credentialRevision":0"#
            )
            let unvalidatedActive = valid.replacingOccurrences(
                of: #""validatedAt":"2026-09-01T12:00:00Z""#,
                with: #""validatedAt":null"#
            )
            XCTAssertThrowsError(try decoder.decode(ProviderKeyResponse.self, from: Data(leakedKey.utf8)))
            XCTAssertThrowsError(try decoder.decode(ProviderKeyResponse.self, from: Data(leakedCiphertext.utf8)))
            XCTAssertThrowsError(try decoder.decode(ProviderKeyResponse.self, from: Data(invalidRevision.utf8)))
            XCTAssertThrowsError(try decoder.decode(ProviderKeyResponse.self, from: Data(unvalidatedActive.utf8)))
        }

        let absent = try decoder.decode(
            ProviderKeyResponse.self,
            from: Data(#"{"providerKey":null}"#.utf8)
        )
        XCTAssertNil(absent.providerKey)
        XCTAssertThrowsError(
            try decoder.decode(ProviderKeyResponse.self, from: Data("{}".utf8)),
            "providerKey must be present, even when null"
        )
    }

    func testProviderPutRequiresAuthenticationBeforeTransport() async throws {
        let lock = NSLock()
        nonisolated(unsafe) var requestCount = 0
        APIURLProtocolStub.install { request in
            lock.withLock { requestCount += 1 }
            return apiResponse(for: request, json: "{}")
        }
        let request = try ProviderKeyPutRequest(
            idempotencyKey: "provider-put-1",
            provider: .openai,
            expectedCredentialRevision: nil,
            apiKey: Self.syntheticProviderKey
        )

        await XCTAssertSettingsThrowsAsync(
            try await makeStubbedAPIClient().putProviderKey(request)
        ) { error in
            XCTAssertEqual(error as? APIClientError, .authenticationRequired)
        }
        XCTAssertEqual(lock.withLock { requestCount }, 0)
    }

    func testProviderPutUsesProtectedRouteAndReturnsMetadataOnly() async throws {
        let provider = APITokenProviderStub()
        let secret = Self.syntheticProviderKey
        let request = try ProviderKeyPutRequest(
            idempotencyKey: "provider-put-1",
            provider: .anthropic,
            expectedCredentialRevision: nil,
            apiKey: secret
        )
        APIURLProtocolStub.install { urlRequest in
            XCTAssertEqual(urlRequest.httpMethod, "PUT")
            XCTAssertEqual(urlRequest.url?.path, "/api/v1/me/provider-key")
            XCTAssertNil(urlRequest.url?.query)
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Idempotency-Key"), "provider-put-1")
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            let body = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(urlRequest)) as? [String: Any]
            )
            XCTAssertEqual(body["apiKey"] as? String, secret)
            XCTAssertEqual(body["provider"] as? String, "anthropic")
            XCTAssertTrue(body["expectedCredentialRevision"] is NSNull)
            return apiResponse(
                for: urlRequest,
                json: Self.providerPutResponseJSON,
                privateNoStore: true
            )
        }

        let response = try await makeStubbedAPIClient(tokenProvider: provider).putProviderKey(request)
        XCTAssertEqual(response.providerKey.provider, .anthropic)
        XCTAssertEqual(response.providerKey.lastFour, "kkkk")
        XCTAssertEqual(response.providerKey.status, .active)
        XCTAssertFalse(response.replayed)
        XCTAssertFalse(String(describing: response).contains(secret))
    }

    func testSettingsUpdateUsesAuthIdempotencyAndSparsePatch() async throws {
        let provider = APITokenProviderStub()
        let request = try UserSettingsUpdateRequest(
            expectedSettingsRevision: 3,
            idempotencyKey: "settings-update-1",
            providerMode: .appDefault,
            byokProvider: .null,
            expansionStyle: .brief
        )
        APIURLProtocolStub.install { urlRequest in
            XCTAssertEqual(urlRequest.httpMethod, "PATCH")
            XCTAssertEqual(urlRequest.url?.path, "/api/v1/me/settings")
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Idempotency-Key"), "settings-update-1")
            let body = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(urlRequest)) as? [String: Any]
            )
            XCTAssertEqual(body["expectedSettingsRevision"] as? Int, 3)
            XCTAssertEqual(body["providerMode"] as? String, "app_default")
            XCTAssertTrue(body["byokProvider"] is NSNull)
            XCTAssertNil(body["organizationMode"])
            XCTAssertNil(body["modelSelection"])
            return apiResponse(
                for: urlRequest,
                json: #"{"settings":\#(Self.appDefaultSettingsJSON),"replayed":false}"#,
                privateNoStore: true
            )
        }
        let response = try await makeStubbedAPIClient(tokenProvider: provider).updateUserSettings(request)
        XCTAssertEqual(response.settings.providerMode, .appDefault)
        XCTAssertNil(response.settings.byokProvider)
        XCTAssertEqual(response.settings.modelSelection, .automatic)
    }

    private static func byokSettingsJSON(provider: AIProvider, model: AIModelSelection) -> String {
        #"{"settingsRevision":3,"organizationMode":"balanced","providerMode":"byok","byokProvider":"\#(provider.rawValue)","modelSelection":"\#(model.rawValue)","byokFallbackToApp":false,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    }

    private static func metadataResponseJSON(provider: AIProvider) -> String {
        #"{"providerKey":{"provider":"\#(provider.rawValue)","lastFour":"1234","status":"active","credentialRevision":1,"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"}}"#
    }

    private static let settingsJSON = #"{"settingsRevision":3,"organizationMode":"balanced","providerMode":"byok","byokProvider":"openai","modelSelection":"auto","byokFallbackToApp":false,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let appDefaultSettingsJSON = #"{"settingsRevision":4,"organizationMode":"balanced","providerMode":"app_default","byokProvider":null,"modelSelection":"auto","byokFallbackToApp":false,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:01Z"}"#
    private static let settingsResponseJSON = #"{"settings":\#(settingsJSON)}"#
    private static let providerPutResponseJSON = #"{"providerKey":{"provider":"anthropic","lastFour":"kkkk","status":"active","credentialRevision":1,"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"},"replayed":false}"#
}

private func XCTAssertSettingsThrowsAsync<T>(
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
