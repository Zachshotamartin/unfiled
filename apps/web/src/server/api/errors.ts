import {
  ApiErrorCode,
  IdempotencyKeySchema,
  type ApiError,
  type ApiErrorCodeValue
} from "@unfiled/contracts";

const MAX_JSON_REQUEST_BYTES = 250_000;
const MAX_BINARY_REQUEST_BYTES = 1_000_000;

export class HttpError extends Error {
  public readonly code: ApiErrorCodeValue;
  public readonly details: Readonly<Record<string, unknown>> | undefined;
  public readonly retryAfterSeconds: number | undefined;
  public readonly status: number;

  public constructor(
    status: number,
    code: ApiErrorCodeValue,
    message: string,
    options?: Readonly<{
      details?: Readonly<Record<string, unknown>>;
      retryAfterSeconds?: number;
    }>
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class ConfigurationError extends HttpError {
  public constructor() {
    super(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "Unfiled is not connected to its data service yet. Try again later."
    );
    this.name = "ConfigurationError";
  }
}

function requestId(request: Request): string {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}

export function jsonResponse(
  value: unknown,
  init: number | ResponseInit = 200,
  additionalHeaders?: readonly string[]
): Response {
  const responseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  for (const cookie of additionalHeaders ?? []) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(value), { ...responseInit, headers });
}

/**
 * Server-side only. Failures that surface as 5xx are otherwise invisible in platform logs, so one
 * content-free line records the error class, its cause class, the API code, and the request
 * method and path. Messages, bodies, query strings, and headers are never logged.
 */
function reportServerFailure(
  reason: unknown,
  request: Request,
  status: number,
  code: string
): void {
  if (status < 500) return;
  const errorClass = reason instanceof Error ? reason.name : typeof reason;
  const cause = reason instanceof Error ? reason.cause : undefined;
  const causeClass = cause instanceof Error ? cause.name : undefined;
  const causeReason =
    cause instanceof Error &&
    "reason" in cause &&
    typeof cause.reason === "string" &&
    /^[a-z_]{1,40}$/u.test(cause.reason)
      ? cause.reason
      : undefined;
  const causeCode =
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[a-z_]{1,40}$/u.test(cause.code)
      ? cause.code
      : undefined;
  let path = "unknown";
  try {
    path = new URL(request.url).pathname;
  } catch {
    // Keep the placeholder when the request URL cannot be parsed.
  }
  console.error(
    JSON.stringify({
      event: "web.request_failed",
      service: "unfiled-web",
      status,
      code,
      errorClass,
      ...(causeClass === undefined ? {} : { causeClass }),
      ...(causeReason === undefined ? {} : { causeReason }),
      ...(causeCode === undefined ? {} : { causeCode }),
      method: request.method,
      path
    })
  );
}

export function errorResponse(reason: unknown, request: Request): Response {
  const id = requestId(request);
  if (reason instanceof HttpError) {
    const body: ApiError = {
      code: reason.code,
      message: reason.message,
      requestId: id,
      ...(reason.details === undefined ? {} : { details: { ...reason.details } }),
      ...(reason.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: reason.retryAfterSeconds })
    };
    reportServerFailure(reason, request, reason.status, reason.code);
    return jsonResponse(body, {
      status: reason.status,
      headers:
        reason.retryAfterSeconds === undefined
          ? { "x-request-id": id }
          : { "retry-after": String(reason.retryAfterSeconds), "x-request-id": id }
    });
  }

  const body: ApiError = {
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Unfiled could not complete that request. Try again.",
    requestId: id
  };
  reportServerFailure(reason, request, 500, body.code);
  return jsonResponse(body, { status: 500, headers: { "x-request-id": id } });
}

function invalidJsonRequest(): HttpError {
  return new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send a valid JSON request.");
}

function requestTooLarge(): HttpError {
  return new HttpError(413, ApiErrorCode.VALIDATION_FAILED, "That request is too large.");
}

function validateDeclaredContentLength(request: Request, maximumBytes: number): void {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) return;
  if (!/^\d+$/u.test(declaredLength)) throw invalidJsonRequest();
  if (BigInt(declaredLength) > BigInt(maximumBytes)) throw requestTooLarge();
}

async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maximumBytes - length) {
        try {
          await reader.cancel();
        } catch {
          // The sanitized size failure remains authoritative if cancellation races.
        }
        throw requestTooLarge();
      }
      length += chunk.value.byteLength;
      chunks.push(chunk.value);
    }
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    if (error instanceof HttpError) throw error;
    throw invalidJsonRequest();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A nonconforming stream cannot override the sanitized parse result.
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  try {
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
  return bytes;
}

export async function readJsonObject(
  request: Request,
  maximumBytes = MAX_JSON_REQUEST_BYTES
): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_JSON_REQUEST_BYTES
  ) {
    throw new ConfigurationError();
  }
  validateDeclaredContentLength(request, maximumBytes);

  const bytes = await readBoundedRequestBody(request, maximumBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidJsonRequest();
  } finally {
    bytes.fill(0);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function requireIdempotencyKey(
  request: Request,
  body?: Readonly<Record<string, unknown>>
): string {
  const header = request.headers.get("idempotency-key")?.trim();
  const bodyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : undefined;
  const parsedHeader = IdempotencyKeySchema.safeParse(header);
  if (!parsedHeader.success) {
    throw new HttpError(
      400,
      ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
      "This action needs a valid idempotency key."
    );
  }
  if (bodyKey !== undefined && bodyKey !== header) {
    throw new HttpError(
      409,
      ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
      "The idempotency key does not match the request body."
    );
  }
  return parsedHeader.data;
}

function unsupportedMediaType(): HttpError {
  return new HttpError(
    400,
    ApiErrorCode.VALIDATION_FAILED,
    "Send a JPEG photo or an AAC recording."
  );
}

/// Reads a raw binary upload whose media type is one of the allowed types, bounded like JSON
/// bodies are. The declared media type is matched exactly, with no parameters.
export async function readBoundedBinaryBody(
  request: Request,
  limits: Readonly<{ allowedContentTypes: readonly string[]; maximumBytes: number }>
): Promise<Readonly<{ bytes: Uint8Array; mediaType: string }>> {
  if (
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes < 1 ||
    limits.maximumBytes > MAX_BINARY_REQUEST_BYTES
  ) {
    throw new ConfigurationError();
  }
  const declaredType = request.headers.get("content-type")?.trim().toLowerCase() ?? "";
  if (!limits.allowedContentTypes.includes(declaredType)) throw unsupportedMediaType();
  validateDeclaredContentLength(request, limits.maximumBytes);
  const bytes = await readBoundedRequestBody(request, limits.maximumBytes);
  if (bytes.byteLength === 0) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "Send the file bytes as the request body."
    );
  }
  return Object.freeze({ bytes, mediaType: declaredType });
}
