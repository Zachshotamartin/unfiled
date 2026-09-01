import {
  AccountDeleteRequestSchema,
  AccountDeletionReceiptReplayRequestSchema,
  AccountDeletionReceiptSchema,
  AccountExportManifestSchema
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const TOKEN = `delete_${"A".repeat(43)}`;
const NOW = "2026-08-31T20:00:00.000Z";

describe("account contracts", () => {
  it("requires exact confirmation and canonical 32-byte capability encoding", () => {
    expect(
      AccountDeleteRequestSchema.parse({ confirmation: "DELETE", idempotencyKey: TOKEN })
    ).toEqual({ confirmation: "DELETE", idempotencyKey: TOKEN });
    expect(AccountDeletionReceiptReplayRequestSchema.parse({ idempotencyKey: TOKEN })).toEqual({
      idempotencyKey: TOKEN
    });
    for (const invalid of [
      "weak",
      `delete_${"A".repeat(42)}`,
      `delete_${"A".repeat(44)}`,
      `delete_${"!".repeat(43)}`,
      `delete_${"A".repeat(42)}B`
    ]) {
      expect(
        AccountDeleteRequestSchema.safeParse({ confirmation: "DELETE", idempotencyKey: invalid })
          .success
      ).toBe(false);
    }
    expect(
      AccountDeleteRequestSchema.safeParse({
        confirmation: "delete",
        idempotencyKey: TOKEN
      }).success
    ).toBe(false);
  });

  it("accepts only content-free, audited deletion receipts", () => {
    const valid = {
      schemaVersion: 1,
      deletedAt: NOW,
      backupExpiresAt: "2026-09-30T20:00:00.000Z",
      receiptExpiresAt: "2026-10-01T20:00:00.000Z",
      backupRetentionDays: 30,
      liveDataDeleted: true,
      sessionsRevoked: true,
      reRegistrationStartsFresh: true,
      deletedRecordCounts: { "auth.sessions": 1, "public.notes": 5 },
      replayed: false
    };
    expect(AccountDeletionReceiptSchema.safeParse(valid).success).toBe(true);
    expect(
      AccountDeletionReceiptSchema.safeParse({ ...valid, sessionsRevoked: false }).success
    ).toBe(false);
    expect(
      AccountDeletionReceiptSchema.safeParse({
        ...valid,
        deletedRecordCounts: { "public.notes": -1 }
      }).success
    ).toBe(false);
    expect(AccountDeletionReceiptSchema.safeParse({ ...valid, ownerId: "secret" }).success).toBe(
      false
    );
  });

  it("requires decrypted space and tag definitions in an export manifest", () => {
    const valid = {
      schemaVersion: 1,
      exportedAt: NOW,
      spaces: [
        {
          id: "spc_00000000000000000000000001",
          parentId: null,
          name: "Projects",
          path: "Projects",
          archivedAt: null,
          createdAt: NOW,
          updatedAt: NOW
        }
      ],
      tags: [
        {
          id: "tag_00000000000000000000000001",
          name: "Important",
          createdAt: NOW,
          updatedAt: NOW
        }
      ],
      notes: [],
      routingRules: []
    };
    expect(AccountExportManifestSchema.safeParse(valid).success).toBe(true);
    const withoutSpaces: Record<string, unknown> = { ...valid };
    delete withoutSpaces.spaces;
    expect(AccountExportManifestSchema.safeParse(withoutSpaces).success).toBe(false);
  });
});
