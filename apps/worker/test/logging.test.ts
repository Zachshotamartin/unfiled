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
});
