import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn<(callback: () => Promise<void>) => void>(),
  drain: vi.fn<() => Promise<unknown>>()
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("./workflow", () => ({ drainCaptureJobs: mocks.drain }));

import { scheduleCaptureDrain } from "./workflow-scheduler";

describe("capture workflow scheduler", () => {
  beforeEach(() => {
    mocks.after.mockReset();
    mocks.drain.mockReset();
  });

  it("registers a Next after callback and drains without retaining request content", async () => {
    let scheduled: (() => Promise<void>) | undefined;
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    mocks.drain.mockResolvedValue({ claimed: 1 });

    scheduleCaptureDrain();

    expect(mocks.after).toHaveBeenCalledOnce();
    if (scheduled === undefined) throw new TypeError("callback was not scheduled");
    await expect(scheduled()).resolves.toBeUndefined();
    expect(mocks.drain).toHaveBeenCalledOnce();
  });

  it("preserves the durable job if scheduling or prompt drain fails", async () => {
    mocks.after.mockImplementationOnce(() => {
      throw new Error("request lifecycle unavailable");
    });
    expect(scheduleCaptureDrain).not.toThrow();

    let scheduled: (() => Promise<void>) | undefined;
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    mocks.drain.mockRejectedValue(new Error("temporary provider outage"));
    scheduleCaptureDrain();

    if (scheduled === undefined) throw new TypeError("callback was not scheduled");
    await expect(scheduled()).resolves.toBeUndefined();
  });
});
