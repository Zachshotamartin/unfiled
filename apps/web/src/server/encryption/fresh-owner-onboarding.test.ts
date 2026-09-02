import { describe, expect, it, vi } from "vitest";

import {
  freshOwnerOnboardingEnabled,
  freshOwnerOnboardingRpcFunctions,
  FreshOwnerOnboardingRolloutSource,
  isFreshOwnerRollout
} from "./fresh-owner-onboarding";
import type { ContentEncryptionRollout } from "./rollout-rpc-source";
import type { ServiceRpcClient } from "./service-rpc-client";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const context = { userId: OWNER_ID } as never;

type State = ContentEncryptionRollout["state"];

function readiness(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    readyForEncryptedRead: true,
    requiredObjectCount: 0,
    exactVerifiedObjectCount: 0,
    missingObjectCount: 0,
    missingBySurface: {},
    activeKeySlots: 4,
    taxonomyEpochReady: true,
    backfillComplete: true,
    ...overrides
  };
}

/** In-memory stand-in for the database rollout functions with their preconditions. */
function simulator(initial: State, overrides: Readonly<Record<string, unknown>> = {}) {
  const db = {
    state: initial,
    keysActive: false,
    backfillComplete: false,
    scrub: null as null | { scrubId: string; cursor: string | null; completedAt: string | null },
    calls: [] as string[]
  };
  const fail = () => {
    throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
  };
  const rollout = {
    rolloutForOwner: vi.fn(async (): Promise<ContentEncryptionRollout> => {
      await Promise.resolve();
      return {
        found: true,
        state: db.state,
        writeMode: db.state === "expanded" ? "legacy" : "encrypted",
        readMode: db.state === "expanded" || db.state === "dual_write" ? "legacy" : "encrypted",
        backfill:
          db.state === "expanded"
            ? null
            : {
                cursor: null,
                complete: db.backfillComplete,
                encryptedObjectCount: 0,
                verifiedObjectCount: 0
              },
        plaintextScrub:
          db.scrub === null
            ? null
            : {
                scrubId: db.scrub.scrubId,
                version: 1,
                startedAt: "2026-09-02T00:00:00.000Z",
                cursor: db.scrub.cursor,
                completedAt: db.scrub.completedAt,
                scrubbedRowCount: 0,
                deletedChunkCount: 0,
                deletedIdempotencyCount: 0,
                attestationDigest: db.scrub.completedAt === null ? null : "a".repeat(64),
                lastRequestDigest: null,
                lastResultDigest: null
              },
        readiness: readiness(overrides)
      };
    })
  };
  const rpcImplementation = async (
    name: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown> => {
    await Promise.resolve();
    db.calls.push(name);
    expect(params.p_owner_id).toBe(OWNER_ID);
    switch (name) {
      case "advance_content_encryption_rollout": {
        if (params.p_expected_state !== db.state) fail();
        if (params.p_next_state === "dual_write" && !db.keysActive) fail();
        if (params.p_next_state === "encrypted_read" && !db.backfillComplete) fail();
        if (params.p_next_state === "encrypted_only" && db.scrub?.completedAt == null) fail();
        db.state = params.p_next_state as State;
        return {
          state: db.state,
          readMode: db.state === "dual_write" ? "legacy" : "encrypted",
          replayed: false
        };
      }
      case "complete_content_encryption_backfill": {
        if (db.state !== "dual_write" || params.p_expected_cursor !== null) fail();
        db.backfillComplete = true;
        return { complete: true, replayed: false };
      }
      case "prepare_content_plaintext_scrub": {
        if (db.state !== "encrypted_read" || db.scrub !== null) fail();
        db.scrub = { scrubId: String(params.p_scrub_id), cursor: null, completedAt: null };
        return { prepared: true };
      }
      case "scrub_content_plaintext_batch": {
        const scrub = db.scrub;
        if (scrub === null || scrub.scrubId !== params.p_scrub_id) return fail();
        if (params.p_expected_cursor !== scrub.cursor) return fail();
        return { complete: true, processedCount: 0, cursor: null };
      }
      case "complete_content_plaintext_scrub": {
        const scrub = db.scrub;
        if (scrub === null || params.p_expected_cursor !== null) return fail();
        db.scrub = {
          scrubId: scrub.scrubId,
          cursor: scrub.cursor,
          completedAt: "2026-09-02T00:00:01.000Z"
        };
        return { completed: true };
      }
      default:
        return fail();
    }
  };
  const holder = { rpc: rpcImplementation };
  const client = {
    rpc: vi.fn((name: string, params: Readonly<Record<string, unknown>>) =>
      holder.rpc(name, params)
    )
  } as unknown as ServiceRpcClient;
  const ensureOwnerKeys = vi.fn(async () => {
    await Promise.resolve();
    db.keysActive = true;
  });
  return { db, rollout, client, ensureOwnerKeys, holder };
}

function source(sim: ReturnType<typeof simulator>, enabled = true) {
  return new FreshOwnerOnboardingRolloutSource({
    rollout: sim.rollout,
    client: sim.client,
    ensureOwnerKeys: sim.ensureOwnerKeys,
    enabled,
    createScrubId: () => "scrub-1",
    createBatchReference: () => "batch-1"
  });
}

describe("fresh owner onboarding", () => {
  it("drives a brand-new owner through the official rollout to encrypted_only", async () => {
    const sim = simulator("expanded");
    expect(await source(sim).stateForOwner(context)).toBe("encrypted_only");
    expect(sim.ensureOwnerKeys).toHaveBeenCalledTimes(1);
    expect(sim.db.calls).toEqual([
      "advance_content_encryption_rollout",
      "complete_content_encryption_backfill",
      "advance_content_encryption_rollout",
      "prepare_content_plaintext_scrub",
      "scrub_content_plaintext_batch",
      "complete_content_plaintext_scrub",
      "advance_content_encryption_rollout"
    ]);
    expect(sim.db.state).toBe("encrypted_only");
  });

  it("is a pass-through when legacy content keys are configured", async () => {
    const sim = simulator("expanded");
    expect(await source(sim, false).stateForOwner(context)).toBe("expanded");
    expect(sim.db.calls).toEqual([]);
    expect(sim.ensureOwnerKeys).not.toHaveBeenCalled();
  });

  it("never touches an owner that still has legacy objects", async () => {
    const sim = simulator("expanded", { requiredObjectCount: 3, missingObjectCount: 3 });
    expect(await source(sim).stateForOwner(context)).toBe("expanded");
    expect(sim.db.calls).toEqual([]);
  });

  it("returns terminal states untouched", async () => {
    for (const state of ["encrypted_only", "contracted"] as const) {
      const sim = simulator(state);
      expect(await source(sim).stateForOwner(context)).toBe(state);
      expect(sim.db.calls).toEqual([]);
    }
  });

  it("resumes from dual_write and from encrypted_read", async () => {
    const fromDualWrite = simulator("dual_write");
    expect(await source(fromDualWrite).stateForOwner(context)).toBe("encrypted_only");
    expect(fromDualWrite.ensureOwnerKeys).not.toHaveBeenCalled();
    expect(fromDualWrite.db.calls[0]).toBe("complete_content_encryption_backfill");

    const fromEncryptedRead = simulator("encrypted_read");
    fromEncryptedRead.db.backfillComplete = true;
    expect(await source(fromEncryptedRead).stateForOwner(context)).toBe("encrypted_only");
    expect(fromEncryptedRead.db.calls[0]).toBe("prepare_content_plaintext_scrub");
  });

  it("recovers when a concurrent request advanced the owner first", async () => {
    const sim = simulator("expanded");
    const original = sim.holder.rpc;
    let raced = false;
    sim.holder.rpc = async (name, params) => {
      if (!raced && name === "advance_content_encryption_rollout") {
        raced = true;
        sim.db.state = "dual_write";
        throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
      }
      return original(name, params);
    };
    expect(await source(sim).stateForOwner(context)).toBe("encrypted_only");
  });

  it("fails closed after bounded attempts when the database keeps refusing", async () => {
    const sim = simulator("expanded");
    sim.holder.rpc = async () => {
      await Promise.resolve();
      throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
    };
    await expect(source(sim).stateForOwner(context)).rejects.toBeInstanceOf(ServiceRpcError);
  });

  it("propagates non-rollout failures immediately", async () => {
    const sim = simulator("expanded");
    sim.ensureOwnerKeys.mockRejectedValueOnce(new TypeError("kms down"));
    await expect(source(sim).stateForOwner(context)).rejects.toBeInstanceOf(TypeError);
    expect(sim.db.calls).toEqual([]);
  });

  it("reports freshness and the enabling condition precisely", () => {
    expect(freshOwnerOnboardingEnabled({})).toBe(true);
    expect(freshOwnerOnboardingEnabled({ UNFILED_CONTENT_KEK: " " })).toBe(true);
    expect(freshOwnerOnboardingEnabled({ UNFILED_CONTENT_KEK: "configured" })).toBe(false);
    expect(freshOwnerOnboardingRpcFunctions).toEqual([
      "get_content_encryption_rollout",
      "advance_content_encryption_rollout",
      "complete_content_encryption_backfill",
      "prepare_content_plaintext_scrub",
      "scrub_content_plaintext_batch",
      "complete_content_plaintext_scrub"
    ]);
    expect(
      isFreshOwnerRollout({
        found: false,
        state: "expanded",
        writeMode: "legacy",
        readMode: "legacy",
        backfill: null,
        plaintextScrub: null,
        readiness: readiness()
      })
    ).toBe(true);
  });
});
