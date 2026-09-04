import Foundation
import WidgetKit

enum QuickCaptureWidgetConstants {
  static let appGroupIdentifier = "group.com.zachshotamartin.unfiled.dev"
  static let captureURL = URL(
    string: "unfiled-dev://capture?source=ios_lock_screen_widget"
  )!
  static let kind = "QuickCaptureWidget"
  static let pendingCountKey = "pendingCaptureCount"
  static let schemaVersion = 1
  static let schemaVersionKey = "widgetSnapshotSchemaVersion"
}

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
    guard
      let defaults = UserDefaults(
        suiteName: QuickCaptureWidgetConstants.appGroupIdentifier
      ),
      defaults.integer(
        forKey: QuickCaptureWidgetConstants.schemaVersionKey
      ) == QuickCaptureWidgetConstants.schemaVersion
    else {
      return QuickCaptureEntry(date: .now, pendingCaptureCount: 0)
    }

    return QuickCaptureEntry(
      date: .now,
      pendingCaptureCount: max(
        0,
        defaults.integer(forKey: QuickCaptureWidgetConstants.pendingCountKey)
      )
    )
  }
}
