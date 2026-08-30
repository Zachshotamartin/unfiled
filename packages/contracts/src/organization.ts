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
