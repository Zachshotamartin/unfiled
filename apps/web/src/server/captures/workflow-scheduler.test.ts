import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrganizerClient } from "./organizer-client";

import { scheduleCaptureDrain } from "./workflow-scheduler";

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["production", "preview", "development"])(
    "defers only the isolated organizer in the %s environment",
    async (vercelEnvironment) => {
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("VERCEL_ENV", vercelEnvironment);
      let scheduled: (() => Promise<void>) | undefined;
      const client = organizer();
      const defer = vi.fn((callback: () => Promise<void>) => {
        scheduled = callback;
      });

      scheduleCaptureDrain({ client, defer });

      expect(defer).toHaveBeenCalledOnce();
      if (scheduled === undefined) throw new TypeError("callback was not scheduled");
      await expect(scheduled()).resolves.toBeUndefined();
      expect(client.drain).toHaveBeenCalledWith("schedule", expect.any(AbortSignal));
      expect(client.drain).toHaveBeenCalledOnce();
    }
  );

  it("preserves the durable job if scheduling or organizer invocation fails", async () => {
    expect(() =>
      scheduleCaptureDrain({
        client: organizer(),
        defer: () => {
          throw new Error("request lifecycle unavailable");
        }
      })
    ).not.toThrow();

    let scheduled: (() => Promise<void>) | undefined;
    scheduleCaptureDrain({
      client: { drain: vi.fn().mockRejectedValue(new Error("temporary organizer outage")) },
      defer: (callback) => {
        scheduled = callback;
      }
    });

    if (scheduled === undefined) throw new TypeError("callback was not scheduled");
    await expect(scheduled()).resolves.toBeUndefined();
  });
});
