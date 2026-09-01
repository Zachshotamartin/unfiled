import { z } from "zod";

import { entityIdSchema } from "./ids.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";

export const RoutingRuleTypeSchema = z.enum(["prefix", "phrase", "alias", "destination_mention"]);
export type RoutingRuleType = z.infer<typeof RoutingRuleTypeSchema>;

export const RoutingRuleSourceSchema = z.enum(["explicit", "correction_suggested"]);
export type RoutingRuleSource = z.infer<typeof RoutingRuleSourceSchema>;

export const RoutingRuleDestinationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("note"), noteId: entityIdSchema("note") }),
  z.strictObject({ type: z.literal("space"), spaceId: entityIdSchema("spc") })
]);
export type RoutingRuleDestination = z.infer<typeof RoutingRuleDestinationSchema>;

const RoutingRuleEditableFields = {
  enabled: z.boolean(),
  ruleType: RoutingRuleTypeSchema,
  condition: z.string().trim().min(1).max(500),
  destination: RoutingRuleDestinationSchema,
  priority: z.number().int().min(0).max(10_000)
} as const;

export const RoutingRuleDtoSchema = z.strictObject({
  id: entityIdSchema("rule"),
  revision: ExpectedRevisionSchema,
  ...RoutingRuleEditableFields,
  normalizedCondition: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(200)).max(100),
  source: RoutingRuleSourceSchema,
  lastFiredAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true })
});
export type RoutingRuleDto = z.infer<typeof RoutingRuleDtoSchema>;

export const RoutingRuleListResponseSchema = z.strictObject({
  items: z.array(RoutingRuleDtoSchema).max(10_000)
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
