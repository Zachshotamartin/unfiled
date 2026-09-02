import { z } from "zod";

import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { PageInfoSchema } from "./pagination.js";

/** A fixed, bounded page keeps encrypted reads responsive as accepted blocks accumulate. */
export const GENERATED_BLOCK_PAGE_SIZE = 50;
export const MAX_GENERATED_BLOCK_RESPONSE_BYTES = 8 * 1024 * 1024;

export const GeneratedBlockKindSchema = z.enum([
  "summary",
  "interpretation",
  "suggestion",
  "label"
]);
export type GeneratedBlockKind = z.infer<typeof GeneratedBlockKindSchema>;

export const GeneratedBlockStateSchema = z.enum(["proposed", "accepted", "rejected"]);
export type GeneratedBlockState = z.infer<typeof GeneratedBlockStateSchema>;

export const GeneratedBlockDtoSchema = z
  .strictObject({
    id: entityIdSchema("blk"),
    noteId: entityIdSchema("note"),
    decisionId: entityIdSchema("dec"),
    kind: GeneratedBlockKindSchema,
    content: z.string().min(1).max(600),
    state: GeneratedBlockStateSchema,
    stateRevision: ExpectedRevisionSchema,
    modelId: z.string().min(1).max(120),
    promptVersion: z.string().min(1).max(120),
    createdAt: z.iso.datetime({ offset: true }),
    resolvedAt: z.iso.datetime({ offset: true }).nullable()
  })
  .superRefine((block, context) => {
    const shouldBeResolved = block.state !== "proposed";
    if (shouldBeResolved !== (block.resolvedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only accepted or rejected generated blocks have a resolution timestamp",
        path: ["resolvedAt"]
      });
    }
    if (
      (block.state === "proposed" && block.stateRevision !== 1) ||
      (block.state !== "proposed" && block.stateRevision < 2)
    ) {
      context.addIssue({
        code: "custom",
        message: "Generated-block state revision does not match its lifecycle state",
        path: ["stateRevision"]
      });
    }
    if (block.resolvedAt !== null && Date.parse(block.resolvedAt) < Date.parse(block.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "A generated block cannot resolve before it was created",
        path: ["resolvedAt"]
      });
    }
  });
export type GeneratedBlockDto = z.infer<typeof GeneratedBlockDtoSchema>;

/** Public reads never disclose rejected content during its encrypted retention window. */
export const VisibleGeneratedBlockDtoSchema = GeneratedBlockDtoSchema.safeExtend({
  state: z.enum(["proposed", "accepted"])
});
export type VisibleGeneratedBlockDto = z.infer<typeof VisibleGeneratedBlockDtoSchema>;

export const GeneratedBlockListQuerySchema = z.strictObject({
  cursor: entityIdSchema("blk").optional()
});
export type GeneratedBlockListQuery = z.infer<typeof GeneratedBlockListQuerySchema>;

export const GeneratedBlockListResponseSchema = z
  .strictObject({
    items: z.array(VisibleGeneratedBlockDtoSchema).max(GENERATED_BLOCK_PAGE_SIZE),
    pageInfo: PageInfoSchema
  })
  .superRefine(({ items, pageInfo }, context) => {
    for (const [index, block] of items.entries()) {
      const previous = items[index - 1];
      if (previous !== undefined && block.id <= previous.id) {
        context.addIssue({
          code: "custom",
          message: "Generated-block pages must be strictly ordered by block identifier",
          path: ["items", index, "id"]
        });
      }
    }
    if (pageInfo.hasMore !== (pageInfo.nextCursor !== null)) {
      context.addIssue({
        code: "custom",
        message: "Generated-block pagination state is inconsistent",
        path: ["pageInfo"]
      });
    }
    if (
      pageInfo.hasMore &&
      (items.length !== GENERATED_BLOCK_PAGE_SIZE || pageInfo.nextCursor !== items.at(-1)?.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "A continuing generated-block page must be full and cursor-bound",
        path: ["pageInfo", "nextCursor"]
      });
    }
  });
export type GeneratedBlockListResponse = z.infer<typeof GeneratedBlockListResponseSchema>;

export const GeneratedBlockDetailResponseSchema = z.strictObject({
  block: VisibleGeneratedBlockDtoSchema
});
export type GeneratedBlockDetailResponse = z.infer<typeof GeneratedBlockDetailResponseSchema>;

export const GeneratedBlockResolveRequestSchema = z.strictObject({
  expectedStateRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  resolution: z.enum(["accept", "reject"])
});
export type GeneratedBlockResolveRequest = z.infer<typeof GeneratedBlockResolveRequestSchema>;

export const GeneratedBlockResolveResponseSchema = z.strictObject({
  block: GeneratedBlockDtoSchema,
  replayed: z.boolean()
});
export type GeneratedBlockResolveResponse = z.infer<typeof GeneratedBlockResolveResponseSchema>;
