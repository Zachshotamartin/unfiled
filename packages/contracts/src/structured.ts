import { z } from "zod";

import { entityIdSchema } from "./ids.js";

const singleLineText = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/[\r\n]/u.test(value), "Structured item text must be one line");

export const ListItemSchema = z.strictObject({
  id: entityIdSchema("itm"),
  text: singleLineText,
  checked: z.boolean(),
  ordinal: z.number().int().nonnegative(),
  section: z.string().trim().min(1).max(100).nullable()
});
export type ListItem = z.infer<typeof ListItemSchema>;

export const ListStructuredDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  items: z.array(ListItemSchema).max(2_000)
});
export type ListStructuredData = z.infer<typeof ListStructuredDataSchema>;

/**
 * The longest string one log field holds. The organizer files a whole capture as one entry
 * (`raw`), and a detailed workout or a day's notes runs well past 500 characters; that bound
 * refused every such entry at write time while the plan and the preservation check had already
 * accepted it. The database and the domain parser enforce the same number.
 */
export const LOG_FIELD_VALUE_MAX_CHARACTERS = 10_000;

export const LogFieldValueSchema = z.union([
  z.string().max(LOG_FIELD_VALUE_MAX_CHARACTERS),
  z.number(),
  z.null()
]);
export type LogFieldValue = z.infer<typeof LogFieldValueSchema>;

export const LogEntrySchema = z.strictObject({
  id: entityIdSchema("ent"),
  occurredAt: z.iso.datetime({ offset: true }),
  fields: z
    .record(z.string().trim().min(1).max(80), LogFieldValueSchema)
    .refine((fields) => Object.keys(fields).length <= 50, "A log entry has at most 50 fields")
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LogStructuredDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(LogEntrySchema).max(2_000)
});
export type LogStructuredData = z.infer<typeof LogStructuredDataSchema>;

export const ProjectChecklistItemSchema = z.strictObject({
  id: entityIdSchema("itm"),
  text: singleLineText,
  checked: z.boolean(),
  ordinal: z.number().int().nonnegative(),
  lineIndex: z.number().int().nonnegative()
});
export type ProjectChecklistItem = z.infer<typeof ProjectChecklistItemSchema>;

export const ProjectStructuredDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checklistItems: z.array(ProjectChecklistItemSchema).max(2_000)
});
export type ProjectStructuredData = z.infer<typeof ProjectStructuredDataSchema>;

export const PlainStructuredDataSchema = z.strictObject({ schemaVersion: z.literal(1) });
export type PlainStructuredData = z.infer<typeof PlainStructuredDataSchema>;

export const NoteStructuredDataSchema = z.union([
  ListStructuredDataSchema,
  LogStructuredDataSchema,
  ProjectStructuredDataSchema,
  PlainStructuredDataSchema
]);
export type NoteStructuredData = z.infer<typeof NoteStructuredDataSchema>;

export const NoteLinkValueSchema = z.strictObject({
  toNoteId: entityIdSchema("note"),
  linkType: z.enum(["reference", "related"])
});
export type NoteLinkValue = z.infer<typeof NoteLinkValueSchema>;
