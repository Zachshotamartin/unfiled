import { describe, expect, it, vi } from "vitest";

import {
  ContentEncryptionRolloutRpcSource,
  parseContentEncryptionRollout,
  rolloutRpcFunctions
} from "./rollout-rpc-source";
import type { ServiceRpcClient } from "./service-rpc-client";
import { ServiceRpcError } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";

function readiness(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    readyForEncryptedRead: false,
    requiredObjectCount: 3,
    exactVerifiedObjectCount: 2,
    missingObjectCount: 1,
    missingBySurface: { note_content: 1 },
    activeKeySlots: 4,
    taxonomyEpochReady: true,
    backfillComplete: false,
    ...overrides
  };
}

function present(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    found: true,
    state: "dual_write",
    writeMode: "encrypted",
    readMode: "legacy",
    backfill: {
      cursor: "note_content:note_01",
      complete: false,
      encryptedObjectCount: 2,
      verifiedObjectCount: 2
    },
    readiness: readiness(),
    ...overrides
  };
}

describe("content encryption rollout RPC source", () => {
  it("parses the exact absent-owner projection as expanded legacy mode", () => {
    const parsed = parseContentEncryptionRollout({
      found: false,
      state: "expanded",
      writeMode: "legacy",
      readMode: "legacy",
      readiness: readiness({
        requiredObjectCount: 0,
        exactVerifiedObjectCount: 0,
        missingObjectCount: 0,
        missingBySurface: {},
        activeKeySlots: 0,
        taxonomyEpochReady: false
      })
    });

    expect(parsed).toMatchObject({
      found: false,
      state: "expanded",
      writeMode: "legacy",
      readMode: "legacy",
      backfill: null
    });
  });

  it("parses authoritative progress without treating counters as proof", () => {
    const parsed = parseContentEncryptionRollout(
      present({
        readiness: readiness({
          readyForEncryptedRead: false,
          requiredObjectCount: 2,
          exactVerifiedObjectCount: 2,
          missingObjectCount: 0,
          missingBySurface: {},
          activeKeySlots: 4,
          taxonomyEpochReady: true,
          backfillComplete: false
        })
      })
    );

    expect(parsed.readiness.readyForEncryptedRead).toBe(false);
    expect(parsed.backfill).toEqual({
      cursor: "note_content:note_01",
      complete: false,
      encryptedObjectCount: 2,
      verifiedObjectCount: 2
    });
  });

  it("looks up state by authenticated repository owner", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(present());
    const source = new ContentEncryptionRolloutRpcSource(Object.freeze({ rpc }));

    await expect(
      source.stateForOwner({ accessToken: "not-forwarded", userId: OWNER_ID })
    ).resolves.toBe("dual_write");
    expect(rpc).toHaveBeenCalledWith("get_content_encryption_rollout", {
      p_owner_id: OWNER_ID
    });
  });

  it.each([
    present({ plaintext: "must-not-pass" }),
    present({ writeMode: "legacy" }),
    present({ readMode: "encrypted" }),
    present({ state: "unknown" }),
    present({
      backfill: {
        cursor: null,
        complete: false,
        encryptedObjectCount: 1,
        verifiedObjectCount: 2
      }
    }),
    present({
      readiness: readiness({ missingBySurface: { unknown_surface: 1 } })
    }),
    present({
      readiness: readiness({ missingBySurface: {} })
    }),
    present({
      readiness: readiness({ readyForEncryptedRead: true })
    }),
    present({
      readiness: readiness({ backfillComplete: true })
    })
  ])("fails closed for malformed or internally inconsistent projections", (projection) => {
    expect(() => parseContentEncryptionRollout(projection)).toThrow(ServiceRpcError);
  });

  it("keeps rollout lookup capability explicit", () => {
    expect(rolloutRpcFunctions).toEqual(["get_content_encryption_rollout"]);
  });
});
