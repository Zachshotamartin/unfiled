import { randomUUID } from "node:crypto";

import type { OrganizerConfig } from "./config.js";
import {
  type DrainTrigger,
  type OrganizerDrainPort,
  isOrganizerDrainResult,
  unconfiguredDrainPort
} from "./drain.js";
import { classifyOrganizerError, OrganizerError } from "./errors.js";
import {
  authorizeLocalOrganizerInvocation,
  createVercelTrustedSourcesInvocationAuth,
  type ProductionInvocationAuthAdapter,
  unconfiguredProductionInvocationAuth
} from "./invocation-auth.js";
import {
  isOrganizerKeyAuthority,
  oidcTokenFromRequest,
  type OrganizerKeyManagementAdapter,
  unconfiguredKeyManagementAdapter
} from "./key-management.js";
import { createStructuredLogger, type OrganizerLogger, type OrganizerRoute } from "./logging.js";

const METHOD = /^[A-Z]{1,12}$/u;
type Clock = Readonly<{ now(): number }>;
export type OrganizerAppDependencies = Readonly<{
  clock?: Clock;
  config: OrganizerConfig;
  drain?: OrganizerDrainPort;
  keyManagement?: OrganizerKeyManagementAdapter;
  logger?: OrganizerLogger;
  productionInvocationAuth?: ProductionInvocationAuthAdapter;
}>;
export type OrganizerApp = (request: Request) => Promise<Response>;

function headers(requestId: string): Headers {
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
function json(
  value: unknown,
  status: number,
  requestId: string,
  extra: Readonly<Record<string, string>> = {}
): Response {
  const responseHeaders = headers(requestId);
  for (const [name, content] of Object.entries(extra)) responseHeaders.set(name, content);
  return new Response(JSON.stringify(value), { headers: responseHeaders, status });
}
function attachReleaseIdentity(response: Response, config: OrganizerConfig): void {
  if (config.releaseIdentity === null) return;
  response.headers.set("x-unfiled-deployment", config.releaseIdentity.deployment);
  response.headers.set("x-unfiled-commit", config.releaseIdentity.commit);
  response.headers.set("x-unfiled-environment", config.releaseIdentity.environment);
}
function id(): string {
  return randomUUID();
}
function method(request: Request): string {
  const value = request.method.toUpperCase();
  return METHOD.test(value) ? value : "OTHER";
}
function route(request: Request): OrganizerRoute {
  try {
    const path = new URL(request.url).pathname.replace(/\/+$/u, "") || "/";
    if (path === "/health" || path === "/api/health") return "health";
    if (path === "/internal/drain" || path === "/api/internal/drain") return "internal_drain";
  } catch {
    return "unknown";
  }
  return "unknown";
}
function errorMessage(code: ReturnType<typeof classifyOrganizerError>["code"]): string {
  switch (code) {
    case "method_not_allowed":
      return "That method is not allowed.";
    case "not_found":
      return "That organizer resource does not exist.";
    case "request_too_large":
      return "That request is too large.";
    case "request_timeout":
      return "The organizer request timed out.";
    case "unauthorized":
      return "This organizer request is not authorized.";
    case "validation_failed":
      return "Send a valid content-free drain request.";
    case "configuration_error":
    case "provider_unavailable":
      return "The organizer is unavailable.";
  }
}
function errorResponse(
  error: unknown,
  requestId: string,
  authKind: OrganizerConfig["invocationAuth"]["kind"]
): Response {
  const classified = classifyOrganizerError(error);
  const extra: Record<string, string> = {};
  if (classified.retryable) extra["retry-after"] = "5";
  if (classified.code === "unauthorized" && authKind === "bearer")
    extra["www-authenticate"] = "Bearer";
  return json(
    { code: classified.code, message: errorMessage(classified.code), requestId },
    classified.status,
    requestId,
    extra
  );
}

async function boundedBody(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    throw new OrganizerError(
      /^\d+$/u.test(length) ? 413 : 400,
      /^\d+$/u.test(length) ? "request_too_large" : "validation_failed",
      "Request length is invalid."
    );
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        throw new OrganizerError(400, "validation_failed", "Drain command is malformed.");
      }
      if (part.done) break;
      if (signal.aborted)
        throw new OrganizerError(504, "request_timeout", "Request deadline elapsed.", {
          retryable: true
        });
      total += part.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new OrganizerError(413, "request_too_large", "Request body exceeds the limit.");
      }
      chunks.push(part.value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    return output;
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      reader.releaseLock();
    } catch {
      /* content-free cleanup */
    }
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function trigger(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<DrainTrigger> {
  const bytes = await boundedBody(request, maximum, signal);
  try {
    if (bytes.byteLength === 0) return "schedule";
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    )
      throw new OrganizerError(400, "validation_failed", "Drain commands must be JSON.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new OrganizerError(400, "validation_failed", "Drain command is malformed.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new OrganizerError(400, "validation_failed", "Drain command must be an object.");
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== "trigger"))
      throw new OrganizerError(400, "validation_failed", "Drain command has unknown fields.");
    const value = row.trigger ?? "schedule";
    if (value !== "manual" && value !== "recovery" && value !== "schedule")
      throw new OrganizerError(400, "validation_failed", "Drain trigger is invalid.");
    return value;
  } finally {
    bytes.fill(0);
  }
}

async function deadline<T>(
  request: Request,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (request.signal.aborted)
    throw new OrganizerError(504, "request_timeout", "Request deadline elapsed.", {
      retryable: true
    });
  const controller = new AbortController();
  let rejectDeadline: ((reason: OrganizerError) => void) | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const fail = (): void => {
    rejectDeadline?.(
      new OrganizerError(504, "request_timeout", "Request deadline elapsed.", { retryable: true })
    );
    controller.abort();
  };
  const timer = setTimeout(fail, timeoutMs);
  request.signal.addEventListener("abort", fail, { once: true });
  const pending = operation(controller.signal);
  void pending.catch(() => undefined);
  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", fail);
    controller.abort();
  }
}

/**
 * Server-side only: the first stack frame of a failure as "file:function", stripped of
 * paths, line numbers, and any argument text. It names where an unavailability was
 * raised without carrying request or note content.
 */
function throwSite(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  const frame = error.stack.split("\n").find((line) => /^\s*at /u.test(line));
  if (frame === undefined) return undefined;
  const match = /at (?:async )?([A-Za-z0-9_.$<>]+)? ?\(?([^()\s]+?)(?::\d+){1,2}\)?$/u.exec(
    frame.trim()
  );
  if (match === null) return undefined;
  const fn = match[1] ?? "anonymous";
  const file = (match[2] ?? "").split("/").pop() ?? "";
  const site = `${file.replace(/[^A-Za-z0-9_.-]/gu, "")}:${fn.replace(/[^A-Za-z0-9_.$<>]/gu, "")}`;
  return site.length > 1 && site.length <= 120 ? site : undefined;
}

export function createOrganizerApp(dependencies: OrganizerAppDependencies): OrganizerApp {
  const { config } = dependencies;
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const drain = dependencies.drain ?? unconfiguredDrainPort;
  const keyManagement = dependencies.keyManagement ?? unconfiguredKeyManagementAdapter;
  const logger = dependencies.logger ?? createStructuredLogger();
  const productionAuth =
    dependencies.productionInvocationAuth ?? unconfiguredProductionInvocationAuth;
  return async (request): Promise<Response> => {
    const started = clock.now();
    const requestId = id();
    const selectedRoute = route(request);
    const selectedMethod = method(request);
    let response: Response;
    let reported: unknown;
    try {
      const url = new URL(request.url);
      if (url.search.length > 0)
        throw new OrganizerError(
          400,
          "validation_failed",
          "Organizer routes do not accept queries."
        );
      if (selectedRoute === "health") {
        if (selectedMethod !== "GET" && selectedMethod !== "HEAD")
          throw new OrganizerError(405, "method_not_allowed", "Health accepts GET only.");
        response = json({ service: "unfiled-organizer", status: "ok" }, 200, requestId, {
          allow: "GET, HEAD"
        });
        if (selectedMethod === "HEAD") response = new Response(null, response);
      } else if (selectedRoute === "internal_drain") {
        if (selectedMethod !== "POST")
          throw new OrganizerError(405, "method_not_allowed", "Drain accepts POST only.");
        if (request.headers.has("cookie"))
          throw new OrganizerError(401, "unauthorized", "User sessions are not accepted.");
        const result = await deadline(request, config.requestTimeoutMs, async (signal) => {
          const invocation =
            config.invocationAuth.kind === "bearer"
              ? config.runtime !== "local"
                ? await Promise.reject(
                    new OrganizerError(503, "provider_unavailable", "Invalid auth composition.", {
                      retryable: true
                    })
                  )
                : authorizeLocalOrganizerInvocation({
                    authorizationHeader: request.headers.get("authorization"),
                    requestId,
                    runtime: "local",
                    secret: config.invocationAuth.secret
                  })
              : await productionAuth.authorize(
                  {
                    authorizationHeader: request.headers.get("authorization"),
                    protectionBypassHeader: request.headers.get("x-vercel-protection-bypass"),
                    requestId,
                    trustedSourceToken: request.headers.get("x-unfiled-trusted-oidc-idp-token")
                  },
                  signal
                );
          const selectedTrigger = await trigger(request, config.maxRequestBytes, signal);
          const oidcToken = oidcTokenFromRequest(request, config.keyBoundary);
          return keyManagement.withAiAssistedAuthority(
            config.keyBoundary,
            { invocation, oidcToken, requestId, runtime: config.runtime },
            signal,
            async (authority) => {
              if (!isOrganizerKeyAuthority(authority, { requestId, runtime: config.runtime }))
                throw new OrganizerError(503, "provider_unavailable", "Unexpected key authority.", {
                  retryable: true
                });
              const result_ = await drain.drain({
                authority,
                requestId,
                signal,
                trigger: selectedTrigger
              });
              if (!isOrganizerDrainResult(result_))
                throw new OrganizerError(
                  503,
                  "provider_unavailable",
                  "Drain adapter returned invalid data.",
                  { retryable: true }
                );
              return result_;
            }
          );
        });
        response = json(result, 200, requestId);
      } else throw new OrganizerError(404, "not_found", "Organizer route was not found.");
    } catch (error: unknown) {
      reported = error;
      response = errorResponse(error, requestId, config.invocationAuth.kind);
    }
    attachReleaseIdentity(response, config);
    const classified = reported === undefined ? undefined : classifyOrganizerError(reported);
    const causeName =
      reported instanceof Error &&
      reported.cause instanceof Error &&
      /^[A-Za-z0-9_]{1,40}$/u.test(reported.cause.name)
        ? reported.cause.name
        : undefined;
    const origin = causeName === undefined ? throwSite(reported) : undefined;
    logger.log({
      durationMs: Math.max(0, clock.now() - started),
      ...(classified === undefined ? {} : { errorClass: classified.errorClass }),
      ...(causeName === undefined ? {} : { causeName }),
      ...(origin === undefined ? {} : { origin }),
      event: "request.completed",
      level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
      method: selectedMethod,
      outcome: response.ok ? "ok" : "error",
      requestId,
      ...(classified === undefined ? {} : { retryable: classified.retryable }),
      route: selectedRoute,
      runtime: config.runtime,
      status: response.status
    });
    return response;
  };
}

export { createVercelTrustedSourcesInvocationAuth };
