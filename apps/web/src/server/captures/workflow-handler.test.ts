import { afterEach, describe, expect, it, vi } from "vitest";

import { OrganizerInvocationError } from "./organizer-client";
import { createCaptureWorkflowHandler } from "./workflow-handler";

const SECRET = "capture-workflow-test-secret-is-long-enough";

function request(authorization?: string): Request {
  return new Request("https://unfiled.test/api/internal/captures/drain", {
    headers: authorization === undefined ? {} : { authorization }
  });
}

describe("capture workflow handler", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    const handler = createCaptureWorkflowHandler({
      getSecret: () => SECRET,
      drain
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
  });

  it.each(["production", "preview", "development"])(
    "uses only the isolated organizer in the %s environment",
    async (vercelEnvironment) => {
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("VERCEL_ENV", vercelEnvironment);
      const client = {
        drain: vi.fn().mockResolvedValue({
          claimed: 1,
          completed: 1,
          failed: 0,
          retryScheduled: 0
        })
      };
      const handler = createCaptureWorkflowHandler({
        client,
        getSecret: () => SECRET
      });

      expect((await handler(request(`Bearer ${SECRET}`))).status).toBe(200);
      expect(client.drain).toHaveBeenCalledWith("recovery", expect.any(AbortSignal));
      expect(client.drain).toHaveBeenCalledOnce();
    }
  );

  it("uses an explicit drain injection without adding another workflow", async () => {
    const client = {
      drain: vi.fn().mockResolvedValue({
        claimed: 1,
        completed: 1,
        failed: 0,
        retryScheduled: 0
      })
    };
    const drain = vi.fn().mockResolvedValue({
      claimed: 0,
      completed: 0,
      failed: 0,
      retryScheduled: 0
    });
    const handler = createCaptureWorkflowHandler({
      client,
      getSecret: () => SECRET,
      drain
    });

    expect((await handler(request(`Bearer ${SECRET}`))).status).toBe(200);
    expect(drain).toHaveBeenCalledOnce();
    expect(client.drain).not.toHaveBeenCalled();
  });

  it("redacts unexpected drain failures", async () => {
    const handler = createCaptureWorkflowHandler({
      getSecret: () => SECRET,
      drain: vi.fn().mockRejectedValue(new Error("plaintext should never appear"))
    });

    const response = await handler(request(`Bearer ${SECRET}`));
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(500);
    expect(body.message).not.toContain("plaintext");
  });

  it("maps an isolated organizer outage to a retryable unavailable response", async () => {
    const handler = createCaptureWorkflowHandler({
      getSecret: () => SECRET,
      drain: vi.fn().mockRejectedValue(new OrganizerInvocationError())
    });

    const response = await handler(request(`Bearer ${SECRET}`));
    const body = (await response.json()) as { code: string; message: string };

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.code).toBe("provider_unavailable");
    expect(body.message).not.toContain("capture");
  });
});
