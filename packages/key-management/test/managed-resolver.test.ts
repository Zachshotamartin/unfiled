import { openUtf8WithResolver, sealUtf8, type EncryptionContext } from "@unfiled/content-crypto";
import { describe, expect, it, vi } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  createManagedKeyResolver,
  type IntermediateKeyCustodian,
  type KeyBinding,
  type KeySelector,
  type ManagedKeyRecordV1,
  type ManagedKeyStore
} from "../src/index";
import { OWNER_A, OWNER_B, managedRecord, rawKey } from "./fixtures";

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

function byteView(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

function fakeCustodian(): IntermediateKeyCustodian {
  return {
    withGeneratedIntermediateKey<Result>(): Promise<Result> {
      return Promise.reject(new Error("not used"));
    },
    async withUnwrappedIntermediateKey<Result>(
      recordValue: unknown,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>
    ): Promise<Result> {
      const record = recordValue as ManagedKeyRecordV1;
      const bytes = rawKey(record.purpose === "object_wrap" ? 11 : 12);
      try {
        return await use(bytes, record);
      } finally {
        bytes.fill(0);
      }
    }
  };
}

function store(records: readonly ManagedKeyRecordV1[]): ManagedKeyStore {
  return {
    findActive(binding: KeyBinding): Promise<unknown> {
      return Promise.resolve(
        records.find(
          (record) =>
            record.ownerId === binding.ownerId &&
            record.keyClass === binding.keyClass &&
            record.purpose === binding.purpose &&
            record.status === "active"
        ) ?? null
      );
    },
    findById(selector: KeySelector): Promise<unknown> {
      return Promise.resolve(
        records.find(
          (record) =>
            record.ownerId === selector.ownerId &&
            record.keyClass === selector.keyClass &&
            record.purpose === selector.purpose &&
            record.keyId === selector.keyId
        ) ?? null
      );
    }
  };
}

describe("managed owner-bound key resolver", () => {
  it("imports distinct non-extractable object-wrap and content-MAC key classes", async () => {
    const objectRecord = managedRecord();
    const macRecord = managedRecord({ purpose: "content_mac" });
    const resolver = createManagedKeyResolver({
      custodian: fakeCustodian(),
      store: store([objectRecord, macRecord]),
      workload: "interactive_api"
    });

    const object = await resolver.activeObjectWrappingKey({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });
    const mac = await resolver.activeContentMacKey({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });
    expect(object.reference.purpose).toBe("object_wrap");
    expect(object.key.key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(object.key.key.extractable).toBe(false);
    expect(mac.reference.purpose).toBe("content_mac");
    expect(mac.key.algorithm).toMatchObject({ name: "HMAC", length: 256 });
    expect(mac.key.extractable).toBe(false);
    expect(
      new Uint8Array(await crypto.subtle.sign("HMAC", mac.key, new Uint8Array([1])))
    ).toHaveLength(32);
  });

  it("zeroes its content-MAC import copy only after Web Crypto settles", async () => {
    const record = managedRecord({ purpose: "content_mac" });
    const suppliedBytes = rawKey(12);
    const importedKey = await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"]
    );
    let importedBytes: Uint8Array = new Uint8Array();
    let resolveImport: ((key: CryptoKey) => void) | undefined;
    const importKey = vi.fn((_format: KeyFormat, keyData: BufferSource) => {
      importedBytes = byteView(keyData);
      return new Promise<CryptoKey>((resolve) => {
        resolveImport = resolve;
      });
    });
    const custodian: IntermediateKeyCustodian = {
      ...fakeCustodian(),
      async withUnwrappedIntermediateKey<Result>(
        recordValue: unknown,
        use: (keyBytes: Uint8Array, parsed: ManagedKeyRecordV1) => Promise<Result>
      ): Promise<Result> {
        try {
          return await use(suppliedBytes, recordValue as ManagedKeyRecordV1);
        } finally {
          suppliedBytes.fill(0);
        }
      }
    };
    const resolver = createManagedKeyResolver({
      crypto: { subtle: { importKey } } as unknown as Crypto,
      custodian,
      store: store([record]),
      workload: "interactive_api"
    });
    const pending = resolver.activeContentMacKey({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });

    await vi.waitFor(() => expect(importKey).toHaveBeenCalledOnce());
    expect(importedBytes).toEqual(rawKey(12));
    expect(importedBytes).not.toBe(suppliedBytes);
    suppliedBytes.fill(13);
    expect(importedBytes).toEqual(rawKey(12));
    if (resolveImport === undefined) throw new Error("Expected Web Crypto import to start");
    resolveImport(importedKey);

    await expect(pending).resolves.toMatchObject({ reference: { purpose: "content_mac" } });
    expect(importedBytes).toEqual(new Uint8Array(32));
    expect(suppliedBytes).toEqual(new Uint8Array(32));
  });

  it("adapts an owner-and-class binding to content-crypto without key-ID fallback", async () => {
    const record = managedRecord();
    const resolver = createManagedKeyResolver({
      custodian: fakeCustodian(),
      store: store([record]),
      workload: "interactive_api"
    });
    const key = await resolver.activeObjectWrappingKey({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });
    const context: EncryptionContext = {
      tenantId: OWNER_A,
      resourceId: "note_01J7WXYZ1234567890ABCDEFGH",
      recordVersion: 1,
      kind: "note"
    };
    const envelope = await sealUtf8("encrypted note", context, key.key);
    const contentResolver = resolver.contentKeyResolver({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });

    await expect(openUtf8WithResolver(envelope, context, contentResolver)).resolves.toBe(
      "encrypted note"
    );
    await expect(contentResolver("missing-key")).resolves.toBeNull();
    await expect(
      resolver.resolveContentMacKey({
        ownerId: OWNER_A,
        keyClass: "ai_assisted",
        keyId: "missing-mac"
      })
    ).resolves.toBeNull();
  });

  it("resolves retired exact keys while requiring active keys for new wraps", async () => {
    const retired = managedRecord({
      status: "retired",
      retiredAt: "2026-09-01T12:00:00.000Z"
    });
    const resolver = createManagedKeyResolver({
      custodian: fakeCustodian(),
      store: store([retired]),
      workload: "interactive_api"
    });

    await expect(
      resolver.resolveObjectWrappingKey({
        ownerId: OWNER_A,
        keyClass: "ai_assisted",
        keyId: retired.keyId
      })
    ).resolves.toMatchObject({ reference: { keyId: retired.keyId } });
    await expect(
      resolver.activeObjectWrappingKey({ ownerId: OWNER_A, keyClass: "ai_assisted" })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_NOT_FOUND));
  });

  it("fails closed when a store returns a record for another owner", async () => {
    const maliciousStore: ManagedKeyStore = {
      findActive: () => Promise.resolve(managedRecord()),
      findById: () => Promise.resolve(managedRecord())
    };
    const resolver = createManagedKeyResolver({
      custodian: fakeCustodian(),
      store: maliciousStore,
      workload: "interactive_api"
    });
    await expect(
      resolver.resolveObjectWrappingKey({
        ownerId: OWNER_B,
        keyClass: "ai_assisted",
        keyId: managedRecord().keyId
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    await expect(
      resolver.activeContentMacKey({ ownerId: OWNER_B, keyClass: "ai_assisted" })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
  });

  it("refuses exhausted active wrapping keys but keeps exact decrypt resolution available", async () => {
    const exhausted = managedRecord({ wrapOperations: 5, wrapOperationLimit: 5 });
    const resolver = createManagedKeyResolver({
      custodian: fakeCustodian(),
      store: store([exhausted]),
      workload: "interactive_api"
    });
    await expect(
      resolver.activeObjectWrappingKey({ ownerId: OWNER_A, keyClass: "ai_assisted" })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_STATE_INVALID));
    await expect(
      resolver.resolveObjectWrappingKey({
        ownerId: OWNER_A,
        keyClass: "ai_assisted",
        keyId: exhausted.keyId
      })
    ).resolves.not.toBeNull();
  });

  it("blocks private worker resolution before consulting the store", async () => {
    const findActive = vi.fn(() => Promise.resolve(null));
    const findById = vi.fn(() => Promise.resolve(null));
    const resolver = createManagedKeyResolver({
      custodian: fakeCustodian(),
      store: { findActive, findById },
      workload: "index_worker"
    });
    await expect(
      resolver.activeContentMacKey({ ownerId: OWNER_A, keyClass: "ai_assisted" })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    await expect(
      resolver.activeObjectWrappingKey({ ownerId: OWNER_A, keyClass: "private_manual" })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    try {
      resolver.contentKeyResolver({ ownerId: OWNER_A, keyClass: "private_manual" });
      throw new Error("expected access denial");
    } catch (error: unknown) {
      expect(error).toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    }
    await expect(
      resolver.resolveContentMacKey({
        ownerId: OWNER_A,
        keyClass: "ai_assisted",
        keyId: "ai.mac.v1"
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    await expect(
      resolver.resolveContentMacKey({
        ownerId: OWNER_A,
        keyClass: "private_manual",
        keyId: "private.mac.v1"
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    expect(findActive).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it("fails closed without a complete Web Crypto runtime", () => {
    expect(() =>
      createManagedKeyResolver({
        crypto: {} as Crypto,
        custodian: fakeCustodian(),
        store: store([]),
        workload: "interactive_api"
      })
    ).toThrow(KeyManagementError);
  });

  it("rejects malformed content-MAC material from a custodian", async () => {
    const record = managedRecord({ purpose: "content_mac" });
    const malformedCustodian: IntermediateKeyCustodian = {
      ...fakeCustodian(),
      withUnwrappedIntermediateKey<Result>(
        recordValue: unknown,
        use: (keyBytes: Uint8Array, parsed: ManagedKeyRecordV1) => Promise<Result>
      ): Promise<Result> {
        return use(new Uint8Array(31), recordValue as ManagedKeyRecordV1);
      }
    };
    const resolver = createManagedKeyResolver({
      custodian: malformedCustodian,
      store: store([record]),
      workload: "interactive_api"
    });
    await expect(
      resolver.activeContentMacKey({ ownerId: OWNER_A, keyClass: "ai_assisted" })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
  });
});
