import { z } from "zod";

import { ReviewStateSchema, ReviewTypeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

export const ReviewItemDtoSchema = z.strictObject({
  id: entityIdSchema("rvw"),
  captureId: entityIdSchema("cap").nullable(),
  noteId: entityIdSchema("note").nullable(),
  type: ReviewTypeSchema,
  choices: z.array(z.json()),
  state: ReviewStateSchema,
  resolution: z.record(z.string(), z.json()).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }).nullable()
});
export type ReviewItemDto = z.infer<typeof ReviewItemDtoSchema>;

export const ReviewItemListQuerySchema = z.strictObject({
  state: ReviewStateSchema.default("open"),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export type ReviewItemListQuery = z.infer<typeof ReviewItemListQuerySchema>;

export const ListReviewItemsResponseSchema = z.strictObject({
  items: z.array(ReviewItemDtoSchema),
  pageInfo: PageInfoSchema
});
export type ListReviewItemsResponse = z.infer<typeof ListReviewItemsResponseSchema>;
