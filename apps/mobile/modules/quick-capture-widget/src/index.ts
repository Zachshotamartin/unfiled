import { requireNativeModule } from "expo";
import { Platform } from "react-native";

export interface WidgetSnapshot {
  pendingCaptureCount: number;
}

interface QuickCaptureWidgetNativeModule {
  reloadQuickCaptureWidget(): Promise<void>;
  setWidgetSnapshot(snapshot: WidgetSnapshot): Promise<void>;
}

let moduleInstance: QuickCaptureWidgetNativeModule | null | undefined;

function nativeModule(): QuickCaptureWidgetNativeModule | null {
  if (Platform.OS !== "ios") return null;
  moduleInstance ??= requireNativeModule<QuickCaptureWidgetNativeModule>("QuickCaptureWidget");
  return moduleInstance;
}

export async function setWidgetSnapshot(snapshot: WidgetSnapshot): Promise<void> {
  if (!Number.isInteger(snapshot.pendingCaptureCount) || snapshot.pendingCaptureCount < 0) {
    throw new RangeError("pendingCaptureCount must be a non-negative integer");
  }
  await nativeModule()?.setWidgetSnapshot(snapshot);
}

export async function reloadQuickCaptureWidget(): Promise<void> {
  await nativeModule()?.reloadQuickCaptureWidget();
}
