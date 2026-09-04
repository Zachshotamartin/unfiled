import type { ReviewItemDto } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DuplicateReviewProposal,
  reviewCopy,
  reviewDecisionAttempt,
  reviewItemIsDismissable,
  reviewLabel
} from "./review-view";

const duplicate: ReviewItemDto = {
  id: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  noteId: null,
  type: "duplicate_suggestion",
  proposal: {
    type: "duplicate_notes",
    explanation: "These entries describe the same weekly training plan.",
    notes: [
      { noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X", revision: 2 },
      { noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y", revision: 4 }
    ]
  },
  state: "open",
  resolution: null,
  createdAt: "2026-09-01T18:00:00.000Z",
  resolvedAt: null
};

describe("review proposal presentation", () => {
  it("shows every duplicate candidate and explicitly describes non-destructive actions", () => {
    const html = renderToStaticMarkup(<DuplicateReviewProposal item={duplicate} />);

    expect(html).toContain("These entries describe the same weekly training plan.");
    expect(html).toContain("Open candidate 1");
    expect(html).toContain("revision 2");
    expect(html).toContain("Open candidate 2");
    expect(html).toContain("revision 4");
    expect(html).toContain("Neither action merges, deletes, archives, or rewrites a note.");
    expect(html).toContain("/app/notes/note_01J6M9Q7G4BMKB33GSG3NJ6D1X");
    expect(html).toContain("/app/notes/note_01J6M9Q7G4BMKB33GSG3NJ6D1Y");
  });

  it("labels generated prose as a proposal held outside the editable note", () => {
    const generated: ReviewItemDto = {
      ...duplicate,
      noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      type: "pending_expansion",
      proposal: { type: "generated_block", blockId: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X" }
    };

    expect(reviewLabel(generated.type)).toBe("AI-generated proposal");
    expect(reviewCopy(generated)).toContain("outside your editable note");
  });

  it("describes duplicate suggestions without implying an automatic merge", () => {
    expect(reviewCopy(duplicate)).toContain("suggestion only");
    expect(reviewCopy(duplicate)).toContain("nothing has been merged or removed");
  });

  it("reuses an ambiguous duplicate decision request instead of duplicating its effect", () => {
    const first = reviewDecisionAttempt(null, { type: "keep_both" }, () => "web_first");
    const retry = reviewDecisionAttempt(first, { type: "keep_both" }, () => "web_unused");
    const changed = reviewDecisionAttempt(first, { type: "dismiss" }, () => "web_second");

    expect(retry).toBe(first);
    expect(changed).toEqual({
      idempotencyKey: "web_second",
      resolution: { type: "dismiss" }
    });
  });
});

describe("clearing a review item", () => {
  // The organizer creates low_confidence items from planner_ambiguity more than any other type,
  // and the web offered them no control whatsoever: not dismiss, not route, not keep in Inbox.
  // They could not be resolved from a browser, so they returned on every poll for good, and the
  // Inbox's "Nothing waiting." never appeared again for that owner.
  const item = (over: Partial<ReviewItemDto>): ReviewItemDto => ({
    ...duplicate,
    ...over
  });

  it("offers a way out of every item the contract lets the owner dismiss", () => {
    const conflict = { type: "conflict", reason: "candidate_eligibility" } as const;
    for (const type of [
      "low_confidence",
      "failed_job",
      "revision_conflict",
      "structure_conflict"
    ] as const) {
      expect(reviewItemIsDismissable(item({ type, proposal: conflict }))).toBe(true);
    }
    expect(reviewItemIsDismissable(duplicate)).toBe(true);
  });

  it("leaves a generated block to its own accept or reject decision", () => {
    expect(
      reviewItemIsDismissable(
        item({
          type: "pending_expansion",
          noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
          proposal: { type: "generated_block", blockId: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X" }
        })
      )
    ).toBe(false);
  });
});
