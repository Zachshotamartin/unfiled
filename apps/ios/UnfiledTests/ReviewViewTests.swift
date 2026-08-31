import XCTest
@testable import Unfiled

@MainActor
final class ReviewViewTests: XCTestCase {
    private let item = ReviewPresentation(
        id: "rvw_01",
        original: "Roosevelt method: tell people you can do it, then figure it out.",
        proposedDestination: "Mindset / Principles",
        actionSummary: "Add as a principle",
        captureID: "cap_01",
        noteID: "nte_01"
    )

    func testQueueSummaryUsesReadableCounts() {
        XCTAssertEqual(ReviewQueueSummary(count: 0).label, "Nothing awaiting review")
        XCTAssertEqual(ReviewQueueSummary(count: 1).label, "1 item awaiting review")
        XCTAssertEqual(ReviewQueueSummary(count: 4).label, "4 items awaiting review")
    }

    func testOpenNavigationHasStableAccessibilityIdentifier() {
        XCTAssertEqual(
            ReviewNavigation.identifier(for: item.id),
            "review.openNote.rvw_01"
        )
    }

    func testReviewViewCanBeConstructedWithReadOnlyNavigation() {
        var openedNoteIDs: [String] = []
        _ = ReviewView(
            items: [item],
            isLoading: false,
            onOpenRelatedNote: { openedNoteIDs.append($0) }
        )
        XCTAssertTrue(openedNoteIDs.isEmpty)
    }
}
