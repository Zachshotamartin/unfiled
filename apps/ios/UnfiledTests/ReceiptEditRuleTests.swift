import XCTest
@testable import Unfiled

/// Edit text is offered exactly for captures that are waiting on a retry or a review.
final class ReceiptEditRuleTests: XCTestCase {
    private func receipt(
        pending: Bool = false,
        retryable: Bool = false,
        outcome: CaptureReceiptOutcome? = nil
    ) -> ReceiptPresentation {
        ReceiptPresentation(
            id: "cap_01TEST",
            category: "Saved",
            time: "NOW",
            headline: "Saved",
            original: "A thought",
            outcome: outcome,
            destinationNoteID: nil,
            destinationTitle: nil,
            reviewItemID: nil,
            insertedContent: [],
            actions: [],
            pending: pending,
            retryable: retryable
        )
    }

    func testFailedCaptureCanBeEdited() {
        XCTAssertTrue(receipt(retryable: true).canEditText)
    }

    func testReviewCaptureCanBeEdited() {
        XCTAssertTrue(receipt(outcome: .needsReview).canEditText)
    }

    func testPendingCaptureCannotBeEdited() {
        XCTAssertFalse(receipt(pending: true, retryable: true).canEditText)
    }

    func testFiledCaptureCannotBeEdited() {
        XCTAssertFalse(receipt(outcome: .createdNote).canEditText)
        XCTAssertFalse(receipt(outcome: .addedToNote).canEditText)
        XCTAssertFalse(receipt(outcome: .keptInInbox).canEditText)
        XCTAssertFalse(receipt().canEditText)
    }
}
