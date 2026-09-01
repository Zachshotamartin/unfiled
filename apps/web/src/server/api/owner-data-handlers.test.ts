import { ApiErrorCode, type AccountDeletionReceipt } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequest } from "@/server/auth/session";

import { HttpError } from "./errors";
import { createOwnerDataHandlers } from "./owner-data-handlers";

const TOKEN = `delete_${"A".repeat(43)}`;
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const receipt: AccountDeletionReceipt = {
  schemaVersion: 1,
  deletedAt: "2026-08-31T20:00:00.000Z",
  backupExpiresAt: "2026-09-30T20:00:00.000Z",
  receiptExpiresAt: "2026-10-01T20:00:00.000Z",
  backupRetentionDays: 30,
  liveDataDeleted: true,
  sessionsRevoked: true,
  reRegistrationStartsFresh: true,
  deletedRecordCounts: {
    "auth.sessions": 2,
    "auth.identities": 1,
    "auth.users": 1,
    "public.notes": 17
  },
  replayed: false
};

function session(): AuthenticatedRequest {
  return {
    accessToken: "access-token",
    cookies: ["refreshed=true; HttpOnly"],
    user: { id: OWNER_ID, email: "owner@example.test" }
  };
}

function privateHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

function deletionRequest(
  body: unknown = { confirmation: "DELETE", idempotencyKey: TOKEN },
  header?: string
): Request {
  return new Request("https://unfiled.test/api/v1/me", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...(header === undefined ? {} : { "idempotency-key": header })
    },
    body: JSON.stringify(body)
  });
}

describe("owner data handlers", () => {
  it("streams a private attachment while preserving refreshed auth cookies", async () => {
    const exportAccount = vi.fn(() =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          }
        })
      )
    );
    const handlers = createOwnerDataHandlers({
      authenticate: () => Promise.resolve(session()),
      now: () => new Date("2026-08-31T20:00:00.000Z"),
      service: {
        exportAccount,
        deleteAccount: vi.fn(),
        getDeletionReceipt: vi.fn()
      }
    });
    const response = await handlers.exportAccount(
      new Request("https://unfiled.test/api/v1/me/export")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="unfiled-export-2026-08-31.tar.gz"'
    );
    expect(response.headers.get("set-cookie")).toContain("refreshed=true");
    privateHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(exportAccount).toHaveBeenCalledWith(
      { accessToken: "access-token", userId: OWNER_ID },
      expect.objectContaining({ exportedAt: "2026-08-31T20:00:00.000Z" })
    );
  });

  it("revokes global sessions before atomic deletion and clears local credentials", async () => {
    const order: string[] = [];
    const handlers = createOwnerDataHandlers({
      authenticate: () => Promise.resolve(session()),
      revokeSessions: () => {
        order.push("revoke");
        return Promise.resolve();
      },
      service: {
        exportAccount: vi.fn(),
        deleteAccount: vi.fn(() => {
          order.push("delete");
          return Promise.resolve(receipt);
        }),
        getDeletionReceipt: vi.fn()
      }
    });
    const response = await handlers.deleteAccount(deletionRequest());

    expect(response.status).toBe(200);
    expect(order).toEqual(["revoke", "delete"]);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    privateHeaders(response);
    await expect(response.json()).resolves.toEqual(receipt);
  });

  it("rejects weak, mismatched, oversized, and non-strict deletion bodies before revocation", async () => {
    const revokeSessions = vi.fn(() => Promise.resolve());
    const handlers = createOwnerDataHandlers({
      authenticate: () => Promise.resolve(session()),
      revokeSessions,
      service: {
        exportAccount: vi.fn(),
        deleteAccount: vi.fn(),
        getDeletionReceipt: vi.fn()
      }
    });
    const requests = [
      deletionRequest({ confirmation: "DELETE", idempotencyKey: "weak" }),
      deletionRequest(undefined, `delete_${"B".repeat(43)}`),
      deletionRequest({ confirmation: "DELETE", idempotencyKey: TOKEN, extra: true }),
      new Request("https://unfiled.test/api/v1/me", {
        method: "DELETE",
        headers: { "content-length": "2049", "content-type": "application/json" },
        body: "{}"
      })
    ];
    for (const request of requests) {
      const response = await handlers.deleteAccount(request);
      expect([400, 409, 413]).toContain(response.status);
      privateHeaders(response);
    }
    expect(revokeSessions).not.toHaveBeenCalled();
  });

  it("recovers a lost deletion response through a rate-limited body-only bearer capability", async () => {
    const authenticate = vi.fn(() => Promise.resolve(session()));
    const getDeletionReceipt = vi.fn(() => Promise.resolve({ ...receipt, replayed: true }));
    const handlers = createOwnerDataHandlers({
      authenticate,
      requesterDigest: () => "c".repeat(64),
      service: {
        exportAccount: vi.fn(),
        deleteAccount: vi.fn(),
        getDeletionReceipt
      }
    });
    const request = new Request("https://unfiled.test/api/v1/me/deletion-receipt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: TOKEN })
    });
    const response = await handlers.replayDeletionReceipt(request);

    expect(request.url).not.toContain(TOKEN);
    expect(request.headers.get("idempotency-key")).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
    expect(getDeletionReceipt).toHaveBeenCalledWith(TOKEN, "c".repeat(64), request.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    privateHeaders(response);
  });

  it("makes missing and expired receipt capabilities indistinguishable and keeps errors private", async () => {
    const missing = new HttpError(404, ApiErrorCode.NOT_FOUND, "That item was not found.");
    const handlers = createOwnerDataHandlers({
      requesterDigest: () => "d".repeat(64),
      service: {
        exportAccount: vi.fn(),
        deleteAccount: vi.fn(),
        getDeletionReceipt: vi.fn(() => Promise.reject(missing))
      }
    });
    const responses = await Promise.all(
      ["missing", "expired"].map(() =>
        handlers.replayDeletionReceipt(
          new Request("https://unfiled.test/api/v1/me/deletion-receipt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idempotencyKey: TOKEN })
          })
        )
      )
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<Readonly<Record<string, unknown>>>)
    );
    expect(responses.map(({ status }) => status)).toEqual([404, 404]);
    const contentFreeBodies = bodies.map((body) => {
      const copy = { ...body };
      delete copy.requestId;
      return copy;
    });
    expect(contentFreeBodies).toEqual([
      { code: "not_found", message: "That item was not found." },
      { code: "not_found", message: "That item was not found." }
    ]);
    responses.forEach(privateHeaders);
  });

  it("marks method errors private and content-free", () => {
    const response = createOwnerDataHandlers().methodNotAllowed("POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    privateHeaders(response);
  });
});
