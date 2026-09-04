/**
 * What the organizer reads a capture as.
 *
 * A capture whose only content is an upload still has to satisfy the capture API's non-empty
 * content rule, so the client sends a short placeholder in place of words the owner never
 * typed. The placeholder exists so the Inbox has a row to draw; it is not the owner's writing,
 * it must never be filed as if it were, and it must never be what candidates are matched
 * against — matching a photo of a shopping list on the word "Photo" finds nothing.
 */

/**
 * The client placeholders, matched exactly after normalization. An owner who types one of
 * these words and also attaches a photo is indistinguishable from one who typed nothing; the
 * photo still reaches the note either way, so the placeholder reading is the safe one.
 */
const UPLOAD_PLACEHOLDERS: ReadonlySet<string> = new Set(["photo", "photos", "voice note"]);

/** A capture as the organizer holds it while routing: the owner's text plus what it carries. */
export type RoutedCaptureContent = Readonly<{
  /** Exactly what the capture API stored, placeholder included. */
  rawContent: string;
  /** How many photos and recordings the owner attached to this capture. */
  attachmentCount: number;
  /**
   * A short factual description the model derived from the photos. It is the organizer's
   * reading of the images, never the owner's words: it chooses candidates and classifies the
   * capture, and is never written into a note.
   */
  visualDescriptor?: string | null;
}>;

function normalizedPlaceholder(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("und");
}

/** True when the capture carries uploads and its text is only the client's stand-in for them. */
export function isUploadPlaceholderCapture(capture: RoutedCaptureContent): boolean {
  return (
    capture.attachmentCount > 0 &&
    UPLOAD_PLACEHOLDERS.has(normalizedPlaceholder(capture.rawContent))
  );
}

/**
 * The words the owner actually typed, and the empty string when they typed none. This is the
 * text a note must preserve, so an upload-only capture preserves nothing and the note holds
 * only what the owner uploaded.
 */
export function ownerCaptureText(capture: RoutedCaptureContent): string {
  return isUploadPlaceholderCapture(capture) ? "" : capture.rawContent;
}

/**
 * The text the capture kind is inferred from. The model's reading of the photos speaks only
 * when the owner wrote nothing, so a photo of a handwritten principle can be classified as one
 * while a typed capture is still classified by its own words.
 */
export function captureKindText(capture: RoutedCaptureContent): string {
  const owner = ownerCaptureText(capture);
  return owner.length > 0 ? owner : (capture.visualDescriptor ?? "");
}

/**
 * The text candidates are retrieved and scored against. Both the owner's words and the model's
 * reading of the photos count here: they are two descriptions of one capture, and a query is
 * only ever a query.
 */
export function captureRetrievalText(capture: RoutedCaptureContent): string {
  const descriptor = capture.visualDescriptor ?? "";
  return [ownerCaptureText(capture), descriptor].filter((part) => part.length > 0).join("\n");
}
