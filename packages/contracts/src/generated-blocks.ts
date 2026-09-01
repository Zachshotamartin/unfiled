import { z } from "zod";

import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";

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
  });
export type GeneratedBlockDto = z.infer<typeof GeneratedBlockDtoSchema>;

export const GeneratedBlockListResponseSchema = z.strictObject({
  items: z.array(GeneratedBlockDtoSchema).max(1_000)
});
export type GeneratedBlockListResponse = z.infer<typeof GeneratedBlockListResponseSchema>;

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
