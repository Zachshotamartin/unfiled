import XCTest
@testable import Unfiled

@MainActor
final class SearchViewTests: XCTestCase {
    func testSearchRequestNormalizesOuterWhitespaceAndPreservesArchiveScope() {
        let request = SearchRequest(
            query: "  Roosevelt method  \n",
            includesArchived: true
        )

        XCTAssertEqual(request.query, "Roosevelt method")
        XCTAssertTrue(request.includesArchived)
        XCTAssertTrue(request.hasQuery)
    }

    func testWhitespaceOnlyRequestHasNoQuery() {
        let request = SearchRequest(query: " \n\t ", includesArchived: false)

        XCTAssertEqual(request.query, "")
        XCTAssertFalse(request.hasQuery)
    }

    func testArchiveScopeParticipatesInDebounceIdentity() {
        let activeOnly = SearchRequest(query: "shopping", includesArchived: false)
        let includingArchived = SearchRequest(query: "shopping", includesArchived: true)

        XCTAssertNotEqual(activeOnly, includingArchived)
    }

    func testDebouncerDispatchesNormalizedRequest() async {
        let request = SearchRequest(query: "  push workout ", includesArchived: false)
        var received: SearchRequest?

        await SearchQueryDebouncer.dispatch(request: request, delay: .zero) {
            received = $0
        }

        XCTAssertEqual(received, SearchRequest(query: "push workout", includesArchived: false))
    }

    func testDebouncerDoesNotDispatchCancelledRequest() async {
        let request = SearchRequest(query: "mindset", includesArchived: false)
        var received: SearchRequest?

        let pending = Task { @MainActor in
            await SearchQueryDebouncer.dispatch(request: request, delay: .seconds(5)) {
                received = $0
            }
        }

        await Task.yield()
        pending.cancel()
        await pending.value

        XCTAssertNil(received)
    }

    func testClearingQueryDispatchesImmediately() async {
        let request = SearchRequest(query: "", includesArchived: true)
        var received: SearchRequest?

        await SearchQueryDebouncer.dispatch(request: request, delay: .seconds(5)) {
            received = $0
        }

        XCTAssertEqual(received, request)
    }
}
