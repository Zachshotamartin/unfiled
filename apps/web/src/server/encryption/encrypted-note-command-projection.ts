import type { EntityId, NoteStructuredData, PrivacyMode, UserOperation } from "@unfiled/contracts";

import type { EncryptedNoteState } from "./encrypted-note-rpc-adapter";

/**
 * The relational note projection remains intentionally queryable after the
 * encrypted-only cutover, but user-authored content must exist only inside the
 * authenticated ciphertext envelopes. These values satisfy the existing
 * typed-note constraints without carrying a title, body, item, log field, or
 * project checklist value through PostgREST/SQL function arguments.
 */
export function encryptedOnlyStructuredData(type: EncryptedNoteState["type"]): NoteStructuredData {
  if (type === "list") return Object.freeze({ schemaVersion: 1, items: Object.freeze([]) });
  if (type === "log") return Object.freeze({ schemaVersion: 1, entries: Object.freeze([]) });
  if (type === "project") {
    return Object.freeze({ schemaVersion: 1, checklistItems: Object.freeze([]) });
  }
  return Object.freeze({ schemaVersion: 1 });
}

export function encryptedOnlyNoteState(
  noteId: EntityId<"note">,
  state: EncryptedNoteState
): EncryptedNoteState {
  return Object.freeze({
    ...state,
    title: `e-${noteId.toLowerCase()}`,
    bodyMarkdown: "",
    structuredData: encryptedOnlyStructuredData(state.type)
  });
}

export type EncryptedOnlyMutationProjection = Readonly<{
  operations: readonly UserOperation[];
  inverse: readonly UserOperation[];
}>;

/**
 * SQL needs only a valid, content-free operation shape after cutover. The real
 * operations and inverse remain authenticated inside the note-mutation cipher.
 */
export function encryptedOnlyMutationProjection(
  privacy: PrivacyMode
): EncryptedOnlyMutationProjection {
  const sentinel = Object.freeze({ type: "set_privacy" as const, privacy });
  return Object.freeze({
    operations: Object.freeze([sentinel]),
    inverse: Object.freeze([sentinel])
  });
}
