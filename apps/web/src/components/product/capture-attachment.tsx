import type { CaptureAttachment as CaptureAttachmentDto } from "@unfiled/contracts";

import { UnfiledGlyph } from "./unfiled-glyph";

/**
 * Where the decrypted bytes come from. `GET /api/v1/captures/attachments/{id}` answers with the
 * attachment's real media type under the owner's own session, so the browser can render a photo
 * directly; nothing about the file is placed in a URL beyond its id.
 */
export function captureAttachmentUrl(attachmentId: string): string {
  return `/api/v1/captures/attachments/${attachmentId}`;
}

/** The longest edge a thumbnail is drawn at, so a portrait photo keeps its shape. */
const THUMBNAIL_EDGE = 168;

function thumbnailSize(
  width: number | null,
  height: number | null
): Readonly<{ height: number; width: number }> {
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { height: THUMBNAIL_EDGE, width: THUMBNAIL_EDGE };
  }
  const scale = THUMBNAIL_EDGE / Math.max(width, height);
  return { height: Math.round(height * scale), width: Math.round(width * scale) };
}

/**
 * One photo, or one recording named as a recording. A recording is not an image, so it is drawn
 * as a labelled row rather than a broken picture.
 */
export function CaptureAttachment({
  attachmentId,
  caption,
  height = null,
  kind,
  width = null
}: Readonly<{
  attachmentId: string;
  caption?: string;
  height?: number | null;
  kind: CaptureAttachmentDto["kind"];
  width?: number | null;
}>) {
  if (kind === "audio") {
    return (
      <span className="attachment-recording">
        <UnfiledGlyph glyph="microphone" size={17} weight={1.9} /> {caption ?? "Recording"}
      </span>
    );
  }
  const size = thumbnailSize(width, height);
  return (
    <figure className="attachment-figure">
      {/*
        A plain <img> rather than next/image: the bytes are private, served no-store through the
        owner's session, and must never pass through the image optimizer's cache.
      */}
      <img
        alt={caption ?? "Photo on this capture"}
        height={size.height}
        loading="lazy"
        src={captureAttachmentUrl(attachmentId)}
        width={size.width}
      />
      {caption === undefined ? null : <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Every photo and recording bound to a capture, in upload order. */
export function CaptureAttachments({
  attachments
}: Readonly<{ attachments: readonly CaptureAttachmentDto[] }>) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-grid" aria-label="Photos and recordings on this capture">
      {attachments.map((attachment) => (
        <CaptureAttachment
          key={attachment.id}
          attachmentId={attachment.id}
          height={attachment.height}
          kind={attachment.kind}
          width={attachment.width}
        />
      ))}
    </div>
  );
}
