import { CaptureReceiptPayloadSchema } from "@unfiled/encrypted-aggregate";
import { describe, expect, it } from "vitest";

import { generatedExpansionReceiptProjectionMatches } from "./encrypted-receipt-projection";

const CAPTURE = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const JOB = "job_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const DECISION = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const REVIEW = "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const BLOCK = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const OTHER_BLOCK = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const NOW = "2026-09-01T18:30:00.000Z";

const pending = CaptureReceiptPayloadSchema.parse({
  schemaVersion: 2,
  captureId: CAPTURE,
  jobId: JOB,
  decisionId: DECISION,
  reviewItemId: REVIEW,
  mutationId: MUTATION,
  outcome: "added_to_note",
  headline: "Added to a note",
  destination: { noteId: NOTE, title: "Principles" },
  insertedContentReferences: [
    { type: "captured", itemId: null },
    { type: "ai_generated", blockId: BLOCK }
  ],
  actions: [
    { type: "open", noteId: NOTE },
    { type: "move", noteId: NOTE, decisionId: DECISION },
    { type: "undo", mutationId: MUTATION, expectedRevision: 2 }
  ],
  reasonCodes: ["semantic_match"],
  createdAt: NOW,
  undoTargets: [{ noteId: NOTE, mutationId: MUTATION, expectedRevision: 2 }]
});

const pendingRow = {
  recordVersion: 1,
  privacy: "ai_assisted" as const,
  decisionId: DECISION,
  reviewItemId: REVIEW,
  mutationId: MUTATION,
  outcome: "added_to_note" as const,
  reasonCodes: ["expansion_pending"]
};

describe("generated expansion receipt projections", () => {
  it("accepts only the narrowly bound pending lifecycle sentinel", () => {
    expect(generatedExpansionReceiptProjectionMatches(pending, pendingRow, BLOCK)).toBe(true);
    expect(
      generatedExpansionReceiptProjectionMatches(
        CaptureReceiptPayloadSchema.parse({
          ...pending,
          insertedContentReferences: [{ type: "captured", itemId: null }]
        }),
        pendingRow
      )
    ).toBe(false);
  });

  it("binds the pending encrypted receipt to the exact generated block", () => {
    const substituted = CaptureReceiptPayloadSchema.parse({
      ...pending,
      insertedContentReferences: [
        { type: "captured", itemId: null },
        { type: "ai_generated", blockId: OTHER_BLOCK }
      ]
    });
    expect(generatedExpansionReceiptProjectionMatches(substituted, pendingRow, BLOCK)).toBe(false);
    expect(
      generatedExpansionReceiptProjectionMatches(
        CaptureReceiptPayloadSchema.parse({
          ...pending,
          insertedContentReferences: [{ type: "captured", itemId: null }]
        }),
        pendingRow,
        BLOCK
      )
    ).toBe(false);
  });

  it.each([
    ["expansion_accepted", true],
    ["expansion_rejected", false]
  ] as const)(
    "binds the %s sentinel to its authenticated block-reference state",
    (reason, kept) => {
      const terminal = CaptureReceiptPayloadSchema.parse({
        ...pending,
        reviewItemId: null,
        insertedContentReferences: [
          { type: "captured", itemId: null },
          ...(kept ? [{ type: "ai_generated" as const, blockId: BLOCK }] : [])
        ],
        reasonCodes: ["semantic_match", reason]
      });
      expect(
        generatedExpansionReceiptProjectionMatches(
          terminal,
          {
            ...pendingRow,
            recordVersion: 2,
            reviewItemId: null,
            reasonCodes: [reason]
          },
          BLOCK
        )
      ).toBe(true);
      expect(
        generatedExpansionReceiptProjectionMatches(terminal, {
          ...pendingRow,
          recordVersion: 2,
          reviewItemId: null,
          reasonCodes: [kept ? "expansion_rejected" : "expansion_accepted"]
        })
      ).toBe(false);
    }
  );

  it("preserves the terminal sentinel through the later destination-retention projection", () => {
    const retained = CaptureReceiptPayloadSchema.parse({
      ...pending,
      reviewItemId: null,
      mutationId: null,
      outcome: "kept_in_inbox",
      headline: "Kept in Inbox after note expired",
      destination: null,
      insertedContentReferences: [],
      actions: [],
      reasonCodes: ["semantic_match", "expansion_accepted", "destination_expired"],
      undoTargets: []
    });
    expect(
      generatedExpansionReceiptProjectionMatches(retained, {
        ...pendingRow,
        recordVersion: 3,
        reviewItemId: null,
        mutationId: null,
        outcome: "kept_in_inbox",
        reasonCodes: ["expansion_accepted", "destination_expired"]
      })
    ).toBe(true);
  });
});
