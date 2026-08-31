import { describe, expect, it, vi } from "vitest";

import { IndexWorkerInvocationError, type IndexWorkerClient } from "./index-worker-client";
import { createIndexWorkerCronHandler } from "./index-worker-cron-handler";

const SECRET = "index-worker-cron-secret-at-least-32-characters";

function request(authorization?: string): Request {
  return new Request("https://unfiled.test/api/internal/indexing/drain", {
    headers: authorization === undefined ? {} : { authorization }
  });
}

describe("index worker recovery cron", () => {
  it("rejects missing and incorrect authorization before invoking the worker", async () => {
    const client: IndexWorkerClient = { drain: vi.fn() };
    const handler = createIndexWorkerCronHandler({ client, getSecret: () => SECRET });
    expect((await handler(request())).status).toBe(401);
    expect((await handler(request("Bearer incorrect"))).status).toBe(401);
    expect(client.drain).not.toHaveBeenCalled();
  });

  it("fails closed when cron configuration is missing", async () => {
    const client: IndexWorkerClient = { drain: vi.fn() };
    const handler = createIndexWorkerCronHandler({ client, getSecret: () => undefined });
    const response = await handler(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "provider_unavailable" });
    expect(client.drain).not.toHaveBeenCalled();
  });

  it("runs bounded recovery waves and returns only aggregate counts", async () => {
    const client: IndexWorkerClient = {
      drain: vi
        .fn()
        .mockResolvedValueOnce({ claimed: 4, completed: 4, failed: 0, retryScheduled: 0 })
        .mockResolvedValueOnce({ claimed: 0, completed: 0, failed: 0, retryScheduled: 0 })
    };
    const handler = createIndexWorkerCronHandler({ client, getSecret: () => SECRET });
    const response = await handler(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      claimed: 4,
      completed: 4,
      failed: 0,
      retryScheduled: 0,
      waves: 2
    });
    expect(client.drain).toHaveBeenCalledTimes(2);
    expect(client.drain).toHaveBeenCalledWith("recovery", expect.any(AbortSignal));
  });

  it("redacts worker failures behind a retryable service response", async () => {
    const client: IndexWorkerClient = {
      drain: vi.fn().mockRejectedValue(new IndexWorkerInvocationError())
    };
    const handler = createIndexWorkerCronHandler({ client, getSecret: () => SECRET });
    const response = await handler(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("token");
  });
});
