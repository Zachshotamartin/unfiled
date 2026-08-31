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
    retryCapture: overrides.retryCapture ?? vi.fn().mockResolvedValue(captureV1ResponseFixture)
  };
}

describe("capture route handlers", () => {
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

    await expect(detail.json()).resolves.toEqual(queuedDetail);
    await expect(receipt.json()).resolves.toEqual(inboxReceipt);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect(receipt.headers.get("cache-control")).toBe("no-store");
    expect(malformed.status).toBe(400);
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
