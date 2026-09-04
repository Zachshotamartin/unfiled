// The decisions the live gate makes about what production gave back, kept apart from the requests
// that fetched it. They live here because they are the whole value of the gate: a step that reports
// green on an outcome which filed nothing is worse than no step at all, so every one of these
// expressions is held by gate-checks.test.mjs instead of only by production.
//
// Each function takes what the gate already has in hand — an `api()` result, or a receipt — and
// answers one question in the terms the step name uses.
//
// Two answers are never allowed here. A step must not read a status code where the owner would
// read an effect, because the server saying 200 to a rename is not the name having changed. And a
// step that asks whether something is absent has to prove production served the list or the note it
// is looking in first, or a deployment that serves nothing at all passes every such step.

/** Whether a value is an identifier the gate can hold a reply to, rather than a missing one. */
function isIdentifier(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * The items a list endpoint served, or null when it served no list at all. An absent list and an
 * empty one are different answers, and only that distinction keeps the steps named for something
 * leaving a list from passing against a deployment whose list endpoint broke.
 */
function servedItems(response) {
  if (response?.status !== 200) return null;
  const items = response.json?.items;
  return Array.isArray(items) ? items : null;
}

/** The note a mutation answer carries, or null when the answer carries none. */
function servedNote(response) {
  if (response?.status !== 200) return null;
  const note = response.json?.note;
  return note !== null && typeof note === "object" ? note : null;
}

// ---------------------------------------------------------------- corrections

/**
 * Whether a correction answer leaves the move's outcome unknown to the caller. The API commits
 * the move, then waits a bounded time for the rule observation and answers 503
 * provider_unavailable when that wait runs out (ADR-0011); the move is durable either way, and
 * the contract's next step is the identical request again -- same key, same body -- which opens
 * the stored answer instead of moving anything twice. A platform answer with no product behind
 * it is the same unknown. A definitive refusal (stale revision, validation, forbidden) is not:
 * a replay of it would only repeat the refusal.
 */
export function correctionOutcomeIsAmbiguous(response) {
  if (response === null || typeof response !== "object") return false;
  return response.status >= 500 || response.json?.code === "provider_unavailable";
}

// ---------------------------------------------------------------- captures and receipts

/**
 * The note a receipt filed into, or null when the capture filed nothing. A capture waiting in
 * review has no note yet, and that is exactly the state every "filed note" assertion must fail on.
 */
export function filedNoteId(receipt) {
  const noteId = receipt?.destination?.noteId ?? null;
  return typeof noteId === "string" && noteId.length > 0 ? noteId : null;
}

/**
 * A capture that filed into exactly the note it was meant to reach. A routing rule names its
 * destination, so a capture the rule matched has to arrive there and nowhere else; an outcome of
 * "added_to_note" on its own says only that something chose some note.
 */
export function receiptFiledInto(receipt, noteId) {
  return isIdentifier(noteId) && filedNoteId(receipt) === noteId;
}

/**
 * The receipt endpoint serves the receipt the capture already carries. A capture the gate polled to
 * a terminal state has a receipt, so the two answers have to agree: an endpoint that cannot find
 * it, or that serves another capture's, is the failure this step exists to find. Neither may read
 * as a pass, which is what accepting a 404 beside a 200 used to do.
 */
export function receiptEndpointServesTheCaptureReceipt(read, capture) {
  const carried = capture?.receipt ?? null;
  if (carried === null || read?.status !== 200) return false;
  const served = read.json?.receipt ?? null;
  if (served === null || typeof served !== "object") return false;
  return (
    isIdentifier(capture.captureId) &&
    served.captureId === capture.captureId &&
    served.outcome === carried.outcome &&
    filedNoteId(served) === filedNoteId(carried)
  );
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

/**
 * A replayed upload returned the record the first one stored rather than a second copy of it. The
 * identifier alone proves nothing, because the caller chooses it as the idempotency key and the
 * server echoes back whatever it was sent; the stored measurements and the creation time are what
 * only the first upload's record can carry.
 */
export function uploadReplayIsTheSameAttachment(replayed, uploaded) {
  if (replayed?.status !== 201 || uploaded?.status !== 201) return false;
  const first = uploaded.json;
  const again = replayed.json;
  if (first === null || typeof first !== "object") return false;
  if (again === null || typeof again !== "object") return false;
  if (!isIdentifier(first.id) || !isIdentifier(first.createdAt)) return false;
  const fields = [
    "id",
    "kind",
    "mediaType",
    "byteLength",
    "width",
    "height",
    "durationMs",
    "createdAt"
  ];
  return fields.every((field) => again[field] === first[field]);
}

/** A capture the owner deleted, in the terms the deletion answer itself reports it. */
export function captureWasDeleted(response, captureId) {
  if (response?.status !== 200 || !isIdentifier(captureId)) return false;
  return response.json?.captureId === captureId && isIdentifier(response.json?.deletedAt);
}

// ---------------------------------------------------------------- notes

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
 * A restored note reads as the revision it was restored from. Restoring is the one operation whose
 * whole purpose is the content that comes back, so the revision's own title and body are what the
 * note has to hold afterwards.
 */
export function noteReadsAsRevision(response, revision) {
  const note = servedNote(response);
  if (note === null || revision === null || revision === undefined) return false;
  if (typeof revision.bodyMarkdown !== "string" || typeof revision.title !== "string") return false;
  return note.bodyMarkdown === revision.bodyMarkdown && note.title === revision.title;
}

/** A note carrying the tag the owner linked to it. */
export function noteCarriesTag(response, tagId) {
  const tagIds = servedNote(response)?.tagIds;
  return isIdentifier(tagId) && Array.isArray(tagIds) && tagIds.includes(tagId);
}

/**
 * A note that no longer carries the tag. Unlinking is only proven by a note production actually
 * served: a missing note carries no tags either, and that is not the same answer.
 */
export function noteDroppedTag(response, tagId) {
  const tagIds = servedNote(response)?.tagIds;
  return isIdentifier(tagId) && Array.isArray(tagIds) && !tagIds.includes(tagId);
}

/**
 * A timestamp the note carries because an operation set it. Archiving and deleting are recorded
 * as times, and reading `archivedAt !== null` off a note nobody served answers true, so the field
 * has to be there and has to be a time.
 */
export function noteCarriesTimestamp(response, field) {
  return isIdentifier(servedNote(response)?.[field]);
}

/** A timestamp the note no longer carries, over a note production actually served. */
export function noteClearedTimestamp(response, field) {
  return servedNote(response)?.[field] === null;
}

/** A note carrying the link the owner made, read off the note the mutation answered with. */
export function noteCarriesLinkTo(response, toNoteId, linkType) {
  const links = servedNote(response)?.links;
  if (!Array.isArray(links) || !isIdentifier(toNoteId)) return false;
  return links.some((link) => link?.toNoteId === toNoteId && link?.linkType === linkType);
}

/** A note that no longer links there, over a note production actually served. */
export function noteDroppedLinkTo(response, toNoteId) {
  const links = servedNote(response)?.links;
  if (!Array.isArray(links) || !isIdentifier(toNoteId)) return false;
  return !links.some((link) => link?.toNoteId === toNoteId);
}

/** The link the owner made, found by where it points rather than by how many links came back. */
export function noteLinksTo(response, toNoteId, linkType) {
  // Counting links says a link exists; it does not say this one does. A link to the wrong note, or
  // of the wrong kind, still made the count one, so the gate called linking green whenever the
  // endpoint returned anything at all.
  const items = servedItems(response);
  if (items === null || !isIdentifier(toNoteId) || typeof linkType !== "string") return false;
  return items.some((link) => link?.toNoteId === toNoteId && link?.linkType === linkType);
}

/** The other note's view of that link: a backlink from exactly the note that made it. */
export function noteIsBacklinkedFrom(response, fromNoteId) {
  const items = servedItems(response);
  if (items === null || !isIdentifier(fromNoteId)) return false;
  return items.some((backlink) => backlink?.fromNoteId === fromNoteId);
}

/** The value a log entry's field holds after the owner edited it. */
export function logFieldReads(response, entryId, field, value) {
  const entries = servedNote(response)?.structuredData?.entries;
  if (!Array.isArray(entries) || !isIdentifier(entryId) || typeof value !== "string") return false;
  const entry = entries.find((candidate) => candidate?.id === entryId);
  return entry?.fields?.[field] === value;
}

// ---------------------------------------------------------------- lists and search

/**
 * A list endpoint that served a list. Some of the gate's lists are legitimately empty on a fresh
 * account, and for those this is the whole question: an endpoint that answers 200 with no items
 * array at all is a broken list, not an empty one.
 */
export function listWasServed(response) {
  return servedItems(response) !== null;
}

/** A list production served that carries the entity the step is named for. */
export function listCarriesId(response, id) {
  const items = servedItems(response);
  return items !== null && isIdentifier(id) && items.some((item) => item?.id === id);
}

/**
 * A list production served that no longer carries it. The list has to have been served: a
 * deployment whose list endpoint answers with nothing must not read as one that dropped the entity.
 */
export function listDroppedId(response, id) {
  const items = servedItems(response);
  return items !== null && isIdentifier(id) && !items.some((item) => item?.id === id);
}

/** Search that found the note whose words were searched for, rather than some count of hits. */
export function searchFindsNote(response, noteId) {
  const items = servedItems(response);
  return items !== null && isIdentifier(noteId) && items.some((hit) => hit?.noteId === noteId);
}

/** Search that no longer offers a deleted note, over results production actually served. */
export function searchDroppedNote(response, noteId) {
  const items = servedItems(response);
  return items !== null && isIdentifier(noteId) && !items.some((hit) => hit?.noteId === noteId);
}

// ---------------------------------------------------------------- settings, spaces, tags, rules

/** The settings production serves back carry the values the owner just asked for. */
export function settingsCarry(response, expected) {
  if (response?.status !== 200) return false;
  const settings = response.json?.settings;
  if (settings === null || typeof settings !== "object") return false;
  const fields = Object.entries(expected);
  return fields.length > 0 && fields.every(([field, value]) => settings[field] === value);
}

/** A space under the name the rename asked for. */
export function spaceIsNamed(response, name) {
  return response?.status === 200 && isIdentifier(name) && response.json?.space?.name === name;
}

/** A tag under the name the rename asked for. */
export function tagIsNamed(response, name) {
  return response?.status === 200 && isIdentifier(name) && response.json?.tag?.name === name;
}

/** A routing rule switched the way the owner switched it. */
export function ruleIsEnabled(response, enabled) {
  return response?.status === 200 && response.json?.rule?.enabled === enabled;
}

/** A routing rule the owner removed, in the terms the deletion answer itself reports it. */
export function ruleWasDeleted(response, ruleId) {
  if (response?.status !== 200 || !isIdentifier(ruleId)) return false;
  return response.json?.deleted === true && response.json?.ruleId === ruleId;
}

// ---------------------------------------------------------------- keys, sessions, and the drains

/** A provider key the owner removed, in the terms the deletion answer itself reports it. */
export function providerKeyWasDeleted(response, provider) {
  if (response?.status !== 200 || !isIdentifier(provider)) return false;
  return response.json?.deleted === true && response.json?.provider === provider;
}

/** The account holds no key for that provider, which is what a removal has to leave behind. */
export function providerKeyIsAbsent(response) {
  return response?.status === 200 && response.json?.providerKey === null;
}

/** The session the owner ended, in the terms the sign-out answer itself reports it. */
export function signOutConfirmed(response) {
  return response?.status === 200 && response.json?.signedOut === true;
}

/**
 * Every queue the deployment was asked to drain answered. The gate drains three of them and used
 * to hold only the first to an answer, so a maintenance or indexing drain that refused the secret
 * left the run to fail minutes later inside a search step that names nothing about draining.
 */
export function drainsSucceeded(drained) {
  return drained?.captures === 200 && drained?.maintenance === 200 && drained?.indexing === 200;
}
