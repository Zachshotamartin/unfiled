import type {
  ManagedKeyRecordV1,
  ManagedKeyRecordV2,
  ManagedKeyStore
} from "@unfiled/key-management";
import { describe, expect, it, vi } from "vitest";

import type { ServiceRpcClient } from "./service-rpc-client";
import {
  createManagedKeyRpcStore,
  createObjectWrapReservationPort,
  managedKeyRpcFunctions
} from "./managed-key-rpc-store";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const RESERVATION_ID = "22222222-2222-4222-8222-222222222222";

function record(overrides: Partial<ManagedKeyRecordV1> = {}): ManagedKeyRecordV1 {
  return {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    keyClass: "ai_assisted",
    purpose: "object_wrap",
    keyId: "key_ai_wrap_1",
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: "AQIDBA",
    rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555",
    createdAt: "2026-08-30T12:00:00.000Z",
    activatedAt: "2026-08-30T12:01:00.000Z",
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 0,
    wrapOperationLimit: 16_777_216,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    },
    ...overrides
  };
}

function v2Record(overrides: Partial<ManagedKeyRecordV2> = {}): ManagedKeyRecordV2 {
  const encryptedKeyMaterial = Buffer.from([
    0x55,
    0x46,
    0x45,
    0x4b,
    0x01,
    ...new Uint8Array(60).fill(7)
  ]).toString("base64url");
  return {
    schemaVersion: 2,
    custodyProvider: "vercel_sensitive_environment_v1",
    ownerId: OWNER_ID,
    keyClass: "ai_assisted",
    purpose: "object_wrap",
    keyId: "key_ai_wrap_v2",
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial,
    rootKeyId:
      "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-2222-4222-8222-222222222222",
    wrapAlgorithm: "AES-256-GCM",
    createdAt: "2026-09-02T12:00:00.000Z",
    activatedAt: "2026-09-02T12:01:00.000Z",
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 0,
    wrapOperationLimit: 16_777_216,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyId: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    },
    ...overrides
  };
}

function client(implementation: ServiceRpcClient["rpc"]): ServiceRpcClient {
  return Object.freeze({ rpc: implementation });
}

describe("managed key RPC store", () => {
  it("maps the exact active and by-id RPC contracts", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name) => {
      if (name === "get_active_user_content_key") {
        return Promise.resolve({ found: true, nextVersion: 2, record: record() });
      }
      return Promise.resolve(record());
    });
    const store = createManagedKeyRpcStore(client(rpc));

    await expect(
      store.findActive({ ownerId: OWNER_ID, keyClass: "ai_assisted", purpose: "object_wrap" })
    ).resolves.toEqual(record());
    await expect(
      store.findById({
        ownerId: OWNER_ID,
        keyClass: "ai_assisted",
        purpose: "object_wrap",
        keyId: "key_ai_wrap_1"
      })
    ).resolves.toEqual(record());

    expect(rpc).toHaveBeenNthCalledWith(1, "get_active_user_content_key", {
      p_owner_id: OWNER_ID,
      p_key_class: "ai_assisted",
      p_key_purpose: "object_wrap"
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_user_content_key_by_id", {
      p_owner_id: OWNER_ID,
      p_key_id: "key_ai_wrap_1",
      p_key_class: "ai_assisted",
      p_key_purpose: "object_wrap"
    });
  });

  it("returns null only for the exact not-found projection", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      found: false,
      nextVersion: 1
    });
    const store = createManagedKeyRpcStore(client(rpc));

    await expect(
      store.findActive({ ownerId: OWNER_ID, keyClass: "private_manual", purpose: "content_mac" })
    ).resolves.toBeNull();
  });

  it("accepts exact V2 projections only when the store is explicitly V2", async () => {
    const value = v2Record();
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name) =>
      Promise.resolve(
        name === "get_active_user_content_key"
          ? { found: true, nextVersion: 2, record: value }
          : value
      )
    );
    const store = createManagedKeyRpcStore(client(rpc), { schemaVersion: 2 });

    await expect(
      store.findActive({ ownerId: OWNER_ID, keyClass: "ai_assisted", purpose: "object_wrap" })
    ).resolves.toEqual(value);
    await expect(
      store.findById({
        ownerId: OWNER_ID,
        keyClass: "ai_assisted",
        purpose: "object_wrap",
        keyId: value.keyId
      })
    ).resolves.toEqual(value);

    const v1Store = createManagedKeyRpcStore(
      client(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(value))
    );
    await expect(
      v1Store.findById({
        ownerId: OWNER_ID,
        keyClass: "ai_assisted",
        purpose: "object_wrap",
        keyId: value.keyId
      })
    ).rejects.toBeInstanceOf(ServiceRpcError);
  });

  it.each([
    { found: false, nextVersion: 1, plaintext: "leak" },
    { found: true, nextVersion: 1 },
    { found: true, nextVersion: 0, record: record() },
    {
      found: true,
      nextVersion: 2,
      record: record({ ownerId: "33333333-3333-4333-8333-333333333333" })
    }
  ])("fails closed for malformed or cross-owner active projections", async (projection) => {
    const store = createManagedKeyRpcStore(
      client(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection))
    );

    const result = store.findActive({
      ownerId: OWNER_ID,
      keyClass: "ai_assisted",
      purpose: "object_wrap"
    });
    await expect(result).rejects.toMatchObject({
      name: "ServiceRpcError",
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    await expect(result).rejects.not.toThrow("leak");
  });

  it("keeps its least-privilege allowlist explicit", () => {
    expect(managedKeyRpcFunctions).toEqual([
      "get_active_user_content_key",
      "get_user_content_key_by_id",
      "reserve_content_key_operations"
    ]);
  });
});

describe("object-wrap operation reservations", () => {
  function activeStore(value: ManagedKeyRecordV1 = record()): ManagedKeyStore {
    return Object.freeze({
      findActive: vi.fn().mockResolvedValue(value),
      findById: vi.fn()
    });
  }

  it("reserves exactly one operation against the selected active key", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      reservationId: RESERVATION_ID,
      keyId: "key_ai_wrap_1",
      keyClass: "ai_assisted",
      keyPurpose: "object_wrap",
      keyVersion: 1,
      operationCount: 1,
      consumed: false,
      replayed: false
    });
    const port = createObjectWrapReservationPort(client(rpc), activeStore(), {
      createReservationId: () => RESERVATION_ID
    });

    await expect(
      port.reserveObjectWrappingKey({ ownerId: OWNER_ID, keyClass: "ai_assisted" })
    ).resolves.toEqual({
      reservationId: RESERVATION_ID,
      reference: {
        ownerId: OWNER_ID,
        keyClass: "ai_assisted",
        purpose: "object_wrap",
        keyId: "key_ai_wrap_1",
        keyVersion: 1
      }
    });
    expect(rpc).toHaveBeenCalledWith("reserve_content_key_operations", {
      p_owner_id: OWNER_ID,
      p_reservation_id: RESERVATION_ID,
      p_key_class: "ai_assisted",
      p_key_id: "key_ai_wrap_1",
      p_key_version: 1,
      p_operation_count: 1
    });
  });

  it.each([
    { consumed: true },
    { keyId: "key_substituted" },
    { keyClass: "private_manual" },
    { operationCount: 2 },
    { plaintext: "must-not-pass" }
  ])("rejects a mismatched, consumed, or widened reservation", async (override) => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      reservationId: RESERVATION_ID,
      keyId: "key_ai_wrap_1",
      keyClass: "ai_assisted",
      keyPurpose: "object_wrap",
      keyVersion: 1,
      operationCount: 1,
      consumed: false,
      replayed: false,
      ...override
    });
    const port = createObjectWrapReservationPort(client(rpc), activeStore(), {
      createReservationId: () => RESERVATION_ID
    });

    await expect(
      port.reserveObjectWrappingKey({ ownerId: OWNER_ID, keyClass: "ai_assisted" })
    ).rejects.toBeInstanceOf(ServiceRpcError);
  });

  it("does not call the database without an active key or a valid reservation ID", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const noKey = createObjectWrapReservationPort(
      client(rpc),
      Object.freeze({ findActive: vi.fn().mockResolvedValue(null), findById: vi.fn() })
    );
    await expect(
      noKey.reserveObjectWrappingKey({ ownerId: OWNER_ID, keyClass: "ai_assisted" })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.KEY_UNAVAILABLE });

    const invalidId = createObjectWrapReservationPort(client(rpc), activeStore(), {
      createReservationId: () => "not-a-uuid"
    });
    await expect(
      invalidId.reserveObjectWrappingKey({ ownerId: OWNER_ID, keyClass: "ai_assisted" })
    ).rejects.toBeInstanceOf(ServiceRpcError);
    expect(rpc).not.toHaveBeenCalled();
  });
});
