import { reloadQuickCaptureWidget, setWidgetSnapshot } from "@unfiled/quick-capture-widget";

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleWidgetPendingCount(pendingCaptureCount: number): void {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void setWidgetSnapshot({ pendingCaptureCount })
      .then(reloadQuickCaptureWidget)
      .catch(() => {
        // The capture path remains fully functional when App Group provisioning is unavailable.
      });
  }, 400);
}
