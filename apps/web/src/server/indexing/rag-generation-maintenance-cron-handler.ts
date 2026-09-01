import { createHash, timingSafeEqual } from "node:crypto";

import { ApiErrorCode } from "@unfiled/contracts";

import { errorResponse, HttpError, jsonResponse } from "@/server/api/errors";
import { ServiceRpcError } from "@/server/encryption/service-rpc-client";

import { IndexVerifierInvocationError } from "./index-verifier-client";
import { IndexWorkerInvocationError } from "./index-worker-client";
import {
  environmentRagGenerationMaintenanceRunner,
  type RagGenerationMaintenanceRunner
} from "./rag-generation-lifecycle-composition";
import {
  RagGenerationMaintenanceError,
  type RagGenerationMaintenanceResult
} from "./rag-generation-lifecycle-controller";
import { RagGenerationLifecycleContractError } from "./rag-generation-lifecycle-store";

export const RAG_GENERATION_MAINTENANCE_TIMEOUT_MS = 55_000;
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 4_096;

export type RagGenerationMaintenanceLogEvent =
  | (RagGenerationMaintenanceResult &
      Readonly<{
        durationMs: number;
        event: "rag_generation_maintenance.completed";
        outcome: "ok";
        status: 200;
      }>)
  | Readonly<{
      durationMs: number;
      errorClass: "abort" | "configuration" | "dependency" | "unknown";
      event: "rag_generation_maintenance.completed";
      outcome: "error";
      status: number;
    }>;

export type RagGenerationMaintenanceCronHandlerDependencies = Readonly<{
  getSecret?: () => string | undefined;
  log?: (event: RagGenerationMaintenanceLogEvent) => void;
  now?: () => number;
  runner?: RagGenerationMaintenanceRunner;
}>;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(request: Request, secret: string): boolean {
  const supplied = digest(request.headers.get("authorization") ?? "");
  const expected = digest(`Bearer ${secret}`);
  return timingSafeEqual(supplied, expected);
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function errorClass(error: unknown): "abort" | "configuration" | "dependency" | "unknown" {
  if (error instanceof DOMException && error.name === "AbortError") return "abort";
  if (error instanceof HttpError) return "configuration";
  if (
    error instanceof ServiceRpcError ||
    error instanceof IndexVerifierInvocationError ||
    error instanceof IndexWorkerInvocationError ||
    error instanceof RagGenerationLifecycleContractError ||
    error instanceof RagGenerationMaintenanceError
  ) {
    return "dependency";
  }
  return "unknown";
}

function dependencyFailure(error: unknown): boolean {
  return (
    error instanceof ServiceRpcError ||
    error instanceof IndexVerifierInvocationError ||
    error instanceof IndexWorkerInvocationError ||
    error instanceof RagGenerationLifecycleContractError ||
    error instanceof RagGenerationMaintenanceError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function defaultLog(event: RagGenerationMaintenanceLogEvent): void {
  const line = JSON.stringify(event);
  if (event.outcome === "ok") console.info(line);
  else console.warn(line);
}

function safeLog(
  log: (event: RagGenerationMaintenanceLogEvent) => void,
  event: RagGenerationMaintenanceLogEvent
): void {
  try {
    log(event);
  } catch {
    // Operational telemetry must not change the durable lifecycle outcome.
  }
}

export function createRagGenerationMaintenanceCronHandler(
  dependencies: RagGenerationMaintenanceCronHandlerDependencies = {}
): (request: Request) => Promise<Response> {
  const runner = dependencies.runner ?? environmentRagGenerationMaintenanceRunner;
  const getSecret = dependencies.getSecret ?? (() => process.env.CRON_SECRET);
  const log = dependencies.log ?? defaultLog;
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    const startedAt = now();
    try {
      const secret = getSecret();
      if (
        secret === undefined ||
        secret.length < MIN_SECRET_LENGTH ||
        secret.length > MAX_SECRET_LENGTH
      ) {
        throw new HttpError(
          503,
          ApiErrorCode.PROVIDER_UNAVAILABLE,
          "Encrypted index generation maintenance is not configured."
        );
      }
      if (!authorized(request, secret)) {
        throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "This scheduled request is not valid.");
      }
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(RAG_GENERATION_MAINTENANCE_TIMEOUT_MS)
      ]);
      const result = await runner.run(signal);
      safeLog(log, {
        ...result,
        durationMs: Math.max(0, now() - startedAt),
        event: "rag_generation_maintenance.completed",
        outcome: "ok",
        status: 200
      });
      return noStore(jsonResponse(result, 200));
    } catch (error: unknown) {
      const mapped = dependencyFailure(error)
        ? new HttpError(
            503,
            ApiErrorCode.PROVIDER_UNAVAILABLE,
            "Encrypted index generation maintenance is temporarily unavailable."
          )
        : error;
      const response = noStore(errorResponse(mapped, request));
      safeLog(log, {
        durationMs: Math.max(0, now() - startedAt),
        errorClass: errorClass(error),
        event: "rag_generation_maintenance.completed",
        outcome: "error",
        status: response.status
      });
      return response;
    }
  };
}

export const ragGenerationMaintenanceCronHandler = createRagGenerationMaintenanceCronHandler();
