import SwiftUI

/// Unfiled's glyphs are built from the mark's own vocabulary: an open tray, a slanted card, and
/// square-capped strokes. Every icon is one of those three things, so the set reads as this app
/// and nothing else. Drawn in a 24-point box; the card tilts 14 degrees like the mark.
enum UnfiledGlyph: CaseIterable {
    case today, notes, review, search
    case pen, plus, send, sliders, more, chevron, back, close
    case lock, organize, clock, warning, tray, check, archive, trash
    case heading, bullets, checklist, quote, link
}

/// Renders a glyph in the current foreground style.
struct GlyphView: View {
    let glyph: UnfiledGlyph
    var size: CGFloat = 20
    var weight: CGFloat = 2.3

    var body: some View {
        ZStack {
            GlyphStroke(glyph: glyph)
                .stroke(style: StrokeStyle(lineWidth: weight, lineCap: .square, lineJoin: .round))
            GlyphFill(glyph: glyph)
                .fill()
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private enum GlyphGeometry {
    static let cardTilt = Angle.degrees(14)

    /// A slanted card centered on `center`, the same tilt as the mark's card.
    static func card(center: CGPoint, width: CGFloat, height: CGFloat, radius: CGFloat) -> Path {
        let rect = CGRect(x: center.x - width / 2, y: center.y - height / 2, width: width, height: height)
        let transform = CGAffineTransform(translationX: center.x, y: center.y)
            .rotated(by: cardTilt.radians)
            .translatedBy(x: -center.x, y: -center.y)
        return Path(roundedRect: rect, cornerRadius: radius, style: .continuous).applying(transform)
    }

    /// Tilts any path with the card's own rotation about a center, so marks drawn on a card
    /// (a check, a lens) slant with it instead of sitting square.
    static func tilted(_ path: Path, about center: CGPoint) -> Path {
        let transform = CGAffineTransform(translationX: center.x, y: center.y)
            .rotated(by: cardTilt.radians)
            .translatedBy(x: -center.x, y: -center.y)
        return path.applying(transform)
    }

    /// The mark's open tray: two uprights joined by a rounded bottom.
    static func tray(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - rect.height * 0.30))
        path.addQuadCurve(
            to: CGPoint(x: rect.midX, y: rect.maxY),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.maxY - rect.height * 0.30),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}

/// The stroked part of a glyph.
struct GlyphStroke: Shape {
    let glyph: UnfiledGlyph

    func path(in rect: CGRect) -> Path {
        let unit = rect.width / 24
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * unit, y: rect.minY + y * unit)
        }
        func box(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
            CGRect(x: rect.minX + x * unit, y: rect.minY + y * unit, width: width * unit, height: height * unit)
        }
        var path = Path()
        switch glyph {
        case .today:
            // A day page: a card with a header rule; the day itself is the filled dot.
            path.addPath(GlyphGeometry.card(center: point(12, 12), width: 12 * unit, height: 15.5 * unit, radius: 1.6 * unit))
            path.move(to: point(7.4, 9.3)); path.addLine(to: point(16.2, 11.5))
        case .notes:
            // The back card of the stack is drawn, the front card is solid.
            path.addPath(GlyphGeometry.card(center: point(9.5, 13.5), width: 8 * unit, height: 11.5 * unit, radius: 1.2 * unit))
        case .review:
            // A decided card: the check is drawn on the card and slants with it.
            path.addPath(GlyphGeometry.card(center: point(12, 12), width: 12 * unit, height: 15.5 * unit, radius: 1.6 * unit))
            var check = Path()
            check.move(to: point(8.4, 12.4)); check.addLine(to: point(11, 15)); check.addLine(to: point(15.8, 9.6))
            path.addPath(GlyphGeometry.tilted(check, about: point(12, 12)))
        case .search:
            // A card under a lens: ring and handle are drawn on the card and slant with it.
            path.addPath(GlyphGeometry.card(center: point(12, 12), width: 12 * unit, height: 15.5 * unit, radius: 1.6 * unit))
            var lens = Path()
            lens.addEllipse(in: box(8.2, 7.6, 6.2, 6.2))
            lens.move(to: point(13.6, 13)); lens.addLine(to: point(16.3, 16.4))
            path.addPath(GlyphGeometry.tilted(lens, about: point(12, 12)))
        case .pen:
            // A new card: the outline of a card with a plus inside.
            path.addPath(GlyphGeometry.card(center: point(12, 12), width: 11 * unit, height: 15 * unit, radius: 1.6 * unit))
            path.move(to: point(12, 8.8)); path.addLine(to: point(12, 15.2))
            path.move(to: point(8.8, 12)); path.addLine(to: point(15.2, 12))
        case .plus:
            path.move(to: point(12, 5)); path.addLine(to: point(12, 19))
            path.move(to: point(5, 12)); path.addLine(to: point(19, 12))
        case .send:
            path.move(to: point(12, 19.5)); path.addLine(to: point(12, 5.5))
            path.move(to: point(6.5, 11)); path.addLine(to: point(12, 5.5)); path.addLine(to: point(17.5, 11))
        case .sliders:
            // Two rails; the knobs are cards (filled).
            path.move(to: point(4, 8)); path.addLine(to: point(20, 8))
            path.move(to: point(4, 16)); path.addLine(to: point(20, 16))
        case .chevron:
            path.move(to: point(9, 6)); path.addLine(to: point(15, 12)); path.addLine(to: point(9, 18))
        case .back:
            path.move(to: point(15, 6)); path.addLine(to: point(9, 12)); path.addLine(to: point(15, 18))
        case .close:
            path.move(to: point(7, 7)); path.addLine(to: point(17, 17))
            path.move(to: point(17, 7)); path.addLine(to: point(7, 17))
        case .lock:
            // The shackle is a tray turned over; the body is a card (filled).
            path.move(to: point(8, 11)); path.addLine(to: point(8, 8.5))
            path.addArc(center: point(12, 8.5), radius: 4 * unit, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
            path.addLine(to: point(16, 11))
        case .organize:
            // The mark itself, in ink: a card dropping into the tray.
            path.addPath(GlyphGeometry.tray(in: box(4.5, 7, 15, 12.5)))
        case .clock:
            path.addEllipse(in: box(4, 4, 16, 16))
            path.move(to: point(12, 7.5)); path.addLine(to: point(12, 12)); path.addLine(to: point(15.5, 14))
        case .warning:
            path.addPath(GlyphGeometry.card(center: point(12, 12), width: 11 * unit, height: 15 * unit, radius: 1.6 * unit))
            path.move(to: point(12, 8)); path.addLine(to: point(12, 12.6))
        case .tray:
            path.addPath(GlyphGeometry.tray(in: box(4, 9, 16, 11)))
            path.move(to: point(12, 3.5)); path.addLine(to: point(12, 12))
            path.move(to: point(8.8, 8.8)); path.addLine(to: point(12, 12)); path.addLine(to: point(15.2, 8.8))
        case .check:
            path.move(to: point(5, 12.5)); path.addLine(to: point(10, 17.5)); path.addLine(to: point(19, 7.5))
        case .archive:
            path.addPath(GlyphGeometry.tray(in: box(4.5, 9, 15, 11)))
            path.move(to: point(4, 5.5)); path.addLine(to: point(20, 5.5))
        case .trash:
            path.move(to: point(4.5, 7)); path.addLine(to: point(19.5, 7))
            path.move(to: point(9.5, 7)); path.addLine(to: point(9.5, 4.5)); path.addLine(to: point(14.5, 4.5)); path.addLine(to: point(14.5, 7))
            path.addPath(GlyphGeometry.tray(in: box(6.5, 7, 11, 13)))
        case .heading:
            // A title card over two lines of text.
            path.move(to: point(5, 15)); path.addLine(to: point(19, 15))
            path.move(to: point(5, 19)); path.addLine(to: point(14, 19))
        case .bullets:
            // Three lines; the bullets are small cards.
            path.move(to: point(10, 6.5)); path.addLine(to: point(19, 6.5))
            path.move(to: point(10, 12)); path.addLine(to: point(19, 12))
            path.move(to: point(10, 17.5)); path.addLine(to: point(19, 17.5))
        case .checklist:
            // Two checks with their lines.
            path.move(to: point(4.5, 8)); path.addLine(to: point(6.6, 10.1)); path.addLine(to: point(10, 5.9))
            path.move(to: point(12.5, 8)); path.addLine(to: point(19.5, 8))
            path.move(to: point(4.5, 16)); path.addLine(to: point(6.6, 18.1)); path.addLine(to: point(10, 13.9))
            path.move(to: point(12.5, 16)); path.addLine(to: point(19.5, 16))
        case .link:
            // Two rings that overlap, drawn with the same square caps as every stroke.
            path.addRoundedRect(in: box(3.5, 9, 10, 6), cornerSize: CGSize(width: 3 * unit, height: 3 * unit))
            path.addRoundedRect(in: box(10.5, 9, 10, 6), cornerSize: CGSize(width: 3 * unit, height: 3 * unit))
        case .quote, .more:
            break
        }
        return path
    }
}

/// The solid part of a glyph: the cards.
struct GlyphFill: Shape {
    let glyph: UnfiledGlyph

    func path(in rect: CGRect) -> Path {
        let unit = rect.width / 24
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * unit, y: rect.minY + y * unit)
        }
        var path = Path()
        switch glyph {
        case .today:
            path.addEllipse(in: CGRect(x: rect.minX + 10.3 * unit, y: rect.minY + 13.2 * unit, width: 3.4 * unit, height: 3.4 * unit))
        case .notes:
            path.addPath(GlyphGeometry.card(center: point(14.5, 10.5), width: 8 * unit, height: 11.5 * unit, radius: 1.2 * unit))
        case .sliders:
            path.addPath(GlyphGeometry.card(center: point(15.5, 8), width: 3.4 * unit, height: 6 * unit, radius: 0.8 * unit))
            path.addPath(GlyphGeometry.card(center: point(8.5, 16), width: 3.4 * unit, height: 6 * unit, radius: 0.8 * unit))
        case .more:
            for x in [6.0, 12.0, 18.0] {
                path.addPath(GlyphGeometry.card(center: point(x, 12), width: 3 * unit, height: 5 * unit, radius: 0.7 * unit))
            }
        case .lock:
            path.addPath(GlyphGeometry.card(center: point(12, 15.5), width: 13 * unit, height: 9 * unit, radius: 1.6 * unit))
        case .organize:
            path.addPath(GlyphGeometry.card(center: point(13, 7.5), width: 4.2 * unit, height: 8.5 * unit, radius: 0.8 * unit))
        case .warning:
            path.addEllipse(in: CGRect(x: rect.minX + 10.9 * unit, y: rect.minY + 14.6 * unit, width: 2.2 * unit, height: 2.2 * unit))
        case .heading:
            path.addPath(GlyphGeometry.card(center: point(8.5, 8), width: 5.5 * unit, height: 7 * unit, radius: 0.8 * unit))
        case .bullets:
            for y in [6.5, 12.0, 17.5] {
                path.addPath(GlyphGeometry.card(center: point(6, y), width: 2.6 * unit, height: 2.6 * unit, radius: 0.5 * unit))
            }
        case .quote:
            // Two slanted cards, the way quotation marks sit.
            path.addPath(GlyphGeometry.card(center: point(8.5, 12), width: 3.6 * unit, height: 7 * unit, radius: 0.8 * unit))
            path.addPath(GlyphGeometry.card(center: point(15.5, 12), width: 3.6 * unit, height: 7 * unit, radius: 0.8 * unit))
        default:
            break
        }
        return path
    }
}
