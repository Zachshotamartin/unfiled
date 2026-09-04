// The decisions the live gate makes about what production gave back, kept apart from the requests
// that fetched it. They live here because they are the whole value of the gate: a step that reports
// green on an outcome which filed nothing is worse than no step at all, so every one of these
// expressions is held by gate-checks.test.mjs instead of only by production.
//
// Each function takes what the gate already has in hand — an `api()` result, or a receipt — and
// answers one question in the terms the step name uses.

/**
 * The note a receipt filed into, or null when the capture filed nothing. A capture waiting in
 * review has no note yet, and that is exactly the state every "filed note" assertion must fail on.
 */
export function filedNoteId(receipt) {
  const noteId = receipt?.destination?.noteId ?? null;
  return typeof noteId === "string" && noteId.length > 0 ? noteId : null;
}

/** The body production served for a note, or the empty string when it served no note at all. */
function bodyMarkdown(note) {
  if (note?.status !== 200) return "";
  const body = note.json?.note?.bodyMarkdown;
  return typeof body === "string" ? body : "";
}

/**
 * A filed note that carries the photo its capture was created with. The reference is what the
 * phone reads to draw the picture, so a note without it is a photo the owner cannot see.
 */
export function noteReferencesAttachment(note, attachmentId) {
  return bodyMarkdown(note).includes(`unfiled-attachment:${attachmentId}`);
}

/**
 * The owner's directions steer the organizer and are never part of what they wrote, so the filed
 * note has to carry the capture's own words and none of the directions.
 */
export function noteKeepsTextWithoutDirections(note, { captureText, directions }) {
  const body = bodyMarkdown(note);
  return body.includes(captureText) && !body.includes(directions);
}

/**
 * Exactly the uploaded attachments are bound to the capture, in the order they were sent. Order is
 * part of the contract: the organizer places references in the order the capture carries them.
 */
export function captureBindsAttachments(capture, attachmentIds) {
  if (capture?.status !== 200) return false;
  const attachments = capture.json?.capture?.attachments;
  if (!Array.isArray(attachments)) return false;
  const bound = attachments.map((attachment) => attachment?.id ?? null);
  return (
    bound.length === attachmentIds.length &&
    bound.every((id, position) => id === attachmentIds[position])
  );
}
