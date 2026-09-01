import { ApiClientError } from "@unfiled/api-client";
import type {
  CaptureDeleteRequest,
  CaptureDeleteResponse,
  CaptureRetryRequest,
  EntityId,
  MutationUndoRequest
} from "@unfiled/contracts";

import type {
  CaptureLocalAction,
  DeleteCaptureIntent,
  RetryCaptureIntent,
  UndoMutationIntent
} from "./capture-action";
import { captureFailurePlan, isRetryableCaptureFailure } from "./capture-queue";
import type { CaptureLocalStore } from "./capture-store";

export const MAX_CAPTURE_ACTION_BATCH = 25;

export interface CaptureActionTransport {
  deleteCapture(
    captureId: EntityId<"cap">,
    input: CaptureDeleteRequest
  ): Promise<CaptureDeleteResponse>;
  retryCapture(captureId: EntityId<"cap">, input: CaptureRetryRequest): Promise<unknown>;
  undoMutation(mutationId: EntityId<"mut">, input: MutationUndoRequest): Promise<unknown>;
  undoMutationBatch(mutationId: EntityId<"mut">, input: MutationUndoRequest): Promise<unknown>;
}

export type CaptureActionRunResult = Readonly<{
  action: CaptureLocalAction;
  deleteResponse?: CaptureDeleteResponse | undefined;
  reason?: unknown;
  status: "completed" | "pending" | "rejected" | "skipped";
}>;

function ready(action: CaptureLocalAction, now: number): boolean {
  if (action.actionType === "capture_tombstone") return false;
  if (action.actionType === "undo_mutation" && action.state !== "pending") return false;
  return action.nextAttemptAt !== null && action.nextAttemptAt <= now;
}

function authoritativeMissing(reason: unknown): boolean {
  return reason instanceof ApiClientError && reason.status === 404;
}

async function deferOrReject(
  store: CaptureLocalStore,
  profileId: string,
  action: RetryCaptureIntent | DeleteCaptureIntent | UndoMutationIntent,
  reason: unknown,
  now: number
): Promise<CaptureActionRunResult> {
  if (!isRetryableCaptureFailure(reason)) {
    await store.removeAction(profileId, action);
    return { action, reason, status: "rejected" };
  }
  const plan = captureFailurePlan(reason, action.attempts + 1, now);
  const pending = {
    ...action,
    attempts: plan.attempts,
    errorCode: plan.errorCode,
    nextAttemptAt: plan.nextAttemptAt,
    updatedAt: now
  };
  await store.saveAction(profileId, pending);
  return { action: pending, reason, status: "pending" };
}

export async function runCaptureAction(
  store: CaptureLocalStore,
  profileId: string,
  action: CaptureLocalAction,
  transport: CaptureActionTransport,
  now: number,
  createKey: () => string
): Promise<CaptureActionRunResult> {
  if (!ready(action, now)) return { action, status: "skipped" };
  if (action.actionType === "retry_capture") {
    try {
      await transport.retryCapture(action.captureId, action.request);
      await store.removeAction(profileId, action);
      return { action, status: "completed" };
    } catch (reason) {
      return deferOrReject(store, profileId, action, reason, now);
    }
  }
  if (action.actionType === "delete_capture") {
    try {
      const response = await transport.deleteCapture(action.captureId, action.request);
      await store.completeCaptureDeletion(profileId, action.captureId, response, now, createKey);
      return { action, deleteResponse: response, status: "completed" };
    } catch (reason) {
      if (authoritativeMissing(reason)) {
        await store.completeCaptureDeletion(profileId, action.captureId, null, now, createKey);
        return { action, status: "completed" };
      }
      return deferOrReject(store, profileId, action, reason, now);
    }
  }
  if (action.actionType !== "undo_mutation" || action.state !== "pending") {
    return { action, status: "skipped" };
  }
  try {
    if (action.source === "receipt") {
      // A receipt mutation can anchor a multi-note correction. The server must
      // derive and undo the complete batch; clients may never choose members.
      await transport.undoMutationBatch(action.mutationId, action.request);
    } else {
      await transport.undoMutation(action.mutationId, action.request);
    }
    const consumed: UndoMutationIntent = {
      ...action,
      errorCode: null,
      nextAttemptAt: null,
      state: "consumed",
      updatedAt: now
    };
    await store.saveAction(profileId, consumed);
    return { action: consumed, status: "completed" };
  } catch (reason) {
    return deferOrReject(store, profileId, action, reason, now);
  }
}

export async function replayPendingCaptureActions(
  store: CaptureLocalStore,
  profileId: string,
  transport: CaptureActionTransport,
  now: number,
  createKey: () => string
): Promise<readonly CaptureActionRunResult[]> {
  const pending = (await store.listActions(profileId))
    .filter((action) => ready(action, now))
    .slice(0, MAX_CAPTURE_ACTION_BATCH);
  const results: CaptureActionRunResult[] = [];
  for (const action of pending) {
    results.push(await runCaptureAction(store, profileId, action, transport, now, createKey));
  }
  return results;
}
