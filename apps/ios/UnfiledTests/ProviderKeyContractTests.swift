import Foundation
import XCTest
@testable import Unfiled

/// Per-provider credential lifecycle: independent metadata loads, put and delete with idempotency
/// and compare-and-set, stale revisions, ambiguous retries, replacement, and deletion.
final class ProviderKeyContractTests: XCTestCase {
    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    // MARK: Metadata

    func testProviderKeyMetadataLoadsIndependentlyPerProvider() async throws {
        let tokenProvider = APITokenProviderStub()
        let lock = NSLock()
        nonisolated(unsafe) var queries: [String] = []
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/v1/me/provider-key")
            let query = request.url?.query ?? ""
            lock.withLock { queries.append(query) }
            let json = query == "provider=openai"
                ? Self.metadataResponseJSON(provider: .openai, lastFour: "7890", revision: 8)
                : #"{"providerKey":null}"#
            return apiResponse(for: request, json: json, privateNoStore: true)
        }

        let client = try makeStubbedAPIClient(tokenProvider: tokenProvider)
        let openAI = try await client.getProviderKeyMetadata(provider: .openai)
        let anthropic = try await client.getProviderKeyMetadata(provider: .anthropic)

        XCTAssertEqual(openAI.providerKey?.provider, .openai)
        XCTAssertEqual(openAI.providerKey?.lastFour, "7890")
        XCTAssertEqual(openAI.providerKey?.credentialRevision, 8)
        XCTAssertNil(anthropic.providerKey, "An absent Claude key does not depend on the OpenAI key")
        XCTAssertEqual(lock.withLock { queries }, ["provider=openai", "provider=anthropic"])
    }

    func testProviderKeyMetadataRejectsAnotherProvidersRecord() async throws {
        let tokenProvider = APITokenProviderStub()
        APIURLProtocolStub.install { request in
            apiResponse(
                for: request,
                json: Self.metadataResponseJSON(provider: .openai, lastFour: "7890", revision: 8),
                privateNoStore: true
            )
        }

        await XCTAssertProviderKeyThrowsAsync(
            try await makeStubbedAPIClient(tokenProvider: tokenProvider)
                .getProviderKeyMetadata(provider: .anthropic)
        ) { error in
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }
    }

    // MARK: Put

    func testProviderPutPerProviderCarriesIdempotencyAndCredentialCAS() async throws {
        let cases: [(provider: AIProvider, expectedRevision: Int?, key: String)] = [
            (.openai, nil, Self.syntheticProviderKey("openai-000000000007890")),
            (.anthropic, 3, Self.syntheticProviderKey("anthropic-00000004321"))
        ]
        for testCase in cases {
            let tokenProvider = APITokenProviderStub()
            let idempotencyKey = "provider-put-\(testCase.provider.rawValue)"
            let responseRevision = (testCase.expectedRevision ?? 0) + 1
            let request = try ProviderKeyPutRequest(
                idempotencyKey: idempotencyKey,
                provider: testCase.provider,
                expectedCredentialRevision: testCase.expectedRevision,
                apiKey: testCase.key
            )
            APIURLProtocolStub.install { urlRequest in
                XCTAssertEqual(urlRequest.httpMethod, "PUT")
                XCTAssertEqual(urlRequest.url?.path, "/api/v1/me/provider-key")
                XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Idempotency-Key"), idempotencyKey)
                let body = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: apiRequestBody(urlRequest)) as? [String: Any]
                )
                XCTAssertEqual(body["idempotencyKey"] as? String, idempotencyKey)
                XCTAssertEqual(body["provider"] as? String, testCase.provider.rawValue)
                if let expectedRevision = testCase.expectedRevision {
                    XCTAssertEqual(body["expectedCredentialRevision"] as? Int, expectedRevision)
                } else {
                    XCTAssertTrue(body["expectedCredentialRevision"] is NSNull)
                }
                XCTAssertEqual(Set(body.keys), ["idempotencyKey", "provider", "expectedCredentialRevision", "apiKey"])
                return apiResponse(
                    for: urlRequest,
                    json: Self.putResponseJSON(
                        provider: testCase.provider,
                        lastFour: String(testCase.key.suffix(4)),
                        revision: responseRevision
                    ),
                    privateNoStore: true
                )
            }

            let response = try await makeStubbedAPIClient(tokenProvider: tokenProvider)
                .putProviderKey(request)
            XCTAssertEqual(response.providerKey.provider, testCase.provider)
            XCTAssertTrue(
                AISettingsMutationContract.accepts(
                    response,
                    provider: testCase.provider,
                    expectedCredentialRevision: testCase.expectedRevision,
                    submittedKey: testCase.key
                )
            )
            XCTAssertFalse(
                AISettingsMutationContract.accepts(
                    response,
                    provider: testCase.provider == .openai ? .anthropic : .openai,
                    expectedCredentialRevision: testCase.expectedRevision,
                    submittedKey: testCase.key
                ),
                "A receipt for one provider never satisfies a save for the other"
            )
        }
    }

    func testProviderPutRejectsReceiptForAnotherProvider() async throws {
        let tokenProvider = APITokenProviderStub()
        let key = Self.syntheticProviderKey("anthropic-00000004321")
        let request = try ProviderKeyPutRequest(
            idempotencyKey: "provider-put-mismatch",
            provider: .anthropic,
            expectedCredentialRevision: nil,
            apiKey: key
        )
        APIURLProtocolStub.install { urlRequest in
            apiResponse(
                for: urlRequest,
                json: Self.putResponseJSON(provider: .openai, lastFour: "4321", revision: 1),
                privateNoStore: true
            )
        }

        await XCTAssertProviderKeyThrowsAsync(
            try await makeStubbedAPIClient(tokenProvider: tokenProvider).putProviderKey(request)
        ) { error in
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }
    }

    func testProviderPutMutationChecksRevisionStatusValidationAndLastFour() throws {
        let secret = Self.syntheticProviderKey("12345678901234567890")
        let decoder = APIJSON.makeDecoder()
        let validJSON = Self.putResponseJSON(provider: .openai, lastFour: "7890", revision: 8)
        let valid = try decoder.decode(ProviderKeyPutResponse.self, from: Data(validJSON.utf8))
        XCTAssertTrue(
            AISettingsMutationContract.accepts(
                valid,
                provider: .openai,
                expectedCredentialRevision: 7,
                submittedKey: secret
            )
        )

        let invalidStatus = try decoder.decode(
            ProviderKeyPutResponse.self,
            from: Data(validJSON.replacingOccurrences(
                of: #""status":"active""#,
                with: #""status":"invalid""#
            ).utf8)
        )
        XCTAssertFalse(
            AISettingsMutationContract.accepts(
                invalidStatus,
                provider: .openai,
                expectedCredentialRevision: 7,
                submittedKey: secret
            )
        )
        XCTAssertFalse(
            AISettingsMutationContract.accepts(
                valid,
                provider: .openai,
                expectedCredentialRevision: 6,
                submittedKey: secret
            ),
            "A stale expected revision cannot claim a receipt two revisions ahead"
        )
        XCTAssertFalse(
            AISettingsMutationContract.accepts(
                valid,
                provider: .openai,
                expectedCredentialRevision: 7,
                submittedKey: Self.syntheticProviderKey("12345678901234561111")
            ),
            "An idempotent replay must not bind old last-four metadata to a changed key body"
        )
        XCTAssertTrue(
            AISettingsMutationContract.accepts(
                valid,
                provider: .openai,
                expectedCredentialRevision: nil,
                submittedKey: secret
            ),
            "A create after deletion uses the owner's monotonic counter and need not restart at one"
        )
    }

    // MARK: Ambiguous retry and replacement

    func testAmbiguousRetryReusesCoordinatesForTheSameProviderWithoutRetainingTheKey() throws {
        let key = Self.syntheticProviderKey("anthropic-00000004321")
        var issuedKeys = 0
        let first = ProviderKeyRetryContract.coordinates(
            resuming: nil,
            provider: .anthropic,
            currentCredentialRevision: 3
        ) {
            issuedKeys += 1
            return "provider-retry-\(issuedKeys)"
        }
        XCTAssertEqual(first.provider, .anthropic)
        XCTAssertEqual(first.expectedCredentialRevision, 3)
        XCTAssertEqual(first.idempotencyKey, "provider-retry-1")

        let resumed = ProviderKeyRetryContract.coordinates(
            resuming: first,
            provider: .anthropic,
            currentCredentialRevision: 4
        ) {
            issuedKeys += 1
            return "provider-retry-\(issuedKeys)"
        }
        XCTAssertEqual(resumed, first, "A retry keeps the original idempotency key and CAS revision")
        XCTAssertEqual(issuedKeys, 1)

        let firstBody = try Self.jsonObject(first.makeRequest(apiKey: key))
        let retryBody = try Self.jsonObject(resumed.makeRequest(apiKey: key))
        XCTAssertEqual(firstBody["idempotencyKey"] as? String, "provider-retry-1")
        XCTAssertEqual(retryBody["idempotencyKey"] as? String, "provider-retry-1")
        XCTAssertEqual(retryBody["expectedCredentialRevision"] as? Int, 3)
        XCTAssertEqual(retryBody["apiKey"] as? String, key)

        let retained = Mirror(reflecting: first).children.map { child in
            "\(child.label ?? "")=\(child.value)"
        }
        XCTAssertFalse(retained.joined().contains(key), "Coordinates never hold key material")
        XCTAssertEqual(
            Set(Mirror(reflecting: first).children.compactMap(\.label)),
            ["provider", "expectedCredentialRevision", "idempotencyKey"]
        )
        XCTAssertFalse(String(describing: first).contains(key))
        XCTAssertFalse(String(reflecting: first).contains(key))

        XCTAssertTrue(ProviderKeyRetryContract.permitsSave(pending: nil, provider: .openai))
        XCTAssertTrue(ProviderKeyRetryContract.permitsSave(pending: first, provider: .anthropic))
        XCTAssertFalse(
            ProviderKeyRetryContract.permitsSave(pending: first, provider: .openai),
            "The other provider waits until the ambiguous Claude save is resolved or discarded"
        )
    }

    func testReplacementUsesCurrentRevisionAndAcceptsOnlyTheNextOne() throws {
        let key = Self.syntheticProviderKey("openai-000000000007890")
        let replacement = ProviderKeyRetryContract.coordinates(
            resuming: nil,
            provider: .openai,
            currentCredentialRevision: 8
        ) { "provider-replace-1" }
        let body = try Self.jsonObject(replacement.makeRequest(apiKey: key))
        XCTAssertEqual(body["expectedCredentialRevision"] as? Int, 8)

        let decoder = APIJSON.makeDecoder()
        let next = try decoder.decode(
            ProviderKeyPutResponse.self,
            from: Data(Self.putResponseJSON(provider: .openai, lastFour: "7890", revision: 9).utf8)
        )
        let same = try decoder.decode(
            ProviderKeyPutResponse.self,
            from: Data(Self.putResponseJSON(provider: .openai, lastFour: "7890", revision: 8).utf8)
        )
        XCTAssertTrue(
            AISettingsMutationContract.accepts(
                next,
                provider: .openai,
                expectedCredentialRevision: replacement.expectedCredentialRevision,
                submittedKey: key
            )
        )
        XCTAssertFalse(
            AISettingsMutationContract.accepts(
                same,
                provider: .openai,
                expectedCredentialRevision: replacement.expectedCredentialRevision,
                submittedKey: key
            ),
            "A replacement must advance the credential revision"
        )
    }

    // MARK: Delete

    func testProviderDeletePerProviderUsesCredentialCASAndStrictConfirmation() async throws {
        for provider in AIProvider.allCases {
            let tokenProvider = APITokenProviderStub()
            let idempotencyKey = "provider-delete-\(provider.rawValue)"
            let request = try ProviderKeyDeleteRequest(
                idempotencyKey: idempotencyKey,
                provider: provider,
                expectedCredentialRevision: 8
            )
            APIURLProtocolStub.install { urlRequest in
                XCTAssertEqual(urlRequest.httpMethod, "DELETE")
                XCTAssertEqual(urlRequest.url?.path, "/api/v1/me/provider-key")
                XCTAssertNil(urlRequest.url?.query)
                XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Idempotency-Key"), idempotencyKey)
                let body = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: apiRequestBody(urlRequest)) as? [String: Any]
                )
                XCTAssertEqual(body["provider"] as? String, provider.rawValue)
                XCTAssertEqual(body["expectedCredentialRevision"] as? Int, 8)
                XCTAssertEqual(Set(body.keys), ["idempotencyKey", "provider", "expectedCredentialRevision"])
                return apiResponse(
                    for: urlRequest,
                    json: Self.deleteResponseJSON(provider: provider, revision: 8),
                    privateNoStore: true
                )
            }

            let response = try await makeStubbedAPIClient(tokenProvider: tokenProvider)
                .deleteProviderKey(request)
            XCTAssertTrue(
                AISettingsMutationContract.accepts(
                    response,
                    provider: provider,
                    expectedCredentialRevision: 8
                )
            )
            XCTAssertFalse(
                AISettingsMutationContract.accepts(
                    response,
                    provider: provider,
                    expectedCredentialRevision: 7
                )
            )
            XCTAssertFalse(
                AISettingsMutationContract.accepts(
                    response,
                    provider: provider == .openai ? .anthropic : .openai,
                    expectedCredentialRevision: 8
                )
            )
        }
        XCTAssertThrowsError(
            try ProviderKeyDeleteRequest(
                idempotencyKey: "provider-delete-invalid",
                provider: .openai,
                expectedCredentialRevision: 0
            )
        )
    }

    func testProviderDeleteRejectsReceiptForAnotherProviderOrUnconfirmedDeletion() async throws {
        let tokenProvider = APITokenProviderStub()
        let request = try ProviderKeyDeleteRequest(
            idempotencyKey: "provider-delete-mismatch",
            provider: .anthropic,
            expectedCredentialRevision: 2
        )
        APIURLProtocolStub.install { urlRequest in
            apiResponse(
                for: urlRequest,
                json: Self.deleteResponseJSON(provider: .openai, revision: 2),
                privateNoStore: true
            )
        }
        await XCTAssertProviderKeyThrowsAsync(
            try await makeStubbedAPIClient(tokenProvider: tokenProvider).deleteProviderKey(request)
        ) { error in
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }

        XCTAssertThrowsError(
            try APIJSON.makeDecoder().decode(
                ProviderKeyDeleteResponse.self,
                from: Data(Self.deleteResponseJSON(provider: .anthropic, revision: 2)
                    .replacingOccurrences(of: #""deleted":true"#, with: #""deleted":false"#).utf8)
            )
        )
    }

    // MARK: Failure copy

    func testStaleRevisionAndInvalidKeyMessagesNameTheProviderActedOn() {
        let requestID = "req-" + Self.syntheticProviderKey("must-not-leak-0000000")
        let stale = APIClientError.http(
            status: 409,
            code: .staleRevision,
            requestId: requestID,
            retryAfterSeconds: nil
        )
        let invalid = APIClientError.http(
            status: 422,
            code: .providerKeyInvalid,
            requestId: requestID,
            retryAfterSeconds: nil
        )

        let claudeStale = AppModel.providerKeyFailureMessage(stale, provider: .anthropic, action: .save)
        XCTAssertEqual(claudeStale, "The Claude key changed on another device. Its latest status is shown.")
        XCTAssertFalse(claudeStale.contains("OpenAI"))
        XCTAssertFalse(claudeStale.contains(requestID))

        let openAIStale = AppModel.providerKeyFailureMessage(stale, provider: .openai, action: .delete)
        XCTAssertEqual(openAIStale, "The OpenAI key changed on another device. Its latest status is shown.")

        let claudeInvalid = AppModel.providerKeyFailureMessage(invalid, provider: .anthropic, action: .save)
        XCTAssertEqual(
            claudeInvalid,
            "Claude did not accept that key. Nothing was stored; check the key and try again."
        )
        XCTAssertEqual(
            AppModel.providerKeyFailureMessage(invalid, provider: .openai, action: .save),
            "OpenAI did not accept that key. Nothing was stored; check the key and try again."
        )
        XCTAssertEqual(
            AppModel.providerKeyFailureMessage(URLError(.timedOut), provider: .anthropic, action: .delete),
            "The Claude key was not deleted. Refresh its status and try again."
        )
        XCTAssertEqual(
            AppModel.providerKeyFailureMessage(
                APIClientError.transportFailure,
                provider: .openai,
                action: .save
            ),
            "The save could not be confirmed. Key status was refreshed; paste the key again only if needed."
        )
    }

    // MARK: Fixtures

    private static func syntheticProviderKey(_ suffix: String) -> String {
        "s" + "k-test-" + suffix
    }

    private static func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIJSON.makeEncoder().encode(value))
                as? [String: Any]
        )
    }

    private static func metadataResponseJSON(
        provider: AIProvider,
        lastFour: String,
        revision: Int
    ) -> String {
        #"{"providerKey":{"provider":"\#(provider.rawValue)","lastFour":"\#(lastFour)","status":"active","credentialRevision":\#(revision),"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"}}"#
    }

    private static func putResponseJSON(
        provider: AIProvider,
        lastFour: String,
        revision: Int
    ) -> String {
        #"{"providerKey":{"provider":"\#(provider.rawValue)","lastFour":"\#(lastFour)","status":"active","credentialRevision":\#(revision),"validatedAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:01Z"},"replayed":false}"#
    }

    private static func deleteResponseJSON(provider: AIProvider, revision: Int) -> String {
        #"{"provider":"\#(provider.rawValue)","deleted":true,"deletedCredentialRevision":\#(revision),"replayed":false}"#
    }
}

private func XCTAssertProviderKeyThrowsAsync<T>(
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
