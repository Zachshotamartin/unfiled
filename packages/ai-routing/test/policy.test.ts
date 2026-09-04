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
    captureCarriesUploads: false,
    features: HIGH_FEATURES,
    createSignals: null,
    ...overrides
  };
}

describe("routing scoring policy", () => {
  it("uses the documented weighted score and clamps it", () => {
    expect(scoreRoutingSignals(HIGH_FEATURES)).toBe(0.945);
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

  it("never auto-files an upload into a note that cannot hold a paragraph", () => {
    // A list or log body is a rendering of its items, so the organizer has nowhere to place the
    // photo. The capture waits for the owner instead of being filed with the photo dropped.
    for (const destinationNoteType of ["list", "log"] as const) {
      const banded = bandRoutingDecision(
        policy({ captureCarriesUploads: true, captureKind: "list_items", destinationNoteType })
      );
      expect(banded.band).toBe("review");
      expect(banded.reasons).toContain("attachment_placement_unavailable");
    }
    for (const destinationNoteType of ["generic", "principle", "project"] as const) {
      expect(
        bandRoutingDecision(
          policy({
            captureCarriesUploads: true,
            captureKind: destinationNoteType === "principle" ? "principle" : "freeform",
            destinationNoteType
          })
        )
      ).toMatchObject({ band: "auto", autoApply: true });
    }
    expect(
      bandRoutingDecision(policy({ captureKind: "list_items", destinationNoteType: "list" }))
    ).toMatchObject({ band: "auto", autoApply: true });
  });

  it("lets the owner's Automatic setting decide the warm-up captures", () => {
    // Warm-up holds a new account back so its owner can watch the first filings. An owner who
    // has chosen Automatic has already answered that; holding them anyway ignores the setting.
    const warmup = bandRoutingDecision(policy({ accountCaptureOrdinal: 1 }));
    expect(warmup.band).toBe("review");
    expect(warmup.reasons).toContain("warmup");
    expect(
      bandRoutingDecision(policy({ accountCaptureOrdinal: 1, mode: "automatic" }))
    ).toMatchObject({ band: "auto", autoApply: true });
    expect(
      bandRoutingDecision(policy({ accountCaptureOrdinal: 5, mode: "cautious" })).reasons
    ).toContain("warmup");
    expect(bandRoutingDecision(policy({ accountCaptureOrdinal: 6 }))).toMatchObject({
      band: "auto"
    });
  });

  it("spends every feature weight on a signal production can raise", () => {
    // A weight on a feature no production path can compute silently lifts the auto threshold
    // by its own value, because the documented maximum is then unreachable.
    const perfect = Object.fromEntries(
      Object.keys(HIGH_FEATURES).map((key) => [key, key === "duplicateTitleSuspicion" ? 0 : 1])
    ) as RoutingSignalFeatures;
    expect(scoreRoutingSignals(perfect)).toBe(1);
    expect(Object.keys(HIGH_FEATURES)).not.toContain("priorAccepted");
  });

  it("maps operational failures to content-safe fail-closed bands", () => {
    for (const failure of [
      "invalid_plan",
      "provider_unavailable",
      "provider_key_invalid",
      "budget_exhausted"
    ] as const) {
      expect(failClosedRoutingPolicy(failure)).toMatchObject({
        band: "inbox",
        failClosed: true,
        reasons: [failure]
      });
    }
    for (const failure of [
      "revision_conflict",
      "retrieval_unavailable",
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
