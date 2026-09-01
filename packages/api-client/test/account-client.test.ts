import { AccountDeletionTokenSchema } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import { createAccountDeletionToken, createApiClient } from "../src/index.js";

const TOKEN = `delete_${"A".repeat(43)}`;
const receipt = {
  schemaVersion: 1,
  deletedAt: "2026-08-31T20:00:00.000Z",
  backupExpiresAt: "2026-09-30T20:00:00.000Z",
  receiptExpiresAt: "2026-10-01T20:00:00.000Z",
  backupRetentionDays: 30,
  liveDataDeleted: true,
  sessionsRevoked: true,
  reRegistrationStartsFresh: true,
  deletedRecordCounts: { "auth.sessions": 1, "public.notes": 3 },
  replayed: false
} as const;

function url(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("account API client", () => {
  it("creates 256-bit base64url deletion capabilities", () => {
    const values = new Set(Array.from({ length: 32 }, () => createAccountDeletionToken()));
    expect(values.size).toBe(32);
    for (const value of values)
      expect(AccountDeletionTokenSchema.safeParse(value).success).toBe(true);
  });

  it("returns the export response unbuffered and enforces private archive headers", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": 'attachment; filename="unfiled-export.tar.gz"',
            "content-type": "application/gzip"
          }
        })
      )
    );
    const client = createApiClient({
      baseUrl: "https://unfiled.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });
    const response = await client.exportAccountData();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://unfiled.test/api/v1/me/export");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", method: "GET" });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer access-token"
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("deletes with authenticated matching capability and replays only through a POST body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(receipt), { headers: { "content-type": "application/json" } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...receipt, replayed: true }), {
          headers: { "content-type": "application/json" }
        })
      );
    const client = createApiClient({
      baseUrl: "https://unfiled.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });
    await client.deleteAccount({ confirmation: "DELETE", idempotencyKey: TOKEN });
    await client.replayAccountDeletionReceipt({ idempotencyKey: TOKEN });

    const deleteCall = fetcher.mock.calls[0];
    const replayCall = fetcher.mock.calls[1];
    expect(deleteCall).toBeDefined();
    expect(replayCall).toBeDefined();
    if (deleteCall === undefined || replayCall === undefined) throw new Error("missing fetch call");
    const [deleteUrl, deleteInit] = deleteCall;
    expect(url(deleteUrl)).toBe("https://unfiled.test/api/v1/me");
    expect(deleteInit?.method).toBe("DELETE");
    expect(new Headers(deleteInit?.headers).get("authorization")).toBe("Bearer access-token");
    expect(new Headers(deleteInit?.headers).get("idempotency-key")).toBeNull();
    expect(url(deleteUrl)).not.toContain(TOKEN);

    const [replayUrl, replayInit] = replayCall;
    expect(url(replayUrl)).toBe("https://unfiled.test/api/v1/me/deletion-receipt");
    expect(url(replayUrl)).not.toContain(TOKEN);
    expect(replayInit).toMatchObject({ cache: "no-store", method: "POST" });
    expect(new Headers(replayInit?.headers).get("authorization")).toBeNull();
    expect(new Headers(replayInit?.headers).get("idempotency-key")).toBeNull();
    await expect(new Response(replayInit?.body).json()).resolves.toEqual({ idempotencyKey: TOKEN });
  });

  it("rejects weak capabilities before network access", () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createApiClient({
      baseUrl: "https://unfiled.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });
    expect(() =>
      client.deleteAccount({ confirmation: "DELETE", idempotencyKey: "weak" })
    ).toThrow();
    expect(() => client.replayAccountDeletionReceipt({ idempotencyKey: "weak" })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
