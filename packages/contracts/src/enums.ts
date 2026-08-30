import { z } from "zod";

export const NoteTypeSchema = z.enum(["generic", "list", "log", "principle", "project"]);
export type NoteType = z.infer<typeof NoteTypeSchema>;

export const PrivacyModeSchema = z.enum(["ai_assisted", "private_manual"]);
export type PrivacyMode = z.infer<typeof PrivacyModeSchema>;

export const CaptureSourceSchema = z.enum([
  "mobile",
  "web",
  "ios_lock_screen_widget",
  "share_sheet",
  "import"
]);
export type CaptureSource = z.infer<typeof CaptureSourceSchema>;

export const CaptureStatusSchema = z.enum([
  "pending",
  "queued",
  "processing",
  "organized",
  "inbox",
  "needs_review",
  "failed",
  "deleted"
]);
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;

export const OrganizationModeSchema = z.enum(["cautious", "balanced", "automatic"]);
export type OrganizationMode = z.infer<typeof OrganizationModeSchema>;

export const RoutingEffortSchema = z.enum(["economical", "standard", "thorough"]);
export type RoutingEffort = z.infer<typeof RoutingEffortSchema>;

export const ExpansionStyleSchema = z.enum(["off", "brief", "detailed"]);
export type ExpansionStyle = z.infer<typeof ExpansionStyleSchema>;

export const AiProviderSchema = z.enum(["openai", "anthropic"]);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const BehaviorBandSchema = z.enum(["auto", "review", "inbox"]);
export type BehaviorBand = z.infer<typeof BehaviorBandSchema>;

export const CaptureKindSchema = z.enum([
  "list_items",
  "log_entry",
  "principle",
  "project_update",
  "freeform"
]);
export type CaptureKind = z.infer<typeof CaptureKindSchema>;

export const RevisionSourceSchema = z.enum([
  "manual",
  "organization",
  "undo",
  "import",
  "interactive"
]);
export type RevisionSource = z.infer<typeof RevisionSourceSchema>;

export const ArchiveFilterSchema = z.enum(["exclude", "include", "only"]);
export type ArchiveFilter = z.infer<typeof ArchiveFilterSchema>;

export const DeletedFilterSchema = z.enum(["exclude", "only"]);
export type DeletedFilter = z.infer<typeof DeletedFilterSchema>;

export const ReviewTypeSchema = z.enum([
  "low_confidence",
  "revision_conflict",
  "failed_job",
  "duplicate_suggestion",
  "pending_expansion",
  "structure_conflict"
]);
export type ReviewType = z.infer<typeof ReviewTypeSchema>;

export const ReviewStateSchema = z.enum(["open", "resolved", "dismissed"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;
