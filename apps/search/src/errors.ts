export type SearchServiceErrorCode =
  | "configuration_error"
  | "method_not_allowed"
  | "not_found"
  | "provider_unavailable"
  | "rate_limited"
  | "request_timeout"
  | "request_too_large"
  | "unauthorized"
  | "validation_failed";

export class SearchServiceError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: SearchServiceErrorCode,
    options: Readonly<{ retryable?: boolean }> = {}
  ) {
    super("The encrypted search service could not complete the request.");
    this.name = "SearchServiceError";
    this.retryable = options.retryable ?? false;
  }

  public readonly retryable: boolean;
}

export class SearchConfigurationError extends Error {
  public constructor() {
    super("The encrypted search service is not configured.");
    this.name = "SearchConfigurationError";
  }
}

export function classifySearchError(error: unknown): Readonly<{
  code: SearchServiceErrorCode;
  errorClass: string;
  retryable: boolean;
  status: number;
}> {
  if (error instanceof SearchServiceError) {
    return {
      code: error.code,
      errorClass: error.name,
      retryable: error.retryable,
      status: error.status
    };
  }
  if (error instanceof SearchConfigurationError) {
    return {
      code: "configuration_error",
      errorClass: error.name,
      retryable: true,
      status: 503
    };
  }
  return {
    code: "provider_unavailable",
    errorClass: error instanceof Error ? error.name : "UnknownError",
    retryable: true,
    status: 503
  };
}

export function unavailable(): never {
  throw new SearchServiceError(503, "provider_unavailable", { retryable: true });
}

export function invalid(): never {
  throw new SearchServiceError(400, "validation_failed");
}
