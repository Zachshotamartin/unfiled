import { z } from "zod";

import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";
import { NoteLinkValueSchema } from "./structured.js";

export const TagNameSchema = z.string().trim().toLowerCase().min(1).max(40);

export const TagSchema = z.strictObject({
  id: entityIdSchema("tag"),
  name: TagNameSchema,
  currentRevision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true })
});
export type Tag = z.infer<typeof TagSchema>;

export const TagListQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export type TagListQuery = z.infer<typeof TagListQuerySchema>;

export const TagListResponseSchema = z.strictObject({
  items: z.array(TagSchema),
  pageInfo: PageInfoSchema
});
export type TagListResponse = z.infer<typeof TagListResponseSchema>;

export const TagCreateRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  name: TagNameSchema
});
export type TagCreateRequest = z.infer<typeof TagCreateRequestSchema>;

export const TagUpdateRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  name: TagNameSchema
});
export type TagUpdateRequest = z.infer<typeof TagUpdateRequestSchema>;

export const TagDeleteRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema
});
export type TagDeleteRequest = z.infer<typeof TagDeleteRequestSchema>;

export const TagMutationResultSchema = z.strictObject({
  tag: TagSchema,
  replayed: z.boolean()
});
export type TagMutationResult = z.infer<typeof TagMutationResultSchema>;

export const DeleteMutationResultSchema = z.strictObject({
  deletedId: z.string().min(1).max(80),
  replayed: z.boolean()
});
export type DeleteMutationResult = z.infer<typeof DeleteMutationResultSchema>;

export const NoteLinkSchema = z.strictObject({
  id: entityIdSchema("lnk"),
  fromNoteId: entityIdSchema("note"),
  ...NoteLinkValueSchema.shape,
  targetTitle: z.string().min(1).max(200)
});
export type NoteLink = z.infer<typeof NoteLinkSchema>;
