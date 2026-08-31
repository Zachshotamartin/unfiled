import XCTest
@testable import Unfiled

final class RevisionHistoryViewTests: XCTestCase {
    func testSnapshotOrdersNewestFirstAndPreventsRestoringCurrent() {
        let oldest = revision(id: "rev_old", number: 1)
        let current = revision(id: "rev_current", number: 3)
        let middle = revision(id: "rev_middle", number: 2)

        let snapshot = RevisionHistorySnapshot(
            revisions: [oldest, current, middle],
            currentRevision: 3
        )

        XCTAssertEqual(snapshot.ordered.map(\.revision), [3, 2, 1])
        XCTAssertFalse(snapshot.canRestore(current))
        XCTAssertTrue(snapshot.canRestore(middle))
    }

    private func revision(id: String, number: Int) -> RevisionPresentation {
        RevisionPresentation(
            id: id,
            revision: number,
            source: RevisionSource.manual.rawValue,
            createdLabel: "Today",
            title: "Shopping"
        )
    }
}
