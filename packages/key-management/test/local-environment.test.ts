import { openUtf8WithResolver, sealUtf8, type EncryptionContext } from "@unfiled/content-crypto";
import { describe, expect, it, vi } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  createLocalEnvironmentKeyResolver,
  localEnvironmentKeyConfiguration
} from "../src/index";
import { OWNER_A, OWNER_B, base64UrlKey } from "./fixtures";

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

function byteView(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

function entry(
  seed: number,
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return {
    ownerId: OWNER_A,
    keyClass: "ai_assisted",
    purpose: "object_wrap",
    keyId: `local.key.${seed}`,
    keyVersion: seed,
    status: "active",
    keyMaterial: base64UrlKey(seed),
    ...overrides
  };
}

function environment(keys: readonly Readonly<Record<string, unknown>>[]) {
  return {
    NODE_ENV: "test",
    UNFILED_KEY_CUSTODIAN: "local",
    UNFILED_LOCAL_KEY_RING_V1: JSON.stringify({ version: 1, keys })
  };
}

describe("local-only environment key resolver", () => {
  it("imports exact active and retired keys without retaining extractable material", async () => {
    const resolver = await createLocalEnvironmentKeyResolver({
      environment: environment([
        entry(1),
        entry(2, { purpose: "content_mac", keyId: "local.mac.1", keyVersion: 1 }),
        entry(3, { keyId: "local.key.retired", keyVersion: 0x2, status: "retired" })
      ]),
      workload: "interactive_api"
    });
    const active = await resolver.activeObjectWrappingKey({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });
    const retired = await resolver.resolveObjectWrappingKey({
      ownerId: OWNER_A,
      keyClass: "ai_assisted",
      keyId: "local.key.retired"
    });
    const mac = await resolver.activeContentMacKey({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });

    expect(active.key.key.extractable).toBe(false);
    expect(retired?.reference.keyVersion).toBe(2);
    expect(mac.key.extractable).toBe(false);
    expect(mac.key.algorithm.name).toBe("HMAC");
    await expect(
      resolver.resolveObjectWrappingKey({
        ownerId: OWNER_A,
        keyClass: "ai_assisted",
        keyId: "missing"
      })
    ).resolves.toBeNull();
  });

  it("provides an owner-bound content-crypto resolver", async () => {
    const resolver = await createLocalEnvironmentKeyResolver({
      environment: environment([entry(4)]),
      workload: "interactive_api"
    });
    const active = await resolver.activeObjectWrappingKey({
      ownerId: OWNER_A,
      keyClass: "ai_assisted"
    });
    const context: EncryptionContext = {
      tenantId: OWNER_A,
      resourceId: "note_local",
      recordVersion: 1,
      kind: "note"
    };
    const envelope = await sealUtf8("local encrypted note", context, active.key);
    await expect(
      openUtf8WithResolver(
        envelope,
        context,
        resolver.contentKeyResolver({ ownerId: OWNER_A, keyClass: "ai_assisted" })
      )
    ).resolves.toBe("local encrypted note");
    await expect(
      resolver.contentKeyResolver({ ownerId: OWNER_A, keyClass: "ai_assisted" })("missing")
    ).resolves.toBeNull();
    await expect(
      resolver.resolveObjectWrappingKey({
        ownerId: OWNER_B,
        keyClass: "ai_assisted",
        keyId: active.reference.keyId
      })
    ).resolves.toBeNull();
  });

  it("zeroes the local content-MAC import copy after Web Crypto rejects", async () => {
    let importedBytes: Uint8Array = new Uint8Array();
    let rejectImport: ((reason: Error) => void) | undefined;
    const importKey = vi.fn((_format: KeyFormat, keyData: BufferSource) => {
      importedBytes = byteView(keyData);
      return new Promise<CryptoKey>((_resolve, reject) => {
        rejectImport = reject;
      });
    });
    const pending = createLocalEnvironmentKeyResolver({
      crypto: { subtle: { importKey } } as unknown as Crypto,
      environment: environment([entry(7, { purpose: "content_mac", keyId: "local.mac.rejected" })]),
      workload: "interactive_api"
    });

    await vi.waitFor(() => expect(importKey).toHaveBeenCalledOnce());
    expect(importedBytes).toEqual(new Uint8Array(32).fill(7));
    if (rejectImport === undefined) throw new Error("Expected Web Crypto import to start");
    rejectImport(new Error("synthetic import failure"));

    await expect(pending).rejects.toSatisfy(
      expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID)
    );
    expect(importedBytes).toEqual(new Uint8Array(32));
  });

  it("cannot start in production, Vercel, preview, or without explicit local mode", async () => {
    const keys = [entry(1)];
    for (const unsafe of [
      { ...environment(keys), NODE_ENV: "production" },
      { ...environment(keys), VERCEL: "1" },
      { ...environment(keys), VERCEL_ENV: "preview" },
      { ...environment(keys), UNFILED_KEY_CUSTODIAN: "kms" },
      { ...environment(keys), NODE_ENV: "staging" }
    ]) {
      await expect(
        createLocalEnvironmentKeyResolver({
          environment: unsafe,
          workload: "interactive_api"
        })
      ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
    }
  });

  it("rejects malformed, noncanonical, reused, or ambiguous environment keys", async () => {
    const malformedRings = [
      undefined,
      "not-json",
      JSON.stringify({ version: 2, keys: [entry(1)] }),
      JSON.stringify({ version: 1, keys: [] }),
      JSON.stringify({ version: 1, keys: [entry(1, { extra: true })] }),
      JSON.stringify({ version: 1, keys: [entry(1, { keyMaterial: "not_base64url!" })] }),
      JSON.stringify({
        version: 1,
        keys: [entry(1), entry(1, { purpose: "content_mac", keyId: "mac", keyVersion: 2 })]
      }),
      JSON.stringify({
        version: 1,
        keys: [entry(1), entry(2, { keyId: "second-active", keyVersion: 2 })]
      })
    ];

    for (const serialized of malformedRings) {
      await expect(
        createLocalEnvironmentKeyResolver({
          environment: {
            NODE_ENV: "test",
            UNFILED_KEY_CUSTODIAN: "local",
            UNFILED_LOCAL_KEY_RING_V1: serialized
          },
          workload: "interactive_api"
        })
      ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
    }
  });

  it("refuses to load content-MAC or private material into the index worker", async () => {
    for (const forbidden of [
      entry(9, { purpose: "content_mac", keyId: "ai.mac.local.v1" }),
      entry(9, { keyClass: "private_manual", keyId: "private.local.v1" })
    ]) {
      await expect(
        createLocalEnvironmentKeyResolver({
          environment: environment([forbidden]),
          workload: "index_worker"
        })
      ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
    }
  });

  it("exports only configuration variable names, never values", () => {
    expect(localEnvironmentKeyConfiguration).toEqual({
      keyRingVariable: "UNFILED_LOCAL_KEY_RING_V1",
      modeVariable: "UNFILED_KEY_CUSTODIAN"
    });
  });
});
