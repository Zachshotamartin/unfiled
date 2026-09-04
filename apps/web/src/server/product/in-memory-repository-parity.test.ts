import {
  MutationResultSchema,
  NoteCreateRequestSchema,
  NoteDetailSchema,
  NoteUpdateRequestSchema,
  noteAttachmentReferences,
  type MutationResult,
  type NoteDetail
} from "@unfiled/contracts";
import { runManualNoteRepositoryParity, type ManualNoteParityDriver } from "@unfiled/domain";
import { describe, expect, it } from "vitest";

import type {
  CreateNoteInput,
  NoteMutationResult,
  NoteRecord,
  UpdateNoteInput
} from "@/lib/product/types";
import { HttpError } from "@/server/api/errors";

import { InMemoryManualNotesRepository } from "./in-memory-repository";
import type { RepositoryContext } from "./repository";

const context: RepositoryContext = {
  accessToken: "parity-access-token",
  userId: "00000000-0000-4000-8000-000000000041"
};

function noteDetail(note: NoteRecord): NoteDetail {
  return NoteDetailSchema.parse({
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
    updatedAt: note.updatedAt,
    attachments: noteAttachmentReferences(note.bodyMarkdown)
  });
}

function mutationResult(result: NoteMutationResult): MutationResult {
  return MutationResultSchema.parse({
    note: noteDetail(result.note),
    revision: result.revision,
    mutationId: result.mutation.id,
    replayed: result.mutation.replayed,
    undo: { eligible: result.mutation.undoAvailable, expiresAt: null }
  });
}

describe("InMemoryManualNotesRepository domain parity", () => {
  it("runs the shared five-type and lifecycle parity suite", async () => {
    const repository = new InMemoryManualNotesRepository(false);
    const createdSpace = await repository.createSpace(
      context,
      { name: "Parity", parentId: null, sortKey: "a0" },
      "parity-space-create"
    );

    const driver: ManualNoteParityDriver = {
      spaceId: createdSpace.space.id,
      create: async (request) => {
        const parsed = NoteCreateRequestSchema.parse(request);
        const input: CreateNoteInput = {
          title: parsed.title,
          type: parsed.type,
          bodyMarkdown: parsed.bodyMarkdown,
          privacy: parsed.privacy,
          spaceId: parsed.spaceId ?? null,
          tagIds: parsed.tagIds,
          links: parsed.links
        };
        return mutationResult(await repository.createNote(context, input, parsed.idempotencyKey));
      },
      patch: async (noteId, request) => {
        const parsed = NoteUpdateRequestSchema.parse(request);
        const input: UpdateNoteInput = {
          expectedRevision: parsed.expectedRevision,
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
          ...(parsed.bodyMarkdown === undefined ? {} : { bodyMarkdown: parsed.bodyMarkdown }),
          ...(parsed.privacy === undefined ? {} : { privacy: parsed.privacy }),
          ...(parsed.spaceId === undefined ? {} : { spaceId: parsed.spaceId }),
          ...(parsed.tagIds === undefined ? {} : { tagIds: parsed.tagIds }),
          ...(parsed.links === undefined ? {} : { links: parsed.links })
        };
        return mutationResult(
          await repository.updateNote(context, noteId, input, parsed.idempotencyKey)
        );
      },
      applyInteractive: async (noteId, { expectedRevision, idempotencyKey, operations }) =>
        mutationResult(
          await repository.applyOperations(context, noteId, operations, {
            expectedRevision,
            idempotencyKey
          })
        ),
      undo: async (mutationId, input) =>
        mutationResult(await repository.undoMutation(context, mutationId, input)),
      get: async (noteId) => noteDetail(await repository.getNote(context, noteId)),
      errorCode: (error) => (error instanceof HttpError ? error.code : undefined)
    };

    await expect(runManualNoteRepositoryParity(driver)).resolves.toBeUndefined();
  });
});
