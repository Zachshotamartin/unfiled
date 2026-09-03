import XCTest
@testable import Unfiled

final class PrivateNoteDraftTests: XCTestCase {
    func testTitleIsTheFirstNonEmptyLineTrimmedAndBounded() {
        XCTAssertEqual(PrivateNoteDraft.title(from: "  Call the plumber  \nabout the tap"), "Call the plumber")
        XCTAssertEqual(PrivateNoteDraft.title(from: "\n\n second line first "), "second line first")
        XCTAssertEqual(PrivateNoteDraft.title(from: "   \n  "), "Untitled")
        XCTAssertEqual(PrivateNoteDraft.title(from: String(repeating: "a", count: 300)).count, 200)
    }

    func testRequestIsAPrivateGenericNoteInNoSpace() {
        let request = PrivateNoteDraft.request(content: "Tap\nthe rest", idempotencyKey: "idem-1")
        XCTAssertEqual(request.title, "Tap")
        XCTAssertEqual(request.bodyMarkdown, "Tap\nthe rest")
        XCTAssertEqual(request.privacy, .privateManual)
        XCTAssertEqual(request.type, .generic)
        XCTAssertNil(request.spaceId)
        XCTAssertEqual(request.idempotencyKey, "idem-1")
    }
}
