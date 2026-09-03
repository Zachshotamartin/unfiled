import SwiftUI

struct UnfiledMark: View {
    var size: CGFloat = 32
    var monochrome = false

    var body: some View {
        ZStack {
            IntakeTray()
                .stroke(
                    monochrome ? Color.primary : BrandMarkColor.paper,
                    style: StrokeStyle(lineWidth: size * 0.16, lineCap: .square, lineJoin: .round)
                )
                .frame(width: size * 0.74, height: size * 0.58)
                .offset(y: size * 0.13)

            RoundedRectangle(cornerRadius: size * 0.025, style: .continuous)
                .fill(monochrome ? Color.primary : BrandMarkColor.persimmon)
                .frame(width: size * 0.19, height: size * 0.42)
                .rotationEffect(.degrees(14))
                .offset(x: size * 0.10, y: -size * 0.20)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
private enum BrandMarkColor {
    static let paper = Color(red: 20 / 255, green: 23 / 255, blue: 27 / 255)
    static let persimmon = Color(red: 30 / 255, green: 107 / 255, blue: 87 / 255)
}

private struct IntakeTray: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY * 0.70))
        path.addQuadCurve(
            to: CGPoint(x: rect.midX, y: rect.maxY),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.maxY * 0.70),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}

#Preview("Mark") {
    ZStack {
        Color(red: 243 / 255, green: 244 / 255, blue: 246 / 255)
        UnfiledMark(size: 72)
    }
    .frame(width: 160, height: 160)
}
