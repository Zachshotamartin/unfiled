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

export const MutationUndoRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema
});
export type MutationUndoRequest = z.infer<typeof MutationUndoRequestSchema>;
