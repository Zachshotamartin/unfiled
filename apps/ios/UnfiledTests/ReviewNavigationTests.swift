import XCTest
@testable import Unfiled

/// Open Review pushes a page for the item; it never bounces back to the Inbox.
@MainActor
final class ReviewNavigationTests: XCTestCase {
    private func makeModel() -> AppModel {
        let defaults = UserDefaults(suiteName: "ReviewNavigationTests.\(UUID().uuidString)")!
        return AppModel(bundle: Bundle(for: ReviewNavigationTests.self), userDefaults: defaults)
    }

    /// An open review item, as the server would have listed it.
    private func openItem(_ id: String) -> ReviewPresentation {
        ReviewPresentation(
            id: id,
            type: .lowConfidence,
            original: "Test capture",
            proposedDestination: "Errands",
            actionSummary: "Low-confidence destination",
            captureID: "cap_00000000000000000000000000",
            noteID: nil,
            duplicateExplanation: nil,
            generatedBlock: nil,
            suggestedDestinations: [],
            suggestedNewNote: nil,
            relatedNotes: [],
            allowedActions: [.create, .dismiss]
        )
    }

    func testShowReviewPushesThePageForTheItem() {
        let model = makeModel()
        model.seedReviewItemsForTesting([openItem("rvw_01TEST")])
        model.navigationPath = [.settings]
        model.showReview(reviewID: "rvw_01TEST")
        XCTAssertEqual(model.navigationPath, [.settings, .review("rvw_01TEST")])
        XCTAssertEqual(model.requestedReviewFocusID, "rvw_01TEST")
    }

    func testShowReviewDoesNotPushTheSamePageTwice() {
        let model = makeModel()
        model.seedReviewItemsForTesting([openItem("rvw_01TEST")])
        model.showReview(reviewID: "rvw_01TEST")
        model.showReview(reviewID: "rvw_01TEST")
        XCTAssertEqual(model.navigationPath, [.review("rvw_01TEST")])
    }

    /// A review that was resolved or dismissed has no page: Open Review explains instead.
    func testShowReviewForAClosedReviewNeverPushesAPage() {
        let model = makeModel()
        model.seedReviewItemsForTesting([openItem("rvw_01OTHER")])
        model.showReview(reviewID: "rvw_01CLOSED")
        XCTAssertEqual(model.navigationPath, [])
        XCTAssertEqual(model.bannerMessage, ReviewClosedCopy.receiptLine)
    }

    func testShowReviewWithoutAnItemReturnsToTheInbox() {
        let model = makeModel()
        model.navigationPath = [.settings, .review("rvw_01TEST")]
        model.selectedTab = .library
        model.showReview()
        XCTAssertEqual(model.navigationPath, [])
        XCTAssertEqual(model.selectedTab, .inbox)
        XCTAssertNil(model.requestedReviewFocusID)
    }

    func testCloseReviewPagePopsOnlyItsOwnPage() {
        let model = makeModel()
        model.navigationPath = [.settings, .review("rvw_01TEST")]
        model.closeReviewPage(reviewID: "rvw_01OTHER")
        XCTAssertEqual(model.navigationPath, [.settings, .review("rvw_01TEST")])
        model.closeReviewPage(reviewID: "rvw_01TEST")
        XCTAssertEqual(model.navigationPath, [.settings])
        model.closeReviewPage(reviewID: "rvw_01TEST")
        XCTAssertEqual(model.navigationPath, [.settings])
    }
}
