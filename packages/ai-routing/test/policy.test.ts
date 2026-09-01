import { describe, expect, it } from "vitest";

import {
  bandRoutingDecision,
  failClosedRoutingPolicy,
  scoreCreateRoutingSignals,
  scoreRoutingSignals,
  type RoutingPolicyInput,
  type RoutingSignalFeatures
} from "../src/index.js";

const HIGH_FEATURES = Object.freeze({
  ruleOrAliasNearMatch: 1,
  explicitDestinationMention: 0.5,
  openSameDayTypeMatch: 1,
  typeCompatibility: 1,
  destinationRecency: 1,
  semanticSimilarity: 0.8,
  margin: 0.4,
  priorAccepted: 0.5,
  reasonCodeConsistency: 1,
  duplicateTitleSuspicion: 0
}) satisfies RoutingSignalFeatures;

function policy(overrides: Partial<RoutingPolicyInput> = {}): RoutingPolicyInput {
  return {
    mode: "balanced",
    planDecision: "append_to_note",
    captureKind: "freeform",
    destinationNoteType: "generic",
    captureLength: 40,
    accountCaptureOrdinal: 6,
    retrievalAutoEligible: true,
    deterministicRuleMatch: false,
    duplicateNoteSuspected: false,
    failure: null,
    features: HIGH_FEATURES,
    createSignals: null,
    ...overrides
  };
}

describe("routing scoring policy", () => {
  it("uses the documented weighted score and clamps it", () => {
    expect(scoreRoutingSignals(HIGH_FEATURES)).toBe(0.995);
    expect(
      scoreRoutingSignals(
        Object.fromEntries(
          Object.keys(HIGH_FEATURES).map((key) => [key, 1])
        ) as RoutingSignalFeatures
      )
    ).toBe(1);
    expect(scoreCreateRoutingSignals({ noCandidateFitStrength: 0.5, titleValidity: 1 })).toBe(0.65);
    expect(() => scoreRoutingSignals({ ...HIGH_FEATURES, margin: 2 })).toThrow();
  });

  it("bands balanced, automatic, cautious, and create decisions deterministically", () => {
    expect(bandRoutingDecision(policy())).toMatchObject({ band: "auto", autoApply: true });
    const automaticSignals = {
      ...HIGH_FEATURES,
      ruleOrAliasNearMatch: 0,
      explicitDestinationMention: 1,
      margin: 0.1
    };
    expect(
      bandRoutingDecision(
        policy({
          mode: "automatic",
          features: automaticSignals
        })
      )
    ).toMatchObject({ band: "auto", autoApply: true });
    expect(bandRoutingDecision(policy({ features: automaticSignals }))).toMatchObject({
      band: "review",
      autoApply: false,
      reasons: ["low_margin"]
    });
    const cautious = bandRoutingDecision(policy({ mode: "cautious" }));
    expect(cautious.band).toBe("review");
    expect(cautious.reasons).toContain("cautious_mode");
    expect(
      bandRoutingDecision(
        policy({
          planDecision: "create_note",
          destinationNoteType: null,
          createSignals: { noCandidateFitStrength: 1, titleValidity: 1 }
        })
      )
    ).toMatchObject({ band: "auto", score: 1 });
  });

  it("never promotes model deferrals and sends low scores to Inbox", () => {
    expect(bandRoutingDecision(policy({ planDecision: "needs_review" }))).toMatchObject({
      band: "review",
      reasons: ["model_deferred"]
    });
    expect(bandRoutingDecision(policy({ planDecision: "add_to_inbox" }))).toMatchObject({
      band: "inbox",
      reasons: ["model_deferred"]
    });
    expect(
      bandRoutingDecision(
        policy({
          features: {
            ...HIGH_FEATURES,
            ruleOrAliasNearMatch: 0,
            openSameDayTypeMatch: 0,
            semanticSimilarity: 0,
            typeCompatibility: 0,
            priorAccepted: 0,
            reasonCodeConsistency: 0,
            explicitDestinationMention: 0,
            destinationRecency: 0,
            margin: 0
          }
        })
      )
    ).toMatchObject({ band: "inbox", reasons: ["low_score"] });
  });

  it.each([
    ["duplicate", { duplicateNoteSuspected: true }],
    ["principle mismatch", { destinationNoteType: "principle", captureKind: "freeform" }],
    ["long capture", { captureLength: 2_001 }],
    ["account warm-up", { accountCaptureOrdinal: 5 }],
    ["retrieval degradation", { retrievalAutoEligible: false }]
  ] as const)("hard-overrides automatic routing for %s", (_label, overrides) => {
    expect(bandRoutingDecision(policy(overrides))).toMatchObject({
      band: "review",
      autoApply: false
    });
  });

  it("honors the deterministic rule warm-up and retrieval exceptions", () => {
    expect(
      bandRoutingDecision(
        policy({
          accountCaptureOrdinal: 1,
          retrievalAutoEligible: false,
          deterministicRuleMatch: true
        })
      )
    ).toMatchObject({ band: "auto" });
  });

  it("maps operational failures to content-safe fail-closed bands", () => {
    for (const failure of [
      "invalid_plan",
      "provider_unavailable",
      "provider_key_invalid",
      "budget_exhausted"
    ] as const) {
      expect(bandRoutingDecision(policy({ failure }))).toMatchObject({
        band: "inbox",
        failClosed: true,
        reasons: [failure]
      });
    }
    for (const failure of [
      "revision_conflict",
      "retrieval_degraded",
      "encryption_failure"
    ] as const) {
      expect(failClosedRoutingPolicy(failure)).toMatchObject({
        band: "review",
        failClosed: true,
        reasons: [failure]
      });
    }
    expect(bandRoutingDecision({ unsafe: true })).toMatchObject({
      band: "inbox",
      failClosed: true,
      reasons: ["invalid_policy_input"]
    });
    expect(
      bandRoutingDecision(policy({ planDecision: "create_note", createSignals: null }))
    ).toMatchObject({
      band: "inbox",
      failClosed: true
    });
  });
});
