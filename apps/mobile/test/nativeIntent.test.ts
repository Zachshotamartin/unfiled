import { describe, expect, it } from "vitest";

import { canonicalCaptureRoute, rewriteNativeIntent } from "../src/features/capture/nativeIntent";

describe("native intent rewriting", () => {
  it("preserves only an allowlisted source on the canonical route", () => {
    expect(
      rewriteNativeIntent(
        "/capture?source=mobile&raw_content=do%20not%20accept&destination_id=note_123"
      )
    ).toBe("/capture?source=mobile");
    expect(
      rewriteNativeIntent(
        "unfiled://capture?source=ios_lock_screen_widget&command=delete_all_notes"
      )
    ).toBe("/capture?source=ios_lock_screen_widget");
  });

  it("maps legacy capture links and malformed capture sources to the widget source", () => {
    expect(rewriteNativeIntent("unfiled-dev://quick-capture")).toBe(
      "/capture?source=ios_lock_screen_widget"
    );
    expect(rewriteNativeIntent("/new?source=not-allowed")).toBe(
      "/capture?source=ios_lock_screen_widget"
    );
    expect(rewriteNativeIntent("widget")).toBe("/capture?source=ios_lock_screen_widget");
  });

  it("sends unknown and foreign native paths to Today", () => {
    expect(rewriteNativeIntent("unfiled://settings?source=ios_lock_screen_widget")).toBe("/");
    expect(rewriteNativeIntent("other-app://capture?source=ios_lock_screen_widget")).toBe("/");
    expect(rewriteNativeIntent("https://example.com/capture")).toBe("/");
    expect(rewriteNativeIntent("   ")).toBe("/");
  });

  it("constructs one encoded canonical route", () => {
    expect(canonicalCaptureRoute("mobile")).toBe("/capture?source=mobile");
  });
});
