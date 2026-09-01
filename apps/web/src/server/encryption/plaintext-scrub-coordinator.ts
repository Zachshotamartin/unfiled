import type {
  CompletePlaintextScrubResult,
  PlaintextScrubCursor,
  PlaintextScrubRpcStore
} from "./plaintext-scrub-rpc-store";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 250;
const DEFAULT_MAX_BATCHES = 1;
const MAX_BATCHES_PER_SLICE = 20;

export type PlaintextScrubSliceResult = Readonly<{
  phase: "scrubbing" | "attested";
  scrubId: string;
  cursor: PlaintextScrubCursor | null;
  processedCount: number;
  deletedChunkCount: number;
  deletedIdempotencyCount: number;
  batchCount: number;
  attestation: CompletePlaintextScrubResult | null;
}>;

export type PlaintextScrubCoordinator = Readonly<{
  runSlice(
    input: Readonly<{
      ownerId: string;
      scrubId: string;
      expectedCursor?: PlaintextScrubCursor | null;
      batchLimit?: number;
      maxBatches?: number;
      signal?: AbortSignal;
    }>
  ): Promise<PlaintextScrubSliceResult>;
}>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
  }
}

export function createPlaintextScrubCoordinator(
  store: PlaintextScrubRpcStore
): PlaintextScrubCoordinator {
  return Object.freeze({
    async runSlice(input) {
      const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;
      const maxBatches = input.maxBatches ?? DEFAULT_MAX_BATCHES;
      if (
        !Number.isSafeInteger(batchLimit) ||
        batchLimit < 1 ||
        batchLimit > MAX_BATCH_LIMIT ||
        !Number.isSafeInteger(maxBatches) ||
        maxBatches < 1 ||
        maxBatches > MAX_BATCHES_PER_SLICE
      ) {
        return invalidInput();
      }

      assertNotAborted(input.signal);
      const prepared = await store.prepare({ ownerId: input.ownerId, scrubId: input.scrubId });
      assertNotAborted(input.signal);
      if (input.expectedCursor !== undefined && input.expectedCursor !== prepared.cursor) {
        throw new ServiceRpcError(ServiceRpcErrorCode.STALE_MAINTENANCE_CURSOR);
      }

      let cursor = prepared.cursor;
      let processedCount = 0;
      let deletedChunkCount = 0;
      let deletedIdempotencyCount = 0;
      let batchCount = 0;
      let complete = prepared.complete;

      while (!complete && batchCount < maxBatches) {
        assertNotAborted(input.signal);
        const batch = await store.scrubBatch({
          ownerId: input.ownerId,
          scrubId: input.scrubId,
          expectedCursor: cursor,
          limit: batchLimit
        });
        assertNotAborted(input.signal);
        cursor = batch.cursor;
        processedCount += batch.processedCount;
        deletedChunkCount += batch.deletedChunkCount;
        deletedIdempotencyCount += batch.deletedIdempotencyCount;
        batchCount += 1;
        complete = batch.complete;
      }

      let attestation: CompletePlaintextScrubResult | null = null;
      if (complete) {
        assertNotAborted(input.signal);
        attestation = await store.complete({
          ownerId: input.ownerId,
          scrubId: input.scrubId,
          expectedCursor: cursor
        });
        assertNotAborted(input.signal);
      }

      return Object.freeze({
        phase: attestation === null ? "scrubbing" : "attested",
        scrubId: prepared.scrubId,
        cursor,
        processedCount,
        deletedChunkCount,
        deletedIdempotencyCount,
        batchCount,
        attestation
      });
    }
  });
}
