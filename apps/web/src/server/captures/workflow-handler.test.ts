import { describe, expect, it, vi } from "vitest";

import { createCaptureWorkflowHandler } from "./workflow-handler";

const SECRET = "capture-workflow-test-secret-is-long-enough";

function request(authorization?: string): Request {
  return new Request("https://unfiled.test/api/internal/captures/drain", {
    headers: authorization === undefined ? {} : { authorization }
  });
}

describe("capture workflow handler", () => {
  it("fails closed for missing configuration and unauthorized requests", async () => {
    const drain = vi.fn();
    const missing = createCaptureWorkflowHandler({ getSecret: () => undefined, drain });
    const configured = createCaptureWorkflowHandler({ getSecret: () => SECRET, drain });

    const missingResponse = await missing(request());
    const unauthorized = await configured(request("Bearer incorrect"));

    expect(missingResponse.status).toBe(503);
    expect(unauthorized.status).toBe(401);
    expect(drain).not.toHaveBeenCalled();
  });

  it("runs one authenticated, content-free drain and disables caching", async () => {
    const drain = vi.fn().mockResolvedValue({
      claimed: 3,
      completed: 2,
      failed: 0,
      retryScheduled: 1
    });
    const scheduleIndexDrain = vi.fn();
    const handler = createCaptureWorkflowHandler({
      getSecret: () => SECRET,
      drain,
      scheduleIndexDrain
    });

    const response = await handler(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      claimed: 3,
      completed: 2,
      failed: 0,
      retryScheduled: 1
    });
    expect(drain).toHaveBeenCalledOnce();
    expect(scheduleIndexDrain).toHaveBeenCalledOnce();
    expect(scheduleIndexDrain).toHaveBeenCalledWith();
  });

  it("does not wake indexing when capture processing completed no durable jobs", async () => {
    const scheduleIndexDrain = vi.fn();
    const handler = createCaptureWorkflowHandler({
      getSecret: () => SECRET,
      drain: vi.fn().mockResolvedValue({
        claimed: 0,
        completed: 0,
        failed: 0,
        retryScheduled: 0
      }),
      scheduleIndexDrain
    });
    expect((await handler(request(`Bearer ${SECRET}`))).status).toBe(200);
    expect(scheduleIndexDrain).not.toHaveBeenCalled();
  });

  it("redacts unexpected drain failures", async () => {
    const handler = createCaptureWorkflowHandler({
      getSecret: () => SECRET,
      drain: vi.fn().mockRejectedValue(new Error("plaintext should never appear")),
      scheduleIndexDrain: vi.fn()
    });

    const response = await handler(request(`Bearer ${SECRET}`));
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(500);
    expect(body.message).not.toContain("plaintext");
  });
});
