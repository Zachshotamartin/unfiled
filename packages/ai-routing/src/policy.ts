import { CaptureKindSchema, NoteTypeSchema, OrganizationDecisionSchema } from "@unfiled/contracts";
import { z } from "zod";

import { noteTypeHoldsParagraphs } from "./application.js";

const UnitIntervalSchema = z.number().min(0).max(1);

export const RoutingBehaviorModeSchema = z.enum(["cautious", "balanced", "automatic"]);
export type RoutingBehaviorMode = z.infer<typeof RoutingBehaviorModeSchema>;

/**
 * An operational failure that ends a capture's routing before a plan can be judged. These are
 * reached only through `failClosedRoutingPolicy`, never as an input to `bandRoutingDecision`:
 * a failure has no score and no features to band. `retrieval_unavailable` is deliberately not
 * called `retrieval_degraded`, which is the hard-override reason for a plan that was banded
 * while the index could not vouch for its candidates.
 */
export const RoutingFailureSchema = z.enum([
  "invalid_plan",
  "provider_unavailable",
  "provider_key_invalid",
  "budget_exhausted",
  "revision_conflict",
  "retrieval_unavailable",
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
  /** Whether the owner attached a photo or recording that the organizer must place. */
  captureCarriesUploads: z.boolean(),
  features: RoutingSignalFeaturesSchema,
  createSignals: CreateRoutingSignalsSchema.nullable()
});
export type RoutingPolicyInput = z.infer<typeof RoutingPolicyInputSchema>;

export type RoutingBand = "auto" | "review" | "inbox";
export type RoutingPolicyReason =
  | "attachment_placement_unavailable"
  | "automatic_threshold_met"
  | "budget_exhausted"
  | "cautious_mode"
  | "duplicate_suspected"
  | "encryption_failure"
  | "invalid_plan"
  | "invalid_policy_input"
  | "long_capture"
  | "low_score"
  | "model_deferred"
  | "principle_type_mismatch"
  | "provider_key_invalid"
  | "provider_unavailable"
  | "retrieval_degraded"
  | "retrieval_unavailable"
  | "revision_conflict";

export type RoutingPolicyResult = Readonly<{
  band: RoutingBand;
  score: number;
  margin: number;
  autoApply: boolean;
  failClosed: boolean;
  reasons: readonly RoutingPolicyReason[];
}>;

/**
 * Every weight here is spent on a signal the organizer can actually observe for a capture. A
 * weight on a feature no production path can raise silently lifts the auto threshold by its
 * own value, because the documented ceiling is then unreachable.
 */
const FEATURE_WEIGHTS = Object.freeze({
  ruleOrAliasNearMatch: 0.3,
  explicitDestinationMention: 0.25,
  openSameDayTypeMatch: 0.2,
  typeCompatibility: 0.1,
  destinationRecency: 0.05,
  semanticSimilarity: 0.1,
  margin: 0.1,
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

/**
 * The one entry point for a capture whose routing ended in a failure rather than a plan. The
 * result is never auto-apply: a failure the owner can act on in Review keeps the capture
 * there, and everything else falls back to the Inbox.
 */
export function failClosedRoutingPolicy(
  failure: RoutingFailure | "invalid_policy_input",
  margin = 0
): RoutingPolicyResult {
  if (
    failure === "revision_conflict" ||
    failure === "retrieval_unavailable" ||
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
  // A list or log note's body is a rendering of its items, so there is nowhere in one for the
  // organizer to place a photo. The capture waits for the owner rather than losing the photo.
  if (
    policy.captureCarriesUploads &&
    policy.destinationNoteType !== null &&
    !noteTypeHoldsParagraphs(policy.destinationNoteType)
  ) {
    hardOverrides.push("attachment_placement_unavailable");
  }
  if (policy.planDecision === "append_to_note" && policy.captureLength > 2_000) {
    hardOverrides.push("long_capture");
  }
  // Starting a note has nothing to get wrong. There is no existing note to damage and nothing to
  // choose between, and a title the owner dislikes is one tap to rename. Review is for placing a
  // capture among notes that already exist, so a plan to give one a note of its own answers to the
  // duplicate check above and to nothing else here: not the warm-up ordinal, not a degraded
  // candidate scan, not a score assembled out of how well the candidates *failed* to fit.
  // Each of those held a capture to ask the owner to approve the only available answer, and for an
  // owner whose library was still empty that was every capture they had ever written.
  const startsANote = policy.planDecision === "create_note";
  // A degraded scan is the one case where the organizer genuinely cannot see the library it is
  // filing into, so an append still waits: the note it chose may not be the note it would have
  // chosen. That is ignorance of the destination, which is what Review is for.
  if (!startsANote && !policy.retrievalAutoEligible && !policy.deterministicRuleMatch) {
    hardOverrides.push("retrieval_degraded");
  }
  if (policy.mode === "cautious") hardOverrides.push("cautious_mode");

  // Review is for a capture the organizer could not resolve, and every one of those is a hard
  // override above: a note the owner may already have, a type the destination cannot hold, a
  // photo with nowhere to sit, a scan that could not vouch for its candidates, a mode in which
  // the owner asked to see everything. A score is not one of those. It says how confident the
  // placement is, so it chooses between filing and leaving the capture in the Inbox -- it does
  // not ask the owner to adjudicate a note the organizer understood.
  //
  // The bar is 0.45 because of what the weights can actually reach. `explicitDestinationMention`
  // (0.25) and `reasonCodeConsistency` (0.05) are both zero for every candidate the retriever
  // merely found -- they fire only for a destination the owner named or a rule matched -- so 0.55
  // is the ceiling for a purely semantic append and a strong one lands near 0.48. The old bar of
  // 0.8 sat above everything an ordinary capture could score, which is why filing the organizer
  // had got right arrived in Review anyway.
  //
  // The margin gate went with it. Margin is the retriever's score gap between the top two
  // candidates, and it is already weighted into the score. Gating on it a second time held a
  // capture because the *retriever* could not separate two notes, when the model that chose
  // between them had read both. Choosing among plausible places is the work, not a reason to ask.
  if (hardOverrides.length > 0) {
    // A blocker over a placement worth showing becomes a question, because there is something for
    // the owner to accept or redirect. A blocker over a placement the organizer had no confidence
    // in has nothing to approve, so it waits in the Inbox instead of arriving as a question whose
    // proposed answer is a guess.
    return startsANote || score >= 0.45
      ? result("review", score, policy.features.margin, hardOverrides)
      : result("inbox", score, policy.features.margin, [...hardOverrides, "low_score"]);
  }
  const autoThreshold = policy.mode === "automatic" ? 0.4 : 0.45;
  if (startsANote || score >= autoThreshold) {
    return result("auto", score, policy.features.margin, ["automatic_threshold_met"]);
  }
  return result("inbox", score, policy.features.margin, ["low_score"]);
}
