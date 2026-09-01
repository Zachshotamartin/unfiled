import { describe, expect, it, vi } from "vitest";

import {
  createPlaintextScrubRpcStore,
  plaintextScrubRpcFunctions
} from "./plaintext-scrub-rpc-store";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const SCRUB_ID = "22222222-2222-4222-8222-222222222222";
const CURSOR = "03:note:note_01J00000000000000000000000";

function harness(response: unknown) {
  const rpc = vi.fn(() => Promise.resolve(response));
  return {
    rpc,
    store: createPlaintextScrubRpcStore(Object.freeze({ rpc }) satisfies ServiceRpcClient)
  };
}

describe("plaintext scrub RPC store", () => {
  it("exposes the exact bounded service capability set", () => {
    expect(plaintextScrubRpcFunctions).toEqual([
      "prepare_content_plaintext_scrub",
      "scrub_content_plaintext_batch",
      "complete_content_plaintext_scrub"
    ]);
    expect(Object.isFrozen(plaintextScrubRpcFunctions)).toBe(true);
  });

  it("prepares only encrypted-read cutovers and strictly parses replay state", async () => {
    const input = harness({
      scrubId: SCRUB_ID,
      cursor: null,
      complete: false,
      replayed: false
    });

    await expect(
      input.store.prepare({ ownerId: OWNER_ID.toUpperCase(), scrubId: SCRUB_ID.toUpperCase() })
    ).resolves.toEqual({ scrubId: SCRUB_ID, cursor: null, complete: false, replayed: false });
    expect(input.rpc).toHaveBeenCalledWith("prepare_content_plaintext_scrub", {
      p_owner_id: OWNER_ID,
      p_scrub_id: SCRUB_ID,
      p_expected_state: "encrypted_read"
    });
  });

  it("submits bounded cursor batches and verifies their accounting", async () => {
    const input = harness({
      scrubId: SCRUB_ID,
      expectedCursor: null,
      cursor: CURSOR,
      processedCount: 9,
      deletedChunkCount: 2,
      deletedIdempotencyCount: 1,
      complete: false,
      replayed: false
    });

    await expect(
      input.store.scrubBatch({
        ownerId: OWNER_ID,
        scrubId: SCRUB_ID,
        expectedCursor: null,
        limit: 9
      })
    ).resolves.toEqual({
      scrubId: SCRUB_ID,
      expectedCursor: null,
      cursor: CURSOR,
      processedCount: 9,
      deletedChunkCount: 2,
      deletedIdempotencyCount: 1,
      complete: false,
      replayed: false
    });
    expect(input.rpc).toHaveBeenCalledWith("scrub_content_plaintext_batch", {
      p_owner_id: OWNER_ID,
      p_scrub_id: SCRUB_ID,
      p_expected_cursor: null,
      p_limit: 9
    });

    const terminal = harness({
      scrubId: SCRUB_ID,
      expectedCursor: CURSOR,
      cursor: CURSOR,
      processedCount: 0,
      deletedChunkCount: 0,
      deletedIdempotencyCount: 0,
      complete: true,
      replayed: true
    });
    await expect(
      terminal.store.scrubBatch({
        ownerId: OWNER_ID,
        scrubId: SCRUB_ID,
        expectedCursor: CURSOR
      })
    ).resolves.toMatchObject({ complete: true, replayed: true });
  });

  it("accepts only a complete, fixed-size attestation from completion", async () => {
    const input = harness({
      scrubId: SCRUB_ID,
      complete: true,
      attestationDigest: "a".repeat(64),
      replayed: false
    });

    await expect(
      input.store.complete({ ownerId: OWNER_ID, scrubId: SCRUB_ID, expectedCursor: CURSOR })
    ).resolves.toEqual({
      scrubId: SCRUB_ID,
      complete: true,
      attestationDigest: "a".repeat(64),
      replayed: false
    });
    expect(input.rpc).toHaveBeenCalledWith("complete_content_plaintext_scrub", {
      p_owner_id: OWNER_ID,
      p_scrub_id: SCRUB_ID,
      p_expected_cursor: CURSOR
    });
  });

  it("rejects invalid caller input before invoking the privileged client", async () => {
    const input = harness({});
    const calls = [
      () => input.store.prepare({ ownerId: "not-owner", scrubId: SCRUB_ID }),
      () => input.store.prepare({ ownerId: OWNER_ID, scrubId: "not-scrub" }),
      () =>
        input.store.scrubBatch({
          ownerId: OWNER_ID,
          scrubId: SCRUB_ID,
          expectedCursor: "private plaintext cursor",
          limit: 50
        }),
      () =>
        input.store.scrubBatch({
          ownerId: OWNER_ID,
          scrubId: SCRUB_ID,
          expectedCursor: null,
          limit: 251
        })
    ] as const;

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    }
    expect(input.rpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "extra response field",
      operation: "prepare" as const,
      response: {
        scrubId: SCRUB_ID,
        cursor: null,
        complete: false,
        replayed: false,
        leaked: "private-canary"
      }
    },
    {
      name: "impossible deletion accounting",
      operation: "batch" as const,
      response: {
        scrubId: SCRUB_ID,
        expectedCursor: null,
        cursor: CURSOR,
        processedCount: 1,
        deletedChunkCount: 1,
        deletedIdempotencyCount: 1,
        complete: false,
        replayed: false
      }
    },
    {
      name: "content-bearing cursor",
      operation: "batch" as const,
      response: {
        scrubId: SCRUB_ID,
        expectedCursor: null,
        cursor: "private plaintext cursor",
        processedCount: 1,
        deletedChunkCount: 0,
        deletedIdempotencyCount: 0,
        complete: false,
        replayed: false
      }
    },
    {
      name: "invalid completion digest",
      operation: "complete" as const,
      response: {
        scrubId: SCRUB_ID,
        complete: true,
        attestationDigest: "private-canary",
        replayed: false
      }
    }
  ])(
    "fails closed on $name without reflecting projection content",
    async ({ operation, response }) => {
      const input = harness(response);
      let error: unknown;
      try {
        if (operation === "prepare") {
          await input.store.prepare({ ownerId: OWNER_ID, scrubId: SCRUB_ID });
        } else if (operation === "batch") {
          await input.store.scrubBatch({
            ownerId: OWNER_ID,
            scrubId: SCRUB_ID,
            expectedCursor: null,
            limit: 2
          });
        } else {
          await input.store.complete({
            ownerId: OWNER_ID,
            scrubId: SCRUB_ID,
            expectedCursor: null
          });
        }
      } catch (cause: unknown) {
        error = cause;
      }
      expect(error).toBeInstanceOf(ServiceRpcError);
      expect(error).toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
      expect(JSON.stringify(error)).not.toContain("private-canary");
    }
  );
});
