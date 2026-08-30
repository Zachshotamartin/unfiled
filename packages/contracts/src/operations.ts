import { z } from "zod";

import { entityIdSchema } from "./ids.js";

const boundedText = z.string().min(1).max(500);

export const ModelOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("append_raw"), content: z.string().min(1).max(10_000) }),
  z.strictObject({
    type: z.literal("append_paragraphs"),
    paragraphs: z.array(boundedText).min(1).max(20)
  }),
  z.strictObject({
    type: z.literal("append_list_items"),
    section: z.string().max(100).nullable(),
    items: z.array(boundedText).min(1).max(50)
  }),
  z.strictObject({
    type: z.literal("append_log_entry"),
    entry: z.record(z.string(), z.unknown())
  }),
  z.strictObject({
    type: z.literal("update_structured_data"),
    patch: z.record(z.string(), z.unknown())
  }),
  z.strictObject({
    type: z.literal("add_tags"),
    tagIds: z.array(entityIdSchema("tag")).min(1).max(5)
  }),
  z.strictObject({
    type: z.literal("add_relation"),
    toCandidateId: entityIdSchema("note"),
    linkType: z.enum(["reference", "related"])
  })
]);

export type ModelOperation = z.infer<typeof ModelOperationSchema>;

export const UserOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("toggle_item_checked"),
    itemId: entityIdSchema("itm"),
    checked: z.boolean()
  }),
  z.strictObject({
    type: z.literal("update_log_field"),
    entryId: entityIdSchema("ent"),
    fieldPath: z
      .array(z.union([z.string(), z.number().int().nonnegative()]))
      .min(1)
      .max(8),
    value: z.union([z.string().max(500), z.number(), z.null()])
  }),
  z.strictObject({
    type: z.literal("edit_item_text"),
    itemId: entityIdSchema("itm"),
    text: boundedText
  }),
  z.strictObject({ type: z.literal("remove_item"), itemId: entityIdSchema("itm") })
]);

export type UserOperation = z.infer<typeof UserOperationSchema>;
export const TypedOperationSchema = z.union([ModelOperationSchema, UserOperationSchema]);
export type TypedOperation = z.infer<typeof TypedOperationSchema>;

export const OperationsRequestSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(80),
  operations: z.array(UserOperationSchema).min(1).max(20)
});
export type OperationsRequest = z.infer<typeof OperationsRequestSchema>;
