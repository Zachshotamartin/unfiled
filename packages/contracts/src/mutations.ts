import { z } from "zod";

import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { NoteSchema } from "./notes.js";
import { NoteRevisionSchema } from "./revisions.js";

export const UndoEligibilitySchema = z.strictObject({
  eligible: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }).nullable()
});
export type UndoEligibility = z.infer<typeof UndoEligibilitySchema>;

export const MutationResultSchema = z.strictObject({
  note: NoteSchema,
  revision: NoteRevisionSchema,
  mutationId: entityIdSchema("mut"),
  replayed: z.boolean(),
  undo: UndoEligibilitySchema
});
export type MutationResult = z.infer<typeof MutationResultSchema>;

export const MutationBatchUndoMemberSchema = MutationResultSchema.omit({
  replayed: true
}).superRefine((member, context) => {
  if (member.note.id !== member.revision.noteId) {
    context.addIssue({
      code: "custom",
      message: "A batch undo member revision must belong to its note",
      path: ["revision", "noteId"]
    });
  }
  if (member.note.currentRevision !== member.revision.revision) {
    context.addIssue({
      code: "custom",
      message: "A batch undo member must return the note's current revision",
      path: ["revision", "revision"]
    });
  }
});
export type MutationBatchUndoMember = z.infer<typeof MutationBatchUndoMemberSchema>;

export const MutationBatchUndoResponseSchema = z
  .strictObject({
    members: z.array(MutationBatchUndoMemberSchema).min(1).max(16),
    replayed: z.boolean()
  })
  .superRefine((response, context) => {
    const noteIds = new Set<string>();
    const mutationIds = new Set<string>();
    for (const [index, member] of response.members.entries()) {
      if (noteIds.has(member.note.id)) {
        context.addIssue({
          code: "custom",
          message: "A batch undo response cannot repeat a note",
          path: ["members", index, "note", "id"]
        });
      }
      noteIds.add(member.note.id);
      if (mutationIds.has(member.mutationId)) {
        context.addIssue({
          code: "custom",
          message: "A batch undo response cannot repeat a mutation",
          path: ["members", index, "mutationId"]
        });
      }
      mutationIds.add(member.mutationId);
    }
  });
export type MutationBatchUndoResponse = z.infer<typeof MutationBatchUndoResponseSchema>;

export const MutationUndoRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema
});
export type MutationUndoRequest = z.infer<typeof MutationUndoRequestSchema>;
