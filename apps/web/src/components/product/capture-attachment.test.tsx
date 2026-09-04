import type { CaptureAttachment as CaptureAttachmentDto } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaptureAttachment, CaptureAttachments, captureAttachmentUrl } from "./capture-attachment";

function attachment(overrides: Partial<CaptureAttachmentDto> = {}): CaptureAttachmentDto {
  return {
    byteLength: 41_233,
    createdAt: "2026-09-03T18:30:00.000Z",
    durationMs: null,
    height: 1568,
    id: "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    kind: "image",
    mediaType: "image/jpeg",
    width: 1176,
    ...overrides
  };
}

describe("capture attachments", () => {
  it("reads the bytes back through the owner's own session", () => {
    expect(captureAttachmentUrl("att_01ARZ3NDEKTSV4RRFFQ69G5FAZ")).toBe(
      "/api/v1/captures/attachments/att_01ARZ3NDEKTSV4RRFFQ69G5FAZ"
    );
  });

  it("shows a capture's photo rather than naming it", () => {
    const html = renderToStaticMarkup(<CaptureAttachments attachments={[attachment()]} />);

    expect(html).toContain("<img");
    expect(html).toContain('src="/api/v1/captures/attachments/att_01ARZ3NDEKTSV4RRFFQ69G5FAZ"');
    expect(html).toContain('alt="Photo on this capture"');
  });

  it("keeps a portrait photo's shape in its thumbnail", () => {
    const html = renderToStaticMarkup(
      <CaptureAttachment
        attachmentId="att_01ARZ3NDEKTSV4RRFFQ69G5FAZ"
        height={1568}
        kind="image"
        width={1176}
      />
    );

    // The longest edge sets the box; the other follows, so nothing is squashed into a square.
    expect(html).toContain('height="168"');
    expect(html).toContain('width="126"');
  });

  it("names a recording instead of drawing it as a broken picture", () => {
    const html = renderToStaticMarkup(
      <CaptureAttachments
        attachments={[
          attachment({
            durationMs: 4_200,
            height: null,
            id: "att_01ARZ3NDEKTSV4RRFFQ69G5FAY",
            kind: "audio",
            mediaType: "audio/mp4",
            width: null
          })
        ]}
      />
    );

    expect(html).toContain("Recording");
    expect(html).not.toContain("<img");
  });

  it("draws nothing when a capture carries no photo", () => {
    expect(renderToStaticMarkup(<CaptureAttachments attachments={[]} />)).toBe("");
  });
});
