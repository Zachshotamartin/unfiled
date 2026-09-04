import { CaptureCreateRequestSchema, type CaptureCreateRequest } from "@unfiled/contracts";

import {
  uploadPendingPhotos,
  withStoredPhotos,
  type CaptureAttachmentTransport,
  type PendingCapturePhoto
} from "./capture-attachment-upload";
import { submitDurably } from "./capture-queue";
import type { CaptureLocalStore, CaptureOutboxItem } from "./capture-store";

export type CaptureSubmission =
  | Readonly<{ item: CaptureOutboxItem; status: "queued" }>
  | Readonly<{ message: string; photos: readonly PendingCapturePhoto[]; status: "photos_unsent" }>;

/**
 * One capture with the photos it carries. The photos go up first, each one once; only when every
 * one of them is stored does the capture join the outbox naming them, and from there the outbox
 * keeps it until the server has it.
 *
 * A photo that cannot be uploaded stops the capture: nothing is queued, and the photos come back
 * so the composer can keep them in front of the owner. That is the whole point of this function.
 * The outbox seals JSON and has nowhere to keep bytes, so a capture queued without its photo
 * would be a capture filed as text with the picture gone — the defect the phone shipped and then
 * fixed, and the one shape of this feature that must never exist.
 */
export async function submitCaptureWithPhotos(
  store: Pick<CaptureLocalStore, "enqueueCapture">,
  transport: CaptureAttachmentTransport,
  input: Readonly<{
    now: number;
    photos: readonly PendingCapturePhoto[];
    profileId: string;
    request: CaptureCreateRequest;
  }>,
  acknowledge: (item: CaptureOutboxItem) => void,
  scheduleFlush: () => void
): Promise<CaptureSubmission> {
  const request = CaptureCreateRequestSchema.parse(input.request);
  if (input.photos.length === 0) {
    const item = await submitDurably(
      store,
      input.profileId,
      request,
      input.now,
      acknowledge,
      scheduleFlush
    );
    return Object.freeze({ item, status: "queued" });
  }
  const outcome = await uploadPendingPhotos(transport, {
    captureId: request.clientCaptureId,
    photos: input.photos,
    privacy: request.privacy
  });
  if (outcome.status === "unsent") {
    return Object.freeze({
      message: outcome.message,
      photos: withStoredPhotos(input.photos, outcome.storedIds),
      status: "photos_unsent"
    });
  }
  const item = await submitDurably(
    store,
    input.profileId,
    { ...request, attachmentIds: [...outcome.storedIds] },
    input.now,
    acknowledge,
    scheduleFlush
  );
  return Object.freeze({ item, status: "queued" });
}
