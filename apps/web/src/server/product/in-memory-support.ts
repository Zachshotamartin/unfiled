import { createHash } from "node:crypto";

import type {
  ApiErrorCodeValue,
  EntityId,
  NoteStructuredData,
  NoteType,
  ReviewItemDto,
  ReviewState,
  ReviewType
} from "@unfiled/contracts";
import { ApiErrorCode } from "@unfiled/contracts";
import {
  DomainError,
  type Note as DomainNote,
  type NoteMutation as DomainNoteMutation
} from "@unfiled/domain";

import type {
  ChecklistItem,
  NoteMutationResult,
  NoteRecord,
  RevisionRecord,
  SpaceRecord,
  TagRecord
} from "@/lib/product/types";
import { HttpError } from "@/server/api/errors";

import type { RepositoryContext } from "./repository";

export type MutableNote = NoteRecord & { userId: string };
export type StoredMutation = Readonly<{
  after: NoteRecord;
  before: NoteRecord | null;
  domainMutation: DomainNoteMutation | null;
  id: EntityId<"mut">;
  userId: string;
}>;
export type SeedNoteInput = Readonly<{
  bodyMarkdown: string;
  id: EntityId<"note">;
  spaceId: EntityId<"spc"> | null;
  spacePath: string | null;
  structuredData: NoteStructuredData;
  title: string;
  type: NoteType;
  userId: string;
}>;

export class InMemoryReplayStore {
  readonly #values = new Map<string, { request: string; response: unknown }>();

  public run<T>(context: RepositoryContext, key: string, request: unknown, operation: () => T): T {
    const mapKey = `${context.userId}:${key}`;
    const requestSignature = signature(request);
    const existing = this.#values.get(mapKey);
    if (existing !== undefined) {
      if (existing.request !== requestSignature) {
        throw new HttpError(
          409,
          ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
          "That action key was already used for something different."
        );
      }
      const response = clone(existing.response as T);
      if (response !== null && typeof response === "object" && "mutation" in response) {
        const mutationResponse = response as unknown as NoteMutationResult;
        return {
          ...mutationResponse,
          mutation: { ...mutationResponse.mutation, replayed: true }
        } as unknown as T;
      }
      if (response !== null && typeof response === "object" && "replayed" in response) {
        return { ...response, replayed: true };
      }
      return response;
    }
    const response = operation();
    this.#values.set(mapKey, { request: requestSignature, response: clone(response) });
    return response;
  }
}

export function expectRevision(note: NoteRecord, expectedRevision: number): void {
  if (note.currentRevision !== expectedRevision) {
    throw new HttpError(
      409,
      ApiErrorCode.STALE_REVISION,
      "This note changed somewhere else. Review the latest version.",
      { details: { currentRevision: note.currentRevision } }
    );
  }
}

export function toDomainNote(note: MutableNote): DomainNote {
  return {
    id: note.id,
    userId: note.userId,
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: clone(note.structuredData),
    currentRevision: note.currentRevision,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: [...note.tagIds],
    links: note.links.map(({ linkType, toNoteId }) => ({ linkType, toNoteId })),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

export function revisionFromNote(
  note: NoteRecord,
  source: RevisionRecord["source"],
  newId: () => EntityId<"rev">
): RevisionRecord {
  return {
    id: newId(),
    noteId: note.id,
    revision: note.currentRevision,
    source,
    actor: "user",
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: clone(note.structuredData),
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: [...note.tagIds],
    links: note.links.map(({ linkType, toNoteId }) => ({ linkType, toNoteId })),
    contentHash: hash(note),
    createdAt: note.updatedAt
  };
}

export function runDomain<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const conflictCodes: readonly ApiErrorCodeValue[] = [
      ApiErrorCode.STALE_REVISION,
      ApiErrorCode.STRUCTURE_CONFLICT,
      ApiErrorCode.CONFLICT_REQUIRES_REVIEW
    ];
    const status =
      error.code === ApiErrorCode.NOT_FOUND ? 404 : conflictCodes.includes(error.code) ? 409 : 400;
    throw new HttpError(status, error.code, error.message.replace(/^[A-Z_]+:\s*/u, ""));
  }
}

export class InMemoryReviewQueue {
  readonly #items = new Map<string, ReviewItemDto & { userId: string }>();
  readonly #newId: () => EntityId<"rvw">;
  readonly #now: () => string;

  public constructor(newId: () => EntityId<"rvw">, timestamp: () => string) {
    this.#newId = newId;
    this.#now = timestamp;
  }

  public record(
    userId: string,
    noteId: EntityId<"note"> | null,
    type: Extract<ReviewType, "revision_conflict" | "structure_conflict">,
    choices: readonly unknown[]
  ): void {
    const existing = [...this.#items.values()].find(
      (item) =>
        item.userId === userId &&
        item.noteId === noteId &&
        item.type === type &&
        item.state === "open"
    );
    if (existing !== undefined) return;
    const id = this.#newId();
    this.#items.set(id, {
      id,
      userId,
      captureId: null,
      noteId,
      type,
      choices: clone(choices) as ReviewItemDto["choices"],
      state: "open",
      resolution: null,
      createdAt: this.#now(),
      resolvedAt: null
    });
  }

  public list(
    userId: string,
    state: ReviewState,
    page?: Readonly<{ limit: number; offset: number }>
  ): readonly ReviewItemDto[] {
    const items = [...this.#items.values()]
      .filter((item) => item.userId === userId && item.state === state)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
      );
    const window = page === undefined ? items : items.slice(page.offset, page.offset + page.limit);
    return window.map((item) =>
      clone({
        id: item.id,
        captureId: item.captureId,
        noteId: item.noteId,
        type: item.type,
        choices: item.choices,
        state: item.state,
        resolution: item.resolution,
        createdAt: item.createdAt,
        resolvedAt: item.resolvedAt
      })
    );
  }
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function signature(value: unknown): string {
  function canonical(candidate: unknown): unknown {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate === null || typeof candidate !== "object") return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)])
    );
  }
  return JSON.stringify(canonical(value));
}

export function hash(note: NoteRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        bodyMarkdown: note.bodyMarkdown,
        structuredData: note.structuredData,
        title: note.title
      })
    )
    .digest("hex");
}

export function now(counter: number): string {
  return new Date(Date.UTC(2026, 7, 30, 18, counter, 0)).toISOString();
}

export function seedStructured(
  type: NoteType,
  items: readonly ChecklistItem[] = []
): NoteStructuredData {
  if (type === "list") {
    return {
      schemaVersion: 1,
      items: items.map((item, ordinal) => ({ ...item, ordinal, section: null }))
    };
  }
  if (type === "log") return { schemaVersion: 1, entries: [] };
  if (type === "project") {
    return {
      schemaVersion: 1,
      checklistItems: items.map((item, ordinal) => ({ ...item, ordinal, lineIndex: ordinal }))
    };
  }
  return { schemaVersion: 1 };
}

export function projectBody(items: readonly ChecklistItem[]): string {
  return items.map((item) => `- [${item.checked ? "x" : " "}] ${item.text}`).join("\n");
}

export function developmentSeed(): Readonly<{
  notes: readonly SeedNoteInput[];
  space: SpaceRecord & { userId: string };
}> {
  const userId = "00000000-0000-4000-8000-000000000001";
  const space: SpaceRecord & { userId: string } = {
    id: "spc_00000000000000000000000001",
    userId,
    name: "Life",
    path: "Life",
    parentId: null,
    slug: "life",
    sortKey: "a0",
    archivedAt: null,
    createdAt: now(1),
    currentRevision: 1,
    updatedAt: now(1)
  };
  const items: ChecklistItem[] = [
    { id: "itm_00000000000000000000000001", text: "milk", checked: false },
    { id: "itm_00000000000000000000000002", text: "spinach", checked: false }
  ];
  return {
    space,
    notes: [
      {
        id: "note_00000000000000000000000001",
        userId,
        type: "list",
        title: "Shopping",
        bodyMarkdown: projectBody(items),
        structuredData: seedStructured("list", items),
        spaceId: space.id,
        spacePath: "Life"
      },
      {
        id: "note_00000000000000000000000003",
        userId,
        type: "principle",
        title: "Mindset",
        bodyMarkdown: "Commit publicly, then learn what the commitment requires.",
        structuredData: { schemaVersion: 1 },
        spaceId: space.id,
        spacePath: "Life"
      }
    ]
  };
}

export function visibleSpace(space: SpaceRecord & { userId: string }): SpaceRecord {
  return {
    id: space.id,
    parentId: space.parentId,
    name: space.name,
    path: space.path,
    slug: space.slug,
    sortKey: space.sortKey,
    archivedAt: space.archivedAt,
    createdAt: space.createdAt,
    currentRevision: space.currentRevision,
    updatedAt: space.updatedAt
  };
}

export function visibleTag(tag: TagRecord & { userId: string }): TagRecord {
  return {
    id: tag.id,
    name: tag.name,
    currentRevision: tag.currentRevision,
    createdAt: tag.createdAt
  };
}
