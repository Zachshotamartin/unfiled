import { describe, expect, it, vi } from "vitest";

import type { PlaintextScrubRpcStore } from "./plaintext-scrub-rpc-store";
import { createPlaintextScrubCoordinator } from "./plaintext-scrub-coordinator";
import { ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const SCRUB_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_CURSOR = "03:note:note_01J00000000000000000000000";
const LAST_CURSOR = "14:note_chunk:chk_01J00000000000000000000000";
const DIGEST = "a".repeat(64);

function harness() {
  const prepare = vi.fn<PlaintextScrubRpcStore["prepare"]>(() =>
    Promise.resolve({ scrubId: SCRUB_ID, cursor: null, complete: false, replayed: false })
  );
  const scrubBatch = vi.fn<PlaintextScrubRpcStore["scrubBatch"]>();
  const complete = vi.fn<PlaintextScrubRpcStore["complete"]>(() =>
    Promise.resolve({
      scrubId: SCRUB_ID,
      complete: true,
      attestationDigest: DIGEST,
      replayed: false
    })
  );
  return {
    complete,
    coordinator: createPlaintextScrubCoordinator({ prepare, scrubBatch, complete }),
    prepare,
    scrubBatch
  };
}

describe("plaintext scrub coordinator", () => {
  it("runs a bounded resumable slice without advancing rollout state", async () => {
    const input = harness();
    input.scrubBatch
      .mockResolvedValueOnce({
        scrubId: SCRUB_ID,
        expectedCursor: null,
        cursor: FIRST_CURSOR,
        processedCount: 50,
        deletedChunkCount: 0,
        deletedIdempotencyCount: 1,
        complete: false,
        replayed: false
      })
      .mockResolvedValueOnce({
        scrubId: SCRUB_ID,
        expectedCursor: FIRST_CURSOR,
        cursor: LAST_CURSOR,
        processedCount: 50,
        deletedChunkCount: 4,
        deletedIdempotencyCount: 0,
        complete: false,
        replayed: false
      });

    await expect(
      input.coordinator.runSlice({
        ownerId: OWNER_ID,
        scrubId: SCRUB_ID,
        expectedCursor: null,
        batchLimit: 50,
        maxBatches: 2
      })
    ).resolves.toEqual({
      phase: "scrubbing",
      scrubId: SCRUB_ID,
      cursor: LAST_CURSOR,
      processedCount: 100,
      deletedChunkCount: 4,
      deletedIdempotencyCount: 1,
      batchCount: 2,
      attestation: null
    });
    expect(input.scrubBatch).toHaveBeenNthCalledWith(1, {
      ownerId: OWNER_ID,
      scrubId: SCRUB_ID,
      expectedCursor: null,
      limit: 50
    });
    expect(input.scrubBatch).toHaveBeenNthCalledWith(2, {
      ownerId: OWNER_ID,
      scrubId: SCRUB_ID,
      expectedCursor: FIRST_CURSOR,
      limit: 50
    });
    expect(input.complete).not.toHaveBeenCalled();
  });

  it("completes and attests only after the database reports no remaining work", async () => {
    const input = harness();
    input.prepare.mockResolvedValue({
      scrubId: SCRUB_ID,
      cursor: FIRST_CURSOR,
      complete: false,
      replayed: true
    });
    input.scrubBatch.mockResolvedValue({
      scrubId: SCRUB_ID,
      expectedCursor: FIRST_CURSOR,
      cursor: LAST_CURSOR,
      processedCount: 3,
      deletedChunkCount: 1,
      deletedIdempotencyCount: 1,
      complete: true,
      replayed: false
    });

    const result = await input.coordinator.runSlice({
      ownerId: OWNER_ID,
      scrubId: SCRUB_ID,
      expectedCursor: FIRST_CURSOR,
      maxBatches: 5
    });

    expect(result).toEqual({
      phase: "attested",
      scrubId: SCRUB_ID,
      cursor: LAST_CURSOR,
      processedCount: 3,
      deletedChunkCount: 1,
      deletedIdempotencyCount: 1,
      batchCount: 1,
      attestation: {
        scrubId: SCRUB_ID,
        complete: true,
        attestationDigest: DIGEST,
        replayed: false
      }
    });
    expect(input.complete).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      scrubId: SCRUB_ID,
      expectedCursor: LAST_CURSOR
    });
  });

  it("re-attests a completed scrub without running another batch", async () => {
    const input = harness();
    input.prepare.mockResolvedValue({
      scrubId: SCRUB_ID,
      cursor: LAST_CURSOR,
      complete: true,
      replayed: true
    });

    await expect(
      input.coordinator.runSlice({
        ownerId: OWNER_ID,
        scrubId: SCRUB_ID,
        expectedCursor: LAST_CURSOR
      })
    ).resolves.toMatchObject({ phase: "attested", batchCount: 0, cursor: LAST_CURSOR });
    expect(input.scrubBatch).not.toHaveBeenCalled();
    expect(input.complete).toHaveBeenCalledOnce();
  });

  it("fails before mutation on stale cursors, invalid bounds, and cancellation", async () => {
    const stale = harness();
    stale.prepare.mockResolvedValue({
      scrubId: SCRUB_ID,
      cursor: FIRST_CURSOR,
      complete: false,
      replayed: true
    });
    await expect(
      stale.coordinator.runSlice({
        ownerId: OWNER_ID,
        scrubId: SCRUB_ID,
        expectedCursor: LAST_CURSOR
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.STALE_MAINTENANCE_CURSOR });
    expect(stale.scrubBatch).not.toHaveBeenCalled();

    const invalid = harness();
    await expect(
      invalid.coordinator.runSlice({ ownerId: OWNER_ID, scrubId: SCRUB_ID, maxBatches: 21 })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    expect(invalid.prepare).not.toHaveBeenCalled();

    const cancelled = harness();
    const signal = AbortSignal.abort();
    await expect(
      cancelled.coordinator.runSlice({ ownerId: OWNER_ID, scrubId: SCRUB_ID, signal })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(cancelled.prepare).not.toHaveBeenCalled();
  });

  it("does not attest when cancellation wins after a terminal batch", async () => {
    const input = harness();
    const controller = new AbortController();
    input.scrubBatch.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        scrubId: SCRUB_ID,
        expectedCursor: null,
        cursor: LAST_CURSOR,
        processedCount: 1,
        deletedChunkCount: 1,
        deletedIdempotencyCount: 0,
        complete: true,
        replayed: false
      });
    });

    await expect(
      input.coordinator.runSlice({
        ownerId: OWNER_ID,
        scrubId: SCRUB_ID,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(input.complete).not.toHaveBeenCalled();
  });
});
