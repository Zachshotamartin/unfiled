import XCTest
@testable import Unfiled

final class NoteDetailViewTests: XCTestCase {
    func testChecklistProgressUsesOptimisticOverrides() {
        let items = [
            ChecklistItemPresentation(id: "itm_one", text: "Milk", checked: false),
            ChecklistItemPresentation(id: "itm_two", text: "Spinach", checked: true),
            ChecklistItemPresentation(id: "itm_three", text: "Batteries", checked: false)
        ]

        let progress = ChecklistProgress(
            items: items,
            overrides: ["itm_one": true, "itm_two": false]
        )

        XCTAssertEqual(progress.completed, 1)
        XCTAssertEqual(progress.remaining, 2)
        XCTAssertEqual(progress.shortLabel, "1 of 3")
        XCTAssertEqual(progress.accessibilityLabel, "1 completed, 2 remaining")
    }

    func testProjectedChecklistLinesAreRemovedFromReadableBody() {
        let markdown = """
        A short note.

        - [ ] Milk
        * [x] Spinach
        + [X] Batteries

        Keep this paragraph.
        """

        XCTAssertEqual(
            NoteDetailContent.bodyWithoutChecklistProjection(markdown),
            "A short note.\n\n\nKeep this paragraph."
        )
    }
}
