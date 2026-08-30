import { ApiErrorCode, type EntityId } from "@unfiled/contracts";

import type {
  SpaceMutationRecord,
  SpaceRecord,
  TagDeleteMutationRecord,
  TagMutationRecord,
  TagRecord
} from "@/lib/product/types";
import { HttpError } from "@/server/api/errors";

import { clone, now, visibleSpace, visibleTag, type MutableNote } from "./in-memory-support";
import type { RepositoryContext } from "./repository";

type Replay = <T>(
  context: RepositoryContext,
  key: string,
  request: unknown,
  operation: () => T
) => T;

export class InMemoryTaxonomy {
  public readonly spaces = new Map<string, SpaceRecord & { userId: string }>();
  public readonly tags = new Map<string, TagRecord & { userId: string }>();
  readonly #newId: <K extends "spc" | "tag">(kind: K) => EntityId<K>;
  readonly #notes: Map<string, MutableNote>;
  readonly #replay: Replay;

  public constructor(
    notes: Map<string, MutableNote>,
    replay: Replay,
    newId: <K extends "spc" | "tag">(kind: K) => EntityId<K>
  ) {
    this.#notes = notes;
    this.#replay = replay;
    this.#newId = newId;
  }

  public resolveTags(
    context: RepositoryContext,
    tagIds: readonly EntityId<"tag">[]
  ): readonly TagRecord[] {
    return [...new Set(tagIds)].map((tagId) => {
      const tag = this.tags.get(tagId);
      if (tag?.userId !== context.userId) {
        throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That tag was not found.");
      }
      return visibleTag(tag);
    });
  }

  public listSpaces(
    context: RepositoryContext,
    includeArchived: boolean,
    page?: Readonly<{ limit: number; offset: number }>
  ): Promise<readonly SpaceRecord[]> {
    const spaces = [...this.spaces.values()]
      .filter(
        (space) => space.userId === context.userId && (includeArchived || space.archivedAt === null)
      )
      .sort(
        (left, right) =>
          left.sortKey.localeCompare(right.sortKey) || left.name.localeCompare(right.name)
      );
    const window =
      page === undefined ? spaces : spaces.slice(page.offset, page.offset + page.limit);
    return Promise.resolve(window.map((space) => clone(visibleSpace(space))));
  }

  public createSpace(
    context: RepositoryContext,
    input: { name: string; parentId: EntityId<"spc"> | null; sortKey?: string },
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    return Promise.resolve(
      this.#replay(context, idempotencyKey, input, () => {
        if (input.parentId !== null) {
          const parent = this.spaces.get(input.parentId);
          if (parent?.userId !== context.userId || parent.parentId !== null) {
            throw new HttpError(
              400,
              ApiErrorCode.VALIDATION_FAILED,
              "Spaces can be nested one level deep."
            );
          }
        }
        const timestamp = now(10);
        const id = this.#newId("spc");
        const parent = input.parentId === null ? null : this.spaces.get(input.parentId);
        const space: SpaceRecord & { userId: string } = {
          id,
          userId: context.userId,
          name: input.name.trim(),
          parentId: input.parentId,
          path:
            parent === null || parent === undefined
              ? input.name.trim()
              : `${parent.name} / ${input.name.trim()}`,
          slug: input.name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-|-$/gu, ""),
          sortKey: input.sortKey ?? "z0",
          archivedAt: null,
          createdAt: timestamp,
          currentRevision: 1,
          updatedAt: timestamp
        };
        this.spaces.set(id, space);
        return { space: visibleSpace(space), replayed: false };
      })
    );
  }

  public updateSpace(
    context: RepositoryContext,
    spaceId: EntityId<"spc">,
    input: { name?: string; parentId?: EntityId<"spc"> | null; sortKey?: string },
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    return Promise.resolve(
      this.#replay(context, idempotencyKey, { spaceId, input, expectedRevision }, () => {
        const current = this.spaces.get(spaceId);
        if (current?.userId !== context.userId) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That space was not found.");
        }
        if (current.currentRevision !== expectedRevision) {
          throw new HttpError(
            409,
            ApiErrorCode.STALE_REVISION,
            "This space changed somewhere else. Review the latest version."
          );
        }
        const updated = {
          ...current,
          ...input,
          name: input.name?.trim() ?? current.name,
          currentRevision: current.currentRevision + 1,
          updatedAt: now(11)
        };
        this.spaces.set(spaceId, updated);
        return { space: visibleSpace(updated), replayed: false };
      })
    );
  }

  public archiveSpace(
    context: RepositoryContext,
    spaceId: EntityId<"spc">,
    archived: boolean,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    return Promise.resolve(
      this.#replay(context, idempotencyKey, { spaceId, archived, expectedRevision }, () => {
        const current = this.spaces.get(spaceId);
        if (current?.userId !== context.userId) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That space was not found.");
        }
        if (current.currentRevision !== expectedRevision) {
          throw new HttpError(
            409,
            ApiErrorCode.STALE_REVISION,
            "This space changed somewhere else. Review the latest version."
          );
        }
        const updated = {
          ...current,
          archivedAt: archived ? now(12) : null,
          currentRevision: current.currentRevision + 1,
          updatedAt: now(12)
        };
        this.spaces.set(spaceId, updated);
        return { space: visibleSpace(updated), replayed: false };
      })
    );
  }

  public listTags(
    context: RepositoryContext,
    page?: Readonly<{ limit: number; offset: number }>
  ): Promise<readonly TagRecord[]> {
    const tags = [...this.tags.values()]
      .filter((tag) => tag.userId === context.userId)
      .sort((left, right) => left.name.localeCompare(right.name));
    const window = page === undefined ? tags : tags.slice(page.offset, page.offset + page.limit);
    return Promise.resolve(window.map((tag) => clone(visibleTag(tag))));
  }

  public createTag(
    context: RepositoryContext,
    name: string,
    idempotencyKey: string
  ): Promise<TagMutationRecord> {
    return Promise.resolve(
      this.#replay(context, idempotencyKey, { name }, () => {
        const normalized = name.trim().toLowerCase();
        const existing = [...this.tags.values()].find(
          (tag) => tag.userId === context.userId && tag.name === normalized
        );
        if (existing !== undefined) {
          throw new HttpError(
            409,
            ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
            "That tag already exists."
          );
        }
        const tag = {
          id: this.#newId("tag"),
          name: normalized,
          currentRevision: 1,
          createdAt: now(13),
          userId: context.userId
        };
        this.tags.set(tag.id, tag);
        return { tag: visibleTag(tag), replayed: false };
      })
    );
  }

  public updateTag(
    context: RepositoryContext,
    tagId: EntityId<"tag">,
    name: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagMutationRecord> {
    return Promise.resolve(
      this.#replay(context, idempotencyKey, { tagId, name, expectedRevision }, () => {
        const current = this.tags.get(tagId);
        if (current?.userId !== context.userId) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That tag was not found.");
        }
        if (current.currentRevision !== expectedRevision) {
          throw new HttpError(
            409,
            ApiErrorCode.STALE_REVISION,
            "This tag changed somewhere else. Review the latest version."
          );
        }
        const normalized = name.trim().toLowerCase();
        if (
          [...this.tags.values()].some(
            (tag) => tag.userId === context.userId && tag.id !== tagId && tag.name === normalized
          )
        ) {
          throw new HttpError(
            409,
            ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
            "That tag already exists."
          );
        }
        const updated = {
          ...current,
          name: normalized,
          currentRevision: current.currentRevision + 1
        };
        this.tags.set(tagId, updated);
        return { tag: visibleTag(updated), replayed: false };
      })
    );
  }

  public deleteTag(
    context: RepositoryContext,
    tagId: EntityId<"tag">,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagDeleteMutationRecord> {
    return Promise.resolve(
      this.#replay(context, idempotencyKey, { tagId, expectedRevision }, () => {
        const tag = this.tags.get(tagId);
        if (tag?.userId !== context.userId) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That tag was not found.");
        }
        if (tag.currentRevision !== expectedRevision) {
          throw new HttpError(
            409,
            ApiErrorCode.STALE_REVISION,
            "This tag changed somewhere else. Review the latest version."
          );
        }
        this.tags.delete(tagId);
        for (const [noteId, note] of this.#notes) {
          if (note.userId === context.userId && note.tagIds.includes(tagId)) {
            this.#notes.set(noteId, {
              ...note,
              tagIds: note.tagIds.filter((id) => id !== tagId),
              tags: note.tags.filter((candidate) => candidate.id !== tagId)
            });
          }
        }
        return { deletedId: tagId, replayed: false };
      })
    );
  }
}
