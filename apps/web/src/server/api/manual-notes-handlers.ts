import { createHash } from "node:crypto";

import {
  ApiErrorCode,
  InteractiveOperationsRequestSchema,
  MutationUndoRequestSchema,
  NoteArchiveRequestSchema,
  NoteCreateRequestSchema,
  NoteLinkCreateRequestSchema,
  NoteLinkDeleteRequestSchema,
  NoteMoveRequestSchema,
  NoteRestoreDeletedRequestSchema,
  NoteRestoreRequestSchema,
  NoteSoftDeleteRequestSchema,
  NoteTagLinkRequestSchema,
  NoteTagUnlinkRequestSchema,
  NoteUpdateRequestSchema,
  ReviewItemListQuerySchema,
  SpaceArchiveRequestSchema,
  SpaceCreateRequestSchema,
  SpaceUpdateRequestSchema,
  TagCreateRequestSchema,
  TagDeleteRequestSchema,
  TagUpdateRequestSchema,
  entityIdSchema,
  type EntityId,
  type NoteDto,
  type NoteSummary,
  type SearchNoteResult,
  type Space
} from "@unfiled/contracts";

import type { NoteMutationResult, NoteRecord, SpaceRecord } from "@/lib/product/types";
import { authenticateRequest, type AuthenticatedRequest } from "@/server/auth/session";
import { scheduleIndexDrain as scheduleProductionIndexDrain } from "@/server/indexing/index-worker-scheduler";
import { createProductionRepository } from "@/server/product/supabase-http-repository";
import type { ManualNotesRepository, RepositoryContext } from "@/server/product/repository";

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

export type ManualNotesDependencies = Readonly<{
  authenticate?: (request: Request) => Promise<AuthenticatedRequest>;
  repository: ManualNotesRepository | (() => ManualNotesRepository);
  scheduleIndexDrain?: () => void;
}>;

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

function parseId<K extends "lnk" | "mut" | "note" | "rev" | "spc" | "tag">(
  kind: K,
  value: string | undefined
): EntityId<K> {
  return parse(entityIdSchema(kind), value);
}

function canonicalNote(note: NoteRecord): NoteDto {
  return {
    id: note.id,
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData,
    currentRevision: note.currentRevision,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: note.tagIds,
    links: note.links.map(({ linkType, toNoteId }) => ({ linkType, toNoteId })),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

function noteSummary(note: NoteRecord): NoteSummary {
  return {
    id: note.id,
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    currentRevision: note.currentRevision,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    updatedAt: note.updatedAt
  };
}

function canonicalSpace(space: SpaceRecord): Space {
  return {
    id: space.id,
    parentId: space.parentId,
    name: space.name,
    slug: space.slug,
    sortKey: space.sortKey,
    currentRevision: space.currentRevision,
    archivedAt: space.archivedAt,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt
  };
}

function mutationResponse(result: NoteMutationResult): Readonly<Record<string, unknown>> {
  return {
    note: canonicalNote(result.note),
    revision: result.revision,
    mutationId: result.mutation.id,
    replayed: result.mutation.replayed,
    undo: { eligible: result.mutation.undoAvailable, expiresAt: null }
  };
}

function scopeHash(scope: string): string {
  return createHash("sha256").update(scope).digest("base64url").slice(0, 16);
}

function cursorOffset(value: string | null, scope: string): number {
  if (value === null) return 0;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(value)) throw new TypeError("invalid cursor");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const [version, offsetValue, hash, extra] = decoded.split(":");
    const offset = Number(offsetValue);
    if (
      version !== "v1" ||
      extra !== undefined ||
      hash !== scopeHash(scope) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100_000
    ) {
      throw new TypeError("invalid cursor");
    }
    return offset;
  } catch {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "That page cursor is invalid or no longer matches these filters."
    );
  }
}

function pageWindow<T>(
  values: readonly T[],
  limit: number,
  offset: number,
  scope: string
): Readonly<{
  items: readonly T[];
  pageInfo: Readonly<{ hasMore: boolean; nextCursor: string | null }>;
}> {
  const hasMore = values.length > limit;
  return {
    items: values.slice(0, limit),
    pageInfo: {
      hasMore,
      nextCursor: hasMore
        ? Buffer.from(`v1:${offset + limit}:${scopeHash(scope)}`, "utf8").toString("base64url")
        : null
    }
  };
}

function enumQuery<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  if (value === null || value.length === 0) return fallback;
  if (values.includes(value as T)) return value as T;
  throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "That filter is not valid.");
}

function positiveLimit(value: string | null): number {
  if (value === null) return 30;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Limit must be between 1 and 100.");
  }
  return parsed;
}

export function createManualNotesHandlers(dependencies: ManualNotesDependencies) {
  const authenticate = dependencies.authenticate ?? authenticateRequest;
  const scheduleIndexDrain = dependencies.scheduleIndexDrain ?? scheduleProductionIndexDrain;

  function noteMutationResponse(result: NoteMutationResult, status = 200): Response {
    try {
      scheduleIndexDrain();
    } catch {
      // The committed mutation and encrypted index queue are authoritative.
    }
    return jsonResponse(mutationResponse(result), status);
  }

  async function run(
    request: Request,
    action: (repository: ManualNotesRepository, context: RepositoryContext) => Promise<Response>
  ): Promise<Response> {
    try {
      const session = await authenticate(request);
      const repository =
        typeof dependencies.repository === "function"
          ? dependencies.repository()
          : dependencies.repository;
      const response = await action(repository, {
        accessToken: session.accessToken,
        userId: session.user.id
      });
      for (const cookie of session.cookies) response.headers.append("set-cookie", cookie);
      return response;
    } catch (error) {
      return errorResponse(error, request);
    }
  }

  return Object.freeze({
    listNotes(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const archive = enumQuery(
          url.searchParams.get("archive"),
          ["exclude", "include", "only"] as const,
          "exclude"
        );
        const deleted = enumQuery(
          url.searchParams.get("deleted"),
          ["exclude", "only"] as const,
          "exclude"
        );
        const spaceValue = url.searchParams.get("spaceId");
        const type = enumQuery(
          url.searchParams.get("type"),
          ["generic", "list", "log", "principle", "project"] as const,
          "generic"
        );
        const hasType = url.searchParams.has("type");
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({
          archive,
          deleted,
          route: "notes",
          spaceId: spaceValue,
          type: hasType ? type : null
        });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const notes = await repository.listNotes(context, {
          archived: archive,
          deleted,
          limit: limit + 1,
          offset,
          ...(spaceValue === null
            ? {}
            : { spaceId: spaceValue === "root" ? null : parseId("spc", spaceValue) }),
          ...(hasType ? { type } : {})
        });
        const page = pageWindow(notes.map(noteSummary), limit, offset, scope);
        return jsonResponse(page);
      });
    },

    createNote(request: Request) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteCreateRequestSchema, body);
        const idempotencyKey = requireIdempotencyKey(request, body);
        const result = await repository.createNote(
          context,
          {
            bodyMarkdown: input.bodyMarkdown,
            links: input.links,
            privacy: input.privacy,
            spaceId: input.spaceId ?? null,
            tagIds: input.tagIds,
            title: input.title,
            type: input.type
          },
          idempotencyKey
        );
        return noteMutationResponse(result, 201);
      });
    },

    getNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const note = await repository.getNote(context, parseId("note", parameters.noteId));
        return jsonResponse({ note: canonicalNote(note) });
      });
    },

    updateNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteUpdateRequestSchema, body);
        const update = {
          expectedRevision: input.expectedRevision,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.bodyMarkdown === undefined ? {} : { bodyMarkdown: input.bodyMarkdown }),
          ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
          ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
          ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
          ...(input.links === undefined ? {} : { links: input.links })
        };
        const result = await repository.updateNote(
          context,
          parseId("note", parameters.noteId),
          update,
          requireIdempotencyKey(request, body)
        );
        return noteMutationResponse(result);
      });
    },

    deleteNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteSoftDeleteRequestSchema, body);
        const result = await repository.deleteNote(context, parseId("note", parameters.noteId), {
          expectedRevision: input.expectedRevision,
          idempotencyKey: requireIdempotencyKey(request, body)
        });
        return noteMutationResponse(result);
      });
    },

    moveNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteMoveRequestSchema, body);
        const result = await repository.moveNote(context, parseId("note", parameters.noteId), {
          expectedRevision: input.expectedRevision,
          idempotencyKey: requireIdempotencyKey(request, body),
          spaceId: input.spaceId
        });
        return noteMutationResponse(result);
      });
    },

    archiveNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteArchiveRequestSchema, body);
        const result = await repository.archiveNote(context, parseId("note", parameters.noteId), {
          archived: input.archived,
          expectedRevision: input.expectedRevision,
          idempotencyKey: requireIdempotencyKey(request, body)
        });
        return noteMutationResponse(result);
      });
    },

    restoreDeletedNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteRestoreDeletedRequestSchema, body);
        const result = await repository.restoreDeletedNote(
          context,
          parseId("note", parameters.noteId),
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    applyOperations(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(InteractiveOperationsRequestSchema, body);
        const result = await repository.applyOperations(
          context,
          parseId("note", parameters.noteId),
          input.operations,
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    listRevisions(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const noteId = parseId("note", parameters.noteId);
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({ noteId, route: "note-revisions" });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const revisions = await repository.listRevisions(context, noteId, {
          limit: limit + 1,
          offset
        });
        return jsonResponse(pageWindow(revisions, limit, offset, scope));
      });
    },

    restoreRevision(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteRestoreRequestSchema, body);
        const result = await repository.restoreRevision(
          context,
          parseId("note", parameters.noteId),
          input.revisionId,
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    undoMutation(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(MutationUndoRequestSchema, body);
        const result = await repository.undoMutation(
          context,
          parseId("mut", parameters.mutationId),
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    listSpaces(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const includeValue = url.searchParams.get("includeArchived");
        if (includeValue !== null && includeValue !== "true" && includeValue !== "false") {
          throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "That filter is not valid.");
        }
        const includeArchived = includeValue === "true";
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({ includeArchived, route: "spaces" });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const spaces = await repository.listSpaces(context, includeArchived, {
          limit: limit + 1,
          offset
        });
        return jsonResponse(pageWindow(spaces.map(canonicalSpace), limit, offset, scope));
      });
    },

    createSpace(request: Request) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(SpaceCreateRequestSchema, body);
        const result = await repository.createSpace(
          context,
          {
            name: input.name,
            parentId: input.parentId,
            ...(input.sortKey === undefined ? {} : { sortKey: input.sortKey })
          },
          requireIdempotencyKey(request, body)
        );
        return jsonResponse(
          { space: canonicalSpace(result.space), replayed: result.replayed },
          201
        );
      });
    },

    getSpace(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const spaceId = parseId("spc", parameters.spaceId);
        const space = (await repository.listSpaces(context, true)).find(
          (candidate) => candidate.id === spaceId
        );
        if (space === undefined) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That space was not found.");
        }
        return jsonResponse({ space: canonicalSpace(space) });
      });
    },

    updateSpace(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(SpaceUpdateRequestSchema, body);
        const patch = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.sortKey === undefined ? {} : { sortKey: input.sortKey })
        };
        const result = await repository.updateSpace(
          context,
          parseId("spc", parameters.spaceId),
          patch,
          input.expectedRevision,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse({
          space: canonicalSpace(result.space),
          replayed: result.replayed
        });
      });
    },

    archiveSpace(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(SpaceArchiveRequestSchema, body);
        const result = await repository.archiveSpace(
          context,
          parseId("spc", parameters.spaceId),
          input.archived,
          input.expectedRevision,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse({
          space: canonicalSpace(result.space),
          replayed: result.replayed
        });
      });
    },

    listTags(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({ route: "tags" });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const tags = await repository.listTags(context, { limit: limit + 1, offset });
        return jsonResponse(pageWindow(tags, limit, offset, scope));
      });
    },

    createTag(request: Request) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(TagCreateRequestSchema, body);
        const result = await repository.createTag(
          context,
          input.name,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse(result, 201);
      });
    },

    updateTag(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(TagUpdateRequestSchema, body);
        const result = await repository.updateTag(
          context,
          parseId("tag", parameters.tagId),
          input.name,
          input.expectedRevision,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse(result);
      });
    },

    deleteTag(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(TagDeleteRequestSchema, body);
        const tagId = parseId("tag", parameters.tagId);
        const result = await repository.deleteTag(
          context,
          tagId,
          input.expectedRevision,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse(result);
      });
    },

    listNoteLinks(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const items = await repository.listLinks(context, parseId("note", parameters.noteId));
        return jsonResponse({ items });
      });
    },

    createNoteLink(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteLinkCreateRequestSchema, body);
        const result = await repository.createLink(context, parseId("note", parameters.noteId), {
          expectedRevision: input.expectedRevision,
          idempotencyKey: requireIdempotencyKey(request, body),
          linkType: input.linkType,
          toNoteId: input.toNoteId
        });
        return noteMutationResponse(result);
      });
    },

    deleteNoteLink(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteLinkDeleteRequestSchema, body);
        const result = await repository.deleteLink(
          context,
          parseId("note", parameters.noteId),
          parseId("lnk", parameters.linkId),
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body),
            linkType: input.linkType,
            toNoteId: input.toNoteId
          }
        );
        return noteMutationResponse(result);
      });
    },

    linkTag(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteTagLinkRequestSchema, body);
        const result = await repository.linkTag(
          context,
          parseId("note", parameters.noteId),
          input.tagId,
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    unlinkTag(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteTagUnlinkRequestSchema, body);
        const result = await repository.unlinkTag(
          context,
          parseId("note", parameters.noteId),
          parseId("tag", parameters.tagId),
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    listReviewItems(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const input = parse(ReviewItemListQuerySchema, {
          ...(url.searchParams.has("state") ? { state: url.searchParams.get("state") } : {}),
          ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {}),
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {})
        });
        const scope = JSON.stringify({ route: "review-items", state: input.state });
        const offset = cursorOffset(input.cursor ?? null, scope);
        const items = await repository.listReviewItems(context, input.state, {
          limit: input.limit + 1,
          offset
        });
        return jsonResponse(pageWindow(items, input.limit, offset, scope));
      });
    },

    search(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (query.length < 1 || query.length > 200) {
          throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Enter a search term.");
        }
        const archive = enumQuery(
          url.searchParams.get("archive"),
          ["exclude", "include", "only"] as const,
          "exclude"
        );
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({ archive, query, route: "search" });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const result = await repository.search(context, query, archive, {
          limit: limit + 1,
          offset
        });
        const items: SearchNoteResult[] = result.results.map(({ note, snippet }) => ({
          noteId: note.id,
          title: note.title,
          type: note.type,
          snippet,
          spacePath: note.spacePath?.split(" / ") ?? [],
          updatedAt: note.updatedAt,
          archivedAt: note.archivedAt
        }));
        return jsonResponse(pageWindow(items, limit, offset, scope));
      });
    }
  });
}

export const manualNotesHandlers = createManualNotesHandlers({
  repository: createProductionRepository
});
