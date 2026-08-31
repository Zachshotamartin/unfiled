import { describe, expect, it } from "vitest";

import {
  classifyWorkerError,
  WorkerConfigurationError,
  WorkerError,
  WorkerUnavailableError
} from "../src/errors";

describe("worker errors", () => {
  it("classifies known failures without carrying cause text", () => {
    expect(classifyWorkerError(new WorkerConfigurationError(["UNFILED_AWS_REGION"]))).toMatchObject(
      {
        errorClass: "configuration",
        status: 503
      }
    );
    expect(classifyWorkerError(new WorkerUnavailableError())).toMatchObject({
      errorClass: "unavailable",
      status: 503
    });
    expect(
      classifyWorkerError(new WorkerError(504, "request_timeout", "private-plaintext-canary"))
    ).toMatchObject({ errorClass: "timeout", status: 504 });
    expect(classifyWorkerError(new WorkerError(400, "validation_failed", "bad"))).toMatchObject({
      errorClass: "http",
      status: 400
    });
    expect(classifyWorkerError(new Error("private-plaintext-canary"))).toEqual({
      code: "provider_unavailable",
      errorClass: "unknown",
      retryable: true,
      status: 500
    });
  });
});
