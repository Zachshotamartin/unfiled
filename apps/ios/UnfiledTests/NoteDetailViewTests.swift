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

    func testGeneratedBlocksStayOutsideEditableBodyAndRejectedBlocksAreHidden() {
        let proposed = block(id: "blk_proposed", state: .proposed)
        let accepted = block(id: "blk_accepted", state: .accepted)
        let rejected = block(id: "blk_rejected", state: .rejected)

        XCTAssertEqual(
            GeneratedBlockVisibility.visible([proposed, accepted, rejected]).map(\.id),
            ["blk_proposed", "blk_accepted"]
        )
        XCTAssertEqual(proposed.operationID, "generated-block.blk_proposed")
        XCTAssertEqual(
            GeneratedBlockAccessibilityIdentifier.accept(proposed.id),
            "noteDetail.generatedBlock.accept.blk_proposed"
        )
        XCTAssertEqual(
            GeneratedBlockAccessibilityIdentifier.reject(proposed.id),
            "noteDetail.generatedBlock.reject.blk_proposed"
        )
    }

    func testGeneratedBlockLoadMoreControlHasDeliberateRetryAndLoadingSemantics() {
        XCTAssertEqual(
            GeneratedBlockAccessibilityIdentifier.loadMore,
            "noteDetail.generatedBlocks.loadMore"
        )
        XCTAssertEqual(
            GeneratedBlockAccessibilityIdentifier.paginationNotice,
            "noteDetail.generatedBlocks.paginationNotice"
        )
        XCTAssertEqual(
            GeneratedBlockLoadMorePresentation.buttonTitle(loadError: nil),
            "Load more"
        )
        XCTAssertEqual(
            GeneratedBlockLoadMorePresentation.buttonTitle(loadError: "Network unavailable"),
            "Try loading more again"
        )
        XCTAssertEqual(
            GeneratedBlockLoadMorePresentation.accessibilityLabel(
                isLoading: true,
                loadError: nil
            ),
            "Loading more AI-generated additions"
        )
    }

    private func block(
        id: String,
        state: GeneratedBlockState
    ) -> GeneratedBlockPresentation {
        GeneratedBlockPresentation(
            id: id,
            noteID: "note_00000000000000000000000000",
            kind: .suggestion,
            content: "AI-generated content that is not part of bodyMarkdown.",
            state: state,
            stateRevision: state == .proposed ? 1 : 2,
            modelID: "organizer-v1",
            promptVersion: "expansion-v1"
        )
    }

    func testBodyProjectionDropsHeadingsThatOnlyIntroduceChecklistLines() {
        let body = "Intro line\n\n## Completed\n- [x] eggs\n- [x] milk"
        XCTAssertEqual(NoteDetailContent.bodyWithoutChecklistProjection(body), "Intro line")
        let mixed = "## Notes\nSome text\n\n## Completed\n- [x] eggs"
        XCTAssertEqual(NoteDetailContent.bodyWithoutChecklistProjection(mixed), "## Notes\nSome text")
        let onlyChecklist = "## Completed\n- [x] eggs"
        XCTAssertEqual(NoteDetailContent.bodyWithoutChecklistProjection(onlyChecklist), "")
    }
}
