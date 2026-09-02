import Foundation
import XCTest
@testable import Unfiled

final class APIClientTests: XCTestCase {
    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testOTPRequestNormalizesBodyAndDisablesCaching() async throws {
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/auth/otp")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Pragma"), "no-cache")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let object = try JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: String]
            XCTAssertEqual(object?["email"], "person@example.com")
            return apiResponse(for: request, status: 202,
                               json: #"{"accepted":true,"retryAfterSeconds":30}"#)
        }
        let response = try await makeStubbedAPIClient().requestOTP(email: " Person@Example.COM ")
        XCTAssertTrue(response.accepted)
        XCTAssertEqual(response.retryAfterSeconds, 30)
    }

    func testProtectedRequestRetriesOnceWithRefreshedBearer() async throws {
        let provider = APITokenProviderStub()
        let lock = NSLock()
        nonisolated(unsafe) var requestCount = 0
        APIURLProtocolStub.install { request in
            let count = lock.withLock { requestCount += 1; return requestCount }
            if count == 1 {
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
                return apiResponse(for: request, status: 401,
                                   json: #"{"code":"unauthorized","message":"no","requestId":"r1"}"#)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer new-token")
            return apiResponse(
                for: request,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#,
                privateNoStore: true
            )
        }
        let result = try await makeStubbedAPIClient(tokenProvider: provider).listNotes()
        XCTAssertTrue(result.items.isEmpty)
        let refreshCalls = await provider.refreshCalls
        XCTAssertEqual(refreshCalls, 1)
        XCTAssertEqual(requestCount, 2)
    }

    func testProtectedRequestNeverRetriesAcrossCredentialAccountBoundary() async throws {
        let provider = CrossAccountSwitchingTokenProviderStub()
        let lock = NSLock()
        nonisolated(unsafe) var requestCount = 0
        APIURLProtocolStub.install { request in
            lock.withLock { requestCount += 1 }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer profile-a-token")
            return apiResponse(
                for: request,
                status: 401,
                json: #"{"code":"unauthorized","message":"no","requestId":"r-account"}"#
            )
        }

        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient(tokenProvider: provider).listNotes()
        ) { error in
            XCTAssertEqual(error as? APIClientError, .authenticationRequired)
        }
        XCTAssertEqual(requestCount, 1, "Profile A's request must not be replayed with profile B's token")
    }

    func testRedirectDelegateRejectsFollowUpRequest() async throws {
        let delegate = RedirectRejectingSessionDelegate()
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://api.example.test/api/v1/notes")!)
        let redirect = URLRequest(url: URL(string: "https://attacker.example/collect")!)
        let response = try XCTUnwrap(
            HTTPURLResponse(
                url: task.originalRequest!.url!,
                statusCode: 307,
                httpVersion: "HTTP/1.1",
                headerFields: ["Location": redirect.url!.absoluteString]
            )
        )
        let completion = expectation(description: "redirect decision")
        let result = LockedRedirectResult()

        delegate.urlSession(
            session,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: redirect
        ) { request in
            result.set(request)
            completion.fulfill()
        }

        await fulfillment(of: [completion], timeout: 1)
        XCTAssertNil(result.value)
    }

    func testMutationSendsMatchingIdempotencyHeader() async throws {
        let provider = APITokenProviderStub()
        let note = try NoteID(validating: "note_00000000000000000000000000")
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/api/v1/notes/\(note.rawValue)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "idem-00000001")
            let object = try JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: Any]
            XCTAssertEqual(object?["expectedRevision"] as? Int, 3)
            XCTAssertEqual(object?["idempotencyKey"] as? String, "idem-00000001")
            return apiResponse(for: request, json: "{}")
        }
        do {
            _ = try await makeStubbedAPIClient(tokenProvider: provider).softDeleteNote(
                note, request: .init(expectedRevision: 3, idempotencyKey: "idem-00000001")
            )
            XCTFail("Expected an intentionally malformed fixture response")
        } catch APIClientError.malformedResponse(status: 200) {}
    }

    func testServerMessageAndDetailsAreNotExposedInTypedError() async throws {
        APIURLProtocolStub.install { request in
            apiResponse(for: request, status: 429,
                        json: #"{"code":"rate_limited","message":"secret upstream detail","requestId":"safe-id","retryAfterSeconds":9,"details":{"token":"never"}}"#)
        }
        do {
            _ = try await makeStubbedAPIClient().requestOTP(email: "a@b.com")
            XCTFail("Expected rejection")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .http(status: 429, code: .rateLimited,
                                         requestId: "safe-id", retryAfterSeconds: 9))
            XCTAssertFalse(String(describing: error).contains("secret upstream"))
            XCTAssertFalse(error.localizedDescription.contains("never"))
        }
    }

    func testRequestAndResponseLimitsFailClosed() async throws {
        APIURLProtocolStub.install { request in apiResponse(for: request, json: String(repeating: "x", count: 128)) }
        let requestLimited = try makeStubbedAPIClient(limits: .init(requestBodyBytes: 8, responseBodyBytes: 1_024))
        await XCTAssertThrowsErrorAsync(try await requestLimited.requestOTP(email: "long@example.com")) {
            XCTAssertEqual($0 as? APIClientError, .requestBodyTooLarge(limit: 8))
        }

        let responseLimited = try makeStubbedAPIClient(limits: .init(requestBodyBytes: 1_024, responseBodyBytes: 16))
        await XCTAssertThrowsErrorAsync(try await responseLimited.requestOTP(email: "a@b.com")) {
            XCTAssertEqual($0 as? APIClientError, .responseBodyTooLarge(limit: 16))
        }
    }

    func testPagedSearchKeepsPrivateQueryInAuthenticatedJSONBody() async throws {
        let provider = APITokenProviderStub()
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/search")
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Pragma"), "no-cache")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: Any]
            )
            XCTAssertEqual(object["query"] as? String, "a & b")
            XCTAssertEqual(object["archive"] as? String, "include")
            XCTAssertEqual(object["cursor"] as? String, "next/cursor")
            XCTAssertEqual(object["limit"] as? Int, 17)
            return apiResponse(
                for: request,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#,
                privateNoStore: true
            )
        }
        _ = try await makeStubbedAPIClient(tokenProvider: provider).searchNotes(
            .init(query: "a & b", archive: .include, cursor: "next/cursor", limit: 17)
        )
    }

    func testSearchLengthMatchesServerUTF16ContractUnits() async throws {
        let provider = APITokenProviderStub()
        let valid = String(repeating: "é", count: 200)
        APIURLProtocolStub.install { request in
            XCTAssertNil(request.url?.query)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: Any]
            )
            XCTAssertEqual(object["query"] as? String, valid)
            return apiResponse(
                for: request,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#,
                privateNoStore: true
            )
        }
        _ = try await makeStubbedAPIClient(tokenProvider: provider).searchNotes(.init(query: valid))

        let oversized = String(repeating: "é", count: 201)
        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient(tokenProvider: provider).searchNotes(.init(query: oversized))
        ) { XCTAssertEqual($0 as? APIClientError, .invalidRequest) }
    }

    func testSearchRejectsInvalidPagingBeforeTransport() async throws {
        let provider = APITokenProviderStub()
        let lock = NSLock()
        nonisolated(unsafe) var requestCount = 0
        APIURLProtocolStub.install { request in
            lock.withLock { requestCount += 1 }
            return apiResponse(
                for: request,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
            )
        }
        let client = try makeStubbedAPIClient(tokenProvider: provider)

        for invalid in [
            SearchNotesRequest(query: "valid", cursor: "", limit: 30),
            SearchNotesRequest(query: "valid", cursor: String(repeating: "c", count: 513), limit: 30),
            SearchNotesRequest(query: "valid", limit: 0),
            SearchNotesRequest(query: "valid", limit: 101)
        ] {
            await XCTAssertThrowsErrorAsync(try await client.searchNotes(invalid)) {
                XCTAssertEqual($0 as? APIClientError, .invalidRequest)
            }
        }

        XCTAssertEqual(lock.withLock { requestCount }, 0)
    }

    func testAccountDeletionCapabilityIsCanonicalAndAlwaysRedacted() throws {
        let token = try AccountDeletionToken(validating: "delete_\(String(repeating: "A", count: 43))")
        XCTAssertFalse(token.description.contains(token.rawValue))
        XCTAssertFalse(token.debugDescription.contains(token.rawValue))
        XCTAssertThrowsError(
            try AccountDeletionToken(validating: "delete_\(String(repeating: "B", count: 43))")
        )

        let generated = try AccountDeletionToken.generate()
        XCTAssertEqual(generated.rawValue.utf8.count, 50)
        XCTAssertNoThrow(try AccountDeletionToken(validating: generated.rawValue))
    }

    func testAccountDeleteAndReplayKeepCapabilityInBodyOnly() async throws {
        let provider = APITokenProviderStub()
        let token = try AccountDeletionToken(
            validating: "delete_\(String(repeating: "A", count: 43))"
        )
        let lock = NSLock()
        nonisolated(unsafe) var requestCount = 0
        APIURLProtocolStub.install { request in
            let count = lock.withLock { requestCount += 1; return requestCount }
            XCTAssertNil(request.url?.query)
            XCTAssertFalse(request.url?.absoluteString.contains(token.rawValue) == true)
            XCTAssertNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Pragma"), "no-cache")
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: String]
            )
            XCTAssertEqual(object["idempotencyKey"], token.rawValue)

            if count == 1 {
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.url?.path, "/api/v1/me")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
                XCTAssertEqual(object["confirmation"], "DELETE")
            } else {
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/api/v1/me/deletion-receipt")
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                XCTAssertNil(object["confirmation"])
            }
            return apiResponse(
                for: request,
                json: Self.accountDeletionReceiptJSON(replayed: count == 2),
                privateNoStore: true
            )
        }

        let client = try makeStubbedAPIClient(tokenProvider: provider)
        let deleted = try await client.deleteAccount(.init(idempotencyKey: token))
        let replayed = try await client.replayAccountDeletionReceipt(
            .init(idempotencyKey: token)
        )
        XCTAssertFalse(deleted.replayed)
        XCTAssertTrue(replayed.replayed)
        XCTAssertEqual(deleted.backupRetentionDays, 30)
        XCTAssertEqual(deleted.deletedRecordCounts["auth.sessions"], 2)
        XCTAssertEqual(requestCount, 2)
    }

    func testAccountExportUsesAuthenticatedPrivateStreamingTransport() async throws {
        let provider = APITokenProviderStub()
        let archive = Data([0x1F, 0x8B, 0x08, 0x00, 0x01, 0x02, 0x03])
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/v1/me/export")
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/gzip")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            let response = try XCTUnwrap(
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Cache-Control": "private, no-store",
                        "Content-Disposition": "attachment; filename=\"unfiled-export.tar.gz\"",
                        "Content-Type": "application/gzip",
                        "Pragma": "no-cache"
                    ]
                )
            )
            return (response, archive)
        }

        let stream = try await makeStubbedAPIClient(tokenProvider: provider).streamAccountExport()
        var received = Data()
        for try await chunk in stream { received.append(chunk) }
        XCTAssertEqual(received, archive)
    }

    func testTransportByteStreamPullsOnlyOneChunkPerConsumerDemandWithoutDataLoss() async throws {
        let source = BytePullProbe(bytes: (0 ..< 10).map(UInt8.init))
        let stream = makeDemandDrivenByteStream(
            iterator: BytePullProbeIterator(source: source),
            chunkBytes: 4,
            isCancelled: { false },
            onCancel: {}
        )

        var pullCount = await source.pullCount
        XCTAssertEqual(pullCount, 0, "Constructing the stream must not eagerly drain its source")

        var iterator = stream.makeAsyncIterator()
        let first = try await iterator.next()
        XCTAssertEqual(first, Data([0, 1, 2, 3]))
        pullCount = await source.pullCount
        XCTAssertEqual(pullCount, 4)

        let second = try await iterator.next()
        XCTAssertEqual(second, Data([4, 5, 6, 7]))
        pullCount = await source.pullCount
        XCTAssertEqual(pullCount, 8)

        let remainder = try await iterator.next()
        XCTAssertEqual(remainder, Data([8, 9]))
        pullCount = await source.pullCount
        XCTAssertEqual(pullCount, 11, "The final pull observes end-of-stream after two bytes")

        let completion = try await iterator.next()
        XCTAssertNil(completion)
        let pullsAfterCompletion = await source.pullCount
        XCTAssertEqual(pullsAfterCompletion, 11)
    }

    func testTransportByteStreamConsumerCancellationCancelsSourceAndSanitizesError() async {
        let source = BlockingBytePullProbe()
        let cancellation = LockedStreamCancellationProbe()
        let stream = makeDemandDrivenByteStream(
            iterator: BlockingBytePullProbeIterator(source: source),
            chunkBytes: 4,
            isCancelled: { cancellation.isCancelled },
            onCancel: { cancellation.cancel() }
        )
        let consumer = Task {
            var iterator = stream.makeAsyncIterator()
            return try await iterator.next()
        }

        await source.waitUntilStarted()
        consumer.cancel()

        await XCTAssertThrowsErrorAsync(try await consumer.value) { error in
            XCTAssertEqual(error as? APIClientError, .transportFailure)
        }
        XCTAssertTrue(cancellation.isCancelled)
        XCTAssertEqual(cancellation.cancelCount, 1)
    }

    func testAccountReceiptFailsClosedOnDishonestFlagsOrUnknownKeys() async throws {
        APIURLProtocolStub.install { request in
            apiResponse(
                for: request,
                json: Self.accountDeletionReceiptJSON(replayed: true)
                    .replacingOccurrences(of: #""sessionsRevoked":true"#, with: #""sessionsRevoked":false"#),
                privateNoStore: true
            )
        }
        let token = try AccountDeletionToken(
            validating: "delete_\(String(repeating: "A", count: 43))"
        )
        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient().replayAccountDeletionReceipt(
                .init(idempotencyKey: token)
            )
        ) { error in
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }
    }

    func testCreateNoteValidatesExactUTF16AndCollectionBoundsBeforeTransport() async throws {
        let provider = APITokenProviderStub()
        let client = try makeStubbedAPIClient(tokenProvider: provider)
        let emoji = "\u{1F642}"
        let exactTitle = String(repeating: emoji, count: 100)
        let exactBody = String(repeating: emoji, count: 100_000)
        let tag = try TagID(validating: "tag_00000000000000000000000000")
        let destination = try NoteID(validating: "note_00000000000000000000000000")
        let exactTags = Array(repeating: tag, count: 100)
        let exactLinks = Array(
            repeating: NoteLinkValue(toNoteId: destination, linkType: .reference),
            count: 100
        )
        let lock = NSLock()
        nonisolated(unsafe) var requestCount = 0

        APIURLProtocolStub.install { request in
            lock.withLock { requestCount += 1 }
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/notes")
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: Any]
            )
            let title = try XCTUnwrap(object["title"] as? String)
            let body = try XCTUnwrap(object["bodyMarkdown"] as? String)
            XCTAssertEqual(
                title.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count,
                200
            )
            XCTAssertEqual(body.utf16.count, 200_000)
            XCTAssertEqual((object["tagIds"] as? [String])?.count, 100)
            XCTAssertEqual((object["links"] as? [[String: Any]])?.count, 100)
            return apiResponse(for: request, json: "{}")
        }

        do {
            _ = try await client.createNote(
                .init(
                    idempotencyKey: "create-boundary",
                    title: " \(exactTitle) ",
                    type: .generic,
                    bodyMarkdown: exactBody,
                    tagIds: exactTags,
                    links: exactLinks
                )
            )
            XCTFail("The deliberately incomplete response should not decode")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .malformedResponse(status: 200))
        }
        XCTAssertEqual(lock.withLock { requestCount }, 1)

        let invalidRequests = [
            NoteCreateRequest(
                idempotencyKey: "title-overflow",
                title: String(repeating: emoji, count: 101),
                type: .generic
            ),
            NoteCreateRequest(
                idempotencyKey: "body-overflow",
                title: "Valid",
                type: .generic,
                bodyMarkdown: String(repeating: emoji, count: 100_001)
            ),
            NoteCreateRequest(
                idempotencyKey: "tag-overflow",
                title: "Valid",
                type: .generic,
                tagIds: Array(repeating: tag, count: 101)
            ),
            NoteCreateRequest(
                idempotencyKey: "link-overflow",
                title: "Valid",
                type: .generic,
                links: Array(repeating: exactLinks[0], count: 101)
            )
        ]
        for request in invalidRequests {
            await XCTAssertThrowsErrorAsync(try await client.createNote(request)) {
                XCTAssertEqual($0 as? APIClientError, .invalidRequest)
            }
        }
        XCTAssertEqual(lock.withLock { requestCount }, 1)
    }

    func testUpdateNoteValidatesExactUTF16CollectionsAndRevisionBeforeTransport() async throws {
        let provider = APITokenProviderStub()
        let client = try makeStubbedAPIClient(tokenProvider: provider)
        let noteID = try NoteID(validating: "note_00000000000000000000000000")
        let tag = try TagID(validating: "tag_00000000000000000000000000")
        let link = NoteLinkValue(toNoteId: noteID, linkType: .related)
        let emoji = "\u{1F642}"
        let exactTitle = String(repeating: emoji, count: 100)
        let exactBody = String(repeating: emoji, count: 100_000)
        let lock = NSLock()
        nonisolated(unsafe) var requestCount = 0

        APIURLProtocolStub.install { request in
            lock.withLock { requestCount += 1 }
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.url?.path, "/api/v1/notes/\(noteID.rawValue)")
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: Any]
            )
            let title = try XCTUnwrap(object["title"] as? String)
            let body = try XCTUnwrap(object["bodyMarkdown"] as? String)
            XCTAssertEqual(
                title.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count,
                200
            )
            XCTAssertEqual(body.utf16.count, 200_000)
            XCTAssertEqual((object["tagIds"] as? [String])?.count, 100)
            XCTAssertEqual((object["links"] as? [[String: Any]])?.count, 100)
            return apiResponse(for: request, json: "{}")
        }

        do {
            _ = try await client.updateNote(
                noteID,
                request: try .init(
                    expectedRevision: 1,
                    idempotencyKey: "update-boundary",
                    title: .value(" \(exactTitle) "),
                    bodyMarkdown: .value(exactBody),
                    tagIds: .value(Array(repeating: tag, count: 100)),
                    links: .value(Array(repeating: link, count: 100))
                )
            )
            XCTFail("The deliberately incomplete response should not decode")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .malformedResponse(status: 200))
        }
        XCTAssertEqual(lock.withLock { requestCount }, 1)

        let invalidRequests: [NoteUpdateRequest] = [
            try .init(
                expectedRevision: 1,
                idempotencyKey: "title-overflow",
                title: .value(String(repeating: emoji, count: 101))
            ),
            try .init(
                expectedRevision: 1,
                idempotencyKey: "body-overflow",
                bodyMarkdown: .value(String(repeating: emoji, count: 100_001))
            ),
            try .init(
                expectedRevision: 0,
                idempotencyKey: "revision-invalid",
                title: .value("Valid")
            ),
            try .init(
                expectedRevision: 1,
                idempotencyKey: "tag-overflow",
                tagIds: .value(Array(repeating: tag, count: 101))
            ),
            try .init(
                expectedRevision: 1,
                idempotencyKey: "link-overflow",
                links: .value(Array(repeating: link, count: 101))
            ),
            try .init(
                expectedRevision: 1,
                idempotencyKey: "title-null",
                title: .null
            ),
            try .init(
                expectedRevision: 1,
                idempotencyKey: "body-null",
                bodyMarkdown: .null
            ),
            try .init(
                expectedRevision: 1,
                idempotencyKey: "tags-null",
                tagIds: .null
            ),
            try .init(
                expectedRevision: 1,
                idempotencyKey: "links-null",
                links: .null
            )
        ]
        for request in invalidRequests {
            await XCTAssertThrowsErrorAsync(try await client.updateNote(noteID, request: request)) {
                XCTAssertEqual($0 as? APIClientError, .invalidRequest)
            }
        }
        XCTAssertEqual(lock.withLock { requestCount }, 1)
    }

    func testInvalidIdempotencyKeyAndInsecureRemoteHTTPFailBeforeNetwork() async throws {
        XCTAssertThrowsError(try APIClient(baseURL: URL(string: "http://api.example.test/api/v1")!)) {
            XCTAssertEqual($0 as? APIClientError, .invalidConfiguration)
        }
        XCTAssertNoThrow(try APIClient(baseURL: URL(string: "http://localhost:8787/api/v1")!))

        let provider = APITokenProviderStub()
        let note = try NoteID(validating: "note_00000000000000000000000000")
        APIURLProtocolStub.install { _ in
            XCTFail("Invalid key must not reach transport")
            throw URLError(.badURL)
        }
        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient(tokenProvider: provider).softDeleteNote(
                note, request: .init(expectedRevision: 1, idempotencyKey: "contains space")
            )
        ) { XCTAssertEqual($0 as? APIClientError, .invalidRequest) }
    }

    func testAppConfigurationRequiresExactVersionedAPIBasePath() throws {
        let secure = try AppConfiguration.validated(
            apiBaseURLString: "https://api.example.test/api/v1/",
            bundleIdentifier: "app.unfiled.test"
        )
        XCTAssertEqual(secure.apiBaseURL.absoluteString, "https://api.example.test/api/v1")

        let loopback = try AppConfiguration.validated(
            apiBaseURLString: "http://127.0.0.1:3000/api/v1",
            bundleIdentifier: "app.unfiled.test"
        )
        XCTAssertEqual(loopback.apiBaseURL.path, "/api/v1")

        for invalid in [
            "https://api.example.test",
            "https://api.example.test/api/v2",
            "https://api.example.test/api/v1/notes",
            "https://user:secret@api.example.test/api/v1",
            "https://api.example.test/api/v1?tenant=other",
            "http://api.example.test/api/v1"
        ] {
            XCTAssertThrowsError(
                try AppConfiguration.validated(
                    apiBaseURLString: invalid,
                    bundleIdentifier: "app.unfiled.test"
                )
            ) { error in
                XCTAssertEqual(error as? AppConfigurationError, .invalidAPIBaseURL, invalid)
            }
        }
    }

    func testAPIClientRejectsUnversionedOrAmbiguousBaseURLs() throws {
        for invalid in [
            "https://api.example.test",
            "https://api.example.test/api/v10",
            "https://api.example.test/api/v1/search",
            "https://api.example.test/api/v1#fragment",
            "https://api.example.test/api/v1?source=test"
        ] {
            XCTAssertThrowsError(try APIClient(baseURL: URL(string: invalid)!)) { error in
                XCTAssertEqual(error as? APIClientError, .invalidConfiguration, invalid)
            }
        }

        let client = try APIClient(baseURL: URL(string: "https://api.example.test/api/v1/")!)
        XCTAssertEqual(client.baseURL.absoluteString, "https://api.example.test/api/v1")
    }

    private static func accountDeletionReceiptJSON(replayed: Bool) -> String {
        """
        {"backupExpiresAt":"2026-09-30T20:00:00.000Z","backupRetentionDays":30,"deletedAt":"2026-08-31T20:00:00.000Z","deletedRecordCounts":{"auth.sessions":2,"public.notes":17},"liveDataDeleted":true,"receiptExpiresAt":"2026-10-01T20:00:00.000Z","reRegistrationStartsFresh":true,"replayed":\(replayed),"schemaVersion":1,"sessionsRevoked":true}
        """
    }
}

private actor CrossAccountSwitchingTokenProviderStub: AccessTokenProviding {
    func accessTokenCredential() -> AccessTokenCredential {
        AccessTokenCredential(
            token: "profile-a-token",
            userID: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            sessionGeneration: 7
        )
    }

    func refreshAfterUnauthorized(
        rejectedCredential _: AccessTokenCredential
    ) -> AccessTokenCredential {
        AccessTokenCredential(
            token: "profile-b-token",
            userID: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!,
            sessionGeneration: 8
        )
    }
}

private final class LockedRedirectResult: @unchecked Sendable {
    private let lock = NSLock()
    private var request: URLRequest?

    var value: URLRequest? { lock.withLock { request } }

    func set(_ request: URLRequest?) {
        lock.withLock { self.request = request }
    }
}

private actor BytePullProbe {
    private let bytes: [UInt8]
    private var index = 0
    private(set) var pullCount = 0

    init(bytes: [UInt8]) { self.bytes = bytes }

    func nextByte() -> UInt8? {
        pullCount += 1
        guard index < bytes.count else { return nil }
        defer { index += 1 }
        return bytes[index]
    }
}

private struct BytePullProbeIterator: AsyncIteratorProtocol, Sendable {
    let source: BytePullProbe

    mutating func next() async throws -> UInt8? { await source.nextByte() }
}

private actor BlockingBytePullProbe {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func nextByte() async throws -> UInt8? {
        if !started {
            started = true
            let waiters = startWaiters
            startWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
        }
        try await Task.sleep(nanoseconds: 60_000_000_000)
        return nil
    }
}

private struct BlockingBytePullProbeIterator: AsyncIteratorProtocol, Sendable {
    let source: BlockingBytePullProbe

    mutating func next() async throws -> UInt8? { try await source.nextByte() }
}

private final class LockedStreamCancellationProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var cancellations = 0

    var isCancelled: Bool { lock.withLock { cancelled } }
    var cancelCount: Int { lock.withLock { cancellations } }

    func cancel() {
        lock.withLock {
            cancelled = true
            cancellations += 1
        }
    }
}

private func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T,
                                           _ verify: (Error) -> Void,
                                           file: StaticString = #filePath, line: UInt = #line) async {
    do { _ = try await expression(); XCTFail("Expected error", file: file, line: line) }
    catch { verify(error) }
}
