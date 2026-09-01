import { timingSafeEqual } from "node:crypto";

import { ApiErrorCode } from "@unfiled/contracts";

import { errorResponse, HttpError, jsonResponse } from "@/server/api/errors";

import {
  environmentOrganizerClient,
  OrganizerInvocationError,
  type OrganizerClient,
  type OrganizerDrainResult
} from "./organizer-client";

export type CaptureWorkflowHandlerDependencies = Readonly<{
  client?: OrganizerClient;
  drain?: () => Promise<OrganizerDrainResult>;
  getSecret?: () => string | undefined;
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

export function createCaptureWorkflowHandler(
  dependencies: CaptureWorkflowHandlerDependencies = {}
): (request: Request) => Promise<Response> {
  const drain =
    dependencies.drain ??
    (() =>
      (dependencies.client ?? environmentOrganizerClient).drain(
        "recovery",
        AbortSignal.timeout(55_000)
      ));
  const getSecret = dependencies.getSecret ?? (() => process.env.CRON_SECRET);

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
