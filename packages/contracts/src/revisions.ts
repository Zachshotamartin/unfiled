import { z } from "zod";

import { RevisionSourceSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { NoteSnapshotSchema } from "./notes.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

export const NoteRevisionSchema = NoteSnapshotSchema.extend({
  id: entityIdSchema("rev"),
  noteId: entityIdSchema("note"),
  revision: z.number().int().positive(),
  source: RevisionSourceSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  actor: z.string().min(1).max(200),
  createdAt: z.iso.datetime({ offset: true })
});
export type NoteRevisionDto = z.infer<typeof NoteRevisionSchema>;

export const NoteRevisionListQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export type NoteRevisionListQuery = z.infer<typeof NoteRevisionListQuerySchema>;

export const NoteRevisionListResponseSchema = z.strictObject({
  items: z.array(NoteRevisionSchema),
  pageInfo: PageInfoSchema
});
export type NoteRevisionListResponse = z.infer<typeof NoteRevisionListResponseSchema>;

export const NoteRestoreRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  revisionId: entityIdSchema("rev")
});
export type NoteRestoreRequest = z.infer<typeof NoteRestoreRequestSchema>;
