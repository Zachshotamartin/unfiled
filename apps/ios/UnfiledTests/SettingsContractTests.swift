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
    }

    func testProviderMetadataResponseCannotContainCredentialMaterial() throws {
        let decoder = APIJSON.makeDecoder()
        let valid = #"{"providerKey":{"provider":"openai","lastFour":"1234","status":"active","credentialRevision":1,"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"}}"#
        let response = try decoder.decode(ProviderKeyResponse.self, from: Data(valid.utf8))
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
            provider: .openai,
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
            XCTAssertEqual(body["provider"] as? String, "openai")
            XCTAssertTrue(body["expectedCredentialRevision"] is NSNull)
            return apiResponse(
                for: urlRequest,
                json: Self.providerPutResponseJSON,
                privateNoStore: true
            )
        }

        let response = try await makeStubbedAPIClient(tokenProvider: provider).putProviderKey(request)
        XCTAssertEqual(response.providerKey.lastFour, "7890")
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
            return apiResponse(
                for: urlRequest,
                json: #"{"settings":\#(Self.appDefaultSettingsJSON),"replayed":false}"#,
                privateNoStore: true
            )
        }
        let response = try await makeStubbedAPIClient(tokenProvider: provider).updateUserSettings(request)
        XCTAssertEqual(response.settings.providerMode, .appDefault)
        XCTAssertNil(response.settings.byokProvider)
    }

    private static let settingsJSON = #"{"settingsRevision":3,"organizationMode":"balanced","providerMode":"byok","byokProvider":"openai","byokFallbackToApp":false,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:00Z"}"#
    private static let appDefaultSettingsJSON = #"{"settingsRevision":4,"organizationMode":"balanced","providerMode":"app_default","byokProvider":null,"byokFallbackToApp":false,"routingEffort":"standard","expansionStyle":"brief","timezone":"America/Los_Angeles","locale":"en-US","updatedAt":"2026-09-01T12:00:01Z"}"#
    private static let settingsResponseJSON = #"{"settings":\#(settingsJSON)}"#
    private static let providerPutResponseJSON = #"{"providerKey":{"provider":"openai","lastFour":"7890","status":"active","credentialRevision":1,"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"},"replayed":false}"#
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
