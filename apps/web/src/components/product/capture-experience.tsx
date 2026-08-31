"use client";

import {
  CaptureCreateRequestSchema,
  createEntityId,
  type CaptureSummary,
  type EntityId,
  type NoteSummary
} from "@unfiled/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { createIdempotencyKey } from "@/lib/product/client";
import { browserCaptureStore } from "@/lib/capture/browser-capture-store";
import { replayPendingCaptureActions, runCaptureAction } from "@/lib/capture/capture-action-runner";
import type { CaptureLocalAction } from "@/lib/capture/capture-action";
import {
  CAPTURE_POLL_INTERVAL_MS,
  flushCaptureOutbox,
  mergeCaptureActivity,
  submitDurably
} from "@/lib/capture/capture-queue";
import type { CaptureOutboxStatus } from "@/lib/capture/capture-store";

import { CaptureActivity } from "./capture-activity";
import { CaptureComposer, type CaptureComposerValue } from "./capture-composer";

const EMPTY_COMPOSER: CaptureComposerValue = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  privacy: "ai_assisted",
  rawContent: ""
});

function clientTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function hasDraft(value: CaptureComposerValue): boolean {
  return (
    value.rawContent.length > 0 ||
    value.explicitDestinationNoteId !== null ||
    value.privacy !== "ai_assisted" ||
    value.expansionDisabled
  );
}

export function CaptureExperience() {
  const activeProfile = useRef<string | null>(null);
  const flushPromise = useRef<Promise<void> | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [composer, setComposer] = useState<CaptureComposerValue>(EMPTY_COMPOSER);
  const [notes, setNotes] = useState<readonly NoteSummary[]>([]);
  const [localItems, setLocalItems] = useState<readonly CaptureOutboxStatus[]>([]);
  const [remoteItems, setRemoteItems] = useState<readonly CaptureSummary[]>([]);
  const [actions, setActions] = useState<readonly CaptureLocalAction[]>([]);
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadLocal = useCallback(async (profile: string): Promise<void> => {
    try {
      const items = await browserCaptureStore.listOutboxStatus(profile);
      if (activeProfile.current === profile) setLocalItems(items);
    } catch {
      if (activeProfile.current === profile) {
        setStorageError(
          "Encrypted browser storage could not be opened. Your draft was not changed."
        );
      }
    }
  }, []);

  const loadActions = useCallback(async (profile: string): Promise<void> => {
    try {
      const items = await browserCaptureStore.listActions(profile);
      if (activeProfile.current === profile) setActions(items);
    } catch {
      if (activeProfile.current === profile) {
        setStorageError("Encrypted browser actions could not be opened. Reload before retrying.");
      }
    }
  }, []);

  const loadRemote = useCallback(async (profile: string): Promise<void> => {
    try {
      const response = await browserApi.listCaptures({ limit: 50 });
      if (activeProfile.current !== profile) return;
      setRemoteItems(response.items);
      setActivityError(null);
    } catch (reason) {
      if (activeProfile.current !== profile) return;
      setActivityError(
        productErrorMessage(reason, "Server activity is unavailable. Local captures remain saved.")
      );
    }
  }, []);

  const loadNotes = useCallback(async (profile: string): Promise<void> => {
    try {
      const response = await browserApi.listNotes({ limit: 100 });
      if (activeProfile.current === profile) setNotes(response.items);
    } catch {
      if (activeProfile.current === profile) setNotes([]);
    }
  }, []);

  const flush = useCallback(
    async (profile: string): Promise<void> => {
      if (activeProfile.current !== profile) return;
      if (flushPromise.current !== null) return flushPromise.current;
      const task = (async () => {
        try {
          await flushCaptureOutbox(browserCaptureStore, profile, browserApi, Date.now());
          await replayPendingCaptureActions(
            browserCaptureStore,
            profile,
            browserApi,
            Date.now(),
            createIdempotencyKey
          );
        } catch {
          if (activeProfile.current === profile) {
            setStorageError("Saved captures could not be read locally. Reload before retrying.");
          }
        }
        await Promise.all([loadActions(profile), loadLocal(profile), loadRemote(profile)]);
      })();
      flushPromise.current = task;
      try {
        await task;
      } finally {
        flushPromise.current = null;
      }
    },
    [loadActions, loadLocal, loadRemote]
  );

  useEffect(() => {
    let cancelled = false;
    async function initialize(): Promise<void> {
      try {
        const session = await browserApi.getAuthSession();
        if (cancelled) return;
        const profile = session.user.id;
        activeProfile.current = profile;
        setProfileId(profile);
        await browserCaptureStore.recoverInterrupted(profile, Date.now());
        const draft = await browserCaptureStore.loadDraft(profile);
        if (activeProfile.current !== profile) return;
        if (draft !== null) {
          setComposer({
            expansionDisabled: draft.expansionDisabled,
            explicitDestinationNoteId: draft.explicitDestinationNoteId,
            privacy: draft.privacy,
            rawContent: draft.rawContent
          });
        }
        await Promise.all([
          loadActions(profile),
          loadLocal(profile),
          loadRemote(profile),
          loadNotes(profile)
        ]);
        if (activeProfile.current !== profile) return;
        setHydrated(true);
        window.setTimeout(() => void flush(profile), 0);
      } catch {
        if (!cancelled) {
          setStorageError("Capture storage could not start. Reload before writing anything new.");
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }
    void initialize();
    return () => {
      cancelled = true;
      activeProfile.current = null;
    };
  }, [flush, loadActions, loadLocal, loadNotes, loadRemote]);

  useEffect(() => {
    if (!hydrated || profileId === null) return;
    const timer = window.setTimeout(() => {
      const operation = hasDraft(composer)
        ? browserCaptureStore.saveDraft(profileId, {
            ...composer,
            updatedAt: new Date().toISOString()
          })
        : browserCaptureStore.deleteDraft(profileId);
      void operation.catch(() => {
        setStorageError("This draft could not be saved locally. Keep this tab open and try again.");
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [composer, hydrated, profileId]);

  useEffect(() => {
    if (!hydrated || profileId === null) return;
    const refresh = (): void => {
      void flush(profileId);
    };
    const interval = window.setInterval(refresh, CAPTURE_POLL_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [flush, hydrated, profileId]);

  useEffect(() => {
    if (profileId === null || remoteItems.length === 0) return;
    const remoteIds = new Set(remoteItems.map((item) => item.id));
    const completed = localItems.filter(
      (item) => item.state === "synced" && remoteIds.has(item.clientCaptureId)
    );
    if (completed.length === 0) return;
    void Promise.all(
      completed.map((item) => browserCaptureStore.deleteOutbox(profileId, item.clientCaptureId))
    )
      .then(() => loadLocal(profileId))
      .catch(() => {
        if (activeProfile.current === profileId) {
          setStorageError("Synced capture cleanup will be retried after reload.");
        }
      });
  }, [loadLocal, localItems, profileId, remoteItems]);

  const hiddenCaptureIds = useMemo(
    () =>
      new Set(
        actions.flatMap((action) =>
          action.actionType === "delete_capture" || action.actionType === "capture_tombstone"
            ? [action.captureId]
            : []
        )
      ),
    [actions]
  );

  const activity = useMemo(
    () => mergeCaptureActivity(localItems, remoteItems, hiddenCaptureIds),
    [hiddenCaptureIds, localItems, remoteItems]
  );

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setComposerError(null);
    setAcknowledgement(null);
    if (profileId === null) {
      setComposerError("Encrypted browser storage is still starting.");
      return;
    }
    if (composer.rawContent.trim().length === 0) {
      setComposerError("Write something before saving.");
      return;
    }
    if (composer.rawContent.length > 10_000) {
      setComposerError("Captures can contain up to 10,000 characters.");
      return;
    }
    const now = Date.now();
    const request = CaptureCreateRequestSchema.parse({
      clientCaptureId: createEntityId("cap"),
      rawContent: composer.rawContent,
      source: "web",
      clientCreatedAt: new Date(now).toISOString(),
      clientTimezone: clientTimezone(),
      privacy: composer.privacy,
      expansionDisabled: composer.privacy === "private_manual" || composer.expansionDisabled,
      ...(composer.explicitDestinationNoteId === null
        ? {}
        : { explicitDestinationNoteId: composer.explicitDestinationNoteId })
    });
    setSubmitting(true);
    try {
      await submitDurably(
        browserCaptureStore,
        profileId,
        request,
        now,
        () => {
          setComposer(EMPTY_COMPOSER);
          setAcknowledgement(navigator.onLine ? "Saved" : "Saved. Waiting to sync.");
          void loadLocal(profileId);
        },
        () => window.setTimeout(() => void flush(profileId), 0)
      );
      try {
        await browserCaptureStore.deleteDraft(profileId);
      } catch {
        setStorageError("The capture was saved, but its old draft could not be cleared.");
      }
    } catch {
      setComposerError("This capture could not be saved securely. Nothing was sent.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryLocal(captureId: EntityId<"cap">): Promise<void> {
    if (profileId === null) return;
    try {
      await browserCaptureStore.manualRetry(profileId, captureId, Date.now());
      await loadLocal(profileId);
      window.setTimeout(() => void flush(profileId), 0);
    } catch {
      setStorageError("This saved capture could not be read locally. Reload before retrying.");
    }
  }

  async function retryRemote(captureId: EntityId<"cap">): Promise<void> {
    if (profileId === null) return;
    try {
      const intent = await browserCaptureStore.ensureRetryCaptureAction(
        profileId,
        captureId,
        { idempotencyKey: createIdempotencyKey() },
        Date.now()
      );
      const resumed = await browserCaptureStore.resumeAction(profileId, intent, Date.now());
      const result = await runCaptureAction(
        browserCaptureStore,
        profileId,
        resumed,
        browserApi,
        Date.now(),
        createIdempotencyKey
      );
      await Promise.all([loadActions(profileId), loadRemote(profileId)]);
      if (result.status === "rejected") {
        setActivityError(productErrorMessage(result.reason, "This capture could not be retried."));
      }
    } catch (reason) {
      setActivityError(productErrorMessage(reason, "This capture could not be retried."));
    }
  }

  return (
    <>
      {storageError === null ? null : (
        <p className="capture-storage-error" role="alert">
          {storageError}
        </p>
      )}
      <CaptureComposer
        acknowledgement={acknowledgement}
        disabled={initializing || submitting || storageError !== null}
        error={composerError}
        notes={notes}
        onChange={setComposer}
        onSubmit={(event) => void submit(event)}
        value={composer}
      />
      <CaptureActivity
        error={activityError}
        items={activity}
        loading={initializing}
        onRetryLocal={(captureId) => void retryLocal(captureId)}
        onRetryRemote={(captureId) => void retryRemote(captureId)}
      />
    </>
  );
}
