import type { PrivacyMode } from "@unfiled/contracts";
import type { CaptureReceiptPayload } from "@unfiled/encrypted-aggregate";

type ReceiptProjection = Readonly<{
  recordVersion: number;
  privacy: PrivacyMode;
  decisionId: string | null;
  reviewItemId: string | null;
  mutationId: string | null;
  outcome: "created_note" | "added_to_note" | "kept_in_inbox" | "needs_review" | "failed";
  reasonCodes: readonly string[];
}>;

/**
 * The organizer's commit function projects one content-free reason onto a `needs_review`
 * receipt row (`ambiguous_intent` for planner ambiguity, `revision_conflict`, or
 * `explicit_destination` when the explicit destination was unavailable) while the
 * authenticated payload keeps the plan's own reasons. Accept exactly that shape and nothing else.
 */
const REVIEW_REASON_PROJECTIONS: ReadonlySet<string> = new Set([
  "ambiguous_intent",
  "revision_conflict",
  "explicit_destination"
]);

export function reviewReceiptProjectionMatches(
  payload: CaptureReceiptPayload,
  row: ReceiptProjection
): boolean {
  const projected = row.reasonCodes[0];
  return (
    row.privacy === "ai_assisted" &&
    row.recordVersion === 1 &&
    row.outcome === "needs_review" &&
    payload.outcome === "needs_review" &&
    row.decisionId !== null &&
    row.reviewItemId !== null &&
    row.mutationId === null &&
    row.reasonCodes.length === 1 &&
    projected !== undefined &&
    REVIEW_REASON_PROJECTIONS.has(projected) &&
    (projected !== "ambiguous_intent" || payload.reasonCodes.includes("ambiguous_intent"))
  );
}

const ACCEPTED = "expansion_accepted";
const REJECTED = "expansion_rejected";
const DESTINATION_EXPIRED = "destination_expired";

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function generatedReferences(payload: CaptureReceiptPayload): readonly string[] {
  return payload.insertedContentReferences.flatMap((reference) =>
    reference.type === "ai_generated" ? [reference.blockId] : []
  );
}

/**
 * E3 deliberately stores content-free lifecycle sentinels in the relational
 * receipt projection while the authenticated payload retains its original
 * routing reasons. Keep this exception exact and separate from ordinary
 * reason equality so arbitrary projection drift still fails closed.
 */
export function generatedExpansionReceiptProjectionMatches(
  payload: CaptureReceiptPayload,
  row: ReceiptProjection,
  expectedBlockId?: string
): boolean {
  if (row.privacy !== "ai_assisted" || payload.schemaVersion !== 2) return false;

  const routed = row.outcome === "created_note" || row.outcome === "added_to_note";
  const references = generatedReferences(payload);
  if (row.reasonCodes.length === 1 && row.reasonCodes[0] === "expansion_pending") {
    return (
      row.recordVersion === 1 &&
      routed &&
      row.decisionId !== null &&
      row.reviewItemId !== null &&
      row.mutationId !== null &&
      payload.reviewItemId === row.reviewItemId &&
      references.length === 1 &&
      (expectedBlockId === undefined || references[0] === expectedBlockId) &&
      !payload.reasonCodes.some(
        (reason) => reason === ACCEPTED || reason === REJECTED || reason === DESTINATION_EXPIRED
      )
    );
  }

  const terminal = row.reasonCodes[0];
  if (terminal !== ACCEPTED && terminal !== REJECTED) return false;
  if (
    row.recordVersion < 2 ||
    row.decisionId === null ||
    row.reviewItemId !== null ||
    payload.reviewItemId !== null ||
    row.reasonCodes.length > 2 ||
    (row.reasonCodes.length === 2 && row.reasonCodes[1] !== DESTINATION_EXPIRED)
  ) {
    return false;
  }
  const authenticatedLifecycleReasons = payload.reasonCodes.filter(
    (reason) => reason === ACCEPTED || reason === REJECTED || reason === DESTINATION_EXPIRED
  );
  if (!sameStrings(authenticatedLifecycleReasons, row.reasonCodes)) return false;

  if (routed) {
    return (
      row.mutationId !== null &&
      (terminal === ACCEPTED
        ? references.length === 1 &&
          (expectedBlockId === undefined || references[0] === expectedBlockId)
        : references.length === 0)
    );
  }
  return row.outcome === "kept_in_inbox" && row.mutationId === null && references.length === 0;
}
