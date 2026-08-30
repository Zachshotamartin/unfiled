import ExpoModulesCore
import Foundation
import WidgetKit

private struct WidgetSnapshotRecord: Record {
  @Field var pendingCaptureCount: Int = 0
}

private enum WidgetBridgeError: Error, LocalizedError {
  case appGroupIdentifierMissing
  case appGroupUnavailable(String)
  case invalidPendingCount

  var errorDescription: String? {
    switch self {
    case .appGroupIdentifierMissing:
      return "UnfiledAppGroupIdentifier is missing from the containing app's Info.plist."
    case .appGroupUnavailable(let identifier):
      return "The App Group container \(identifier) is unavailable."
    case .invalidPendingCount:
      return "pendingCaptureCount must be a non-negative integer."
    }
  }
}

public final class QuickCaptureWidgetModule: Module {
  private static let widgetKind = "QuickCaptureWidget"
  private static let pendingCountKey = "pendingCaptureCount"
  private static let schemaVersionKey = "widgetSnapshotSchemaVersion"
  private static let schemaVersion = 1

  public func definition() -> ModuleDefinition {
    Name("QuickCaptureWidget")

    AsyncFunction("setWidgetSnapshot") { (snapshot: WidgetSnapshotRecord) throws in
      guard snapshot.pendingCaptureCount >= 0 else {
        throw WidgetBridgeError.invalidPendingCount
      }
      let defaults = try Self.sharedDefaults()
      defaults.set(snapshot.pendingCaptureCount, forKey: Self.pendingCountKey)
      defaults.set(Self.schemaVersion, forKey: Self.schemaVersionKey)
    }

    AsyncFunction("reloadQuickCaptureWidget") {
      WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
    }
    .runOnQueue(.main)
  }

  private static func sharedDefaults() throws -> UserDefaults {
    guard
      let identifier = Bundle.main.object(
        forInfoDictionaryKey: "UnfiledAppGroupIdentifier"
      ) as? String,
      !identifier.isEmpty
    else {
      throw WidgetBridgeError.appGroupIdentifierMissing
    }
    guard let defaults = UserDefaults(suiteName: identifier) else {
      throw WidgetBridgeError.appGroupUnavailable(identifier)
    }
    return defaults
  }
}
