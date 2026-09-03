import Foundation
import XCTest
@testable import Unfiled

final class NoteContextViewTests: XCTestCase {
    func testSourcePaginationMergesUniqueRevisionBoundPages() throws {
        let first = try sourcePage(indices: [1, 2], nextCursor: "source-page-two")
        let second = try sourcePage(indices: [3], nextCursor: nil)

        var state = try NoteSourcesPaginationState(
            first: first,
            boundRevision: 9,
            pageLimit: 2
        )
        try state.append(second, after: "source-page-two")

        XCTAssertEqual(state.boundRevision, 9)
        XCTAssertEqual(state.items.count, 3)
        XCTAssertEqual(state.pageCount, 2)
        XCTAssertNil(state.nextCursor)
        XCTAssertFalse(state.canLoadMore)
    }

    func testSourcePaginationRejectsDuplicateWithoutMutatingVisibleItems() throws {
        let first = try sourcePage(indices: [1, 2], nextCursor: "source-page-two")
        let replay = try sourcePage(indices: [2], nextCursor: nil)
        var state = try NoteSourcesPaginationState(
            first: first,
            boundRevision: 4,
            pageLimit: 2
        )

        XCTAssertThrowsError(try state.append(replay, after: "source-page-two")) { error in
            XCTAssertEqual(error as? NoteContextPaginationError, .duplicateItemIdentifier)
        }
        XCTAssertEqual(state.items.count, 2)
        XCTAssertEqual(state.pageCount, 1)
        XCTAssertEqual(state.nextCursor, "source-page-two")
    }

    func testBacklinkPaginationRejectsWrongOrReplayedCursor() throws {
        let first = try backlinkPage(indices: [1], nextCursor: "backlink-page-two")
        let second = try backlinkPage(indices: [2], nextCursor: nil)
        var state = try NoteBacklinksPaginationState(
            first: first,
            boundRevision: 3,
            pageLimit: 1
        )

        XCTAssertThrowsError(try state.append(second, after: "wrong-cursor")) { error in
            XCTAssertEqual(error as? NoteContextPaginationError, .unexpectedPage)
        }
        try state.append(second, after: "backlink-page-two")
        XCTAssertThrowsError(try state.append(second, after: "backlink-page-two"))
        XCTAssertEqual(state.items.count, 2)
        XCTAssertEqual(state.pageCount, 2)
    }

    func testPaginationRejectsInconsistentPageInfoAndOversizedPage() throws {
        let inconsistent = try sourcePage(
            indices: [1],
            nextCursor: "unexpected",
            hasMore: false
        )
        XCTAssertThrowsError(
            try NoteSourcesPaginationState(
                first: inconsistent,
                boundRevision: 1,
                pageLimit: 1
            )
        ) { error in
            XCTAssertEqual(error as? NoteContextPaginationError, .inconsistentPageInfo)
        }

        let oversized = try backlinkPage(indices: [1, 2], nextCursor: nil)
        XCTAssertThrowsError(
            try NoteBacklinksPaginationState(
                first: oversized,
                boundRevision: 1,
                pageLimit: 1
            )
        ) { error in
            XCTAssertEqual(error as? NoteContextPaginationError, .pageLimitExceeded)
        }
    }

    func testOfflineAndDeletedFailuresUseContentFreeRecoveryCopy() {
        XCTAssertEqual(NoteContextFailure.offline.glyph, .warning)
        XCTAssertEqual(
            NoteContextFailure.offline.message,
            "Reconnect to load this private note context."
        )
        XCTAssertEqual(
            NoteContextFailure.deleted.message,
            "Sources and backlinks were removed from this screen."
        )
    }

    private func sourcePage(
        indices: [Int],
        nextCursor: String?,
        hasMore: Bool? = nil,
        removed: Bool = false
    ) throws -> NoteSourcesResponse {
        let items: String = indices.map { index -> String in
            let suffix = identifierSuffix(index)
            let relation = removed ? "source_removed" : "routed"
            return """
            {"captureId":"cap_\(suffix)","mutationId":"mut_\(suffix)","relation":"\(relation)","rawContent":"private capture \(index)","source":"mobile","clientCreatedAt":"2026-09-01T12:00:00Z","insertedItemIds":[],"createdAt":"2026-09-01T12:00:01Z"}
            """
        }.joined(separator: ",")
        return try decodePage(
            items: items,
            nextCursor: nextCursor,
            hasMore: hasMore ?? (nextCursor != nil),
            as: NoteSourcesResponse.self
        )
    }

    private func backlinkPage(
        indices: [Int],
        nextCursor: String?,
        hasMore: Bool? = nil
    ) throws -> NoteBacklinksResponse {
        let items: String = indices.map { index -> String in
            let suffix = identifierSuffix(index)
            return """
            {"linkId":"lnk_\(suffix)","fromNoteId":"note_\(suffix)","fromTitle":"Linked note \(index)","linkType":"reference","createdAt":"2026-09-01T12:00:00Z"}
            """
        }.joined(separator: ",")
        return try decodePage(
            items: items,
            nextCursor: nextCursor,
            hasMore: hasMore ?? (nextCursor != nil),
            as: NoteBacklinksResponse.self
        )
    }

    private func decodePage<Response: Decodable>(
        items: String,
        nextCursor: String?,
        hasMore: Bool,
        as _: Response.Type
    ) throws -> Response {
        let cursor = nextCursor.map { "\"\($0)\"" } ?? "null"
        let json = """
        {"items":[\(items)],"pageInfo":{"hasMore":\(hasMore),"nextCursor":\(cursor)}}
        """
        return try APIJSON.makeDecoder().decode(Response.self, from: Data(json.utf8))
    }

    private func identifierSuffix(_ index: Int) -> String {
        String(repeating: "0", count: 24) + String(format: "%02d", index)
    }
}
