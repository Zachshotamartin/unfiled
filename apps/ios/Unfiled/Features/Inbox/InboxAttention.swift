import Foundation

/// The Inbox holds only what needs the owner. Filed captures live in the Library as notes, so
/// they never appear here; a capture appears while it is still organizing, when it failed, or
/// when it stopped for a review (open or already closed).
enum InboxAttention {
    static func needsYou(_ receipt: ReceiptPresentation) -> Bool {
        if receipt.pending { return true }
        if receipt.retryable { return true }
        return receipt.outcome == .needsReview
    }

    /// What the Inbox says when nothing is listed: while a refresh is still running it is not
    /// yet known that nothing waits, so it says it is checking rather than "nothing".
    static func emptyCopy(isLoading: Bool) -> String {
        isLoading
            ? "Checking what needs you."
            : "Nothing waiting. Everything you wrote is filed in your Library."
    }

    /// The header summary: a count once known, "Checking" until the first refresh finishes.
    static func summary(waitingCount: Int, isLoading: Bool) -> String {
        if waitingCount == 0 && isLoading { return "Checking" }
        return waitingCount == 1 ? "1 waiting" : "\(waitingCount) waiting"
    }

    /// Receipts that need the owner, without the ones an open review card already represents.
    static func rows(
        _ receipts: [ReceiptPresentation],
        openReviewIDs: Set<String>
    ) -> [ReceiptPresentation] {
        receipts.filter { receipt in
            guard needsYou(receipt) else { return false }
            if let reviewID = receipt.reviewItemID, openReviewIDs.contains(reviewID) { return false }
            return true
        }
    }
}
