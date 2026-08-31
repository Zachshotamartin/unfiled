import { describe, expect, it, vi } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  createAwsKmsEnvelopeCustodian,
  type AwsKmsTransport,
  type DecryptDataKeyRequest,
  type ReEncryptDataKeyRequest
} from "../src/index";
import {
  CREATED_AT,
  AI_ROOTS,
  OWNER_A,
  RETIRED_AI_OBJECT_ROOT,
  REWRAPPED_AT,
  ROOTS,
  managedRecord,
  rawKey
} from "./fixtures";

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
        KeyId: ROOTS.ai_assisted.object_wrap,
        Plaintext: new Uint8Array(generated),
        CiphertextBlob: new Uint8Array([1, 2, 3, 4])
      })
    ),
    decryptDataKey: vi.fn((input: DecryptDataKeyRequest) =>
      Promise.resolve({
        KeyId: input.KeyId,
        Plaintext: new Uint8Array(generated)
      })
    ),
    reEncryptDataKey: vi.fn(() =>
      Promise.resolve({
        SourceKeyId: RETIRED_AI_OBJECT_ROOT,
        KeyId: ROOTS.ai_assisted.object_wrap,
        CiphertextBlob: new Uint8Array([5, 6, 7, 8])
      })
    ),
    ...overrides
  } as never;
}

describe("AWS KMS envelope custodian", () => {
  it("generates a pending per-owner intermediate key with exact KMS context", async () => {
    const kms = transport();
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: AI_ROOTS,
      transport: kms,
      workload: "organization_worker"
    });
    let callbackBytes: Uint8Array | undefined;
    const record = await custodian.withGeneratedIntermediateKey(request(), (bytes, generated) => {
      callbackBytes = bytes;
      expect(bytes).toEqual(rawKey(7));
      return Promise.resolve(generated);
    });

    expect(record).toMatchObject({
      ownerId: OWNER_A,
      keyClass: "ai_assisted",
      purpose: "object_wrap",
      keyId: "ai.object.v1",
      keyVersion: 1,
      status: "pending",
      rootKeyArn: ROOTS.ai_assisted.object_wrap,
      wrapOperations: 0,
      wrapOperationLimit: 2 ** 24
    });
    expect(kms.generateDataKey).toHaveBeenCalledWith(
      {
        KeyId: ROOTS.ai_assisted.object_wrap,
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

  it("zeroes generated material when a consumer throws", async () => {
    const responsePlaintext = rawKey(9);
    const kms = transport({
      generateDataKey: vi.fn(() =>
        Promise.resolve({
          KeyId: ROOTS.ai_assisted.object_wrap,
          Plaintext: responsePlaintext,
          CiphertextBlob: new Uint8Array([1])
        })
      )
    });
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: ROOTS,
      transport: kms,
      workload: "interactive_api"
    });
    let callbackBytes: Uint8Array | undefined;
    await expect(
      custodian.withGeneratedIntermediateKey(request(), (bytes) => {
        callbackBytes = bytes;
        throw new Error("consumer failed");
      })
    ).rejects.toThrow("consumer failed");
    expect(responsePlaintext).toEqual(new Uint8Array(32));
    expect(callbackBytes).toEqual(new Uint8Array(32));
  });

  it("unwraps active and retired-root records using the complete authenticated context", async () => {
    let sentCiphertext: Uint8Array | undefined;
    const decryptDataKey = vi.fn((input: DecryptDataKeyRequest) => {
      sentCiphertext = new Uint8Array(input.CiphertextBlob);
      return Promise.resolve({ KeyId: input.KeyId, Plaintext: rawKey(7) });
    });
    const kms = transport({ decryptDataKey });
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: ROOTS,
      retiredRoots: { ai_assisted: { object_wrap: [RETIRED_AI_OBJECT_ROOT] } },
      transport: kms,
      workload: "interactive_api"
    });
    const record = managedRecord({ rootKeyArn: RETIRED_AI_OBJECT_ROOT });
    let callbackBytes: Uint8Array | undefined;
    await custodian.withUnwrappedIntermediateKey(record, (bytes) => {
      callbackBytes = bytes;
      expect(bytes).toEqual(rawKey(7));
      return Promise.resolve();
    });

    expect(sentCiphertext).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(kms.decryptDataKey).toHaveBeenCalledWith(
      {
        CiphertextBlob: new Uint8Array(4),
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: {
          UnfiledOwnerId: OWNER_A,
          UnfiledKeyClass: "ai_assisted",
          UnfiledKeyPurpose: "object_wrap",
          UnfiledKeyRecordId: "ai_assisted.object_wrap.v1"
        },
        KeyId: RETIRED_AI_OBJECT_ROOT
      },
      undefined
    );
    expect(callbackBytes).toEqual(new Uint8Array(32));
  });

  it("rewraps root ciphertext in KMS without exposing the intermediate key", async () => {
    let sentCiphertext: Uint8Array | undefined;
    const reEncryptDataKey = vi.fn((input: ReEncryptDataKeyRequest) => {
      sentCiphertext = new Uint8Array(input.CiphertextBlob);
      return Promise.resolve({
        SourceKeyId: RETIRED_AI_OBJECT_ROOT,
        KeyId: ROOTS.ai_assisted.object_wrap,
        CiphertextBlob: new Uint8Array([5, 6, 7, 8])
      });
    });
    const kms = transport({ reEncryptDataKey });
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: ROOTS,
      retiredRoots: { ai_assisted: { object_wrap: [RETIRED_AI_OBJECT_ROOT] } },
      transport: kms,
      workload: "interactive_api"
    });
    const previous = managedRecord({ rootKeyArn: RETIRED_AI_OBJECT_ROOT });
    const rewrapped = await custodian.rewrapIntermediateKey(previous, REWRAPPED_AT);

    expect(rewrapped).toMatchObject({
      keyId: previous.keyId,
      keyVersion: previous.keyVersion,
      rootKeyArn: ROOTS.ai_assisted.object_wrap,
      encryptedKeyMaterial: "BQYHCA",
      rotation: {
        predecessorKeyId: null,
        previousRootKeyArn: RETIRED_AI_OBJECT_ROOT,
        rootRewrapCount: 1,
        lastRootRewrappedAt: REWRAPPED_AT
      }
    });
    const reEncryptRequest: unknown = kms.reEncryptDataKey.mock.calls[0]?.[0];
    expect(sentCiphertext).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(reEncryptRequest).toEqual({
      CiphertextBlob: new Uint8Array(4),
      DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      DestinationEncryptionContext: {
        UnfiledOwnerId: OWNER_A,
        UnfiledKeyClass: "ai_assisted",
        UnfiledKeyPurpose: "object_wrap",
        UnfiledKeyRecordId: previous.keyId
      },
      DestinationKeyId: ROOTS.ai_assisted.object_wrap,
      SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      SourceEncryptionContext: {
        UnfiledOwnerId: OWNER_A,
        UnfiledKeyClass: "ai_assisted",
        UnfiledKeyPurpose: "object_wrap",
        UnfiledKeyRecordId: previous.keyId
      },
      SourceKeyId: RETIRED_AI_OBJECT_ROOT
    });
    expect(await custodian.rewrapIntermediateKey(rewrapped, REWRAPPED_AT)).toEqual(rewrapped);
    await expect(custodian.rewrapIntermediateKey(rewrapped, CREATED_AT)).rejects.toSatisfy(
      expectCode(KeyManagementErrorCode.KEY_STATE_INVALID)
    );
    expect(kms.reEncryptDataKey).toHaveBeenCalledOnce();
  });

  it("blocks the worker from private keys before contacting KMS", async () => {
    const kms = transport();
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: AI_ROOTS,
      transport: kms,
      workload: "organization_worker"
    });

    expect("rewrapIntermediateKey" in custodian).toBe(false);
    // @ts-expect-error Worker custody intentionally has no rotation-admin capability.
    expect(custodian.rewrapIntermediateKey).toBeUndefined();

    await expect(
      custodian.withGeneratedIntermediateKey(
        request({ keyClass: "private_manual", keyId: "private.object.v1" }),
        () => Promise.resolve()
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    await expect(
      custodian.withUnwrappedIntermediateKey(managedRecord({ keyClass: "private_manual" }), () =>
        Promise.resolve()
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    expect(kms.generateDataKey).not.toHaveBeenCalled();
    expect(kms.decryptDataKey).not.toHaveBeenCalled();
  });

  it("threads AbortSignal to every permitted KMS operation and fails closed if pre-aborted", async () => {
    const controller = new AbortController();
    const kms = transport();
    const worker = createAwsKmsEnvelopeCustodian({
      activeRoots: AI_ROOTS,
      transport: kms,
      workload: "organization_worker"
    });
    await worker.withGeneratedIntermediateKey(request(), () => Promise.resolve(), {
      signal: controller.signal
    });
    await worker.withUnwrappedIntermediateKey(managedRecord(), () => Promise.resolve(), {
      signal: controller.signal
    });
    expect(kms.generateDataKey.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
    expect(kms.decryptDataKey.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });

    const adminKms = transport();
    const admin = createAwsKmsEnvelopeCustodian({
      activeRoots: ROOTS,
      retiredRoots: { ai_assisted: { object_wrap: [RETIRED_AI_OBJECT_ROOT] } },
      transport: adminKms,
      workload: "interactive_api"
    });
    await admin.rewrapIntermediateKey(
      managedRecord({ rootKeyArn: RETIRED_AI_OBJECT_ROOT }),
      REWRAPPED_AT,
      { signal: controller.signal }
    );
    expect(adminKms.reEncryptDataKey.mock.calls[0]?.[1]).toEqual({
      abortSignal: controller.signal
    });

    const aborted = new AbortController();
    aborted.abort("CANARY_ABORT_REASON");
    const unusedKms = transport();
    const abortedWorker = createAwsKmsEnvelopeCustodian({
      activeRoots: AI_ROOTS,
      transport: unusedKms,
      workload: "organization_worker"
    });
    try {
      await abortedWorker.withGeneratedIntermediateKey(request(), () => Promise.resolve(), {
        signal: aborted.signal
      });
      throw new Error("expected failure");
    } catch (error: unknown) {
      expect(error).toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
      expect(String(error)).not.toContain("CANARY_ABORT_REASON");
    }
    expect(unusedKms.generateDataKey).not.toHaveBeenCalled();
  });

  it("fails closed for invalid state, untrusted roots, timestamps, and KMS response IDs", async () => {
    const kms = transport();
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: ROOTS,
      transport: kms,
      workload: "interactive_api"
    });
    await expect(
      custodian.withUnwrappedIntermediateKey(
        managedRecord({
          status: "revoked",
          revokedAt: CREATED_AT,
          activatedAt: null
        }),
        () => Promise.resolve()
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_STATE_INVALID));
    await expect(
      custodian.withUnwrappedIntermediateKey(
        managedRecord({ rootKeyArn: RETIRED_AI_OBJECT_ROOT }),
        () => Promise.resolve()
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_STATE_INVALID));
    await expect(custodian.rewrapIntermediateKey(managedRecord(), "not-a-date")).rejects.toSatisfy(
      expectCode(KeyManagementErrorCode.KEY_INVALID)
    );

    const wrongKeyPlaintext = rawKey(1);
    const wrongResponse = createAwsKmsEnvelopeCustodian({
      activeRoots: ROOTS,
      transport: transport({
        generateDataKey: vi.fn(() =>
          Promise.resolve({
            KeyId: ROOTS.private_manual.object_wrap,
            Plaintext: wrongKeyPlaintext,
            CiphertextBlob: new Uint8Array([1])
          })
        )
      }),
      workload: "interactive_api"
    });
    await expect(
      wrongResponse.withGeneratedIntermediateKey(request(), () => Promise.resolve())
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    expect(wrongKeyPlaintext).toEqual(new Uint8Array(32));

    for (const response of [
      {
        KeyId: ROOTS.ai_assisted.object_wrap,
        CiphertextBlob: new Uint8Array([1])
      },
      {
        KeyId: ROOTS.ai_assisted.object_wrap,
        Plaintext: new Uint8Array(31),
        CiphertextBlob: new Uint8Array([1])
      },
      {
        KeyId: ROOTS.ai_assisted.object_wrap,
        Plaintext: rawKey(1)
      }
    ]) {
      const malformedResponse = createAwsKmsEnvelopeCustodian({
        activeRoots: ROOTS,
        transport: transport({ generateDataKey: vi.fn(() => Promise.resolve(response)) }),
        workload: "interactive_api"
      });
      await expect(
        malformedResponse.withGeneratedIntermediateKey(request(), () => Promise.resolve())
      ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    }
  });

  it("turns provider errors into generic failures without plaintext canaries", async () => {
    const canary = "CANARY_KEY_MATERIAL_d0f4";
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: ROOTS,
      transport: transport({
        generateDataKey: vi.fn(() => Promise.reject(new Error(`provider leaked ${canary}`)))
      }),
      workload: "interactive_api"
    });
    try {
      await custodian.withGeneratedIntermediateKey(request(), () => Promise.resolve());
      throw new Error("expected failure");
    } catch (error: unknown) {
      expect(error).toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  });
});
