import { z } from "zod";

import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { entityIdSchema } from "./ids.js";
import { MutationResultSchema } from "./mutations.js";
import { NoteLinkValueSchema } from "./structured.js";
import { NoteLinkSchema } from "./tags.js";

const NoteLinkWriteFields = {
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  ...NoteLinkValueSchema.shape
} as const;

export const NoteLinkListResponseSchema = z.strictObject({ items: z.array(NoteLinkSchema) });
export type NoteLinkListResponse = z.infer<typeof NoteLinkListResponseSchema>;

export const NoteLinkCreateRequestSchema = z.strictObject(NoteLinkWriteFields);
export type NoteLinkCreateRequest = z.infer<typeof NoteLinkCreateRequestSchema>;

// Deletion carries the original relation value so the server can record a complete inverse.
export const NoteLinkDeleteRequestSchema = z.strictObject(NoteLinkWriteFields);
export type NoteLinkDeleteRequest = z.infer<typeof NoteLinkDeleteRequestSchema>;

export const NoteTagLinkRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  tagId: entityIdSchema("tag")
});
export type NoteTagLinkRequest = z.infer<typeof NoteTagLinkRequestSchema>;

export const NoteTagUnlinkRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema
});
export type NoteTagUnlinkRequest = z.infer<typeof NoteTagUnlinkRequestSchema>;

export const NoteRelationMutationResponseSchema = MutationResultSchema;
export type NoteRelationMutationResponse = z.infer<typeof NoteRelationMutationResponseSchema>;
