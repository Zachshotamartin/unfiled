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
    expect(scoreRoutingSignals(HIGH_FEATURES)).toBe(0.875);
    const everySignal = Object.fromEntries(
      Object.keys(HIGH_FEATURES).map((key) => [key, 1])
    ) as RoutingSignalFeatures;
    // The positive weights sum to exactly one; a duplicate title takes its 0.15 off the top.
    expect(scoreRoutingSignals({ ...everySignal, duplicateTitleSuspicion: 0 })).toBe(1);
    expect(scoreRoutingSignals(everySignal)).toBe(0.85);
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
    // The retriever's score gap no longer decides on the model's behalf. This is a 0.74 capture
    // whose top two candidates sit 0.1 apart; the model read both and chose, so Balanced files it.
    expect(bandRoutingDecision(policy({ features: automaticSignals }))).toMatchObject({
      band: "auto",
      autoApply: true
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

  it("files an append into the note that holds this kind of thing, whatever the words", () => {
    // "Eggs for the weekend" into Groceries shares no word with the note and no lexical signal
    // will ever vouch for it. The list holds items and the model chose this list: that files.
    const noEvidence = {
      ...HIGH_FEATURES,
      ruleOrAliasNearMatch: 0,
      explicitDestinationMention: 0,
      openSameDayTypeMatch: 0,
      semanticSimilarity: 0,
      destinationRecency: 0,
      margin: 0,
      reasonCodeConsistency: 0
    };
    expect(
      bandRoutingDecision(
        policy({
          captureKind: "list_items",
          destinationNoteType: "list",
          features: { ...noEvidence, typeCompatibility: 1 }
        })
      )
    ).toMatchObject({ band: "auto", autoApply: true, score: 0.3 });
    // A shapeless thought into a note built for something else is a loose fit, and with nothing
    // else to vouch for it the capture waits in the Inbox.
    expect(
      bandRoutingDecision(policy({ features: { ...noEvidence, typeCompatibility: 0.25 } }))
    ).toMatchObject({ band: "inbox", reasons: ["low_score"], score: 0.075 });
    // With corroboration -- the title named in the capture -- the loose fit files too.
    expect(
      bandRoutingDecision(
        policy({
          features: {
            ...noEvidence,
            typeCompatibility: 0.25,
            ruleOrAliasNearMatch: 1,
            openSameDayTypeMatch: 1,
            semanticSimilarity: 0.8
          }
        })
      )
    ).toMatchObject({ band: "auto" });
  });

  it.each([
    ["duplicate", { duplicateNoteSuspected: true }],
    ["principle mismatch", { destinationNoteType: "principle", captureKind: "freeform" }],
    ["long capture", { captureLength: 2_001 }],
    ["retrieval degradation", { retrievalAutoEligible: false }]
  ] as const)("hard-overrides automatic routing for %s", (_label, overrides) => {
    expect(bandRoutingDecision(policy(overrides))).toMatchObject({
      band: "review",
      autoApply: false
    });
  });

  it("honors the deterministic rule retrieval exception", () => {
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

  it("files a new account's first captures instead of holding them for review", () => {
    // The warm-up held an account's first five captures so its owner could watch the organizer
    // work. What they watched was every capture they had ever written arrive in Review, which is
    // the opposite of what they installed the app to do.
    for (const accountCaptureOrdinal of [1, 2, 5, 6]) {
      expect(bandRoutingDecision(policy({ accountCaptureOrdinal }))).toMatchObject({
        band: "auto",
        autoApply: true
      });
    }
  });

  it("auto-files a plan to start a note whatever the score, ordinal, or scan says", () => {
    // Starting a note damages no existing note and chooses between nothing, so the create score --
    // assembled out of how badly the candidates fit -- is not a reason to ask the owner. An owner
    // whose library is still empty is exactly the owner this used to interrogate every time.
    const startsANote = {
      planDecision: "create_note",
      destinationNoteType: null,
      createSignals: { noCandidateFitStrength: 0.2, titleValidity: 0.5 }
    } as const;
    expect(scoreCreateRoutingSignals(startsANote.createSignals)).toBe(0.29);
    for (const overrides of [
      {},
      { accountCaptureOrdinal: 1 },
      { retrievalAutoEligible: false },
      { features: { ...HIGH_FEATURES, margin: 0 } }
    ]) {
      expect(bandRoutingDecision(policy({ ...startsANote, ...overrides }))).toMatchObject({
        band: "auto",
        autoApply: true
      });
    }
  });

  it("still holds a new note the owner may already have, and an append it cannot place", () => {
    // Two things starting a note can get wrong: duplicating one that exists, and being made while
    // the owner has asked to approve everything. Neither is a score, and both survive the change.
    const startsANote = {
      planDecision: "create_note",
      destinationNoteType: null,
      createSignals: { noCandidateFitStrength: 1, titleValidity: 1 }
    } as const;
    expect(
      bandRoutingDecision(policy({ ...startsANote, duplicateNoteSuspected: true })).reasons
    ).toContain("duplicate_suspected");
    expect(bandRoutingDecision(policy({ ...startsANote, mode: "cautious" })).reasons).toContain(
      "cautious_mode"
    );
    // An append is where the organizer can genuinely be ignorant: a scan that could not vouch for
    // its candidates means the note it chose may not be the note it would have chosen.
    expect(bandRoutingDecision(policy({ retrievalAutoEligible: false })).reasons).toContain(
      "retrieval_degraded"
    );
  });

  it("bands an append by what a retrieved candidate can actually score", () => {
    // In production a candidate the retriever merely found has explicitDestinationMention and
    // reasonCodeConsistency of zero -- they fire only for a destination the owner named or a rule
    // matched -- so 0.6 is the ceiling for a purely semantic append. The old 0.8 bar sat above
    // every score this case can reach, which is the whole reason ordinary filing went to Review.
    const found = {
      ...HIGH_FEATURES,
      ruleOrAliasNearMatch: 0,
      explicitDestinationMention: 0,
      reasonCodeConsistency: 0
    };
    const ceiling = { ...found, semanticSimilarity: 1, margin: 1 };
    expect(scoreRoutingSignals(ceiling)).toBe(0.6);

    const strong = { ...found, semanticSimilarity: 0.9, margin: 0.4 };
    expect(scoreRoutingSignals(strong)).toBe(0.56);
    expect(bandRoutingDecision(policy({ features: strong }))).toMatchObject({ band: "auto" });

    // A loose fit -- the note is not made of this kind of thing -- is where the score decides.
    const weak = {
      ...found,
      typeCompatibility: 0.25,
      openSameDayTypeMatch: 0,
      semanticSimilarity: 0.8,
      margin: 0.3
    };
    expect(scoreRoutingSignals(weak)).toBe(0.22);
    expect(bandRoutingDecision(policy({ features: weak }))).toMatchObject({
      band: "inbox",
      reasons: ["low_score"]
    });
  });

  it("never sends a capture to Review over a score alone", () => {
    // Review is for what the organizer could not resolve, and every one of those is a hard
    // override. Confidence is not one: a placement it is unsure of waits in the Inbox, which
    // costs the owner a glance, instead of asking them to adjudicate a note it understood.
    for (const semanticSimilarity of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      for (const margin of [0, 0.5, 1]) {
        for (const mode of ["balanced", "automatic"] as const) {
          const banded = bandRoutingDecision(
            policy({
              mode,
              features: {
                ...HIGH_FEATURES,
                ruleOrAliasNearMatch: 0,
                explicitDestinationMention: 0,
                reasonCodeConsistency: 0,
                semanticSimilarity,
                margin
              }
            })
          );
          expect(banded.band).not.toBe("review");
        }
      }
    }
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
