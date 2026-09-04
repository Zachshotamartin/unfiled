import type { CaptureReceipt, NoteSummary, ReviewItemDto } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  letUnfiledDecide,
  reviewAllowedActions,
  reviewSuggestedDestinations,
  suggestedNoteTitle
} from "./review-actions";

const CAPTURE = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1A" as const;
const REVIEW = "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1B" as const;
const GROCERIES = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const JOURNAL = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;

function note(id: NoteSummary["id"], overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    spaceId: null,
    type: "list",
    title: "Groceries",
    currentRevision: 3,
    isOpen: true,
    pinnedAt: null,
    privacy: "ai_assisted",
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-09-04T10:00:00.000Z",
    ...overrides
  };
}

function routeItem(overrides: Partial<ReviewItemDto> = {}): ReviewItemDto {
  return {
    id: REVIEW,
    captureId: CAPTURE,
    noteId: null,
    type: "low_confidence",
    proposal: {
      type: "route_capture",
      plan: {
        schemaVersion: 1,
        captureKind: "list_items",
        decision: "needs_review",
        destination: { candidateId: GROCERIES, newNote: null },
        operations: [{ type: "append_list_items", section: null, items: ["eggs"] }],
        generatedExpansion: null,
        alternatives: [JOURNAL],
        reasonCodes: ["ambiguous_intent"]
      }
    },
    state: "open",
    resolution: null,
    createdAt: "2026-09-04T10:00:00.000Z",
    resolvedAt: null,
    ...overrides
  };
}

function receipt(overrides: Partial<CaptureReceipt> = {}): CaptureReceipt {
  return {
    schemaVersion: 1,
    captureId: CAPTURE,
    jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1C",
    decisionId: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1D",
    reviewItemId: REVIEW,
    mutationId: null,
    outcome: "needs_review",
    headline: "Needs your decision",
    destination: null,
    insertedContent: [],
    actions: [],
    reasonCodes: ["ambiguous_intent"],
    createdAt: "2026-09-04T10:00:00.000Z",
    ...overrides
  };
}

describe("review actions", () => {
  it("offers routing and a new note only when the capture's own receipt carries a decision", () => {
    expect(reviewAllowedActions(routeItem(), receipt())).toEqual([
      "route",
      "create",
      "keep_inbox",
      "dismiss"
    ]);
    expect(reviewAllowedActions(routeItem(), receipt({ decisionId: null }))).toEqual([
      "keep_inbox",
      "dismiss"
    ]);
    // A receipt for another capture, or naming another item, is not this item's receipt.
    expect(reviewAllowedActions(routeItem(), receipt({ reviewItemId: null }))).toEqual(["dismiss"]);
    expect(reviewAllowedActions(routeItem({ state: "resolved" }), receipt())).toEqual([]);
  });

  it("holds a conflict that only needs acknowledging to keep or close", () => {
    const conflict = routeItem({
      type: "revision_conflict",
      proposal: { type: "conflict", reason: "revision" }
    });
    expect(reviewAllowedActions(conflict, receipt())).toEqual([
      "route",
      "create",
      "keep_inbox",
      "dismiss"
    ]);
    expect(
      reviewAllowedActions(conflict, receipt({ reasonCodes: ["conflict_requires_review"] }))
    ).toEqual(["keep_inbox", "dismiss"]);
  });

  it("keeps duplicates, failures and legacy consent holds to their own answers", () => {
    expect(
      reviewAllowedActions(
        routeItem({
          type: "duplicate_suggestion",
          captureId: null,
          proposal: {
            type: "duplicate_notes",
            notes: [
              { noteId: GROCERIES, revision: 2 },
              { noteId: JOURNAL, revision: 4 }
            ],
            explanation: "These entries describe the same plan."
          }
        }),
        null
      )
    ).toEqual(["keep_both", "dismiss"]);
    expect(
      reviewAllowedActions(
        routeItem({
          type: "failed_job",
          proposal: { type: "failed_job", errorCode: "rate_limited" }
        }),
        receipt({ decisionId: null })
      )
    ).toEqual(["keep_inbox", "dismiss"]);
    expect(
      reviewAllowedActions(
        routeItem({
          type: "failed_job",
          proposal: { type: "failed_job", errorCode: "rate_limited" }
        }),
        null
      )
    ).toEqual(["dismiss"]);
  });

  it("suggests the organizer's own destinations, in its order, that are still open", () => {
    const notes = [note(JOURNAL, { title: "Journal", type: "generic" }), note(GROCERIES)];
    expect(reviewSuggestedDestinations(routeItem(), notes).map(({ title }) => title)).toEqual([
      "Groceries",
      "Journal"
    ]);
    expect(
      reviewSuggestedDestinations(routeItem(), [
        note(GROCERIES, { archivedAt: "2026-09-01T00:00:00.000Z" })
      ])
    ).toEqual([]);
  });

  it("lets Unfiled decide: the suggestion when there is one, else a note of the detected kind", () => {
    const notes = [note(GROCERIES)];
    expect(letUnfiledDecide(routeItem(), ["route", "create"], notes, "eggs")).toEqual({
      type: "route",
      noteId: GROCERIES,
      expectedRevision: 3
    });
    expect(letUnfiledDecide(routeItem(), ["create"], [], "todo list, eggs, milk")).toEqual({
      type: "create",
      title: "Todo list",
      noteType: "list",
      spaceId: null
    });
    expect(letUnfiledDecide(routeItem(), ["keep_inbox", "dismiss"], notes, "eggs")).toBeNull();
  });

  it("titles a new note the way the phone does", () => {
    expect(suggestedNoteTitle("  Call the plumber  \nabout the tap")).toBe("Call the plumber");
    expect(suggestedNoteTitle("groceries: milk, eggs")).toBe("Groceries");
    expect(suggestedNoteTitle("   \n  ")).toBe("Untitled");
    expect(suggestedNoteTitle("a".repeat(80))).toHaveLength(60);
  });
});
