import {
  captureV1Fixture,
  captureV1ListFixture,
  captureV1ResponseFixture,
  type CaptureDeleteResponse,
  type CaptureDetailResponse,
  type CaptureReceiptResponse
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequest } from "@/server/auth/session";
import type { CaptureRepository } from "@/server/captures/repository";

import { createCaptureHandlers } from "./capture-handlers";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function authenticated(): Promise<AuthenticatedRequest> {
  return Promise.resolve({
    accessToken: "test-access-token",
    cookies: ["refreshed=true; HttpOnly"],
    user: { id: USER_ID, email: "person@example.com" }
  });
}

function request(
  path: string,
  method = "GET",
  body?: Readonly<Record<string, unknown>>,
  idempotencyKey?: string
): Request {
  return new Request(`https://unfiled.test${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

const queuedDetail: CaptureDetailResponse = {
  capture: {
    ...captureV1ResponseFixture.capture,
    jobId: captureV1ResponseFixture.jobId,
    receipt: null
  }
};

const inboxReceipt: CaptureReceiptResponse = {
  receipt: {
    schemaVersion: 1,
    captureId: captureV1Fixture.clientCaptureId,
    jobId: captureV1ResponseFixture.jobId,
    decisionId: null,
    reviewItemId: null,
    mutationId: null,
    outcome: "kept_in_inbox",
    headline: "Kept in Inbox",
    destination: null,
    insertedContent: [],
    actions: [],
    reasonCodes: [],
    createdAt: "2026-08-30T18:30:03.000Z"
  }
};

const ATTACHMENT_ID = "att_01J6M9Q7G4BMKB33GSG3NJ6D1Z";
const JPEG_BYTES = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70]);
const uploadedAttachment = {
  id: ATTACHMENT_ID,
  kind: "image",
  mediaType: "image/jpeg",
  byteLength: JPEG_BYTES.byteLength,
  width: 1568,
  height: 1044,
  durationMs: null,
  createdAt: "2026-09-03T10:00:00.000Z"
} as const;

function upload(
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
  idempotencyKey: string | null = ATTACHMENT_ID
): Request {
  return new Request("https://unfiled.test/api/v1/captures/attachments", {
    method: "POST",
    headers: {
      "content-type": "image/jpeg",
      "x-unfiled-capture-id": captureV1Fixture.clientCaptureId,
      "x-unfiled-privacy": "ai_assisted",
      "x-unfiled-width": "1568",
      "x-unfiled-height": "1044",
      ...(idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }),
      ...headers
    },
    body: bytes
  });
}

const deletedCapture: CaptureDeleteResponse = {
  captureId: captureV1Fixture.clientCaptureId,
  deletedAt: "2026-08-30T18:35:00.000Z",
  sourceRemovedFromNoteIds: [],
  removedInsertedContent: false,
  contentRemovalMutations: [],
  replayed: false
};

function repository(overrides: Partial<CaptureRepository> = {}): CaptureRepository {
  return {
    createCapture: overrides.createCapture ?? vi.fn().mockResolvedValue(captureV1ResponseFixture),
    deleteCapture: overrides.deleteCapture ?? vi.fn().mockResolvedValue(deletedCapture),
    getCapture: overrides.getCapture ?? vi.fn().mockResolvedValue(queuedDetail),
    getReceipt: overrides.getReceipt ?? vi.fn().mockResolvedValue(inboxReceipt),
    listCaptures: overrides.listCaptures ?? vi.fn().mockResolvedValue(captureV1ListFixture),
    retryCapture: overrides.retryCapture ?? vi.fn().mockResolvedValue(captureV1ResponseFixture),
    createAttachment: overrides.createAttachment ?? vi.fn().mockResolvedValue(uploadedAttachment),
    getAttachment:
      overrides.getAttachment ??
      vi.fn().mockResolvedValue({ attachment: uploadedAttachment, bytes: JPEG_BYTES })
  };
}

describe("capture route handlers", () => {
  it("passes the request to a request-scoped repository factory", async () => {
    const captureRepository = repository();
    const factory = vi.fn(() => captureRepository);
    const handlers = createCaptureHandlers({ authenticate: authenticated, repository: factory });
    const incoming = request("/api/v1/captures?limit=1");

    await handlers.listCaptures(incoming);

    expect(factory).toHaveBeenCalledWith(incoming);
  });

  it("accepts a validated capture with caller-owned idempotency and schedules prompt processing", async () => {
    const captureRepository = repository();
    const scheduleDrain = vi.fn();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository,
      scheduleDrain
    });
    const response = await handlers.createCapture(
      request("/api/v1/captures", "POST", captureV1Fixture, captureV1Fixture.clientCaptureId)
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("refreshed=true");
    await expect(response.json()).resolves.toEqual(captureV1ResponseFixture);
    expect(captureRepository.createCapture).toHaveBeenCalledWith(
      { accessToken: "test-access-token", userId: USER_ID },
      captureV1Fixture
    );
    expect(scheduleDrain).toHaveBeenCalledOnce();
  });

  it("rejects blank content and mismatched idempotency without touching storage", async () => {
    const captureRepository = repository();
    const scheduleDrain = vi.fn();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository,
      scheduleDrain
    });
    const blank = await handlers.createCapture(
      request(
        "/api/v1/captures",
        "POST",
        { ...captureV1Fixture, rawContent: "   " },
        captureV1Fixture.clientCaptureId
      )
    );
    const mismatch = await handlers.createCapture(
      request("/api/v1/captures", "POST", captureV1Fixture, "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y")
    );

    expect(blank.status).toBe(400);
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      code: "invalid_idempotency_key"
    });
    expect(captureRepository.createCapture).not.toHaveBeenCalled();
    expect(scheduleDrain).not.toHaveBeenCalled();
  });

  it("validates list filters and schedules recovery after an owner read", async () => {
    const captureRepository = repository();
    const scheduleDrain = vi.fn();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository,
      scheduleDrain
    });
    const response = await handlers.listCaptures(request("/api/v1/captures?status=done&limit=25"));
    const unknown = await handlers.listCaptures(request("/api/v1/captures?includeCiphertext=true"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(captureV1ListFixture);
    expect(captureRepository.listCaptures).toHaveBeenCalledWith(
      { accessToken: "test-access-token", userId: USER_ID },
      { limit: 25, status: "done" }
    );
    expect(scheduleDrain).toHaveBeenCalledOnce();
    expect(unknown.status).toBe(400);
    expect(captureRepository.listCaptures).toHaveBeenCalledOnce();
  });

  it("serves detail and terminal receipt without caching and rejects malformed IDs", async () => {
    const captureRepository = repository();
    const scheduleDrain = vi.fn();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository,
      scheduleDrain
    });
    const detail = await handlers.getCapture(request("/api/v1/captures/id"), {
      captureId: captureV1Fixture.clientCaptureId
    });
    const receipt = await handlers.getReceipt(request("/api/v1/captures/id/receipt"), {
      captureId: captureV1Fixture.clientCaptureId
    });
    const malformed = await handlers.getCapture(request("/api/v1/captures/nope"), {
      captureId: "nope"
    });
    const malformedReceipt = await handlers.getReceipt(request("/api/v1/captures/nope/receipt"), {
      captureId: "nope"
    });

    await expect(detail.json()).resolves.toEqual(queuedDetail);
    await expect(receipt.json()).resolves.toEqual(inboxReceipt);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect(receipt.headers.get("cache-control")).toBe("private, no-store");
    expect(receipt.headers.get("pragma")).toBe("no-cache");
    expect(malformed.status).toBe(400);
    expect(malformedReceipt.status).toBe(400);
    expect(malformedReceipt.headers.get("cache-control")).toBe("private, no-store");
    expect(malformedReceipt.headers.get("pragma")).toBe("no-cache");
    expect(scheduleDrain).toHaveBeenCalledTimes(2);
  });

  it("retries failed captures and soft deletes through explicit idempotent writes", async () => {
    const captureRepository = repository();
    const scheduleDrain = vi.fn();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository,
      scheduleDrain
    });
    const retry = await handlers.retryCapture(
      request(
        "/api/v1/captures/id/retry",
        "POST",
        { idempotencyKey: "retry-capture-once" },
        "retry-capture-once"
      ),
      { captureId: captureV1Fixture.clientCaptureId }
    );
    const remove = await handlers.deleteCapture(
      request(
        "/api/v1/captures/id",
        "DELETE",
        { idempotencyKey: "delete-capture-once" },
        "delete-capture-once"
      ),
      { captureId: captureV1Fixture.clientCaptureId }
    );

    expect(retry.status).toBe(202);
    expect(remove.status).toBe(200);
    expect(captureRepository.retryCapture).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      captureV1Fixture.clientCaptureId,
      "retry-capture-once"
    );
    expect(captureRepository.deleteCapture).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      captureV1Fixture.clientCaptureId,
      {
        idempotencyKey: "delete-capture-once",
        removeInsertedContent: false,
        expectedNoteRevisions: []
      }
    );
    expect(scheduleDrain).toHaveBeenCalledOnce();
  });

  it("does not schedule processing when persistence fails", async () => {
    const captureRepository = repository({
      createCapture: vi.fn().mockRejectedValue(new Error("sensitive detail"))
    });
    const scheduleDrain = vi.fn();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository,
      scheduleDrain
    });
    const response = await handlers.createCapture(
      request("/api/v1/captures", "POST", captureV1Fixture, captureV1Fixture.clientCaptureId)
    );
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(500);
    expect(body.message).not.toContain("sensitive");
    expect(scheduleDrain).not.toHaveBeenCalled();
  });
});

describe("capture attachment handlers", () => {
  it("stores an uploaded photo under the owner's capture id and answers without the bytes", async () => {
    const captureRepository = repository();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository
    });

    const response = await handlers.uploadAttachment(upload(JPEG_BYTES, {}));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(uploadedAttachment);
    expect(captureRepository.createAttachment).toHaveBeenCalledWith(
      { accessToken: "test-access-token", userId: USER_ID },
      {
        attachmentId: ATTACHMENT_ID,
        captureId: captureV1Fixture.clientCaptureId,
        kind: "image",
        mediaType: "image/jpeg",
        privacy: "ai_assisted",
        width: 1568,
        height: 1044,
        durationMs: null,
        bytes: JPEG_BYTES
      }
    );
  });

  it("stores a recording with its duration", async () => {
    const captureRepository = repository();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository
    });
    const request = new Request("https://unfiled.test/api/v1/captures/attachments", {
      method: "POST",
      headers: {
        "content-type": "audio/mp4",
        "idempotency-key": ATTACHMENT_ID,
        "x-unfiled-capture-id": captureV1Fixture.clientCaptureId,
        "x-unfiled-privacy": "private_manual",
        "x-unfiled-duration-ms": "4200"
      },
      body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
    });

    const response = await handlers.uploadAttachment(request);

    expect(response.status).toBe(201);
    expect(captureRepository.createAttachment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "audio",
        mediaType: "audio/mp4",
        privacy: "private_manual",
        durationMs: 4200,
        width: null,
        height: null
      })
    );
  });

  it("refuses uploads with a missing or foreign idempotency key, a bad capture id, or dimensions that do not fit the kind", async () => {
    const captureRepository = repository();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository
    });

    expect((await handlers.uploadAttachment(upload(JPEG_BYTES, {}, null))).status).toBe(400);
    expect(
      (await handlers.uploadAttachment(upload(JPEG_BYTES, {}, "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Z")))
        .status
    ).toBe(400);
    expect(
      (await handlers.uploadAttachment(upload(JPEG_BYTES, { "x-unfiled-capture-id": "nope" })))
        .status
    ).toBe(400);
    expect(
      (await handlers.uploadAttachment(upload(JPEG_BYTES, { "x-unfiled-width": "0" }))).status
    ).toBe(400);
    expect(
      (await handlers.uploadAttachment(upload(JPEG_BYTES, { "x-unfiled-duration-ms": "10" })))
        .status
    ).toBe(400);
    expect(
      (await handlers.uploadAttachment(upload(JPEG_BYTES, { "x-unfiled-privacy": "secret" })))
        .status
    ).toBe(400);
    expect(captureRepository.createAttachment).not.toHaveBeenCalled();
  });

  it("serves the owner's attachment bytes with its media type and never caches them", async () => {
    const captureRepository = repository();
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository
    });

    const response = await handlers.getAttachment(
      request(`/api/v1/captures/attachments/${ATTACHMENT_ID}`),
      { attachmentId: ATTACHMENT_ID }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBe(String(JPEG_BYTES.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    expect(captureRepository.getAttachment).toHaveBeenCalledWith(
      { accessToken: "test-access-token", userId: USER_ID },
      ATTACHMENT_ID
    );
  });

  it("answers not found for a missing attachment and rejects malformed ids", async () => {
    const captureRepository = repository({ getAttachment: vi.fn().mockResolvedValue(null) });
    const handlers = createCaptureHandlers({
      authenticate: authenticated,
      repository: captureRepository
    });

    const missing = await handlers.getAttachment(
      request(`/api/v1/captures/attachments/${ATTACHMENT_ID}`),
      { attachmentId: ATTACHMENT_ID }
    );
    expect(missing.status).toBe(404);
    const malformed = await handlers.getAttachment(request("/api/v1/captures/attachments/x"), {
      attachmentId: "x"
    });
    expect(malformed.status).toBe(400);
  });
});
