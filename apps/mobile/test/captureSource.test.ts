import { describe, expect, it } from "vitest";

import {
  allowlistedCaptureSource,
  captureSourceLabel,
  isNativeCaptureSource,
  nativeCaptureSources
} from "../src/features/capture/captureSource";

describe("native capture source allowlist", () => {
  it("contains only the in-app and Lock Screen entry points", () => {
    expect(nativeCaptureSources).toEqual(["mobile", "ios_lock_screen_widget"]);
    expect(isNativeCaptureSource("mobile")).toBe(true);
    expect(isNativeCaptureSource("ios_lock_screen_widget")).toBe(true);
  });

  it("rejects commands, destinations, arrays, and unknown values", () => {
    expect(isNativeCaptureSource("web")).toBe(false);
    expect(isNativeCaptureSource("delete_all_notes")).toBe(false);
    expect(isNativeCaptureSource({ source: "mobile" })).toBe(false);
    expect(allowlistedCaptureSource(["ios_lock_screen_widget", "mobile"])).toBe("mobile");
    expect(allowlistedCaptureSource("unknown")).toBe("mobile");
  });

  it("uses an explicit safe fallback and user-facing labels", () => {
    expect(allowlistedCaptureSource(undefined, "ios_lock_screen_widget")).toBe(
      "ios_lock_screen_widget"
    );
    expect(captureSourceLabel("ios_lock_screen_widget")).toBe("Lock Screen");
    expect(captureSourceLabel("mobile")).toBe("Unfiled");
  });
});
