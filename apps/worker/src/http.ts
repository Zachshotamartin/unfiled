import { randomUUID } from "node:crypto";

import type { WorkerConfig } from "./config";
import type { DrainResult, DrainTrigger, WorkerDrainPort } from "./drain";
import { isDrainResult, unconfiguredDrainPort } from "./drain";
import { classifyWorkerError, WorkerError } from "./errors";
import {
  oidcTokenFromRequest,
  isAiAssistedKeyAuthority,
  type WorkerKeyManagementAdapter,
  unconfiguredKeyManagementAdapter
} from "./key-management-adapter";
import {
  authorizeLocalWorkerInvocation,
  type ProductionInvocationAuthAdapter,
  unconfiguredProductionInvocationAuth
} from "./invocation-auth-adapter";
import { createStructuredLogger, type WorkerLogger, type WorkerRoute } from "./logging";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const SAFE_METHOD_PATTERN = /^[A-Z]{1,12}$/;

type Clock = Readonly<{
  now(): number;
}>;

export type WorkerAppDependencies = Readonly<{
  clock?: Clock;
  config: WorkerConfig;
  drain?: WorkerDrainPort;
  keyManagement?: WorkerKeyManagementAdapter;
  logger?: WorkerLogger;
  productionInvocationAuth?: ProductionInvocationAuthAdapter;
}>;

export type WorkerApp = (request: Request) => Promise<Response>;

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

function jsonResponse(
  value: unknown,
  status: number,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): Response {
  const headers = securityHeaders(requestId);
  for (const [name, value_] of Object.entries(extraHeaders)) headers.set(name, value_);
  return new Response(JSON.stringify(value), { headers, status });
}

function requestId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function safeMethod(method: string): string {
  const upper = method.toUpperCase();
  return SAFE_METHOD_PATTERN.test(upper) ? upper : "OTHER";
}

function routeFor(request: Request): WorkerRoute {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "unknown";
  }
  if (pathname === "/health" || pathname === "/api/health") return "health";
  if (pathname === "/internal/drain" || pathname === "/api/internal/drain") {
    return "internal_drain";
  }
  return "unknown";
}

function errorMessage(code: ReturnType<typeof classifyWorkerError>["code"]): string {
  switch (code) {
    case "method_not_allowed":
      return "That method is not allowed.";
    case "not_found":
      return "That worker resource does not exist.";
    case "request_too_large":
      return "That request is too large.";
    case "request_timeout":
      return "The worker request timed out.";
    case "unauthorized":
      return "This worker request is not authorized.";
    case "validation_failed":
      return "Send a valid content-free drain request.";
    case "configuration_error":
    case "provider_unavailable":
      return "The worker is unavailable.";
  }
}

function errorResponse(
  error: unknown,
  requestId_: string,
  invocationKind: WorkerConfig["invocationAuth"]["kind"]
): Response {
  const classified = classifyWorkerError(error);
  const extraHeaders: Record<string, string> = {};
  if (classified.code === "unauthorized" && invocationKind === "bearer") {
    extraHeaders["www-authenticate"] = "Bearer";
  }
  if (classified.retryable) extraHeaders["retry-after"] = "5";
  return jsonResponse(
    {
      code: classified.code,
      message: errorMessage(classified.code),
      requestId: requestId_
    },
    classified.status,
    requestId_,
    extraHeaders
  );
}

function contentLength(request: Request, maximum: number): void {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  if (!/^\d+$/.test(raw)) {
    throw new WorkerError(400, "validation_failed", "Invalid content length.");
  }
  if (Number(raw) > maximum) {
    throw new WorkerError(413, "request_too_large", "Request body exceeds the limit.");
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
        throw new WorkerError(504, "request_timeout", "Request deadline elapsed.", {
          retryable: true
        });
      }
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new WorkerError(413, "request_too_large", "Request body exceeds the limit.");
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

async function readDrainTrigger(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<DrainTrigger> {
  const body = await readBoundedBody(request, maximum, signal);
  if (body.byteLength === 0) return "schedule";
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new WorkerError(400, "validation_failed", "Drain commands must be JSON.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WorkerError(400, "validation_failed", "Drain command is malformed.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkerError(400, "validation_failed", "Drain command must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "trigger")) {
    throw new WorkerError(400, "validation_failed", "Drain command has unknown fields.");
  }
  const trigger = record.trigger ?? "schedule";
  if (trigger !== "manual" && trigger !== "recovery" && trigger !== "schedule") {
    throw new WorkerError(400, "validation_failed", "Drain trigger is invalid.");
  }
  return trigger;
}

async function withDeadline<T>(
  request: Request,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let rejectDeadline: ((reason: WorkerError) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const fail = (): void => {
    rejectDeadline?.(
      new WorkerError(504, "request_timeout", "Request deadline elapsed.", { retryable: true })
    );
    controller.abort();
  };
  const timer = setTimeout(fail, timeoutMs);
  request.signal.addEventListener("abort", fail, { once: true });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", fail);
    controller.abort();
  }
}

function validatedDrainResult(result: unknown): DrainResult {
  if (!isDrainResult(result)) {
    throw new WorkerError(503, "provider_unavailable", "Drain adapter returned invalid data.", {
      retryable: true
    });
  }
  return result;
}

export function createWorkerApp(dependencies: WorkerAppDependencies): WorkerApp {
  const { config } = dependencies;
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const drain = dependencies.drain ?? unconfiguredDrainPort;
  const keyManagement = dependencies.keyManagement ?? unconfiguredKeyManagementAdapter;
  const logger = dependencies.logger ?? createStructuredLogger();
  const productionInvocationAuth =
    dependencies.productionInvocationAuth ?? unconfiguredProductionInvocationAuth;

  return async (request: Request): Promise<Response> => {
    const startedAt = clock.now();
    const id = requestId(request);
    const route = routeFor(request);
    const method = safeMethod(request.method);
    let response: Response;
    let reportedError: unknown;

    try {
      const url = new URL(request.url);
      if (url.search.length > 0) {
        throw new WorkerError(400, "validation_failed", "Worker routes do not accept queries.");
      }

      if (route === "health") {
        if (method !== "GET" && method !== "HEAD") {
          throw new WorkerError(405, "method_not_allowed", "Health accepts GET only.");
        }
        response = jsonResponse({ service: "unfiled-worker", status: "ok" }, 200, id, {
          allow: "GET, HEAD"
        });
        if (method === "HEAD") response = new Response(null, response);
      } else if (route === "internal_drain") {
        if (method !== "POST") {
          throw new WorkerError(405, "method_not_allowed", "Drain accepts POST only.");
        }
        if (request.headers.has("cookie")) {
          throw new WorkerError(401, "unauthorized", "User sessions are not accepted.");
        }
        const result = await withDeadline(request, config.requestTimeoutMs, async (signal) => {
          let invocation;
          if (config.invocationAuth.kind === "bearer") {
            if (config.runtime === "production") {
              throw new WorkerError(503, "provider_unavailable", "Invalid auth composition.", {
                retryable: true
              });
            }
            invocation = authorizeLocalWorkerInvocation({
              authorizationHeader: request.headers.get("authorization"),
              requestId: id,
              runtime: config.runtime,
              secret: config.invocationAuth.secret
            });
          } else {
            invocation = await productionInvocationAuth.authorize(
              {
                authorizationHeader: request.headers.get("authorization"),
                protectionBypassHeader: request.headers.get("x-vercel-protection-bypass"),
                requestId: id,
                trustedSourceToken: request.headers.get("x-vercel-trusted-oidc-idp-token")
              },
              signal
            );
          }
          const trigger = await readDrainTrigger(request, config.maxRequestBytes, signal);
          const oidcToken = oidcTokenFromRequest(request, config.keyBoundary);
          return keyManagement.withAiAssistedAuthority(
            config.keyBoundary,
            { invocation, oidcToken, requestId: id, runtime: config.runtime },
            signal,
            async (authority) => {
              if (
                !isAiAssistedKeyAuthority(authority, { requestId: id, runtime: config.runtime })
              ) {
                throw new WorkerError(503, "provider_unavailable", "Unexpected key authority.", {
                  retryable: true
                });
              }
              return validatedDrainResult(
                await drain.drain({ authority, requestId: id, signal, trigger })
              );
            }
          );
        });
        response = jsonResponse(result, 200, id);
      } else {
        throw new WorkerError(404, "not_found", "Worker route was not found.");
      }
    } catch (error: unknown) {
      reportedError = error;
      response = errorResponse(error, id, config.invocationAuth.kind);
    }

    const classified = reportedError === undefined ? undefined : classifyWorkerError(reportedError);
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
