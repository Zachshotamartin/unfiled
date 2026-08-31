"use client";

import {
  ArrowRightIcon,
  CheckCircleIcon,
  TrashIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type {
  CaptureDeleteRequest,
  CaptureDeleteResponse,
  CaptureDetail,
  CaptureReceiptAction,
  EntityId
} from "@unfiled/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { createIdempotencyKey } from "@/lib/product/client";
import type { CaptureLocalAction, UndoMutationIntent } from "@/lib/capture/capture-action";
import { replayPendingCaptureActions, runCaptureAction } from "@/lib/capture/capture-action-runner";
import { browserCaptureStore } from "@/lib/capture/browser-capture-store";
import { CAPTURE_POLL_INTERVAL_MS } from "@/lib/capture/capture-queue";

import { captureStatusLabel } from "./capture-activity";

function receiptMoveUrl(captureId: EntityId<"cap">, decisionId: EntityId<"dec">): string {
  const query = new URLSearchParams({ captureId, decisionId });
  return `/app/review?${query.toString()}`;
}

function ReceiptAction({
  action,
  captureId,
  disabled,
  onUndo,
  undoIntent
}: Readonly<{
  action: CaptureReceiptAction;
  captureId: EntityId<"cap">;
  disabled: boolean;
  onUndo: (action: Extract<CaptureReceiptAction, { type: "undo" }>) => void;
  undoIntent: UndoMutationIntent | null;
}>) {
  if (action.type === "open") {
    return (
      <Link className="button-secondary" href={`/app/notes/${action.noteId}`}>
        Open <ArrowRightIcon size={15} aria-hidden="true" />
      </Link>
    );
  }
  if (action.type === "move") {
    return (
      <Link className="button-secondary" href={receiptMoveUrl(captureId, action.decisionId)}>
        Move <ArrowRightIcon size={15} aria-hidden="true" />
      </Link>
    );
  }
  const consumed = undoIntent?.state === "consumed";
  const waiting = undoIntent?.state === "pending" && undoIntent.nextAttemptAt !== null;
  return (
    <button
      type="button"
      className="button-secondary"
      disabled={disabled || consumed || waiting}
      onClick={() => onUndo(action)}
    >
      {consumed ? "Undone" : waiting ? "Undo pending" : "Undo"}
    </button>
  );
}

export function CaptureDetailView({ captureId }: Readonly<{ captureId: EntityId<"cap"> }>) {
  const activeProfile = useRef<string | null>(null);
  const deleteRequest = useRef<CaptureDeleteRequest | null>(null);
  const [capture, setCapture] = useState<CaptureDetail | null>(null);
  const [deleted, setDeleted] = useState<CaptureDeleteResponse | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [actions, setActions] = useState<readonly CaptureLocalAction[]>([]);
  const [removeInsertedContent, setRemoveInsertedContent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const hidden = actions.some(
      (action) =>
        action.captureId === captureId &&
        (action.actionType === "delete_capture" || action.actionType === "capture_tombstone")
    );
    if (hidden) {
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const response = await browserApi.getCapture(captureId);
      setCapture(response.capture);
      setError(null);
    } catch (reason) {
      setError(productErrorMessage(reason, "This capture could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [actions, captureId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), CAPTURE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const syncActions = useCallback(
    async (profile: string): Promise<void> => {
      try {
        const results = await replayPendingCaptureActions(
          browserCaptureStore,
          profile,
          browserApi,
          Date.now(),
          createIdempotencyKey
        );
        const local = await browserCaptureStore.listActions(profile);
        if (activeProfile.current !== profile) return;
        setActions(local);
        const deletion = results.find(
          (result) => result.action.captureId === captureId && result.deleteResponse !== undefined
        );
        if (deletion?.deleteResponse !== undefined) setDeleted(deletion.deleteResponse);
        const rejected = results.find(
          (result) => result.action.captureId === captureId && result.status === "rejected"
        );
        if (rejected !== undefined) {
          setError(productErrorMessage(rejected.reason, "That saved action was rejected."));
        }
      } catch (reason) {
        if (activeProfile.current === profile) {
          setError(productErrorMessage(reason, "Saved actions could not be resumed."));
        }
      }
    },
    [captureId]
  );

  useEffect(() => {
    let cancelled = false;
    let interval: number | undefined;
    const online = (): void => {
      const profile = activeProfile.current;
      if (profile !== null) void syncActions(profile);
    };
    void browserApi
      .getAuthSession()
      .then((session) => {
        if (cancelled) return;
        const profile = session.user.id;
        activeProfile.current = profile;
        setProfileId(profile);
        void syncActions(profile);
        interval = window.setInterval(() => void syncActions(profile), CAPTURE_POLL_INTERVAL_MS);
        window.addEventListener("online", online);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(productErrorMessage(reason, "Encrypted browser actions could not start."));
        }
      });
    return () => {
      cancelled = true;
      activeProfile.current = null;
      if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener("online", online);
    };
  }, [syncActions]);

  async function undoReceipt(
    action: Extract<CaptureReceiptAction, { type: "undo" }>
  ): Promise<void> {
    setWorking(true);
    setError(null);
    if (profileId === null) {
      setWorking(false);
      setError("Encrypted browser actions are still starting.");
      return;
    }
    try {
      const intent = await browserCaptureStore.ensureUndoMutationAction(
        profileId,
        captureId,
        action.mutationId,
        capture?.receipt?.destination?.noteId ?? null,
        "receipt",
        {
          expectedRevision: action.expectedRevision,
          idempotencyKey: createIdempotencyKey()
        },
        Date.now()
      );
      const resumed = await browserCaptureStore.resumeAction(profileId, intent, Date.now());
      setActions(await browserCaptureStore.listActions(profileId));
      const result = await runCaptureAction(
        browserCaptureStore,
        profileId,
        resumed,
        browserApi,
        Date.now(),
        createIdempotencyKey
      );
      await syncActions(profileId);
      if (result.status === "completed") {
        setActionMessage("The organization change was undone.");
        await refresh();
      } else if (result.status === "rejected") {
        setError(productErrorMessage(result.reason, "That change could not be undone safely."));
      } else {
        setActionMessage("Undo saved. It will retry when the connection recovers.");
      }
    } catch (reason) {
      setError(productErrorMessage(reason, "That change could not be undone safely."));
    } finally {
      setWorking(false);
    }
  }

  async function buildDeleteRequest(): Promise<CaptureDeleteRequest> {
    if (deleteRequest.current !== null) return deleteRequest.current;
    const destination = capture?.receipt?.destination;
    const expectedNoteRevisions = [];
    if (removeInsertedContent && destination !== null && destination !== undefined) {
      const response = await browserApi.getNote(destination.noteId);
      expectedNoteRevisions.push({
        expectedRevision: response.note.currentRevision,
        noteId: destination.noteId
      });
    }
    const request: CaptureDeleteRequest = {
      expectedNoteRevisions,
      idempotencyKey: createIdempotencyKey(),
      removeInsertedContent
    };
    deleteRequest.current = request;
    return request;
  }

  async function deleteCapture(): Promise<void> {
    setWorking(true);
    setError(null);
    if (profileId === null) {
      setWorking(false);
      setError("Encrypted browser actions are still starting.");
      return;
    }
    try {
      const intent = await browserCaptureStore.ensureDeleteCaptureAction(
        profileId,
        captureId,
        await buildDeleteRequest(),
        Date.now()
      );
      const resumed = await browserCaptureStore.resumeAction(profileId, intent, Date.now());
      setActions(await browserCaptureStore.listActions(profileId));
      const result = await runCaptureAction(
        browserCaptureStore,
        profileId,
        resumed,
        browserApi,
        Date.now(),
        createIdempotencyKey
      );
      await syncActions(profileId);
      if (result.status === "completed") {
        setDeleted(result.deleteResponse ?? null);
        setCapture(null);
        setActionMessage("The capture was deleted.");
      } else if (result.status === "rejected") {
        setError(productErrorMessage(result.reason, "This capture could not be deleted."));
        await refresh();
      } else {
        setActionMessage("Deletion saved. It will retry when the connection recovers.");
      }
    } catch (reason) {
      setError(productErrorMessage(reason, "This capture could not be deleted."));
    } finally {
      setWorking(false);
    }
  }

  async function undoContentRemoval(intent: UndoMutationIntent): Promise<void> {
    setWorking(true);
    setError(null);
    if (profileId === null) {
      setWorking(false);
      setError("Encrypted browser actions are still starting.");
      return;
    }
    try {
      const resumed = await browserCaptureStore.resumeAction(profileId, intent, Date.now());
      setActions(await browserCaptureStore.listActions(profileId));
      const result = await runCaptureAction(
        browserCaptureStore,
        profileId,
        resumed,
        browserApi,
        Date.now(),
        createIdempotencyKey
      );
      await syncActions(profileId);
      if (result.status === "completed") {
        setActionMessage("Removed note content was restored.");
      } else if (result.status === "rejected") {
        setError(
          productErrorMessage(
            result.reason,
            "The removed note content could not be restored safely."
          )
        );
      } else {
        setActionMessage("Content restore saved. It will retry when the connection recovers.");
      }
    } catch (reason) {
      setError(
        productErrorMessage(reason, "The removed note content could not be restored safely.")
      );
    } finally {
      setWorking(false);
    }
  }

  const deleteIntent = actions.find(
    (action): action is Extract<CaptureLocalAction, { actionType: "delete_capture" }> =>
      action.actionType === "delete_capture" && action.captureId === captureId
  );
  const tombstone = actions.find(
    (action) => action.actionType === "capture_tombstone" && action.captureId === captureId
  );
  const deletionUndos = actions.filter(
    (action): action is UndoMutationIntent =>
      action.actionType === "undo_mutation" &&
      action.captureId === captureId &&
      action.source === "delete_content"
  );
  const deletedLocally = deleteIntent !== undefined || tombstone !== undefined || deleted !== null;

  if (deletedLocally) {
    const pendingDeletion = deleteIntent !== undefined;
    const removedContent = deleted?.removedInsertedContent === true || deletionUndos.length > 0;
    return (
      <div className="capture-deleted-state">
        {pendingDeletion ? (
          <WarningCircleIcon size={30} className="text-action" aria-hidden="true" />
        ) : (
          <CheckCircleIcon size={30} className="text-action" aria-hidden="true" />
        )}
        <h1>{pendingDeletion ? "Deleting capture." : "Capture deleted."}</h1>
        <p>
          {pendingDeletion
            ? "The deletion is saved securely and this capture is hidden while it completes."
            : `Its source record was removed. Content already added to notes${
                removedContent ? " was removed as requested." : " remains in place."
              }`}
        </p>
        <div className="receipt-actions">
          {deleteIntent?.nextAttemptAt === null ? (
            <button
              type="button"
              className="button-secondary"
              disabled={working}
              onClick={() => void deleteCapture()}
            >
              Retry deletion
            </button>
          ) : null}
          {deletionUndos.map((intent) => {
            const consumed = intent.state === "consumed";
            const waiting = intent.state === "pending" && intent.nextAttemptAt !== null;
            return (
              <button
                key={intent.mutationId}
                type="button"
                className="button-secondary"
                disabled={working || consumed || waiting}
                onClick={() => void undoContentRemoval(intent)}
              >
                {consumed
                  ? "Content restored"
                  : waiting
                    ? "Restore pending"
                    : intent.state === "pending"
                      ? "Retry content restore"
                      : "Undo content removal"}
              </button>
            );
          })}
          <Link href="/app" className="button-primary">
            Back to Today
          </Link>
        </div>
        <p role="status" aria-live="polite" className="mt-4 text-action">
          {actionMessage}
        </p>
        {error === null ? null : (
          <p role="alert" className="mt-4 text-critical">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div aria-label="Loading capture" aria-busy="true" className="capture-detail-header">
        <div className="skeleton-block h-4 w-28" />
        <div className="skeleton-block mt-6 h-16 w-96 max-w-full" />
      </div>
    );
  }

  if (capture === null) {
    return (
      <div className="capture-deleted-state" role="alert">
        <WarningCircleIcon size={30} className="text-action" aria-hidden="true" />
        <h1>Capture unavailable.</h1>
        <p>{error ?? "This capture may have been removed."}</p>
        <Link href="/app" className="button-secondary mt-6">
          Back to Today
        </Link>
      </div>
    );
  }

  const receipt = capture.receipt;
  const canRemoveInsertedContent = Boolean(receipt?.destination) && Boolean(receipt?.mutationId);
  const receiptUndoIntent = actions.find(
    (localAction): localAction is UndoMutationIntent =>
      localAction.actionType === "undo_mutation" &&
      localAction.captureId === captureId &&
      localAction.source === "receipt"
  );

  return (
    <>
      <header className="capture-detail-header">
        <span className="eyebrow">{captureStatusLabel(capture.status)}</span>
        <h1>{receipt?.headline ?? "Capture saved."}</h1>
        <p className="mt-4 text-sm text-muted-content">
          {new Date(capture.clientCreatedAt).toLocaleString()}
        </p>
      </header>
      <section className="capture-original" aria-labelledby="original-capture">
        <span id="original-capture" className="field-label">
          Original capture
        </span>
        <p>{capture.rawContent}</p>
      </section>
      {receipt === null ? (
        <section className="capture-receipt" aria-live="polite">
          <h2>{capture.status === "processing" ? "Finding its place." : "Waiting to begin."}</h2>
          <p className="mt-4 text-muted-content">This page updates every 4 seconds.</p>
        </section>
      ) : (
        <section className="capture-receipt" aria-labelledby="receipt-heading">
          <span className="field-label">Receipt</span>
          <h2 id="receipt-heading" className="mt-3">
            {receipt.headline}
          </h2>
          <div className="receipt-content-list">
            {receipt.insertedContent.map((content, index) => (
              <div
                key={content.type === "ai_generated" ? content.blockId : (content.itemId ?? index)}
                className="receipt-content-item"
              >
                {content.type === "ai_generated" ? (
                  <span className="receipt-generated-label">AI-generated</span>
                ) : null}
                {content.content}
              </div>
            ))}
          </div>
          <div className="receipt-actions">
            {receipt.actions.map((action) => (
              <ReceiptAction
                key={action.type}
                action={action}
                captureId={captureId}
                disabled={working}
                onUndo={(undoAction) => void undoReceipt(undoAction)}
                undoIntent={action.type === "undo" ? (receiptUndoIntent ?? null) : null}
              />
            ))}
          </div>
          <p role="status" aria-live="polite" className="mt-4 text-sm text-action">
            {actionMessage}
          </p>
        </section>
      )}
      {error === null ? null : (
        <p className="capture-inline-error" role="alert">
          <WarningCircleIcon size={17} aria-hidden="true" /> {error}
        </p>
      )}
      <details className="capture-delete-panel">
        <summary>Delete this capture</summary>
        <div className="capture-delete-confirmation">
          <p>
            The source capture will be soft deleted. Content already placed in a note stays there
            with its source marked as removed.
          </p>
          <label className="capture-delete-toggle">
            <input
              type="checkbox"
              checked={removeInsertedContent}
              disabled={!canRemoveInsertedContent || working}
              onChange={(event) => {
                deleteRequest.current = null;
                setRemoveInsertedContent(event.target.checked);
              }}
            />
            Also remove the inserted note content. You can undo that note mutation afterward.
          </label>
          <button
            type="button"
            className="button-secondary w-fit text-critical"
            disabled={working}
            onClick={() => void deleteCapture()}
          >
            <TrashIcon size={16} aria-hidden="true" /> Delete capture
          </button>
        </div>
      </details>
    </>
  );
}
