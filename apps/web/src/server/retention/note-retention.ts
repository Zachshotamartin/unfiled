import { randomUUID } from "node:crypto";

import { ApiErrorCode } from "@unfiled/contracts";

import { HttpError } from "@/server/api/errors";
import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "@/server/encryption/encrypted-aggregate-runtime";
import { createEncryptedCaptureRpcAdapter } from "@/server/encryption/encrypted-capture-rpc-adapter";
import { createEncryptedNoteRetentionCoordinator } from "@/server/encryption/encrypted-note-retention-coordinator";
import {
  createEncryptedNoteRetentionRpcStore,
  encryptedNoteRetentionRpcFunctions,
  type ClaimEncryptedNoteRetentionResult,
  type EncryptedNoteRetentionClaim
} from "@/server/encryption/encrypted-note-retention-rpc-store";
import { createEncryptedNoteReadRpcAdapter } from "@/server/encryption/encrypted-note-read-rpc-adapter";
import {
  encryptedStorageContractStateRpcFunctions,
  getEncryptedStorageContractState
} from "@/server/encryption/encrypted-storage-contract-state";
import { ContentEncryptionRolloutRpcSource } from "@/server/encryption/rollout-rpc-source";
import { createServiceRpcClient } from "@/server/encryption/service-rpc-client";
import { createInteractiveWebKeyRuntime } from "@/server/encryption/web-key-runtime";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const MAX_ENCRYPTED_BATCH_SIZE = 25;

const ENCRYPTED_RETENTION_RPC_FUNCTIONS = Object.freeze([
  ...encryptedAggregateRuntimeRpcFunctions,
  ...encryptedNoteRetentionRpcFunctions,
  ...encryptedStorageContractStateRpcFunctions,
  "get_encrypted_capture_receipt",
  "get_encrypted_note",
  "get_content_encryption_rollout"
] as const);

const LEGACY_RETENTION_RPC_FUNCTIONS = Object.freeze(["purge_expired_deleted_notes"] as const);

export type NoteRetentionResult = Readonly<{
  cutoff: string;
  eligibleCount: number;
  executed: boolean;
  purgedCount: number;
  runAt: string;
}>;

export type NoteRetentionRequest = Readonly<{
  batchSize?: number;
  execute?: boolean;
  now?: Date;
  ownerId?: string | null;
  signal?: AbortSignal;
}>;

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function emptyLegacyResult(now: Date): NoteRetentionResult {
  return Object.freeze({
    cutoff: new Date(now.valueOf() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
    eligibleCount: 0,
    executed: false,
    purgedCount: 0,
    runAt: now.toISOString()
  });
}

async function cancelClaims(
  store: ReturnType<typeof createEncryptedNoteRetentionRpcStore>,
  runId: string,
  leaseToken: string,
  claims: readonly EncryptedNoteRetentionClaim[]
): Promise<void> {
  await Promise.allSettled(
    claims.map((claim) =>
      store.cancel({ ownerId: claim.ownerId, runId, claimId: claim.claimId, leaseToken })
    )
  );
}

async function executeEncryptedClaims(
  client: ReturnType<typeof createServiceRpcClient>,
  store: ReturnType<typeof createEncryptedNoteRetentionRpcStore>,
  claimResult: ClaimEncryptedNoteRetentionResult,
  runId: string,
  leaseToken: string,
  signal: AbortSignal
): Promise<number> {
  if (claimResult.claims.length === 0) return 0;
  const runtime = await createInteractiveWebKeyRuntime();
  const captures = createEncryptedCaptureRpcAdapter(client);
  const notes = createEncryptedNoteReadRpcAdapter(client);
  const pending = new Set(claimResult.claims.map((claim) => claim.claimId));
  let purgedCount = 0;
  try {
    for (const claim of claimResult.claims) {
      if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      await withOwnerEncryptedAggregateRuntime(
        runtime,
        client,
        claim.ownerId,
        { signal },
        async ({ access, service }) => {
          const coordinator = createEncryptedNoteRetentionCoordinator({
            access,
            aggregate: service,
            captures,
            notes,
            store
          });
          return coordinator.processClaim({ runId, leaseToken, claim, signal });
        }
      );
      pending.delete(claim.claimId);
      purgedCount += 1;
    }
    return purgedCount;
  } catch (error) {
    await cancelClaims(
      store,
      runId,
      leaseToken,
      claimResult.claims.filter((claim) => pending.has(claim.claimId))
    );
    throw error;
  }
}

function retentionResult(value: unknown): NoteRetentionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The retention service returned an invalid response."
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.cutoff !== "string" ||
    typeof record.runAt !== "string" ||
    typeof record.executed !== "boolean" ||
    !nonNegativeInteger(record.eligibleCount) ||
    !nonNegativeInteger(record.purgedCount) ||
    Number.isNaN(Date.parse(record.cutoff)) ||
    Number.isNaN(Date.parse(record.runAt))
  ) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The retention service returned an invalid response."
    );
  }
  return {
    cutoff: record.cutoff,
    eligibleCount: record.eligibleCount,
    executed: record.executed,
    purgedCount: record.purgedCount,
    runAt: record.runAt
  };
}

/**
 * Runs one bounded retention batch. It is deliberately dry-run by default;
 * a scheduler must opt into the destructive path on every invocation.
 */
export async function runNoteRetentionBatch(
  input: NoteRetentionRequest = {},
  fetcher: typeof fetch = fetch
): Promise<NoteRetentionResult> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = input.now ?? new Date();
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_BATCH_SIZE ||
    Number.isNaN(now.getTime())
  ) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "The retention batch configuration is invalid."
    );
  }
  if (
    input.ownerId !== undefined &&
    input.ownerId !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.ownerId
    )
  ) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "The retention batch configuration is invalid."
    );
  }

  const signal = input.signal ?? new AbortController().signal;
  const execute = input.execute === true;
  const ownerId = input.ownerId ?? null;
  const client = createServiceRpcClient({
    allowedFunctions: ENCRYPTED_RETENTION_RPC_FUNCTIONS,
    fetch: fetcher,
    signal
  });
  const store = createEncryptedNoteRetentionRpcStore(client);
  const encryptedLimit = Math.min(batchSize, MAX_ENCRYPTED_BATCH_SIZE);
  const runId = randomUUID();
  const leaseToken = randomUUID();
  try {
    const initialContract = await getEncryptedStorageContractState(client);
    let ownerUsesEncryption = ownerId === null || initialContract.state === "contracted";
    if (ownerId !== null && initialContract.state === "expand_compatible") {
      ownerUsesEncryption =
        (await new ContentEncryptionRolloutRpcSource(client).rolloutForOwner(ownerId)).state !==
        "expanded";
    }
    const encrypted = ownerUsesEncryption
      ? await store.claim({
          runId,
          leaseToken,
          ownerId,
          now: now.toISOString(),
          batchSize: encryptedLimit,
          execute
        })
      : Object.freeze({
          runAt: now.toISOString(),
          cutoff: new Date(now.valueOf() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
          eligibleCount: 0,
          executed: execute,
          claimedCount: 0,
          claims: Object.freeze([]),
          replayed: false
        });
    const encryptedPurged = execute
      ? await executeEncryptedClaims(client, store, encrypted, runId, leaseToken, signal)
      : 0;

    const remaining = Math.max(0, batchSize - encrypted.eligibleCount);
    let legacy = emptyLegacyResult(now);
    const legacyCandidate =
      initialContract.state === "expand_compatible" &&
      (!ownerUsesEncryption || (ownerId === null && remaining > 0));
    if (legacyCandidate) {
      // Recheck on the encrypted-only capability before even constructing a
      // client that can name the rollback RPC. A concurrent contract commit
      // therefore turns this remainder into a safe no-op.
      const currentContract = await getEncryptedStorageContractState(client);
      if (currentContract.state === "expand_compatible") {
        const legacyClient = createServiceRpcClient({
          allowedFunctions: LEGACY_RETENTION_RPC_FUNCTIONS,
          fetch: fetcher,
          signal
        });
        legacy = retentionResult(
          await legacyClient.rpc("purge_expired_deleted_notes", {
            p_batch_size: remaining === 0 ? 1 : remaining,
            p_execute: execute && remaining > 0,
            p_now: now.toISOString(),
            p_owner_id: ownerId
          })
        );
      }
    }
    return Object.freeze({
      cutoff: encrypted.cutoff,
      eligibleCount: encrypted.eligibleCount + legacy.eligibleCount,
      executed: execute,
      purgedCount: encryptedPurged + legacy.purgedCount,
      runAt: encrypted.runAt
    });
  } catch {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The retention service could not complete this batch."
    );
  }
}
