import type { CaptureKind, NoteType } from "@unfiled/contracts";

/**
 * The kind a plan is judged by. The deterministic reading of the text's shape is authoritative
 * when it found structure: a delimited list, a measured log line, a labelled principle, a project
 * update. When it found none -- the capture is "freeform", a sentence with no shape -- the model
 * may say the capture is really one item for a list or one entry for a log, because "eggs for the
 * weekend" belongs in Groceries and only a reader knows that. Any other disagreement is the model
 * contradicting what the text plainly is, and stays a disagreement.
 */
export function reconcileCaptureKind(
  inferred: CaptureKind,
  planned: CaptureKind
): CaptureKind | null {
  if (planned === inferred) return inferred;
  if (inferred === "freeform" && (planned === "list_items" || planned === "log_entry")) {
    return planned;
  }
  return null;
}

/**
 * How well a note of this type holds a capture of this kind: 1 when the note is made of exactly
 * this (an item in a list, an entry in a log), 0.25 when a shapeless thought lands in a note
 * built for something else, 0 when the note cannot hold it at all.
 */
export function captureKindTypeCompatibility(kind: CaptureKind, noteType: NoteType): number {
  if (kind === "list_items") return noteType === "list" ? 1 : 0;
  if (kind === "log_entry") return noteType === "log" ? 1 : 0;
  if (kind === "project_update") return noteType === "project" ? 1 : 0;
  if (kind === "principle") return noteType === "principle" ? 1 : 0;
  return noteType === "generic" ? 1 : 0.25;
}
