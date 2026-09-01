import { captureV1ReceiptFixture } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import { CaptureReceiptPayloadSchema } from "../src/index.js";
import { OTHER_IDS } from "./harness.js";

const OTHER_DECISION = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const OTHER_MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const storedReceipt = (({ insertedContent, ...receipt }) =>
  Object.freeze({
    ...receipt,
    insertedContentReferences: insertedContent.map((item) =>
      Object.freeze({ type: "captured" as const, itemId: item.itemId })
    )
  }))(captureV1ReceiptFixture);

function expectInvalid(value: unknown): void {
  expect(CaptureReceiptPayloadSchema.safeParse(value).success).toBe(false);
}

describe("stored capture receipt payload invariants", () => {
  it("accepts only a receipt whose durable references agree", () => {
    expect(CaptureReceiptPayloadSchema.parse(storedReceipt)).toEqual(storedReceipt);
  });

  it("rejects duplicate or destination-substituted actions", () => {
    expectInvalid({
      ...storedReceipt,
      actions: [storedReceipt.actions[0], storedReceipt.actions[0]]
    });
    expectInvalid({
      ...storedReceipt,
      actions: [{ type: "open", noteId: OTHER_IDS.note }]
    });
  });

  it("rejects move and undo actions that do not name their persisted records", () => {
    expectInvalid({
      ...storedReceipt,
      actions: [
        {
          type: "move",
          noteId: storedReceipt.destination.noteId,
          decisionId: OTHER_DECISION
        }
      ]
    });
    expectInvalid({
      ...storedReceipt,
      actions: [
        {
          type: "undo",
          mutationId: OTHER_MUTATION,
          expectedRevision: 2
        }
      ]
    });
  });

  it("rejects routed outcomes without every durable routed effect", () => {
    expectInvalid({
      ...storedReceipt,
      destination: null,
      mutationId: null,
      decisionId: null,
      insertedContentReferences: [],
      actions: []
    });
  });

  it("rejects non-routed outcomes that claim routed effects or actions", () => {
    expectInvalid({
      ...storedReceipt,
      outcome: "kept_in_inbox"
    });
  });

  it("requires a persisted review item for review outcomes", () => {
    expectInvalid({
      ...storedReceipt,
      outcome: "needs_review",
      decisionId: null,
      reviewItemId: null,
      mutationId: null,
      destination: null,
      insertedContentReferences: [],
      actions: []
    });
  });

  it("accepts a v2 receipt only when its sorted authenticated targets bind the primary undo", () => {
    const undo = storedReceipt.actions.find((action) => action.type === "undo");
    expect(undo?.type).toBe("undo");
    const receiptV2 = {
      ...storedReceipt,
      schemaVersion: 2,
      undoTargets: [
        {
          noteId: storedReceipt.destination.noteId,
          mutationId: storedReceipt.mutationId,
          expectedRevision: undo?.type === "undo" ? undo.expectedRevision : 1
        },
        {
          noteId: OTHER_IDS.note,
          mutationId: OTHER_MUTATION,
          expectedRevision: 7
        }
      ]
    } as const;
    expect(CaptureReceiptPayloadSchema.parse(receiptV2)).toEqual(receiptV2);
    expectInvalid({ ...receiptV2, undoTargets: [...receiptV2.undoTargets].reverse() });
    expectInvalid({
      ...receiptV2,
      undoTargets: [
        receiptV2.undoTargets[0],
        { ...receiptV2.undoTargets[1], mutationId: receiptV2.undoTargets[0].mutationId }
      ]
    });
    expectInvalid({
      ...receiptV2,
      undoTargets: receiptV2.undoTargets.map((target, index) =>
        index === 0 ? { ...target, expectedRevision: target.expectedRevision + 1 } : target
      )
    });
  });

  it("keeps legacy v1 receipts readable without fabricating undo authority", () => {
    const legacyWithoutUndo = {
      ...storedReceipt,
      actions: storedReceipt.actions.filter((action) => action.type !== "undo")
    };
    expect(CaptureReceiptPayloadSchema.parse(legacyWithoutUndo)).toEqual(legacyWithoutUndo);
    expectInvalid({ ...legacyWithoutUndo, schemaVersion: 2, undoTargets: [] });
  });

  it("allows only an explicitly terminal restored route to omit undo authority", () => {
    const restoredRoute = {
      ...storedReceipt,
      schemaVersion: 2,
      outcome: "added_to_note",
      actions: storedReceipt.actions.filter((action) => action.type !== "undo"),
      reasonCodes: ["user_undo"],
      undoTargets: []
    } as const;
    expect(CaptureReceiptPayloadSchema.parse(restoredRoute)).toEqual(restoredRoute);
    expectInvalid({
      ...restoredRoute,
      actions: storedReceipt.actions,
      undoTargets: [
        {
          noteId: storedReceipt.destination.noteId,
          mutationId: storedReceipt.mutationId,
          expectedRevision: 2
        }
      ]
    });
    expectInvalid({ ...restoredRoute, outcome: "created_note" });
    expectInvalid({ ...restoredRoute, reasonCodes: ["user_undo", "semantic_match"] });
    expectInvalid({ ...restoredRoute, actions: restoredRoute.actions.slice(0, 1) });
  });
});
