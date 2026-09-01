import { timingSafeEqual } from "node:crypto";

import { ApiErrorCode } from "@unfiled/contracts";

import { errorResponse, HttpError, jsonResponse } from "@/server/api/errors";
import { scheduleIndexDrain as scheduleProductionIndexDrain } from "@/server/indexing/index-worker-scheduler";

import {
  environmentOrganizerClient,
  OrganizerInvocationError,
  type OrganizerClient,
  type OrganizerDrainResult
} from "./organizer-client";
import { drainCaptureJobs } from "./workflow";

export type CaptureWorkflowHandlerDependencies = Readonly<{
  client?: OrganizerClient;
  drain?: () => Promise<OrganizerDrainResult>;
  environment?: Readonly<Record<string, string | undefined>>;
  getSecret?: () => string | undefined;
  localDrain?: () => Promise<OrganizerDrainResult>;
  scheduleIndexDrain?: () => void;
}>;

function authorized(request: Request, secret: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const actualBytes = Buffer.from(authorization);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function noStoreError(reason: unknown, request: Request): Response {
  const response = errorResponse(reason, request);
  response.headers.set("cache-control", "no-store");
  return response;
}

function isProductionRuntime(environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.VERCEL === "1" && environment.VERCEL_ENV === "production";
}

export function createCaptureWorkflowHandler(
  dependencies: CaptureWorkflowHandlerDependencies = {}
): (request: Request) => Promise<Response> {
  const environment = dependencies.environment ?? process.env;
  const productionRuntime = isProductionRuntime(environment);
  const drain =
    dependencies.drain ??
    (() =>
      productionRuntime
        ? (dependencies.client ?? environmentOrganizerClient).drain(
            "recovery",
            AbortSignal.timeout(55_000)
          )
        : (dependencies.localDrain ?? (() => drainCaptureJobs()))());
  const getSecret = dependencies.getSecret ?? (() => process.env.CRON_SECRET);
  const scheduleIndexDrain = dependencies.scheduleIndexDrain ?? scheduleProductionIndexDrain;

  return async (request: Request): Promise<Response> => {
    try {
      const secret = getSecret();
      if (secret === undefined || secret.length < 32) {
        throw new HttpError(
          503,
          ApiErrorCode.PROVIDER_UNAVAILABLE,
          "The capture workflow is not configured."
        );
      }
      if (!authorized(request, secret)) {
        throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "This scheduled request is not valid.");
      }
      const result = await drain();
      if (!productionRuntime && result.completed > 0) {
        try {
          scheduleIndexDrain();
        } catch {
          // Durable capture and index queues remain authoritative.
        }
      }
      return jsonResponse(result, {
        status: 200,
        headers: { "cache-control": "no-store" }
      });
    } catch (error: unknown) {
      if (error instanceof OrganizerInvocationError) {
        return noStoreError(
          new HttpError(
            503,
            ApiErrorCode.PROVIDER_UNAVAILABLE,
            "The encrypted organizer is unavailable."
          ),
          request
        );
      }
      return noStoreError(error, request);
    }
  };
}

export const captureWorkflowHandler = createCaptureWorkflowHandler();
