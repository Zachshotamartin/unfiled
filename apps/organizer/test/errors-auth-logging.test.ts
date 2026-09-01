import { describe, expect, it, vi } from "vitest";

import { hasValidBearerCredential } from "../src/auth.js";
import {
  classifyOrganizerError,
  OrganizerConfigurationError,
  OrganizerError,
  OrganizerUnavailableError
} from "../src/errors.js";
import { createStructuredLogger } from "../src/logging.js";

describe("safe error taxonomy", () => {
  it("classifies configuration, availability, timeout, http, and unknown failures", () => {
    expect(classifyOrganizerError(new OrganizerConfigurationError(["SECRET"]))).toMatchObject({
      code: "configuration_error",
      errorClass: "configuration",
      status: 503
    });
    expect(classifyOrganizerError(new OrganizerUnavailableError())).toMatchObject({
      code: "provider_unavailable",
      errorClass: "unavailable",
      retryable: true
    });
    expect(
      classifyOrganizerError(new OrganizerError(504, "request_timeout", "private"))
    ).toMatchObject({ errorClass: "timeout" });
    expect(
      classifyOrganizerError(new OrganizerError(400, "validation_failed", "private"))
    ).toMatchObject({ errorClass: "http" });
    expect(classifyOrganizerError(new Error("capture text"))).toEqual({
      code: "provider_unavailable",
      errorClass: "unknown",
      retryable: true,
      status: 500
    });
  });
  it("never places failure messages in structured output", () => {
    const sink = vi.fn();
    const logger = createStructuredLogger(sink, () => new Date("2026-08-31T20:00:00.000Z"));
    logger.log({
      durationMs: 5,
      errorClass: "unknown",
      event: "request.completed",
      level: "error",
      method: "POST",
      outcome: "error",
      requestId: "request",
      retryable: true,
      route: "internal_drain",
      runtime: "production",
      status: 500
    });
    const line = sink.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line)).toEqual({
      durationMs: 5,
      errorClass: "unknown",
      event: "request.completed",
      level: "error",
      method: "POST",
      outcome: "error",
      requestId: "request",
      retryable: true,
      route: "internal_drain",
      runtime: "production",
      service: "unfiled-organizer",
      status: 500,
      timestamp: "2026-08-31T20:00:00.000Z"
    });
    expect(line).not.toContain("capture");
  });
});

describe("local bearer comparison", () => {
  const secret = "local-organizer-secret-at-least-32-characters";
  it("accepts only exact Bearer syntax", () => {
    expect(hasValidBearerCredential(`Bearer ${secret}`, secret)).toBe(true);
    expect(hasValidBearerCredential(`bearer ${secret}`, secret)).toBe(false);
    expect(hasValidBearerCredential(`Bearer  ${secret}`, secret)).toBe(false);
    expect(hasValidBearerCredential(null, secret)).toBe(false);
  });
  it("bounds attacker-controlled authorization values", () => {
    expect(hasValidBearerCredential(`Bearer ${"x".repeat(3_000)}`, secret)).toBe(false);
  });
});
