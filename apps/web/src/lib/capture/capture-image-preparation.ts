import { CAPTURE_ATTACHMENT_MAX_BYTES } from "@unfiled/contracts";

/**
 * Turns whatever the file picker hands over into the one form that leaves the browser: a JPEG no
 * longer than 1568 px on its long edge, under 700,000 bytes, re-encoded from a bare bitmap so no
 * camera, location or editing metadata survives. This is the phone's `CaptureImagePreparation`
 * step for step, because the same photo filed from either client has to reach the organizer as
 * the same picture.
 */
export const CAPTURE_IMAGE_MAX_LONG_EDGE = 1_568;
export const CAPTURE_IMAGE_MAX_BYTES = CAPTURE_ATTACHMENT_MAX_BYTES;
export const CAPTURE_IMAGE_MEDIA_TYPE = "image/jpeg";

/** The qualities tried in order at one size, and how many sizes are tried before giving up. */
const JPEG_QUALITIES: readonly number[] = Object.freeze([0.8, 0.7, 0.6, 0.5]);
const LONG_EDGE_ATTEMPTS = 4;

/** How much of the long edge survives a round in which no quality was small enough. */
const LONG_EDGE_STEP_NUMERATOR = 3;
const LONG_EDGE_STEP_DENOMINATOR = 4;

export type CaptureImageSize = Readonly<{ height: number; width: number }>;

/** The one form that leaves the browser, with the measurements the upload headers carry. */
export type PreparedCaptureImage = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  height: number;
  mediaType: typeof CAPTURE_IMAGE_MEDIA_TYPE;
  width: number;
}>;

export type CaptureImageFailureCode = "too_large" | "unreadable";

export class CaptureImageError extends Error {
  readonly code: CaptureImageFailureCode;

  constructor(code: CaptureImageFailureCode, message: string) {
    super(message);
    this.name = "CaptureImageError";
    this.code = code;
  }
}

/**
 * Decoding and encoding, kept behind an interface so the rule above can be exercised without a
 * browser. The decoded picture is whatever the codec's decoder produced; nothing here reads it
 * beyond its size.
 */
export interface CaptureImageCodec<TImage extends CaptureImageSize = CaptureImageSize> {
  decode(file: Blob): Promise<TImage>;
  encodeJpeg(
    image: TImage,
    size: CaptureImageSize,
    quality: number
  ): Promise<Uint8Array<ArrayBuffer>>;
  release(image: TImage): void;
}

function unreadable(): CaptureImageError {
  return new CaptureImageError("unreadable", "That file could not be read as a photo");
}

/**
 * The size one round draws at. A photo already smaller than the long edge is left at its own
 * size, exactly as the phone's thumbnail pass leaves it: this pass exists to shrink, never to
 * enlarge, and an enlarged photo would cost bytes without adding detail.
 */
function scaledSize(image: CaptureImageSize, longEdge: number): CaptureImageSize {
  const source = Math.max(image.width, image.height);
  if (!Number.isFinite(source) || source < 1) throw unreadable();
  const scale = Math.min(1, longEdge / source);
  return Object.freeze({
    height: Math.max(1, Math.round(image.height * scale)),
    width: Math.max(1, Math.round(image.width * scale))
  });
}

async function decodeImage<TImage extends CaptureImageSize>(
  file: Blob,
  codec: CaptureImageCodec<TImage>
): Promise<TImage> {
  let image: TImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw unreadable();
  }
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1
  ) {
    codec.release(image);
    throw unreadable();
  }
  return image;
}

async function encodeImage<TImage extends CaptureImageSize>(
  codec: CaptureImageCodec<TImage>,
  image: TImage,
  size: CaptureImageSize,
  quality: number
): Promise<Uint8Array<ArrayBuffer>> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await codec.encodeJpeg(image, size, quality);
  } catch {
    throw unreadable();
  }
  if (bytes.byteLength < 1) throw unreadable();
  return bytes;
}

/**
 * The prepared photo, or a `CaptureImageError` naming why there is none. A file that cannot be
 * decoded is `unreadable`; a picture still over the byte limit after four sizes at four
 * qualities is `too_large`. Neither ever returns bytes the API would refuse.
 */
export async function prepareCaptureImage<TImage extends CaptureImageSize>(
  file: Blob,
  codec: CaptureImageCodec<TImage>
): Promise<PreparedCaptureImage> {
  if (file.size < 1) throw unreadable();
  const image = await decodeImage(file, codec);
  try {
    let longEdge = CAPTURE_IMAGE_MAX_LONG_EDGE;
    for (let attempt = 0; attempt < LONG_EDGE_ATTEMPTS; attempt += 1) {
      const size = scaledSize(image, longEdge);
      for (const quality of JPEG_QUALITIES) {
        const bytes = await encodeImage(codec, image, size, quality);
        if (bytes.byteLength <= CAPTURE_IMAGE_MAX_BYTES) {
          return Object.freeze({
            bytes,
            height: size.height,
            mediaType: CAPTURE_IMAGE_MEDIA_TYPE,
            width: size.width
          });
        }
      }
      longEdge = Math.floor((longEdge * LONG_EDGE_STEP_NUMERATOR) / LONG_EDGE_STEP_DENOMINATOR);
    }
    throw new CaptureImageError("too_large", "That photo is too large to send");
  } finally {
    codec.release(image);
  }
}

/** What the owner is told about a file that never became a photo worth sending. */
export function captureImageFailureMessage(reason: unknown): string {
  if (reason instanceof CaptureImageError && reason.code === "too_large") {
    return "That photo is too detailed to send, even after resizing. Try a smaller picture.";
  }
  return "That file could not be read as a photo. Choose a JPEG, PNG, or HEIC picture.";
}

/**
 * The browser's own decoder and encoder. Drawing the decoded pixels into a canvas and asking the
 * canvas for JPEG bytes writes the bitmap alone, so no camera, location or editing metadata from
 * the original file rides along — the same guarantee the phone gets by encoding from a bare
 * bitmap.
 */
export const browserImageCodec: CaptureImageCodec<ImageBitmap> = Object.freeze({
  decode(file: Blob): Promise<ImageBitmap> {
    // "from-image" applies the file's own orientation the way the phone's thumbnail transform
    // does, so a photo taken sideways is sent the way the owner saw it.
    return createImageBitmap(file, { imageOrientation: "from-image" });
  },

  async encodeJpeg(
    image: ImageBitmap,
    size: CaptureImageSize,
    quality: number
  ): Promise<Uint8Array<ArrayBuffer>> {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw unreadable();
    context.drawImage(image, 0, 0, size.width, size.height);
    const encoded = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, CAPTURE_IMAGE_MEDIA_TYPE, quality);
    });
    // A browser that cannot write JPEG answers with null or with some other type; either way
    // there are no bytes this API would accept, so the file is treated as unreadable.
    if (encoded?.type !== CAPTURE_IMAGE_MEDIA_TYPE) throw unreadable();
    return new Uint8Array(await encoded.arrayBuffer());
  },

  release(image: ImageBitmap): void {
    image.close();
  }
});
