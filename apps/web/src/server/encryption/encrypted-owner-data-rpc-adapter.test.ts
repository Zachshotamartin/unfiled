import { createHash, createHmac } from "node:crypto";

import type { EntityId } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import { createEncryptedOwnerDataRpcAdapter } from "./encrypted-owner-data-rpc-adapter";
import { ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const TOKEN = `delete_${"A".repeat(43)}`;
const NOTE = "note_00000000000000000000000001" as EntityId<"note">;
const CAPTURE = "cap_00000000000000000000000001" as EntityId<"cap">;

const receipt = {
  schemaVersion: 1,
  deletedAt: "2026-08-31T20:00:00.000Z",
  backupExpiresAt: "2026-09-30T20:00:00.000Z",
  receiptExpiresAt: "2026-10-01T20:00:00.000Z",
  backupRetentionDays: 30,
  liveDataDeleted: true,
  sessionsRevoked: true,
  reRegistrationStartsFresh: true,
  deletedRecordCounts: { "auth.sessions": 1, "public.notes": 5 },
  replayed: false
} as const;

describe("encrypted owner-data RPC adapter", () => {
  it("sends exact owner-bounded note IDs and rejects incomplete source projections", async () => {
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({ items: [{ noteId: NOTE, sourceCaptureIds: [CAPTURE] }] })
      .mockResolvedValueOnce({ items: [] });
    const adapter = createEncryptedOwnerDataRpcAdapter({ rpc });
    await expect(adapter.listNoteSources({ ownerId: OWNER, noteIds: [NOTE] })).resolves.toEqual([
      { noteId: NOTE, sourceCaptureIds: [CAPTURE] }
    ]);
    expect(rpc).toHaveBeenNthCalledWith(1, "list_encrypted_export_note_sources", {
      p_owner_id: OWNER,
      p_note_ids: [NOTE]
    });
    await expect(
      adapter.listNoteSources({ ownerId: OWNER, noteIds: [NOTE] })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("hashes the bearer capability before both delete and replay RPC boundaries", async () => {
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce({ status: "found", receipt: { ...receipt, replayed: true } });
    const adapter = createEncryptedOwnerDataRpcAdapter({ rpc });
    await adapter.deleteAccount({ ownerId: OWNER, idempotencyKey: TOKEN });
    await adapter.getDeletionReceipt({
      idempotencyKey: TOKEN,
      requesterDigest: "b".repeat(64)
    });

    const digest = createHash("sha256").update(TOKEN).digest("hex");
    expect(rpc).toHaveBeenNthCalledWith(1, "delete_encrypted_owner_account", {
      p_owner_id: OWNER,
      p_idempotency_digest: digest,
      p_owner_binding_digest: createHmac("sha256", TOKEN)
        .update("unfiled:account-deletion-owner:v1\0")
        .update(OWNER)
        .digest("hex")
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_account_deletion_receipt", {
      p_idempotency_digest: digest,
      p_requester_digest: "b".repeat(64)
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(TOKEN);
  });

  it("maps durable content-free lookup statuses without accepting ambiguous projections", async () => {
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({ status: "not_found" })
      .mockResolvedValueOnce({ status: "rate_limited" })
      .mockResolvedValueOnce({ status: "not_found", receipt });
    const adapter = createEncryptedOwnerDataRpcAdapter({ rpc });
    const input = { idempotencyKey: TOKEN, requesterDigest: "b".repeat(64) };

    await expect(adapter.getDeletionReceipt(input)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.NOT_FOUND
    });
    await expect(adapter.getDeletionReceipt(input)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.RATE_LIMITED
    });
    await expect(adapter.getDeletionReceipt(input)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
  });

  it("fails closed on weak tokens, malformed requester digests, and dishonest receipts", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>(() =>
      Promise.resolve({ ...receipt, sessionsRevoked: false })
    );
    const adapter = createEncryptedOwnerDataRpcAdapter({ rpc });
    await expect(
      adapter.deleteAccount({ ownerId: OWNER, idempotencyKey: "weak" })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    await expect(
      adapter.getDeletionReceipt({ idempotencyKey: TOKEN, requesterDigest: "bad" })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    await expect(
      adapter.deleteAccount({ ownerId: OWNER, idempotencyKey: TOKEN })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });
});
