import Foundation
import WidgetKit

struct WidgetSnapshotStore: Sendable {
    func publish(pendingCaptureCount: Int) {
        guard let defaults = AppGroupConfiguration.sharedDefaults else { return }
        defaults.set(AppGroupConfiguration.schemaVersion, forKey: AppGroupConfiguration.schemaVersionKey)
        defaults.set(max(0, pendingCaptureCount), forKey: AppGroupConfiguration.pendingCaptureCountKey)
        WidgetCenter.shared.reloadTimelines(ofKind: "QuickCaptureWidget")
    }

    func clear() {
        guard let defaults = AppGroupConfiguration.sharedDefaults else { return }
        defaults.removeObject(forKey: AppGroupConfiguration.pendingCaptureCountKey)
        defaults.set(AppGroupConfiguration.schemaVersion, forKey: AppGroupConfiguration.schemaVersionKey)
        WidgetCenter.shared.reloadTimelines(ofKind: "QuickCaptureWidget")
    }
}
