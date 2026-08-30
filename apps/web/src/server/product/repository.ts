import type {
  EntityId,
  NoteType,
  PrivacyMode,
  ReviewItemDto,
  ReviewState,
  UserOperation
} from "@unfiled/contracts";

import type {
  CreateNoteInput,
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
  UpdateNoteInput
} from "@/lib/product/types";

export type RepositoryContext = Readonly<{
  accessToken: string;
  userId: string;
}>;

export type ExistingNoteWrite = Readonly<{
  expectedRevision: number;
  idempotencyKey: string;
}>;

export type RepositoryPage = Readonly<{
  limit: number;
  offset: number;
}>;

export interface ManualNotesRepository {
  archiveNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { archived: boolean }
  ): Promise<NoteMutationResult>;
  archiveSpace(
    context: RepositoryContext,
    spaceId: EntityId<"spc">,
    archived: boolean,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord>;
  createLink(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & {
      linkType: "reference" | "related";
      toNoteId: EntityId<"note">;
    }
  ): Promise<NoteMutationResult>;
  createNote(
    context: RepositoryContext,
    input: CreateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult>;
  createSpace(
    context: RepositoryContext,
    input: Readonly<{
      name: string;
      parentId: EntityId<"spc"> | null;
      sortKey?: string;
    }>,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord>;
  createTag(
    context: RepositoryContext,
    name: string,
    idempotencyKey: string
  ): Promise<TagMutationRecord>;
  deleteLink(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    linkId: EntityId<"lnk">,
    input: ExistingNoteWrite & {
      linkType: "reference" | "related";
      toNoteId: EntityId<"note">;
    }
  ): Promise<NoteMutationResult>;
  deleteNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult>;
  deleteTag(
    context: RepositoryContext,
    tagId: EntityId<"tag">,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagDeleteMutationRecord>;
  getNote(context: RepositoryContext, noteId: EntityId<"note">): Promise<NoteRecord>;
  linkTag(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult>;
  listLinks(
    context: RepositoryContext,
    noteId: EntityId<"note">
  ): Promise<readonly NoteLinkRecord[]>;
  listNotes(context: RepositoryContext, filters: NoteListFilters): Promise<readonly NoteRecord[]>;
  listRevisions(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    page?: RepositoryPage
  ): Promise<readonly RevisionRecord[]>;
  listReviewItems(
    context: RepositoryContext,
    state: ReviewState,
    page?: RepositoryPage
  ): Promise<readonly ReviewItemDto[]>;
  listSpaces(
    context: RepositoryContext,
    includeArchived: boolean,
    page?: RepositoryPage
  ): Promise<readonly SpaceRecord[]>;
  listTags(context: RepositoryContext, page?: RepositoryPage): Promise<readonly TagRecord[]>;
  moveNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { spaceId: EntityId<"spc"> | null }
  ): Promise<NoteMutationResult>;
  restoreDeletedNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult>;
  restoreRevision(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    revisionId: EntityId<"rev">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult>;
  search(
    context: RepositoryContext,
    query: string,
    archived: "exclude" | "include" | "only",
    page?: RepositoryPage
  ): Promise<SearchResponse>;
  unlinkTag(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult>;
  undoMutation(
    context: RepositoryContext,
    mutationId: EntityId<"mut">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult>;
  updateNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: UpdateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult>;
  updateSpace(
    context: RepositoryContext,
    spaceId: EntityId<"spc">,
    input: Readonly<{
      name?: string;
      parentId?: EntityId<"spc"> | null;
      sortKey?: string;
    }>,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord>;
  updateTag(
    context: RepositoryContext,
    tagId: EntityId<"tag">,
    name: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagMutationRecord>;
  applyOperations(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    operations: readonly UserOperation[],
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult>;
}

export type NoteCreateFields = Readonly<{
  bodyMarkdown: string;
  privacy: PrivacyMode;
  spaceId: EntityId<"spc"> | null;
  title: string;
  type: NoteType;
}>;
