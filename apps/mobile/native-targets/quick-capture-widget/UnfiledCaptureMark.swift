import SwiftUI

struct UnfiledCaptureMark: View {
  var body: some View {
    GeometryReader { proxy in
      let side = min(proxy.size.width, proxy.size.height)
      let stroke = max(2, side * 0.11)

      ZStack {
        UnevenRoundedRectangle(
          topLeadingRadius: 0,
          bottomLeadingRadius: side * 0.2,
          bottomTrailingRadius: side * 0.2,
          topTrailingRadius: 0
        )
        .trim(from: 0.22, to: 0.78)
        .stroke(
          style: StrokeStyle(lineWidth: stroke, lineCap: .round, lineJoin: .round)
        )
        .frame(width: side * 0.76, height: side * 0.58)
        .offset(y: side * 0.12)

        RoundedRectangle(cornerRadius: max(1, side * 0.025))
          .frame(width: side * 0.2, height: side * 0.42)
          .rotationEffect(.degrees(14))
          .offset(x: side * 0.1, y: -side * 0.16)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .aspectRatio(1, contentMode: .fit)
    .foregroundStyle(.primary)
    .widgetAccentable()
  }
}
