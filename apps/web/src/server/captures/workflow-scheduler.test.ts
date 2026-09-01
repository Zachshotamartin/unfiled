import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrganizerClient } from "./organizer-client";

const mocks = vi.hoisted(() => ({
  wakeIndex: vi.fn<() => Promise<void>>()
}));

vi.mock("@/server/indexing/index-worker-scheduler", () => ({
  runIndexDrainWakeup: mocks.wakeIndex
}));

import { scheduleCaptureDrain } from "./workflow-scheduler";

const PRODUCTION = Object.freeze({ VERCEL: "1", VERCEL_ENV: "production" });

function organizer(completed = 1): OrganizerClient {
  return {
    drain: vi.fn().mockResolvedValue({
      claimed: completed,
      completed,
      failed: 0,
      retryScheduled: 0
    })
  };
}

describe("isolated organizer scheduler", () => {
  beforeEach(() => {
    mocks.wakeIndex.mockReset();
    mocks.wakeIndex.mockResolvedValue();
  });

  it("defers one bounded production organizer invocation without chaining another drain", async () => {
    let scheduled: (() => Promise<void>) | undefined;
    const client = organizer();
    const defer = vi.fn((callback: () => Promise<void>) => {
      scheduled = callback;
    });

    scheduleCaptureDrain({ client, defer, environment: PRODUCTION });

    expect(defer).toHaveBeenCalledOnce();
    if (scheduled === undefined) throw new TypeError("callback was not scheduled");
    await expect(scheduled()).resolves.toBeUndefined();
    expect(client.drain).toHaveBeenCalledWith("schedule", expect.any(AbortSignal));
    expect(client.drain).toHaveBeenCalledOnce();
    expect(mocks.wakeIndex).not.toHaveBeenCalled();
  });

  it("does not wake indexing when the organizer completed no note mutations", async () => {
    let scheduled: (() => Promise<void>) | undefined;
    const client = organizer(0);
    scheduleCaptureDrain({
      client,
      environment: PRODUCTION,
      defer: (callback) => {
        scheduled = callback;
      }
    });

    if (scheduled === undefined) throw new TypeError("callback was not scheduled");
    await expect(scheduled()).resolves.toBeUndefined();
    expect(mocks.wakeIndex).not.toHaveBeenCalled();
  });

  it("preserves the durable job if scheduling or organizer invocation fails", async () => {
    expect(() =>
      scheduleCaptureDrain({
        client: organizer(),
        environment: PRODUCTION,
        defer: () => {
          throw new Error("request lifecycle unavailable");
        }
      })
    ).not.toThrow();

    let scheduled: (() => Promise<void>) | undefined;
    scheduleCaptureDrain({
      client: { drain: vi.fn().mockRejectedValue(new Error("temporary organizer outage")) },
      environment: PRODUCTION,
      defer: (callback) => {
        scheduled = callback;
      }
    });

    if (scheduled === undefined) throw new TypeError("callback was not scheduled");
    await expect(scheduled()).resolves.toBeUndefined();
    expect(mocks.wakeIndex).not.toHaveBeenCalled();
  });

  it("keeps the deterministic in-process drain only outside Vercel Production", async () => {
    let scheduled: (() => Promise<void>) | undefined;
    const client = organizer();
    const localDrain = vi.fn().mockResolvedValue({
      claimed: 1,
      completed: 1,
      failed: 0,
      retryScheduled: 0
    });
    scheduleCaptureDrain({
      client,
      environment: { VERCEL: "1", VERCEL_ENV: "preview" },
      localDrain,
      defer: (callback) => {
        scheduled = callback;
      }
    });

    if (scheduled === undefined) throw new TypeError("callback was not scheduled");
    await expect(scheduled()).resolves.toBeUndefined();
    expect(localDrain).toHaveBeenCalledOnce();
    expect(client.drain).not.toHaveBeenCalled();
    expect(mocks.wakeIndex).toHaveBeenCalledOnce();
  });

  it("leaves production indexing to its durable authenticated recovery cron", async () => {
    let scheduled: (() => Promise<void>) | undefined;
    scheduleCaptureDrain({
      client: organizer(1),
      environment: PRODUCTION,
      defer: (callback) => {
        scheduled = callback;
      }
    });

    if (scheduled === undefined) throw new TypeError("callback was not scheduled");
    await expect(scheduled()).resolves.toBeUndefined();
    expect(mocks.wakeIndex).not.toHaveBeenCalled();
  });
});
