import type { CaptureRetryRequest, EntityId, MutationUndoRequest } from "@unfiled/contracts";

export type CaptureActionIntentKind = "delete" | "retry" | "undo";
export type CaptureActionIntentState = "pending" | "succeeded";

export type CaptureActionIntent = Readonly<{
  actionSignature: string;
  actionType: CaptureActionIntentKind;
  idempotencyKey: string;
  profileId: string;
  requestJson: string;
  state: CaptureActionIntentState;
  targetId: string;
}>;

export interface PersistedCaptureDeleteRequest {
  expectedNoteRevisions: {
    expectedRevision: number;
    noteId: EntityId<"note">;
  }[];
  idempotencyKey: string;
  removeInsertedContent: boolean;
}

export type CaptureDeleteIntent = CaptureActionIntent &
  Readonly<{
    actionType: "delete";
    captureId: `cap_${string}`;
    request: PersistedCaptureDeleteRequest;
  }>;

export function captureRetrySignature(captureId: string, failureReceiptCreatedAt: string): string {
  return `retry:${captureId}:${failureReceiptCreatedAt}`;
}

export function captureUndoSignature(mutationId: string, expectedRevision: number): string {
  return `undo:${mutationId}:${expectedRevision}`;
}

export function captureDeleteSignature(
  captureId: string,
  request: Omit<PersistedCaptureDeleteRequest, "idempotencyKey">
): string {
  const revisions = [...request.expectedNoteRevisions]
    .sort((left, right) => left.noteId.localeCompare(right.noteId))
    .map(({ expectedRevision, noteId }) => `${noteId}@${expectedRevision}`)
    .join(",");
  return `delete:${captureId}:${request.removeInsertedContent ? "content" : "source"}:${revisions}`;
}

export function actionIdempotencyKey(kind: CaptureActionIntentKind, id: string): string {
  return `mobile-${kind}:${id}`;
}

export function serializeCaptureActionRequest(
  request: PersistedCaptureDeleteRequest | CaptureRetryRequest | MutationUndoRequest
): string {
  return JSON.stringify(request);
}
