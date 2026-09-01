import { z } from "zod";

import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";
import { PageInfoSchema } from "./pagination.js";

export const RoutingRuleTypeSchema = z.enum(["prefix", "phrase", "alias", "destination_mention"]);
export type RoutingRuleType = z.infer<typeof RoutingRuleTypeSchema>;

export const RoutingRuleSourceSchema = z.enum(["explicit", "correction_suggested"]);
export type RoutingRuleSource = z.infer<typeof RoutingRuleSourceSchema>;

export const RoutingRuleProposalStateSchema = z.enum(["offered", "accepted"]).nullable();
export type RoutingRuleProposalState = z.infer<typeof RoutingRuleProposalStateSchema>;

export const RoutingRuleDestinationStatusSchema = z.enum([
  "active",
  "archived",
  "deleted",
  "missing"
]);
export type RoutingRuleDestinationStatus = z.infer<typeof RoutingRuleDestinationStatusSchema>;

export const MAX_ACTIVE_ROUTING_RULES = 256;
export const MAX_RETAINED_ROUTING_RULES = 1_000;
export const MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES = 8 * 1024 * 1024;
export const ROUTING_RULE_PAGE_SIZE = 50;
export const MAX_ROUTING_RULE_PAGE_BYTES = 8 * 1024 * 1024;

const ROUTING_RULE_TRAILING_DECORATION = /(?:\p{P}|\p{White_Space})+$/gu;
const ROUTING_RULE_WHITESPACE = /\p{White_Space}+/gu;
const ROUTING_RULE_EDGE_WHITESPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Canonical condition form shared by validation, matching, and encrypted storage. */
export function normalizeRoutingRuleCondition(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(ROUTING_RULE_WHITESPACE, " ")
    .replace(/^ +| +$/gu, "")
    .replace(ROUTING_RULE_TRAILING_DECORATION, "");
}

/** Removes only the frozen Unicode White_Space set from request-display edges. */
export function prepareRoutingRuleCondition(value: string): string {
  return value.replace(ROUTING_RULE_EDGE_WHITESPACE, "");
}

function validRoutingRuleCondition(value: string): boolean {
  const length = normalizeRoutingRuleCondition(value).length;
  return length >= 1 && length <= 500;
}

const RoutingRuleConditionSchema = z
  .string()
  .max(500)
  .transform(prepareRoutingRuleCondition)
  .refine(validRoutingRuleCondition, {
    message: "A canonical routing-rule condition must contain 1 to 500 UTF-16 code units"
  });

export const RoutingRuleDestinationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("note"), noteId: entityIdSchema("note") }),
  z.strictObject({ type: z.literal("space"), spaceId: entityIdSchema("spc") })
]);
export type RoutingRuleDestination = z.infer<typeof RoutingRuleDestinationSchema>;

const RoutingRuleEditableFields = {
  enabled: z.boolean(),
  ruleType: RoutingRuleTypeSchema,
  condition: RoutingRuleConditionSchema,
  destination: RoutingRuleDestinationSchema,
  priority: z.number().int().min(0).max(10_000)
} as const;

export const RoutingRuleDtoSchema = z
  .strictObject({
    id: entityIdSchema("rule"),
    revision: ExpectedRevisionSchema,
    ...RoutingRuleEditableFields,
    normalizedCondition: z.string().min(1).max(500),
    aliases: z.array(z.string().min(1).max(200)).max(100),
    source: RoutingRuleSourceSchema,
    proposalState: RoutingRuleProposalStateSchema,
    destinationStatus: RoutingRuleDestinationStatusSchema,
    lastFiredAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .superRefine((rule, context) => {
    if (normalizeRoutingRuleCondition(rule.condition) !== rule.normalizedCondition) {
      context.addIssue({
        code: "custom",
        message: "The normalized condition must use canonical routing-rule normalization",
        path: ["normalizedCondition"]
      });
    }

    if (rule.source === "explicit" && rule.proposalState !== null) {
      context.addIssue({
        code: "custom",
        message: "Explicit routing rules cannot have a learned-rule proposal state",
        path: ["proposalState"]
      });
      return;
    }

    if (rule.source === "correction_suggested" && rule.proposalState === null) {
      context.addIssue({
        code: "custom",
        message: "Learned routing rules require an owner-visible proposal state",
        path: ["proposalState"]
      });
      return;
    }

    if (rule.proposalState === "offered" && rule.enabled) {
      context.addIssue({
        code: "custom",
        message: "An offered routing rule remains disabled until owner confirmation",
        path: ["enabled"]
      });
    }
  });
export type RoutingRuleDto = z.infer<typeof RoutingRuleDtoSchema>;

export const RoutingRuleListQuerySchema = z.strictObject({
  cursor: entityIdSchema("rule").optional()
});
export type RoutingRuleListQuery = z.infer<typeof RoutingRuleListQuerySchema>;

export const RoutingRuleListResponseSchema = z
  .strictObject({
    items: z.array(RoutingRuleDtoSchema).max(ROUTING_RULE_PAGE_SIZE),
    pageInfo: PageInfoSchema
  })
  .superRefine(({ items, pageInfo }, context) => {
    if (pageInfo.hasMore !== (pageInfo.nextCursor !== null)) {
      context.addIssue({
        code: "custom",
        message: "Routing-rule pagination state is inconsistent",
        path: ["pageInfo"]
      });
    }
    if (
      pageInfo.hasMore &&
      (items.length !== ROUTING_RULE_PAGE_SIZE || pageInfo.nextCursor !== items.at(-1)?.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "A continuing routing-rule page must be full and cursor-bound",
        path: ["pageInfo", "nextCursor"]
      });
    }
  });
export type RoutingRuleListResponse = z.infer<typeof RoutingRuleListResponseSchema>;

export const RoutingRuleCreateRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  ...RoutingRuleEditableFields
});
export type RoutingRuleCreateRequest = z.infer<typeof RoutingRuleCreateRequestSchema>;

export const RoutingRuleUpdateRequestSchema = z
  .strictObject({
    expectedRevision: ExpectedRevisionSchema,
    idempotencyKey: IdempotencyKeySchema,
    enabled: RoutingRuleEditableFields.enabled.optional(),
    ruleType: RoutingRuleEditableFields.ruleType.optional(),
    condition: RoutingRuleEditableFields.condition.optional(),
    destination: RoutingRuleEditableFields.destination.optional(),
    priority: RoutingRuleEditableFields.priority.optional()
  })
  .refine(
    ({ enabled, ruleType, condition, destination, priority }) =>
      enabled !== undefined ||
      ruleType !== undefined ||
      condition !== undefined ||
      destination !== undefined ||
      priority !== undefined,
    "At least one routing-rule field is required"
  );
export type RoutingRuleUpdateRequest = z.infer<typeof RoutingRuleUpdateRequestSchema>;

export const RoutingRuleDeleteRequestSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema
});
export type RoutingRuleDeleteRequest = z.infer<typeof RoutingRuleDeleteRequestSchema>;

export const RoutingRuleMutationResponseSchema = z.strictObject({
  rule: RoutingRuleDtoSchema,
  replayed: z.boolean()
});
export type RoutingRuleMutationResponse = z.infer<typeof RoutingRuleMutationResponseSchema>;

export const RoutingRuleDeleteResponseSchema = z.strictObject({
  ruleId: entityIdSchema("rule"),
  deleted: z.literal(true),
  replayed: z.boolean()
});
export type RoutingRuleDeleteResponse = z.infer<typeof RoutingRuleDeleteResponseSchema>;
