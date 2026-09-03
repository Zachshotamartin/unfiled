import XCTest
@testable import Unfiled

/// Every user action shows its result at once and keeps the server's revision so the
/// confirmed reply replaces the local copy and a stale refresh cannot.
final class OptimisticUpdateTests: XCTestCase {
    private func note() -> Note {
        Note(
            spaceId: nil,
            type: .generic,
            title: "Before",
            bodyMarkdown: "Old body",
            structuredData: .plain,
            isOpen: true,
            pinnedAt: nil,
            privacy: .aiAssisted,
            archivedAt: nil,
            deletedAt: nil,
            tagIds: [],
            links: [],
            id: NoteID(rawValue: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV")!,
            currentRevision: 4,
            createdAt: Date(timeIntervalSince1970: 1_000),
            updatedAt: Date(timeIntervalSince1970: 2_000)
        )
    }

    func testEditedCopyCarriesTheDraftAndKeepsIdentityAndRevision() {
        let original = note()
        let now = Date(timeIntervalSince1970: 3_000)
        let edited = original.edited(
            title: "After",
            bodyMarkdown: "New body",
            spaceId: SpaceID(rawValue: "spc_01BX5ZZKBKACTAV9WEVGEMMVRZ"),
            privacy: .privateManual,
            updatedAt: now
        )
        XCTAssertEqual(edited.title, "After")
        XCTAssertEqual(edited.bodyMarkdown, "New body")
        XCTAssertEqual(edited.spaceId?.rawValue, "spc_01BX5ZZKBKACTAV9WEVGEMMVRZ")
        XCTAssertEqual(edited.privacy, .privateManual)
        XCTAssertEqual(edited.updatedAt, now)
        XCTAssertEqual(edited.id, original.id)
        XCTAssertEqual(edited.currentRevision, original.currentRevision)
        XCTAssertEqual(edited.createdAt, original.createdAt)
        // The original is untouched.
        XCTAssertEqual(original.title, "Before")
    }

    func testArchivedAndDeletedCopiesLeaveTheActiveSet() {
        let archived = note().archived(at: Date())
        let deleted = note().deleted(at: Date())
        XCTAssertTrue(AppModel.isActiveNote(note()))
        XCTAssertFalse(AppModel.isActiveNote(archived))
        XCTAssertFalse(AppModel.isActiveNote(deleted))
        XCTAssertEqual(archived.currentRevision, 4)
        XCTAssertTrue(AppModel.isActiveNote(deleted.deleted(at: nil)))
    }

    private func receipt() -> ReceiptPresentation {
        ReceiptPresentation(
            id: "cap_01FAILED",
            category: "Failed",
            time: "2M AGO",
            headline: "Could not be organized",
            original: "milk, eggs",
            outcome: nil,
            destinationNoteID: nil,
            destinationTitle: nil,
            reviewItemID: nil,
            insertedContent: [],
            actions: [.undo(mutationID: "mut_01", expectedRevision: 3)],
            pending: false,
            retryable: true
        )
    }

    func testRetryingReceiptShowsWorkAndOffersNoActions() {
        let retrying = receipt().retrying()
        XCTAssertTrue(retrying.pending)
        XCTAssertFalse(retrying.retryable)
        XCTAssertFalse(retrying.canEditText)
        XCTAssertTrue(retrying.actions.isEmpty)
        XCTAssertEqual(retrying.id, "cap_01FAILED")
        XCTAssertEqual(retrying.original, "milk, eggs")
        XCTAssertEqual(retrying.headline, "Organizing again")
    }

    /// Receipts only decrypt the capture, so every captured reference carries the whole
    /// capture text; the row shows it once, not once per list item.
    func testRepeatedCapturedContentCollapsesToOneLine() {
        let whole = "Groceries: milk, eggs, bread"
        let content = [
            ReceiptContentPresentation(id: "itm_1", kind: .captured, content: whole),
            ReceiptContentPresentation(id: "itm_2", kind: .captured, content: whole),
            ReceiptContentPresentation(id: "blk_1", kind: .aiGenerated, content: "Also: butter"),
            ReceiptContentPresentation(id: "itm_3", kind: .captured, content: whole)
        ]
        let collapsed = ReceiptContentPresentation.collapsingRepeatedCaptures(content)
        XCTAssertEqual(collapsed.map(\.id), ["itm_1", "blk_1"])
    }

    /// The Library preview reads like prose: no checklist markers and no "Completed" heading.
    func testNotePreviewDropsChecklistMarkersAndCompletedHeading() {
        let markdown = """
        - [ ] eggs
        - [ ] bananas

        ## Completed

        - [x] milk
        - [X] bread
        """
        XCTAssertEqual(PresentationMapping.preview(markdown), "eggs bananas milk bread")
        XCTAssertEqual(PresentationMapping.preview("# Plan\n\nCall the *plumber* on Friday."), "Plan Call the plumber on Friday.")
        XCTAssertEqual(PresentationMapping.preview("   "), "Empty note")
    }

    func testUndoingReceiptDropsTheUndoActionAndKeepsTheRest() {
        let undoing = receipt().undoing()
        XCTAssertTrue(undoing.actions.isEmpty)
        XCTAssertFalse(undoing.retryable)
        XCTAssertEqual(undoing.headline, "Undoing the organized change")
        XCTAssertEqual(undoing.original, "milk, eggs")
    }
}
