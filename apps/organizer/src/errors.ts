export type OrganizerErrorCode =
  | "configuration_error"
  | "method_not_allowed"
  | "not_found"
  | "provider_unavailable"
  | "request_too_large"
  | "request_timeout"
  | "unauthorized"
  | "validation_failed";

export class OrganizerError extends Error {
  public readonly code: OrganizerErrorCode;
  public readonly retryable: boolean;
  public readonly status: number;

  public constructor(
    status: number,
    code: OrganizerErrorCode,
    message: string,
    options: Readonly<{ retryable?: boolean }> = {}
  ) {
    super(message);
    this.name = "OrganizerError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = status;
  }
}

export class OrganizerConfigurationError extends OrganizerError {
  public constructor(variableNames: readonly string[]) {
    const suffix = variableNames.length === 0 ? "" : ` (${variableNames.join(", ")})`;
    super(503, "configuration_error", `The organizer configuration is invalid${suffix}.`, {
      retryable: true
    });
    this.name = "OrganizerConfigurationError";
  }
}

export class OrganizerUnavailableError extends OrganizerError {
  public constructor() {
    super(503, "provider_unavailable", "The organizer is not ready.", { retryable: true });
    this.name = "OrganizerUnavailableError";
  }
}

/**
 * The identifiers a provider attaches to its own request-validation failure (`error.type`,
 * `error.code`, `error.param`) and, only when the message begins with "Invalid schema", that
 * message, which names keywords of the organizer's schema and never user content.
 */
export type OrganizerProviderErrorIdentity = Readonly<{
  type?: string;
  code?: string;
  param?: string;
  schemaError?: string;
}>;

export type OrganizerProviderFailureCode =
  "provider_key_invalid" | "provider_unavailable" | "rate_limited" | "validation_failed";

/** Safe internal provider failure. It never retains provider or user content. */
export class OrganizerProviderError extends Error {
  public readonly retryable: boolean;
  public readonly safeCode: OrganizerProviderFailureCode;
  public readonly status: number | null;
  public readonly identity: OrganizerProviderErrorIdentity | null;

  public constructor(
    safeCode: OrganizerProviderFailureCode,
    retryable: boolean,
    status: number | null = null,
    identity: OrganizerProviderErrorIdentity | null = null
  ) {
    super("The organizer provider request failed.");
    this.name = "OrganizerProviderError";
    this.retryable = retryable;
    this.safeCode = safeCode;
    this.status = status;
    this.identity = identity;
  }
}

export type OrganizerPlannerReviewReason =
  "incomplete" | "input_bounds" | "invalid_output" | "refusal";

/** A safe planner outcome that must become Review rather than a job failure. */
export class OrganizerPlannerReviewError extends Error {
  public readonly reason: OrganizerPlannerReviewReason;

  public constructor(reason: OrganizerPlannerReviewReason) {
    super("The organizer planner deferred this capture for review.");
    this.name = "OrganizerPlannerReviewError";
    this.reason = reason;
  }
}

export type OrganizerFailure = Readonly<{
  code: OrganizerErrorCode;
  errorClass: "configuration" | "http" | "timeout" | "unknown" | "unavailable";
  retryable: boolean;
  status: number;
}>;

export function classifyOrganizerError(error: unknown): OrganizerFailure {
  if (error instanceof OrganizerConfigurationError) {
    return {
      code: error.code,
      errorClass: "configuration",
      retryable: error.retryable,
      status: error.status
    };
  }
  if (error instanceof OrganizerUnavailableError) {
    return {
      code: error.code,
      errorClass: "unavailable",
      retryable: error.retryable,
      status: error.status
    };
  }
  if (error instanceof OrganizerError) {
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
