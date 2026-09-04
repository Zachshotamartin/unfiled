import { describe, expect, it } from "vitest";

import { noteUpdatePayload } from "./note-editor";

describe("note editor saves", () => {
  it("sends the title and body the owner typed", () => {
    expect(noteUpdatePayload({ body: "the body", title: "  Trip list  " }, 7, "key-1")).toEqual({
      bodyMarkdown: "the body",
      expectedRevision: 7,
      idempotencyKey: "key-1",
      title: "Trip list"
    });
  });

  it("names an untitled note rather than sending an empty title", () => {
    expect(noteUpdatePayload({ body: "", title: "   " }, 1, "key-2").title).toBe("Untitled note");
  });

  it("never sends a key class, so the editor cannot make a note only it can read", () => {
    // A `private_manual` note is sealed under a class the organizer's login cannot unwrap and
    // `enqueue_encrypted_note_index_jobs` skips, so it is never indexed, never available as a
    // destination, and — since ADR-0019 removed privacy from the phone's note screen — could
    // only ever be undone from this one surface.
    expect(Object.keys(noteUpdatePayload({ body: "", title: "x" }, 1, "key-3"))).not.toContain(
      "privacy"
    );
  });
});
