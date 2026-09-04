import { MAX_CAPTURE_IMAGES } from "@unfiled/contracts";

/**
 * What the composer allows and what it sends when the owner attached photos. These are the
 * phone's `CaptureComposerRules`: a capture written on either client can be sent with words, with
 * photos, or with both, and a capture sent with photos alone still carries text the organizer and
 * the Inbox can show.
 */
export const MAX_CAPTURE_CHARACTERS = 10_000;
export const MAX_CAPTURE_PHOTOS = MAX_CAPTURE_IMAGES;

/** Words or photos are enough to send; too many characters never are. */
export function canSendCapture(content: string, photoCount: number): boolean {
  if (content.length > MAX_CAPTURE_CHARACTERS) return false;
  return content.trim().length > 0 || photoCount > 0;
}

/**
 * The owner's words, or a plain placeholder when they typed nothing, so a capture always has text
 * the organizer and the Inbox can show.
 */
export function captureRawContent(content: string, photoCount: number): string {
  const words = content.trim();
  if (words.length > 0) return words;
  if (photoCount === 1) return "Photo";
  return photoCount > 1 ? "Photos" : "";
}

/** How many more photos this capture can carry. */
export function remainingCapturePhotos(photoCount: number): number {
  return Math.max(0, MAX_CAPTURE_PHOTOS - photoCount);
}
