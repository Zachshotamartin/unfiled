import { timingSafeEqual } from "node:crypto";

import { ApiErrorCode } from "@unfiled/contracts";

import { errorResponse, HttpError, jsonResponse } from "@/server/api/errors";

import {
  environmentIndexWorkerClient,
  IndexWorkerInvocationError,
  type IndexWorkerClient
} from "./index-worker-client";
import { drainIndexWorkerUntilIdle } from "./index-worker-drain";

export type IndexWorkerCronHandlerDependencies = Readonly<{
  client?: IndexWorkerClient;
  getSecret?: () => string | undefined;
}>;

function authorized(request: Request, secret: string): boolean {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createIndexWorkerCronHandler(
  dependencies: IndexWorkerCronHandlerDependencies = {}
): (request: Request) => Promise<Response> {
  const client = dependencies.client ?? environmentIndexWorkerClient;
  const getSecret = dependencies.getSecret ?? (() => process.env.CRON_SECRET);
  return async (request: Request): Promise<Response> => {
    try {
      const secret = getSecret();
      if (secret === undefined || secret.length < 32) {
        throw new HttpError(
          503,
          ApiErrorCode.PROVIDER_UNAVAILABLE,
          "The encrypted index recovery schedule is not configured."
        );
      }
      if (!authorized(request, secret)) {
        throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "This scheduled request is not valid.");
      }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]);
      const result = await drainIndexWorkerUntilIdle({
        client,
        maxWaves: 8,
        signal,
        trigger: "recovery"
      });
      return jsonResponse(result, {
        status: 200,
        headers: { "cache-control": "no-store" }
      });
    } catch (error: unknown) {
      if (error instanceof IndexWorkerInvocationError) {
        return errorResponse(
          new HttpError(
            503,
            ApiErrorCode.PROVIDER_UNAVAILABLE,
            "The encrypted index worker is temporarily unavailable."
          ),
          request
        );
      }
      return errorResponse(error, request);
    }
  };
}

export const indexWorkerCronHandler = createIndexWorkerCronHandler();
