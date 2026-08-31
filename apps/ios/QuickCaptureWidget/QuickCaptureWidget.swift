import SwiftUI
import WidgetKit

struct QuickCaptureWidgetView: View {
    @Environment(\.widgetFamily) private var family

    let entry: QuickCaptureEntry

    var body: some View {
        Button(intent: OpenQuickCaptureIntent()) {
            Group {
                switch family {
                case .accessoryRectangular:
                    rectangularView
                default:
                    circularView
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Write in Unfiled")
        .containerBackground(for: .widget) {
            Color.clear
        }
    }

    private var circularView: some View {
        ZStack {
            AccessoryWidgetBackground()
            UnfiledMark(size: 28, monochrome: true)
                .widgetAccentable()
        }
    }

    private var rectangularView: some View {
        HStack(spacing: 9) {
            UnfiledMark(size: 25, monochrome: true)
                .widgetAccentable()
            VStack(alignment: .leading, spacing: 1) {
                Text("Write something")
                    .font(.headline)
                    .lineLimit(1)
                if entry.pendingCaptureCount > 0 {
                    Text("\(entry.pendingCaptureCount) waiting to sync")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .privacySensitive()
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct QuickCaptureWidget: Widget {
    let kind = "QuickCaptureWidget"

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
