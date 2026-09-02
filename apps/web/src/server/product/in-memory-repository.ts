import {
  ApiErrorCode,
  type EntityId,
  type EntityKind,
  type ReviewItemDto,
  type ReviewState,
  type UserOperation
} from "@unfiled/contracts";
import {
  applyNoteOperations,
  createInitialNote,
  restoreNoteRevision,
  undoNoteMutation,
  type EntityIdFactory,
  type Note as DomainNote,
  type NoteMutationResult as DomainNoteMutationResult
} from "@unfiled/domain";

import type {
  CreateNoteInput,
  NoteLinkRecord,
  NoteListFilters,
  NoteMutationResult,
  NoteRecord,
  NoteSearchOptions,
  RevisionRecord,
  SearchResponse,
  SpaceMutationRecord,
  SpaceRecord,
  TagDeleteMutationRecord,
  TagMutationRecord,
  TagRecord,
  UpdateNoteInput
} from "@/lib/product/types";
import { HttpError } from "@/server/api/errors";

import {
  clone,
  developmentSeed,
  expectRevision,
  InMemoryReplayStore,
  InMemoryReviewQueue,
  now,
  revisionFromNote,
  runDomain,
  signature,
  toDomainNote,
  type MutableNote,
  type SeedNoteInput,
  type StoredMutation
} from "./in-memory-support";
import { InMemoryTaxonomy } from "./in-memory-taxonomy";
import type { ExistingNoteWrite, ManualNotesRepository, RepositoryContext } from "./repository";
import { noteMatchesSearchOptions } from "./search-filters";

export class InMemoryManualNotesRepository implements ManualNotesRepository {
  #sequence = 100;
  readonly #replayStore = new InMemoryReplayStore();
  readonly #links = new Map<string, NoteLinkRecord>();
  readonly #mutations = new Map<string, StoredMutation>();
  readonly #notes = new Map<string, MutableNote>();
  readonly #taxonomy = new InMemoryTaxonomy(
    this.#notes,
    (context, key, request, operation) => this.#replayStore.run(context, key, request, operation),
    (kind) => this.#id(kind)
  );
  readonly #reviewQueue = new InMemoryReviewQueue(
    () => this.#id("rvw"),
    () => now(this.#sequence % 50)
  );
  readonly #revisions = new Map<string, RevisionRecord[]>();
  readonly #spaces = this.#taxonomy.spaces;
  readonly #tags = this.#taxonomy.tags;

  public constructor(seed = true) {
    if (seed) this.seed();
  }

  #id<K extends EntityKind>(prefix: K): EntityId<K> {
    this.#sequence += 1;
    return `${prefix}_${String(this.#sequence).padStart(26, "0")}`;
  }

  private seed(): void {
    const { notes, space } = developmentSeed();
    this.#spaces.set(space.id, space);
    for (const note of notes) this.insertSeedNote(note);
  }

  private insertSeedNote(input: SeedNoteInput): void {
    const note: MutableNote = {
      ...input,
      currentRevision: 1,
      isOpen: true,
      pinnedAt: null,
      privacy: "ai_assisted",
      archivedAt: null,
      deletedAt: null,
      createdAt: now(2),
      updatedAt: now(2),
      tagIds: [],
      tags: [],
      links: []
    };
    this.#notes.set(note.id, note);
    this.#revisions.set(note.id, [revisionFromNote(note, "manual", () => this.#id("rev"))]);
  }

  private ownedNote(context: RepositoryContext, noteId: EntityId<"note">): MutableNote {
    const note = this.#notes.get(noteId);
    if (note?.userId !== context.userId) {
      throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That note was not found.");
    }
    return note;
  }

  private resolveLinks(
    context: RepositoryContext,
    fromNoteId: EntityId<"note">,
    values: readonly Readonly<{
      linkType: "reference" | "related";
      toNoteId: EntityId<"note">;
    }>[],
    existing: readonly NoteLinkRecord[] = []
  ): readonly NoteLinkRecord[] {
    const seen = new Set<string>();
    return values.flatMap((value) => {
      if (value.toNoteId === fromNoteId) {
        throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "A note cannot link to itself.");
      }
      const target = this.ownedNote(context, value.toNoteId);
      const key = `${value.toNoteId}:${value.linkType}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const previous = existing.find(
        (link) => link.toNoteId === value.toNoteId && link.linkType === value.linkType
      );
      return [
        {
          id: previous?.id ?? this.#id("lnk"),
          fromNoteId,
          toNoteId: value.toNoteId,
          linkType: value.linkType,
          targetTitle: target.title
        }
      ];
    });
  }

  private replaceStoredLinks(noteId: EntityId<"note">, links: readonly NoteLinkRecord[]): void {
    for (const [linkId, link] of this.#links) {
      if (link.fromNoteId === noteId) this.#links.delete(linkId);
    }
    for (const link of links) this.#links.set(link.id, link);
  }

  private visibleDomainNote(
    context: RepositoryContext,
    note: DomainNote,
    previousLinks: readonly NoteLinkRecord[] = []
  ): MutableNote {
    const space = note.spaceId === null ? null : this.#spaces.get(note.spaceId);
    if (note.spaceId !== null && space?.userId !== context.userId) {
      throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That space was not found.");
    }
    const tags = this.#taxonomy.resolveTags(context, note.tagIds);
    const links = this.resolveLinks(context, note.id, note.links, previousLinks);
    return {
      ...note,
      spacePath: space?.path ?? null,
      tags,
      links
    };
  }

  private mutate(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite,
    operationName: string,
    apply: (
      note: DomainNote,
      timestamp: string,
      idFactory: EntityIdFactory
    ) => DomainNoteMutationResult
  ): NoteMutationResult {
    return this.#replayStore.run(
      context,
      input.idempotencyKey,
      { noteId, operationName, ...input },
      () => {
        const current = this.ownedNote(context, noteId);
        try {
          expectRevision(current, input.expectedRevision);
        } catch (error) {
          if (error instanceof HttpError && error.code === ApiErrorCode.STALE_REVISION) {
            this.#reviewQueue.record(context.userId, noteId, "revision_conflict", {
              type: "conflict",
              reason: "revision"
            });
          }
          throw error;
        }
        const before = clone(current);
        const timestamp = now(this.#sequence % 50);
        const idFactory: EntityIdFactory = (kind) => this.#id(kind);
        let transition: DomainNoteMutationResult;
        try {
          transition = runDomain(() => apply(toDomainNote(current), timestamp, idFactory));
        } catch (error) {
          if (error instanceof HttpError && error.code === ApiErrorCode.STRUCTURE_CONFLICT) {
            this.#reviewQueue.record(context.userId, noteId, "structure_conflict", {
              type: "conflict",
              reason: "structure"
            });
          }
          throw error;
        }
        const updated = this.visibleDomainNote(context, transition.note, current.links);
        const revision = transition.revision;
        this.#notes.set(noteId, updated);
        this.replaceStoredLinks(noteId, updated.links);
        this.#revisions.set(noteId, [...(this.#revisions.get(noteId) ?? []), revision]);
        this.#mutations.set(transition.mutation.id, {
          id: transition.mutation.id,
          before,
          after: clone(updated),
          domainMutation: transition.mutation,
          userId: context.userId
        });
        return {
          note: clone(updated),
          revision,
          mutation: {
            id: transition.mutation.id,
            beforeRevision: transition.mutation.beforeRevision,
            afterRevision: transition.mutation.afterRevision,
            replayed: false,
            undoAvailable: true
          }
        };
      }
    );
  }

  public listNotes(
    context: RepositoryContext,
    filters: NoteListFilters
  ): Promise<readonly NoteRecord[]> {
    const notes = [...this.#notes.values()]
      .filter((note) => note.userId === context.userId)
      .filter((note) =>
        filters.deleted === "only" ? note.deletedAt !== null : note.deletedAt === null
      )
      .filter(
        (note) =>
          filters.archived === "include" ||
          (filters.archived === "only" ? note.archivedAt !== null : note.archivedAt === null)
      )
      .filter((note) => filters.spaceId === undefined || note.spaceId === filters.spaceId)
      .filter((note) => filters.type === undefined || note.type === filters.type)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      )
      .slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 100))
      .map(clone);
    return Promise.resolve(notes);
  }

  public getNote(context: RepositoryContext, noteId: EntityId<"note">): Promise<NoteRecord> {
    return Promise.resolve(clone(this.ownedNote(context, noteId)));
  }

  public createNote(
    context: RepositoryContext,
    input: CreateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.#replayStore.run(context, idempotencyKey, input, () => {
        const id = this.#id("note");
        const createdAt = now(this.#sequence % 50);
        const space = input.spaceId === null ? null : this.#spaces.get(input.spaceId);
        if (
          input.spaceId !== null &&
          (space?.userId !== context.userId || space.archivedAt !== null)
        ) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That space was not found.");
        }
        this.#taxonomy.resolveTags(context, input.tagIds);
        const idFactory: EntityIdFactory = (kind) => this.#id(kind);
        const created = runDomain(() =>
          createInitialNote({
            id,
            userId: context.userId,
            title: input.title,
            type: input.type,
            privacy: input.privacy,
            now: createdAt,
            spaceId: input.spaceId,
            bodyMarkdown: input.bodyMarkdown,
            tagIds: input.tagIds,
            links: input.links,
            idFactory
          })
        );
        const note = this.visibleDomainNote(context, created.note);
        this.#notes.set(id, note);
        this.replaceStoredLinks(id, note.links);
        this.#revisions.set(id, [created.revision]);
        const mutationId = this.#id("mut");
        this.#mutations.set(mutationId, {
          id: mutationId,
          before: null,
          after: clone(note),
          domainMutation: null,
          userId: context.userId
        });
        return {
          note: clone(note),
          revision: created.revision,
          mutation: {
            id: mutationId,
            beforeRevision: 0,
            afterRevision: 1,
            replayed: false,
            undoAvailable: true
          }
        };
      })
    );
  }

  public updateNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: UpdateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(
        context,
        noteId,
        { expectedRevision: input.expectedRevision, idempotencyKey },
        `update:${signature(input)}`,
        (note, timestamp, idFactory) => {
          if (input.tagIds !== undefined) this.#taxonomy.resolveTags(context, input.tagIds);
          if (input.spaceId !== undefined && input.spaceId !== null) {
            const space = this.#spaces.get(input.spaceId);
            if (space?.userId !== context.userId || space.archivedAt !== null) {
              throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That space was not found.");
            }
          }
          const operations: UserOperation[] = [];
          if (input.title !== undefined) {
            operations.push({ type: "set_title", title: input.title.trim() });
          }
          if (input.bodyMarkdown !== undefined) {
            operations.push({ type: "replace_body_markdown", bodyMarkdown: input.bodyMarkdown });
          }
          if (input.privacy !== undefined) {
            operations.push({ type: "set_privacy", privacy: input.privacy });
          }
          if (input.spaceId !== undefined) {
            operations.push({ type: "move_to_space", spaceId: input.spaceId });
          }
          if (input.tagIds !== undefined) {
            operations.push({ type: "set_tags", tagIds: [...input.tagIds] });
          }
          if (input.links !== undefined) {
            operations.push({
              type: "set_note_links",
              links: input.links.map((link) => ({ ...link }))
            });
          }
          return applyNoteOperations(note, {
            expectedRevision: input.expectedRevision,
            operations,
            now: timestamp,
            idFactory
          });
        }
      )
    );
  }

  public applyOperations(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    operations: readonly UserOperation[],
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(
        context,
        noteId,
        input,
        `operations:${signature(operations)}`,
        (note, timestamp, idFactory) =>
          applyNoteOperations(note, {
            expectedRevision: input.expectedRevision,
            operations,
            now: timestamp,
            idFactory,
            source: "interactive"
          })
      )
    );
  }

  public moveNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { spaceId: EntityId<"spc"> | null }
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(context, noteId, input, "move", (note, timestamp, idFactory) => {
        const space = input.spaceId === null ? null : this.#spaces.get(input.spaceId);
        if (
          input.spaceId !== null &&
          (space?.userId !== context.userId || space.archivedAt !== null)
        ) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That space was not found.");
        }
        return applyNoteOperations(note, {
          expectedRevision: input.expectedRevision,
          operations: [{ type: "move_to_space", spaceId: input.spaceId }],
          now: timestamp,
          idFactory
        });
      })
    );
  }

  public archiveNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { archived: boolean }
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(context, noteId, input, "archive", (note, timestamp, idFactory) =>
        applyNoteOperations(note, {
          expectedRevision: input.expectedRevision,
          operations: [{ type: "set_archived", archivedAt: input.archived ? timestamp : null }],
          now: timestamp,
          idFactory
        })
      )
    );
  }

  public deleteNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(context, noteId, input, "delete", (note, timestamp, idFactory) =>
        applyNoteOperations(note, {
          expectedRevision: input.expectedRevision,
          operations: [{ type: "set_deleted", deletedAt: timestamp }],
          now: timestamp,
          idFactory
        })
      )
    );
  }

  public restoreDeletedNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(context, noteId, input, "restore-deleted", (note, timestamp, idFactory) =>
        applyNoteOperations(note, {
          expectedRevision: input.expectedRevision,
          operations: [{ type: "set_deleted", deletedAt: null }],
          now: timestamp,
          idFactory
        })
      )
    );
  }

  public listRevisions(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    page?: Readonly<{ limit: number; offset: number }>
  ): Promise<readonly RevisionRecord[]> {
    this.ownedNote(context, noteId);
    const revisions = [...(this.#revisions.get(noteId) ?? [])].reverse();
    return Promise.resolve(
      clone(page === undefined ? revisions : revisions.slice(page.offset, page.offset + page.limit))
    );
  }

  public restoreRevision(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    revisionId: EntityId<"rev">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    const revision = (this.#revisions.get(noteId) ?? []).find(
      (candidate) => candidate.id === revisionId
    );
    if (revision === undefined)
      return Promise.reject(
        new HttpError(404, ApiErrorCode.NOT_FOUND, "That revision was not found.")
      );
    return Promise.resolve(
      this.mutate(context, noteId, input, `restore:${revisionId}`, (note, timestamp, idFactory) =>
        restoreNoteRevision(note, revision, {
          expectedRevision: input.expectedRevision,
          now: timestamp,
          idFactory
        })
      )
    );
  }

  public undoMutation(
    context: RepositoryContext,
    mutationId: EntityId<"mut">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    const mutation = this.#mutations.get(mutationId);
    if (mutation?.userId !== context.userId)
      return Promise.reject(
        new HttpError(404, ApiErrorCode.NOT_FOUND, "That change was not found.")
      );
    return Promise.resolve(
      this.mutate(
        context,
        mutation.after.id,
        input,
        `undo:${mutationId}`,
        (note, timestamp, idFactory) => {
          if (mutation.domainMutation === null) {
            return applyNoteOperations(note, {
              expectedRevision: input.expectedRevision,
              operations: [{ type: "set_deleted", deletedAt: timestamp }],
              now: timestamp,
              idFactory,
              source: "undo",
              actor: "user:undo-create"
            });
          }
          return undoNoteMutation(note, mutation.domainMutation, {
            expectedRevision: input.expectedRevision,
            now: timestamp,
            idFactory
          });
        }
      )
    );
  }

  public listSpaces(
    context: RepositoryContext,
    includeArchived: boolean,
    page?: Readonly<{ limit: number; offset: number }>
  ): Promise<readonly SpaceRecord[]> {
    return this.#taxonomy.listSpaces(context, includeArchived, page);
  }

  public listReviewItems(
    context: RepositoryContext,
    state: ReviewState,
    page?: Readonly<{ limit: number; offset: number }>
  ): Promise<readonly ReviewItemDto[]> {
    return Promise.resolve(this.#reviewQueue.list(context.userId, state, page));
  }

  public createSpace(
    context: RepositoryContext,
    input: { name: string; parentId: EntityId<"spc"> | null; sortKey?: string },
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    return this.#taxonomy.createSpace(context, input, idempotencyKey);
  }

  public updateSpace(
    context: RepositoryContext,
    spaceId: EntityId<"spc">,
    input: { name?: string; parentId?: EntityId<"spc"> | null; sortKey?: string },
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    return this.#taxonomy.updateSpace(context, spaceId, input, expectedRevision, idempotencyKey);
  }

  public archiveSpace(
    context: RepositoryContext,
    spaceId: EntityId<"spc">,
    archived: boolean,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    return this.#taxonomy.archiveSpace(
      context,
      spaceId,
      archived,
      expectedRevision,
      idempotencyKey
    );
  }

  public listTags(
    context: RepositoryContext,
    page?: Readonly<{ limit: number; offset: number }>
  ): Promise<readonly TagRecord[]> {
    return this.#taxonomy.listTags(context, page);
  }

  public createTag(
    context: RepositoryContext,
    name: string,
    idempotencyKey: string
  ): Promise<TagMutationRecord> {
    return this.#taxonomy.createTag(context, name, idempotencyKey);
  }

  public updateTag(
    context: RepositoryContext,
    tagId: EntityId<"tag">,
    name: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagMutationRecord> {
    return this.#taxonomy.updateTag(context, tagId, name, expectedRevision, idempotencyKey);
  }

  public deleteTag(
    context: RepositoryContext,
    tagId: EntityId<"tag">,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagDeleteMutationRecord> {
    return this.#taxonomy.deleteTag(context, tagId, expectedRevision, idempotencyKey);
  }

  public linkTag(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(context, noteId, input, `tag:${tagId}`, (note, timestamp, idFactory) => {
        const tag = this.#tags.get(tagId);
        if (tag?.userId !== context.userId) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That tag was not found.");
        }
        return applyNoteOperations(note, {
          expectedRevision: input.expectedRevision,
          operations: [
            {
              type: "set_tags",
              tagIds: [...note.tagIds.filter((id) => id !== tagId), tag.id]
            }
          ],
          now: timestamp,
          idFactory
        });
      })
    );
  }

  public unlinkTag(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(context, noteId, input, `untag:${tagId}`, (note, timestamp, idFactory) =>
        applyNoteOperations(note, {
          expectedRevision: input.expectedRevision,
          operations: [{ type: "set_tags", tagIds: note.tagIds.filter((id) => id !== tagId) }],
          now: timestamp,
          idFactory
        })
      )
    );
  }

  public listLinks(
    context: RepositoryContext,
    noteId: EntityId<"note">
  ): Promise<readonly NoteLinkRecord[]> {
    this.ownedNote(context, noteId);
    return Promise.resolve(
      [...this.#links.values()].filter((link) => link.fromNoteId === noteId).map(clone)
    );
  }

  public createLink(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { linkType: "reference" | "related"; toNoteId: EntityId<"note"> }
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(
        context,
        noteId,
        input,
        `link:${input.toNoteId}`,
        (note, timestamp, idFactory) => {
          this.ownedNote(context, input.toNoteId);
          return applyNoteOperations(note, {
            expectedRevision: input.expectedRevision,
            operations: [
              {
                type: "set_note_links",
                links: [
                  ...note.links.map((link) => ({ ...link })),
                  { linkType: input.linkType, toNoteId: input.toNoteId }
                ]
              }
            ],
            now: timestamp,
            idFactory
          });
        }
      )
    );
  }

  public deleteLink(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    linkId: EntityId<"lnk">,
    input: ExistingNoteWrite & { linkType: "reference" | "related"; toNoteId: EntityId<"note"> }
  ): Promise<NoteMutationResult> {
    return Promise.resolve(
      this.mutate(context, noteId, input, `unlink:${linkId}`, (note, timestamp, idFactory) => {
        const link = this.#links.get(linkId);
        if (
          link?.fromNoteId !== noteId ||
          link.toNoteId !== input.toNoteId ||
          link.linkType !== input.linkType
        ) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That link was not found.");
        }
        return applyNoteOperations(note, {
          expectedRevision: input.expectedRevision,
          operations: [
            {
              type: "set_note_links",
              links: note.links.filter(
                (candidate) =>
                  candidate.toNoteId !== link.toNoteId || candidate.linkType !== link.linkType
              )
            }
          ],
          now: timestamp,
          idFactory
        });
      })
    );
  }

  public async search(
    context: RepositoryContext,
    query: string,
    options: NoteSearchOptions
  ): Promise<SearchResponse> {
    const normalized = query.trim().toLowerCase();
    const notes = await this.listNotes(context, {
      archived: options.archived,
      limit: Number.MAX_SAFE_INTEGER,
      ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
      ...(options.type === undefined ? {} : { type: options.type })
    });
    const matches = notes.flatMap((note) => {
      if (!noteMatchesSearchOptions(note, options)) return [];
      const haystack = `${note.title}\n${note.bodyMarkdown}`.toLowerCase();
      if (!haystack.includes(normalized)) return [];
      const index = Math.max(0, haystack.indexOf(normalized));
      const start = Math.max(0, index - 40);
      const normalizedTitle = note.title.trim().toLowerCase();
      const score =
        normalizedTitle === normalized ? 1 : normalizedTitle.includes(normalized) ? 0.8 : 0.6;
      return [{ note, score, snippet: note.bodyMarkdown.slice(start, start + 180) }];
    });
    return {
      query,
      results: matches.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 50))
    };
  }
}
