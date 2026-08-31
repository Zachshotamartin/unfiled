import {
  BehaviorBandSchema,
  CaptureReceiptActionSchema,
  CaptureReceiptDestinationSchema,
  CaptureReceiptOutcomeSchema,
  NoteSnapshotSchema,
  NoteStructuredDataSchema,
  NoteTypeSchema,
  OrganizationPlanSchema,
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

export const ReviewPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  choices: z.array(z.json()).max(100),
  state: ReviewStateSchema,
  resolution: JsonObjectSchema.nullable()
});
export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

export const RoutingRulePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  condition: z.string().trim().min(1).max(500),
  normalizedCondition: z.string().trim().min(1).max(500),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100)
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

export const CaptureReceiptPayloadSchema = z
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
    insertedContentReferences: z.array(CaptureReceiptContentReferenceSchema).max(500),
    actions: z.array(CaptureReceiptActionSchema).max(3),
    reasonCodes: z.array(ReceiptReasonCodeSchema).max(20),
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
