import XCTest
@testable import Unfiled

/// Open Review pushes a page for the item; it never bounces back to the Inbox.
@MainActor
final class ReviewNavigationTests: XCTestCase {
    private func makeModel() -> AppModel {
        let defaults = UserDefaults(suiteName: "ReviewNavigationTests.\(UUID().uuidString)")!
        return AppModel(bundle: Bundle(for: ReviewNavigationTests.self), userDefaults: defaults)
    }

    func testShowReviewPushesThePageForTheItem() {
        let model = makeModel()
        model.navigationPath = [.settings]
        model.showReview(reviewID: "rvw_01TEST")
        XCTAssertEqual(model.navigationPath, [.settings, .review("rvw_01TEST")])
        XCTAssertEqual(model.requestedReviewFocusID, "rvw_01TEST")
    }

    func testShowReviewDoesNotPushTheSamePageTwice() {
        let model = makeModel()
        model.showReview(reviewID: "rvw_01TEST")
        model.showReview(reviewID: "rvw_01TEST")
        XCTAssertEqual(model.navigationPath, [.review("rvw_01TEST")])
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
