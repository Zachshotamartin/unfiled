import { ConfigurationError } from "@/server/api/errors";

const FUNCTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/u;

export const ServiceRpcErrorCode = Object.freeze({
  CONFLICT_REQUIRES_REVIEW: "conflict_requires_review",
  FORBIDDEN: "forbidden",
  INVALID_IDEMPOTENCY_KEY: "invalid_idempotency_key",
  KEY_UNAVAILABLE: "key_unavailable",
  NOT_FOUND: "not_found",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  RATE_LIMITED: "rate_limited",
  ROUTING_RULE_DESTINATION_INVALID: "routing_rule_destination_invalid",
  ROUTING_RULE_MATCH_STALE: "routing_rule_match_stale",
  ROUTING_RULE_OBSERVATION_STALE: "routing_rule_observation_stale",
  STALE_MAINTENANCE_CURSOR: "stale_maintenance_cursor",
  STALE_REVISION: "stale_revision",
  UNAUTHORIZED: "unauthorized",
  VALIDATION_FAILED: "validation_failed"
} as const);

export type ServiceRpcErrorCodeValue =
  (typeof ServiceRpcErrorCode)[keyof typeof ServiceRpcErrorCode];

export class ServiceRpcError extends Error {
  public readonly code: ServiceRpcErrorCodeValue;

  public constructor(code: ServiceRpcErrorCodeValue) {
    super("The encrypted data service could not complete the request");
    this.name = "ServiceRpcError";
    this.code = code;
  }
}

export type ServiceRpcClient = Readonly<{
  rpc(functionName: string, parameters: Readonly<Record<string, unknown>>): Promise<unknown>;
}>;

export type ServiceRpcClientOptions = Readonly<{
  allowedFunctions: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  /** Revokes every request made by this capability-scoped client. */
  signal?: AbortSignal;
}>;

export function throwIfServiceOperationAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
  }
}

/**
 * Makes cancellation authoritative even when a composed dependency fails to
 * observe the forwarded signal. The underlying promise remains observed so a
 * late rejection cannot become unhandled after the caller has failed closed.
 */
export function settleServiceOperationBeforeAbort<Result>(
  signal: AbortSignal,
  operation: Promise<Result>
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => {
      finish(() => reject(new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE)));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => {
        if (signal.aborted) onAbort();
        else finish(() => resolve(value));
      },
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE)
          )
        )
    );
  });
}

function configuration(environment: Readonly<Record<string, string | undefined>>): Readonly<{
  serviceRoleKey: string;
  url: string;
}> {
  const rawUrl = environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (rawUrl === undefined || serviceRoleKey === undefined || serviceRoleKey.trim().length < 20) {
    throw new ConfigurationError();
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigurationError();
  }
  const loopbackHttp =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  const builtCiLoopback =
    loopbackHttp &&
    environment.NODE_ENV === "production" &&
    environment.CI === "true" &&
    environment.UNFILED_ALLOW_INSECURE_LOCAL_SUPABASE_E2E === "1" &&
    environment.VERCEL === undefined &&
    environment.VERCEL_ENV === undefined &&
    environment.VERCEL_PROJECT_ID === undefined;
  const localHttp = loopbackHttp && (environment.NODE_ENV !== "production" || builtCiLoopback);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigurationError();
  }
  return {
    serviceRoleKey,
    url: url.origin
  };
}

function databaseError(status: number, body: unknown): ServiceRpcError {
  const message =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as Readonly<Record<string, unknown>>).message === "string"
      ? ((body as Readonly<Record<string, string>>).message ?? "")
      : "";
  if (message.includes("invalid_idempotency_key") || message.includes("capture_id_conflict")) {
    return new ServiceRpcError(ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY);
  }
  if (message.includes("stale_revision")) {
    return new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION);
  }
  if (message.includes("routing_rule_match_stale")) {
    return new ServiceRpcError(ServiceRpcErrorCode.ROUTING_RULE_MATCH_STALE);
  }
  if (message.includes("routing_rule_observation_stale")) {
    return new ServiceRpcError(ServiceRpcErrorCode.ROUTING_RULE_OBSERVATION_STALE);
  }
  if (message.includes("routing_rule_destination_invalid")) {
    return new ServiceRpcError(ServiceRpcErrorCode.ROUTING_RULE_DESTINATION_INVALID);
  }
  if (message.includes("conflict_requires_review")) {
    return new ServiceRpcError(ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW);
  }
  if (message.includes("stale_maintenance_cursor") || message.includes("stale_scrub_cursor")) {
    return new ServiceRpcError(ServiceRpcErrorCode.STALE_MAINTENANCE_CURSOR);
  }
  if (
    message.includes("key_unavailable") ||
    message.includes("invalid_key_state") ||
    message.includes("wrap_operation_limit")
  ) {
    return new ServiceRpcError(ServiceRpcErrorCode.KEY_UNAVAILABLE);
  }
  if (message.includes("explicit_destination_not_owned")) {
    return new ServiceRpcError(ServiceRpcErrorCode.FORBIDDEN);
  }
  if (
    message.includes("invalid_rollout_state") ||
    message.includes("invalid_scrub_state") ||
    message.includes("encrypted_organizer_write_unavailable") ||
    message.includes("incomplete_encryption_backfill") ||
    message.includes("incomplete_index_coverage") ||
    message.includes("cutover_work_in_flight") ||
    message.includes("organizer_jobs_in_flight") ||
    message.includes("plaintext_scrub_complete") ||
    message.includes("plaintext_scrub_incomplete") ||
    message.includes("scrub_attestation_stale") ||
    message.includes("stale_backfill_cursor") ||
    message.includes("stale_rollout_state")
  ) {
    return new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
  }
  if (message.includes("not_found") || status === 404) {
    return new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND);
  }
  if (
    message.includes("rate_limited") ||
    message.includes("routing_rule_limit") ||
    message.includes("routing_rule_enabled_limit") ||
    status === 429
  ) {
    return new ServiceRpcError(ServiceRpcErrorCode.RATE_LIMITED);
  }
  if (message.includes("validation_failed") || status === 400) {
    return new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
  }
  if (message.includes("unauthorized") || status === 401) {
    return new ServiceRpcError(ServiceRpcErrorCode.UNAUTHORIZED);
  }
  if (message.includes("forbidden") || status === 403) {
    return new ServiceRpcError(ServiceRpcErrorCode.FORBIDDEN);
  }
  return new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

export function createServiceRpcClient(options: ServiceRpcClientOptions): ServiceRpcClient {
  if (
    options.allowedFunctions.length < 1 ||
    options.allowedFunctions.some((name) => !FUNCTION_NAME_PATTERN.test(name)) ||
    new Set(options.allowedFunctions).size !== options.allowedFunctions.length
  ) {
    throw new ConfigurationError();
  }
  const allowedFunctions = new Set(options.allowedFunctions);
  const config = configuration(options.environment ?? process.env);
  const request = options.fetch ?? globalThis.fetch;
  if (typeof request !== "function") throw new ConfigurationError();

  return Object.freeze({
    async rpc(
      functionName: string,
      parameters: Readonly<Record<string, unknown>>
    ): Promise<unknown> {
      if (!allowedFunctions.has(functionName)) {
        throw new ServiceRpcError(ServiceRpcErrorCode.FORBIDDEN);
      }
      let response: Response;
      try {
        response = await request(`${config.url}/rest/v1/rpc/${functionName}`, {
          method: "POST",
          body: JSON.stringify(parameters),
          cache: "no-store",
          redirect: "error",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          headers: {
            apikey: config.serviceRoleKey,
            authorization: `Bearer ${config.serviceRoleKey}`,
            "content-type": "application/json"
          }
        });
      } catch {
        throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
      }
      const body: unknown =
        response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) throw databaseError(response.status, body);
      return body;
    }
  });
}
