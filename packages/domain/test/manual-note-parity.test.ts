import {
  ApiErrorCode,
  NoteCreateRequestSchema,
  noteAttachmentReferences,
  type EntityId,
  type EntityKind,
  type InteractiveOperationsRequest,
  type MutationResult,
  type MutationUndoRequest,
  type NoteCreateRequest,
  type NoteDto,
  type NoteUpdateRequest
} from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  DomainError,
  applyNoteOperations,
  createInitialNote,
  noteSnapshot,
  patchNote,
  runManualNoteRepositoryParity,
  undoNoteMutation,
  type ManualNoteParityDriver,
  type Note,
  type NoteMutation
} from "../src/index.js";

type StoredReplay = Readonly<{ request: string; response: MutationResult }>;

class AggregateParityDriver implements ManualNoteParityDriver {
  public readonly spaceId = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
  readonly #idempotency = new Map<string, StoredReplay>();
  readonly #mutations = new Map<string, NoteMutation>();
  readonly #notes = new Map<string, Note>();
  #sequence = 1;

  readonly #idFactory = <K extends EntityKind>(kind: K): EntityId<K> => {
    const id: EntityId<K> = `${kind}_${String(this.#sequence).padStart(26, "0")}`;
    this.#sequence += 1;
    return id;
  };

  #now(): string {
    const value = new Date(Date.UTC(2026, 7, 30, 18, this.#sequence, 0)).toISOString();
    return value;
  }

  #result(transition: ReturnType<typeof applyNoteOperations>, replayed = false): MutationResult {
    this.#notes.set(transition.note.id, transition.note);
    this.#mutations.set(transition.mutation.id, transition.mutation);
    return {
      note: {
        ...transition.note,
        attachments: [...noteAttachmentReferences(transition.note.bodyMarkdown)]
      },
      revision: transition.revision,
      mutationId: transition.mutation.id,
      replayed,
      undo: { eligible: true, expiresAt: null }
    };
  }

  #replay(key: string, request: unknown, transition: () => MutationResult): MutationResult {
    const serialized = JSON.stringify(request);
    const stored = this.#idempotency.get(key);
    if (stored !== undefined) {
      if (stored.request !== serialized) {
        throw new DomainError(
          ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
          "The parity key was reused with a different request"
        );
      }
      return { ...stored.response, replayed: true };
    }
    const result = transition();
    this.#idempotency.set(key, { request: serialized, response: result });
    return result;
  }

  public create(input: NoteCreateRequest): Promise<MutationResult> {
    return Promise.resolve(
      this.#replay(input.idempotencyKey, { operation: "create", input }, () => {
        const parsed = NoteCreateRequestSchema.parse(input);
        const created = createInitialNote({
          id: this.#idFactory("note"),
          userId: "00000000-0000-4000-8000-000000000001",
          title: parsed.title,
          type: parsed.type,
          privacy: parsed.privacy,
          now: this.#now(),
          spaceId: parsed.spaceId ?? null,
          bodyMarkdown: parsed.bodyMarkdown,
          tagIds: parsed.tagIds,
          links: parsed.links,
          idFactory: this.#idFactory
        });
        this.#notes.set(created.note.id, created.note);
        const activeSnapshot = noteSnapshot(created.note);
        const deletedSnapshot = { ...activeSnapshot, deletedAt: created.note.createdAt };
        const mutationId = this.#idFactory("mut");
        const mutation: NoteMutation = {
          id: mutationId,
          noteId: created.note.id,
          beforeRevision: 0,
          afterRevision: 1,
          operations: [
            {
              type: "restore_snapshot",
              spaceId: activeSnapshot.spaceId,
              noteType: activeSnapshot.type,
              title: activeSnapshot.title,
              bodyMarkdown: activeSnapshot.bodyMarkdown,
              structuredData: activeSnapshot.structuredData,
              privacy: activeSnapshot.privacy,
              isOpen: activeSnapshot.isOpen,
              pinnedAt: activeSnapshot.pinnedAt,
              archivedAt: activeSnapshot.archivedAt,
              deletedAt: activeSnapshot.deletedAt,
              tagIds: activeSnapshot.tagIds,
              links: activeSnapshot.links
            }
          ],
          inverse: [
            {
              type: "restore_snapshot",
              spaceId: deletedSnapshot.spaceId,
              noteType: deletedSnapshot.type,
              title: deletedSnapshot.title,
              bodyMarkdown: deletedSnapshot.bodyMarkdown,
              structuredData: deletedSnapshot.structuredData,
              privacy: deletedSnapshot.privacy,
              isOpen: deletedSnapshot.isOpen,
              pinnedAt: deletedSnapshot.pinnedAt,
              archivedAt: deletedSnapshot.archivedAt,
              deletedAt: deletedSnapshot.deletedAt,
              tagIds: deletedSnapshot.tagIds,
              links: deletedSnapshot.links
            }
          ],
          beforeSnapshot: deletedSnapshot,
          afterSnapshot: activeSnapshot,
          createdAt: created.note.createdAt,
          undoneAt: null
        };
        this.#mutations.set(mutationId, mutation);
        return {
          note: {
            ...created.note,
            attachments: [...noteAttachmentReferences(created.note.bodyMarkdown)]
          },
          revision: created.revision,
          mutationId,
          replayed: false,
          undo: { eligible: true, expiresAt: null }
        };
      })
    );
  }

  public get(noteId: EntityId<"note">): Promise<NoteDto> {
    const note = this.#notes.get(noteId);
    if (note === undefined) throw new Error(`Missing parity note ${noteId}`);
    return Promise.resolve(note);
  }

  public patch(noteId: EntityId<"note">, input: NoteUpdateRequest): Promise<MutationResult> {
    return Promise.resolve(
      this.#replay(input.idempotencyKey, { operation: "patch", noteId, input }, () => {
        const note = this.#notes.get(noteId);
        if (note === undefined) throw new Error(`Missing parity note ${noteId}`);
        return this.#result(
          patchNote(note, {
            expectedRevision: input.expectedRevision,
            now: this.#now(),
            idFactory: this.#idFactory,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.bodyMarkdown === undefined ? {} : { bodyMarkdown: input.bodyMarkdown }),
            ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
            ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
            ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
            ...(input.links === undefined ? {} : { links: input.links })
          })
        );
      })
    );
  }

  public applyInteractive(
    noteId: EntityId<"note">,
    input: InteractiveOperationsRequest
  ): Promise<MutationResult> {
    return Promise.resolve(
      this.#replay(input.idempotencyKey, { operation: "interactive", noteId, input }, () => {
        const note = this.#notes.get(noteId);
        if (note === undefined) throw new Error(`Missing parity note ${noteId}`);
        return this.#result(
          applyNoteOperations(note, {
            expectedRevision: input.expectedRevision,
            operations: input.operations,
            now: this.#now(),
            idFactory: this.#idFactory
          })
        );
      })
    );
  }

  public undo(mutationId: EntityId<"mut">, input: MutationUndoRequest): Promise<MutationResult> {
    return Promise.resolve(
      this.#replay(input.idempotencyKey, { operation: "undo", mutationId, input }, () => {
        const mutation = this.#mutations.get(mutationId);
        if (mutation === undefined) throw new Error(`Missing parity mutation ${mutationId}`);
        const note = this.#notes.get(mutation.noteId);
        if (note === undefined) throw new Error(`Missing parity note ${mutation.noteId}`);
        return this.#result(
          undoNoteMutation(note, mutation, {
            expectedRevision: input.expectedRevision,
            now: this.#now(),
            idFactory: this.#idFactory
          })
        );
      })
    );
  }

  public errorCode(error: unknown): string | undefined {
    return error instanceof DomainError ? error.code : undefined;
  }
}

describe("manual-note cross-adapter parity", () => {
  it("passes the shared creation, reconciliation, stale, undo, and replay scenarios", async () => {
    await expect(
      runManualNoteRepositoryParity(new AggregateParityDriver())
    ).resolves.toBeUndefined();
  });
});
