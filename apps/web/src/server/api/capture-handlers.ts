import {
  ApiErrorCode,
  CaptureCreateRequestSchema,
  CaptureDeleteRequestSchema,
  CaptureListQuerySchema,
  CaptureRetryRequestSchema,
  entityIdSchema,
  type EntityId
} from "@unfiled/contracts";

import { authenticateRequest, type AuthenticatedRequest } from "@/server/auth/session";
import { createProductionCaptureRepository } from "@/server/captures/supabase-http-repository";
import type { CaptureRepository, CaptureRepositoryContext } from "@/server/captures/repository";
import { scheduleCaptureDrain } from "@/server/captures/workflow-scheduler";

import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJsonObject,
  requireIdempotencyKey
} from "./errors";

type RouteParameters = Readonly<Record<string, string>>;

type Schema<T> = Readonly<{
  safeParse(
    value: unknown
  ):
    | Readonly<{ data: T; success: true }>
    | Readonly<{ error: { issues: readonly unknown[] }; success: false }>;
}>;

export type CaptureHandlerDependencies = Readonly<{
  authenticate?: (request: Request) => Promise<AuthenticatedRequest>;
  repository: CaptureRepository | ((request: Request) => CaptureRepository);
  scheduleDrain?: () => void;
}>;

function parse<T>(schema: Schema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "Check the fields in this request and try again."
    );
  }
  return parsed.data;
}

function captureId(value: string | undefined): EntityId<"cap"> {
  return parse(entityIdSchema("cap"), value);
}

function requireCaptureIdempotency(request: Request, expected: string): void {
  if (requireIdempotencyKey(request) !== expected) {
    throw new HttpError(
      409,
      ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
      "The idempotency key must match the client capture identifier."
    );
  }
}

function noStore(value: unknown, status = 200): Response {
  return jsonResponse(value, { status, headers: { "cache-control": "no-store" } });
}

export function createCaptureHandlers(dependencies: CaptureHandlerDependencies) {
  const authenticate = dependencies.authenticate ?? authenticateRequest;
  const scheduleDrain = dependencies.scheduleDrain ?? (() => undefined);

  async function run(
    request: Request,
    action: (repository: CaptureRepository, context: CaptureRepositoryContext) => Promise<Response>
  ): Promise<Response> {
    try {
      const session = await authenticate(request);
      const repository =
        typeof dependencies.repository === "function"
          ? dependencies.repository(request)
          : dependencies.repository;
      const response = await action(repository, {
        accessToken: session.accessToken,
        userId: session.user.id
      });
      for (const cookie of session.cookies) response.headers.append("set-cookie", cookie);
      return response;
    } catch (error: unknown) {
      return errorResponse(error, request);
    }
  }

  return Object.freeze({
    createCapture(request: Request) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(CaptureCreateRequestSchema, body);
        requireCaptureIdempotency(request, input.clientCaptureId);
        const result = await repository.createCapture(context, input);
        scheduleDrain();
        return noStore(result, 202);
      });
    },

    listCaptures(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const allowed = new Set(["cursor", "limit", "status", "from", "to"]);
        if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
          throw new HttpError(
            400,
            ApiErrorCode.VALIDATION_FAILED,
            "That capture filter is not supported."
          );
        }
        const query = parse(CaptureListQuerySchema, {
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
          ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {}),
          ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") } : {}),
          ...(url.searchParams.has("from") ? { from: url.searchParams.get("from") } : {}),
          ...(url.searchParams.has("to") ? { to: url.searchParams.get("to") } : {})
        });
        const result = await repository.listCaptures(context, query);
        scheduleDrain();
        return noStore(result);
      });
    },

    getCapture(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const result = await repository.getCapture(context, captureId(parameters.captureId));
        scheduleDrain();
        return noStore(result);
      });
    },

    getReceipt(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const result = await repository.getReceipt(context, captureId(parameters.captureId));
        scheduleDrain();
        return noStore(result);
      });
    },

    retryCapture(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(CaptureRetryRequestSchema, body);
        requireIdempotencyKey(request, body);
        const result = await repository.retryCapture(
          context,
          captureId(parameters.captureId),
          input.idempotencyKey
        );
        scheduleDrain();
        return noStore(result, 202);
      });
    },

    deleteCapture(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(CaptureDeleteRequestSchema, body);
        requireIdempotencyKey(request, body);
        return noStore(
          await repository.deleteCapture(context, captureId(parameters.captureId), input)
        );
      });
    }
  });
}

export const captureHandlers = createCaptureHandlers({
  repository: createProductionCaptureRepository,
  scheduleDrain: scheduleCaptureDrain
});
