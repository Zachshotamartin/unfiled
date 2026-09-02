import { randomUUID } from "node:crypto";

import {
  EncryptedUserSearchInvocationSchema,
  EncryptedUserSearchResultSchema,
  type EncryptedUserSearchInvocation
} from "@unfiled/contracts";

import type { SearchConfig } from "./config.js";
import { classifySearchError, SearchServiceError } from "./errors.js";
import {
  authorizeLocalSearchInvocation,
  createSearchInvocationAuth,
  isVerifiedSearchInvocation,
  type SearchInvocationAuth
} from "./invocation-auth.js";
import {
  isSearchKeyAuthority,
  oidcTokenFromRequest,
  type SearchKeyManagementAdapter,
  unconfiguredSearchKeyManagementAdapter
} from "./key-management.js";
import { createStructuredSearchLogger, type SearchLogger, type SearchRoute } from "./logging.js";
import { hasValidEncryptedUserSearchDigest } from "./material.js";
import type { SearchQueryPort } from "./query.js";

const METHOD = /^[A-Z]{1,12}$/u;

type Clock = Readonly<{ now(): number }>;
export type SearchApp = (request: Request) => Promise<Response>;
export type SearchAppDependencies = Readonly<{
  clock?: Clock;
  config: SearchConfig;
  keyManagement?: SearchKeyManagementAdapter;
  logger?: SearchLogger;
  productionInvocationAuth?: SearchInvocationAuth;
  query?: SearchQueryPort;
}>;

const unconfiguredQuery: SearchQueryPort = Object.freeze({
  query() {
    return Promise.reject(new SearchServiceError(503, "provider_unavailable", { retryable: true }));
  }
});

function responseHeaders(requestId: string): Headers {
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
  const headers = responseHeaders(requestId);
  for (const [name, content] of Object.entries(extra)) headers.set(name, content);
  return new Response(JSON.stringify(value), { headers, status });
}

function attachReleaseIdentity(response: Response, config: SearchConfig): void {
  if (config.releaseIdentity === null) return;
  response.headers.set("x-unfiled-deployment", config.releaseIdentity.deployment);
  response.headers.set("x-unfiled-commit", config.releaseIdentity.commit);
  response.headers.set("x-unfiled-environment", config.releaseIdentity.environment);
}

function requestMethod(request: Request): string {
  const value = request.method.toUpperCase();
  return METHOD.test(value) ? value : "OTHER";
}

function requestRoute(request: Request): SearchRoute {
  try {
    const path = new URL(request.url).pathname.replace(/\/+$/u, "") || "/";
    if (path === "/health" || path === "/api/health") return "health";
    if (path === "/internal/query" || path === "/api/internal/query") return "internal_query";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function message(code: ReturnType<typeof classifySearchError>["code"]): string {
  switch (code) {
    case "method_not_allowed":
      return "That method is not allowed.";
    case "not_found":
      return "That search resource does not exist.";
    case "request_too_large":
      return "That request is too large.";
    case "request_timeout":
      return "The search request timed out.";
    case "unauthorized":
      return "This search request is not authorized.";
    case "validation_failed":
      return "Send a valid encrypted search invocation.";
    case "rate_limited":
      return "Search is temporarily rate limited.";
    case "configuration_error":
    case "provider_unavailable":
      return "Search is temporarily unavailable.";
  }
}

function errorResponse(error: unknown, requestId: string, localBearer: boolean): Response {
  const classified = classifySearchError(error);
  const extra: Record<string, string> = {};
  if (classified.retryable) extra["retry-after"] = "5";
  if (classified.code === "unauthorized" && localBearer) {
    extra["www-authenticate"] = "Bearer";
  }
  return json(
    { code: classified.code, message: message(classified.code), requestId },
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
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/u.test(declared) || Number(declared) > maximum)) {
    throw new SearchServiceError(
      /^\d{1,10}$/u.test(declared) ? 413 : 400,
      /^\d{1,10}$/u.test(declared) ? "request_too_large" : "validation_failed"
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
        throw new SearchServiceError(400, "validation_failed");
      }
      if (part.done) break;
      if (signal.aborted) {
        part.value.fill(0);
        throw new SearchServiceError(504, "request_timeout", { retryable: true });
      }
      total += part.value.byteLength;
      if (total > maximum) {
        part.value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new SearchServiceError(413, "request_too_large");
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
      // Request cleanup cannot widen the surfaced error.
    }
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function invocation(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<EncryptedUserSearchInvocation> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new SearchServiceError(400, "validation_failed");
  }
  const bytes = await boundedBody(request, maximum, signal);
  try {
    if (bytes.byteLength === 0) throw new SearchServiceError(400, "validation_failed");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new SearchServiceError(400, "validation_failed");
    }
    const parsed = EncryptedUserSearchInvocationSchema.safeParse(value);
    if (!parsed.success || !hasValidEncryptedUserSearchDigest(parsed.data)) {
      throw new SearchServiceError(401, "unauthorized");
    }
    return parsed.data;
  } finally {
    bytes.fill(0);
  }
}

async function deadline<Result>(
  request: Request,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<Result>
): Promise<Result> {
  if (request.signal.aborted) {
    throw new SearchServiceError(504, "request_timeout", { retryable: true });
  }
  const controller = new AbortController();
  let rejectDeadline: ((error: SearchServiceError) => void) | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const fail = (): void => {
    rejectDeadline?.(new SearchServiceError(504, "request_timeout", { retryable: true }));
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

export function createSearchApp(dependencies: SearchAppDependencies): SearchApp {
  const { config } = dependencies;
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const logger = dependencies.logger ?? createStructuredSearchLogger();
  const query = dependencies.query ?? unconfiguredQuery;
  const keyManagement = dependencies.keyManagement ?? unconfiguredSearchKeyManagementAdapter;
  const productionAuth =
    dependencies.productionInvocationAuth ??
    (config.invocation.kind === "trusted-source"
      ? createSearchInvocationAuth(config.invocation.source)
      : undefined);

  return async (request): Promise<Response> => {
    const started = clock.now();
    const requestId = randomUUID();
    const selectedMethod = requestMethod(request);
    const selectedRoute = requestRoute(request);
    let response: Response;
    let reported: unknown;
    try {
      const url = new URL(request.url);
      if (url.search.length > 0) throw new SearchServiceError(400, "validation_failed");
      if (selectedRoute === "health") {
        if (selectedMethod !== "GET" && selectedMethod !== "HEAD") {
          throw new SearchServiceError(405, "method_not_allowed");
        }
        response = json({ service: "unfiled-search", status: "ok" }, 200, requestId, {
          allow: "GET, HEAD"
        });
        if (selectedMethod === "HEAD") response = new Response(null, response);
      } else if (selectedRoute === "internal_query") {
        if (selectedMethod !== "POST") {
          throw new SearchServiceError(405, "method_not_allowed");
        }
        if (request.headers.has("cookie")) throw new SearchServiceError(401, "unauthorized");
        const result = await deadline(request, config.requestTimeoutMs, async (signal) => {
          const verifiedInvocation =
            config.invocation.kind === "local-bearer"
              ? authorizeLocalSearchInvocation({
                  authorizationHeader: request.headers.get("authorization"),
                  requestId,
                  secret: config.invocation.secret
                })
              : productionAuth === undefined
                ? await Promise.reject(
                    new SearchServiceError(503, "provider_unavailable", { retryable: true })
                  )
                : await productionAuth.authorize(
                    {
                      authorizationHeader: request.headers.get("authorization"),
                      protectionBypassHeader: request.headers.get("x-vercel-protection-bypass"),
                      requestId,
                      trustedSourceToken: request.headers.get("x-unfiled-trusted-oidc-idp-token")
                    },
                    signal
                  );
          if (
            !isVerifiedSearchInvocation(verifiedInvocation, { requestId, runtime: config.runtime })
          ) {
            throw new SearchServiceError(401, "unauthorized");
          }
          const parsedInvocation = await invocation(request, config.maxRequestBytes, signal);
          const oidcToken = oidcTokenFromRequest(request, config.keyBoundary);
          return keyManagement.withAiAssistedSearchAuthority(
            config.keyBoundary,
            {
              invocation: verifiedInvocation,
              oidcToken,
              requestId,
              runtime: config.runtime
            },
            signal,
            async (authority) => {
              if (
                config.runtime === "local" ||
                !isSearchKeyAuthority(authority, { requestId, runtime: config.runtime })
              ) {
                throw new SearchServiceError(503, "provider_unavailable", { retryable: true });
              }
              return query.query({ authority, invocation: parsedInvocation, signal });
            }
          );
        });
        response = json(EncryptedUserSearchResultSchema.parse(result), 200, requestId);
      } else {
        throw new SearchServiceError(404, "not_found");
      }
    } catch (error: unknown) {
      reported = error;
      response = errorResponse(error, requestId, config.invocation.kind === "local-bearer");
      if (classifySearchError(error).code === "method_not_allowed") {
        response.headers.set("allow", selectedRoute === "health" ? "GET, HEAD" : "POST");
      }
    }
    attachReleaseIdentity(response, config);
    const classified = reported === undefined ? undefined : classifySearchError(reported);
    logger.log({
      durationMs: Math.max(0, clock.now() - started),
      ...(classified === undefined ? {} : { errorClass: classified.errorClass }),
      event: "request.completed",
      level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
      method: selectedMethod,
      outcome: response.ok ? "ok" : "error",
      requestId,
      ...(classified?.retryable === true ? { retryable: true } : {}),
      route: selectedRoute,
      runtime: config.runtime,
      status: response.status
    });
    return response;
  };
}
