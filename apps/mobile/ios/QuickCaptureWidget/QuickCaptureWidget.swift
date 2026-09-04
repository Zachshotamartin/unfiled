import SwiftUI
import WidgetKit

struct QuickCaptureWidgetView: View {
  @Environment(\.widgetFamily) private var family

  let entry: QuickCaptureEntry

  var body: some View {
    Group {
      switch family {
      case .accessoryRectangular:
        rectangularView
      default:
        circularView
      }
    }
    .widgetURL(QuickCaptureWidgetConstants.captureURL)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
    .containerBackground(for: .widget) {
      Color.clear
    }
  }

  private var accessibilityLabel: String {
    if entry.pendingCaptureCount > 0 {
      return "New capture. \(entry.pendingCaptureCount) waiting to sync."
    }
    return "New capture"
  }

  private var circularView: some View {
    ZStack {
      AccessoryWidgetBackground()
      UnfiledCaptureMark()
        .frame(width: 28, height: 28)
    }
  }

  private var rectangularView: some View {
    HStack(spacing: 8) {
      UnfiledCaptureMark()
        .frame(width: 24, height: 24)
      VStack(alignment: .leading, spacing: 1) {
        Text("Write something")
          .font(.headline)
          .lineLimit(1)
        if entry.pendingCaptureCount > 0 {
          Text("\(entry.pendingCaptureCount) waiting to sync")
            .font(.caption)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
  }
}

struct QuickCaptureWidget: Widget {
  let kind = QuickCaptureWidgetConstants.kind

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: QuickCaptureProvider()) { entry in
      QuickCaptureWidgetView(entry: entry)
    }
    .configurationDisplayName("Quick Capture")
    .description("Open a blank capture without choosing where it belongs.")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    .contentMarginsDisabled()
  }
}

#Preview(as: .accessoryCircular) {
  QuickCaptureWidget()
} timeline: {
  QuickCaptureEntry(date: .now, pendingCaptureCount: 0)
}

#Preview(as: .accessoryRectangular) {
  QuickCaptureWidget()
} timeline: {
  QuickCaptureEntry(date: .now, pendingCaptureCount: 3)
}
