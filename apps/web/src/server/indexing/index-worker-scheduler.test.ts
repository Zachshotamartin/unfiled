import { describe, expect, it, vi } from "vitest";

import type { IndexWorkerClient } from "./index-worker-client";
import { scheduleIndexDrain } from "./index-worker-scheduler";

describe("post-commit index worker scheduler", () => {
  it("defers a bounded content-free drain", async () => {
    let task: (() => Promise<void>) | undefined;
    const client: IndexWorkerClient = {
      drain: vi.fn().mockResolvedValue({ claimed: 0, completed: 0, failed: 0, retryScheduled: 0 })
    };
    const defer = vi.fn((callback: () => Promise<void>) => {
      task = callback;
    });

    scheduleIndexDrain({ client, defer });
    expect(defer).toHaveBeenCalledOnce();
    await expect(task?.()).resolves.toBeUndefined();
    expect(client.drain).toHaveBeenCalledWith("schedule", expect.any(AbortSignal));
    expect(client.drain).toHaveBeenCalledTimes(1);
  });

  it("never throws when defer or the best-effort invocation fails", async () => {
    expect(() =>
      scheduleIndexDrain({
        client: { drain: vi.fn() },
        defer: () => {
          throw new Error("no request lifecycle");
        }
      })
    ).not.toThrow();

    let task: (() => Promise<void>) | undefined;
    scheduleIndexDrain({
      client: { drain: vi.fn().mockRejectedValue(new Error("worker unavailable")) },
      defer: (callback) => {
        task = callback;
      }
    });
    await expect(task?.()).resolves.toBeUndefined();
  });
});
