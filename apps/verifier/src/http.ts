import { randomUUID } from "node:crypto";

import type { VerifierConfig } from "./config.js";
import type { GenerationTarget } from "./database.js";
import { classifyVerifierError, VerifierError, VerifierUnavailableError } from "./errors.js";
import {
  assertWorkloadOidcPresence,
  type ProductionInvocationAuth,
  unconfiguredProductionInvocationAuth
} from "./invocation-auth.js";
import { type VerifierKmsAdapter, unconfiguredVerifierKmsAdapter } from "./kms.js";
import { createStructuredLogger, type VerifierLogger, type VerifierRoute } from "./logging.js";
import type { GenerationVerifier, VerifyGenerationResult } from "./verifier.js";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_METHOD_PATTERN = /^[A-Z]{1,12}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION_ID_PATTERN = /^igen_[0-9A-HJKMNP-TV-Z]{26}$/u;
const REVISION_TOKEN_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

type Clock = Readonly<{ now(): number }>;

const unconfiguredGenerationVerifier: GenerationVerifier = Object.freeze({
  verify(): Promise<never> {
    return Promise.reject(new VerifierUnavailableError());
  }
});

export type VerifierAppDependencies = Readonly<{
  clock?: Clock;
  config: VerifierConfig;
  kms?: VerifierKmsAdapter;
  logger?: VerifierLogger;
  productionInvocationAuth?: ProductionInvocationAuth;
  verifier?: GenerationVerifier;
}>;

export type VerifierApp = (request: Request) => Promise<Response>;

function securityHeaders(requestId: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-request-id": requestId
  });
}

function jsonResponse(value: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(value), {
    headers: securityHeaders(requestId),
    status
  });
}

function attachReleaseIdentity(response: Response, config: VerifierConfig): void {
  if (config.releaseIdentity === null) return;
  response.headers.set("x-unfiled-deployment", config.releaseIdentity.deployment);
  response.headers.set("x-unfiled-commit", config.releaseIdentity.commit);
  response.headers.set("x-unfiled-environment", config.releaseIdentity.environment);
}

function requestId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function safeMethod(value: string): string {
  const method = value.toUpperCase();
  return SAFE_METHOD_PATTERN.test(method) ? method : "OTHER";
}

function routeFor(request: Request): VerifierRoute {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname.replace(/\/+$/u, "") || "/";
  } catch {
    return "unknown";
  }
  if (pathname === "/health" || pathname === "/api/health") return "health";
  if (pathname === "/internal/verify" || pathname === "/api/internal/verify") {
    return "internal_verify";
  }
  return "unknown";
}

function errorMessage(code: ReturnType<typeof classifyVerifierError>["code"]): string {
  switch (code) {
    case "generation_invalid":
      return "That encrypted generation could not be verified.";
    case "method_not_allowed":
      return "That method is not allowed.";
    case "not_found":
      return "That verifier resource does not exist.";
    case "request_too_large":
      return "That request is too large.";
    case "request_timeout":
      return "The verifier request timed out.";
    case "unauthorized":
      return "This verifier request is not authorized.";
    case "validation_failed":
      return "Send a valid content-free verification target.";
    case "configuration_error":
    case "provider_unavailable":
      return "The verifier is unavailable.";
  }
}

function errorResponse(error: unknown, id: string): Response {
  const classified = classifyVerifierError(error);
  const headers = securityHeaders(id);
  if (classified.retryable) headers.set("retry-after", "5");
  return new Response(
    JSON.stringify({
      code: classified.code,
      message: errorMessage(classified.code),
      requestId: id
    }),
    { headers, status: classified.status }
  );
}

function contentLength(request: Request, maximum: number): void {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  if (!/^\d+$/u.test(raw)) {
    throw new VerifierError(400, "validation_failed", "Invalid content length.");
  }
  if (Number(raw) > maximum) {
    throw new VerifierError(413, "request_too_large", "Request body exceeds the limit.");
  }
}

async function readBoundedBody(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  contentLength(request, maximum);
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = (): void => {
    void reader.cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    let next = await reader.read();
    while (!next.done) {
      if (signal.aborted) {
        throw new VerifierError(504, "request_timeout", "Request deadline elapsed.", {
          retryable: true
        });
      }
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new VerifierError(413, "request_too_large", "Request body exceeds the limit.");
      }
      chunks.push(next.value);
      next = await reader.read();
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function exactTarget(value: unknown): GenerationTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VerifierError(400, "validation_failed", "Verification target must be an object.");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "generationId,ownerId,revisionToken") {
    throw new VerifierError(400, "validation_failed", "Verification target shape is invalid.");
  }
  if (
    typeof row.ownerId !== "string" ||
    !UUID_PATTERN.test(row.ownerId) ||
    typeof row.generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(row.generationId) ||
    typeof row.revisionToken !== "string" ||
    !REVISION_TOKEN_PATTERN.test(row.revisionToken) ||
    BigInt(row.revisionToken) > MAX_SIGNED_BIGINT
  ) {
    throw new VerifierError(400, "validation_failed", "Verification target is invalid.");
  }
  return Object.freeze({
    ownerId: row.ownerId,
    generationId: row.generationId,
    revisionToken: row.revisionToken
  });
}

async function readTarget(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<GenerationTarget> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new VerifierError(400, "validation_failed", "Verification targets must be JSON.");
  }
  const bytes = await readBoundedBody(request, maximum, signal);
  try {
    if (bytes.byteLength === 0) {
      throw new VerifierError(400, "validation_failed", "Verification target is required.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new VerifierError(400, "validation_failed", "Verification target is malformed.");
    }
    return exactTarget(parsed);
  } finally {
    bytes.fill(0);
  }
}

async function withDeadline<Result>(
  request: Request,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<Result>
): Promise<Result> {
  const controller = new AbortController();
  let rejectDeadline: ((reason: VerifierError) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const fail = (): void => {
    rejectDeadline?.(
      new VerifierError(504, "request_timeout", "Request deadline elapsed.", { retryable: true })
    );
    controller.abort();
  };
  const timer = setTimeout(fail, timeoutMs);
  request.signal.addEventListener("abort", fail, { once: true });
  try {
    if (request.signal.aborted) {
      fail();
      return await deadline;
    }
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", fail);
    controller.abort();
  }
}

function validResult(value: unknown): value is VerifyGenerationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(",") === "generationId,revisionToken,verified,verifiedNoteCount" &&
    typeof row.generationId === "string" &&
    GENERATION_ID_PATTERN.test(row.generationId) &&
    typeof row.revisionToken === "string" &&
    REVISION_TOKEN_PATTERN.test(row.revisionToken) &&
    row.verified === true &&
    Number.isSafeInteger(row.verifiedNoteCount) &&
    Number(row.verifiedNoteCount) >= 0
  );
}

export function createVerifierApp(dependencies: VerifierAppDependencies): VerifierApp {
  const { config } = dependencies;
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const kms = dependencies.kms ?? unconfiguredVerifierKmsAdapter;
  const logger = dependencies.logger ?? createStructuredLogger();
  const productionAuth =
    dependencies.productionInvocationAuth ?? unconfiguredProductionInvocationAuth;
  const verifier = dependencies.verifier ?? unconfiguredGenerationVerifier;

  return async (request): Promise<Response> => {
    const startedAt = clock.now();
    const id = requestId(request);
    const route = routeFor(request);
    const method = safeMethod(request.method);
    let response: Response;
    let reportedError: unknown;
    try {
      const url = new URL(request.url);
      if (url.search.length > 0) {
        throw new VerifierError(400, "validation_failed", "Verifier routes do not accept queries.");
      }
      if (route === "health") {
        if (method !== "GET" && method !== "HEAD") {
          throw new VerifierError(405, "method_not_allowed", "Health accepts GET only.");
        }
        response = jsonResponse({ service: "unfiled-rag-verifier", status: "ok" }, 200, id);
        response.headers.set("allow", "GET, HEAD");
        if (method === "HEAD") response = new Response(null, response);
      } else if (route === "internal_verify") {
        if (method !== "POST") {
          throw new VerifierError(405, "method_not_allowed", "Verification accepts POST only.");
        }
        if (request.headers.has("cookie")) {
          throw new VerifierError(401, "unauthorized", "User sessions are not accepted.");
        }
        if (config.runtime === "local" || config.verification.kind !== "enabled") {
          throw new VerifierUnavailableError();
        }
        const managedRuntime = config.runtime;
        const verificationConfig = config.verification;
        const result = await withDeadline(request, config.requestTimeoutMs, async (signal) => {
          const invocation = await productionAuth.authorize(
            {
              authorizationHeader: request.headers.get("authorization"),
              protectionBypassHeader: request.headers.get("x-vercel-protection-bypass"),
              requestId: id,
              trustedSourceToken: request.headers.get("x-unfiled-trusted-oidc-idp-token")
            },
            signal
          );
          if (verificationConfig.kms.kind === "aws-oidc") {
            assertWorkloadOidcPresence(request);
          }
          const target = await readTarget(request, config.maxRequestBytes, signal);
          return kms.withKeySession(
            verificationConfig.kms,
            { invocation, requestId: id, runtime: managedRuntime },
            signal,
            (keys) => verifier.verify(target, keys, signal)
          );
        });
        if (!validResult(result)) throw new VerifierUnavailableError();
        response = jsonResponse(result, 200, id);
      } else {
        throw new VerifierError(404, "not_found", "Verifier route was not found.");
      }
    } catch (error: unknown) {
      reportedError = error;
      response = errorResponse(error, id);
    }
    attachReleaseIdentity(response, config);
    const classified =
      reportedError === undefined ? undefined : classifyVerifierError(reportedError);
    logger.log({
      durationMs: Math.max(0, clock.now() - startedAt),
      ...(classified === undefined ? {} : { errorClass: classified.errorClass }),
      event: "request.completed",
      level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
      method,
      outcome: response.ok ? "ok" : "error",
      requestId: id,
      ...(classified === undefined ? {} : { retryable: classified.retryable }),
      route,
      runtime: config.runtime,
      status: response.status
    });
    return response;
  };
}
