import { CaptureKindSchema, NoteTypeSchema, OrganizationDecisionSchema } from "@unfiled/contracts";
import { z } from "zod";

const UnitIntervalSchema = z.number().min(0).max(1);

export const RoutingBehaviorModeSchema = z.enum(["cautious", "balanced", "automatic"]);
export type RoutingBehaviorMode = z.infer<typeof RoutingBehaviorModeSchema>;

export const RoutingFailureSchema = z.enum([
  "invalid_plan",
  "provider_unavailable",
  "provider_key_invalid",
  "budget_exhausted",
  "revision_conflict",
  "retrieval_degraded",
  "encryption_failure"
]);
export type RoutingFailure = z.infer<typeof RoutingFailureSchema>;

export const RoutingSignalFeaturesSchema = z.strictObject({
  ruleOrAliasNearMatch: UnitIntervalSchema,
  explicitDestinationMention: UnitIntervalSchema,
  openSameDayTypeMatch: UnitIntervalSchema,
  typeCompatibility: UnitIntervalSchema,
  destinationRecency: UnitIntervalSchema,
  semanticSimilarity: UnitIntervalSchema,
  margin: UnitIntervalSchema,
  priorAccepted: UnitIntervalSchema,
  reasonCodeConsistency: UnitIntervalSchema,
  duplicateTitleSuspicion: UnitIntervalSchema
});
export type RoutingSignalFeatures = z.infer<typeof RoutingSignalFeaturesSchema>;

export const CreateRoutingSignalsSchema = z.strictObject({
  noCandidateFitStrength: UnitIntervalSchema,
  titleValidity: UnitIntervalSchema
});
export type CreateRoutingSignals = z.infer<typeof CreateRoutingSignalsSchema>;

export const RoutingPolicyInputSchema = z.strictObject({
  mode: RoutingBehaviorModeSchema,
  planDecision: OrganizationDecisionSchema,
  captureKind: CaptureKindSchema,
  destinationNoteType: NoteTypeSchema.nullable(),
  captureLength: z.number().int().min(0).max(1_000_000),
  accountCaptureOrdinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  retrievalAutoEligible: z.boolean(),
  deterministicRuleMatch: z.boolean(),
  duplicateNoteSuspected: z.boolean(),
  failure: RoutingFailureSchema.nullable(),
  features: RoutingSignalFeaturesSchema,
  createSignals: CreateRoutingSignalsSchema.nullable()
});
export type RoutingPolicyInput = z.infer<typeof RoutingPolicyInputSchema>;

export type RoutingBand = "auto" | "review" | "inbox";
export type RoutingPolicyReason =
  | "automatic_threshold_met"
  | "budget_exhausted"
  | "cautious_mode"
  | "duplicate_suspected"
  | "encryption_failure"
  | "invalid_plan"
  | "invalid_policy_input"
  | "long_capture"
  | "low_margin"
  | "low_score"
  | "model_deferred"
  | "principle_type_mismatch"
  | "provider_key_invalid"
  | "provider_unavailable"
  | "retrieval_degraded"
  | "revision_conflict"
  | "warmup";

export type RoutingPolicyResult = Readonly<{
  band: RoutingBand;
  score: number;
  margin: number;
  autoApply: boolean;
  failClosed: boolean;
  reasons: readonly RoutingPolicyReason[];
}>;

const FEATURE_WEIGHTS = Object.freeze({
  ruleOrAliasNearMatch: 0.3,
  explicitDestinationMention: 0.25,
  openSameDayTypeMatch: 0.2,
  typeCompatibility: 0.1,
  destinationRecency: 0.05,
  semanticSimilarity: 0.1,
  margin: 0.1,
  priorAccepted: 0.1,
  reasonCodeConsistency: 0.05,
  duplicateTitleSuspicion: -0.15
} satisfies Record<keyof RoutingSignalFeatures, number>);

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp01(value: number): number {
  return rounded(Math.max(0, Math.min(1, value)));
}

export function scoreRoutingSignals(features: RoutingSignalFeatures): number {
  const parsed = RoutingSignalFeaturesSchema.parse(features);
  return clamp01(
    Object.entries(FEATURE_WEIGHTS).reduce(
      (total, [key, weight]) => total + parsed[key as keyof RoutingSignalFeatures] * weight,
      0
    )
  );
}

export function scoreCreateRoutingSignals(signals: CreateRoutingSignals): number {
  const parsed = CreateRoutingSignalsSchema.parse(signals);
  return clamp01(parsed.noCandidateFitStrength * 0.7 + parsed.titleValidity * 0.3);
}

function result(
  band: RoutingBand,
  score: number,
  margin: number,
  reasons: readonly RoutingPolicyReason[],
  failClosed = false
): RoutingPolicyResult {
  return Object.freeze({
    band,
    score: rounded(score),
    margin: rounded(margin),
    autoApply: band === "auto",
    failClosed,
    reasons: Object.freeze([...new Set(reasons)])
  });
}

export function failClosedRoutingPolicy(
  failure: RoutingFailure | "invalid_policy_input",
  margin = 0
): RoutingPolicyResult {
  if (
    failure === "revision_conflict" ||
    failure === "retrieval_degraded" ||
    failure === "encryption_failure"
  ) {
    return result("review", 0, margin, [failure], true);
  }
  return result("inbox", 0, margin, [failure], true);
}

export function bandRoutingDecision(input: unknown): RoutingPolicyResult {
  const parsed = RoutingPolicyInputSchema.safeParse(input);
  if (!parsed.success) return failClosedRoutingPolicy("invalid_policy_input");
  const policy = parsed.data;
  if (policy.failure !== null)
    return failClosedRoutingPolicy(policy.failure, policy.features.margin);

  const primaryScore = scoreRoutingSignals(policy.features);
  const score =
    policy.planDecision === "create_note"
      ? policy.createSignals === null
        ? null
        : scoreCreateRoutingSignals(policy.createSignals)
      : primaryScore;
  if (score === null)
    return failClosedRoutingPolicy("invalid_policy_input", policy.features.margin);

  if (policy.planDecision === "add_to_inbox") {
    return result("inbox", score, policy.features.margin, ["model_deferred"]);
  }
  if (policy.planDecision === "needs_review") {
    return result("review", score, policy.features.margin, ["model_deferred"]);
  }

  const hardOverrides: RoutingPolicyReason[] = [];
  if (policy.duplicateNoteSuspected || policy.features.duplicateTitleSuspicion > 0) {
    hardOverrides.push("duplicate_suspected");
  }
  if (policy.destinationNoteType === "principle" && policy.captureKind !== "principle") {
    hardOverrides.push("principle_type_mismatch");
  }
  if (policy.planDecision === "append_to_note" && policy.captureLength > 2_000) {
    hardOverrides.push("long_capture");
  }
  if (policy.accountCaptureOrdinal <= 5 && !policy.deterministicRuleMatch) {
    hardOverrides.push("warmup");
  }
  if (!policy.retrievalAutoEligible && !policy.deterministicRuleMatch) {
    hardOverrides.push("retrieval_degraded");
  }
  if (policy.mode === "cautious") hardOverrides.push("cautious_mode");

  const isCreate = policy.planDecision === "create_note";
  const autoThreshold = isCreate ? 0.7 : policy.mode === "automatic" ? 0.7 : 0.8;
  const marginThreshold = policy.mode === "automatic" ? 0.1 : 0.15;
  const marginTooLow = !isCreate && policy.features.margin < marginThreshold;
  if (hardOverrides.length === 0 && score >= autoThreshold && !marginTooLow) {
    return result("auto", score, policy.features.margin, ["automatic_threshold_met"]);
  }

  if (score < 0.45) {
    return result("inbox", score, policy.features.margin, [...hardOverrides, "low_score"]);
  }
  return result("review", score, policy.features.margin, [
    ...hardOverrides,
    ...(marginTooLow ? (["low_margin"] as const) : [])
  ]);
}
