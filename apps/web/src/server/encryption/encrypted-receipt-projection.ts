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
