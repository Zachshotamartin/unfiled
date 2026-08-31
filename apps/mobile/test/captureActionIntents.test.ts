import { describe, expect, it } from "vitest";

import {
  actionIdempotencyKey,
  captureDeleteSignature,
  captureRetrySignature,
  captureUndoSignature,
  serializeCaptureActionRequest
} from "../src/features/capture/captureActionIntents";

describe("capture action intent identity", () => {
  it("canonicalizes deletion revisions so presentation order cannot mint a second intent", () => {
    const captureId = "cap_01J6M9Q7R5K4N3P2T1V0WXYZAB";
    const revisions = [
      { expectedRevision: 7, noteId: "note_01J6M9Q7R5K4N3P2T1V0WXYZAC" as const },
      { expectedRevision: 4, noteId: "note_01J6M9Q7R5K4N3P2T1V0WXYZAB" as const }
    ];

    const forward = captureDeleteSignature(captureId, {
      expectedNoteRevisions: revisions,
      removeInsertedContent: true
    });
    const reversed = captureDeleteSignature(captureId, {
      expectedNoteRevisions: [...revisions].reverse(),
      removeInsertedContent: true
    });

    expect(reversed).toBe(forward);
    expect(forward).toContain(":content:");
    expect(
      captureDeleteSignature(captureId, {
        expectedNoteRevisions: revisions,
        removeInsertedContent: false
      })
    ).not.toBe(forward);
  });

  it("derives stable cycle signatures and embeds the generated key in the protected request", () => {
    expect(captureRetrySignature("cap_one", "2026-08-30T18:30:00.000Z")).toBe(
      "retry:cap_one:2026-08-30T18:30:00.000Z"
    );
    expect(captureUndoSignature("mut_one", 9)).toBe("undo:mut_one:9");
    expect(actionIdempotencyKey("undo", "01JTEST")).toBe("mobile-undo:01JTEST");
    expect(
      serializeCaptureActionRequest({
        expectedRevision: 9,
        idempotencyKey: "mobile-undo:01JTEST"
      })
    ).toBe('{"expectedRevision":9,"idempotencyKey":"mobile-undo:01JTEST"}');
  });
});
