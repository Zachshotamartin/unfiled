import {
  ApiErrorCode,
  type EntityId,
  type ReviewItemDto,
  type ReviewState,
  type UserOperation
} from "@unfiled/contracts";

import type {
  NoteLinkRecord,
  NoteListFilters,
  NoteMutationResult,
  NoteRecord,
  RevisionRecord,
  SearchResponse,
  SpaceMutationRecord,
  SpaceRecord,
  TagDeleteMutationRecord,
  TagMutationRecord,
  TagRecord,
  UpdateNoteInput,
  CreateNoteInput
} from "@/lib/product/types";
import { ConfigurationError, HttpError } from "@/server/api/errors";
import { InMemoryManualNotesRepository } from "@/server/product/in-memory-repository";

import type {
  ExistingNoteWrite,
  ManualNotesRepository,
  RepositoryContext,
  RepositoryPage
} from "./repository";
import { createProductionManualNotesComposition } from "./production-repository-composition";
import {
  asObject,
  field,
  mapLink,
  mapNote,
  mapReviewItem,
  mapRevision,
  mapSpace,
  mapStoredMutationNote,
  mapTag,
  nullableString,
  stringValue
} from "./supabase-http-mappers";

type SupabaseConfiguration = Readonly<{ anonKey: string; url: string }>;

function configuration(): SupabaseConfiguration {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url === undefined || anonKey === undefined) throw new ConfigurationError();
  return { anonKey, url: url.replace(/\/$/u, "") };
}

async function request(
  context: RepositoryContext,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const config = configuration();
  const headers = new Headers(init?.headers);
  headers.set("apikey", config.anonKey);
  headers.set("authorization", `Bearer ${context.accessToken}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    cache: "no-store",
    headers
  });
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.ok) return body;

  const error = body === null || typeof body !== "object" ? {} : (body as Record<string, unknown>);
  const message = typeof error.message === "string" ? error.message : "";
  if (message.includes("stale_revision")) {
    throw new HttpError(
      409,
      ApiErrorCode.STALE_REVISION,
      "This note changed somewhere else. Review the latest version."
    );
  }
  if (message.includes("invalid_idempotency_key")) {
    throw new HttpError(
      409,
      ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
      "That action key was already used for something different."
    );
  }
  if (message.includes("structure_conflict")) {
    throw new HttpError(
      409,
      ApiErrorCode.STRUCTURE_CONFLICT,
      "This edit changes structured content ambiguously."
    );
  }
  if (message.includes("conflict_requires_review")) {
    throw new HttpError(
      409,
      ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
      "This change needs review before it can be applied."
    );
  }
  if (message.includes("not_found") || response.status === 404) {
    throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That item was not found.");
  }
  if (message.includes("validation_failed")) {
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Check this request and try again.");
  }
  if (message.includes("unauthorized") || response.status === 401) {
    throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
  }
  if (response.status === 403) {
    throw new HttpError(403, ApiErrorCode.FORBIDDEN, "You do not have access to that item.");
  }
  throw new HttpError(
    503,
    ApiErrorCode.PROVIDER_UNAVAILABLE,
    "The data service could not complete that action."
  );
}

async function rpc(
  context: RepositoryContext,
  functionName: string,
  parameters: Readonly<Record<string, unknown>>
): Promise<unknown> {
  return request(context, `rpc/${functionName}`, {
    method: "POST",
    body: JSON.stringify(parameters)
  });
}

function mutationResult(value: unknown): NoteMutationResult {
  const row = asObject(Array.isArray(value) ? value[0] : value);
  if (field(row, "errorCode", "error_code") === ApiErrorCode.STRUCTURE_CONFLICT) {
    throw new HttpError(
      409,
      ApiErrorCode.STRUCTURE_CONFLICT,
      "This edit could not be reconciled safely. The saved note was left unchanged."
    );
  }
  const note = mapStoredMutationNote(row.note);
  const revision = mapRevision(row.revision);
  const mutationId = stringValue(row, "mutationId", "mutation_id") as EntityId<"mut">;
  const undo = asObject(row.undo);
  return {
    note,
    revision,
    mutation: {
      id: mutationId,
      beforeRevision: Math.max(0, note.currentRevision - 1),
      afterRevision: note.currentRevision,
      replayed: row.replayed === true,
      undoAvailable: undo.eligible === true
    }
  };
}

function writeParameters(input: ExistingNoteWrite): Record<string, unknown> {
  return {
    p_expected_revision: input.expectedRevision,
    p_idempotency_key: input.idempotencyKey
  };
}

export class SupabaseHttpManualNotesRepository implements ManualNotesRepository {
  public async listNotes(
    context: RepositoryContext,
    filters: NoteListFilters
  ): Promise<readonly NoteRecord[]> {
    const clauses = [
      "select=*",
      "order=updated_at.desc,id.asc",
      `limit=${filters.limit ?? 100}`,
      `offset=${filters.offset ?? 0}`
    ];
    if (filters.deleted === "only") clauses.push("deleted_at=not.is.null");
    else clauses.push("deleted_at=is.null");
    if (filters.archived === "exclude" || filters.archived === undefined)
      clauses.push("archived_at=is.null");
    if (filters.archived === "only") clauses.push("archived_at=not.is.null");
    if (filters.spaceId === null) clauses.push("space_id=is.null");
    else if (filters.spaceId !== undefined)
      clauses.push(`space_id=eq.${encodeURIComponent(filters.spaceId)}`);
    if (filters.type !== undefined) clauses.push(`type=eq.${filters.type}`);
    const value = await request(context, `notes?${clauses.join("&")}`);
    return Array.isArray(value) ? value.map(mapNote) : [];
  }

  public async getNote(context: RepositoryContext, noteId: EntityId<"note">): Promise<NoteRecord> {
    const value = await request(
      context,
      `notes?id=eq.${encodeURIComponent(noteId)}&select=*&limit=1`
    );
    if (!Array.isArray(value) || value[0] === undefined)
      throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That note was not found.");
    const base = mapNote(value[0]);
    const [tags, links] = await Promise.all([
      this.listTagsForNote(context, noteId),
      this.listLinks(context, noteId)
    ]);
    return { ...base, tagIds: tags.map((tag) => tag.id), tags, links };
  }

  private async listTagsForNote(
    context: RepositoryContext,
    noteId: EntityId<"note">
  ): Promise<readonly TagRecord[]> {
    const value = await request(
      context,
      `note_tags?note_id=eq.${encodeURIComponent(noteId)}&select=tags(id,name,current_revision,created_at)`
    );
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      const tags = asObject(entry).tags;
      return tags === null || tags === undefined ? [] : [mapTag(tags)];
    });
  }

  private async revisionSnapshot(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    revision: number
  ): Promise<RevisionRecord> {
    const value = await request(
      context,
      `note_revisions?note_id=eq.${encodeURIComponent(noteId)}&revision=eq.${revision}&select=*&limit=1`
    );
    if (!Array.isArray(value) || value[0] === undefined) {
      throw new HttpError(
        409,
        ApiErrorCode.STALE_REVISION,
        "This note changed somewhere else. Review the latest version."
      );
    }
    return mapRevision(value[0]);
  }

  public async createNote(
    context: RepositoryContext,
    input: CreateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult> {
    return mutationResult(
      await rpc(context, "create_note", {
        p_idempotency_key: idempotencyKey,
        p_type: input.type,
        p_title: input.title,
        p_body_markdown: input.bodyMarkdown,
        p_space_id: input.spaceId,
        p_privacy: input.privacy,
        p_tag_ids: input.tagIds,
        p_links: input.links
      })
    );
  }

  public async updateNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: UpdateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult> {
    const operations = [
      ...(input.title === undefined ? [] : [{ type: "set_title", title: input.title }]),
      ...(input.bodyMarkdown === undefined
        ? []
        : [{ type: "replace_body_markdown", bodyMarkdown: input.bodyMarkdown }]),
      ...(input.privacy === undefined ? [] : [{ type: "set_privacy", privacy: input.privacy }]),
      ...(input.spaceId === undefined ? [] : [{ type: "move_to_space", spaceId: input.spaceId }]),
      ...(input.tagIds === undefined ? [] : [{ type: "set_tags", tagIds: input.tagIds }]),
      ...(input.links === undefined ? [] : [{ type: "set_note_links", links: input.links }])
    ];
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_expected_revision: input.expectedRevision,
        p_operations: operations,
        p_idempotency_key: idempotencyKey
      })
    );
  }

  public async applyOperations(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    operations: readonly UserOperation[],
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: operations,
        ...writeParameters(input)
      })
    );
  }

  public async moveNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { spaceId: EntityId<"spc"> | null }
  ): Promise<NoteMutationResult> {
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: [{ type: "move_to_space", spaceId: input.spaceId }],
        ...writeParameters(input)
      })
    );
  }

  public async archiveNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { archived: boolean }
  ): Promise<NoteMutationResult> {
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: [
          { type: "set_archived", archivedAt: input.archived ? new Date().toISOString() : null }
        ],
        ...writeParameters(input)
      })
    );
  }

  public async deleteNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: [{ type: "set_deleted", deletedAt: new Date().toISOString() }],
        ...writeParameters(input)
      })
    );
  }

  public async restoreDeletedNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: [{ type: "set_deleted", deletedAt: null }],
        ...writeParameters(input)
      })
    );
  }

  public async listRevisions(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    page?: RepositoryPage
  ): Promise<readonly RevisionRecord[]> {
    const pagination = page === undefined ? "" : `&limit=${page.limit}&offset=${page.offset}`;
    const value = await request(
      context,
      `note_revisions?note_id=eq.${encodeURIComponent(noteId)}&select=*&order=revision.desc${pagination}`
    );
    return Array.isArray(value) ? value.map(mapRevision) : [];
  }

  public async listReviewItems(
    context: RepositoryContext,
    state: ReviewState,
    page?: RepositoryPage
  ): Promise<readonly ReviewItemDto[]> {
    const pagination = page === undefined ? "" : `&limit=${page.limit}&offset=${page.offset}`;
    const value = await request(
      context,
      `review_items?state=eq.${state}&select=id,capture_id,note_id,type,choices,state,resolution,created_at,resolved_at&order=created_at.desc,id.asc${pagination}`
    );
    return Array.isArray(value) ? value.map(mapReviewItem) : [];
  }

  public async restoreRevision(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    revisionId: EntityId<"rev">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return mutationResult(
      await rpc(context, "restore_note_revision", {
        p_note_id: noteId,
        p_revision_id: revisionId,
        ...writeParameters(input)
      })
    );
  }

  public async undoMutation(
    context: RepositoryContext,
    mutationId: EntityId<"mut">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return mutationResult(
      await rpc(context, "undo_user_mutation", {
        p_mutation_id: mutationId,
        ...writeParameters(input)
      })
    );
  }

  public async listSpaces(
    context: RepositoryContext,
    includeArchived: boolean,
    page?: RepositoryPage
  ): Promise<readonly SpaceRecord[]> {
    const archiveFilter = includeArchived ? "" : "&archived_at=is.null";
    const pagination = page === undefined ? "" : `&limit=${page.limit}&offset=${page.offset}`;
    const value = await request(
      context,
      `spaces?select=*&order=sort_key.asc,name.asc,id.asc${archiveFilter}${pagination}`
    );
    return Array.isArray(value) ? value.map(mapSpace) : [];
  }

  public async createSpace(
    context: RepositoryContext,
    input: { name: string; parentId: EntityId<"spc"> | null; sortKey?: string },
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    const result = asObject(
      await rpc(context, "create_space", {
        p_idempotency_key: idempotencyKey,
        p_name: input.name,
        p_parent_id: input.parentId,
        p_slug: null,
        ...(input.sortKey === undefined ? {} : { p_sort_key: input.sortKey })
      })
    );
    return { space: mapSpace(result.space), replayed: result.replayed === true };
  }

  public async updateSpace(
    context: RepositoryContext,
    spaceId: EntityId<"spc">,
    input: { name?: string; parentId?: EntityId<"spc"> | null; sortKey?: string },
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    const result = asObject(
      await rpc(context, "update_space", {
        p_space_id: spaceId,
        p_patch: input,
        p_expected_revision: expectedRevision,
        p_idempotency_key: idempotencyKey
      })
    );
    return { space: mapSpace(result.space), replayed: result.replayed === true };
  }

  public async archiveSpace(
    context: RepositoryContext,
    spaceId: EntityId<"spc">,
    archived: boolean,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    const result = asObject(
      await rpc(context, "archive_space", {
        p_space_id: spaceId,
        p_archived: archived,
        p_expected_revision: expectedRevision,
        p_idempotency_key: idempotencyKey
      })
    );
    return { space: mapSpace(result.space), replayed: result.replayed === true };
  }

  public async listTags(
    context: RepositoryContext,
    page?: RepositoryPage
  ): Promise<readonly TagRecord[]> {
    const pagination = page === undefined ? "" : `&limit=${page.limit}&offset=${page.offset}`;
    const value = await request(
      context,
      `tags?select=id,name,current_revision,created_at&order=name.asc${pagination}`
    );
    return Array.isArray(value) ? value.map(mapTag) : [];
  }

  public async createTag(
    context: RepositoryContext,
    name: string,
    idempotencyKey: string
  ): Promise<TagMutationRecord> {
    const result = asObject(
      await rpc(context, "create_tag", {
        p_name: name,
        p_idempotency_key: idempotencyKey
      })
    );
    return { tag: mapTag(result.tag), replayed: result.replayed === true };
  }

  public async updateTag(
    context: RepositoryContext,
    tagId: EntityId<"tag">,
    name: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagMutationRecord> {
    const result = asObject(
      await rpc(context, "update_tag", {
        p_tag_id: tagId,
        p_expected_revision: expectedRevision,
        p_name: name,
        p_idempotency_key: idempotencyKey
      })
    );
    return { tag: mapTag(result.tag), replayed: result.replayed === true };
  }

  public async deleteTag(
    context: RepositoryContext,
    tagId: EntityId<"tag">,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagDeleteMutationRecord> {
    const result = asObject(
      await rpc(context, "delete_tag", {
        p_tag_id: tagId,
        p_expected_revision: expectedRevision,
        p_idempotency_key: idempotencyKey
      })
    );
    return {
      deletedId: stringValue(result, "deletedId", "deleted_id") as EntityId<"tag">,
      replayed: result.replayed === true
    };
  }

  public async linkTag(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    const snapshot = await this.revisionSnapshot(context, noteId, input.expectedRevision);
    const tagIds = [...new Set([...snapshot.tagIds, tagId])];
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: [{ type: "set_tags", tagIds }],
        ...writeParameters(input)
      })
    );
  }

  public async unlinkTag(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    const snapshot = await this.revisionSnapshot(context, noteId, input.expectedRevision);
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: [{ type: "set_tags", tagIds: snapshot.tagIds.filter((id) => id !== tagId) }],
        ...writeParameters(input)
      })
    );
  }

  public async listLinks(
    context: RepositoryContext,
    noteId: EntityId<"note">
  ): Promise<readonly NoteLinkRecord[]> {
    const value = await request(
      context,
      `note_links?from_note_id=eq.${encodeURIComponent(noteId)}&select=id,from_note_id,to_note_id,link_type,target:notes!note_links_to_note_id_fkey(title)`
    );
    return Array.isArray(value) ? value.map(mapLink) : [];
  }

  public async createLink(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { linkType: "reference" | "related"; toNoteId: EntityId<"note"> }
  ): Promise<NoteMutationResult> {
    const snapshot = await this.revisionSnapshot(context, noteId, input.expectedRevision);
    const links = [
      ...snapshot.links.map(({ linkType, toNoteId }) => ({ linkType, toNoteId })),
      { linkType: input.linkType, toNoteId: input.toNoteId }
    ];
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: [{ type: "set_note_links", links }],
        ...writeParameters(input)
      })
    );
  }

  public async deleteLink(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    linkId: EntityId<"lnk">,
    input: ExistingNoteWrite & { linkType: "reference" | "related"; toNoteId: EntityId<"note"> }
  ): Promise<NoteMutationResult> {
    const linkValue = await request(
      context,
      `note_links?id=eq.${encodeURIComponent(linkId)}&from_note_id=eq.${encodeURIComponent(noteId)}&select=id,from_note_id,to_note_id,link_type&limit=1`
    );
    const link =
      Array.isArray(linkValue) && linkValue[0] !== undefined ? mapLink(linkValue[0]) : null;
    if (
      link !== null &&
      (link.fromNoteId !== noteId ||
        link.toNoteId !== input.toNoteId ||
        link.linkType !== input.linkType)
    ) {
      throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That link was not found.");
    }
    if (link === null) {
      const noteValue = await request(
        context,
        `notes?id=eq.${encodeURIComponent(noteId)}&select=current_revision&limit=1`
      );
      if (!Array.isArray(noteValue) || noteValue[0] === undefined) {
        throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That link was not found.");
      }
      const currentRevision = field(asObject(noteValue[0]), "currentRevision", "current_revision");
      if (typeof currentRevision !== "number") {
        throw new HttpError(
          503,
          ApiErrorCode.PROVIDER_UNAVAILABLE,
          "The data service response was incomplete."
        );
      }
      // A committed delete no longer has a live link row. Only let a stale request reach
      // the RPC, where the database can distinguish a valid replay from a new stale write.
      if (currentRevision <= input.expectedRevision) {
        throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That link was not found.");
      }
    }
    const snapshot = await this.revisionSnapshot(context, noteId, input.expectedRevision);
    const links = snapshot.links.filter(
      (link) => link.toNoteId !== input.toNoteId || link.linkType !== input.linkType
    );
    return mutationResult(
      await rpc(context, "apply_user_note_mutation", {
        p_note_id: noteId,
        p_operations: [{ type: "set_note_links", links }],
        ...writeParameters(input)
      })
    );
  }

  public async search(
    context: RepositoryContext,
    query: string,
    archived: "exclude" | "include" | "only",
    page?: RepositoryPage
  ): Promise<SearchResponse> {
    const value = await rpc(context, "search_notes", {
      p_query: query,
      p_archive_filter: archived,
      p_limit: page?.limit ?? 50,
      p_offset: page?.offset ?? 0
    });
    const rows = Array.isArray(value) ? value : [];
    const notes = await Promise.all(
      rows.map((entry) =>
        this.getNote(context, stringValue(asObject(entry), "noteId", "note_id") as EntityId<"note">)
      )
    );
    return {
      query,
      results: rows.map((entry, index) => {
        const row = asObject(entry);
        const note = notes[index];
        if (note === undefined) {
          throw new HttpError(
            503,
            ApiErrorCode.PROVIDER_UNAVAILABLE,
            "Search returned an invalid note."
          );
        }
        return {
          note: {
            ...note,
            spacePath: nullableString(row, "spacePath", "space_path")
          },
          snippet: typeof row.snippet === "string" ? row.snippet : ""
        };
      })
    };
  }
}

export function createProductionRepository(request?: Request): ManualNotesRepository {
  if (process.env.UNFILED_WEB_DATA_ADAPTER === "memory") {
    if (process.env.NODE_ENV === "production") throw new ConfigurationError();
    const globalRepository = globalThis as typeof globalThis & {
      __unfiledDevelopmentRepository?: InMemoryManualNotesRepository;
    };
    globalRepository.__unfiledDevelopmentRepository ??= new InMemoryManualNotesRepository();
    return globalRepository.__unfiledDevelopmentRepository;
  }
  return createProductionManualNotesComposition({
    legacy: new SupabaseHttpManualNotesRepository(),
    ...(request === undefined ? {} : { signal: request.signal })
  });
}
