import { describe, expect, it, vi } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  assertAiAssistedKmsReadiness,
  assertIndexWorkerKmsReadiness,
  type AwsKmsTransport,
  type DecryptDataKeyRequest,
  type GenerateDataKeyRequest,
  type KmsTransportOperationOptions
} from "../src/index";
import { AI_ROOTS, INDEX_ROOTS, ROOTS, rawKey } from "./fixtures";

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

function seedForRoot(rootKeyArn: string): number {
  return rootKeyArn === ROOTS.ai_assisted.object_wrap ? 17 : 29;
}

describe("AI-assisted KMS readiness", () => {
  it("proves only the index worker object-wrap root and rejects a content-MAC-bearing set", async () => {
    const generateDataKey = vi.fn((input: GenerateDataKeyRequest) =>
      Promise.resolve({
        CiphertextBlob: new Uint8Array([17]),
        KeyId: input.KeyId,
        Plaintext: rawKey(17)
      })
    );
    const decryptDataKey = vi.fn((input: DecryptDataKeyRequest) =>
      Promise.resolve({ KeyId: input.KeyId, Plaintext: rawKey(17) })
    );

    await expect(
      assertIndexWorkerKmsReadiness({
        activeRoots: INDEX_ROOTS,
        transport: { decryptDataKey, generateDataKey }
      })
    ).resolves.toBeUndefined();

    expect(generateDataKey).toHaveBeenCalledOnce();
    expect(decryptDataKey).toHaveBeenCalledOnce();
    expect(generateDataKey.mock.calls[0]?.[0]).toMatchObject({
      EncryptionContext: {
        UnfiledKeyClass: "ai_assisted",
        UnfiledKeyPurpose: "object_wrap"
      },
      KeyId: ROOTS.ai_assisted.object_wrap
    });
    await expect(
      assertIndexWorkerKmsReadiness({
        activeRoots: AI_ROOTS,
        transport: { decryptDataKey, generateDataKey }
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
    expect(generateDataKey).toHaveBeenCalledOnce();
  });

  it("proves GenerateDataKey and Decrypt on both AI roots with exact contexts and cancellation", async () => {
    const returnedPlaintexts: Uint8Array[] = [];
    const returnedCiphertexts: Uint8Array[] = [];
    const decryptedCiphertexts: Uint8Array[] = [];
    const generateDataKey = vi.fn(
      (input: GenerateDataKeyRequest, _options?: KmsTransportOperationOptions) => {
        void _options;
        const seed = seedForRoot(input.KeyId);
        const plaintext = rawKey(seed);
        const ciphertext = new Uint8Array([seed, 99]);
        returnedPlaintexts.push(plaintext);
        returnedCiphertexts.push(ciphertext);
        return Promise.resolve({
          KeyId: input.KeyId,
          Plaintext: plaintext,
          CiphertextBlob: ciphertext
        });
      }
    );
    const decryptDataKey = vi.fn(
      (input: DecryptDataKeyRequest, _options?: KmsTransportOperationOptions) => {
        void _options;
        decryptedCiphertexts.push(new Uint8Array(input.CiphertextBlob));
        const plaintext = rawKey(input.CiphertextBlob[0] ?? 0);
        returnedPlaintexts.push(plaintext);
        return Promise.resolve({ KeyId: input.KeyId, Plaintext: plaintext });
      }
    );
    const controller = new AbortController();

    await expect(
      assertAiAssistedKmsReadiness({
        activeRoots: AI_ROOTS,
        signal: controller.signal,
        transport: { decryptDataKey, generateDataKey }
      })
    ).resolves.toBeUndefined();

    expect(generateDataKey).toHaveBeenCalledTimes(2);
    expect(decryptDataKey).toHaveBeenCalledTimes(2);
    expect(generateDataKey.mock.calls.map((call) => call[1])).toEqual([
      { abortSignal: controller.signal },
      { abortSignal: controller.signal }
    ]);
    expect(decryptDataKey.mock.calls.map((call) => call[1])).toEqual([
      { abortSignal: controller.signal },
      { abortSignal: controller.signal }
    ]);
    expect(generateDataKey.mock.calls.map((call) => call[0])).toEqual([
      {
        EncryptionContext: {
          UnfiledOwnerId: "00000000-0000-4000-8000-000000000001",
          UnfiledKeyClass: "ai_assisted",
          UnfiledKeyPurpose: "object_wrap",
          UnfiledKeyRecordId: "readiness.ai.object-wrap.v1"
        },
        KeyId: ROOTS.ai_assisted.object_wrap,
        KeySpec: "AES_256"
      },
      {
        EncryptionContext: {
          UnfiledOwnerId: "00000000-0000-4000-8000-000000000001",
          UnfiledKeyClass: "ai_assisted",
          UnfiledKeyPurpose: "content_mac",
          UnfiledKeyRecordId: "readiness.ai.content-mac.v1"
        },
        KeyId: ROOTS.ai_assisted.content_mac,
        KeySpec: "AES_256"
      }
    ]);
    expect(decryptedCiphertexts).toEqual([new Uint8Array([17, 99]), new Uint8Array([29, 99])]);
    for (const bytes of [...returnedPlaintexts, ...returnedCiphertexts]) {
      expect(bytes.every((value) => value === 0)).toBe(true);
    }
  });

  it("fails closed and zeroes plaintext when either root does not round-trip", async () => {
    const returnedPlaintexts: Uint8Array[] = [];
    const generateDataKey = vi.fn((input: GenerateDataKeyRequest) => {
      const seed = seedForRoot(input.KeyId);
      const plaintext = rawKey(seed);
      returnedPlaintexts.push(plaintext);
      return Promise.resolve({
        KeyId: input.KeyId,
        Plaintext: plaintext,
        CiphertextBlob: new Uint8Array([seed])
      });
    });
    const decryptDataKey = vi.fn((input: DecryptDataKeyRequest) => {
      const plaintext = rawKey(
        input.KeyId === ROOTS.ai_assisted.content_mac ? 30 : (input.CiphertextBlob[0] ?? 0)
      );
      returnedPlaintexts.push(plaintext);
      return Promise.resolve({ KeyId: input.KeyId, Plaintext: plaintext });
    });

    await expect(
      assertAiAssistedKmsReadiness({
        activeRoots: AI_ROOTS,
        transport: { decryptDataKey, generateDataKey }
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    expect(generateDataKey).toHaveBeenCalledTimes(2);
    expect(decryptDataKey).toHaveBeenCalledTimes(2);
    for (const plaintext of returnedPlaintexts) {
      expect(plaintext).toEqual(new Uint8Array(32));
    }
  });

  it("rejects malformed KMS responses and erases any returned key bytes", async () => {
    for (const generatedResponse of [
      {
        KeyId: ROOTS.private_manual.object_wrap,
        Plaintext: rawKey(1),
        CiphertextBlob: new Uint8Array([1])
      },
      {
        KeyId: ROOTS.ai_assisted.object_wrap,
        Plaintext: new Uint8Array(31),
        CiphertextBlob: new Uint8Array([1])
      },
      {
        KeyId: ROOTS.ai_assisted.object_wrap,
        Plaintext: rawKey(1),
        CiphertextBlob: new Uint8Array()
      }
    ]) {
      await expect(
        assertAiAssistedKmsReadiness({
          activeRoots: AI_ROOTS,
          transport: {
            decryptDataKey: vi.fn(() => Promise.reject(new Error("not reached"))),
            generateDataKey: vi.fn(() => Promise.resolve(generatedResponse))
          }
        })
      ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
      expect(generatedResponse.Plaintext).toEqual(
        new Uint8Array(generatedResponse.Plaintext.length)
      );
    }
  });

  it("maps provider failures and pre-aborted probes to generic unavailable errors", async () => {
    const canary = "CANARY_PROVIDER_DETAIL_7a02";
    const unavailable: Pick<AwsKmsTransport, "decryptDataKey" | "generateDataKey"> = {
      decryptDataKey: vi.fn(() => Promise.reject(new Error("not reached"))),
      generateDataKey: vi.fn(() => Promise.reject(new Error(canary)))
    };
    try {
      await assertAiAssistedKmsReadiness({ activeRoots: AI_ROOTS, transport: unavailable });
      throw new Error("expected failure");
    } catch (error: unknown) {
      expect(error).toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }

    const controller = new AbortController();
    controller.abort("CANARY_ABORT_REASON");
    const generateDataKey = vi.fn(() => Promise.reject(new Error("not reached")));
    await expect(
      assertAiAssistedKmsReadiness({
        activeRoots: AI_ROOTS,
        signal: controller.signal,
        transport: {
          decryptDataKey: vi.fn(() => Promise.reject(new Error("not reached"))),
          generateDataKey
        }
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    expect(generateDataKey).not.toHaveBeenCalled();
  });
});
