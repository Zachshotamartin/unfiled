import type { ManagedKeyRecordV2 } from "@unfiled/key-management";
import { describe, expect, it, vi } from "vitest";

import {
  managedKeyRewrapRpcFunctions,
  persistVercelSensitiveEnvironmentKeyRewrap
} from "./managed-key-rewrap";
import type { ServiceRpcClient } from "./service-rpc-client";
import { ServiceRpcError } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OLD_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:22222222-2222-4222-8222-222222222222";
const NEW_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:33333333-3333-4333-8333-333333333333";

function envelope(fill: number): string {
  return Buffer.from([0x55, 0x46, 0x45, 0x4b, 0x01, ...new Uint8Array(60).fill(fill)]).toString(
    "base64url"
  );
}

function previous(): ManagedKeyRecordV2 {
  return {
    schemaVersion: 2,
    custodyProvider: "vercel_sensitive_environment_v1",
    ownerId: OWNER_ID,
    keyClass: "private_manual",
    purpose: "object_wrap",
    keyId: "key_private_wrap_1",
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: envelope(1),
    rootKeyId: OLD_ROOT,
    wrapAlgorithm: "AES-256-GCM",
    createdAt: "2026-09-02T12:00:00.000Z",
    activatedAt: "2026-09-02T12:01:00.000Z",
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 7,
    wrapOperationLimit: 16_777_216,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyId: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    }
  };
}

function rewrapped(overrides: Partial<ManagedKeyRecordV2> = {}): ManagedKeyRecordV2 {
  return {
    ...previous(),
    encryptedKeyMaterial: envelope(2),
    rootKeyId: NEW_ROOT,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyId: OLD_ROOT,
      rootRewrapCount: 1,
      lastRootRewrappedAt: "2026-09-02T12:02:00.000Z"
    },
    ...overrides
  };
}

function client(rpc: ServiceRpcClient["rpc"]): ServiceRpcClient {
  return Object.freeze({ rpc });
}

describe("Vercel sensitive-environment managed-key rewrap persistence", () => {
  it("commits the exact V2 compare-and-swap without plaintext or root material", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      keyId: "key_private_wrap_1",
      state: "active",
      rootRewrapCount: 1,
      rewrapped: true,
      replayed: false
    });
    const next = rewrapped();

    await expect(
      persistVercelSensitiveEnvironmentKeyRewrap(client(rpc), previous(), next)
    ).resolves.toEqual({
      keyId: "key_private_wrap_1",
      state: "active",
      rootRewrapCount: 1,
      rewrapped: true,
      replayed: false
    });

    expect(rpc).toHaveBeenCalledWith("rewrap_user_content_key_v2", {
      p_owner_id: OWNER_ID,
      p_key_id: "key_private_wrap_1",
      p_expected_root_key_id: OLD_ROOT,
      p_expected_root_rewrap_count: 0,
      p_new_root_key_id: NEW_ROOT,
      p_new_wrapped_intermediate_key: `\\x${Buffer.from(
        next.encryptedKeyMaterial,
        "base64url"
      ).toString("hex")}`
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("keyMaterial");
  });

  it.each([
    rewrapped({ ownerId: "44444444-4444-4444-8444-444444444444" }),
    rewrapped({ rootKeyId: OLD_ROOT }),
    rewrapped({ encryptedKeyMaterial: previous().encryptedKeyMaterial }),
    rewrapped({ wrapOperations: 8 }),
    rewrapped({ rotation: { ...rewrapped().rotation, previousRootKeyId: NEW_ROOT } })
  ])("rejects malformed rewrap transitions before database access", async (next) => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    await expect(
      persistVercelSensitiveEnvironmentKeyRewrap(client(rpc), previous(), next)
    ).rejects.toBeInstanceOf(ServiceRpcError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed for widened or mismatched database summaries", async () => {
    for (const projection of [
      {
        keyId: "other",
        state: "active",
        rootRewrapCount: 1,
        rewrapped: true,
        replayed: false
      },
      {
        keyId: "key_private_wrap_1",
        state: "active",
        rootRewrapCount: 1,
        rewrapped: true,
        replayed: false,
        rootKeyId: NEW_ROOT
      }
    ]) {
      await expect(
        persistVercelSensitiveEnvironmentKeyRewrap(
          client(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection)),
          previous(),
          rewrapped()
        )
      ).rejects.toBeInstanceOf(ServiceRpcError);
    }
  });

  it("keeps the V2 mutation capability explicit", () => {
    expect(managedKeyRewrapRpcFunctions).toEqual(["rewrap_user_content_key_v2"]);
  });
});
