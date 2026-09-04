import { ApiClientError, type CaptureAttachmentUploadInput } from "@unfiled/api-client";
import type { CaptureAttachment, EntityId, PrivacyMode } from "@unfiled/contracts";

import type { PreparedCaptureImage } from "./capture-image-preparation";

/**
 * One photo the owner added to the capture they are writing: prepared for sending, drawn from
 * `previewUrl` while it waits, and marked `stored` once the server holds its bytes. The mark is
 * what makes a second attempt cheap — an attachment already stored is not sent twice.
 */
export type PendingCapturePhoto = Readonly<{
  attachmentId: EntityId<"att">;
  image: PreparedCaptureImage;
  previewUrl: string;
  stored: boolean;
}>;

export type CaptureAttachmentTransport = Readonly<{
  uploadCaptureAttachment: (input: CaptureAttachmentUploadInput) => Promise<CaptureAttachment>;
}>;

export type CaptureAttachmentUploadOutcome =
  | Readonly<{ status: "stored"; storedIds: readonly EntityId<"att">[] }>
  | Readonly<{ message: string; status: "unsent"; storedIds: readonly EntityId<"att">[] }>;

/**
 * What the owner is told when a photo could not be sent. The words carry three facts, because
 * leaving any of them out is how a photo goes missing: the capture was not saved, the photo is
 * still in front of them, and what they can do next. The phone keeps bytes in its own database
 * until the network returns; a browser tab has nowhere to keep them, so the honest answer is to
 * refuse the capture rather than file the words and drop the picture.
 */
export function captureAttachmentFailureMessage(reason: unknown, photoCount: number): string {
  const photos = photoCount === 1 ? "photo" : "photos";
  if (reason instanceof ApiClientError) {
    return `${reason.message} Nothing was saved, so your words and ${photos} are still here. Save again, or remove the ${photos} to save the words on their own.`;
  }
  return `Your ${photos} could not be uploaded, so nothing was saved. Photos are sent when you save and are not kept on this device — check your connection and save again, or remove the ${photos} to save the words on their own.`;
}

/**
 * Sends every photo the capture will name, each one once, before the capture exists. An
 * attachment is uploaded under the capture's own id and bound when that capture is created; one
 * that never gets bound is swept by the server, so stopping at the first failure leaves nothing
 * behind but the owner's photo, still in the composer.
 */
export async function uploadPendingPhotos(
  transport: CaptureAttachmentTransport,
  input: Readonly<{
    captureId: EntityId<"cap">;
    photos: readonly PendingCapturePhoto[];
    privacy: PrivacyMode;
  }>
): Promise<CaptureAttachmentUploadOutcome> {
  const storedIds: EntityId<"att">[] = [];
  for (const photo of input.photos) {
    if (photo.stored) {
      storedIds.push(photo.attachmentId);
      continue;
    }
    try {
      await transport.uploadCaptureAttachment({
        attachmentId: photo.attachmentId,
        bytes: photo.image.bytes,
        captureId: input.captureId,
        durationMs: null,
        height: photo.image.height,
        kind: "image",
        mediaType: photo.image.mediaType,
        privacy: input.privacy,
        width: photo.image.width
      });
    } catch (reason) {
      return Object.freeze({
        message: captureAttachmentFailureMessage(reason, input.photos.length),
        status: "unsent",
        storedIds: Object.freeze([...storedIds])
      });
    }
    storedIds.push(photo.attachmentId);
  }
  return Object.freeze({ status: "stored", storedIds: Object.freeze([...storedIds]) });
}

/** The same photos, with the ones the server now holds marked so they are not sent again. */
export function withStoredPhotos(
  photos: readonly PendingCapturePhoto[],
  storedIds: readonly EntityId<"att">[]
): readonly PendingCapturePhoto[] {
  const stored = new Set<string>(storedIds);
  return Object.freeze(
    photos.map((photo) =>
      photo.stored || !stored.has(photo.attachmentId) ? photo : { ...photo, stored: true }
    )
  );
}
