import { describe, expect, it, vi } from "vitest";

import { createStructuredLogger } from "../src/logging";

describe("structured worker logging", () => {
  it("serializes only the operational allowlist", () => {
    const sink = vi.fn();
    const logger = createStructuredLogger(sink, () => new Date("2026-08-30T12:00:00.000Z"));
    logger.log({
      authorization: "Bearer private-plaintext-canary",
      body: "private-plaintext-canary",
      durationMs: 12,
      event: "request.completed",
      level: "info",
      method: "POST",
      outcome: "ok",
      requestId: "request-1",
      route: "internal_drain",
      runtime: "preview",
      status: 200
    } as never);

    const serialized = String(sink.mock.calls[0]?.[0]);
    expect(JSON.parse(serialized)).toEqual({
      durationMs: 12,
      event: "request.completed",
      level: "info",
      method: "POST",
      outcome: "ok",
      requestId: "request-1",
      route: "internal_drain",
      runtime: "preview",
      service: "unfiled-worker",
      status: 200,
      timestamp: "2026-08-30T12:00:00.000Z"
    });
    expect(serialized).not.toContain("private-plaintext-canary");
  });

  it("includes only the optional operational error fields when supplied", () => {
    const sink = vi.fn();
    const logger = createStructuredLogger(sink, () => new Date("2026-08-30T12:00:00.000Z"));

    logger.log({
      durationMs: 25_000,
      errorClass: "timeout",
      event: "request.completed",
      level: "error",
      method: "POST",
      outcome: "error",
      requestId: "request-2",
      retryable: true,
      route: "internal_drain",
      runtime: "production",
      status: 504
    });

    expect(JSON.parse(String(sink.mock.calls[0]?.[0]))).toMatchObject({
      errorClass: "timeout",
      retryable: true,
      service: "unfiled-worker"
    });
  });

  it("uses the default console sink and clock without adding unsafe fields", () => {
    const consoleSink = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      createStructuredLogger().log({
        durationMs: 0,
        event: "request.completed",
        level: "info",
        method: "GET",
        outcome: "ok",
        requestId: "request-default-sink",
        route: "health",
        runtime: "local",
        status: 200
      });

      expect(consoleSink).toHaveBeenCalledOnce();
      const parsed = JSON.parse(String(consoleSink.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        event: "request.completed",
        requestId: "request-default-sink",
        service: "unfiled-worker"
      });
      expect(typeof parsed.timestamp).toBe("string");
      expect(Object.keys(parsed)).not.toContain("body");
    } finally {
      consoleSink.mockRestore();
    }
  });
});
