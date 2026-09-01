export type VerifierErrorCode =
  | "configuration_error"
  | "generation_invalid"
  | "method_not_allowed"
  | "not_found"
  | "provider_unavailable"
  | "request_too_large"
  | "request_timeout"
  | "unauthorized"
  | "validation_failed";

export class VerifierError extends Error {
  readonly code: VerifierErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    status: number,
    code: VerifierErrorCode,
    message: string,
    options: Readonly<{ retryable?: boolean }> = {}
  ) {
    super(message);
    this.name = "VerifierError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = status;
  }
}

export class VerifierConfigurationError extends VerifierError {
  constructor(variableNames: readonly string[]) {
    const suffix = variableNames.length === 0 ? "" : ` (${variableNames.join(", ")})`;
    super(503, "configuration_error", `The verifier configuration is invalid${suffix}.`, {
      retryable: true
    });
    this.name = "VerifierConfigurationError";
  }
}

export class VerifierUnavailableError extends VerifierError {
  constructor() {
    super(503, "provider_unavailable", "The verifier is not ready.", { retryable: true });
    this.name = "VerifierUnavailableError";
  }
}

export class GenerationVerificationError extends VerifierError {
  constructor() {
    super(409, "generation_invalid", "The encrypted generation could not be verified.");
    this.name = "GenerationVerificationError";
  }
}

export function classifyVerifierError(error: unknown): Readonly<{
  code: VerifierErrorCode;
  errorClass: "configuration" | "generation" | "http" | "timeout" | "unknown" | "unavailable";
  retryable: boolean;
  status: number;
}> {
  if (error instanceof VerifierConfigurationError) {
    return {
      code: error.code,
      errorClass: "configuration",
      retryable: error.retryable,
      status: error.status
    };
  }
  if (error instanceof VerifierUnavailableError) {
    return {
      code: error.code,
      errorClass: "unavailable",
      retryable: error.retryable,
      status: error.status
    };
  }
  if (error instanceof GenerationVerificationError) {
    return {
      code: error.code,
      errorClass: "generation",
      retryable: error.retryable,
      status: error.status
    };
  }
  if (error instanceof VerifierError) {
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
