import { describe, expect, it } from "vitest";

import { reviewReasonSentence, reviewReasonSentences } from "./review-reasons";

describe("review reasons", () => {
  it("says why the organizer stopped in the phone's words, once each, in order", () => {
    expect(
      reviewReasonSentences([
        "planner_ambiguity",
        "low_information",
        "low_confidence",
        "internal_bookkeeping_code",
        "provider_unavailable"
      ])
    ).toEqual([
      "Unfiled could not settle on one destination.",
      "There was not enough to file it with confidence.",
      "Your AI key was not available."
    ]);
  });

  it("drops codes that mean nothing to the owner", () => {
    expect(reviewReasonSentence("validation_failed")).toBeNull();
    expect(reviewReasonSentences([])).toEqual([]);
  });
});
