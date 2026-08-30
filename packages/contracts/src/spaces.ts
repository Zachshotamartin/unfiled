import { z } from "zod";

import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

const BooleanQuerySchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const SpaceSchema = z.strictObject({
  id: entityIdSchema("spc"),
  parentId: entityIdSchema("spc").nullable(),
  name: z.string().min(1).max(60),
  slug: z.string().min(1).max(80),
  sortKey: z.string().min(1).max(100),
  currentRevision: z.number().int().positive(),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true })
});
export type Space = z.infer<typeof SpaceSchema>;

export const SpaceDetailResponseSchema = z.strictObject({ space: SpaceSchema });
export type SpaceDetailResponse = z.infer<typeof SpaceDetailResponseSchema>;

export const SpaceListQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  includeArchived: BooleanQuerySchema.default(false)
});
export type SpaceListQuery = z.infer<typeof SpaceListQuerySchema>;

export const SpaceListResponseSchema = z.strictObject({
  items: z.array(SpaceSchema),
  pageInfo: PageInfoSchema
});
export type SpaceListResponse = z.infer<typeof SpaceListResponseSchema>;

export const SpaceCreateRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  name: z.string().trim().min(1).max(60),
  parentId: entityIdSchema("spc").nullable().default(null),
  sortKey: z.string().trim().min(1).max(100).optional()
});
export type SpaceCreateRequest = z.input<typeof SpaceCreateRequestSchema>;

export const SpaceUpdateRequestSchema = z
  .strictObject({
    expectedRevision: ExpectedRevisionSchema,
    idempotencyKey: IdempotencyKeySchema,
    name: z.string().trim().min(1).max(60).optional(),
    parentId: entityIdSchema("spc").nullable().optional(),
    sortKey: z.string().trim().min(1).max(100).optional()
  })
  .refine(
    ({ name, parentId, sortKey }) =>
      name !== undefined || parentId !== undefined || sortKey !== undefined,
    "At least one space field is required"
  );
export type SpaceUpdateRequest = z.infer<typeof SpaceUpdateRequestSchema>;

export const SpaceArchiveRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  archived: z.boolean().default(true)
});
export type SpaceArchiveRequest = z.input<typeof SpaceArchiveRequestSchema>;

export const SpaceMutationResultSchema = z.strictObject({
  space: SpaceSchema,
  replayed: z.boolean()
});
export type SpaceMutationResult = z.infer<typeof SpaceMutationResultSchema>;
