import { z } from "zod";

import { CaptureSourceSchema, PrivacyModeSchema } from "./enums.js";
import { ApiErrorCodeSchema } from "./errors.js";
import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

const CaptureContentSchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine((value) => value.trim().length > 0, "Capture cannot contain only whitespace");

const CapturePreviewSchema = z
  .string()
  .min(1)
  .max(280)
  .refine((value) => value.trim().length > 0, "Capture preview cannot be blank");

const CaptureQueryLimitSchema = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/u, "Use a base-ten integer")
      .transform(Number)
  ])
  .pipe(z.number().int().min(1).max(100))
  .default(30);

const ReasonCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, "Use a stable snake-case reason code");

export const CaptureProcessingStateSchema = z.enum([
  "queued",
  "processing",
  "done",
  "needs_review",
  "failed",
  "inbox"
]);
export type CaptureProcessingState = z.infer<typeof CaptureProcessingStateSchema>;

/** The owner's directions for one capture: where to file it or how to shape it. Never note text. */
export const CaptureGuidanceSchema = z.string().trim().min(1).max(500);

export const CaptureCreateRequestSchema = z.strictObject({
  clientCaptureId: entityIdSchema("cap"),
  rawContent: CaptureContentSchema,
  source: CaptureSourceSchema,
  deviceId: z.string().max(120).optional(),
  clientCreatedAt: z.iso.datetime({ offset: true }),
  clientTimezone: z.string().min(1).max(100),
  privacy: PrivacyModeSchema.default("ai_assisted"),
  explicitDestinationNoteId: entityIdSchema("note").optional(),
  expansionDisabled: z.boolean().default(false),
  guidance: CaptureGuidanceSchema.nullable().optional()
});
export type CaptureCreateRequest = z.input<typeof CaptureCreateRequestSchema>;

export const CaptureSchema = z.strictObject({
  id: entityIdSchema("cap"),
  rawContent: CaptureContentSchema,
  source: CaptureSourceSchema,
  deviceId: z.string().max(120),
  privacy: PrivacyModeSchema,
  explicitDestinationNoteId: entityIdSchema("note").nullable(),
  expansionDisabled: z.boolean(),
  clientCreatedAt: z.iso.datetime({ offset: true }),
  clientTimezone: z.string().min(1).max(100),
  receivedAt: z.iso.datetime({ offset: true }),
  status: CaptureProcessingStateSchema,
  lastErrorCode: ApiErrorCodeSchema.nullable()
});
export type Capture = z.infer<typeof CaptureSchema>;

export const CaptureSummarySchema = z
  .strictObject({
    id: entityIdSchema("cap"),
    jobId: entityIdSchema("job"),
    rawContentPreview: CapturePreviewSchema,
    source: CaptureSourceSchema,
    privacy: PrivacyModeSchema,
    clientCreatedAt: z.iso.datetime({ offset: true }),
    receivedAt: z.iso.datetime({ offset: true }),
    status: CaptureProcessingStateSchema,
    lastErrorCode: ApiErrorCodeSchema.nullable(),
    receiptAvailable: z.boolean()
  })
  .superRefine((capture, context) => {
    const isTerminal = capture.status !== "queued" && capture.status !== "processing";
    // A failed job records its error code without an organization receipt unless a later
    // organizer run produced one, so either value is consistent for a failed capture.
    const receiptOptional = capture.status === "failed";
    if (!receiptOptional && capture.receiptAvailable !== isTerminal) {
      context.addIssue({
        code: "custom",
        message: "Receipt availability must match the terminal processing state",
        path: ["receiptAvailable"]
      });
    }
  });
export type CaptureSummary = z.infer<typeof CaptureSummarySchema>;

export const CaptureListQuerySchema = z
  .strictObject({
    cursor: CursorSchema.optional(),
    limit: CaptureQueryLimitSchema,
    status: CaptureProcessingStateSchema.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional()
  })
  .superRefine(({ from, to }, context) => {
    if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) {
      context.addIssue({
        code: "custom",
        message: "from must be earlier than to",
        path: ["from"]
      });
    }
  });
export type CaptureListQuery = z.infer<typeof CaptureListQuerySchema>;

export const CaptureListResponseSchema = z.strictObject({
  items: z.array(CaptureSummarySchema),
  pageInfo: PageInfoSchema
});
export type CaptureListResponse = z.infer<typeof CaptureListResponseSchema>;

export const CaptureReceiptOutcomeSchema = z.enum([
  "created_note",
  "added_to_note",
  "kept_in_inbox",
  "needs_review",
  "failed"
]);
export type CaptureReceiptOutcome = z.infer<typeof CaptureReceiptOutcomeSchema>;

export const CaptureReceiptDestinationSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  title: z.string().min(1).max(200)
});
export type CaptureReceiptDestination = z.infer<typeof CaptureReceiptDestinationSchema>;

const CapturedReceiptContentSchema = z.strictObject({
  type: z.literal("captured"),
  itemId: z.union([entityIdSchema("itm"), entityIdSchema("ent")]).nullable(),
  content: CaptureContentSchema
});

const AiGeneratedReceiptContentSchema = z.strictObject({
  type: z.literal("ai_generated"),
  blockId: entityIdSchema("blk"),
  content: z.string().min(1).max(600)
});

export const CaptureReceiptContentSchema = z.discriminatedUnion("type", [
  CapturedReceiptContentSchema,
  AiGeneratedReceiptContentSchema
]);
export type CaptureReceiptContent = z.infer<typeof CaptureReceiptContentSchema>;

const CaptureReceiptOpenActionSchema = z.strictObject({
  type: z.literal("open"),
  noteId: entityIdSchema("note")
});

const CaptureReceiptMoveActionSchema = z.strictObject({
  type: z.literal("move"),
  noteId: entityIdSchema("note"),
  decisionId: entityIdSchema("dec")
});

const CaptureReceiptUndoActionSchema = z.strictObject({
  type: z.literal("undo"),
  mutationId: entityIdSchema("mut"),
  expectedRevision: ExpectedRevisionSchema
});

export const CaptureReceiptActionSchema = z.discriminatedUnion("type", [
  CaptureReceiptOpenActionSchema,
  CaptureReceiptMoveActionSchema,
  CaptureReceiptUndoActionSchema
]);
export type CaptureReceiptAction = z.infer<typeof CaptureReceiptActionSchema>;

export const CaptureReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    captureId: entityIdSchema("cap"),
    jobId: entityIdSchema("job"),
    decisionId: entityIdSchema("dec").nullable(),
    reviewItemId: entityIdSchema("rvw").nullable(),
    mutationId: entityIdSchema("mut").nullable(),
    outcome: CaptureReceiptOutcomeSchema,
    headline: z.string().min(1).max(240),
    destination: CaptureReceiptDestinationSchema.nullable(),
    insertedContent: z.array(CaptureReceiptContentSchema).max(500),
    actions: z.array(CaptureReceiptActionSchema).max(3),
    reasonCodes: z.array(ReasonCodeSchema).max(20),
    createdAt: z.iso.datetime({ offset: true })
  })
  .superRefine((receipt, context) => {
    const actionTypes = new Set<string>();
    for (const [index, action] of receipt.actions.entries()) {
      if (actionTypes.has(action.type)) {
        context.addIssue({
          code: "custom",
          message: "Receipt action types must be unique",
          path: ["actions", index, "type"]
        });
      }
      actionTypes.add(action.type);
      if (action.type === "open" || action.type === "move") {
        if (action.noteId !== receipt.destination?.noteId) {
          context.addIssue({
            code: "custom",
            message: "Receipt action must reference the persisted destination",
            path: ["actions", index, "noteId"]
          });
        }
      }
      if (action.type === "move") {
        if (receipt.decisionId === null || action.decisionId !== receipt.decisionId) {
          context.addIssue({
            code: "custom",
            message: "Move action must reference the persisted routing decision",
            path: ["actions", index, "decisionId"]
          });
        }
      }
      if (action.type === "undo") {
        if (receipt.mutationId === null || action.mutationId !== receipt.mutationId) {
          context.addIssue({
            code: "custom",
            message: "Receipt action must reference the persisted mutation",
            path: ["actions", index, "mutationId"]
          });
        }
      }
    }

    if (receipt.outcome === "created_note" || receipt.outcome === "added_to_note") {
      if (receipt.destination === null) {
        context.addIssue({
          code: "custom",
          message: "A routed receipt requires a persisted destination",
          path: ["destination"]
        });
      }
      if (receipt.mutationId === null) {
        context.addIssue({
          code: "custom",
          message: "A routed receipt requires a persisted mutation",
          path: ["mutationId"]
        });
      }
      if (receipt.decisionId === null) {
        context.addIssue({
          code: "custom",
          message: "A routed receipt requires a persisted routing decision",
          path: ["decisionId"]
        });
      }
      if (receipt.insertedContent.length === 0) {
        context.addIssue({
          code: "custom",
          message: "A routed receipt requires persisted inserted content",
          path: ["insertedContent"]
        });
      }
    } else {
      if (receipt.destination !== null || receipt.mutationId !== null) {
        context.addIssue({
          code: "custom",
          message: "A non-routed receipt cannot claim a destination or mutation",
          path: ["destination"]
        });
      }
      if (receipt.insertedContent.length > 0 || receipt.actions.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A non-routed receipt cannot expose unpersisted effects or actions",
          path: ["actions"]
        });
      }
    }
    if (receipt.outcome === "needs_review" && receipt.reviewItemId === null) {
      context.addIssue({
        code: "custom",
        message: "A review receipt requires a persisted Review item",
        path: ["reviewItemId"]
      });
    }
  });
export type CaptureReceipt = z.infer<typeof CaptureReceiptSchema>;

export const CaptureDetailSchema = CaptureSchema.extend({
  jobId: entityIdSchema("job"),
  receipt: CaptureReceiptSchema.nullable()
}).superRefine((capture, context) => {
  if (
    capture.receipt !== null &&
    (capture.receipt.captureId !== capture.id || capture.receipt.jobId !== capture.jobId)
  ) {
    context.addIssue({
      code: "custom",
      message: "Embedded receipt must belong to this capture and job",
      path: ["receipt"]
    });
  }
  const expectedOutcomeByState = {
    done: ["created_note", "added_to_note"],
    failed: ["failed"],
    inbox: ["kept_in_inbox"],
    needs_review: ["needs_review"]
  } as const satisfies Record<
    Exclude<CaptureProcessingState, "queued" | "processing">,
    readonly CaptureReceiptOutcome[]
  >;
  if (capture.status === "queued" || capture.status === "processing") {
    if (capture.receipt !== null) {
      context.addIssue({
        code: "custom",
        message: "A non-terminal capture cannot expose a receipt",
        path: ["receipt"]
      });
    }
    return;
  }
  const expectedOutcomes = expectedOutcomeByState[capture.status];
  // A failed job may carry no receipt: the organizer records the error code without one.
  if (capture.receipt === null && capture.status === "failed") return;
  if (
    capture.receipt === null ||
    !expectedOutcomes.some((outcome) => outcome === capture.receipt?.outcome)
  ) {
    context.addIssue({
      code: "custom",
      message: "A terminal capture requires a receipt matching its processing state",
      path: ["receipt"]
    });
  }
});
export type CaptureDetail = z.infer<typeof CaptureDetailSchema>;

export const CaptureDetailResponseSchema = z.strictObject({ capture: CaptureDetailSchema });
export type CaptureDetailResponse = z.infer<typeof CaptureDetailResponseSchema>;

export const CaptureReceiptResponseSchema = z.strictObject({ receipt: CaptureReceiptSchema });
export type CaptureReceiptResponse = z.infer<typeof CaptureReceiptResponseSchema>;

const AcceptedCaptureSchema = CaptureSchema.extend({
  lastErrorCode: z.null(),
  status: z.literal("queued")
});

export const CaptureCreateResponseSchema = z.strictObject({
  capture: AcceptedCaptureSchema,
  jobId: entityIdSchema("job"),
  replayed: z.boolean()
});
export type CaptureCreateResponse = z.infer<typeof CaptureCreateResponseSchema>;

export const CaptureRetryRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema
});
export type CaptureRetryRequest = z.infer<typeof CaptureRetryRequestSchema>;

export const CaptureRetryResponseSchema = CaptureCreateResponseSchema;
export type CaptureRetryResponse = z.infer<typeof CaptureRetryResponseSchema>;

export const CaptureExpectedNoteRevisionSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  expectedRevision: ExpectedRevisionSchema
});
export type CaptureExpectedNoteRevision = z.infer<typeof CaptureExpectedNoteRevisionSchema>;

export const CaptureDeleteRequestSchema = z
  .strictObject({
    idempotencyKey: IdempotencyKeySchema,
    removeInsertedContent: z.boolean().default(false),
    expectedNoteRevisions: z.array(CaptureExpectedNoteRevisionSchema).max(100).default([])
  })
  .superRefine((request, context) => {
    if (request.removeInsertedContent && request.expectedNoteRevisions.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Removing inserted content requires current note revisions",
        path: ["expectedNoteRevisions"]
      });
    }
    if (!request.removeInsertedContent && request.expectedNoteRevisions.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Note revisions are only accepted when removing inserted content",
        path: ["expectedNoteRevisions"]
      });
    }
    const noteIds = new Set<string>();
    for (const [index, revision] of request.expectedNoteRevisions.entries()) {
      if (noteIds.has(revision.noteId)) {
        context.addIssue({
          code: "custom",
          message: "Expected note revisions must be unique",
          path: ["expectedNoteRevisions", index, "noteId"]
        });
      }
      noteIds.add(revision.noteId);
    }
  });
export type CaptureDeleteRequest = z.input<typeof CaptureDeleteRequestSchema>;

export const CaptureContentRemovalMutationSchema = z.strictObject({
  mutationId: entityIdSchema("mut"),
  noteId: entityIdSchema("note"),
  expectedRevision: ExpectedRevisionSchema
});
export type CaptureContentRemovalMutation = z.infer<typeof CaptureContentRemovalMutationSchema>;

export const CaptureDeleteResponseSchema = z
  .strictObject({
    captureId: entityIdSchema("cap"),
    deletedAt: z.iso.datetime({ offset: true }),
    sourceRemovedFromNoteIds: z.array(entityIdSchema("note")).max(100),
    removedInsertedContent: z.boolean(),
    contentRemovalMutations: z.array(CaptureContentRemovalMutationSchema).max(100),
    replayed: z.boolean()
  })
  .superRefine((response, context) => {
    if (response.removedInsertedContent !== response.contentRemovalMutations.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Content removal must be backed by persisted mutations",
        path: ["contentRemovalMutations"]
      });
    }
    if (
      new Set(response.sourceRemovedFromNoteIds).size !== response.sourceRemovedFromNoteIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Persisted identifiers must be unique",
        path: ["sourceRemovedFromNoteIds"]
      });
    }
    const mutationIds = new Set<string>();
    const mutationNoteIds = new Set<string>();
    for (const [index, mutation] of response.contentRemovalMutations.entries()) {
      if (mutationIds.has(mutation.mutationId) || mutationNoteIds.has(mutation.noteId)) {
        context.addIssue({
          code: "custom",
          message: "Content removal mutations must have unique mutation and note identifiers",
          path: ["contentRemovalMutations", index]
        });
      }
      if (!response.sourceRemovedFromNoteIds.includes(mutation.noteId)) {
        context.addIssue({
          code: "custom",
          message: "A content removal mutation must reference a source-removed note",
          path: ["contentRemovalMutations", index, "noteId"]
        });
      }
      mutationIds.add(mutation.mutationId);
      mutationNoteIds.add(mutation.noteId);
    }
  });
export type CaptureDeleteResponse = z.infer<typeof CaptureDeleteResponseSchema>;
