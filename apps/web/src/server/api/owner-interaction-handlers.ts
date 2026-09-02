import {
  ApiErrorCode,
  DecisionCorrectionRequestSchema,
  GeneratedBlockListQuerySchema,
  GeneratedBlockResolveRequestSchema,
  MutationUndoRequestSchema,
  ReviewResolveRequestSchema,
  entityIdSchema,
  type EntityId
} from "@unfiled/contracts";

import { authenticateRequest, type AuthenticatedRequest } from "@/server/auth/session";
import { scheduleIndexDrain as scheduleProductionIndexDrain } from "@/server/indexing/index-worker-scheduler";
import { createProductionOwnerInteractionRepository } from "@/server/owner-interactions/production-repository";
import type {
  OwnerInteractionRepository,
  OwnerInteractionRepositoryContext
} from "@/server/owner-interactions/repository";

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

export type OwnerInteractionHandlerDependencies = Readonly<{
  authenticate?: (request: Request) => Promise<AuthenticatedRequest>;
  repository: OwnerInteractionRepository | ((request: Request) => OwnerInteractionRepository);
  scheduleIndexDrain?: () => void;
}>;

const PRIVATE_OWNER_CONTENT_CACHE_CONTROL = "private, no-store";

function parse<T>(schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "Check the fields in this request and try again."
    );
  }
  return result.data;
}

function parseId<K extends "blk" | "dec" | "mut" | "note" | "rvw">(
  kind: K,
  value: string | undefined
): EntityId<K> {
  return parse(entityIdSchema(kind), value);
}

function privateOwnerContentResponse(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_OWNER_CONTENT_CACHE_CONTROL);
  response.headers.set("pragma", "no-cache");
  return response;
}

export function createOwnerInteractionHandlers(dependencies: OwnerInteractionHandlerDependencies) {
  const authenticate = dependencies.authenticate ?? authenticateRequest;
  const scheduleIndexDrain = dependencies.scheduleIndexDrain ?? scheduleProductionIndexDrain;

  async function run(
    request: Request,
    action: (
      repository: OwnerInteractionRepository,
      context: OwnerInteractionRepositoryContext
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

  function scheduleCommittedIndexWork(): void {
    try {
      scheduleIndexDrain();
    } catch {
      // The committed mutation and encrypted index queue remain authoritative.
    }
  }

  return Object.freeze({
    methodNotAllowed(allow: string): Response {
      return privateOwnerContentResponse(
        new Response(null, {
          status: 405,
          headers: { allow }
        })
      );
    },

    correctDecision(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(DecisionCorrectionRequestSchema, body);
        requireIdempotencyKey(request, body);
        const response = await repository.correctDecision(
          context,
          parseId("dec", parameters.decisionId),
          input
        );
        scheduleCommittedIndexWork();
        return jsonResponse(response);
      });
    },

    listGeneratedBlocks(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        if (
          [...url.searchParams.keys()].some((key) => key !== "cursor") ||
          url.searchParams.getAll("cursor").length > 1
        ) {
          throw new HttpError(
            400,
            ApiErrorCode.VALIDATION_FAILED,
            "That generated-block page cursor is invalid."
          );
        }
        const query = parse(GeneratedBlockListQuerySchema, {
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {})
        });
        const response = await repository.listGeneratedBlocks(
          context,
          parseId("note", parameters.noteId),
          query
        );
        return jsonResponse(response);
      });
    },

    getGeneratedBlock(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const response = await repository.getGeneratedBlock(
          context,
          parseId("blk", parameters.blockId)
        );
        return jsonResponse(response);
      });
    },

    resolveGeneratedBlock(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(GeneratedBlockResolveRequestSchema, body);
        requireIdempotencyKey(request, body);
        const response = await repository.resolveGeneratedBlock(
          context,
          parseId("blk", parameters.blockId),
          input
        );
        return jsonResponse(response);
      });
    },

    resolveReviewItem(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(ReviewResolveRequestSchema, body);
        requireIdempotencyKey(request, body);
        const response = await repository.resolveReviewItem(
          context,
          parseId("rvw", parameters.reviewItemId),
          input
        );
        scheduleCommittedIndexWork();
        return jsonResponse(response);
      });
    },

    undoMutationBatch(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(MutationUndoRequestSchema, body);
        requireIdempotencyKey(request, body);
        const response = await repository.undoMutationBatch(
          context,
          parseId("mut", parameters.mutationId),
          input
        );
        scheduleCommittedIndexWork();
        return jsonResponse(response);
      });
    }
  });
}

export const ownerInteractionHandlers = createOwnerInteractionHandlers({
  repository: (request) =>
    createProductionOwnerInteractionRepository({ signalForOperation: () => request.signal })
});
