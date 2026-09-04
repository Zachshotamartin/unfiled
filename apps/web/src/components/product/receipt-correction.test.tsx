import { readdirSync, readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReceiptAction } from "./capture-detail-view";
import { ReceiptCorrection, correctionOutcomeMessage } from "./receipt-correction";

const NOTE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const DECISION_ID = "dec_01ARZ3NDEKTSV4RRFFQ69G5FA2";

describe("correcting a filing from the receipt", () => {
  it("offers Move as an action rather than a link that discards its ids", () => {
    const html = renderToStaticMarkup(
      <ReceiptAction
        action={{ type: "move", noteId: NOTE_ID, decisionId: DECISION_ID }}
        correcting={false}
        disabled={false}
        onCorrect={vi.fn()}
        onUndo={vi.fn()}
        undoIntent={null}
      />
    );

    expect(html).toContain("Move");
    expect(html).toContain('aria-expanded="false"');
    // The link this replaced carried captureId and decisionId to a page that read neither, so
    // the owner landed on a generic list and the correction endpoint was never called.
    expect(html).not.toContain("/app/review?");
  });

  it("says so while the picker is open", () => {
    const html = renderToStaticMarkup(
      <ReceiptAction
        action={{ type: "move", noteId: NOTE_ID, decisionId: DECISION_ID }}
        correcting
        disabled={false}
        onCorrect={vi.fn()}
        onUndo={vi.fn()}
        undoIntent={null}
      />
    );

    expect(html).toContain("Cancel move");
    expect(html).toContain('aria-expanded="true"');
  });

  it("asks where the content should go instead", () => {
    const html = renderToStaticMarkup(
      <ReceiptCorrection decisionId={DECISION_ID} onCorrected={vi.fn()} sourceNoteId={NOTE_ID} />
    );

    expect(html).toContain('id="correction-mode"');
    expect(html).toContain("An existing note");
    expect(html).toContain("A new note");
    expect(html).toContain("Move it");
    // Nothing may be sent until a destination is chosen.
    expect(html).toMatch(/<button[^>]+type="submit"[^>]+disabled=""[^>]*>/u);
  });

  it("tells the owner what each outcome means", () => {
    expect(correctionOutcomeMessage("applied")).toContain("kept every revision");
    expect(correctionOutcomeMessage("needs_review")).toContain("opened a review in your Inbox");
  });

  it("sends a correction through the replaying helper rather than straight to the API", () => {
    const source = readFileSync(new URL("./receipt-correction.tsx", import.meta.url), "utf8");
    // ADR-0011: a 503 after the move commits is answered by replaying the same key, never by a
    // fresh key that would ask for a second move.
    expect(source).toContain("submitCorrection(");
    expect(source).toContain("attemptToReplay(");
    expect(source).not.toContain("browserApi.correctDecision(");
    expect(source).not.toContain("createIdempotencyKey");
  });

  it("leaves no product route pointing at the retired Review destination", () => {
    const directory = new URL(".", import.meta.url);
    const offenders = readdirSync(directory)
      .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
      .filter((entry) => readFileSync(new URL(entry, directory), "utf8").includes("/app/review?"));

    expect(offenders).toEqual([]);
  });
});
