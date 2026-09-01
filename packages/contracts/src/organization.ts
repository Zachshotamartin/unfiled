import { z } from "zod";

import { CaptureKindSchema, NoteTypeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { ModelOperationSchema } from "./operations.js";

export const OrganizationDecisionSchema = z.enum([
  "append_to_note",
  "create_note",
  "add_to_inbox",
  "needs_review"
]);

export const AllowedReasonCodeSchema = z.enum([
  "explicit_shopping_intent",
  "explicit_destination",
  "routing_rule_match",
  "open_daily_list",
  "same_day_log",
  "alias_match",
  "semantic_match",
  "recent_destination",
  "type_match",
  "no_candidate_fit",
  "ambiguous_intent",
  "duplicate_suspected",
  "low_information",
  "parser_override"
]);

const RoutingRuleMatchSnapshotFields = {
  ruleId: entityIdSchema("rule"),
  ruleRevision: z.number().int().positive(),
  priority: z.number().int().min(0).max(10_000),
  matched: z.literal(true)
} as const;

export const RoutingRuleMatchSnapshotSchema = z.discriminatedUnion("destinationKind", [
  z.strictObject({
    ...RoutingRuleMatchSnapshotFields,
    destinationKind: z.literal("note"),
    destinationId: entityIdSchema("note")
  }),
  z.strictObject({
    ...RoutingRuleMatchSnapshotFields,
    destinationKind: z.literal("space"),
    destinationId: entityIdSchema("spc")
  })
]);
export type RoutingRuleMatchSnapshot = z.infer<typeof RoutingRuleMatchSnapshotSchema>;

export const OrganizationPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  captureKind: CaptureKindSchema,
  decision: OrganizationDecisionSchema,
  destination: z.strictObject({
    candidateId: entityIdSchema("note").nullable(),
    newNote: z
      .strictObject({
        title: z.string().min(1).max(60),
        noteType: NoteTypeSchema,
        spaceCandidateId: entityIdSchema("spc").nullable()
      })
      .nullable()
  }),
  operations: z.array(ModelOperationSchema).max(5),
  generatedExpansion: z
    .strictObject({
      kind: z.enum(["summary", "interpretation", "suggestion", "label"]),
      text: z.string().min(1).max(600)
    })
    .nullable(),
  alternatives: z.array(entityIdSchema("note")).max(2),
  reasonCodes: z.array(AllowedReasonCodeSchema).max(5)
});

export type OrganizationPlan = z.infer<typeof OrganizationPlanSchema>;
