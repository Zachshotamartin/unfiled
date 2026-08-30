import {
  createEntityId,
  type ApiErrorCodeValue,
  type CaptureCreateRequest
} from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  acknowledgeSync,
  beginSync,
  createOutboxEntry,
  reconcileEntries,
  retryDelayMilliseconds,
  scheduleRetry
} from "../src/index.js";

function capture(): CaptureCreateRequest {
  return {
    clientCaptureId: createEntityId("cap"),
    rawContent: "milk",
    source: "mobile",
    clientCreatedAt: "2026-08-30T18:30:00.000Z",
    clientTimezone: "UTC",
    privacy: "ai_assisted",
    expansionDisabled: false
  };
}

describe("capture outbox state machine", () => {
  it("moves from pending to syncing to acknowledged", () => {
    const pending = createOutboxEntry(capture());
    const syncing = beginSync(pending);
    const synced = acknowledgeSync(syncing, "2026-08-30T18:31:00.000Z");
    expect(syncing).toMatchObject({ state: "syncing", attemptCount: 1 });
    expect(synced).toMatchObject({
      state: "synced",
      serverAcknowledgedAt: "2026-08-30T18:31:00.000Z"
    });
    expect(beginSync(synced)).toBe(synced);
    expect(acknowledgeSync(synced, "2026-08-30T18:32:00.000Z")).toBe(synced);
  });

  it("uses bounded exponential retry and then a surfaced permanent failure", () => {
    const syncing = beginSync(createOutboxEntry(capture()));
    const retry = scheduleRetry(syncing, 0, "offline");
    expect(retry).toMatchObject({ state: "retry_wait", nextAttemptAt: "1970-01-01T00:00:01.000Z" });
    expect(retryDelayMilliseconds(20)).toBe(120_000);
    expect(scheduleRetry({ ...syncing, attemptCount: 5 }, 0, "invalid_capture")).toMatchObject({
      state: "permanent_failure",
      nextAttemptAt: null
    });
    expect(beginSync({ ...syncing, state: "permanent_failure" })).toMatchObject({
      state: "permanent_failure"
    });
    expect(() =>
      scheduleRetry(syncing, 0, "provider_response_body_raw" as ApiErrorCodeValue)
    ).toThrow();
  });

  it("deduplicates restart recovery by capture id and retains the latest attempt", () => {
    const original = createOutboxEntry(capture());
    const later = beginSync(original);
    expect(reconcileEntries([original, later])).toEqual([later]);
  });
});
