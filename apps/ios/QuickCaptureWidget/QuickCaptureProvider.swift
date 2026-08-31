import Foundation
import WidgetKit

struct QuickCaptureEntry: TimelineEntry {
    let date: Date
    let pendingCaptureCount: Int
}
struct QuickCaptureProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuickCaptureEntry {
        QuickCaptureEntry(date: .now, pendingCaptureCount: 0)
    }

    func getSnapshot(
        in context: Context,
        completion: @escaping (QuickCaptureEntry) -> Void
    ) {
        completion(entry())
    }

    func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<QuickCaptureEntry>) -> Void
    ) {
        completion(Timeline(entries: [entry()], policy: .never))
    }

    private func entry() -> QuickCaptureEntry {
        guard let defaults = AppGroupConfiguration.sharedDefaults,
              defaults.integer(forKey: AppGroupConfiguration.schemaVersionKey)
                == AppGroupConfiguration.schemaVersion else {
            return QuickCaptureEntry(date: .now, pendingCaptureCount: 0)
        }
        return QuickCaptureEntry(
            date: .now,
            pendingCaptureCount: max(
                0,
                defaults.integer(forKey: AppGroupConfiguration.pendingCaptureCountKey)
            )
        )
    }
}
