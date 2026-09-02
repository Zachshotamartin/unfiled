import Foundation
import XCTest
@testable import Unfiled

final class SearchAndNoteContextContractTests: XCTestCase {
    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testExtendedSearchFiltersStayInAuthenticatedJSONBody() async throws {
        let provider = APITokenProviderStub()
        let space = try SpaceID(validating: "spc_00000000000000000000000000")
        let tagA = try TagID(validating: "tag_00000000000000000000000000")
        let tagB = try TagID(validating: "tag_11111111111111111111111111")
        let from = try XCTUnwrap(APIJSON.parseDate("2026-08-01T00:00:00Z"))
        let to = try XCTUnwrap(APIJSON.parseDate("2026-09-01T00:00:00Z"))
        let request = SearchNotesRequest(
            query: " training ",
            archive: .include,
            type: .log,
            space: .space(space),
            tagIds: [tagA, tagB],
            updatedFrom: from,
            updatedTo: to,
            privacy: .privateManual,
            cursor: "next-cursor",
            limit: 25
        )
        APIURLProtocolStub.install { urlRequest in
            XCTAssertEqual(urlRequest.httpMethod, "POST")
            XCTAssertEqual(urlRequest.url?.path, "/api/v1/search")
            XCTAssertNil(urlRequest.url?.query)
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            let body = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(urlRequest)) as? [String: Any]
            )
            XCTAssertEqual(body["query"] as? String, "training")
            XCTAssertEqual(body["archive"] as? String, "include")
            XCTAssertEqual(body["type"] as? String, "log")
            XCTAssertEqual(body["spaceId"] as? String, space.rawValue)
            XCTAssertEqual(body["tagIds"] as? [String], [tagA.rawValue, tagB.rawValue])
            XCTAssertEqual(body["updatedFrom"] as? String, APIJSON.dateString(from))
            XCTAssertEqual(body["updatedTo"] as? String, APIJSON.dateString(to))
            XCTAssertEqual(body["privacy"] as? String, "private_manual")
            XCTAssertEqual(body["cursor"] as? String, "next-cursor")
            XCTAssertEqual(body["limit"] as? Int, 25)
            return apiResponse(
                for: urlRequest,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#,
                privateNoStore: true
            )
        }
        _ = try await makeStubbedAPIClient(tokenProvider: provider).searchNotes(request)
    }

    func testSearchRootIsExplicitNullWhileAnyOmitsSpaceAndEmptyTags() throws {
        let encoder = APIJSON.makeEncoder()
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: encoder.encode(SearchNotesRequest(query: "one", space: .root))
            ) as? [String: Any]
        )
        XCTAssertTrue(root["spaceId"] is NSNull)
        XCTAssertNil(root["tagIds"])

        let any = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: encoder.encode(SearchNotesRequest(query: "one", space: .any))
            ) as? [String: Any]
        )
        XCTAssertNil(any["spaceId"])
        XCTAssertNil(any["tagIds"])
    }

    func testSearchRejectsDuplicateTagsAndInvalidDateRangeBeforeTransport() async throws {
        let provider = APITokenProviderStub()
        let tag = try TagID(validating: "tag_00000000000000000000000000")
        let from = try XCTUnwrap(APIJSON.parseDate("2026-09-01T00:00:00Z"))
        let to = try XCTUnwrap(APIJSON.parseDate("2026-08-01T00:00:00Z"))
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

        await XCTAssertSearchThrowsAsync(
            try await client.searchNotes(SearchNotesRequest(query: "one", tagIds: [tag, tag]))
        ) { XCTAssertEqual($0 as? APIClientError, .invalidRequest) }
        await XCTAssertSearchThrowsAsync(
            try await client.searchNotes(
                SearchNotesRequest(query: "one", updatedFrom: from, updatedTo: to)
            )
        ) { XCTAssertEqual($0 as? APIClientError, .invalidRequest) }
        XCTAssertEqual(lock.withLock { requestCount }, 0)
    }

    func testLogFieldOperationRoundTripsAndRejectsLooseOrInvalidPaths() throws {
        let entry = try EntryID(validating: "ent_00000000000000000000000000")
        let operation = try UpdateLogFieldOperation(
            entryId: entry,
            fieldPath: ["workout", "sets"],
            value: .number(4)
        )
        let wrapped = InteractiveOperation.updateLogField(operation)
        let data = try APIJSON.makeEncoder().encode(wrapped)
        XCTAssertEqual(
            try APIJSON.makeDecoder().decode(InteractiveOperation.self, from: data),
            wrapped
        )
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["type"] as? String, "update_log_field")
        XCTAssertEqual(body["fieldPath"] as? [String], ["workout", "sets"])
        XCTAssertEqual(body["value"] as? Double, 4)

        XCTAssertThrowsError(
            try UpdateLogFieldOperation(entryId: entry, fieldPath: [], value: .string("x"))
        )
        let unknown = #"{"type":"update_log_field","entryId":"ent_00000000000000000000000000","fieldPath":["sets"],"value":4,"plaintext":"leak"}"#
        XCTAssertThrowsError(
            try APIJSON.makeDecoder().decode(
                InteractiveOperation.self,
                from: Data(unknown.utf8)
            )
        )
    }

    func testApplyOperationsCarriesLogFieldUnionAndIdempotency() async throws {
        let provider = APITokenProviderStub()
        let note = try NoteID(validating: "note_00000000000000000000000000")
        let entry = try EntryID(validating: "ent_00000000000000000000000000")
        let operation = try UpdateLogFieldOperation(
            entryId: entry,
            fieldPath: ["durationMinutes"],
            value: .number(45)
        )
        let request = InteractiveOperationsRequest(
            expectedRevision: 2,
            idempotencyKey: "log-update-1",
            operations: [.updateLogField(operation)]
        )
        APIURLProtocolStub.install { urlRequest in
            XCTAssertEqual(urlRequest.httpMethod, "POST")
            XCTAssertEqual(urlRequest.url?.path, "/api/v1/notes/\(note.rawValue)/operations")
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Idempotency-Key"), "log-update-1")
            let body = try XCTUnwrap(
                JSONSerialization.jsonObject(with: apiRequestBody(urlRequest)) as? [String: Any]
            )
            let operations = try XCTUnwrap(body["operations"] as? [[String: Any]])
            XCTAssertEqual(operations.first?["type"] as? String, "update_log_field")
            return apiResponse(for: urlRequest, json: "{}")
        }
        do {
            _ = try await makeStubbedAPIClient(tokenProvider: provider)
                .applyNoteOperations(note, request: request)
            XCTFail("Expected intentionally incomplete MutationResult fixture")
        } catch APIClientError.malformedResponse(status: 200) {}
    }

    func testNoteSourceAndBacklinkResponsesDecodeStrictly() throws {
        let decoder = APIJSON.makeDecoder()
        let sources = #"{"items":[{"captureId":"cap_00000000000000000000000000","mutationId":"mut_00000000000000000000000000","relation":"routed","rawContent":"ran five kilometers","source":"mobile","clientCreatedAt":"2026-09-01T11:59:00Z","insertedItemIds":["ent_00000000000000000000000000"],"createdAt":"2026-09-01T12:00:00Z"}],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
        let backlinks = #"{"items":[{"linkId":"lnk_00000000000000000000000000","fromNoteId":"note_11111111111111111111111111","fromTitle":"September plan","linkType":"related","createdAt":"2026-09-01T12:00:00Z"}],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
        let sourceResponse = try decoder.decode(NoteSourcesResponse.self, from: Data(sources.utf8))
        XCTAssertEqual(sourceResponse.items.first?.rawContent, "ran five kilometers")
        let backlinkResponse = try decoder.decode(NoteBacklinksResponse.self, from: Data(backlinks.utf8))
        XCTAssertEqual(backlinkResponse.items.first?.fromTitle, "September plan")

        let leakedSource = sources.replacingOccurrences(
            of: #""rawContent":"ran five kilometers""#,
            with: #""rawContent":"ran five kilometers","rawEmbedding":[1,2,3]"#
        )
        XCTAssertThrowsError(
            try decoder.decode(NoteSourcesResponse.self, from: Data(leakedSource.utf8))
        )
        let blankTitle = backlinks.replacingOccurrences(
            of: #""fromTitle":"September plan""#,
            with: #""fromTitle":"""#
        )
        XCTAssertThrowsError(
            try decoder.decode(NoteBacklinksResponse.self, from: Data(blankTitle.utf8))
        )
    }

    func testNoteSourceAndBacklinkRoutesUseBoundedPrivatePagination() async throws {
        let provider = APITokenProviderStub()
        let note = try NoteID(validating: "note_00000000000000000000000000")
        let client = try makeStubbedAPIClient(tokenProvider: provider)
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/v1/notes/\(note.rawValue)/sources")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query?.first(where: { $0.name == "limit" })?.value, "17")
            XCTAssertEqual(query?.first(where: { $0.name == "cursor" })?.value, "source-cursor")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            return apiResponse(
                for: request,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#,
                privateNoStore: true
            )
        }
        _ = try await client.listNoteSources(
            note,
            query: .init(cursor: "source-cursor", limit: 17)
        )

        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/v1/notes/\(note.rawValue)/backlinks")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query?.first(where: { $0.name == "limit" })?.value, "19")
            XCTAssertEqual(query?.first(where: { $0.name == "cursor" })?.value, "backlink-cursor")
            return apiResponse(
                for: request,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#,
                privateNoStore: true
            )
        }
        _ = try await client.listNoteBacklinks(
            note,
            query: .init(cursor: "backlink-cursor", limit: 19)
        )
    }

    func testNoteContextRejectsCacheablePlaintextResponses() async throws {
        let provider = APITokenProviderStub()
        let note = try NoteID(validating: "note_00000000000000000000000000")
        APIURLProtocolStub.install { request in
            apiResponse(
                for: request,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
            )
        }

        await XCTAssertSearchThrowsAsync(
            try await makeStubbedAPIClient(tokenProvider: provider).listNoteSources(note)
        ) { error in
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }
    }
}

private func XCTAssertSearchThrowsAsync<T>(
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
