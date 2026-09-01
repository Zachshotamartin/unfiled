import { describe, expect, it, vi } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  createAwsKmsEnvelopeCustodian,
  runKeyCustodyProbe,
  type AwsKmsTransport,
  type CreateIntermediateKeyRequest,
  type DecryptDataKeyRequest,
  type GenerateDataKeyRequest,
  type IntermediateKeyCustodian,
  type ManagedKeyRecordV1
} from "../src/index";
import { CREATED_AT, INDEX_ROOTS, OWNER_A, OWNER_B, ROOTS, rawKey } from "./fixtures";

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

function aiRequest() {
  return {
    ownerId: OWNER_A,
    keyClass: "ai_assisted" as const,
    purpose: "object_wrap" as const,
    keyId: "probe.ai.object.v1",
    keyVersion: 1,
    createdAt: CREATED_AT,
    predecessorKeyId: null
  };
}

function contextAwareTransport(): AwsKmsTransport {
  let expectedContext: Readonly<Record<string, string>> | undefined;
  const material = rawKey(23);
  return {
    destroy: vi.fn(),
    generateDataKey: vi.fn((input: GenerateDataKeyRequest) => {
      expectedContext = input.EncryptionContext;
      return Promise.resolve({
        KeyId: input.KeyId,
        Plaintext: new Uint8Array(material),
        CiphertextBlob: new Uint8Array([1, 9, 9, 7])
      });
    }),
    decryptDataKey: vi.fn((input: DecryptDataKeyRequest) => {
      if (JSON.stringify(input.EncryptionContext) !== JSON.stringify(expectedContext)) {
        return Promise.reject(
          Object.assign(new Error("context mismatch"), { name: "InvalidCiphertextException" })
        );
      }
      return Promise.resolve({ KeyId: input.KeyId, Plaintext: new Uint8Array(material) });
    }),
    reEncryptDataKey: vi.fn(() => Promise.reject(new Error("not used")))
  };
}

describe("key custody role-separation probe", () => {
  it("proves AI round-trip, software private denial, wrong-context rejection, and safe events", async () => {
    const events: unknown[] = [];
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      transport: contextAwareTransport(),
      workload: "index_worker"
    });
    const report = await runKeyCustodyProbe({
      aiKeyRequest: aiRequest(),
      custodian,
      emit: (event) => events.push(event),
      wrongOwnerId: OWNER_B
    });

    expect(report).toEqual({
      aiContentMacDenialEvidence: "application_guard",
      passed: true,
      privateDenialEvidence: "application_guard",
      checks: [
        { check: "ai_generate_decrypt", status: "passed" },
        { check: "ai_content_mac_application_guard_denied", status: "passed" },
        { check: "private_object_wrap_application_guard_denied", status: "passed" },
        { check: "private_content_mac_application_guard_denied", status: "passed" },
        { check: "wrong_context_denied", status: "passed" },
        { check: "report_events_content_free", status: "passed" }
      ]
    });
    expect(events).toEqual(report.checks);
    expect(JSON.stringify(events)).not.toContain(Buffer.from(rawKey(23)).toString("base64url"));
    expect(Object.keys(events[0] as object).sort()).toEqual(["check", "status"]);
  });

  it("can probe the real worker IAM boundary through an injected raw KMS transport", async () => {
    const privateGenerate = vi.fn(() =>
      Promise.reject(Object.assign(new Error("denied by IAM"), { name: "AccessDeniedException" }))
    );
    const privateDecrypt = vi.fn(() =>
      Promise.reject(Object.assign(new Error("denied by IAM"), { name: "AccessDeniedException" }))
    );
    const privateTransport: AwsKmsTransport = {
      destroy: vi.fn(),
      decryptDataKey: privateDecrypt,
      generateDataKey: privateGenerate,
      reEncryptDataKey: vi.fn(() => Promise.reject(new Error("not used")))
    };
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      transport: contextAwareTransport(),
      workload: "index_worker"
    });

    const report = await runKeyCustodyProbe({
      aiKeyRequest: aiRequest(),
      custodian,
      directPrivateKmsProbe: {
        aiContentMacRootArn: ROOTS.ai_assisted.content_mac,
        rootKeyArns: ROOTS.private_manual,
        transport: privateTransport
      },
      wrongOwnerId: OWNER_B
    });
    expect(report).toMatchObject({ passed: true, privateDenialEvidence: "direct_kms" });
    expect(report).toMatchObject({ aiContentMacDenialEvidence: "direct_kms" });
    expect(report.checks).toContainEqual({
      check: "ai_content_mac_kms_generate_decrypt_denied",
      status: "passed"
    });
    expect(report.checks).toContainEqual({
      check: "private_object_wrap_kms_generate_decrypt_denied",
      status: "passed"
    });
    expect(report.checks).toContainEqual({
      check: "private_content_mac_kms_generate_decrypt_denied",
      status: "passed"
    });
    expect(privateGenerate).toHaveBeenCalledTimes(3);
    expect(privateDecrypt).toHaveBeenCalledTimes(3);
    expect(privateGenerate).toHaveBeenNthCalledWith(1, {
      EncryptionContext: {
        UnfiledOwnerId: OWNER_A,
        UnfiledKeyClass: "ai_assisted",
        UnfiledKeyPurpose: "content_mac",
        UnfiledKeyRecordId: "probe.ai.content-mac.v1"
      },
      KeyId: ROOTS.ai_assisted.content_mac,
      KeySpec: "AES_256"
    });
    expect(privateGenerate).toHaveBeenNthCalledWith(2, {
      EncryptionContext: {
        UnfiledOwnerId: OWNER_A,
        UnfiledKeyClass: "private_manual",
        UnfiledKeyPurpose: "object_wrap",
        UnfiledKeyRecordId: "probe.private.object-wrap.v1"
      },
      KeyId: ROOTS.private_manual.object_wrap,
      KeySpec: "AES_256"
    });
    expect(privateGenerate).toHaveBeenNthCalledWith(3, {
      EncryptionContext: {
        UnfiledOwnerId: OWNER_A,
        UnfiledKeyClass: "private_manual",
        UnfiledKeyPurpose: "content_mac",
        UnfiledKeyRecordId: "probe.private.content-mac.v1"
      },
      KeyId: ROOTS.private_manual.content_mac,
      KeySpec: "AES_256"
    });
  });

  it("fails if either private purpose opens and zeroes returned KMS plaintext", async () => {
    const leaked = rawKey(31);
    const privateTransport: AwsKmsTransport = {
      destroy: vi.fn(),
      decryptDataKey: vi.fn(() =>
        Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" }))
      ),
      generateDataKey: vi.fn((input: GenerateDataKeyRequest) =>
        input.KeyId === ROOTS.private_manual.object_wrap
          ? Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" }))
          : Promise.resolve({
              KeyId: ROOTS.private_manual.content_mac,
              Plaintext: leaked,
              CiphertextBlob: new Uint8Array([1])
            })
      ),
      reEncryptDataKey: vi.fn(() => Promise.reject(new Error("not used")))
    };
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      transport: contextAwareTransport(),
      workload: "index_worker"
    });
    await expect(
      runKeyCustodyProbe({
        aiKeyRequest: aiRequest(),
        custodian,
        directPrivateKmsProbe: {
          aiContentMacRootArn: ROOTS.ai_assisted.content_mac,
          rootKeyArns: ROOTS.private_manual,
          transport: privateTransport
        },
        wrongOwnerId: OWNER_B
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    expect(leaked).toEqual(new Uint8Array(32));
  });

  it("fails if wrong-context decryption opens or AI material does not round-trip", async () => {
    const permissiveCustodian: IntermediateKeyCustodian = {
      withGeneratedIntermediateKey<Result>(
        request: CreateIntermediateKeyRequest,
        use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>
      ): Promise<Result> {
        const record = {
          schemaVersion: 1,
          ...request,
          wrapOperationLimit: request.wrapOperationLimit ?? 2 ** 24,
          status: "pending",
          encryptedKeyMaterial: "AQ",
          rootKeyArn: ROOTS[request.keyClass][request.purpose],
          activatedAt: null,
          retiredAt: null,
          revokedAt: null,
          wrapOperations: 0,
          rotation: {
            predecessorKeyId: request.predecessorKeyId,
            previousRootKeyArn: null,
            rootRewrapCount: 0,
            lastRootRewrappedAt: null
          }
        } as ManagedKeyRecordV1;
        return use(rawKey(1), record);
      },
      withUnwrappedIntermediateKey<Result>(
        record: unknown,
        use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>
      ): Promise<Result> {
        return use(rawKey(1), record as ManagedKeyRecordV1);
      }
    };
    await expect(
      runKeyCustodyProbe({
        aiKeyRequest: aiRequest(),
        custodian: permissiveCustodian,
        directPrivateKmsProbe: {
          aiContentMacRootArn: ROOTS.ai_assisted.content_mac,
          rootKeyArns: ROOTS.private_manual,
          transport: {
            destroy: vi.fn(),
            decryptDataKey: vi.fn(() =>
              Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" }))
            ),
            generateDataKey: vi.fn(() =>
              Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" }))
            ),
            reEncryptDataKey: vi.fn(() => Promise.reject(new Error("not used")))
          }
        },
        wrongOwnerId: OWNER_B
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
  });

  it("rejects invalid probe bindings, collapsed roots, and non-denial provider errors", async () => {
    const custodian = createAwsKmsEnvelopeCustodian({
      activeRoots: INDEX_ROOTS,
      transport: contextAwareTransport(),
      workload: "index_worker"
    });
    await expect(
      runKeyCustodyProbe({
        aiKeyRequest: { ...aiRequest(), keyClass: "private_manual" },
        custodian,
        wrongOwnerId: OWNER_B
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    await expect(
      runKeyCustodyProbe({
        aiKeyRequest: aiRequest(),
        custodian,
        wrongOwnerId: OWNER_A
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
    await expect(
      runKeyCustodyProbe({
        aiKeyRequest: aiRequest(),
        custodian,
        directPrivateKmsProbe: {
          aiContentMacRootArn: ROOTS.private_manual.object_wrap,
          rootKeyArns: {
            object_wrap: ROOTS.private_manual.object_wrap,
            content_mac: ROOTS.private_manual.object_wrap
          },
          transport: contextAwareTransport()
        },
        wrongOwnerId: OWNER_B
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));

    const unavailablePrivateTransport: AwsKmsTransport = {
      destroy: vi.fn(),
      decryptDataKey: vi.fn(() => Promise.reject(new Error("not used"))),
      generateDataKey: vi.fn(() => Promise.reject(new Error("provider unavailable"))),
      reEncryptDataKey: vi.fn(() => Promise.reject(new Error("not used")))
    };
    await expect(
      runKeyCustodyProbe({
        aiKeyRequest: aiRequest(),
        custodian,
        directPrivateKmsProbe: {
          aiContentMacRootArn: ROOTS.ai_assisted.content_mac,
          rootKeyArns: ROOTS.private_manual,
          transport: unavailablePrivateTransport
        },
        wrongOwnerId: OWNER_B
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KEY_INVALID));
  });
});
