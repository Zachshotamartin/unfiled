import { describe, expect, it, vi } from "vitest";

import type { IndexWorkerClient } from "./index-worker-client";
import { drainIndexWorkerUntilIdle } from "./index-worker-drain";

describe("bounded index worker drain controller", () => {
  it("continues through partial nonzero waves until a zero-claim wave", async () => {
    const client: IndexWorkerClient = {
      drain: vi
        .fn()
        .mockResolvedValueOnce({ claimed: 2, completed: 1, failed: 0, retryScheduled: 1 })
        .mockResolvedValueOnce({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 })
        .mockResolvedValueOnce({ claimed: 0, completed: 0, failed: 0, retryScheduled: 0 })
    };
    const signal = new AbortController().signal;

    await expect(
      drainIndexWorkerUntilIdle({ client, maxWaves: 8, signal, trigger: "recovery" })
    ).resolves.toEqual({
      claimed: 3,
      completed: 2,
      failed: 0,
      retryScheduled: 1,
      waves: 3
    });
    expect(client.drain).toHaveBeenNthCalledWith(1, "recovery", signal);
    expect(client.drain).toHaveBeenCalledTimes(3);
  });

  it("stops after the first zero-claim wave", async () => {
    const client: IndexWorkerClient = {
      drain: vi
        .fn()
        .mockResolvedValueOnce({ claimed: 0, completed: 0, failed: 0, retryScheduled: 0 })
        .mockResolvedValueOnce({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 })
    };

    await expect(
      drainIndexWorkerUntilIdle({
        client,
        maxWaves: 8,
        signal: new AbortController().signal,
        trigger: "manual"
      })
    ).resolves.toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
      retryScheduled: 0,
      waves: 1
    });
    expect(client.drain).toHaveBeenCalledTimes(1);
  });

  it("enforces the wave ceiling while every wave claims work", async () => {
    const client: IndexWorkerClient = {
      drain: vi.fn().mockResolvedValue({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 })
    };
    const result = await drainIndexWorkerUntilIdle({
      client,
      maxWaves: 2,
      signal: new AbortController().signal,
      trigger: "schedule"
    });
    expect(result).toMatchObject({ claimed: 2, completed: 2, waves: 2 });
    expect(client.drain).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid bounds and aborts before calling the worker", async () => {
    const client: IndexWorkerClient = { drain: vi.fn() };
    for (const maxWaves of [0, 9, Number.NaN]) {
      await expect(
        drainIndexWorkerUntilIdle({
          client,
          maxWaves,
          signal: new AbortController().signal,
          trigger: "manual"
        })
      ).rejects.toBeInstanceOf(TypeError);
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      drainIndexWorkerUntilIdle({
        client,
        maxWaves: 1,
        signal: controller.signal,
        trigger: "manual"
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(client.drain).not.toHaveBeenCalled();
  });
});
