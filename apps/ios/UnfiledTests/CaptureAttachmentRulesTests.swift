import XCTest
@testable import Unfiled

/// The rules the composer and the note view follow for photos and recordings.
final class CaptureAttachmentRulesTests: XCTestCase {
    func testPhotosAloneAreEnoughToSend() {
        XCTAssertTrue(CaptureComposerRules.canSend(content: "   ", attachmentCount: 1))
        XCTAssertFalse(CaptureComposerRules.canSend(content: "", attachmentCount: 0))
        XCTAssertTrue(CaptureComposerRules.canSend(content: "hi", attachmentCount: 0))
        XCTAssertFalse(
            CaptureComposerRules.canSend(content: String(repeating: "x", count: 10_001), attachmentCount: 1)
        )
    }

    func testPlaceholderWordsWhenNothingWasTyped() {
        XCTAssertEqual(CaptureComposerRules.rawContent(content: "  ", kinds: [.image]), "Photo")
        XCTAssertEqual(CaptureComposerRules.rawContent(content: "", kinds: [.image, .image]), "Photos")
        XCTAssertEqual(CaptureComposerRules.rawContent(content: "", kinds: []), "")
        XCTAssertEqual(CaptureComposerRules.rawContent(content: " Kitchen ", kinds: [.image]), "Kitchen")
    }

    func testAtMostFourPhotosAndNoRecordings() {
        XCTAssertTrue(CaptureComposerRules.canAdd(.image, to: [.image, .image, .image]))
        XCTAssertFalse(CaptureComposerRules.canAdd(.image, to: [.image, .image, .image, .image]))
        XCTAssertFalse(
            CaptureComposerRules.canAdd(.audio, to: []),
            "the keyboard's dictation key writes speech into the text; the app records nothing"
        )
        XCTAssertEqual(CaptureComposerRules.remainingPhotos(given: [.image]), 3)
    }

    func testNoteBodySplitsAttachmentReferencesFromWords() {
        let body = """
        Whiteboard from the kitchen

        ![Photo](unfiled-attachment:att_01ARZ3NDEKTSV4RRFFQ69G5FAZ)

        [Recording](unfiled-attachment:att_01ARZ3NDEKTSV4RRFFQ69G5FAY)
        More words
        """
        XCTAssertEqual(NoteBodySegment.segments(of: body), [
            .text("Whiteboard from the kitchen"),
            .image(attachmentID: "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
            .recording(attachmentID: "att_01ARZ3NDEKTSV4RRFFQ69G5FAY"),
            .text("More words")
        ])
        XCTAssertEqual(NoteBodySegment.segments(of: "Just words\n\nand more"), [.text("Just words\n\nand more")])
        XCTAssertEqual(
            NoteBodySegment.segments(of: "![Photo](unfiled-attachment:nope)"),
            [.text("![Photo](unfiled-attachment:nope)")]
        )
        XCTAssertEqual(NoteBodySegment.segments(of: ""), [])
    }
}
