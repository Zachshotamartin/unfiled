import { isDeepStrictEqual } from "node:util";

import { CaptureReceiptPayloadSchema } from "@unfiled/encrypted-aggregate";
import {
  encryptedFieldForRpc,
  keyedMacForRpc,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";

import type {
  EncryptedCaptureReceiptRead,
  EncryptedCaptureRpcAdapter
} from "./encrypted-capture-rpc-adapter";
import type { EncryptedNoteReadRpcAdapter } from "./encrypted-note-read-rpc-adapter";
import type {
  CommitEncryptedNoteRetentionResult,
  EncryptedNoteRetentionClaim,
  EncryptedNoteRetentionReceiptCommit,
  EncryptedNoteRetentionRpcStore
} from "./encrypted-note-retention-rpc-store";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

export type EncryptedNoteRetentionCoordinatorDependencies = Readonly<{
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  captures: Pick<EncryptedCaptureRpcAdapter, "getCaptureReceipt">;
  notes: Pick<EncryptedNoteReadRpcAdapter, "getNote">;
  store: EncryptedNoteRetentionRpcStore;
}>;

export type ProcessEncryptedNoteRetentionClaimInput = Readonly<{
  runId: string;
  leaseToken: string;
  claim: EncryptedNoteRetentionClaim;
  signal?: AbortSignal;
}>;

function failClosed(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) failClosed();
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function receiptMatchesProjection(
  payload: ReturnType<typeof CaptureReceiptPayloadSchema.parse>,
  row: EncryptedCaptureReceiptRead
): boolean {
  return (
    payload.captureId === row.captureId &&
    payload.jobId === row.jobId &&
    payload.decisionId === row.decisionId &&
    payload.reviewItemId === row.reviewItemId &&
    payload.mutationId === row.mutationId &&
    payload.outcome === row.outcome &&
    payload.destination?.noteId === (row.destinationNoteId ?? undefined) &&
    sameStrings(payload.reasonCodes, row.reasonCodes) &&
    sameInstant(payload.createdAt, row.createdAt)
  );
}

function expiredReasonCodes(reasonCodes: readonly string[]): readonly string[] {
  if (reasonCodes.includes("destination_expired")) return Object.freeze([...reasonCodes]);
  if (reasonCodes.length < 20) {
    return Object.freeze([...reasonCodes, "destination_expired"]);
  }
  return Object.freeze([...reasonCodes.slice(0, 19), "destination_expired"]);
}

type OpenedCaptureReceipt = Awaited<ReturnType<EncryptedAggregateService["openCaptureReceipt"]>>;

type RetentionReceiptPlan = Readonly<{
  payload: OpenedCaptureReceipt;
  projection: EncryptedNoteRetentionReceiptCommit["projection"];
}>;

function inboxPlan(opened: OpenedCaptureReceipt): RetentionReceiptPlan {
  return Object.freeze({
    payload: CaptureReceiptPayloadSchema.parse({
      schemaVersion: 2,
      captureId: opened.captureId,
      jobId: opened.jobId,
      decisionId: opened.decisionId,
      reviewItemId: null,
      mutationId: null,
      outcome: "kept_in_inbox",
      headline: "Kept in Inbox after note expired",
      destination: null,
      insertedContentReferences: [],
      actions: [],
      undoTargets: [],
      reasonCodes: expiredReasonCodes(opened.reasonCodes),
      createdAt: opened.createdAt
    }),
    projection: Object.freeze({ mode: "inbox" as const, primary: null })
  });
}

async function reconcileReceipt(
  dependencies: EncryptedNoteRetentionCoordinatorDependencies,
  claim: EncryptedNoteRetentionClaim,
  opened: OpenedCaptureReceipt,
  signal: AbortSignal | undefined
): Promise<RetentionReceiptPlan> {
  const routed = opened.outcome === "created_note" || opened.outcome === "added_to_note";
  if (!routed) return inboxPlan(opened);
  if (opened.schemaVersion === 1) {
    return opened.destination?.noteId === claim.noteId
      ? inboxPlan(opened)
      : Object.freeze({
          payload: opened,
          projection: Object.freeze({ mode: "preserve" as const, primary: null })
        });
  }

  const removed = opened.undoTargets.filter((target) => target.noteId === claim.noteId);
  if (removed.length === 0) {
    if (opened.destination?.noteId === claim.noteId) failClosed();
    return Object.freeze({
      payload: opened,
      projection: Object.freeze({ mode: "preserve" as const, primary: null })
    });
  }
  if (removed.length !== 1) failClosed();
  const remaining = opened.undoTargets.filter((target) => target.noteId !== claim.noteId);
  if (remaining.length === 0) return inboxPlan(opened);

  const primary =
    remaining.find(
      (target) =>
        target.noteId === opened.destination?.noteId && target.mutationId === opened.mutationId
    ) ?? remaining[0];
  if (primary === undefined) failClosed();
  assertNotAborted(signal);
  const target = await dependencies.notes.getNote({
    ownerId: claim.ownerId,
    noteId: primary.noteId
  });
  assertNotAborted(signal);
  const content = await dependencies.aggregate.openNoteContent(
    dependencies.access,
    target.contentCipher,
    {
      noteId: target.noteId,
      currentRevision: target.currentRevision,
      privacy: target.privacy
    }
  );
  assertNotAborted(signal);
  return Object.freeze({
    payload: CaptureReceiptPayloadSchema.parse({
      schemaVersion: 2,
      captureId: opened.captureId,
      jobId: opened.jobId,
      decisionId: opened.decisionId,
      reviewItemId: null,
      mutationId: primary.mutationId,
      outcome: "added_to_note",
      headline: `Updated ${content.title}`,
      destination: { noteId: primary.noteId, title: content.title },
      insertedContentReferences: [{ type: "captured", itemId: null }],
      actions: [
        {
          type: "undo",
          mutationId: primary.mutationId,
          expectedRevision: primary.expectedRevision
        }
      ],
      undoTargets: remaining,
      reasonCodes: expiredReasonCodes(opened.reasonCodes),
      createdAt: opened.createdAt
    }),
    projection: Object.freeze({
      mode: "routed" as const,
      primary: Object.freeze({
        noteId: primary.noteId,
        mutationId: primary.mutationId,
        expectedRevision: primary.expectedRevision,
        noteRecordVersion: target.currentRevision
      })
    })
  });
}

async function prepareReceipt(
  dependencies: EncryptedNoteRetentionCoordinatorDependencies,
  claim: EncryptedNoteRetentionClaim,
  context: EncryptedNoteRetentionClaim["receiptContexts"][number],
  signal: AbortSignal | undefined
): Promise<EncryptedNoteRetentionReceiptCommit> {
  assertNotAborted(signal);
  const row = await dependencies.captures.getCaptureReceipt({
    ownerId: claim.ownerId,
    captureId: context.captureId
  });
  assertNotAborted(signal);
  if (
    row.captureId !== context.captureId ||
    row.recordVersion !== context.recordVersion ||
    row.privacy !== context.privacy
  ) {
    failClosed();
  }
  const opened = await dependencies.aggregate.openCaptureReceipt(
    dependencies.access,
    row.receiptCipher,
    {
      captureId: row.captureId,
      recordVersion: row.recordVersion,
      sourcePrivacy: row.privacy
    }
  );
  if (!receiptMatchesProjection(opened, row)) failClosed();
  const plan = await reconcileReceipt(dependencies, claim, opened, signal);
  const payload = plan.payload;
  const next = Object.freeze({
    captureId: row.captureId,
    recordVersion: row.recordVersion + 1,
    sourcePrivacy: row.privacy,
    payload
  });
  const sealed = await dependencies.aggregate.sealCaptureReceipt(dependencies.access, next);
  const [roundTrip, verificationMac] = await Promise.all([
    dependencies.aggregate.openCaptureReceipt(dependencies.access, sealed, next),
    dependencies.aggregate.createAggregateVerificationMac(dependencies.access, {
      surface: "capture_receipt",
      ...next
    })
  ]);
  const verificationValid = await dependencies.aggregate.verifyAggregateVerificationMac(
    dependencies.access,
    verificationMac,
    { surface: "capture_receipt", ...next }
  );
  assertNotAborted(signal);
  if (!verificationValid || !isDeepStrictEqual(roundTrip, payload)) failClosed();
  return Object.freeze({
    captureId: row.captureId,
    recordVersion: next.recordVersion,
    receiptCipher: encryptedFieldForRpc(sealed),
    verificationMac: keyedMacForRpc(verificationMac),
    projection: plan.projection
  });
}

export function createEncryptedNoteRetentionCoordinator(
  dependencies: EncryptedNoteRetentionCoordinatorDependencies
): Readonly<{
  processClaim(
    input: ProcessEncryptedNoteRetentionClaimInput
  ): Promise<CommitEncryptedNoteRetentionResult>;
}> {
  return Object.freeze({
    async processClaim(input) {
      if (input.claim.ownerId.length === 0) failClosed();
      try {
        const receipts: EncryptedNoteRetentionReceiptCommit[] = [];
        for (const context of input.claim.receiptContexts) {
          receipts.push(await prepareReceipt(dependencies, input.claim, context, input.signal));
        }
        assertNotAborted(input.signal);
        const committed = await dependencies.store.commit({
          ownerId: input.claim.ownerId,
          runId: input.runId,
          claimId: input.claim.claimId,
          leaseToken: input.leaseToken,
          contextDigest: input.claim.contextDigest,
          receipts
        });
        if (committed.noteId !== input.claim.noteId) failClosed();
        return committed;
      } catch (error) {
        try {
          await dependencies.store.cancel({
            ownerId: input.claim.ownerId,
            runId: input.runId,
            claimId: input.claim.claimId,
            leaseToken: input.leaseToken
          });
        } catch {
          // Cancellation is best-effort after the original operation failed.
          // Its lease expires quickly and the original error remains opaque.
        }
        throw error;
      }
    }
  });
}
