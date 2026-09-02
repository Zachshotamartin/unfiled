import type { AccountDeletionReceipt, AccountDeletionToken } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountDataControls, deleteAccountWithReceiptRecovery } from "./account-data-controls";

const TOKEN: AccountDeletionToken = `delete_${"A".repeat(43)}`;
const receipt: AccountDeletionReceipt = {
  schemaVersion: 1,
  deletedAt: "2026-09-01T22:00:00.000Z",
  backupExpiresAt: "2026-10-01T22:00:00.000Z",
  receiptExpiresAt: "2026-10-01T22:00:00.000Z",
  backupRetentionDays: 30,
  liveDataDeleted: true,
  sessionsRevoked: true,
  reRegistrationStartsFresh: true,
  deletedRecordCounts: { "public.notes": 3 },
  replayed: false
};

describe("AccountDataControls", () => {
  it("offers a direct streaming archive and a separate destructive action", () => {
    const html = renderToStaticMarkup(<AccountDataControls />);

    expect(html).toContain('href="/api/v1/me/export"');
    expect(html).toContain("Download archive");
    expect(html).toContain("Delete account");
    expect(html).not.toContain("Type DELETE to confirm");
  });

  it("returns the first deletion receipt without replay", async () => {
    const client = {
      deleteAccount: vi.fn(() => Promise.resolve(receipt)),
      replayAccountDeletionReceipt: vi.fn(() => Promise.resolve({ ...receipt, replayed: true }))
    };

    await expect(deleteAccountWithReceiptRecovery(client, TOKEN)).resolves.toBe(receipt);
    expect(client.deleteAccount).toHaveBeenCalledWith({
      confirmation: "DELETE",
      idempotencyKey: TOKEN
    });
    expect(client.replayAccountDeletionReceipt).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous response loss with the exact body-only token", async () => {
    const recovered = { ...receipt, replayed: true } as const;
    const client = {
      deleteAccount: vi.fn(() => Promise.reject(new TypeError("connection ended after commit"))),
      replayAccountDeletionReceipt: vi.fn(() => Promise.resolve(recovered))
    };

    await expect(deleteAccountWithReceiptRecovery(client, TOKEN)).resolves.toBe(recovered);
    expect(client.replayAccountDeletionReceipt).toHaveBeenCalledWith({ idempotencyKey: TOKEN });
  });

  it("does not replay a deterministic rejection", async () => {
    const rejection = new Error("validation failed");
    const client = {
      deleteAccount: vi.fn(() => Promise.reject(rejection)),
      replayAccountDeletionReceipt: vi.fn(() => Promise.resolve(receipt))
    };

    await expect(deleteAccountWithReceiptRecovery(client, TOKEN)).rejects.toBe(rejection);
    expect(client.replayAccountDeletionReceipt).not.toHaveBeenCalled();
  });

  it("preserves the primary ambiguous error if receipt recovery also fails", async () => {
    const primary = new TypeError("request outcome unknown");
    const client = {
      deleteAccount: vi.fn(() => Promise.reject(primary)),
      replayAccountDeletionReceipt: vi.fn(() => Promise.reject(new Error("receipt unavailable")))
    };

    await expect(deleteAccountWithReceiptRecovery(client, TOKEN)).rejects.toBe(primary);
  });
});
