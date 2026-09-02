import type {
  CreateIntermediateKeyRequest,
  IntermediateKeyCustodian,
  KeyBinding,
  KeyPurpose,
  ManagedKeyRecordV1,
  ManagedKeyRecordV2,
  ManagedKeyStore
} from "@unfiled/key-management";
import { describe, expect, it, vi } from "vitest";

import { ensureOwnerContentKeys, managedKeyBootstrapRpcFunctions } from "./managed-key-bootstrap";
import type { ServiceRpcClient } from "./service-rpc-client";
import { ServiceRpcError } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-30T12:00:00.000Z";
const ROOT_ARN = "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555";
const ROOT_ID =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-2222-4222-8222-222222222222";

function v2Envelope(): string {
  return Buffer.from([0x55, 0x46, 0x45, 0x4b, 0x01, ...new Uint8Array(60).fill(9)]).toString(
    "base64url"
  );
}

interface MutableStatus {
  active: Readonly<{ keyId: string; keyVersion: number }> | null;
  pending: Readonly<{ keyId: string; keyVersion: number }> | null;
  nextVersion: number;
}

function keyRecord(
  binding: KeyBinding,
  keyId: string,
  keyVersion: number,
  status: "active" | "pending"
): ManagedKeyRecordV1 {
  return {
    schemaVersion: 1,
    ...binding,
    keyId,
    keyVersion,
    status,
    encryptedKeyMaterial: "AQIDBA",
    rootKeyArn: ROOT_ARN,
    createdAt: CREATED_AT,
    activatedAt: status === "active" ? CREATED_AT : null,
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 0,
    wrapOperationLimit: 16_777_216,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    }
  };
}

function keyRecordV2(
  binding: KeyBinding,
  keyId: string,
  keyVersion: number,
  status: "active" | "pending"
): ManagedKeyRecordV2 {
  return {
    schemaVersion: 2,
    custodyProvider: "vercel_sensitive_environment_v1",
    ...binding,
    keyId,
    keyVersion,
    status,
    encryptedKeyMaterial: v2Envelope(),
    rootKeyId: ROOT_ID,
    wrapAlgorithm: "AES-256-GCM",
    createdAt: CREATED_AT,
    activatedAt: status === "active" ? CREATED_AT : null,
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 0,
    wrapOperationLimit: 16_777_216,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyId: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    }
  };
}

function allStatuses(initial: "active" | "empty"): Map<string, MutableStatus> {
  const statuses = new Map<string, MutableStatus>();
  for (const keyClass of ["ai_assisted", "private_manual"] as const) {
    for (const purpose of ["object_wrap", "content_mac"] as const) {
      statuses.set(`${keyClass}/${purpose}`, {
        active:
          initial === "active" ? { keyId: `key_${keyClass}_${purpose}`, keyVersion: 1 } : null,
        pending: null,
        nextVersion: initial === "active" ? 2 : 1
      });
    }
  }
  return statuses;
}

function rpcHarness(statuses: Map<string, MutableStatus>): Readonly<{
  client: ServiceRpcClient;
  rpc: ReturnType<typeof vi.fn<ServiceRpcClient["rpc"]>>;
}> {
  const rpc = vi.fn<ServiceRpcClient["rpc"]>((name, parameters) => {
    const keyClass = parameters.p_key_class;
    const purpose = parameters.p_key_purpose;
    if (name === "get_user_content_key_status") {
      const key = `${String(keyClass)}/${String(purpose)}`;
      const status = statuses.get(key);
      if (status === undefined) throw new Error("unexpected status binding");
      return Promise.resolve({ keyClass, keyPurpose: purpose, ...status });
    }
    if (name === "register_user_content_key" || name === "register_user_content_key_v2") {
      const key = `${String(keyClass)}/${String(purpose)}`;
      const status = statuses.get(key);
      if (status === undefined) throw new Error("unexpected register binding");
      const reference = {
        keyId: String(parameters.p_key_id),
        keyVersion: Number(parameters.p_key_version)
      };
      status.pending = reference;
      status.nextVersion = reference.keyVersion + 1;
      return Promise.resolve({
        ...reference,
        keyClass,
        keyPurpose: purpose,
        state: "pending",
        replayed: false
      });
    }
    if (name === "activate_user_content_key") {
      const found = [...statuses.entries()].find(([, status]) => {
        return (
          status.pending?.keyId === parameters.p_key_id ||
          status.active?.keyId === parameters.p_key_id
        );
      });
      if (found === undefined) throw new Error("unexpected activation");
      const [key, status] = found;
      const [foundClass, foundPurpose] = key.split("/") as [string, string];
      const reference = status.pending ?? status.active;
      if (reference === null) throw new Error("missing activation reference");
      const replayed = status.active?.keyId === reference.keyId;
      status.active = reference;
      status.pending = null;
      return Promise.resolve({
        ...reference,
        keyClass: foundClass,
        keyPurpose: foundPurpose,
        state: "active",
        replayed
      });
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return { client: Object.freeze({ rpc }), rpc };
}

function generatedV2Custodian(
  generated: CreateIntermediateKeyRequest[]
): IntermediateKeyCustodian<ManagedKeyRecordV2> {
  return Object.freeze({
    async withGeneratedIntermediateKey<Result>(
      request: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV2) => Promise<Result>
    ): Promise<Result> {
      generated.push(request);
      return use(
        new Uint8Array(32).fill(7),
        keyRecordV2(
          { ownerId: request.ownerId, keyClass: request.keyClass, purpose: request.purpose },
          request.keyId,
          request.keyVersion,
          "pending"
        )
      );
    },
    async withUnwrappedIntermediateKey<Result>(
      value: unknown,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV2) => Promise<Result>
    ): Promise<Result> {
      return use(new Uint8Array(32).fill(8), value as ManagedKeyRecordV2);
    }
  });
}

function generatedCustodian(
  generated: CreateIntermediateKeyRequest[],
  unwrapped: ManagedKeyRecordV1[] = []
): IntermediateKeyCustodian {
  return Object.freeze({
    async withGeneratedIntermediateKey<Result>(
      request: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>
    ): Promise<Result> {
      generated.push(request);
      return use(
        new Uint8Array(32).fill(7),
        keyRecord(
          {
            ownerId: request.ownerId,
            keyClass: request.keyClass,
            purpose: request.purpose
          },
          request.keyId,
          request.keyVersion,
          "pending"
        )
      );
    },
    async withUnwrappedIntermediateKey<Result>(
      value: unknown,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>
    ): Promise<Result> {
      const record = value as ManagedKeyRecordV1;
      unwrapped.push(record);
      return use(new Uint8Array(32).fill(8), record);
    }
  });
}

function emptyStore(): ManagedKeyStore {
  return Object.freeze({ findActive: vi.fn(), findById: vi.fn() });
}

describe("owner content-key bootstrap", () => {
  it("does nothing destructive when all four key domains are active", async () => {
    const statuses = allStatuses("active");
    const { client, rpc } = rpcHarness(statuses);
    const generated: CreateIntermediateKeyRequest[] = [];

    await ensureOwnerContentKeys(client, generatedCustodian(generated), emptyStore(), OWNER_ID);

    expect(generated).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(rpc.mock.calls.every(([name]) => name === "get_user_content_key_status")).toBe(true);
  });

  it("generates, registers, and activates every missing class/purpose domain", async () => {
    const statuses = allStatuses("empty");
    const { client, rpc } = rpcHarness(statuses);
    const generated: CreateIntermediateKeyRequest[] = [];
    let sequence = 0;

    await ensureOwnerContentKeys(client, generatedCustodian(generated), emptyStore(), OWNER_ID, {
      createKeyId: () => `key_generated_${(sequence += 1)}`,
      now: () => CREATED_AT
    });

    expect(generated).toHaveLength(4);
    expect(generated.map(({ keyClass, purpose }) => `${keyClass}/${purpose}`)).toEqual([
      "ai_assisted/object_wrap",
      "ai_assisted/content_mac",
      "private_manual/object_wrap",
      "private_manual/content_mac"
    ]);
    expect(rpc.mock.calls.filter(([name]) => name === "register_user_content_key")).toHaveLength(4);
    expect(rpc.mock.calls.filter(([name]) => name === "activate_user_content_key")).toHaveLength(4);
    const registration = rpc.mock.calls.find(([name]) => name === "register_user_content_key");
    expect(registration?.[1]).toMatchObject({
      p_owner_id: OWNER_ID,
      p_kms_key_id: ROOT_ARN,
      p_wrapped_intermediate_key: "\\x01020304"
    });
    expect(
      [...statuses.values()].every(({ active, pending }) => active !== null && pending === null)
    ).toBe(true);
  });

  it("registers V2 envelope records only through the provider-neutral RPC", async () => {
    const statuses = allStatuses("empty");
    const { client, rpc } = rpcHarness(statuses);
    const generated: CreateIntermediateKeyRequest[] = [];
    let sequence = 0;

    await ensureOwnerContentKeys(client, generatedV2Custodian(generated), emptyStore(), OWNER_ID, {
      createKeyId: () => `key_v2_${(sequence += 1)}`,
      now: () => CREATED_AT,
      schemaVersion: 2
    });

    expect(generated).toHaveLength(4);
    expect(rpc.mock.calls.filter(([name]) => name === "register_user_content_key_v2")).toHaveLength(
      4
    );
    expect(rpc.mock.calls.some(([name]) => name === "register_user_content_key")).toBe(false);
    const registration = rpc.mock.calls.find(([name]) => name === "register_user_content_key_v2");
    expect(registration?.[1]).toMatchObject({
      p_owner_id: OWNER_ID,
      p_root_key_id: ROOT_ID,
      p_wrap_algorithm: "AES-256-GCM",
      p_wrapped_intermediate_key: `\\x${Buffer.from(v2Envelope(), "base64url").toString("hex")}`
    });
    expect(registration?.[1]).not.toHaveProperty("p_kms_key_id");
  });

  it("proves an existing pending key under KMS before activation", async () => {
    const statuses = allStatuses("active");
    const target = statuses.get("private_manual/content_mac");
    if (target === undefined) throw new Error("missing fixture");
    target.active = null;
    target.pending = { keyId: "key_pending_private_mac", keyVersion: 1 };
    target.nextVersion = 2;
    const { client, rpc } = rpcHarness(statuses);
    const binding: KeyBinding = {
      ownerId: OWNER_ID,
      keyClass: "private_manual",
      purpose: "content_mac"
    };
    const pending = keyRecord(binding, "key_pending_private_mac", 1, "pending");
    const store: ManagedKeyStore = Object.freeze({
      findActive: vi.fn(),
      findById: vi.fn().mockResolvedValue(pending)
    });
    const generated: CreateIntermediateKeyRequest[] = [];
    const unwrapped: ManagedKeyRecordV1[] = [];

    await ensureOwnerContentKeys(client, generatedCustodian(generated, unwrapped), store, OWNER_ID);

    expect(generated).toEqual([]);
    expect(unwrapped).toEqual([pending]);
    expect(store.findById).toHaveBeenCalledWith({ ...binding, keyId: pending.keyId });
    expect(rpc).toHaveBeenCalledWith("activate_user_content_key", {
      p_owner_id: OWNER_ID,
      p_key_id: pending.keyId
    });
  });

  it("never activates a pending key that cannot be unwrapped exactly", async () => {
    const statuses = allStatuses("active");
    const target = statuses.get("ai_assisted/object_wrap");
    if (target === undefined) throw new Error("missing fixture");
    target.active = null;
    target.pending = { keyId: "key_pending_ai_wrap", keyVersion: 1 };
    target.nextVersion = 2;
    const { client, rpc } = rpcHarness(statuses);
    const binding: KeyBinding = {
      ownerId: OWNER_ID,
      keyClass: "ai_assisted",
      purpose: "object_wrap"
    };
    const store: ManagedKeyStore = Object.freeze({
      findActive: vi.fn(),
      findById: vi.fn().mockResolvedValue(keyRecord(binding, "key_pending_ai_wrap", 1, "pending"))
    });
    const custodian: IntermediateKeyCustodian = Object.freeze({
      withGeneratedIntermediateKey: vi.fn(),
      withUnwrappedIntermediateKey: vi.fn().mockRejectedValue(new Error("kms unavailable"))
    });

    await expect(ensureOwnerContentKeys(client, custodian, store, OWNER_ID)).rejects.toThrow(
      "kms unavailable"
    );
    expect(rpc.mock.calls.some(([name]) => name === "activate_user_content_key")).toBe(false);
  });

  it("fails before database access when the request scope is already aborted", async () => {
    const { client, rpc } = rpcHarness(allStatuses("empty"));
    const abort = new AbortController();
    abort.abort();

    await expect(
      ensureOwnerContentKeys(client, generatedCustodian([]), emptyStore(), OWNER_ID, {
        signal: abort.signal
      })
    ).rejects.toBeInstanceOf(ServiceRpcError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps bootstrap mutation capabilities explicit", () => {
    expect(managedKeyBootstrapRpcFunctions).toEqual([
      "activate_user_content_key",
      "get_user_content_key_status",
      "register_user_content_key",
      "register_user_content_key_v2"
    ]);
  });

  it.each(["object_wrap", "content_mac"] as const)(
    "rejects a malformed status for %s",
    async (purpose: KeyPurpose) => {
      const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
        keyClass: "ai_assisted",
        keyPurpose: purpose,
        active: null,
        pending: null,
        nextVersion: 0
      });
      await expect(
        ensureOwnerContentKeys(
          Object.freeze({ rpc }),
          generatedCustodian([]),
          emptyStore(),
          OWNER_ID
        )
      ).rejects.toBeInstanceOf(ServiceRpcError);
    }
  );
});
