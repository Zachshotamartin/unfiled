import XCTest
@testable import Unfiled

/// The title a capture's own words suggest, used when a review resolution creates a note.
final class CaptureTitleTests: XCTestCase {
    func testTitleIsTheFirstNonEmptyLineTrimmedAndBounded() {
        XCTAssertEqual(CaptureTitle.from("  Call the plumber  \nabout the tap"), "Call the plumber")
        XCTAssertEqual(CaptureTitle.from("\n\n second line first "), "second line first")
        XCTAssertEqual(CaptureTitle.from("   \n  "), "Untitled")
        XCTAssertEqual(CaptureTitle.from(String(repeating: "a", count: 300)).count, 200)
    }
}
