import { describe, expect, it } from "vitest";

import {
  GenerationVerificationError,
  VerifierConfigurationError,
  VerifierError,
  VerifierUnavailableError,
  classifyVerifierError
} from "../src/errors";
import { createStructuredLogger } from "../src/logging";

describe("verifier error and telemetry redaction", () => {
  it("classifies only stable safe error metadata", () => {
    expect(classifyVerifierError(new VerifierConfigurationError(["SECRET_NAME"]))).toMatchObject({
      code: "configuration_error",
      errorClass: "configuration",
      status: 503
    });
    expect(classifyVerifierError(new VerifierUnavailableError())).toMatchObject({
      errorClass: "unavailable",
      retryable: true
    });
    expect(classifyVerifierError(new GenerationVerificationError())).toMatchObject({
      code: "generation_invalid",
      errorClass: "generation",
      status: 409
    });
    expect(
      classifyVerifierError(
        new VerifierError(504, "request_timeout", "canary", { retryable: true })
      )
    ).toMatchObject({ errorClass: "timeout", status: 504 });
    expect(classifyVerifierError(new Error("plaintext-secret-canary"))).toEqual({
      code: "provider_unavailable",
      errorClass: "unknown",
      retryable: true,
      status: 500
    });
  });

  it("serializes only allowlisted operational fields", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger(
      (line) => lines.push(line),
      () => new Date("2026-08-31T12:00:00.000Z")
    );
    logger.log({
      durationMs: 12,
      event: "request.completed",
      level: "info",
      method: "POST",
      outcome: "ok",
      requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      route: "internal_verify",
      runtime: "production",
      status: 200
    });
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      durationMs: 12,
      event: "request.completed",
      level: "info",
      method: "POST",
      outcome: "ok",
      requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      route: "internal_verify",
      runtime: "production",
      service: "unfiled-rag-verifier",
      status: 200,
      timestamp: "2026-08-31T12:00:00.000Z"
    });
    expect(lines[0]).not.toContain("ownerId");
    expect(lines[0]).not.toContain("generationId");
    expect(lines[0]).not.toContain("attestation");
  });
});
