export type WorkerErrorCode =
  | "configuration_error"
  | "method_not_allowed"
  | "not_found"
  | "provider_unavailable"
  | "request_too_large"
  | "request_timeout"
  | "unauthorized"
  | "validation_failed";

export class WorkerError extends Error {
  public readonly code: WorkerErrorCode;
  public readonly retryable: boolean;
  public readonly status: number;

  public constructor(
    status: number,
    code: WorkerErrorCode,
    message: string,
    options: Readonly<{ retryable?: boolean }> = {}
  ) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = status;
  }
}

export class WorkerConfigurationError extends WorkerError {
  public constructor(variableNames: readonly string[]) {
    const suffix = variableNames.length === 0 ? "" : ` (${variableNames.join(", ")})`;
    super(503, "configuration_error", `The worker configuration is invalid${suffix}.`, {
      retryable: true
    });
    this.name = "WorkerConfigurationError";
  }
}

export class WorkerUnavailableError extends WorkerError {
  public constructor() {
    super(503, "provider_unavailable", "The worker is not ready.", { retryable: true });
    this.name = "WorkerUnavailableError";
  }
}

export function classifyWorkerError(error: unknown): Readonly<{
  code: WorkerErrorCode;
  errorClass: "configuration" | "http" | "timeout" | "unknown" | "unavailable";
  retryable: boolean;
  status: number;
}> {
  if (error instanceof WorkerConfigurationError) {
    return {
      code: error.code,
      errorClass: "configuration",
      retryable: error.retryable,
      status: error.status
    };
  }
  if (error instanceof WorkerUnavailableError) {
    return {
      code: error.code,
      errorClass: "unavailable",
      retryable: error.retryable,
      status: error.status
    };
  }
  if (error instanceof WorkerError) {
    return {
      code: error.code,
      errorClass: error.code === "request_timeout" ? "timeout" : "http",
      retryable: error.retryable,
      status: error.status
    };
  }
  return {
    code: "provider_unavailable",
    errorClass: "unknown",
    retryable: true,
    status: 500
  };
}
