import XCTest
@testable import Unfiled

/// The Inbox shows only what needs the owner; filed captures are notes in the Library.
final class InboxAttentionTests: XCTestCase {
    private func receipt(
        id: String,
        outcome: CaptureReceiptOutcome?,
        pending: Bool = false,
        retryable: Bool = false,
        reviewItemID: String? = nil
    ) -> ReceiptPresentation {
        ReceiptPresentation(
            id: id, category: "x", time: "1M", headline: "x", original: "text", outcome: outcome,
            destinationNoteID: nil, destinationTitle: nil, reviewItemID: reviewItemID,
            insertedContent: [], actions: [], pending: pending, retryable: retryable
        )
    }

    func testFiledCapturesNeverAppear() {
        XCTAssertFalse(InboxAttention.needsYou(receipt(id: "a", outcome: .createdNote)))
        XCTAssertFalse(InboxAttention.needsYou(receipt(id: "b", outcome: .addedToNote)))
        XCTAssertFalse(InboxAttention.needsYou(receipt(id: "c", outcome: .keptInInbox)))
    }

    func testOrganizingFailedAndReviewCapturesAppear() {
        XCTAssertTrue(InboxAttention.needsYou(receipt(id: "a", outcome: nil, pending: true)))
        XCTAssertTrue(InboxAttention.needsYou(receipt(id: "b", outcome: nil, retryable: true)))
        XCTAssertTrue(InboxAttention.needsYou(receipt(id: "c", outcome: .needsReview, reviewItemID: "rvw_1")))
    }

    func testAnOpenReviewIsRepresentedByItsCardNotARow() {
        let open = receipt(id: "a", outcome: .needsReview, reviewItemID: "rvw_open")
        let closed = receipt(id: "b", outcome: .needsReview, reviewItemID: "rvw_closed")
        let rows = InboxAttention.rows([open, closed], openReviewIDs: ["rvw_open"])
        XCTAssertEqual(rows.map(\.id), ["b"])
    }

    /// While the first refresh runs it is not known that nothing waits, so the Inbox says so.
    func testEmptyInboxSaysCheckingWhileLoading() {
        XCTAssertEqual(InboxAttention.emptyCopy(isLoading: true), "Checking what needs you.")
        XCTAssertEqual(InboxAttention.summary(waitingCount: 0, isLoading: true), "Checking")
        XCTAssertEqual(
            InboxAttention.emptyCopy(isLoading: false),
            "Nothing waiting. Everything you wrote is filed in your Library."
        )
        XCTAssertEqual(InboxAttention.summary(waitingCount: 0, isLoading: false), "0 waiting")
        XCTAssertEqual(InboxAttention.summary(waitingCount: 2, isLoading: true), "2 waiting")
    }

    func testReasonCopyIsPlainAndDeduplicated() {
        let reasons = ReviewReasonCopy.sentences(for: ["warmup", "no_candidate_fit", "warmup", "unknown_code"])
        XCTAssertEqual(reasons, [
            "Your first few captures always come to you first.",
            "None of your notes fit this."
        ])
        XCTAssertEqual(ReviewReasonCopy.sentences(for: []), [])
    }

    func testGuidanceIsTrimmedBoundedAndBlankMeansNone() {
        XCTAssertNil(CaptureCreateRequest.normalizedGuidance(nil))
        XCTAssertNil(CaptureCreateRequest.normalizedGuidance("   \n"))
        XCTAssertEqual(CaptureCreateRequest.normalizedGuidance("  with the plumber  "), "with the plumber")
        XCTAssertEqual(CaptureCreateRequest.normalizedGuidance(String(repeating: "x", count: 600))?.count, 500)
    }
}
