import { ApiClientError } from "@unfiled/api-client";
import {
  captureV1Fixture,
  captureV1ResponseFixture,
  type ApiErrorCodeValue,
  type CaptureCreateResponse
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  CaptureOutboxRecord,
  CaptureOutboxState
} from "../src/features/capture/captureOutboxTypes";
import {
  classifyCaptureSyncFailure,
  drainCaptureOutbox,
  type CaptureOutboxStore
} from "../src/features/capture/captureOutboxCoordinator";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";

function outboxRecord(state: CaptureOutboxState = "queued", attemptCount = 0): CaptureOutboxRecord {
  return {
    attemptCount,
    capture: captureV1Fixture,
    lastErrorCode: null,
    nextAttemptAt: null,
    profileId: PROFILE_ID,
    serverAcknowledgedAt: null,
    serverCaptureId: null,
    serverJobId: null,
    state
  };
}

class MemoryOutboxStore implements CaptureOutboxStore {
  public entry: CaptureOutboxRecord | null;
  public recoverCount = 0;

  public constructor(entry: CaptureOutboxRecord | null) {
    this.entry = entry;
  }

  public recover(profileId: string): Promise<void> {
    expect(profileId).toBe(PROFILE_ID);
    this.recoverCount += 1;
    if (this.entry?.state === "syncing") {
      this.entry = { ...this.entry, nextAttemptAt: null, state: "queued" };
    }
    return Promise.resolve();
  }

  public claimNext(profileId: string, now: string): Promise<CaptureOutboxRecord | null> {
    expect(profileId).toBe(PROFILE_ID);
    const entry = this.entry;
    if (entry === null || (entry.state !== "queued" && entry.state !== "retry_wait")) {
      return Promise.resolve(null);
    }
    if (entry.state === "retry_wait" && (entry.nextAttemptAt ?? "") > now) {
      return Promise.resolve(null);
    }
    const claimed = { ...entry, attemptCount: entry.attemptCount + 1, state: "syncing" } as const;
    this.entry = claimed;
    return Promise.resolve(claimed);
  }

  public markPermanentFailure(
    profileId: string,
    captureId: string,
    code: ApiErrorCodeValue
  ): Promise<void> {
    this.assertIdentity(profileId, captureId);
    if (this.entry !== null) {
      this.entry = { ...this.entry, lastErrorCode: code, state: "permanent_failure" };
    }
    return Promise.resolve();
  }

  public markRetry(
    profileId: string,
    captureId: string,
    code: ApiErrorCodeValue,
    nextAttemptAt: string
  ): Promise<void> {
    this.assertIdentity(profileId, captureId);
    if (this.entry !== null) {
      this.entry = { ...this.entry, lastErrorCode: code, nextAttemptAt, state: "retry_wait" };
    }
    return Promise.resolve();
  }

  public markSynced(
    profileId: string,
    captureId: string,
    response: CaptureCreateResponse,
    acknowledgedAt = "2026-08-30T18:30:02.000Z"
  ): Promise<void> {
    this.assertIdentity(profileId, captureId);
    if (this.entry !== null) {
      this.entry = {
        ...this.entry,
        lastErrorCode: null,
        nextAttemptAt: null,
        serverAcknowledgedAt: acknowledgedAt,
        serverCaptureId: response.capture.id,
        serverJobId: response.jobId,
        state: "synced"
      };
    }
    return Promise.resolve();
  }

  public markWaitingForSignIn(profileId: string, captureId: string): Promise<void> {
    this.assertIdentity(profileId, captureId);
    if (this.entry !== null) this.entry = { ...this.entry, state: "waiting_for_sign_in" };
    return Promise.resolve();
  }

  private assertIdentity(profileId: string, captureId: string): void {
    expect(profileId).toBe(PROFILE_ID);
    expect(captureId).toBe(captureV1Fixture.clientCaptureId);
  }
}

function apiError(status: number, code: ApiErrorCodeValue, retryAfterSeconds?: number) {
  return new ApiClientError(status, {
    code,
    message: "Request failed",
    requestId: "req_test",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  });
}

describe("capture outbox coordinator", () => {
  it("recovers an interrupted lease and accepts an idempotent replay exactly once", async () => {
    const store = new MemoryOutboxStore(outboxRecord("syncing", 1));
    const response = { ...captureV1ResponseFixture, replayed: true };
    const send = vi.fn().mockResolvedValue(response);

    const summary = await drainCaptureOutbox({ profileId: PROFILE_ID, send, store });

    expect(store.recoverCount).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(captureV1Fixture);
    expect(summary).toMatchObject({ attempted: 1, synced: 1 });
    expect(store.entry?.state).toBe("synced");
  });

  it("uses bounded retry timing and does not retry before the durable due time", async () => {
    let now = Date.parse("2026-08-30T18:30:00.000Z");
    const store = new MemoryOutboxStore(outboxRecord());
    const send = vi
      .fn<() => Promise<CaptureCreateResponse>>()
      .mockRejectedValueOnce(apiError(503, "provider_unavailable", 600))
      .mockResolvedValueOnce(captureV1ResponseFixture);

    const first = await drainCaptureOutbox({ now: () => now, profileId: PROFILE_ID, send, store });
    expect(first.scheduledForRetry).toBe(1);
    expect(store.entry?.nextAttemptAt).toBe("2026-08-30T18:32:00.000Z");

    now += 119_000;
    const early = await drainCaptureOutbox({ now: () => now, profileId: PROFILE_ID, send, store });
    expect(early.attempted).toBe(0);

    now += 1_000;
    const recovered = await drainCaptureOutbox({
      now: () => now,
      profileId: PROFILE_ID,
      send,
      store
    });
    expect(recovered.synced).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps offline captures durable beyond five attempts and syncs after reconnection", async () => {
    let now = Date.parse("2026-08-30T18:30:00.000Z");
    const store = new MemoryOutboxStore(outboxRecord());
    const send = vi
      .fn<() => Promise<CaptureCreateResponse>>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(captureV1ResponseFixture);

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const summary = await drainCaptureOutbox({
        now: () => now,
        profileId: PROFILE_ID,
        send,
        store
      });
      expect(summary).toMatchObject({ failedPermanently: 0, scheduledForRetry: 1 });
      expect(store.entry).toMatchObject({ attemptCount: attempt, state: "retry_wait" });
      now += 120_000;
    }

    const reconnected = await drainCaptureOutbox({
      now: () => now,
      profileId: PROFILE_ID,
      send,
      store
    });
    expect(reconnected.synced).toBe(1);
    expect(store.entry).toMatchObject({ attemptCount: 7, state: "synced" });
    expect(send).toHaveBeenCalledTimes(7);
  });

  it("keeps the bounded attempt limit for retryable server failures", async () => {
    let now = Date.parse("2026-08-30T18:30:00.000Z");
    const store = new MemoryOutboxStore(outboxRecord());
    const send = vi.fn(() => Promise.reject(apiError(503, "provider_unavailable")));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const summary = await drainCaptureOutbox({
        now: () => now,
        profileId: PROFILE_ID,
        send,
        store
      });
      if (attempt < 5) expect(summary.scheduledForRetry).toBe(1);
      else expect(summary.failedPermanently).toBe(1);
      now += 120_000;
    }

    expect(store.entry).toMatchObject({ attemptCount: 5, state: "permanent_failure" });
  });

  it("marks non-retryable validation failures for a safe manual retry", async () => {
    const store = new MemoryOutboxStore(outboxRecord());
    const summary = await drainCaptureOutbox({
      profileId: PROFILE_ID,
      send: () => Promise.reject(apiError(400, "invalid_capture")),
      store
    });

    expect(summary.failedPermanently).toBe(1);
    expect(store.entry).toMatchObject({
      lastErrorCode: "invalid_capture",
      state: "permanent_failure"
    });
  });

  it("returns an unauthorized entry to the account-isolated waiting state", async () => {
    const store = new MemoryOutboxStore(outboxRecord());
    const send = vi.fn(() => Promise.reject(apiError(401, "unauthorized")));
    const summary = await drainCaptureOutbox({
      profileId: PROFILE_ID,
      send,
      store
    });

    expect(summary.waitingForSignIn).toBe(true);
    expect(store.entry?.state).toBe("waiting_for_sign_in");

    const repeated = await drainCaptureOutbox({ profileId: PROFILE_ID, send, store });
    expect(repeated.attempted).toBe(0);
    expect(send).toHaveBeenCalledOnce();
  });

  it("classifies offline errors without exposing their messages", () => {
    expect(classifyCaptureSyncFailure(new Error("secret network detail"))).toEqual({
      attemptLimit: null,
      code: "offline",
      disposition: "retry",
      retryAfterMilliseconds: null
    });
  });
});
