import type {
  CaptureReceipt,
  NoteSummary,
  NoteType,
  OrganizationPlan,
  PublicReviewResolution,
  ReviewItemDto
} from "@unfiled/contracts";
import { parseListLabel } from "@unfiled/ai-routing";

/** The decisions a review item can take, as the phone decides them (PresentationMapping.swift). */
export type ReviewActionKind =
  | "route"
  | "create"
  | "keep_inbox"
  | "dismiss"
  | "keep_both"
  | "accept_expansion"
  | "reject_expansion";

/** A receipt is bound to a review item only when it is the capture's own and names this item. */
export function receiptBoundTo(
  item: ReviewItemDto,
  receipt: CaptureReceipt | null
): CaptureReceipt | null {
  if (receipt === null || item.captureId === null) return null;
  if (receipt.captureId !== item.captureId || receipt.reviewItemId !== item.id) return null;
  return receipt;
}

export function reviewAllowedActions(
  item: ReviewItemDto,
  receipt: CaptureReceipt | null
): readonly ReviewActionKind[] {
  if (item.state !== "open") return [];
  const bound = receiptBoundTo(item, receipt);
  const hasDecision = bound !== null && bound.decisionId !== null;
  const { proposal } = item;

  if (item.type === "low_confidence" && proposal.type === "route_capture") {
    return [
      ...(hasDecision ? (["route", "create"] as const) : []),
      ...(bound !== null ? (["keep_inbox"] as const) : []),
      "dismiss"
    ];
  }
  if (
    (item.type === "revision_conflict" &&
      proposal.type === "conflict" &&
      proposal.reason === "revision") ||
    (item.type === "structure_conflict" &&
      proposal.type === "conflict" &&
      (proposal.reason === "candidate_eligibility" || proposal.reason === "structure"))
  ) {
    const acknowledgementOnly = (bound?.reasonCodes ?? []).includes("conflict_requires_review");
    return [
      ...(hasDecision && !acknowledgementOnly ? (["route", "create"] as const) : []),
      ...(bound !== null ? (["keep_inbox"] as const) : []),
      "dismiss"
    ];
  }
  if (item.type === "failed_job" && proposal.type === "failed_job") {
    return bound !== null ? ["keep_inbox", "dismiss"] : ["dismiss"];
  }
  if (item.type === "duplicate_suggestion" && proposal.type === "duplicate_notes") {
    return ["keep_both", "dismiss"];
  }
  if (item.type === "pending_expansion" && proposal.type === "generated_block") {
    return ["accept_expansion", "reject_expansion"];
  }
  if (
    item.type === "pending_expansion" &&
    proposal.type === "conflict" &&
    proposal.reason === "consent_controls"
  ) {
    return ["dismiss"];
  }
  return [];
}

export function reviewDestinationIsEligible(note: NoteSummary): boolean {
  return note.isOpen && note.archivedAt === null && note.deletedAt === null;
}

/** The organizer's own suggestions, in its order, that are still open notes: at most three. */
export function reviewSuggestedDestinations(
  item: ReviewItemDto,
  notes: readonly NoteSummary[]
): readonly NoteSummary[] {
  if (item.proposal.type !== "route_capture") return [];
  const plan: OrganizationPlan = item.proposal.plan;
  const ids = [plan.destination.candidateId, ...plan.alternatives].filter(
    (id): id is NonNullable<typeof id> => id !== null
  );
  const seen = new Set<string>();
  const suggested: NoteSummary[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const note = notes.find((candidate) => candidate.id === id);
    if (note !== undefined && reviewDestinationIsEligible(note)) suggested.push(note);
    if (suggested.length === 3) break;
  }
  return suggested;
}

export function noteTypeForCaptureKind(kind: OrganizationPlan["captureKind"]): NoteType {
  switch (kind) {
    case "list_items":
      return "list";
    case "log_entry":
      return "log";
    case "principle":
      return "principle";
    case "project_update":
      return "project";
    case "freeform":
      return "generic";
  }
}

/**
 * The title a capture's own words suggest, as the phone suggests it: the name the owner gave a
 * list, or else the first non-empty line, at most sixty characters.
 */
export function suggestedNoteTitle(captureText: string): string {
  const label = parseListLabel(captureText);
  if (label !== null) return Array.from(label.title).slice(0, 60).join("");
  const firstLine =
    captureText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const title = Array.from(firstLine).slice(0, 60).join("").trim();
  return title.length === 0 ? "Untitled" : title;
}

/** The note the organizer proposed to start, when its plan started one. */
export function reviewSuggestedNewNote(
  item: ReviewItemDto
): Readonly<{ noteType: NoteType; title: string }> | null {
  if (item.proposal.type !== "route_capture") return null;
  const newNote = item.proposal.plan.destination.newNote;
  return newNote === null ? null : { noteType: newNote.noteType, title: newNote.title };
}

/**
 * "Let Unfiled decide": the organizer's own suggestion when it made one, otherwise a note of the
 * kind it detected, titled from the capture. Null when neither is allowed.
 */
export function letUnfiledDecide(
  item: ReviewItemDto,
  allowed: readonly ReviewActionKind[],
  notes: readonly NoteSummary[],
  captureText: string
): PublicReviewResolution | null {
  if (item.proposal.type !== "route_capture") return null;
  const suggested = reviewSuggestedDestinations(item, notes)[0];
  if (allowed.includes("route") && suggested !== undefined) {
    return { type: "route", noteId: suggested.id, expectedRevision: suggested.currentRevision };
  }
  if (!allowed.includes("create")) return null;
  return {
    type: "create",
    title: suggestedNoteTitle(captureText),
    noteType: noteTypeForCaptureKind(item.proposal.plan.captureKind),
    spaceId: null
  };
}
