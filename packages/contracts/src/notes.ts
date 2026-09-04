import { z } from "zod";

import {
  MAX_NOTE_ATTACHMENTS,
  NoteAttachmentSchema,
  noteAttachmentReferences,
  type NoteAttachment
} from "./captures.js";
import {
  ArchiveFilterSchema,
  DeletedFilterSchema,
  NoteTypeSchema,
  PrivacyModeSchema
} from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";
import { NoteLinkValueSchema, NoteStructuredDataSchema } from "./structured.js";

export const NoteSnapshotSchema = z.strictObject({
  spaceId: entityIdSchema("spc").nullable(),
  type: NoteTypeSchema,
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(200_000),
  structuredData: NoteStructuredDataSchema,
  isOpen: z.boolean(),
  pinnedAt: z.iso.datetime({ offset: true }).nullable(),
  privacy: PrivacyModeSchema,
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
  tagIds: z.array(entityIdSchema("tag")).max(100),
  links: z.array(NoteLinkValueSchema).max(100)
});
export type NoteSnapshot = z.infer<typeof NoteSnapshotSchema>;

export const NoteSchema = NoteSnapshotSchema.extend({
  id: entityIdSchema("note"),
  currentRevision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true })
});
export type NoteDto = z.infer<typeof NoteSchema>;

/**
 * A note as the API returns it: the stored note plus the photos and recordings its body places.
 * The body keeps the references because they carry the placement, and the array carries the
 * identity and kind, so a client renders a note's photo without parsing the body for markers.
 * The array is a projection of the body and is checked against it, so the two cannot drift.
 */
export const NoteDetailSchema = NoteSchema.extend({
  attachments: z.array(NoteAttachmentSchema).max(MAX_NOTE_ATTACHMENTS)
}).superRefine((note, context) => {
  const placement = (attachment: NoteAttachment): string => `${attachment.kind}:${attachment.id}`;
  const placed = noteAttachmentReferences(note.bodyMarkdown).map(placement).join("\n");
  if (placed !== note.attachments.map(placement).join("\n")) {
    context.addIssue({
      code: "custom",
      message: "Note attachments must be exactly the references its body places, in body order",
      path: ["attachments"]
    });
  }
});
export type NoteDetail = z.infer<typeof NoteDetailSchema>;

export const NoteSummarySchema = z.strictObject({
  id: entityIdSchema("note"),
  spaceId: entityIdSchema("spc").nullable(),
  type: NoteTypeSchema,
  title: z.string().min(1).max(200),
  currentRevision: z.number().int().positive(),
  isOpen: z.boolean(),
  pinnedAt: z.iso.datetime({ offset: true }).nullable(),
  privacy: PrivacyModeSchema,
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true })
});
export type NoteSummary = z.infer<typeof NoteSummarySchema>;

export const NoteDetailResponseSchema = z.strictObject({ note: NoteDetailSchema });
export type NoteDetailResponse = z.infer<typeof NoteDetailResponseSchema>;

export const NoteListQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  spaceId: z
    .union([entityIdSchema("spc"), z.literal("root").transform(() => null), z.null()])
    .optional(),
  type: NoteTypeSchema.optional(),
  archive: ArchiveFilterSchema.default("exclude"),
  deleted: DeletedFilterSchema.default("exclude")
});
export type NoteListQuery = z.infer<typeof NoteListQuerySchema>;

export const NoteListResponseSchema = z.strictObject({
  items: z.array(NoteSummarySchema),
  pageInfo: PageInfoSchema
});
export type NoteListResponse = z.infer<typeof NoteListResponseSchema>;

export const NoteCreateRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  title: z.string().trim().min(1).max(200),
  type: NoteTypeSchema,
  spaceId: entityIdSchema("spc").nullable().optional(),
  privacy: PrivacyModeSchema.default("ai_assisted"),
  bodyMarkdown: z.string().max(200_000).default(""),
  tagIds: z.array(entityIdSchema("tag")).max(100).default([]),
  links: z.array(NoteLinkValueSchema).max(100).default([])
});
export type NoteCreateRequest = z.input<typeof NoteCreateRequestSchema>;

export const NoteUpdateRequestSchema = z
  .strictObject({
    expectedRevision: ExpectedRevisionSchema,
    idempotencyKey: IdempotencyKeySchema,
    title: z.string().trim().min(1).max(200).optional(),
    bodyMarkdown: z.string().max(200_000).optional(),
    privacy: PrivacyModeSchema.optional(),
    spaceId: entityIdSchema("spc").nullable().optional(),
    tagIds: z.array(entityIdSchema("tag")).max(100).optional(),
    links: z.array(NoteLinkValueSchema).max(100).optional()
  })
  .refine(
    ({ title, bodyMarkdown, privacy, spaceId, tagIds, links }) =>
      title !== undefined ||
      bodyMarkdown !== undefined ||
      privacy !== undefined ||
      spaceId !== undefined ||
      tagIds !== undefined ||
      links !== undefined,
    "At least one editable field is required"
  );
export type NoteUpdateRequest = z.infer<typeof NoteUpdateRequestSchema>;

export const NoteMoveRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  spaceId: entityIdSchema("spc").nullable()
});
export type NoteMoveRequest = z.infer<typeof NoteMoveRequestSchema>;

export const NoteArchiveRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  archived: z.boolean().default(true)
});
export type NoteArchiveRequest = z.input<typeof NoteArchiveRequestSchema>;

export const NoteSoftDeleteRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema
});
export type NoteSoftDeleteRequest = z.infer<typeof NoteSoftDeleteRequestSchema>;

export const NoteRestoreDeletedRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema
});
export type NoteRestoreDeletedRequest = z.infer<typeof NoteRestoreDeletedRequestSchema>;
