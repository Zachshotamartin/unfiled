import type { CaptureSource } from "@unfiled/contracts";

export const nativeCaptureSources = [
  "mobile",
  "ios_lock_screen_widget"
] as const satisfies readonly CaptureSource[];

export type NativeCaptureSource = (typeof nativeCaptureSources)[number];

export function isNativeCaptureSource(value: unknown): value is NativeCaptureSource {
  return typeof value === "string" && nativeCaptureSources.some((source) => source === value);
}

export function allowlistedCaptureSource(
  value: string | string[] | undefined,
  fallback: NativeCaptureSource = "mobile"
): NativeCaptureSource {
  if (Array.isArray(value)) return fallback;
  return isNativeCaptureSource(value) ? value : fallback;
}

export function captureSourceLabel(source: NativeCaptureSource): string {
  return source === "ios_lock_screen_widget" ? "Lock Screen" : "Unfiled";
}
