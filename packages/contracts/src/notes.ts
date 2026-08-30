import { z } from "zod";

import { NoteTypeSchema, PrivacyModeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";

export const NoteSchema = z.strictObject({
  id: entityIdSchema("note"),
  spaceId: entityIdSchema("spc").nullable(),
  type: NoteTypeSchema,
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(200_000),
  structuredData: z.record(z.string(), z.unknown()),
  currentRevision: z.number().int().positive(),
  isOpen: z.boolean(),
  pinnedAt: z.iso.datetime({ offset: true }).nullable(),
  privacy: PrivacyModeSchema,
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true })
});

export type NoteDto = z.infer<typeof NoteSchema>;

export const NoteCreateRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  type: NoteTypeSchema,
  spaceId: entityIdSchema("spc").nullable().optional(),
  privacy: PrivacyModeSchema.default("ai_assisted"),
  bodyMarkdown: z.string().max(200_000).default("")
});

export const NoteUpdateRequestSchema = z
  .strictObject({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(80),
    title: z.string().trim().min(1).max(200).optional(),
    bodyMarkdown: z.string().max(200_000).optional(),
    privacy: PrivacyModeSchema.optional()
  })
  .refine(
    ({ title, bodyMarkdown, privacy }) =>
      title !== undefined || bodyMarkdown !== undefined || privacy !== undefined,
    "At least one editable field is required"
  );
