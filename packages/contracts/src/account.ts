import { z } from "zod";

import { NoteTypeSchema, PrivacyModeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
const TimestampSchema = z.iso.datetime({ offset: true });

/**
 * A deletion token is also the only credential that can recover a content-free
 * receipt after the auth principal has been removed. Official clients encode
 * 32 CSPRNG bytes so that response-loss replay is an
 * unguessable capability. The server can validate only the canonical 32-byte
 * base64url encoding shape; neither the token nor the owner UUID is retained.
 */
export const AccountDeletionTokenSchema = z
  .string()
  .regex(/^delete_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
export type AccountDeletionToken = z.infer<typeof AccountDeletionTokenSchema>;

export const AccountDeleteRequestSchema = z.strictObject({
  confirmation: z.literal("DELETE"),
  idempotencyKey: AccountDeletionTokenSchema
});
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;

export const AccountDeletionReceiptReplayRequestSchema = z.strictObject({
  idempotencyKey: AccountDeletionTokenSchema
});
export type AccountDeletionReceiptReplayRequest = z.infer<
  typeof AccountDeletionReceiptReplayRequestSchema
>;

const DeletedRecordCountsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,2}$/u),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  )
  .superRefine((value, context) => {
    if (Object.keys(value).length > 128) {
      context.addIssue({ code: "custom", message: "Too many deletion audit categories" });
    }
  });

export const AccountDeletionReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deletedAt: TimestampSchema,
  backupExpiresAt: TimestampSchema,
  receiptExpiresAt: TimestampSchema,
  backupRetentionDays: z.literal(30),
  liveDataDeleted: z.literal(true),
  sessionsRevoked: z.literal(true),
  reRegistrationStartsFresh: z.literal(true),
  deletedRecordCounts: DeletedRecordCountsSchema,
  replayed: z.boolean()
});
export type AccountDeletionReceipt = z.infer<typeof AccountDeletionReceiptSchema>;

export const AccountExportNoteLinkSchema = z.strictObject({
  toNoteId: entityIdSchema("note"),
  linkType: z.enum(["reference", "related"])
});

export const AccountExportNoteSchema = z.strictObject({
  id: entityIdSchema("note"),
  markdownPath: z.string().min(1).max(255),
  spaceId: entityIdSchema("spc").nullable(),
  type: NoteTypeSchema,
  privacy: PrivacyModeSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
  deletedAt: TimestampSchema.nullable(),
  tagIds: z.array(entityIdSchema("tag")).max(100),
  links: z.array(AccountExportNoteLinkSchema).max(100),
  sourceCaptureIds: z.array(entityIdSchema("cap")).max(1_000)
});
export type AccountExportNote = z.infer<typeof AccountExportNoteSchema>;

export const AccountExportSpaceSchema = z.strictObject({
  id: entityIdSchema("spc"),
  parentId: entityIdSchema("spc").nullable(),
  name: z.string().min(1).max(120),
  path: z.string().min(1).max(500),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});
export type AccountExportSpace = z.infer<typeof AccountExportSpaceSchema>;

export const AccountExportTagSchema = z.strictObject({
  id: entityIdSchema("tag"),
  name: z.string().min(1).max(80),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});
export type AccountExportTag = z.infer<typeof AccountExportTagSchema>;

export const AccountExportRoutingRuleSchema = z.strictObject({
  id: entityIdSchema("rule"),
  enabled: z.boolean(),
  ruleType: z.enum(["prefix", "phrase", "alias", "destination_mention"]),
  condition: z.string().min(1).max(500),
  normalizedCondition: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(200)).max(100),
  destinationNoteId: entityIdSchema("note").nullable(),
  destinationSpaceId: entityIdSchema("spc").nullable(),
  priority: z.number().int().min(0).max(10_000),
  source: z.enum(["explicit", "correction_suggested"]),
  lastFiredAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});
export type AccountExportRoutingRule = z.infer<typeof AccountExportRoutingRuleSchema>;

export const AccountExportManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  exportedAt: TimestampSchema,
  spaces: z.array(AccountExportSpaceSchema).max(1_000),
  tags: z.array(AccountExportTagSchema).max(1_000),
  notes: z.array(AccountExportNoteSchema).max(100_000),
  routingRules: z.array(AccountExportRoutingRuleSchema).max(10_000)
});
export type AccountExportManifest = z.infer<typeof AccountExportManifestSchema>;
