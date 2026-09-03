import SwiftUI
import XCTest
@testable import Unfiled

/// Every icon in the app comes from the glyph vocabulary; none is an empty case, and the
/// menu images are templates so a menu tints them like any other icon.
final class GlyphVocabularyTests: XCTestCase {
    func testEveryGlyphDrawsSomething() {
        let box = CGRect(x: 0, y: 0, width: 24, height: 24)
        for glyph in UnfiledGlyph.allCases {
            let drawn = !GlyphStroke(glyph: glyph).path(in: box).isEmpty
                || !GlyphFill(glyph: glyph).path(in: box).isEmpty
            XCTAssertTrue(drawn, "\(glyph) draws nothing")
        }
    }

    @MainActor
    func testMenuImagesAreTintableTemplates() {
        let image = GlyphImage.uiImage(.archive)
        XCTAssertEqual(image.renderingMode, .alwaysTemplate)
        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertTrue(GlyphImage.uiImage(.archive) === image, "rendered once, then cached")
    }

    func testFailureAndStatusGlyphsComeFromTheVocabulary() {
        XCTAssertEqual(SearchFailure.offline.glyph, .warning)
        XCTAssertEqual(NoteContextFailure.deleted.glyph, .trash)
        XCTAssertEqual(AuthInlineMessage.Kind.confirmation.glyph, .checkCircle)
    }
}
