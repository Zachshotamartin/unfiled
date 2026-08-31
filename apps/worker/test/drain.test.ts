import { describe, expect, it } from "vitest";

import { isDrainResult, unconfiguredDrainPort } from "../src/drain";

describe("worker drain boundary", () => {
  it("accepts content-free, internally consistent counters", () => {
    expect(isDrainResult({ claimed: 3, completed: 1, failed: 1, retryScheduled: 1 })).toBe(true);
    expect(isDrainResult({ claimed: 0, completed: 0, failed: 0, retryScheduled: 0 })).toBe(true);
  });

  it("rejects malformed, negative, inconsistent, or expanded results", () => {
    expect(isDrainResult(null)).toBe(false);
    expect(isDrainResult([])).toBe(false);
    expect(isDrainResult({ claimed: 1, completed: 2, failed: 0, retryScheduled: 0 })).toBe(false);
    expect(isDrainResult({ claimed: -1, completed: 0, failed: 0, retryScheduled: 0 })).toBe(false);
    expect(isDrainResult({ claimed: 1.5, completed: 0, failed: 0, retryScheduled: 0 })).toBe(false);
    expect(
      isDrainResult({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0, content: "no" })
    ).toBe(false);
  });

  it("ships with a fail-closed drain adapter", async () => {
    await expect(
      unconfiguredDrainPort.drain({
        authority: {} as never,
        requestId: "request-1",
        signal: new AbortController().signal,
        trigger: "schedule"
      })
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
  });
});
