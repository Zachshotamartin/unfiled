import {
  BehaviorBandSchema,
  CAPTURE_ATTACHMENT_MAX_BYTES,
  CaptureAttachmentKindSchema,
  CaptureAttachmentMediaTypeSchema,
  MAX_CAPTURE_IMAGE_EDGE_PIXELS,
  MAX_CAPTURE_RECORDING_MS,
  CaptureReceiptActionSchema,
  CaptureReceiptDestinationSchema,
  CaptureReceiptOutcomeSchema,
  NoteSnapshotSchema,
  NoteStructuredDataSchema,
  NoteTypeSchema,
  OrganizationPlanSchema,
  ReviewProposalSchema,
  ReviewResolutionSchema,
  ReviewStateSchema,
  UserOperationSchema,
  entityIdSchema
} from "@unfiled/contracts";
import { z } from "zod";

const NonBlankCaptureContentSchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine((value) => value.trim().length > 0, "Capture cannot contain only whitespace");

const JsonObjectSchema = z.record(z.string(), z.json());
const HeadingSchema = z.string().min(1).max(200);

export const CapturePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rawContent: NonBlankCaptureContentSchema
});
export type CapturePayload = z.infer<typeof CapturePayloadSchema>;

export { CAPTURE_ATTACHMENT_MAX_BYTES };

const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/// Bytes decoded from standard base64 with no whitespace, or null when the text is not base64.
function decodedBase64Length(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0 || !STANDARD_BASE64.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

const CAPTURE_ATTACHMENT_MAX_BASE64_LENGTH = Math.ceil(CAPTURE_ATTACHMENT_MAX_BYTES / 3) * 4;

/// A photo or recording sealed beside its capture under the capture's key class. The bytes are
/// base64 because every sealed payload is canonical JSON; the byte length is bound to the data
/// so a truncated upload cannot pass as a complete one.
export const CaptureAttachmentPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    captureId: entityIdSchema("cap"),
    kind: CaptureAttachmentKindSchema,
    mediaType: CaptureAttachmentMediaTypeSchema,
    dataBase64: z.string().min(4).max(CAPTURE_ATTACHMENT_MAX_BASE64_LENGTH),
    byteLength: z.number().int().min(1).max(CAPTURE_ATTACHMENT_MAX_BYTES),
    width: z.number().int().min(1).max(MAX_CAPTURE_IMAGE_EDGE_PIXELS).optional(),
    height: z.number().int().min(1).max(MAX_CAPTURE_IMAGE_EDGE_PIXELS).optional(),
    durationMs: z.number().int().min(1).max(MAX_CAPTURE_RECORDING_MS).optional()
  })
  .superRefine((value, context) => {
    if (decodedBase64Length(value.dataBase64) !== value.byteLength) {
      context.addIssue({
        code: "custom",
        message: "Attachment byte length must match the encoded data",
        path: ["byteLength"]
      });
    }
    const image = value.kind === "image";
    if (image !== value.mediaType.startsWith("image/")) {
      context.addIssue({
        code: "custom",
        message: "Attachment media type must match its kind",
        path: ["mediaType"]
      });
    }
    if (
      image &&
      (value.width === undefined || value.height === undefined || value.durationMs !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Images carry width and height and no duration",
        path: ["width"]
      });
    }
    if (
      !image &&
      (value.durationMs === undefined || value.width !== undefined || value.height !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Recordings carry a duration and no dimensions",
        path: ["durationMs"]
      });
    }
  });
export type CaptureAttachmentPayload = z.infer<typeof CaptureAttachmentPayloadSchema>;

export const NoteContentPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(200_000),
  structuredData: NoteStructuredDataSchema
});
export type NoteContentPayload = z.infer<typeof NoteContentPayloadSchema>;

export const SpaceDisplayPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(60),
  slug: z.string().trim().min(1).max(80)
});
export type SpaceDisplayPayload = z.infer<typeof SpaceDisplayPayloadSchema>;

export const TagDisplayPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().trim().toLowerCase().min(1).max(40)
});
export type TagDisplayPayload = z.infer<typeof TagDisplayPayloadSchema>;

export const NoteRevisionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshot: NoteSnapshotSchema
});
export type NoteRevisionPayload = z.infer<typeof NoteRevisionPayloadSchema>;

const UpdateNoteMutationPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    action: z.literal("update"),
    beforeRevision: z.number().int().positive(),
    afterRevision: z.number().int().positive(),
    operations: z.array(UserOperationSchema).min(1).max(20),
    inverse: z.array(UserOperationSchema).min(1).max(20),
    beforeSnapshot: NoteSnapshotSchema,
    afterSnapshot: NoteSnapshotSchema
  })
  .refine(
    ({ beforeRevision, afterRevision }) => afterRevision === beforeRevision + 1,
    "Mutation revisions must be consecutive"
  );

const CreateNoteMutationPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal("create"),
  beforeRevision: z.literal(0),
  afterRevision: z.literal(1),
  operations: z.tuple([z.strictObject({ type: z.literal("create_note") })]),
  inverse: z.strictObject({ type: z.literal("soft_delete_created_note") }),
  beforeSnapshot: z.null(),
  afterSnapshot: NoteSnapshotSchema
});

export const NoteMutationPayloadSchema = z.discriminatedUnion("action", [
  CreateNoteMutationPayloadSchema,
  UpdateNoteMutationPayloadSchema
]);
export type NoteMutationPayload = z.infer<typeof NoteMutationPayloadSchema>;

export const OrganizationCandidateManifestItemSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  revision: z.number().int().positive(),
  title: z.string().min(1).max(200),
  noteType: NoteTypeSchema,
  spacePath: z.string().max(500),
  isOpen: z.boolean(),
  pinned: z.boolean(),
  headings: z.array(HeadingSchema).max(64),
  latestSnippet: z.string().max(2_000)
});
export type OrganizationCandidateManifestItem = z.infer<
  typeof OrganizationCandidateManifestItemSchema
>;

export const OrganizationDecisionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateManifest: z.strictObject({
    generationId: z.string().min(1).max(128).nullable(),
    candidates: z.array(OrganizationCandidateManifestItemSchema).max(50)
  }),
  signals: JsonObjectSchema,
  validatedPlan: OrganizationPlanSchema.nullable(),
  band: BehaviorBandSchema
});
export type OrganizationDecisionPayload = z.infer<typeof OrganizationDecisionPayloadSchema>;

export const GeneratedBlockPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  content: z.string().min(1).max(600)
});
export type GeneratedBlockPayload = z.infer<typeof GeneratedBlockPayloadSchema>;

export const ReviewPayloadV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  choices: z.array(z.json()).max(100),
  state: ReviewStateSchema,
  resolution: JsonObjectSchema.nullable()
});
export type ReviewPayloadV1 = z.infer<typeof ReviewPayloadV1Schema>;

export const ReviewPayloadV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    proposal: ReviewProposalSchema,
    state: ReviewStateSchema,
    resolution: ReviewResolutionSchema.nullable()
  })
  .superRefine(({ resolution, state }, context) => {
    if (state === "open" && resolution !== null) {
      context.addIssue({
        code: "custom",
        message: "An open Review proposal cannot have a resolution",
        path: ["resolution"]
      });
    }
    if (state === "resolved" && (resolution === null || resolution.type === "dismiss")) {
      context.addIssue({
        code: "custom",
        message: "A resolved Review proposal requires a non-dismiss resolution",
        path: ["resolution"]
      });
    }
    if (state === "dismissed" && resolution?.type !== "dismiss") {
      context.addIssue({
        code: "custom",
        message: "A dismissed Review proposal requires a dismiss resolution",
        path: ["resolution"]
      });
    }
  });
export type ReviewPayloadV2 = z.infer<typeof ReviewPayloadV2Schema>;

export const ReviewPayloadSchema = z.discriminatedUnion("schemaVersion", [
  ReviewPayloadV1Schema,
  ReviewPayloadV2Schema
]);
export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

export const RoutingRulePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  condition: z.string().min(1).max(500),
  normalizedCondition: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(200)).max(100)
});
export type RoutingRulePayload = z.infer<typeof RoutingRulePayloadSchema>;

export const OrganizationMutationAttemptPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operations: z.array(UserOperationSchema).min(1).max(20)
});
export type OrganizationMutationAttemptPayload = z.infer<
  typeof OrganizationMutationAttemptPayloadSchema
>;

const CaptureReceiptContentReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("captured"),
    itemId: z.union([entityIdSchema("itm"), entityIdSchema("ent")]).nullable()
  }),
  z.strictObject({
    type: z.literal("ai_generated"),
    blockId: entityIdSchema("blk")
  })
]);

const ReceiptReasonCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);

export const MAX_CAPTURE_RECEIPT_UNDO_TARGETS = 16;

export const CaptureReceiptUndoTargetSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  mutationId: entityIdSchema("mut"),
  expectedRevision: z.number().int().positive()
});
export type CaptureReceiptUndoTarget = z.infer<typeof CaptureReceiptUndoTargetSchema>;

const CaptureReceiptPayloadFields = {
  captureId: entityIdSchema("cap"),
  jobId: entityIdSchema("job"),
  decisionId: entityIdSchema("dec").nullable(),
  reviewItemId: entityIdSchema("rvw").nullable(),
  mutationId: entityIdSchema("mut").nullable(),
  outcome: CaptureReceiptOutcomeSchema,
  headline: z.string().min(1).max(240),
  destination: CaptureReceiptDestinationSchema.nullable(),
  insertedContentReferences: z.array(CaptureReceiptContentReferenceSchema).max(500),
  actions: z.array(CaptureReceiptActionSchema).max(3),
  reasonCodes: z.array(ReceiptReasonCodeSchema).max(20),
  createdAt: z.iso.datetime({ offset: true })
} as const;

const CaptureReceiptPayloadV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ...CaptureReceiptPayloadFields
});

const CaptureReceiptPayloadV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ...CaptureReceiptPayloadFields,
  undoTargets: z.array(CaptureReceiptUndoTargetSchema).max(MAX_CAPTURE_RECEIPT_UNDO_TARGETS)
});

export const CaptureReceiptPayloadSchema = z
  .discriminatedUnion("schemaVersion", [
    CaptureReceiptPayloadV1Schema,
    CaptureReceiptPayloadV2Schema
  ])
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
      if (
        (action.type === "open" || action.type === "move") &&
        action.noteId !== receipt.destination?.noteId
      ) {
        context.addIssue({
          code: "custom",
          message: "Receipt action must reference the persisted destination",
          path: ["actions", index, "noteId"]
        });
      }
      if (
        action.type === "move" &&
        (receipt.decisionId === null || action.decisionId !== receipt.decisionId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Move action must reference the persisted routing decision",
          path: ["actions", index, "decisionId"]
        });
      }
      if (
        action.type === "undo" &&
        (receipt.mutationId === null || action.mutationId !== receipt.mutationId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Receipt action must reference the persisted mutation",
          path: ["actions", index, "mutationId"]
        });
      }
    }

    const routed = receipt.outcome === "created_note" || receipt.outcome === "added_to_note";
    if (routed) {
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
      if (receipt.insertedContentReferences.length === 0) {
        context.addIssue({
          code: "custom",
          message: "A routed receipt requires persisted inserted content",
          path: ["insertedContentReferences"]
        });
      }
      if (receipt.schemaVersion === 2) {
        const undo = receipt.actions.find((action) => action.type === "undo");
        const hasUserUndoReason = receipt.reasonCodes.includes("user_undo");
        const terminalUndoReceipt =
          receipt.outcome === "added_to_note" &&
          receipt.reasonCodes.length === 1 &&
          receipt.reasonCodes[0] === "user_undo" &&
          receipt.actions.length === 2 &&
          receipt.actions.some((action) => action.type === "open") &&
          receipt.actions.some((action) => action.type === "move");
        if (hasUserUndoReason && !terminalUndoReceipt) {
          context.addIssue({
            code: "custom",
            message: "A user-undo receipt must use the exact restored-route shape",
            path: ["reasonCodes"]
          });
        }
        if (terminalUndoReceipt) {
          if (undo !== undefined || receipt.undoTargets.length > 0) {
            context.addIssue({
              code: "custom",
              message: "A restored route cannot advertise undo-of-undo authority",
              path: ["undoTargets"]
            });
          }
        } else if (receipt.undoTargets.length === 0) {
          context.addIssue({
            code: "custom",
            message: "A routed v2 receipt requires authenticated undo targets",
            path: ["undoTargets"]
          });
        } else {
          const primary = receipt.undoTargets.find(
            (target) =>
              target.noteId === receipt.destination?.noteId &&
              target.mutationId === receipt.mutationId
          );
          if (
            primary === undefined ||
            undo?.mutationId !== primary.mutationId ||
            undo.expectedRevision !== primary.expectedRevision
          ) {
            context.addIssue({
              code: "custom",
              message: "The primary undo action must match an authenticated v2 undo target",
              path: ["undoTargets"]
            });
          }
        }
      }
    } else {
      if (receipt.destination !== null || receipt.mutationId !== null) {
        context.addIssue({
          code: "custom",
          message: "A non-routed receipt cannot claim a destination or mutation",
          path: ["destination"]
        });
      }
      if (receipt.insertedContentReferences.length > 0 || receipt.actions.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A non-routed receipt cannot expose unpersisted effects or actions",
          path: ["actions"]
        });
      }
      if (receipt.schemaVersion === 2 && receipt.undoTargets.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A non-routed receipt cannot expose undo targets",
          path: ["undoTargets"]
        });
      }
    }
    if (receipt.schemaVersion === 2) {
      const mutationIds = new Set<string>();
      let previousNoteId: string | null = null;
      for (const [index, target] of receipt.undoTargets.entries()) {
        if (previousNoteId !== null && previousNoteId >= target.noteId) {
          context.addIssue({
            code: "custom",
            message: "Undo targets must be strictly ordered by note ID",
            path: ["undoTargets", index, "noteId"]
          });
        }
        previousNoteId = target.noteId;
        if (mutationIds.has(target.mutationId)) {
          context.addIssue({
            code: "custom",
            message: "Undo target mutations must be unique",
            path: ["undoTargets", index, "mutationId"]
          });
        }
        mutationIds.add(target.mutationId);
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
export type CaptureReceiptPayload = z.infer<typeof CaptureReceiptPayloadSchema>;

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

export type PayloadCodec<Value> = Readonly<{
  parse(value: unknown): Value;
}>;

export function jsonPayloadCodec<Value extends JsonValue>(): PayloadCodec<Value> {
  return Object.freeze({
    parse(value: unknown): Value {
      return z.json().parse(value) as Value;
    }
  });
}
