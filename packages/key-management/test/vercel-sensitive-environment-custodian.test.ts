import { describe, expect, it, vi } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  type AwsKmsTransport,
  type DecryptDataKeyRequest,
  type ReEncryptDataKeyRequest
} from "../src/index";
import {
  CREATED_AT,
  OWNER_A,
  REWRAPPED_AT,
  VERCEL_RETIRED_AI_OBJECT_ROOT,
  VERCEL_ROOTS,
  environmentEnvelope,
  managedRecordV2,
  rawKey
} from "./fixtures";

const INDEX_ROOTS = Object.freeze({
  ai_assisted: Object.freeze({ object_wrap: VERCEL_ROOTS.ai_assisted.object_wrap })
});

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

function request(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ownerId: OWNER_A,
    keyClass: "ai_assisted" as const,
    purpose: "object_wrap" as const,
    keyId: "ai.object.v1",
    keyVersion: 1,
    createdAt: CREATED_AT,
    predecessorKeyId: null,
    ...overrides
  };
}

function envelopeBytes(seed = 1): Uint8Array {
  return new Uint8Array(Buffer.from(environmentEnvelope(seed), "base64url"));
}

function transport(overrides: Partial<AwsKmsTransport> = {}): AwsKmsTransport &
  Readonly<{
    decryptDataKey: ReturnType<typeof vi.fn>;
    generateDataKey: ReturnType<typeof vi.fn>;
    reEncryptDataKey: ReturnType<typeof vi.fn>;
  }> {
  const generated = rawKey(7);
  return {
    destroy: vi.fn(),
    generateDataKey: vi.fn(() =>
      Promise.resolve({
        KeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
        Plaintext: new Uint8Array(generated),
        CiphertextBlob: envelopeBytes(1)
      })
    ),
    decryptDataKey: vi.fn((input: DecryptDataKeyRequest) =>
      Promise.resolve({ KeyId: input.KeyId, Plaintext: new Uint8Array(generated) })
    ),
    reEncryptDataKey: vi.fn(() =>
      Promise.resolve({
        SourceKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT,
        KeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
        CiphertextBlob: envelopeBytes(2)
      })
    ),
    ...overrides
  } as never;
}

describe("Vercel sensitive-environment envelope custodian", () => {
  it("generates an honest pending V2 record with exact authenticated context", async () => {
    const envelopeTransport = transport();
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      deploymentEnvironment: "production",
      transport: envelopeTransport,
      workload: "index_worker"
    });
    let callbackBytes: Uint8Array | undefined;
    const record = await custodian.withGeneratedIntermediateKey(request(), (bytes, generated) => {
      callbackBytes = bytes;
      expect(bytes).toEqual(rawKey(7));
      return Promise.resolve(generated);
    });

    expect(record).toMatchObject({
      schemaVersion: 2,
      custodyProvider: "vercel_sensitive_environment_v1",
      ownerId: OWNER_A,
      keyClass: "ai_assisted",
      purpose: "object_wrap",
      keyId: "ai.object.v1",
      keyVersion: 1,
      status: "pending",
      rootKeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
      wrapAlgorithm: "AES-256-GCM",
      wrapOperations: 0,
      wrapOperationLimit: 2 ** 24,
      rotation: {
        predecessorKeyId: null,
        previousRootKeyId: null,
        rootRewrapCount: 0,
        lastRootRewrappedAt: null
      }
    });
    expect(envelopeTransport.generateDataKey).toHaveBeenCalledWith(
      {
        KeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
        KeySpec: "AES_256",
        EncryptionContext: {
          UnfiledOwnerId: OWNER_A,
          UnfiledKeyClass: "ai_assisted",
          UnfiledKeyPurpose: "object_wrap",
          UnfiledKeyRecordId: "ai.object.v1"
        }
      },
      undefined
    );
    expect(callbackBytes).toEqual(new Uint8Array(32));
  });

  it("unwraps active and retired roots and zeroes consumer bytes", async () => {
    let sentCiphertext: Uint8Array | undefined;
    const envelopeTransport = transport({
      decryptDataKey: vi.fn((input: DecryptDataKeyRequest) => {
        sentCiphertext = new Uint8Array(input.CiphertextBlob);
        return Promise.resolve({ KeyId: input.KeyId, Plaintext: rawKey(7) });
      })
    });
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: VERCEL_ROOTS,
      deploymentEnvironment: "production",
      retiredRoots: { ai_assisted: { object_wrap: [VERCEL_RETIRED_AI_OBJECT_ROOT] } },
      transport: envelopeTransport,
      workload: "interactive_api"
    });
    const record = managedRecordV2({ rootKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT });
    let callbackBytes: Uint8Array | undefined;
    await custodian.withUnwrappedIntermediateKey(record, (bytes, parsed) => {
      callbackBytes = bytes;
      expect(parsed).toEqual(record);
      expect(bytes).toEqual(rawKey(7));
      return Promise.resolve();
    });
    expect(sentCiphertext).toEqual(envelopeBytes(1));
    expect(envelopeTransport.decryptDataKey).toHaveBeenCalledWith(
      {
        CiphertextBlob: new Uint8Array(65),
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: {
          UnfiledOwnerId: OWNER_A,
          UnfiledKeyClass: "ai_assisted",
          UnfiledKeyPurpose: "object_wrap",
          UnfiledKeyRecordId: record.keyId
        },
        KeyId: VERCEL_RETIRED_AI_OBJECT_ROOT
      },
      undefined
    );
    expect(callbackBytes).toEqual(new Uint8Array(32));
  });

  it("gives search only the decrypt capability and preserves worker generation", () => {
    const envelopeTransport = transport();
    const search = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      deploymentEnvironment: "production",
      transport: envelopeTransport,
      workload: "search_worker"
    });
    expect(Object.isFrozen(search)).toBe(true);
    expect("withGeneratedIntermediateKey" in search).toBe(false);
    expect("rewrapIntermediateKey" in search).toBe(false);

    const organizer = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: { ai_assisted: VERCEL_ROOTS.ai_assisted },
      deploymentEnvironment: "production",
      transport: envelopeTransport,
      workload: "organization_worker"
    });
    expect("withGeneratedIntermediateKey" in organizer).toBe(true);
    expect("rewrapIntermediateKey" in organizer).toBe(false);
  });

  it("rewraps from a retired root and records provider-neutral audit metadata", async () => {
    let sentCiphertext: Uint8Array | undefined;
    const envelopeTransport = transport({
      reEncryptDataKey: vi.fn((input: ReEncryptDataKeyRequest) => {
        sentCiphertext = new Uint8Array(input.CiphertextBlob);
        return Promise.resolve({
          SourceKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT,
          KeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
          CiphertextBlob: envelopeBytes(2)
        });
      })
    });
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: VERCEL_ROOTS,
      deploymentEnvironment: "production",
      retiredRoots: { ai_assisted: { object_wrap: [VERCEL_RETIRED_AI_OBJECT_ROOT] } },
      transport: envelopeTransport,
      workload: "interactive_api"
    });
    const previous = managedRecordV2({ rootKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT });
    const rewrapped = await custodian.rewrapIntermediateKey(previous, REWRAPPED_AT);

    expect(rewrapped).toMatchObject({
      schemaVersion: 2,
      rootKeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
      encryptedKeyMaterial: environmentEnvelope(2),
      rotation: {
        previousRootKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT,
        rootRewrapCount: 1,
        lastRootRewrappedAt: REWRAPPED_AT
      }
    });
    expect(sentCiphertext).toEqual(envelopeBytes(1));
    expect(envelopeTransport.reEncryptDataKey).toHaveBeenCalledWith(
      expect.objectContaining({
        DestinationKeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
        SourceKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT
      }),
      undefined
    );
    expect(await custodian.rewrapIntermediateKey(rewrapped, REWRAPPED_AT)).toEqual(rewrapped);
    await expect(custodian.rewrapIntermediateKey(rewrapped, CREATED_AT)).rejects.toSatisfy(
      expectCode(KeyManagementErrorCode.KEY_STATE_INVALID)
    );
    expect(envelopeTransport.reEncryptDataKey).toHaveBeenCalledOnce();
  });

  it("rejects V1 records, untrusted roots, revoked state, cross-environment config, and denied classes", async () => {
    const envelopeTransport = transport();
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: VERCEL_ROOTS,
      deploymentEnvironment: "production",
      transport: envelopeTransport,
      workload: "interactive_api"
    });
    await expect(
      custodian.withUnwrappedIntermediateKey({ ...managedRecordV2(), schemaVersion: 1 }, () =>
        Promise.resolve()
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    await expect(
      custodian.withUnwrappedIntermediateKey(
        managedRecordV2({ rootKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT }),
        () => Promise.resolve()
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_STATE_INVALID));
    await expect(
      custodian.withUnwrappedIntermediateKey(
        managedRecordV2({ status: "revoked", revokedAt: CREATED_AT, activatedAt: null }),
        () => Promise.resolve()
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_STATE_INVALID));
    expect(() =>
      createVercelSensitiveEnvironmentEnvelopeCustodian({
        activeRoots: VERCEL_ROOTS,
        deploymentEnvironment: "preview",
        transport: envelopeTransport,
        workload: "interactive_api"
      })
    ).toThrow(KeyManagementError);

    const index = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      deploymentEnvironment: "production",
      transport: envelopeTransport,
      workload: "index_worker"
    });
    await expect(
      index.withGeneratedIntermediateKey(
        request({ keyClass: "private_manual", keyId: "private.object.v1" }),
        () => Promise.resolve()
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    expect(envelopeTransport.decryptDataKey).not.toHaveBeenCalled();
  });

  it("threads AbortSignal and maps provider failures without leaking a canary", async () => {
    const canary = "CANARY_ENV_ROOT_MATERIAL";
    const controller = new AbortController();
    const envelopeTransport = transport();
    const index = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      deploymentEnvironment: "production",
      transport: envelopeTransport,
      workload: "index_worker"
    });
    await index.withGeneratedIntermediateKey(request(), () => Promise.resolve(), {
      signal: controller.signal
    });
    await index.withUnwrappedIntermediateKey(managedRecordV2(), () => Promise.resolve(), {
      signal: controller.signal
    });
    expect(envelopeTransport.generateDataKey.mock.calls[0]?.[1]).toEqual({
      abortSignal: controller.signal
    });
    expect(envelopeTransport.decryptDataKey.mock.calls[0]?.[1]).toEqual({
      abortSignal: controller.signal
    });

    const failing = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      deploymentEnvironment: "production",
      transport: transport({
        decryptDataKey: vi.fn(() => Promise.reject(new Error(canary)))
      }),
      workload: "index_worker"
    });
    let failure: unknown;
    try {
      await failing.withUnwrappedIntermediateKey(managedRecordV2(), () => Promise.resolve());
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    expect(String(failure)).not.toContain(canary);

    const aborted = new AbortController();
    aborted.abort(canary);
    await expect(
      index.withGeneratedIntermediateKey(request(), () => Promise.resolve(), {
        signal: aborted.signal
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
  });

  it("fails closed on malformed transport responses and zeroes returned plaintext", async () => {
    const wrongRootPlaintext = rawKey(9);
    const wrongRoot = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      deploymentEnvironment: "production",
      transport: transport({
        generateDataKey: vi.fn(() =>
          Promise.resolve({
            KeyId: VERCEL_ROOTS.ai_assisted.content_mac,
            Plaintext: wrongRootPlaintext,
            CiphertextBlob: envelopeBytes()
          })
        )
      }),
      workload: "index_worker"
    });
    await expect(
      wrongRoot.withGeneratedIntermediateKey(request(), () => Promise.resolve())
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    expect(wrongRootPlaintext).toEqual(new Uint8Array(32));

    for (const response of [
      { KeyId: VERCEL_ROOTS.ai_assisted.object_wrap, CiphertextBlob: envelopeBytes() },
      {
        KeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
        Plaintext: new Uint8Array(31),
        CiphertextBlob: envelopeBytes()
      },
      {
        KeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
        Plaintext: rawKey(1),
        CiphertextBlob: new Uint8Array(64)
      }
    ]) {
      const malformed = createVercelSensitiveEnvironmentEnvelopeCustodian({
        activeRoots: INDEX_ROOTS,
        deploymentEnvironment: "production",
        transport: transport({ generateDataKey: vi.fn(() => Promise.resolve(response)) }),
        workload: "index_worker"
      });
      await expect(
        malformed.withGeneratedIntermediateKey(request(), () => Promise.resolve())
      ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    }
  });
});
