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

    func testTheNameTheOwnerGaveAListIsItsTitle() {
        XCTAssertEqual(CaptureTitle.from("todo list, buy milk, call mom, fix the bike"), "Todo list")
        XCTAssertEqual(CaptureTitle.from("groceries: milk, eggs"), "Groceries")
        XCTAssertEqual(CaptureTitle.from("Weekend plans: hike, brunch"), "Weekend plans")
        XCTAssertEqual(CaptureTitle.from("Packing list\npassport\ncharger"), "Packing list")
        XCTAssertEqual(CaptureTitle.from("to do, water the plants"), "To do")
    }

    func testAPlainListKeepsItsFirstLineAsTheSuggestion() {
        XCTAssertEqual(CaptureTitle.from("milk, eggs, bread"), "milk, eggs, bread")
        XCTAssertEqual(CaptureTitle.from("Milk\neggs\nbread"), "Milk")
        XCTAssertEqual(CaptureTitle.from("guest count, venue, catering"), "guest count, venue, catering")
        XCTAssertEqual(CaptureTitle.from("http://example.com, read later"), "http://example.com, read later")
        XCTAssertEqual(CaptureTitle.from("meet at 10:30, bring the deck"), "meet at 10:30, bring the deck")
        XCTAssertEqual(CaptureTitle.from("todo list:"), "todo list:")
    }
}
