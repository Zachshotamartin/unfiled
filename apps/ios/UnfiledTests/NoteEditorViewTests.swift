import XCTest
@testable import Unfiled

final class NoteEditorViewTests: XCTestCase {
    func testDraftTrimsTitleOnlyWhenPreparedForSave() {
        let draft = makeDraft(title: "  Shopping  ", body: " milk ")

        XCTAssertNil(draft.validationIssue)
        XCTAssertEqual(draft.normalizedForSave.title, "Shopping")
        XCTAssertEqual(draft.normalizedForSave.bodyMarkdown, " milk ")
    }

    func testDraftRejectsWhitespaceTitleAndContractLimits() {
        XCTAssertEqual(
            makeDraft(title: "   ", body: "").validationIssue,
            "Add a title before saving."
        )
        XCTAssertEqual(
            makeDraft(title: String(repeating: "a", count: 201), body: "").validationIssue,
            "The title must be 200 characters or fewer."
        )
        XCTAssertEqual(
            makeDraft(
                title: "Long note",
                body: String(repeating: "b", count: NoteEditorDraft.maximumBodyLength + 1)
            ).validationIssue,
            "The note must be 200,000 characters or fewer."
        )
    }

    func testDraftCountsNonBMPTextInServerUTF16Units() {
        let emoji = "\u{1F642}"

        XCTAssertNil(makeDraft(title: String(repeating: emoji, count: 100), body: "").validationIssue)
        XCTAssertEqual(
            makeDraft(title: String(repeating: emoji, count: 101), body: "").validationIssue,
            "The title must be 200 characters or fewer."
        )
        XCTAssertEqual(
            makeDraft(
                title: "Emoji note",
                body: String(repeating: emoji, count: NoteEditorDraft.maximumBodyLength / 2 + 1)
            ).validationIssue,
            "The note must be 200,000 characters or fewer."
        )
    }

    private func makeDraft(title: String, body: String) -> NoteEditorDraft {
        NoteEditorDraft(
            noteID: nil,
            title: title,
            bodyMarkdown: body,
            type: .generic,
            privacy: .aiAssisted,
            spaceID: nil
        )
    }
}
