"use client";

import {
  CaptureCreateRequestSchema,
  createEntityId,
  type CaptureSummary,
  type EntityId,
  type NoteSummary
} from "@unfiled/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent
} from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { createIdempotencyKey } from "@/lib/product/client";
import { browserCaptureStore } from "@/lib/capture/browser-capture-store";
import { replayPendingCaptureActions, runCaptureAction } from "@/lib/capture/capture-action-runner";
import type { CaptureLocalAction } from "@/lib/capture/capture-action";
import type { PendingCapturePhoto } from "@/lib/capture/capture-attachment-upload";
import {
  canSendCapture,
  captureRawContent,
  MAX_CAPTURE_CHARACTERS,
  MAX_CAPTURE_PHOTOS,
  remainingCapturePhotos
} from "@/lib/capture/capture-composer-rules";
import {
  browserImageCodec,
  captureImageFailureMessage,
  prepareCaptureImage
} from "@/lib/capture/capture-image-preparation";
import {
  CAPTURE_POLL_INTERVAL_MS,
  flushCaptureOutbox,
  mergeCaptureActivity
} from "@/lib/capture/capture-queue";
import { submitCaptureWithPhotos } from "@/lib/capture/capture-submission";
import type { CaptureOutboxStatus } from "@/lib/capture/capture-store";

import { CaptureActivity } from "./capture-activity";
import { CaptureComposer, type CaptureComposerValue } from "./capture-composer";

/**
 * Every capture is filed by the organizer (ADR-0021, decision 1). The key class is fixed here
 * rather than chosen per capture, because `claim_organization_jobs` only ever claims a job whose
 * capture is `ai_assisted`.
 */
const CAPTURE_PRIVACY = "ai_assisted" as const;

const EMPTY_COMPOSER: CaptureComposerValue = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  rawContent: ""
});

function clientTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function hasDraft(value: CaptureComposerValue): boolean {
  return (
    value.rawContent.length > 0 ||
    value.explicitDestinationNoteId !== null ||
    value.expansionDisabled
  );
}

/**
 * The Inbox in order (ADR-0019, decision 6): the capture card first, then everything that needs
 * the owner. `reviewDecisions` is the review list the Inbox now carries, since Review is no
 * longer a destination of its own.
 */
export function CaptureExperience({
  reviewDecisions,
  providerKeyMissing = false,
  reviewDecisionsEmpty = true
}: Readonly<{
  providerKeyMissing?: boolean;
  reviewDecisions?: ReactNode;
  reviewDecisionsEmpty?: boolean;
}> = {}) {
  const activeProfile = useRef<string | null>(null);
  const flushPromise = useRef<Promise<void> | null>(null);
  /**
   * The photos of the capture being written, and the capture id they are uploaded under. Both
   * live only as long as this tab: the outbox seals JSON and has nowhere to keep bytes. The id is
   * kept across a failed attempt so a second try binds to the same capture and re-sends nothing
   * the server already holds.
   */
  const pendingPhotos = useRef<readonly PendingCapturePhoto[]>([]);
  const pendingCaptureId = useRef<EntityId<"cap"> | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [composer, setComposer] = useState<CaptureComposerValue>(EMPTY_COMPOSER);
  const [photos, setPhotos] = useState<readonly PendingCapturePhoto[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [preparingPhotos, setPreparingPhotos] = useState(false);
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

  /** Every change to the pending photos goes through here, so the ref is never behind the view. */
  const keepPhotos = useCallback((next: readonly PendingCapturePhoto[]): void => {
    pendingPhotos.current = next;
    setPhotos(next);
  }, []);

  useEffect(
    () => () => {
      for (const photo of pendingPhotos.current) URL.revokeObjectURL(photo.previewUrl);
    },
    []
  );

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
          // A draft saved before ADR-0021 can carry the retired private mode. Its words are
          // restored; the mode is not, so an old draft cannot mint a job nothing will claim.
          setComposer({
            expansionDisabled: draft.expansionDisabled,
            explicitDestinationNoteId: draft.explicitDestinationNoteId,
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
            privacy: CAPTURE_PRIVACY,
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

  /**
   * Prepares each chosen file the way the phone does, and keeps it in front of the owner. A file
   * that is not a photo this API would accept is named here, before anything is sent.
   */
  async function addPhotos(files: readonly File[]): Promise<void> {
    setPhotoError(null);
    const room = remainingCapturePhotos(pendingPhotos.current.length);
    if (room === 0) {
      setPhotoError(`A capture carries up to ${MAX_CAPTURE_PHOTOS} photos.`);
      return;
    }
    setPreparingPhotos(true);
    try {
      const prepared: PendingCapturePhoto[] = [];
      for (const file of files.slice(0, room)) {
        try {
          const image = await prepareCaptureImage(file, browserImageCodec);
          prepared.push({
            attachmentId: createEntityId("att"),
            image,
            previewUrl: URL.createObjectURL(new Blob([image.bytes], { type: image.mediaType })),
            stored: false
          });
        } catch (reason) {
          setPhotoError(captureImageFailureMessage(reason));
        }
      }
      if (files.length > room) {
        setPhotoError(
          `A capture carries up to ${MAX_CAPTURE_PHOTOS} photos, so the rest were not added.`
        );
      }
      if (prepared.length > 0) {
        pendingCaptureId.current ??= createEntityId("cap");
        keepPhotos([...pendingPhotos.current, ...prepared]);
      }
    } finally {
      setPreparingPhotos(false);
    }
  }

  function removePhoto(attachmentId: EntityId<"att">): void {
    setPhotoError(null);
    const removed = pendingPhotos.current.find((photo) => photo.attachmentId === attachmentId);
    if (removed !== undefined) URL.revokeObjectURL(removed.previewUrl);
    // A photo the server already holds stays unbound there, where it is swept within the day.
    // Removing it here is the owner saying this is not the capture it belongs to.
    keepPhotos(pendingPhotos.current.filter((photo) => photo.attachmentId !== attachmentId));
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setComposerError(null);
    setAcknowledgement(null);
    if (profileId === null) {
      setComposerError("Encrypted browser storage is still starting.");
      return;
    }
    const photosToSend = pendingPhotos.current;
    if (!canSendCapture(composer.rawContent, photosToSend.length)) {
      setComposerError(
        composer.rawContent.length > MAX_CAPTURE_CHARACTERS
          ? `Captures can contain up to ${MAX_CAPTURE_CHARACTERS.toLocaleString()} characters.`
          : "Write something or add a photo before saving."
      );
      return;
    }
    const now = Date.now();
    const request = CaptureCreateRequestSchema.parse({
      clientCaptureId: pendingCaptureId.current ?? createEntityId("cap"),
      rawContent: captureRawContent(composer.rawContent, photosToSend.length),
      source: "web",
      clientCreatedAt: new Date(now).toISOString(),
      clientTimezone: clientTimezone(),
      privacy: CAPTURE_PRIVACY,
      expansionDisabled: composer.expansionDisabled,
      ...(composer.explicitDestinationNoteId === null
        ? {}
        : { explicitDestinationNoteId: composer.explicitDestinationNoteId })
    });
    setSubmitting(true);
    try {
      const submission = await submitCaptureWithPhotos(
        browserCaptureStore,
        browserApi,
        { now, photos: photosToSend, profileId, request },
        () => {
          for (const photo of photosToSend) URL.revokeObjectURL(photo.previewUrl);
          keepPhotos([]);
          pendingCaptureId.current = null;
          setComposer(EMPTY_COMPOSER);
          setAcknowledgement(navigator.onLine ? "Saved" : "Saved. Waiting to sync.");
          void loadLocal(profileId);
        },
        () => window.setTimeout(() => void flush(profileId), 0)
      );
      // A photo that could not be uploaded stops the capture, because a browser tab has nowhere
      // to keep its bytes: filing the words alone would lose the picture without saying so.
      if (submission.status === "photos_unsent") {
        keepPhotos(submission.photos);
        setComposerError(submission.message);
        return;
      }
      try {
        await browserCaptureStore.deleteDraft(profileId);
      } catch {
        setStorageError("The capture was saved, but its old draft could not be cleared.");
      }
    } catch {
      setComposerError(
        photosToSend.length === 0
          ? "This capture could not be saved securely. Nothing was sent."
          : "This capture could not be saved securely on this device, so it was not created. Your words and photos are still here: save again."
      );
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
        onAddPhotos={(files) => void addPhotos(files)}
        onChange={setComposer}
        onRemovePhoto={removePhoto}
        onSubmit={(event) => void submit(event)}
        photoError={photoError}
        photos={photos}
        preparingPhotos={preparingPhotos}
        value={composer}
      />
      <CaptureActivity
        error={activityError}
        items={activity}
        loading={initializing}
        onRetryLocal={(captureId) => void retryLocal(captureId)}
        onRetryRemote={(captureId) => void retryRemote(captureId)}
        reviewDecisions={reviewDecisions}
        providerKeyMissing={providerKeyMissing}
        reviewDecisionsEmpty={reviewDecisionsEmpty}
      />
    </>
  );
}
