import { ApiClientError } from "@unfiled/api-client";
import type { CaptureCreateResponse, EntityId } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  captureFailurePlan,
  flushCaptureOutbox,
  mergeCaptureActivity,
  retryDelayMs,
  submitDurably,
  type CaptureQueueStore,
  type CaptureTransport
} from "./capture-queue";
import type {
  CaptureOutboxItem,
  CaptureOutboxStatus,
  CaptureOutboxUpdate,
  DurableCaptureRequest
} from "./capture-store";

const CAPTURE_ID = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"cap">;
const request: DurableCaptureRequest = {
  clientCaptureId: CAPTURE_ID,
  rawContent: "milk",
  source: "web",
  clientCreatedAt: "2026-08-30T18:30:00.000Z",
  clientTimezone: "UTC",
  privacy: "ai_assisted",
  expansionDisabled: false
};

function item(overrides: Partial<CaptureOutboxItem> = {}): CaptureOutboxItem {
  return {
    attempts: 0,
    createdAt: 100,
    errorCode: null,
    nextAttemptAt: 100,
    request,
    state: "waiting",
    updatedAt: 100,
    ...overrides
  };
}

function status(overrides: Partial<CaptureOutboxStatus> = {}): CaptureOutboxStatus {
  return {
    attempts: 0,
    clientCaptureId: CAPTURE_ID,
    createdAt: Date.parse(request.clientCreatedAt),
    errorCode: null,
    nextAttemptAt: 100,
    state: "waiting",
    updatedAt: 100,
    ...overrides
  };
}

function apiError(code: "provider_unavailable" | "validation_failed", status: number) {
  return new ApiClientError(status, { code, message: "Safe message", requestId: "request-1" });
}

describe("browser capture queue", () => {
  it("uses capped exponential backoff and eventually requires manual retry", () => {
    expect([1, 2, 3, 10].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 300_000]);
    expect(captureFailurePlan(apiError("provider_unavailable", 503), 1, 10_000)).toEqual({
      attempts: 1,
      errorCode: "provider_unavailable",
      nextAttemptAt: 11_000,
      state: "retrying"
    });
    expect(captureFailurePlan(apiError("provider_unavailable", 503), 5, 10_000)).toEqual({
      attempts: 5,
      errorCode: "provider_unavailable",
      nextAttemptAt: null,
      state: "permanent"
    });
    expect(captureFailurePlan(apiError("validation_failed", 400), 1, 10_000)).toEqual({
      attempts: 1,
      errorCode: "validation_failed",
      nextAttemptAt: null,
      state: "permanent"
    });
    expect(captureFailurePlan(new Error("offline"), 50, 10_000)).toEqual({
      attempts: 50,
      errorCode: "offline",
      nextAttemptAt: 310_000,
      state: "retrying"
    });
  });

  it("acknowledges only after durable storage and schedules network work afterward", async () => {
    const order: string[] = [];
    await submitDurably(
      {
        enqueueCapture: () => {
          order.push("persist");
          return Promise.resolve(item());
        }
      },
      "profile",
      request,
      100,
      () => order.push("acknowledge"),
      () => order.push("schedule")
    );
    expect(order).toEqual(["persist", "acknowledge", "schedule"]);
  });

  it("marks successful sends synced and retryable failures without changing IDs", async () => {
    const updates: unknown[] = [];
    const store: CaptureQueueStore = {
      listOutbox: () =>
        Promise.resolve([
          item(),
          item({
            request: {
              ...request,
              clientCaptureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
            }
          })
        ]),
      updateOutbox: (_profileId, captureId, update) => {
        updates.push([captureId, update]);
        return Promise.resolve();
      }
    };
    const response = {
      capture: { id: CAPTURE_ID },
      jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      replayed: false
    } as unknown as CaptureCreateResponse;
    const createCapture = vi
      .fn<CaptureTransport["createCapture"]>()
      .mockResolvedValueOnce(response)
      .mockRejectedValueOnce(apiError("provider_unavailable", 503));

    const result = await flushCaptureOutbox(store, "profile", { createCapture }, 1_000);

    expect(result).toEqual({ attempted: 2, failed: 1, synced: 1 });
    expect(createCapture.mock.calls.map(([input]) => input.clientCaptureId)).toEqual([
      CAPTURE_ID,
      "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
    ]);
    expect(updates).toEqual(
      expect.arrayContaining([
        [CAPTURE_ID, expect.objectContaining({ state: "sending" })],
        [CAPTURE_ID, expect.objectContaining({ state: "synced" })],
        ["cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y", expect.objectContaining({ state: "retrying" })]
      ])
    );
  });

  it("keeps an offline capture eligible across restart and syncs it on reconnect", async () => {
    const updates: (readonly [EntityId<"cap">, CaptureOutboxUpdate])[] = [];
    const firstStore: CaptureQueueStore = {
      listOutbox: () => Promise.resolve([item({ attempts: 8 })]),
      updateOutbox: (_profileId, captureId, update) => {
        updates.push([captureId, update]);
        return Promise.resolve();
      }
    };
    await flushCaptureOutbox(
      firstStore,
      "profile",
      { createCapture: () => Promise.reject(new Error("offline")) },
      1_000
    );
    const retry = updates.at(-1)?.[1];
    expect(retry).toMatchObject({ attempts: 9, errorCode: "offline", state: "retrying" });
    expect(retry?.nextAttemptAt).not.toBeNull();
    if (retry === undefined) throw new Error("Expected a persisted retry update");

    const createCapture = vi.fn(() => Promise.resolve({} as CaptureCreateResponse));
    const restartedStore: CaptureQueueStore = {
      listOutbox: () =>
        Promise.resolve([
          item({
            attempts: retry.attempts,
            errorCode: retry.errorCode,
            nextAttemptAt: retry.nextAttemptAt,
            state: "retrying",
            updatedAt: retry.updatedAt
          })
        ]),
      updateOutbox: vi.fn()
    };
    await flushCaptureOutbox(
      restartedStore,
      "profile",
      { createCapture },
      retry.nextAttemptAt ?? 0
    );
    expect(createCapture).toHaveBeenCalledWith(request);
  });

  it("skips future, permanent, and already-synced entries", async () => {
    const createCapture = vi.fn();
    const store: CaptureQueueStore = {
      listOutbox: () =>
        Promise.resolve([
          item({ nextAttemptAt: 2_000, state: "retrying" }),
          item({ nextAttemptAt: null, state: "permanent" }),
          item({ nextAttemptAt: null, state: "synced" })
        ]),
      updateOutbox: vi.fn()
    };
    await expect(flushCaptureOutbox(store, "profile", { createCapture }, 1_000)).resolves.toEqual({
      attempted: 0,
      failed: 0,
      synced: 0
    });
    expect(createCapture).not.toHaveBeenCalled();
  });

  it("bounds each recovered flush so a large outbox yields back to the UI", async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      item({
        createdAt: 30 - index,
        request: {
          ...request,
          clientCaptureId: `cap_01J6M9Q7G4BMKB33GSG3NJ6D${String(index).padStart(2, "0")}`
        }
      })
    );
    const store: CaptureQueueStore = {
      listOutbox: () => Promise.resolve(many),
      updateOutbox: vi.fn()
    };
    const createCapture = vi.fn().mockResolvedValue({});

    await expect(flushCaptureOutbox(store, "profile", { createCapture }, 1_000)).resolves.toEqual({
      attempted: 25,
      failed: 0,
      synced: 25
    });
    expect(createCapture).toHaveBeenCalledTimes(25);
    expect(createCapture).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientCaptureId: many[0]?.request.clientCaptureId })
    );
  });

  it("merges local and remote activity without exposing local plaintext", () => {
    const activity = mergeCaptureActivity(
      [status({ state: "permanent", errorCode: "provider_unavailable" })],
      [
        {
          id: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
          jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
          rawContentPreview: "remote preview",
          source: "web",
          privacy: "ai_assisted",
          clientCreatedAt: "2026-08-30T18:31:00.000Z",
          receivedAt: "2026-08-30T18:31:01.000Z",
          status: "done",
          lastErrorCode: null,
          receiptAvailable: true
        }
      ]
    );
    expect(activity.map(({ id }) => id)).toEqual(["cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y", CAPTURE_ID]);
    expect(activity[1]).not.toHaveProperty("rawContent");
    expect(activity[1]).toMatchObject({
      preview: null,
      serverAvailable: false,
      status: "permanent"
    });
  });

  it("hides tombstoned local and remote rows so a deleted capture cannot ghost", () => {
    const activity = mergeCaptureActivity(
      [status({ state: "synced" })],
      [
        {
          clientCreatedAt: request.clientCreatedAt,
          id: CAPTURE_ID,
          jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
          lastErrorCode: null,
          privacy: "ai_assisted",
          rawContentPreview: "stale server row",
          receiptAvailable: true,
          receivedAt: "2026-08-30T18:31:01.000Z",
          source: "web",
          status: "done"
        }
      ],
      new Set([CAPTURE_ID])
    );
    expect(activity).toEqual([]);
  });
});
