import { z, type ZodType } from "zod";

export const CursorSchema = z.string().min(1).max(512);

export const PaginationQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PageInfoSchema = z.strictObject({
  hasMore: z.boolean(),
  nextCursor: CursorSchema.nullable()
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

export function paginatedResponseSchema<T>(itemSchema: ZodType<T>) {
  return z.strictObject({
    items: z.array(itemSchema),
    pageInfo: PageInfoSchema
  });
}
