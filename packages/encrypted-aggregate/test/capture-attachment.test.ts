import { describe, expect, it } from "vitest";

import {
  CAPTURE_ATTACHMENT_MAX_BYTES,
  CaptureAttachmentPayloadSchema,
  type CaptureAttachmentPayload
} from "../src/index.js";
import { IDS, OTHER_IDS, createHarness } from "./harness.js";

const ATTACHMENT_ID = "att_01J6M9Q7G4BMKB33GSG3NJ6D1Z";
const OTHER_ATTACHMENT_ID = "att_01J6M9Q7G4BMKB33GSG3NJ6D2A";

/// The failure code of a rejected promise, so assertions name the exact refusal.
async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error("expected the operation to fail");
}

function base64Of(byteLength: number): string {
  return Buffer.alloc(byteLength, 7).toString("base64");
}

function imagePayload(overrides: Partial<CaptureAttachmentPayload> = {}): CaptureAttachmentPayload {
  return {
    schemaVersion: 1,
    captureId: IDS.capture,
    kind: "image",
    mediaType: "image/jpeg",
    dataBase64: base64Of(12),
    byteLength: 12,
    width: 1568,
    height: 1044,
    ...overrides
  };
}

function audioPayload(): CaptureAttachmentPayload {
  return {
    schemaVersion: 1,
    captureId: IDS.capture,
    kind: "audio",
    mediaType: "audio/mp4",
    dataBase64: base64Of(30),
    byteLength: 30,
    durationMs: 4_200
  };
}

describe("capture attachment payload", () => {
  it("accepts a downscaled JPEG and a short AAC recording", () => {
    expect(CaptureAttachmentPayloadSchema.parse(imagePayload())).toEqual(imagePayload());
    expect(CaptureAttachmentPayloadSchema.parse(audioPayload())).toEqual(audioPayload());
  });

  it("binds the byte length to the encoded data", () => {
    expect(() => CaptureAttachmentPayloadSchema.parse(imagePayload({ byteLength: 11 }))).toThrow();
    expect(() =>
      CaptureAttachmentPayloadSchema.parse(imagePayload({ dataBase64: " " + base64Of(12) }))
    ).toThrow();
  });

  it("refuses anything above the attachment byte cap and accepts the cap itself", () => {
    expect(CAPTURE_ATTACHMENT_MAX_BYTES).toBe(700_000);
    const atCap = imagePayload({
      dataBase64: base64Of(CAPTURE_ATTACHMENT_MAX_BYTES),
      byteLength: CAPTURE_ATTACHMENT_MAX_BYTES
    });
    expect(CaptureAttachmentPayloadSchema.parse(atCap).byteLength).toBe(
      CAPTURE_ATTACHMENT_MAX_BYTES
    );
    const overCap = imagePayload({
      dataBase64: base64Of(CAPTURE_ATTACHMENT_MAX_BYTES + 1),
      byteLength: CAPTURE_ATTACHMENT_MAX_BYTES + 1
    });
    expect(() => CaptureAttachmentPayloadSchema.parse(overCap)).toThrow();
  });

  it("requires the metadata that matches the kind and only the media types the phone produces", () => {
    expect(() =>
      CaptureAttachmentPayloadSchema.parse(imagePayload({ width: undefined }))
    ).toThrow();
    expect(() =>
      CaptureAttachmentPayloadSchema.parse({ ...audioPayload(), durationMs: undefined })
    ).toThrow();
    expect(() => CaptureAttachmentPayloadSchema.parse(imagePayload({ durationMs: 10 }))).toThrow();
    expect(() =>
      CaptureAttachmentPayloadSchema.parse(imagePayload({ mediaType: "image/heic" as never }))
    ).toThrow();
    expect(() =>
      CaptureAttachmentPayloadSchema.parse({ ...audioPayload(), mediaType: "image/jpeg" })
    ).toThrow();
    expect(() => CaptureAttachmentPayloadSchema.parse(imagePayload({ width: 8_001 }))).toThrow();
    expect(() =>
      CaptureAttachmentPayloadSchema.parse({ ...audioPayload(), durationMs: 120_001 })
    ).toThrow();
    expect(() =>
      CaptureAttachmentPayloadSchema.parse({ ...imagePayload(), extra: true })
    ).toThrow();
  });
});

describe("capture attachment sealing", () => {
  it("round-trips under the capture's key class and binds the attachment and capture ids", async () => {
    const harness = await createHarness();
    const sealed = await harness.service.sealCaptureAttachment(harness.accessA, {
      attachmentId: ATTACHMENT_ID,
      captureId: IDS.capture,
      recordVersion: 1,
      privacy: "ai_assisted",
      payload: imagePayload()
    });
    expect(sealed.encrypted.kind).toBe("capture_attachment");
    expect(sealed.encrypted.keyClass).toBe("ai_assisted");
    expect(JSON.stringify(sealed)).not.toContain(base64Of(12));

    const opened = await harness.service.openCaptureAttachment(harness.accessA, sealed, {
      attachmentId: ATTACHMENT_ID,
      captureId: IDS.capture,
      recordVersion: 1,
      privacy: "ai_assisted"
    });
    expect(opened).toEqual(imagePayload());

    expect(
      await failureCode(
        harness.service.openCaptureAttachment(harness.accessA, sealed, {
          attachmentId: OTHER_ATTACHMENT_ID,
          captureId: IDS.capture,
          recordVersion: 1,
          privacy: "ai_assisted"
        })
      )
    ).toBe("invalid_record");
    await expect(
      harness.service.openCaptureAttachment(harness.accessA, sealed, {
        attachmentId: ATTACHMENT_ID,
        captureId: OTHER_IDS.capture,
        recordVersion: 1,
        privacy: "ai_assisted"
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      await failureCode(
        harness.service.openCaptureAttachment(harness.accessB, sealed, {
          attachmentId: ATTACHMENT_ID,
          captureId: IDS.capture,
          recordVersion: 1,
          privacy: "ai_assisted"
        })
      )
    ).toBe("invalid_record");
  });

  it("refuses a payload whose capture id disagrees with the sealing input", async () => {
    const harness = await createHarness();
    await expect(
      harness.service.sealCaptureAttachment(harness.accessA, {
        attachmentId: ATTACHMENT_ID,
        captureId: OTHER_IDS.capture,
        recordVersion: 1,
        privacy: "ai_assisted",
        payload: imagePayload()
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a tampered MAC and a stranger's attachment id", async () => {
    const harness = await createHarness();
    const sealed = await harness.service.sealCaptureAttachment(harness.accessA, {
      attachmentId: ATTACHMENT_ID,
      captureId: IDS.capture,
      recordVersion: 1,
      privacy: "private_manual",
      payload: audioPayload()
    });
    const flipped = sealed.contentMac.value.startsWith("0") ? "1" : "0";
    expect(
      await failureCode(
        harness.service.openCaptureAttachment(
          harness.accessA,
          {
            ...sealed,
            contentMac: {
              ...sealed.contentMac,
              value: `${flipped}${sealed.contentMac.value.slice(1)}`
            }
          },
          {
            attachmentId: ATTACHMENT_ID,
            captureId: IDS.capture,
            recordVersion: 1,
            privacy: "private_manual"
          }
        )
      )
    ).toBe("integrity_check_failed");
    await expect(
      harness.service.sealCaptureAttachment(harness.accessA, {
        attachmentId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Z" as never,
        captureId: IDS.capture,
        recordVersion: 1,
        privacy: "private_manual",
        payload: audioPayload()
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
