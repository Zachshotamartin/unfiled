import { timingSafeEqual } from "node:crypto";

import { ApiErrorCode } from "@unfiled/contracts";

import { errorResponse, HttpError, jsonResponse } from "@/server/api/errors";
import { scheduleIndexDrain as scheduleProductionIndexDrain } from "@/server/indexing/index-worker-scheduler";

import { drainCaptureJobs, type CaptureDrainResult } from "./workflow";

export type CaptureWorkflowHandlerDependencies = Readonly<{
  drain?: () => Promise<CaptureDrainResult>;
  getSecret?: () => string | undefined;
  scheduleIndexDrain?: () => void;
}>;

function authorized(request: Request, secret: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const actualBytes = Buffer.from(authorization);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createCaptureWorkflowHandler(
  dependencies: CaptureWorkflowHandlerDependencies = {}
): (request: Request) => Promise<Response> {
  const drain = dependencies.drain ?? (() => drainCaptureJobs());
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
      if (result.completed > 0) {
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
      return errorResponse(error, request);
    }
  };
}

export const captureWorkflowHandler = createCaptureWorkflowHandler();
