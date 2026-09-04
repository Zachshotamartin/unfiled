import { describe, expect, it } from "vitest";

import {
  captureBindsAttachments,
  filedNoteId,
  noteKeepsTextWithoutDirections,
  noteReferencesAttachment
} from "./gate-checks.mjs";

const ATTACHMENT_ID = "att_01J8Z0000000000000000GATE";
const NOTE_ID = "note_01J8Z0000000000000000GATE";

/** The receipt production returns for a capture the organizer stopped on. */
const reviewReceipt = Object.freeze({
  outcome: "needs_review",
  reviewItemId: "rev_01J8Z0000000000000000GATE",
  destination: null
});

/** The receipt production returns once the capture reached a note. */
const filedReceipt = Object.freeze({
  outcome: "created_note",
  destination: Object.freeze({ noteId: NOTE_ID, title: "Gate photo" })
});

const noteServing = (bodyMarkdown) =>
  Object.freeze({ status: 200, json: { note: { id: NOTE_ID, bodyMarkdown } } });

describe("filedNoteId", () => {
  it("names the note a filed capture reached", () => {
    expect(filedNoteId(filedReceipt)).toBe(NOTE_ID);
  });

  // This is the state the gate used to call green. A capture in review filed nothing, so every
  // step that names a filed note has to be able to see that there is no note.
  it("is null for a capture waiting in review", () => {
    expect(filedNoteId(reviewReceipt)).toBeNull();
  });

  it("is null when the organizer produced no receipt at all", () => {
    expect(filedNoteId(null)).toBeNull();
    expect(filedNoteId({ outcome: "failed" })).toBeNull();
  });

  it("is null when the destination carries no note id", () => {
    expect(filedNoteId({ outcome: "created_note", destination: { noteId: "" } })).toBeNull();
    expect(
      filedNoteId({ outcome: "created_note", destination: { title: "Gate photo" } })
    ).toBeNull();
  });
});

describe("noteReferencesAttachment", () => {
  it("holds when the filed note carries the photo reference", () => {
    const note = noteServing(`Whiteboard\n\n![Photo](unfiled-attachment:${ATTACHMENT_ID})\n`);
    expect(noteReferencesAttachment(note, ATTACHMENT_ID)).toBe(true);
  });

  it("fails when the filed note is only the capture text", () => {
    expect(noteReferencesAttachment(noteServing("Whiteboard\n"), ATTACHMENT_ID)).toBe(false);
  });

  it("fails when the note references some other photo", () => {
    const note = noteServing("![Photo](unfiled-attachment:att_01J8Z0000000000000000OTHR)");
    expect(noteReferencesAttachment(note, ATTACHMENT_ID)).toBe(false);
  });

  // No note is the case the old fallback passed on, so it is the one that has to be false here.
  it("fails when production served no note", () => {
    expect(noteReferencesAttachment(null, ATTACHMENT_ID)).toBe(false);
    expect(noteReferencesAttachment({ status: 404, json: null }, ATTACHMENT_ID)).toBe(false);
    expect(noteReferencesAttachment({ status: 200, json: {} }, ATTACHMENT_ID)).toBe(false);
  });
});

describe("noteKeepsTextWithoutDirections", () => {
  const directions = "put this in the note titled Gate second";

  it("holds when the note carries the capture's words and none of the directions", () => {
    const note = noteServing("- the plumber comes Thursday at nine\n");
    expect(
      noteKeepsTextWithoutDirections(note, { captureText: "plumber comes Thursday", directions })
    ).toBe(true);
  });

  it("fails when the directions were written into the note", () => {
    const note = noteServing(`${directions}\n\nthe plumber comes Thursday at nine\n`);
    expect(
      noteKeepsTextWithoutDirections(note, { captureText: "plumber comes Thursday", directions })
    ).toBe(false);
  });

  it("fails when the capture's own words never reached the note", () => {
    expect(
      noteKeepsTextWithoutDirections(noteServing("Something else\n"), {
        captureText: "plumber comes Thursday",
        directions
      })
    ).toBe(false);
  });

  it("fails when production served no note", () => {
    expect(
      noteKeepsTextWithoutDirections(null, { captureText: "plumber comes Thursday", directions })
    ).toBe(false);
  });
});

describe("captureBindsAttachments", () => {
  const capture = (attachments) =>
    Object.freeze({ status: 200, json: { capture: { id: "cap_1", attachments } } });

  it("holds when the capture carries exactly the uploaded photo", () => {
    expect(captureBindsAttachments(capture([{ id: ATTACHMENT_ID }]), [ATTACHMENT_ID])).toBe(true);
  });

  it("fails when the server accepted the create and bound nothing", () => {
    expect(captureBindsAttachments(capture([]), [ATTACHMENT_ID])).toBe(false);
  });

  it("fails when the capture carries an attachment that was never uploaded for it", () => {
    expect(
      captureBindsAttachments(capture([{ id: "att_01J8Z0000000000000000OTHR" }]), [ATTACHMENT_ID])
    ).toBe(false);
  });

  it("fails when the bound attachments come back in another order", () => {
    const second = "att_01J8Z0000000000000000SCND";
    expect(
      captureBindsAttachments(capture([{ id: second }, { id: ATTACHMENT_ID }]), [
        ATTACHMENT_ID,
        second
      ])
    ).toBe(false);
  });

  it("fails when production served no capture", () => {
    expect(captureBindsAttachments(null, [ATTACHMENT_ID])).toBe(false);
    expect(captureBindsAttachments({ status: 200, json: { capture: {} } }, [ATTACHMENT_ID])).toBe(
      false
    );
  });
});
