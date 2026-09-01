import { z } from "zod";

import { NoteTypeSchema, PrivacyModeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { NoteLinkValueSchema, NoteStructuredDataSchema } from "./structured.js";

const boundedText = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/[\r\n]/u.test(value), "Item text must be one line");

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

export const ToggleItemCheckedOperationSchema = z.strictObject({
  type: z.literal("toggle_item_checked"),
  itemId: entityIdSchema("itm"),
  checked: z.boolean()
});
export type ToggleItemCheckedOperation = z.infer<typeof ToggleItemCheckedOperationSchema>;

export const UpdateLogFieldOperationSchema = z.strictObject({
  type: z.literal("update_log_field"),
  entryId: entityIdSchema("ent"),
  fieldPath: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  value: z.union([z.string().max(500), z.number(), z.null()])
});
export type UpdateLogFieldOperation = z.infer<typeof UpdateLogFieldOperationSchema>;

export const RestoreSnapshotOperationSchema = z.strictObject({
  type: z.literal("restore_snapshot"),
  spaceId: entityIdSchema("spc").nullable(),
  noteType: NoteTypeSchema,
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(200_000),
  structuredData: NoteStructuredDataSchema,
  privacy: PrivacyModeSchema,
  isOpen: z.boolean(),
  pinnedAt: z.iso.datetime({ offset: true }).nullable(),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
  tagIds: z.array(entityIdSchema("tag")).max(100),
  links: z.array(NoteLinkValueSchema).max(100)
});

export const UserOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set_title"), title: z.string().trim().min(1).max(200) }),
  z.strictObject({
    type: z.literal("replace_body_markdown"),
    bodyMarkdown: z.string().max(200_000)
  }),
  z.strictObject({ type: z.literal("set_privacy"), privacy: PrivacyModeSchema }),
  z.strictObject({
    type: z.literal("move_to_space"),
    spaceId: entityIdSchema("spc").nullable()
  }),
  z.strictObject({
    type: z.literal("set_archived"),
    archivedAt: z.iso.datetime({ offset: true }).nullable()
  }),
  z.strictObject({
    type: z.literal("set_deleted"),
    deletedAt: z.iso.datetime({ offset: true }).nullable()
  }),
  z.strictObject({ type: z.literal("set_tags"), tagIds: z.array(entityIdSchema("tag")).max(100) }),
  z.strictObject({
    type: z.literal("set_note_links"),
    links: z.array(NoteLinkValueSchema).max(100)
  }),
  ToggleItemCheckedOperationSchema,
  UpdateLogFieldOperationSchema,
  z.strictObject({
    type: z.literal("edit_item_text"),
    itemId: entityIdSchema("itm"),
    text: boundedText
  }),
  z.strictObject({ type: z.literal("remove_item"), itemId: entityIdSchema("itm") }),
  RestoreSnapshotOperationSchema
]);
export type UserOperation = z.infer<typeof UserOperationSchema>;

export const TypedOperationSchema = z.union([ModelOperationSchema, UserOperationSchema]);
export type TypedOperation = z.infer<typeof TypedOperationSchema>;

export const InteractiveOperationSchema = z.discriminatedUnion("type", [
  ToggleItemCheckedOperationSchema,
  UpdateLogFieldOperationSchema
]);
export type InteractiveOperation = z.infer<typeof InteractiveOperationSchema>;

export const InteractiveOperationsRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  operations: z.array(InteractiveOperationSchema).min(1).max(20)
});
export type InteractiveOperationsRequest = z.infer<typeof InteractiveOperationsRequestSchema>;

export const UserMutationRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  operations: z.array(UserOperationSchema).min(1).max(20)
});
export type UserMutationRequest = z.infer<typeof UserMutationRequestSchema>;

export const OperationsRequestSchema = InteractiveOperationsRequestSchema;
export type OperationsRequest = InteractiveOperationsRequest;
