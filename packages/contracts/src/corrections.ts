import { z } from "zod";

import { NoteTypeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";

export const CorrectionSourceSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  expectedRevision: ExpectedRevisionSchema
});
export type CorrectionSource = z.infer<typeof CorrectionSourceSchema>;

export const CorrectionExistingNoteDestinationSchema = z.strictObject({
  type: z.literal("existing_note"),
  noteId: entityIdSchema("note"),
  expectedRevision: ExpectedRevisionSchema
});
export type CorrectionExistingNoteDestination = z.infer<
  typeof CorrectionExistingNoteDestinationSchema
>;

export const CorrectionNewNoteDestinationSchema = z.strictObject({
  type: z.literal("new_note"),
  title: z.string().trim().min(1).max(200),
  noteType: NoteTypeSchema,
  spaceId: entityIdSchema("spc").nullable()
});
export type CorrectionNewNoteDestination = z.infer<typeof CorrectionNewNoteDestinationSchema>;

export const CorrectionDestinationSchema = z.discriminatedUnion("type", [
  CorrectionExistingNoteDestinationSchema,
  CorrectionNewNoteDestinationSchema
]);
export type CorrectionDestination = z.infer<typeof CorrectionDestinationSchema>;

export const DecisionCorrectionRequestSchema = z
  .strictObject({
    idempotencyKey: IdempotencyKeySchema,
    source: CorrectionSourceSchema,
    destination: CorrectionDestinationSchema
  })
  .superRefine((request, context) => {
    if (
      request.destination.type === "existing_note" &&
      request.destination.noteId === request.source.noteId
    ) {
      context.addIssue({
        code: "custom",
        message: "A correction must choose a different destination note",
        path: ["destination", "noteId"]
      });
    }
  });
export type DecisionCorrectionRequest = z.infer<typeof DecisionCorrectionRequestSchema>;

export const CorrectionAppliedNoteSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  currentRevision: ExpectedRevisionSchema,
  mutationId: entityIdSchema("mut")
});
export type CorrectionAppliedNote = z.infer<typeof CorrectionAppliedNoteSchema>;

export const CorrectionAppliedDestinationSchema = z.discriminatedUnion("type", [
  CorrectionAppliedNoteSchema.extend({ type: z.literal("existing_note") }),
  CorrectionAppliedNoteSchema.extend({ type: z.literal("new_note") })
]);
export type CorrectionAppliedDestination = z.infer<typeof CorrectionAppliedDestinationSchema>;

export const DecisionCorrectionAppliedResponseSchema = z
  .strictObject({
    outcome: z.literal("applied"),
    decisionId: entityIdSchema("dec"),
    source: CorrectionAppliedNoteSchema,
    destination: CorrectionAppliedDestinationSchema,
    replayed: z.boolean()
  })
  .superRefine((response, context) => {
    if (response.source.noteId === response.destination.noteId) {
      context.addIssue({
        code: "custom",
        message: "A correction response must contain distinct source and destination notes",
        path: ["destination", "noteId"]
      });
    }
    if (response.source.mutationId === response.destination.mutationId) {
      context.addIssue({
        code: "custom",
        message: "Each corrected note must have its own persisted mutation",
        path: ["destination", "mutationId"]
      });
    }
  });
export type DecisionCorrectionAppliedResponse = z.infer<
  typeof DecisionCorrectionAppliedResponseSchema
>;

export const DecisionCorrectionNeedsReviewResponseSchema = z.strictObject({
  outcome: z.literal("needs_review"),
  decisionId: entityIdSchema("dec"),
  reviewItemId: entityIdSchema("rvw"),
  reasonCode: z.literal("exact_inverse_unavailable"),
  replayed: z.boolean()
});
export type DecisionCorrectionNeedsReviewResponse = z.infer<
  typeof DecisionCorrectionNeedsReviewResponseSchema
>;

export const DecisionCorrectionResponseSchema = z.discriminatedUnion("outcome", [
  DecisionCorrectionAppliedResponseSchema,
  DecisionCorrectionNeedsReviewResponseSchema
]);
export type DecisionCorrectionResponse = z.infer<typeof DecisionCorrectionResponseSchema>;
