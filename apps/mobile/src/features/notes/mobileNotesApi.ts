import { ApiClientError, createApiClient } from "@unfiled/api-client";
import type {
  EntityId,
  NoteLinkValue,
  NoteDto,
  NoteRevisionDto,
  NoteSummary,
  NoteType,
  PrivacyMode,
  ReviewItemDto,
  SearchNoteResult,
  Space,
  Tag
} from "@unfiled/contracts";

export type MobileNoteType = NoteType;
export type MobileNotePrivacy = PrivacyMode;
export type MobileNoteSummary = NoteSummary;
export type MobileSpace = Space;
export type MobileTag = Tag;
export type MobileSearchResult = SearchNoteResult;
export type MobileReviewItem = ReviewItemDto;

export interface MobileNoteDetail extends NoteDto {
  revisions: NoteRevisionDto[];
}

export interface NoteWriteInput {
  bodyMarkdown: string;
  idempotencyKey: string;
  links: NoteLinkValue[];
  privacy: MobileNotePrivacy;
  spaceId: string | null;
  tagIds: string[];
  title: string;
  type: MobileNoteType;
}

export interface NoteUpdateInput {
  bodyMarkdown?: string;
  expectedRevision: number;
  idempotencyKey: string;
  links?: NoteLinkValue[];
  privacy?: MobileNotePrivacy;
  spaceId?: string | null;
  tagIds?: string[];
  title?: string;
}

export class MobileNotesError extends Error {
  readonly code: string;
  readonly latestRevision: number | null;
  readonly status: number;

  constructor(code: string, message: string, status: number, latestRevision: number | null = null) {
    super(message);
    this.name = "MobileNotesError";
    this.code = code;
    this.latestRevision = latestRevision;
    this.status = status;
  }
}

type FetchLike = typeof fetch;

interface Page<T> {
  items: T[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

async function collectPages<T>(load: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();

  for (;;) {
    const page = await load(cursor);
    items.push(...page.items);
    if (!page.pageInfo.hasMore) return items;
    const next = page.pageInfo.nextCursor;
    if (next === null || seen.has(next)) {
      throw new MobileNotesError(
        "validation_failed",
        "Unfiled received an invalid pagination cursor.",
        502
      );
    }
    seen.add(next);
    cursor = next;
  }
}

function noteWithRevisions(note: NoteDto, revisions: NoteRevisionDto[] = []): MobileNoteDetail {
  return { ...note, revisions };
}

function mappedError(reason: unknown): MobileNotesError {
  if (reason instanceof MobileNotesError) return reason;
  if (reason instanceof ApiClientError) {
    const latestRevision = reason.error.details?.latestRevision;
    return new MobileNotesError(
      reason.error.code,
      reason.error.message,
      reason.status,
      typeof latestRevision === "number" ? latestRevision : null
    );
  }
  if (reason instanceof TypeError) {
    return new MobileNotesError("validation_failed", "Check this note and try again.", 400);
  }
  return new MobileNotesError("offline", "Connect to update your notes.", 0);
}

async function mapResult<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (reason) {
    throw mappedError(reason);
  }
}

export interface MobileNotesApi {
  archiveNote(
    noteId: string,
    expectedRevision: number,
    idempotencyKey: string,
    archived?: boolean
  ): Promise<MobileNoteDetail>;
  archiveSpace(
    spaceId: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<MobileSpace>;
  createTag(name: string, idempotencyKey: string): Promise<MobileTag>;
  createNote(input: NoteWriteInput): Promise<MobileNoteDetail>;
  createSpace(name: string, parentId: string | null, idempotencyKey: string): Promise<MobileSpace>;
  deleteTag(tagId: string, expectedRevision: number, idempotencyKey: string): Promise<void>;
  deleteNote(
    noteId: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<MobileNoteDetail>;
  getNote(noteId: string): Promise<MobileNoteDetail>;
  listNotes(options?: {
    archived?: boolean;
    deleted?: boolean;
    spaceId?: string;
  }): Promise<MobileNoteSummary[]>;
  listReviewItems(): Promise<MobileReviewItem[]>;
  listSpaces(): Promise<MobileSpace[]>;
  listTags(): Promise<MobileTag[]>;
  moveNote(
    noteId: string,
    spaceId: string | null,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<MobileNoteDetail>;
  restoreDeletedNote(
    noteId: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<MobileNoteDetail>;
  restoreRevision(
    noteId: string,
    revisionId: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<MobileNoteDetail>;
  search(query: string, includeArchived?: boolean): Promise<MobileSearchResult[]>;
  toggleChecklistItem(
    noteId: string,
    itemId: string,
    checked: boolean,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<{ mutationId: string; note: MobileNoteDetail }>;
  undoMutation(
    mutationId: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<MobileNoteDetail>;
  updateNote(noteId: string, input: NoteUpdateInput): Promise<MobileNoteDetail>;
  updateSpace(
    spaceId: string,
    input: { name?: string; parentId?: string | null; sortKey?: string },
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<MobileSpace>;
}

export function createMobileNotesApi(
  baseUrl: string,
  accessToken: string | (() => Promise<string | null>),
  fetcher: FetchLike = fetch
): MobileNotesApi {
  const client = createApiClient({
    baseUrl,
    fetch: fetcher,
    getAccessToken:
      typeof accessToken === "string" ? () => Promise.resolve(accessToken) : accessToken
  });
  const noteId = (value: string): EntityId<"note"> => value as EntityId<"note">;
  const spaceId = (value: string): EntityId<"spc"> => value as EntityId<"spc">;
  const itemId = (value: string): EntityId<"itm"> => value as EntityId<"itm">;
  const mutationId = (value: string): EntityId<"mut"> => value as EntityId<"mut">;
  const revisionId = (value: string): EntityId<"rev"> => value as EntityId<"rev">;

  return {
    archiveNote: async (id, expectedRevision, idempotencyKey, archived = true) =>
      noteWithRevisions(
        (
          await mapResult(
            client.archiveNote(noteId(id), { archived, expectedRevision, idempotencyKey })
          )
        ).note
      ),

    archiveSpace: async (id, expectedRevision, idempotencyKey) =>
      (
        await mapResult(
          client.archiveSpace(spaceId(id), {
            archived: true,
            expectedRevision,
            idempotencyKey
          })
        )
      ).space,

    createTag: async (name, idempotencyKey) =>
      (await mapResult(client.createTag({ idempotencyKey, name }))).tag,

    createNote: async (input) =>
      noteWithRevisions(
        (
          await mapResult(
            client.createNote({
              bodyMarkdown: input.bodyMarkdown,
              idempotencyKey: input.idempotencyKey,
              links: input.links,
              privacy: input.privacy,
              spaceId: input.spaceId === null ? null : spaceId(input.spaceId),
              tagIds: input.tagIds.map((id) => id as EntityId<"tag">),
              title: input.title,
              type: input.type
            })
          )
        ).note
      ),

    createSpace: async (name, parentId, idempotencyKey) =>
      (
        await mapResult(
          client.createSpace({
            idempotencyKey,
            name,
            parentId: parentId === null ? null : spaceId(parentId)
          })
        )
      ).space,

    deleteTag: async (id, expectedRevision, idempotencyKey) => {
      await mapResult(
        client.deleteTag(id as EntityId<"tag">, { expectedRevision, idempotencyKey })
      );
    },

    deleteNote: async (id, expectedRevision, idempotencyKey) =>
      noteWithRevisions(
        (await mapResult(client.softDeleteNote(noteId(id), { expectedRevision, idempotencyKey })))
          .note
      ),

    getNote: async (id) => {
      const parsedId = noteId(id);
      const [detail, history] = await mapResult(
        Promise.all([
          client.getNote(parsedId),
          collectPages((cursor) =>
            client.listNoteRevisions(parsedId, cursor === undefined ? {} : { cursor })
          )
        ])
      );
      return noteWithRevisions(detail.note, history);
    },

    listNotes: async (options = {}) =>
      mapResult(
        collectPages((cursor) =>
          client.listNotes({
            archive: options.archived === true ? "only" : "exclude",
            deleted: options.deleted === true ? "only" : "exclude",
            ...(cursor === undefined ? {} : { cursor }),
            ...(options.spaceId === undefined ? {} : { spaceId: spaceId(options.spaceId) })
          })
        )
      ),

    listReviewItems: async () =>
      mapResult(
        collectPages((cursor) =>
          client.listReviewItems(cursor === undefined ? {} : { cursor, state: "open" })
        )
      ),

    listSpaces: async () =>
      mapResult(
        collectPages((cursor) => client.listSpaces(cursor === undefined ? {} : { cursor }))
      ),

    listTags: async () =>
      mapResult(collectPages((cursor) => client.listTags(cursor === undefined ? {} : { cursor }))),

    moveNote: async (id, destinationSpaceId, expectedRevision, idempotencyKey) =>
      noteWithRevisions(
        (
          await mapResult(
            client.moveNote(noteId(id), {
              expectedRevision,
              idempotencyKey,
              spaceId: destinationSpaceId === null ? null : spaceId(destinationSpaceId)
            })
          )
        ).note
      ),

    restoreDeletedNote: async (id, expectedRevision, idempotencyKey) =>
      noteWithRevisions(
        (
          await mapResult(
            client.restoreDeletedNote(noteId(id), { expectedRevision, idempotencyKey })
          )
        ).note
      ),

    restoreRevision: async (id, revision, expectedRevision, idempotencyKey) =>
      noteWithRevisions(
        (
          await mapResult(
            client.restoreNoteRevision(noteId(id), {
              expectedRevision,
              idempotencyKey,
              revisionId: revisionId(revision)
            })
          )
        ).note
      ),

    search: async (query, includeArchived = false) =>
      mapResult(
        collectPages((cursor) =>
          client.searchNotes({
            archive: includeArchived ? "include" : "exclude",
            ...(cursor === undefined ? {} : { cursor }),
            q: query
          })
        )
      ),

    toggleChecklistItem: async (id, item, checked, expectedRevision, idempotencyKey) => {
      const result = await mapResult(
        client.applyNoteOperations(noteId(id), {
          expectedRevision,
          idempotencyKey,
          operations: [{ checked, itemId: itemId(item), type: "toggle_item_checked" }]
        })
      );
      return { mutationId: result.mutationId, note: noteWithRevisions(result.note) };
    },

    undoMutation: async (id, expectedRevision, idempotencyKey) =>
      noteWithRevisions(
        (await mapResult(client.undoMutation(mutationId(id), { expectedRevision, idempotencyKey })))
          .note
      ),

    updateNote: async (id, input) =>
      noteWithRevisions(
        (
          await mapResult(
            client.updateNote(noteId(id), {
              expectedRevision: input.expectedRevision,
              idempotencyKey: input.idempotencyKey,
              ...(input.bodyMarkdown === undefined ? {} : { bodyMarkdown: input.bodyMarkdown }),
              ...(input.links === undefined ? {} : { links: input.links }),
              ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
              ...(input.spaceId === undefined
                ? {}
                : { spaceId: input.spaceId === null ? null : spaceId(input.spaceId) }),
              ...(input.tagIds === undefined
                ? {}
                : { tagIds: input.tagIds.map((tag) => tag as EntityId<"tag">) }),
              ...(input.title === undefined ? {} : { title: input.title })
            })
          )
        ).note
      ),

    updateSpace: async (id, input, expectedRevision, idempotencyKey) =>
      (
        await mapResult(
          client.updateSpace(spaceId(id), {
            expectedRevision,
            idempotencyKey,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.parentId === undefined
              ? {}
              : { parentId: input.parentId === null ? null : spaceId(input.parentId) }),
            ...(input.sortKey === undefined ? {} : { sortKey: input.sortKey })
          })
        )
      ).space
  };
}

export function noteTypeLabel(type: MobileNoteType): string {
  const labels: Record<MobileNoteType, string> = {
    generic: "Prose",
    list: "List",
    log: "Log",
    principle: "Principle",
    project: "Project"
  };
  return labels[type];
}

export function relativeUpdatedAt(value: string, now = Date.now()): string {
  const delta = Math.max(0, now - Date.parse(value));
  if (delta < 60_000) return "Now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
