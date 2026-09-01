import { createHash, createHmac } from "node:crypto";

import {
  AccountDeletionReceiptSchema,
  AccountDeletionTokenSchema,
  parseEntityId,
  type AccountDeletionReceipt,
  type EntityId
} from "@unfiled/contracts";

import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const encryptedOwnerDataRpcFunctions = Object.freeze([
  "list_encrypted_export_note_sources",
  "get_account_deletion_receipt",
  "delete_encrypted_owner_account"
] as const);

export type EncryptedExportNoteSources = Readonly<{
  noteId: EntityId<"note">;
  sourceCaptureIds: readonly EntityId<"cap">[];
}>;

export type EncryptedAccountDeletionResult = AccountDeletionReceipt;

export type EncryptedOwnerDataRpcAdapter = Readonly<{
  listNoteSources(input: {
    ownerId: string;
    noteIds: readonly EntityId<"note">[];
  }): Promise<readonly EncryptedExportNoteSources[]>;
  deleteAccount(input: {
    ownerId: string;
    idempotencyKey: string;
  }): Promise<EncryptedAccountDeletionResult>;
  getDeletionReceipt(input: {
    idempotencyKey: string;
    requesterDigest: string;
  }): Promise<EncryptedAccountDeletionResult>;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function invalidProjection(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function deletionTokenDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deletionOwnerBinding(value: string, canonicalOwner: string): string {
  return createHmac("sha256", value)
    .update("unfiled:account-deletion-owner:v1\0", "utf8")
    .update(canonicalOwner, "utf8")
    .digest("hex");
}

function exactRecord(value: unknown, keys: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidProjection();
  }
  const record = value as UnknownRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return invalidProjection();
  }
  return record;
}

function ownerId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalidInput();
  return value.toLowerCase();
}

function entityId<Kind extends "cap" | "note">(
  value: unknown,
  kind: Kind,
  input: boolean
): EntityId<Kind> {
  if (typeof value !== "string") return input ? invalidInput() : invalidProjection();
  try {
    parseEntityId(value, kind);
  } catch {
    return input ? invalidInput() : invalidProjection();
  }
  return value as EntityId<Kind>;
}

function parseSources(
  value: unknown,
  requested: readonly EntityId<"note">[]
): readonly EncryptedExportNoteSources[] {
  const response = exactRecord(value, ["items"]);
  if (!Array.isArray(response.items) || response.items.length !== requested.length) {
    return invalidProjection();
  }
  const requestedIds = new Set(requested);
  const seen = new Set<string>();
  const items = response.items.map((item): EncryptedExportNoteSources => {
    const record = exactRecord(item, ["noteId", "sourceCaptureIds"]);
    const noteId = entityId(record.noteId, "note", false);
    if (!requestedIds.has(noteId) || seen.has(noteId) || !Array.isArray(record.sourceCaptureIds)) {
      return invalidProjection();
    }
    seen.add(noteId);
    const sourceCaptureIds = record.sourceCaptureIds.map((captureId) =>
      entityId(captureId, "cap", false)
    );
    if (
      sourceCaptureIds.length > 1_000 ||
      new Set(sourceCaptureIds).size !== sourceCaptureIds.length ||
      sourceCaptureIds.some((captureId, index) =>
        index === 0 ? false : captureId <= (sourceCaptureIds[index - 1] ?? "")
      )
    ) {
      return invalidProjection();
    }
    return Object.freeze({ noteId, sourceCaptureIds: Object.freeze(sourceCaptureIds) });
  });
  return Object.freeze(items);
}

function parseDeletion(value: unknown): EncryptedAccountDeletionResult {
  const parsed = AccountDeletionReceiptSchema.safeParse(value);
  if (!parsed.success) return invalidProjection();
  const deletedAt = Date.parse(parsed.data.deletedAt);
  if (
    Date.parse(parsed.data.backupExpiresAt) - deletedAt !== 30 * 24 * 60 * 60 * 1_000 ||
    Date.parse(parsed.data.receiptExpiresAt) - deletedAt !== 31 * 24 * 60 * 60 * 1_000
  ) {
    return invalidProjection();
  }
  return Object.freeze({
    ...parsed.data,
    deletedRecordCounts: Object.freeze({ ...parsed.data.deletedRecordCounts })
  });
}

function parseDeletionLookup(value: unknown): EncryptedAccountDeletionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidProjection();
  }
  const status = (value as UnknownRecord).status;
  if (status === "not_found") {
    exactRecord(value, ["status"]);
    throw new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND);
  }
  if (status === "rate_limited") {
    exactRecord(value, ["status"]);
    throw new ServiceRpcError(ServiceRpcErrorCode.RATE_LIMITED);
  }
  const response = exactRecord(value, ["receipt", "status"]);
  if (response.status !== "found") return invalidProjection();
  return parseDeletion(response.receipt);
}

export function createEncryptedOwnerDataRpcAdapter(
  client: ServiceRpcClient
): EncryptedOwnerDataRpcAdapter {
  return Object.freeze({
    async listNoteSources(input) {
      const canonicalOwner = ownerId(input.ownerId);
      if (!Array.isArray(input.noteIds) || input.noteIds.length < 1 || input.noteIds.length > 50) {
        return invalidInput();
      }
      const noteIds = input.noteIds.map((noteId) => entityId(noteId, "note", true));
      if (new Set(noteIds).size !== noteIds.length) return invalidInput();
      return parseSources(
        await client.rpc("list_encrypted_export_note_sources", {
          p_owner_id: canonicalOwner,
          p_note_ids: noteIds
        }),
        noteIds
      );
    },
    async getDeletionReceipt(input) {
      const idempotencyKey = AccountDeletionTokenSchema.safeParse(input.idempotencyKey);
      if (!idempotencyKey.success || !/^[0-9a-f]{64}$/u.test(input.requesterDigest)) {
        return invalidInput();
      }
      return parseDeletionLookup(
        await client.rpc("get_account_deletion_receipt", {
          p_idempotency_digest: deletionTokenDigest(idempotencyKey.data),
          p_requester_digest: input.requesterDigest
        })
      );
    },
    async deleteAccount(input) {
      const canonicalOwner = ownerId(input.ownerId);
      const idempotencyKey = AccountDeletionTokenSchema.safeParse(input.idempotencyKey);
      if (!idempotencyKey.success) return invalidInput();
      return parseDeletion(
        await client.rpc("delete_encrypted_owner_account", {
          p_owner_id: canonicalOwner,
          p_idempotency_digest: deletionTokenDigest(idempotencyKey.data),
          p_owner_binding_digest: deletionOwnerBinding(idempotencyKey.data, canonicalOwner)
        })
      );
    }
  });
}
