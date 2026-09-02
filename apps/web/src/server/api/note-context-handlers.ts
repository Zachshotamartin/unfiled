import {
  ApiErrorCode,
  NoteBacklinksQuerySchema,
  NoteSourcesQuerySchema,
  entityIdSchema,
  type EntityId
} from "@unfiled/contracts";

import { authenticateRequest, type AuthenticatedRequest } from "@/server/auth/session";
import { createProductionNoteContextRepository } from "@/server/note-context/production-repository";
import type { NoteContextRepository } from "@/server/note-context/repository";

import { errorResponse, HttpError, jsonResponse } from "./errors";

type RouteParameters = Readonly<Record<string, string>>;
type Schema<T> = Readonly<{
  safeParse(
    value: unknown
  ):
    | Readonly<{ data: T; success: true }>
    | Readonly<{ error: { issues: readonly unknown[] }; success: false }>;
}>;

export type NoteContextHandlerDependencies = Readonly<{
  authenticate?: (request: Request) => Promise<AuthenticatedRequest>;
  repository: NoteContextRepository | ((request: Request) => NoteContextRepository);
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

function noteId(value: string | undefined): EntityId<"note"> {
  return parse(entityIdSchema("note"), value);
}

function listQuery<T>(request: Request, schema: Schema<T>): T {
  const searchParams = new URL(request.url).searchParams;
  if (
    [...searchParams.keys()].some((key) => key !== "cursor" && key !== "limit") ||
    searchParams.getAll("cursor").length > 1 ||
    searchParams.getAll("limit").length > 1
  ) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "That note-context page request is invalid."
    );
  }
  return parse(schema, {
    ...(searchParams.has("cursor") ? { cursor: searchParams.get("cursor") } : {}),
    ...(searchParams.has("limit") ? { limit: searchParams.get("limit") } : {})
  });
}

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_OWNER_CONTENT_CACHE_CONTROL);
  response.headers.set("pragma", "no-cache");
  return response;
}

export function createNoteContextHandlers(dependencies: NoteContextHandlerDependencies) {
  const authenticate = dependencies.authenticate ?? authenticateRequest;

  async function run(
    request: Request,
    action: (
      repository: NoteContextRepository,
      context: Readonly<{ accessToken: string; userId: string }>
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
      return privateResponse(response);
    } catch (error: unknown) {
      return privateResponse(errorResponse(error, request));
    }
  }

  return Object.freeze({
    listSources(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) =>
        jsonResponse(
          await repository.listSources(
            context,
            noteId(parameters.noteId),
            listQuery(request, NoteSourcesQuerySchema)
          )
        )
      );
    },

    listBacklinks(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) =>
        jsonResponse(
          await repository.listBacklinks(
            context,
            noteId(parameters.noteId),
            listQuery(request, NoteBacklinksQuerySchema)
          )
        )
      );
    }
  });
}

export const noteContextHandlers = createNoteContextHandlers({
  repository: (request) =>
    createProductionNoteContextRepository({ signalForOperation: () => request.signal })
});
