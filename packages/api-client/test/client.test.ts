import {
  captureV1DetailFixture,
  captureV1Fixture,
  captureV1ListFixture,
  captureV1ReceiptFixture,
  captureV1ResponseFixture
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/index.js";

const CAPTURE_ID = captureV1Fixture.clientCaptureId;
const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const ATTACHMENT_ID = "att_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("Milestone C capture API client", () => {
  it("creates with the stable client capture ID as the retry-safe idempotency header", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(captureV1ResponseFixture, 202));
    const client = createApiClient({
      baseUrl: "https://example.test/",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("access-token")
    });

    await expect(client.createCapture(captureV1Fixture)).resolves.toEqual(captureV1ResponseFixture);

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example.test/api/v1/captures");
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(captureV1Fixture));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: "Bearer access-token",
      "content-type": "application/json",
      "idempotency-key": CAPTURE_ID
    });
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("rejects invalid capture bodies before any network request", () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("access-token")
    });

    expect(() =>
      client.createCapture({ ...captureV1Fixture, rawContent: "x".repeat(10_001) })
    ).toThrow();
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("lists captures with strict pagination, processing-state, and date filters", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(captureV1ListFixture));
    const client = createApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("access-token")
    });

    await expect(
      client.listCaptures({
        cursor: "next-page",
        from: "2026-08-29T00:00:00.000Z",
        limit: 20,
        status: "failed",
        to: "2026-08-30T00:00:00.000Z"
      })
    ).resolves.toEqual(captureV1ListFixture);
    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(
      "https://example.test/api/v1/captures?status=failed&limit=20&cursor=next-page&from=2026-08-29T00%3A00%3A00.000Z&to=2026-08-30T00%3A00%3A00.000Z"
    );
    expect(() => client.listCaptures({ limit: 101 })).toThrow();
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it("loads durable detail and receipt views from their canonical endpoints", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(captureV1DetailFixture))
      .mockResolvedValueOnce(jsonResponse({ receipt: captureV1ReceiptFixture }));
    const client = createApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("access-token")
    });

    await expect(client.getCapture(CAPTURE_ID)).resolves.toEqual(captureV1DetailFixture);
    await expect(client.getCaptureReceipt(CAPTURE_ID)).resolves.toEqual({
      receipt: captureV1ReceiptFixture
    });
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      `https://example.test/api/v1/captures/${CAPTURE_ID}`,
      `https://example.test/api/v1/captures/${CAPTURE_ID}/receipt`
    ]);
  });

  it("retries and deletes with explicit caller-owned idempotency keys", async () => {
    const deleteResponse = {
      captureId: CAPTURE_ID,
      contentRemovalMutations: [],
      deletedAt: "2026-08-30T18:35:00.000Z",
      removedInsertedContent: false,
      replayed: false,
      sourceRemovedFromNoteIds: [NOTE_ID]
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(captureV1ResponseFixture, 202))
      .mockResolvedValueOnce(jsonResponse(deleteResponse));
    const client = createApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("access-token")
    });

    await expect(
      client.retryCapture(CAPTURE_ID, { idempotencyKey: "capture-retry-01" })
    ).resolves.toEqual(captureV1ResponseFixture);
    await expect(
      client.deleteCapture(CAPTURE_ID, { idempotencyKey: "capture-delete-01" })
    ).resolves.toEqual(deleteResponse);

    expect(fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method])).toEqual([
      [`https://example.test/api/v1/captures/${CAPTURE_ID}/retry`, "POST"],
      [`https://example.test/api/v1/captures/${CAPTURE_ID}`, "DELETE"]
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "idempotency-key": "capture-retry-01"
    });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      "idempotency-key": "capture-delete-01"
    });
  });

  it("validates path IDs and deletion revision requirements before the request boundary", () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("access-token")
    });

    expect(() => client.getCapture("cap_bad")).toThrow();
    expect(() =>
      client.deleteCapture(CAPTURE_ID, {
        idempotencyKey: "capture-delete-02",
        removeInsertedContent: true
      })
    ).toThrow();
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("uploads one photo as raw bytes under its own identifier as the idempotency key", async () => {
    const attachment = {
      id: ATTACHMENT_ID,
      kind: "image" as const,
      mediaType: "image/jpeg" as const,
      byteLength: JPEG.byteLength,
      width: 1568,
      height: 1044,
      durationMs: null,
      createdAt: "2026-09-03T10:00:00.000Z"
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(attachment, 201));
    const client = createApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("access-token")
    });

    await expect(
      client.uploadCaptureAttachment({
        attachmentId: attachment.id,
        captureId: CAPTURE_ID,
        kind: "image",
        mediaType: "image/jpeg",
        privacy: "ai_assisted",
        width: 1568,
        height: 1044,
        durationMs: null,
        bytes: JPEG
      })
    ).resolves.toEqual(attachment);
    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(
      "https://example.test/api/v1/captures/attachments"
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "content-type": "image/jpeg",
      "idempotency-key": attachment.id,
      "x-unfiled-capture-id": CAPTURE_ID,
      "x-unfiled-privacy": "ai_assisted",
      "x-unfiled-width": "1568",
      "x-unfiled-height": "1044"
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("x-unfiled-duration-ms");
    // A photo carries dimensions and no duration; the client refuses the wrong shape before it
    // puts owner media on the wire.
    expect(() =>
      client.uploadCaptureAttachment({
        attachmentId: attachment.id,
        captureId: CAPTURE_ID,
        kind: "image",
        mediaType: "image/jpeg",
        privacy: "ai_assisted",
        width: null,
        height: null,
        durationMs: 4_200,
        bytes: JPEG
      })
    ).toThrow();
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it("reads attachment bytes only from an uncacheable private response", async () => {
    const privateResponse = () =>
      new Response(JPEG.slice(), {
        headers: {
          "cache-control": "private, no-store",
          "content-type": "image/jpeg",
          pragma: "no-cache"
        },
        status: 200
      });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(privateResponse()));
    const client = createApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("access-token")
    });

    const read = await client.getCaptureAttachment(ATTACHMENT_ID);
    expect(read.mediaType).toBe("image/jpeg");
    expect([...read.bytes]).toEqual([...JPEG]);
    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(
      `https://example.test/api/v1/captures/attachments/${ATTACHMENT_ID}`
    );

    const cacheable = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JPEG.slice(), {
        headers: { "content-type": "image/jpeg" },
        status: 200
      })
    );
    const permissive = createApiClient({
      baseUrl: "https://example.test",
      fetch: cacheable,
      getAccessToken: () => Promise.resolve("access-token")
    });
    await expect(permissive.getCaptureAttachment(ATTACHMENT_ID)).rejects.toMatchObject({
      name: "ApiClientMalformedResponseError"
    });
    expect(() => client.getCaptureAttachment("att_bad")).toThrow();
  });
});
