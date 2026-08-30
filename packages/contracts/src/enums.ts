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
