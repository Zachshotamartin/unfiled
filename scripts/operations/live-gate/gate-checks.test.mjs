import { describe, expect, it } from "vitest";

import {
  captureBindsAttachments,
  captureWasDeleted,
  correctionOutcomeIsAmbiguous,
  drainsSucceeded,
  filedNoteId,
  listCarriesId,
  listDroppedId,
  listWasServed,
  logFieldReads,
  noteCarriesLinkTo,
  noteCarriesTag,
  noteCarriesTimestamp,
  noteClearedTimestamp,
  noteDroppedLinkTo,
  noteDroppedTag,
  noteIsBacklinkedFrom,
  noteKeepsTextWithoutDirections,
  noteLinksTo,
  noteReadsAsRevision,
  noteReferencesAttachment,
  providerKeyIsAbsent,
  providerKeyWasDeleted,
  receiptEndpointServesTheCaptureReceipt,
  receiptFiledInto,
  ruleIsEnabled,
  ruleWasDeleted,
  searchDroppedNote,
  searchFindsNote,
  settingsCarry,
  signOutConfirmed,
  spaceIsNamed,
  tagIsNamed,
  uploadReplayIsTheSameAttachment
} from "./gate-checks.mjs";

const ATTACHMENT_ID = "att_01J8Z0000000000000000GATE";
const NOTE_ID = "note_01J8Z0000000000000000GATE";
const OTHER_NOTE_ID = "note_01J8Z0000000000000000OTHR";
const CAPTURE_ID = "cap_01J8Z0000000000000000GATE";
const TAG_ID = "tag_01J8Z0000000000000000GATE";
const RULE_ID = "rule_01J8Z000000000000000GATE";

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

/** A note answer carrying whichever of the note's own fields a step reads. */
const noteWith = (note) => Object.freeze({ status: 200, json: { note: { id: NOTE_ID, ...note } } });

const listing = (items) => Object.freeze({ status: 200, json: { items } });

describe("correctionOutcomeIsAmbiguous", () => {
  it("holds when the observation wait ran out behind a durable move", () => {
    expect(
      correctionOutcomeIsAmbiguous({ status: 503, json: { code: "provider_unavailable" } })
    ).toBe(true);
  });

  it("holds when the platform answered without the product", () => {
    expect(correctionOutcomeIsAmbiguous({ status: 502, json: null })).toBe(true);
    expect(correctionOutcomeIsAmbiguous({ status: 500, json: { code: "internal_error" } })).toBe(
      true
    );
  });

  it("fails for an applied correction, which needs no replay", () => {
    expect(correctionOutcomeIsAmbiguous({ status: 200, json: { outcome: "applied" } })).toBe(false);
  });

  it("fails for a definitive refusal, which a replay would only repeat", () => {
    expect(correctionOutcomeIsAmbiguous({ status: 409, json: { code: "stale_revision" } })).toBe(
      false
    );
    expect(correctionOutcomeIsAmbiguous({ status: 403, json: { code: "forbidden" } })).toBe(false);
    expect(correctionOutcomeIsAmbiguous({ status: 400, json: { code: "validation_failed" } })).toBe(
      false
    );
  });

  it("fails when there is no answer to read", () => {
    expect(correctionOutcomeIsAmbiguous(null)).toBe(false);
    expect(correctionOutcomeIsAmbiguous(undefined)).toBe(false);
  });
});

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

describe("receiptFiledInto", () => {
  it("holds when the capture reached the note the rule names", () => {
    expect(receiptFiledInto(filedReceipt, NOTE_ID)).toBe(true);
  });

  // A rule that names one note and files into another is the fault this step exists to find; an
  // outcome of "added_to_note" is true of both, which is why the outcome alone was not enough.
  it("fails when the capture was filed into some other note", () => {
    expect(
      receiptFiledInto(
        { outcome: "added_to_note", destination: { noteId: OTHER_NOTE_ID } },
        NOTE_ID
      )
    ).toBe(false);
  });

  it("fails when the capture filed nothing at all", () => {
    expect(receiptFiledInto(reviewReceipt, NOTE_ID)).toBe(false);
    expect(receiptFiledInto(null, NOTE_ID)).toBe(false);
  });

  it("fails when the gate never learned which note to expect", () => {
    expect(receiptFiledInto({ outcome: "created_note", destination: { noteId: null } }, null)).toBe(
      false
    );
  });
});

describe("receiptEndpointServesTheCaptureReceipt", () => {
  const carried = Object.freeze({
    captureId: CAPTURE_ID,
    outcome: "created_note",
    destination: { noteId: NOTE_ID, title: "Gate groceries" }
  });
  const capture = Object.freeze({ captureId: CAPTURE_ID, receipt: carried });
  const serving = (receipt) => Object.freeze({ status: 200, json: { receipt } });

  it("holds when the endpoint serves the receipt the capture carries", () => {
    expect(receiptEndpointServesTheCaptureReceipt(serving({ ...carried }), capture)).toBe(true);
  });

  // The gate used to accept a 404 beside a 200, so the endpoint could fail to find a receipt the
  // capture was already carrying and the step still read green.
  it("fails when the endpoint cannot find a receipt the capture carries", () => {
    expect(
      receiptEndpointServesTheCaptureReceipt({ status: 404, json: { code: "not_found" } }, capture)
    ).toBe(false);
  });

  it("fails when the endpoint serves another capture's receipt", () => {
    const stranger = serving({ ...carried, captureId: "cap_01J8Z0000000000000000OTHR" });
    expect(receiptEndpointServesTheCaptureReceipt(stranger, capture)).toBe(false);
  });

  it("fails when the endpoint disagrees about the outcome or the destination", () => {
    expect(
      receiptEndpointServesTheCaptureReceipt(
        serving({ ...carried, outcome: "needs_review" }),
        capture
      )
    ).toBe(false);
    expect(
      receiptEndpointServesTheCaptureReceipt(
        serving({ ...carried, destination: { noteId: OTHER_NOTE_ID, title: "Elsewhere" } }),
        capture
      )
    ).toBe(false);
  });

  it("fails when the capture itself never produced a receipt", () => {
    expect(
      receiptEndpointServesTheCaptureReceipt(serving({ ...carried }), {
        captureId: CAPTURE_ID,
        receipt: null
      })
    ).toBe(false);
  });

  it("fails when the endpoint answers 200 with no receipt in it", () => {
    expect(receiptEndpointServesTheCaptureReceipt({ status: 200, json: {} }, capture)).toBe(false);
  });
});

describe("uploadReplayIsTheSameAttachment", () => {
  const stored = Object.freeze({
    id: ATTACHMENT_ID,
    kind: "image",
    mediaType: "image/jpeg",
    byteLength: 1234,
    width: 96,
    height: 64,
    durationMs: null,
    createdAt: "2026-09-03T10:00:00.000Z"
  });
  const upload = (attachment) => Object.freeze({ status: 201, json: attachment });

  it("holds when the replay returns the record the first upload stored", () => {
    expect(uploadReplayIsTheSameAttachment(upload({ ...stored }), upload(stored))).toBe(true);
  });

  // The identifier is the idempotency key the caller chose, so a server that stored a second copy
  // echoes it back unchanged. Only the stored record can carry the first upload's creation time.
  it("fails when the replay stored a second copy under the same identifier", () => {
    const second = upload({ ...stored, createdAt: "2026-09-03T10:00:04.000Z" });
    expect(uploadReplayIsTheSameAttachment(second, upload(stored))).toBe(false);
  });

  it("fails when the replay came back with different bytes or measurements", () => {
    expect(
      uploadReplayIsTheSameAttachment(upload({ ...stored, byteLength: 99 }), upload(stored))
    ).toBe(false);
    expect(uploadReplayIsTheSameAttachment(upload({ ...stored, width: 32 }), upload(stored))).toBe(
      false
    );
  });

  it("fails when either upload was refused", () => {
    expect(uploadReplayIsTheSameAttachment({ status: 409, json: null }, upload(stored))).toBe(
      false
    );
    expect(uploadReplayIsTheSameAttachment(upload(stored), { status: 500, json: null })).toBe(
      false
    );
  });
});

describe("captureWasDeleted", () => {
  it("holds when the deletion answer names the capture and when it went", () => {
    const removed = {
      status: 200,
      json: { captureId: CAPTURE_ID, deletedAt: "2026-09-03T10:00:00.000Z" }
    };
    expect(captureWasDeleted(removed, CAPTURE_ID)).toBe(true);
  });

  // A 200 that deleted nothing is the shape this step is here to catch, and the old predicate,
  // which read the status alone, could not tell the two apart.
  it("fails when the server answered 200 and deleted nothing", () => {
    expect(captureWasDeleted({ status: 200, json: { captureId: CAPTURE_ID } }, CAPTURE_ID)).toBe(
      false
    );
    expect(captureWasDeleted({ status: 200, json: {} }, CAPTURE_ID)).toBe(false);
  });

  it("fails when the answer names another capture", () => {
    const removed = {
      status: 200,
      json: { captureId: "cap_01J8Z0000000000000000OTHR", deletedAt: "2026-09-03T10:00:00.000Z" }
    };
    expect(captureWasDeleted(removed, CAPTURE_ID)).toBe(false);
  });
});

describe("noteReadsAsRevision", () => {
  const revision = Object.freeze({
    id: "rev_01J8Z0000000000000000GATE",
    title: "Gate list",
    bodyMarkdown: "- [ ] alpha\n- [x] beta"
  });

  it("holds when the note came back as the revision it was restored from", () => {
    expect(noteReadsAsRevision(noteWith(revision), revision)).toBe(true);
  });

  // The restore endpoint answering 200 while the note keeps its later content is exactly the
  // failure a status-only assertion cannot see.
  it("fails when the note kept the content the restore was meant to replace", () => {
    const unchanged = noteWith({ title: "Gate list v2", bodyMarkdown: "- [x] alpha\n- [x] beta" });
    expect(noteReadsAsRevision(unchanged, revision)).toBe(false);
  });

  it("fails when production served no note", () => {
    expect(noteReadsAsRevision(null, revision)).toBe(false);
    expect(noteReadsAsRevision({ status: 200, json: {} }, revision)).toBe(false);
  });

  it("fails when there was no revision to restore from", () => {
    expect(noteReadsAsRevision(noteWith(revision), undefined)).toBe(false);
  });
});

describe("noteCarriesTag and noteDroppedTag", () => {
  it("holds when the note carries the tag, and fails when it does not", () => {
    expect(noteCarriesTag(noteWith({ tagIds: [TAG_ID] }), TAG_ID)).toBe(true);
    expect(noteCarriesTag(noteWith({ tagIds: [] }), TAG_ID)).toBe(false);
  });

  // A tag link the server accepted and never made leaves the note carrying some other tag, or
  // none, and the status the step used to read is 200 either way.
  it("fails when the note came back carrying only some other tag", () => {
    const other = noteWith({ tagIds: ["tag_01J8Z0000000000000000OTHR"] });
    expect(noteCarriesTag(other, TAG_ID)).toBe(false);
  });

  it("holds when the note dropped the tag", () => {
    expect(noteDroppedTag(noteWith({ tagIds: [] }), TAG_ID)).toBe(true);
  });

  it("fails when the tag is still on the note after unlinking", () => {
    expect(noteDroppedTag(noteWith({ tagIds: [TAG_ID] }), TAG_ID)).toBe(false);
  });

  // A note nobody served carries no tags either. That answer must not read as an unlink, which is
  // the trap every absent-thing assertion in the gate falls into unless it proves the note arrived.
  it("fails when production served no note to read the tags from", () => {
    expect(noteDroppedTag(null, TAG_ID)).toBe(false);
    expect(noteDroppedTag({ status: 200, json: {} }, TAG_ID)).toBe(false);
    expect(noteDroppedTag(noteWith({}), TAG_ID)).toBe(false);
  });
});

describe("noteCarriesTimestamp and noteClearedTimestamp", () => {
  it("holds when the note carries the time an operation set", () => {
    expect(
      noteCarriesTimestamp(noteWith({ archivedAt: "2026-09-03T10:00:00.000Z" }), "archivedAt")
    ).toBe(true);
    expect(noteClearedTimestamp(noteWith({ archivedAt: null }), "archivedAt")).toBe(true);
  });

  // Reading `archivedAt !== null` off a note nobody served answered true, so an archive step could
  // pass on a reply that carried no note at all.
  it("fails when production served no note to read the time from", () => {
    expect(noteCarriesTimestamp({ status: 200, json: {} }, "archivedAt")).toBe(false);
    expect(noteCarriesTimestamp(noteWith({}), "archivedAt")).toBe(false);
    expect(noteCarriesTimestamp(null, "deletedAt")).toBe(false);
    expect(noteClearedTimestamp({ status: 200, json: {} }, "archivedAt")).toBe(false);
    expect(noteClearedTimestamp(noteWith({}), "archivedAt")).toBe(false);
  });

  it("fails when the note is in the state the operation was meant to leave", () => {
    expect(noteCarriesTimestamp(noteWith({ archivedAt: null }), "archivedAt")).toBe(false);
    expect(
      noteClearedTimestamp(noteWith({ deletedAt: "2026-09-03T10:00:00.000Z" }), "deletedAt")
    ).toBe(false);
  });
});

describe("noteCarriesLinkTo and noteDroppedLinkTo", () => {
  const linked = noteWith({ links: [{ toNoteId: OTHER_NOTE_ID, linkType: "reference" }] });

  it("holds when the note the mutation answered with carries the link", () => {
    expect(noteCarriesLinkTo(linked, OTHER_NOTE_ID, "reference")).toBe(true);
  });

  it("fails when the note links somewhere else or by another kind", () => {
    expect(noteCarriesLinkTo(linked, NOTE_ID, "reference")).toBe(false);
    expect(noteCarriesLinkTo(linked, OTHER_NOTE_ID, "related")).toBe(false);
  });

  it("holds when the link is gone from the note", () => {
    expect(noteDroppedLinkTo(noteWith({ links: [] }), OTHER_NOTE_ID)).toBe(true);
  });

  // Deleting a link answered 200 whether or not the link went, and a reply carrying no note has
  // no links either.
  it("fails when the link survived, and when no note came back to look in", () => {
    expect(noteDroppedLinkTo(linked, OTHER_NOTE_ID)).toBe(false);
    expect(noteDroppedLinkTo(noteWith({}), OTHER_NOTE_ID)).toBe(false);
    expect(noteDroppedLinkTo(null, OTHER_NOTE_ID)).toBe(false);
  });
});

describe("listWasServed", () => {
  it("holds for a list, empty or not", () => {
    expect(listWasServed(listing([]))).toBe(true);
    expect(listWasServed(listing([{ id: NOTE_ID }]))).toBe(true);
  });

  // A list endpoint that stops serving items reads as an empty list to every step that reaches
  // for the items through a fallback, which is how an empty answer became a pass.
  it("fails when the endpoint served no list at all", () => {
    expect(listWasServed({ status: 200, json: {} })).toBe(false);
    expect(listWasServed({ status: 200, json: { items: null } })).toBe(false);
    expect(listWasServed({ status: 500, json: null })).toBe(false);
  });
});

describe("noteLinksTo", () => {
  const link = {
    id: "lnk_01J8Z0000000000000000GATE",
    toNoteId: OTHER_NOTE_ID,
    linkType: "reference"
  };

  it("holds when the list carries the link the owner made", () => {
    expect(noteLinksTo(listing([link]), OTHER_NOTE_ID, "reference")).toBe(true);
  });

  // Counting links says a link exists; it does not say this one does. A link to the wrong note,
  // or of the wrong kind, still makes the count one.
  it("fails when the only link points at another note", () => {
    expect(noteLinksTo(listing([{ ...link, toNoteId: NOTE_ID }]), OTHER_NOTE_ID, "reference")).toBe(
      false
    );
  });

  it("fails when the link came back as another kind", () => {
    expect(
      noteLinksTo(listing([{ ...link, linkType: "related" }]), OTHER_NOTE_ID, "reference")
    ).toBe(false);
  });

  it("fails when production served no links", () => {
    expect(noteLinksTo(listing([]), OTHER_NOTE_ID, "reference")).toBe(false);
    expect(noteLinksTo({ status: 200, json: {} }, OTHER_NOTE_ID, "reference")).toBe(false);
    expect(noteLinksTo(null, OTHER_NOTE_ID, "reference")).toBe(false);
  });
});

describe("noteIsBacklinkedFrom", () => {
  const backlink = {
    linkId: "lnk_01J8Z0000000000000000GATE",
    fromNoteId: NOTE_ID,
    fromTitle: "Gate list",
    linkType: "reference",
    createdAt: "2026-09-03T10:00:00.000Z"
  };

  it("holds when the other note is linked from the note that made the link", () => {
    expect(noteIsBacklinkedFrom(listing([backlink]), NOTE_ID)).toBe(true);
  });

  // The step used to read the status and print the count beside it without ever holding either
  // to the note the link came from, so an empty backlink list passed.
  it("fails when the backlink list came back empty", () => {
    expect(noteIsBacklinkedFrom(listing([]), NOTE_ID)).toBe(false);
  });

  it("fails when the backlink comes from some other note", () => {
    expect(
      noteIsBacklinkedFrom(listing([{ ...backlink, fromNoteId: OTHER_NOTE_ID }]), NOTE_ID)
    ).toBe(false);
  });

  it("fails when production served no backlinks at all", () => {
    expect(noteIsBacklinkedFrom({ status: 500, json: null }, NOTE_ID)).toBe(false);
  });
});

describe("logFieldReads", () => {
  const entryId = "ent_01J8Z0000000000000000GATE";
  const entry = (fields) => noteWith({ structuredData: { entries: [{ id: entryId, fields }] } });

  it("holds when the field carries the value the owner wrote", () => {
    expect(logFieldReads(entry({ distance: "6 km" }), entryId, "distance", "6 km")).toBe(true);
  });

  // A 200 over a log entry that still reads 5 km is the whole failure, and the status could not
  // tell it from the edit landing.
  it("fails when the field still holds what it held before", () => {
    expect(logFieldReads(entry({ distance: "5 km" }), entryId, "distance", "6 km")).toBe(false);
  });

  it("fails when the entry is not the one that was edited", () => {
    expect(
      logFieldReads(entry({ distance: "6 km" }), "ent_01J8Z000000000000000OTHR", "distance", "6 km")
    ).toBe(false);
  });

  it("fails when production served no note or no entries", () => {
    expect(logFieldReads(null, entryId, "distance", "6 km")).toBe(false);
    expect(logFieldReads(noteWith({}), entryId, "distance", "6 km")).toBe(false);
  });
});

describe("listCarriesId and listDroppedId", () => {
  const items = [{ id: NOTE_ID }, { id: OTHER_NOTE_ID }];

  it("holds when the list carries the entity, and fails when it does not", () => {
    expect(listCarriesId(listing(items), NOTE_ID)).toBe(true);
    expect(listCarriesId(listing([{ id: OTHER_NOTE_ID }]), NOTE_ID)).toBe(false);
  });

  it("holds when the entity has left the list", () => {
    expect(listDroppedId(listing([{ id: OTHER_NOTE_ID }]), NOTE_ID)).toBe(true);
  });

  it("fails when the entity is still in the list", () => {
    expect(listDroppedId(listing(items), NOTE_ID)).toBe(false);
  });

  // The gate used to read the items through a fallback that turned any other shape into an empty
  // list, so a list endpoint that stopped serving items made every "left the list" step green.
  it("fails when production served no list to look in", () => {
    expect(listDroppedId({ status: 200, json: {} }, NOTE_ID)).toBe(false);
    expect(listDroppedId({ status: 200, json: { notes: [{ id: NOTE_ID }] } }, NOTE_ID)).toBe(false);
    expect(listDroppedId({ status: 500, json: null }, NOTE_ID)).toBe(false);
    expect(listDroppedId(null, NOTE_ID)).toBe(false);
  });
});

describe("searchFindsNote and searchDroppedNote", () => {
  const hits = (noteIds) => listing(noteIds.map((noteId) => ({ noteId, title: "Gate second" })));

  it("holds when the search results carry the note whose words were searched for", () => {
    expect(searchFindsNote(hits([NOTE_ID]), NOTE_ID)).toBe(true);
  });

  // A count of hits says search returned something. It does not say search returned this note,
  // which is the only thing the step is named for.
  it("fails when search returned other notes and not this one", () => {
    expect(searchFindsNote(hits([OTHER_NOTE_ID]), NOTE_ID)).toBe(false);
  });

  it("holds when a deleted note has left the results", () => {
    expect(searchDroppedNote(hits([OTHER_NOTE_ID]), NOTE_ID)).toBe(true);
  });

  it("fails when the deleted note is still offered", () => {
    expect(searchDroppedNote(hits([NOTE_ID]), NOTE_ID)).toBe(false);
  });

  it("fails when search served no results list at all", () => {
    expect(searchDroppedNote({ status: 200, json: {} }, NOTE_ID)).toBe(false);
    expect(searchFindsNote({ status: 500, json: null }, NOTE_ID)).toBe(false);
  });
});

describe("settingsCarry", () => {
  const served = (settings) => Object.freeze({ status: 200, json: { settings } });

  it("holds when the settings came back with the values the owner asked for", () => {
    expect(settingsCarry(served({ expansionStyle: "off" }), { expansionStyle: "off" })).toBe(true);
    expect(
      settingsCarry(served({ providerMode: "byok", byokProvider: "openai" }), {
        providerMode: "byok",
        byokProvider: "openai"
      })
    ).toBe(true);
  });

  // A settings write that answers 200 and keeps the old value is the failure the owner would see,
  // and the status alone reads the same for both.
  it("fails when the setting did not change", () => {
    expect(settingsCarry(served({ expansionStyle: "brief" }), { expansionStyle: "off" })).toBe(
      false
    );
  });

  it("fails when only some of the asked-for values came back", () => {
    expect(
      settingsCarry(served({ providerMode: "byok", byokProvider: null }), {
        providerMode: "byok",
        byokProvider: "openai"
      })
    ).toBe(false);
  });

  it("fails when production served no settings, and when nothing was asked for", () => {
    expect(settingsCarry({ status: 200, json: {} }, { expansionStyle: "off" })).toBe(false);
    expect(settingsCarry(served({ expansionStyle: "off" }), {})).toBe(false);
  });
});

describe("spaceIsNamed, tagIsNamed and ruleIsEnabled", () => {
  it("holds when the rename came back under the new name", () => {
    expect(
      spaceIsNamed(
        { status: 200, json: { space: { name: "Gate space renamed" } } },
        "Gate space renamed"
      )
    ).toBe(true);
    expect(tagIsNamed({ status: 200, json: { tag: { name: "gate-r" } } }, "gate-r")).toBe(true);
  });

  // A rename that answers 200 and keeps the old name is the only failure worth a step here.
  it("fails when the entity kept its old name", () => {
    expect(
      spaceIsNamed({ status: 200, json: { space: { name: "Gate space" } } }, "Gate space renamed")
    ).toBe(false);
    expect(tagIsNamed({ status: 200, json: { tag: { name: "gate" } } }, "gate-r")).toBe(false);
  });

  it("holds when the rule came back switched the way it was switched", () => {
    expect(ruleIsEnabled({ status: 200, json: { rule: { enabled: false } } }, false)).toBe(true);
    expect(ruleIsEnabled({ status: 200, json: { rule: { enabled: true } } }, true)).toBe(true);
  });

  it("fails when the rule is still switched the way it was", () => {
    expect(ruleIsEnabled({ status: 200, json: { rule: { enabled: true } } }, false)).toBe(false);
  });

  it("fails when production served no entity", () => {
    expect(spaceIsNamed({ status: 200, json: {} }, "Gate space renamed")).toBe(false);
    expect(tagIsNamed(null, "gate-r")).toBe(false);
    expect(ruleIsEnabled({ status: 200, json: {} }, false)).toBe(false);
  });
});

describe("ruleWasDeleted, providerKeyWasDeleted and providerKeyIsAbsent", () => {
  it("holds when the deletion answer names what it removed", () => {
    expect(ruleWasDeleted({ status: 200, json: { ruleId: RULE_ID, deleted: true } }, RULE_ID)).toBe(
      true
    );
    expect(
      providerKeyWasDeleted({ status: 200, json: { provider: "openai", deleted: true } }, "openai")
    ).toBe(true);
  });

  // A 200 that removed nothing, or removed something else, is what the status-only predicate let
  // through.
  it("fails when the answer does not say the entity was removed", () => {
    expect(
      ruleWasDeleted({ status: 200, json: { ruleId: RULE_ID, deleted: false } }, RULE_ID)
    ).toBe(false);
    expect(ruleWasDeleted({ status: 200, json: {} }, RULE_ID)).toBe(false);
    expect(
      providerKeyWasDeleted(
        { status: 200, json: { provider: "anthropic", deleted: true } },
        "openai"
      )
    ).toBe(false);
  });

  it("holds when the account holds no key for that provider afterwards", () => {
    expect(providerKeyIsAbsent({ status: 200, json: { providerKey: null } })).toBe(true);
  });

  it("fails when a key is still stored after the removal", () => {
    expect(
      providerKeyIsAbsent({
        status: 200,
        json: { providerKey: { provider: "openai", status: "active" } }
      })
    ).toBe(false);
    expect(providerKeyIsAbsent({ status: 200, json: {} })).toBe(false);
  });
});

describe("signOutConfirmed", () => {
  it("holds when the deployment says the session ended", () => {
    expect(signOutConfirmed({ status: 200, json: { signedOut: true } })).toBe(true);
  });

  // The status alone was the whole predicate, so a sign-out that answered 200 without ending
  // anything read the same as one that did.
  it("fails when the answer does not say the session ended", () => {
    expect(signOutConfirmed({ status: 200, json: { signedOut: false } })).toBe(false);
    expect(signOutConfirmed({ status: 200, json: {} })).toBe(false);
    expect(signOutConfirmed({ status: 401, json: { code: "unauthorized" } })).toBe(false);
  });
});

describe("drainsSucceeded", () => {
  it("holds when every queue answered the drain", () => {
    expect(drainsSucceeded({ captures: 200, maintenance: 200, indexing: 200 })).toBe(true);
  });

  // The gate drains three queues and used to hold only the first to an answer, so a maintenance
  // or indexing drain that refused the secret never showed up as a drain failure.
  it("fails when a queue behind the first one refused the drain", () => {
    expect(drainsSucceeded({ captures: 200, maintenance: 401, indexing: 200 })).toBe(false);
    expect(drainsSucceeded({ captures: 200, maintenance: 200, indexing: 500 })).toBe(false);
  });

  it("fails when no drain was attempted", () => {
    expect(drainsSucceeded({ skipped: true })).toBe(false);
    expect(drainsSucceeded(null)).toBe(false);
  });
});
