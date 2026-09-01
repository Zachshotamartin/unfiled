import { z } from "zod";

import { NoteTypeSchema, ReviewStateSchema, ReviewTypeSchema } from "./enums.js";
import { ApiErrorCodeSchema } from "./errors.js";
import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { OrganizationPlanSchema } from "./organization.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

export const ReviewProposalNoteSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  revision: ExpectedRevisionSchema
});
export type ReviewProposalNote = z.infer<typeof ReviewProposalNoteSchema>;

const DuplicateReviewNotesSchema = z
  .array(ReviewProposalNoteSchema)
  .min(2)
  .max(3)
  .superRefine((notes, context) => {
    const noteIds = new Set<string>();
    for (const [index, note] of notes.entries()) {
      if (noteIds.has(note.noteId)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate-note proposals must contain distinct notes",
          path: [index, "noteId"]
        });
      }
      noteIds.add(note.noteId);
    }
  });

export const ReviewProposalSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("route_capture"),
    plan: OrganizationPlanSchema
  }),
  z.strictObject({
    type: z.literal("generated_block"),
    blockId: entityIdSchema("blk")
  }),
  z.strictObject({
    type: z.literal("duplicate_notes"),
    notes: DuplicateReviewNotesSchema
  }),
  z.strictObject({
    type: z.literal("conflict"),
    reason: z.enum(["revision", "candidate_eligibility", "consent_controls", "structure"])
  }),
  z.strictObject({
    type: z.literal("failed_job"),
    errorCode: ApiErrorCodeSchema
  })
]);
export type ReviewProposal = z.infer<typeof ReviewProposalSchema>;

export const ReviewResolutionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("route"),
    noteId: entityIdSchema("note"),
    expectedRevision: ExpectedRevisionSchema
  }),
  z.strictObject({
    type: z.literal("create"),
    title: z.string().trim().min(1).max(200),
    noteType: NoteTypeSchema,
    spaceId: entityIdSchema("spc").nullable()
  }),
  z.strictObject({ type: z.literal("keep_inbox") }),
  z.strictObject({ type: z.literal("dismiss") }),
  z.strictObject({ type: z.literal("keep_both") }),
  z.strictObject({ type: z.literal("accept_expansion") }),
  z.strictObject({ type: z.literal("reject_expansion") })
]);
export type ReviewResolution = z.infer<typeof ReviewResolutionSchema>;

/**
 * Frozen Review semantics. The public Review type is operational metadata, so
 * it must agree with the authenticated proposal before the pair is trusted:
 *
 * - low confidence -> route proposal
 * - revision conflict -> revision conflict proposal
 * - failed job -> failed-job proposal
 * - duplicate suggestion -> duplicate-notes proposal
 * - pending expansion -> generated block, or D's temporary consent hold
 * - structure conflict -> candidate-eligibility or structure conflict
 *
 * Dismiss is the only resolution shared by every type. Routing, revision, and
 * structure items otherwise permit route/create/keep-inbox; failed jobs permit
 * keep-inbox only; duplicates permit keep-both; persisted expansions permit
 * accept/reject. Operational route/create availability additionally requires
 * server-validated receipt and decision lineage and is not implied by type.
 *
 * The consent hold is intentionally resolution-inert until E3 persists a
 * generated block. It may remain open or be dismissed, but it cannot accept or
 * reject expansion without an authenticated generated-block identifier.
 */
export function reviewProposalMatchesType(
  type: z.infer<typeof ReviewTypeSchema>,
  proposal: ReviewProposal
): boolean {
  switch (type) {
    case "low_confidence":
      return proposal.type === "route_capture";
    case "revision_conflict":
      return proposal.type === "conflict" && proposal.reason === "revision";
    case "failed_job":
      return proposal.type === "failed_job";
    case "duplicate_suggestion":
      return proposal.type === "duplicate_notes";
    case "pending_expansion":
      return (
        proposal.type === "generated_block" ||
        (proposal.type === "conflict" && proposal.reason === "consent_controls")
      );
    case "structure_conflict":
      return (
        proposal.type === "conflict" &&
        (proposal.reason === "candidate_eligibility" || proposal.reason === "structure")
      );
  }
}

export function reviewResolutionMatchesSemantics(
  type: z.infer<typeof ReviewTypeSchema>,
  proposal: ReviewProposal,
  resolution: ReviewResolution | null
): boolean {
  if (!reviewProposalMatchesType(type, proposal)) return false;
  if (resolution === null || resolution.type === "dismiss") return true;

  switch (type) {
    case "duplicate_suggestion":
      return resolution.type === "keep_both";
    case "pending_expansion":
      return (
        proposal.type === "generated_block" &&
        (resolution.type === "accept_expansion" || resolution.type === "reject_expansion")
      );
    case "failed_job":
      return resolution.type === "keep_inbox";
    case "low_confidence":
    case "revision_conflict":
    case "structure_conflict":
      return (
        resolution.type === "route" ||
        resolution.type === "create" ||
        resolution.type === "keep_inbox"
      );
  }
}

export const ReviewItemDtoSchema = z
  .strictObject({
    id: entityIdSchema("rvw"),
    captureId: entityIdSchema("cap").nullable(),
    noteId: entityIdSchema("note").nullable(),
    type: ReviewTypeSchema,
    proposal: ReviewProposalSchema,
    state: ReviewStateSchema,
    resolution: ReviewResolutionSchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    resolvedAt: z.iso.datetime({ offset: true }).nullable()
  })
  .superRefine((item, context) => {
    if (!reviewProposalMatchesType(item.type, item.proposal)) {
      context.addIssue({
        code: "custom",
        message: "Review type and proposal do not agree",
        path: ["proposal"]
      });
    } else if (!reviewResolutionMatchesSemantics(item.type, item.proposal, item.resolution)) {
      context.addIssue({
        code: "custom",
        message: "Review proposal and resolution do not agree",
        path: ["resolution"]
      });
    }
    if (item.state === "open" && (item.resolution !== null || item.resolvedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "An open Review item cannot have a resolution",
        path: ["resolution"]
      });
    }
    if (
      item.state === "resolved" &&
      (item.resolution === null || item.resolution.type === "dismiss" || item.resolvedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A resolved Review item requires a non-dismiss resolution and timestamp",
        path: ["resolution"]
      });
    }
    if (
      item.state === "dismissed" &&
      (item.resolution?.type !== "dismiss" || item.resolvedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A dismissed Review item requires the dismiss resolution and timestamp",
        path: ["resolution"]
      });
    }
  });
export type ReviewItemDto = z.infer<typeof ReviewItemDtoSchema>;

export const ReviewItemListQuerySchema = z.strictObject({
  state: ReviewStateSchema.default("open"),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export type ReviewItemListQuery = z.infer<typeof ReviewItemListQuerySchema>;

export const ListReviewItemsResponseSchema = z.strictObject({
  items: z.array(ReviewItemDtoSchema),
  pageInfo: PageInfoSchema
});
export type ListReviewItemsResponse = z.infer<typeof ListReviewItemsResponseSchema>;

export const ReviewResolveRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  resolution: ReviewResolutionSchema
});
export type ReviewResolveRequest = z.infer<typeof ReviewResolveRequestSchema>;

export const ReviewResolveResponseSchema = z.strictObject({
  reviewItem: ReviewItemDtoSchema,
  replayed: z.boolean()
});
export type ReviewResolveResponse = z.infer<typeof ReviewResolveResponseSchema>;
