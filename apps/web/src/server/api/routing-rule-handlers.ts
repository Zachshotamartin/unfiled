import {
  ApiErrorCode,
  RoutingRuleCreateRequestSchema,
  RoutingRuleDeleteRequestSchema,
  RoutingRuleListQuerySchema,
  RoutingRuleUpdateRequestSchema,
  entityIdSchema,
  type EntityId
} from "@unfiled/contracts";

import { authenticateRequest, type AuthenticatedRequest } from "@/server/auth/session";
import { createProductionRoutingRuleRepository } from "@/server/routing-rules/production-repository";
import type {
  RoutingRuleRepository,
  RoutingRuleRepositoryContext
} from "@/server/routing-rules/repository";

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

export type RoutingRuleHandlerDependencies = Readonly<{
  authenticate?: (request: Request) => Promise<AuthenticatedRequest>;
  repository: RoutingRuleRepository | ((request: Request) => RoutingRuleRepository);
}>;

const PRIVATE_OWNER_CONTENT_CACHE_CONTROL = "private, no-store";

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

function ruleId(value: string | undefined): EntityId<"rule"> {
  return parse(entityIdSchema("rule"), value);
}

function privateOwnerContentResponse(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_OWNER_CONTENT_CACHE_CONTROL);
  response.headers.set("pragma", "no-cache");
  return response;
}

export function createRoutingRuleHandlers(dependencies: RoutingRuleHandlerDependencies) {
  const authenticate = dependencies.authenticate ?? authenticateRequest;

  async function run(
    request: Request,
    action: (
      repository: RoutingRuleRepository,
      context: RoutingRuleRepositoryContext
    ) => Promise<Response>
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
      return privateOwnerContentResponse(response);
    } catch (error: unknown) {
      return privateOwnerContentResponse(errorResponse(error, request));
    }
  }

  return Object.freeze({
    methodNotAllowed(allow: string): Response {
      return privateOwnerContentResponse(new Response(null, { status: 405, headers: { allow } }));
    },

    list(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        if (
          [...url.searchParams.keys()].some((key) => key !== "cursor") ||
          url.searchParams.getAll("cursor").length > 1
        ) {
          throw new HttpError(
            400,
            ApiErrorCode.VALIDATION_FAILED,
            "That routing-rule page cursor is invalid."
          );
        }
        const query = parse(RoutingRuleListQuerySchema, {
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {})
        });
        return jsonResponse(await repository.list(context, query));
      });
    },

    create(request: Request) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(RoutingRuleCreateRequestSchema, body);
        requireIdempotencyKey(request, body);
        return jsonResponse(await repository.create(context, input), { status: 201 });
      });
    },

    update(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(RoutingRuleUpdateRequestSchema, body);
        requireIdempotencyKey(request, body);
        return jsonResponse(await repository.update(context, ruleId(parameters.ruleId), input));
      });
    },

    delete(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(RoutingRuleDeleteRequestSchema, body);
        requireIdempotencyKey(request, body);
        return jsonResponse(await repository.delete(context, ruleId(parameters.ruleId), input));
      });
    }
  });
}

export const routingRuleHandlers = createRoutingRuleHandlers({
  repository: (request) =>
    createProductionRoutingRuleRepository({ signalForOperation: () => request.signal })
});
