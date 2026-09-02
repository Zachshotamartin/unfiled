import { describe, expect, it } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  createVercelSensitiveEnvironmentKmsTransport,
  vercelSensitiveEnvironmentKeyConfiguration,
  type KmsEncryptionContext,
  type VercelSensitiveEnvironmentKmsTransportOptions
} from "../src/index";
import { OWNER_A } from "./fixtures";

const PROJECT_ID = "prj_unfiledbeta123";
const ROOT_A =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-1111-4111-8111-111111111111";
const ROOT_B =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:22222222-2222-4222-8222-222222222222";
const ROOT_C =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:33333333-3333-4333-8333-333333333333";
const PREVIEW_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:preview:44444444-4444-4444-8444-444444444444";
const MATERIAL_A = Buffer.alloc(32, 0x11).toString("base64url");
const MATERIAL_B = Buffer.alloc(32, 0x22).toString("base64url");
const MATERIAL_C = Buffer.alloc(32, 0x33).toString("base64url");
const SECRET_VARIABLE = vercelSensitiveEnvironmentKeyConfiguration.keyRingVariable;

const CONTEXT: KmsEncryptionContext = Object.freeze({
  UnfiledOwnerId: OWNER_A,
  UnfiledKeyClass: "ai_assisted",
  UnfiledKeyPurpose: "object_wrap",
  UnfiledKeyRecordId: "key-ai-object-wrap-v1"
});

type RootEntry = Readonly<{ keyMaterial: string; rootKeyId: string }>;
type RingOptions = Readonly<{
  deploymentEnvironment?: "preview" | "production";
  projectId?: string;
  roots?: readonly unknown[];
  version?: number;
}>;

function root(rootKeyId: string, keyMaterial: string): RootEntry {
  return Object.freeze({ keyMaterial, rootKeyId });
}

function ring(options: RingOptions = {}): string {
  return JSON.stringify({
    deploymentEnvironment: options.deploymentEnvironment ?? "production",
    projectId: options.projectId ?? PROJECT_ID,
    roots: options.roots ?? [root(ROOT_A, MATERIAL_A), root(ROOT_B, MATERIAL_B)],
    version: options.version ?? 1
  });
}

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
  serializedRing = ring()
): Readonly<Record<string, string | undefined>> {
  return {
    NODE_ENV: "production",
    UNFILED_KEY_CUSTODIAN: "vercel-sensitive-env-v1",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: PROJECT_ID,
    [SECRET_VARIABLE]: serializedRing,
    ...overrides
  };
}

function options(
  overrides: Partial<VercelSensitiveEnvironmentKmsTransportOptions> = {}
): VercelSensitiveEnvironmentKmsTransportOptions {
  return {
    environment: environment(),
    expectedRootKeyIds: [ROOT_A, ROOT_B],
    ...overrides
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

function requiredBytes(value: Uint8Array | undefined): Uint8Array {
  if (value === undefined) throw new Error("test setup failed");
  return value;
}

async function generatedEnvelope() {
  const transport = await createVercelSensitiveEnvironmentKmsTransport(options());
  const generated = await transport.generateDataKey({
    EncryptionContext: CONTEXT,
    KeyId: ROOT_A,
    KeySpec: "AES_256"
  });
  const plaintext = generated.Plaintext;
  const ciphertext = generated.CiphertextBlob;
  if (plaintext === undefined || ciphertext === undefined) throw new Error("test setup failed");
  return { ciphertext, plaintext, transport };
}

describe("Vercel sensitive-environment key transport", () => {
  it("exports a stable, non-public configuration contract", () => {
    expect(vercelSensitiveEnvironmentKeyConfiguration).toEqual({
      keyRingVariable: "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1",
      mode: "vercel-sensitive-env-v1",
      modeVariable: "UNFILED_KEY_CUSTODIAN",
      rootKeyIdPrefix: "urn:unfiled:key-root:vercel-sensitive-env-v1:"
    });
    expect(SECRET_VARIABLE).not.toMatch(/^NEXT_PUBLIC_/u);
  });

  it("generates and unwraps fresh 256-bit data keys with a versioned randomized envelope", async () => {
    const transport = await createVercelSensitiveEnvironmentKmsTransport(options());
    const first = await transport.generateDataKey({
      EncryptionContext: CONTEXT,
      KeyId: ROOT_A,
      KeySpec: "AES_256"
    });
    const second = await transport.generateDataKey({
      EncryptionContext: CONTEXT,
      KeyId: ROOT_A,
      KeySpec: "AES_256"
    });
    const firstCiphertext = requiredBytes(first.CiphertextBlob);
    expect(first.KeyId).toBe(ROOT_A);
    expect(first.Plaintext).toHaveLength(32);
    expect(first.CiphertextBlob).toHaveLength(65);
    expect([...firstCiphertext.slice(0, 5)]).toEqual([0x55, 0x46, 0x45, 0x4b, 0x01]);
    expect(first.Plaintext).not.toEqual(second.Plaintext);
    expect(first.CiphertextBlob).not.toEqual(second.CiphertextBlob);

    const decrypted = await transport.decryptDataKey({
      CiphertextBlob: firstCiphertext,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      EncryptionContext: CONTEXT,
      KeyId: ROOT_A
    });
    expect(decrypted).toEqual({ KeyId: ROOT_A, Plaintext: first.Plaintext });

    first.Plaintext?.fill(0);
    second.Plaintext?.fill(0);
    decrypted.Plaintext?.fill(0);
    first.CiphertextBlob?.fill(0);
    second.CiphertextBlob?.fill(0);
    transport.destroy();
  });

  it("canonicalizes context order while binding every exact context field", async () => {
    const { ciphertext, plaintext, transport } = await generatedEnvelope();
    const reordered: KmsEncryptionContext = {
      UnfiledKeyRecordId: "key-ai-object-wrap-v1",
      UnfiledKeyPurpose: "object_wrap",
      UnfiledKeyClass: "ai_assisted",
      UnfiledOwnerId: OWNER_A
    };
    await expect(
      transport.decryptDataKey({
        CiphertextBlob: ciphertext,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: reordered,
        KeyId: ROOT_A
      })
    ).resolves.toMatchObject({ Plaintext: plaintext });

    const invalidContexts: unknown[] = [
      { ...CONTEXT, UnfiledOwnerId: "00000000-0000-4000-8000-000000000000" },
      { ...CONTEXT, UnfiledKeyClass: "private_manual" },
      { ...CONTEXT, UnfiledKeyPurpose: "content_mac" },
      { ...CONTEXT, UnfiledKeyRecordId: "different-key" },
      { ...CONTEXT, unexpected: "value" },
      {
        UnfiledOwnerId: CONTEXT.UnfiledOwnerId,
        UnfiledKeyClass: CONTEXT.UnfiledKeyClass,
        UnfiledKeyPurpose: CONTEXT.UnfiledKeyPurpose
      },
      { ...CONTEXT, UnfiledKeyRecordId: "" },
      { ...CONTEXT, UnfiledKeyRecordId: " leading-space" },
      { ...CONTEXT, UnfiledKeyRecordId: "control\u0000character" },
      { ...CONTEXT, UnfiledKeyRecordId: "é".repeat(257) },
      [],
      null
    ];
    for (const invalidContext of invalidContexts) {
      await expect(
        transport.decryptDataKey({
          CiphertextBlob: ciphertext,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          EncryptionContext: invalidContext as KmsEncryptionContext,
          KeyId: ROOT_A
        })
      ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    }
    plaintext.fill(0);
    ciphertext.fill(0);
    transport.destroy();
  });

  it("authenticates the envelope version, IV, ciphertext, tag, root, and exact length", async () => {
    const { ciphertext, plaintext, transport } = await generatedEnvelope();
    const mutations = [
      (() => {
        const value = Uint8Array.from(ciphertext);
        value[0] = (value[0] ?? 0) ^ 1;
        return value;
      })(),
      (() => {
        const value = Uint8Array.from(ciphertext);
        value[5] = (value[5] ?? 0) ^ 1;
        return value;
      })(),
      (() => {
        const value = Uint8Array.from(ciphertext);
        value[20] = (value[20] ?? 0) ^ 1;
        return value;
      })(),
      (() => {
        const value = Uint8Array.from(ciphertext);
        value[value.length - 1] = (value[value.length - 1] ?? 0) ^ 1;
        return value;
      })(),
      ciphertext.slice(0, -1),
      Uint8Array.from([...ciphertext, 0])
    ];
    for (const mutation of mutations) {
      await expect(
        transport.decryptDataKey({
          CiphertextBlob: mutation,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          EncryptionContext: CONTEXT,
          KeyId: ROOT_A
        })
      ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
      mutation.fill(0);
    }
    await expect(
      transport.decryptDataKey({
        CiphertextBlob: ciphertext,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: CONTEXT,
        KeyId: ROOT_B
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    plaintext.fill(0);
    ciphertext.fill(0);
    transport.destroy();
  });

  it("rewraps without returning plaintext and binds the destination root", async () => {
    const { ciphertext, plaintext, transport } = await generatedEnvelope();
    const rewrapped = await transport.reEncryptDataKey({
      CiphertextBlob: ciphertext,
      DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      DestinationEncryptionContext: CONTEXT,
      DestinationKeyId: ROOT_B,
      SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      SourceEncryptionContext: CONTEXT,
      SourceKeyId: ROOT_A
    });
    expect(rewrapped.KeyId).toBe(ROOT_B);
    expect(rewrapped.SourceKeyId).toBe(ROOT_A);
    expect(rewrapped.CiphertextBlob).toHaveLength(65);
    expect(rewrapped).not.toHaveProperty("Plaintext");
    const rewrappedCiphertext = requiredBytes(rewrapped.CiphertextBlob);
    await expect(
      transport.decryptDataKey({
        CiphertextBlob: rewrappedCiphertext,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: CONTEXT,
        KeyId: ROOT_B
      })
    ).resolves.toMatchObject({ Plaintext: plaintext });
    await expect(
      transport.decryptDataKey({
        CiphertextBlob: rewrappedCiphertext,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: CONTEXT,
        KeyId: ROOT_A
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    plaintext.fill(0);
    ciphertext.fill(0);
    rewrapped.CiphertextBlob?.fill(0);
    transport.destroy();
  });

  it("rejects unknown roots and non-canonical operation algorithms", async () => {
    const { ciphertext, plaintext, transport } = await generatedEnvelope();
    await expect(
      transport.generateDataKey({
        EncryptionContext: CONTEXT,
        KeyId: ROOT_C,
        KeySpec: "AES_256"
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    await expect(
      transport.generateDataKey({
        EncryptionContext: CONTEXT,
        KeyId: ROOT_A,
        KeySpec: "AES_128" as "AES_256"
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    await expect(
      transport.decryptDataKey({
        CiphertextBlob: ciphertext,
        EncryptionAlgorithm: "RSAES_OAEP_SHA_256" as "SYMMETRIC_DEFAULT",
        EncryptionContext: CONTEXT,
        KeyId: ROOT_A
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    await expect(
      transport.reEncryptDataKey({
        CiphertextBlob: ciphertext,
        DestinationEncryptionAlgorithm: "invalid" as "SYMMETRIC_DEFAULT",
        DestinationEncryptionContext: CONTEXT,
        DestinationKeyId: ROOT_B,
        SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        SourceEncryptionContext: CONTEXT,
        SourceKeyId: ROOT_A
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    await expect(
      transport.reEncryptDataKey({
        CiphertextBlob: ciphertext,
        DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        DestinationEncryptionContext: CONTEXT,
        DestinationKeyId: ROOT_B,
        SourceEncryptionAlgorithm: "invalid" as "SYMMETRIC_DEFAULT",
        SourceEncryptionContext: CONTEXT,
        SourceKeyId: ROOT_A
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    plaintext.fill(0);
    ciphertext.fill(0);
    transport.destroy();
  });

  it("fails closed before work when aborted and after idempotent destruction", async () => {
    const { ciphertext, plaintext, transport } = await generatedEnvelope();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      transport.generateDataKey(
        { EncryptionContext: CONTEXT, KeyId: ROOT_A, KeySpec: "AES_256" },
        { abortSignal: aborted.signal }
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    await expect(
      transport.decryptDataKey(
        {
          CiphertextBlob: ciphertext,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          EncryptionContext: CONTEXT,
          KeyId: ROOT_A
        },
        { abortSignal: aborted.signal }
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    await expect(
      transport.reEncryptDataKey(
        {
          CiphertextBlob: ciphertext,
          DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          DestinationEncryptionContext: CONTEXT,
          DestinationKeyId: ROOT_B,
          SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          SourceEncryptionContext: CONTEXT,
          SourceKeyId: ROOT_A
        },
        { abortSignal: aborted.signal }
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));

    transport.destroy();
    transport.destroy();
    await expect(
      transport.generateDataKey({ EncryptionContext: CONTEXT, KeyId: ROOT_A, KeySpec: "AES_256" })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    await expect(
      transport.decryptDataKey({
        CiphertextBlob: ciphertext,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: CONTEXT,
        KeyId: ROOT_A
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    plaintext.fill(0);
    ciphertext.fill(0);
  });

  it("maps runtime randomness failures to a content-free availability error", async () => {
    const failingCrypto = {
      getRandomValues(): never {
        throw new Error(MATERIAL_A);
      },
      subtle: globalThis.crypto.subtle
    } as unknown as Crypto;
    const transport = await createVercelSensitiveEnvironmentKmsTransport(
      options({ crypto: failingCrypto })
    );
    let failure: unknown;
    try {
      await transport.generateDataKey({
        EncryptionContext: CONTEXT,
        KeyId: ROOT_A,
        KeySpec: "AES_256"
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toSatisfy(expectCode(KeyManagementErrorCode.KMS_UNAVAILABLE));
    expect(String(failure)).not.toContain(MATERIAL_A);
    transport.destroy();
  });

  it.each([
    ["non-production Node runtime", { NODE_ENV: "test" }],
    ["missing Vercel marker", { VERCEL: undefined }],
    ["false Vercel marker", { VERCEL: "0" }],
    ["development Vercel environment", { VERCEL_ENV: "development" }],
    ["whitespace-padded Vercel environment", { VERCEL_ENV: " production " }],
    ["missing project identity", { VERCEL_PROJECT_ID: undefined }],
    ["invalid project identity", { VERCEL_PROJECT_ID: "unfiled" }],
    ["whitespace-padded project identity", { VERCEL_PROJECT_ID: ` ${PROJECT_ID}` }],
    ["missing custody mode", { UNFILED_KEY_CUSTODIAN: undefined }],
    ["wrong custody mode", { UNFILED_KEY_CUSTODIAN: "local" }],
    ["whitespace-padded custody mode", { UNFILED_KEY_CUSTODIAN: "vercel-sensitive-env-v1 " }],
    ["local key ring", { UNFILED_LOCAL_KEY_RING_V1: "{}" }],
    ["AWS access key", { AWS_ACCESS_KEY_ID: "canary" }],
    ["AWS profile", { AWS_PROFILE: "default" }],
    ["AWS role", { AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/canary" }],
    ["Unfiled AWS role", { UNFILED_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/canary" }],
    [
      "service-specific AWS role",
      { UNFILED_SEARCH_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/canary" }
    ],
    ["public root key", { NEXT_PUBLIC_UNFILED_ROOT_KEY: MATERIAL_C }],
    ["public key ring", { NEXT_PUBLIC_UNFILED_KEY_RING_V1: ring() }]
  ])("rejects %s in the deployment identity", async (_name, override) => {
    await expect(
      createVercelSensitiveEnvironmentKmsTransport(options({ environment: environment(override) }))
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
  });

  it("accepts an exact Preview identity only with Preview-bound roots and key ring", async () => {
    const previewEnvironment = environment(
      { VERCEL_ENV: "preview" },
      ring({
        deploymentEnvironment: "preview",
        roots: [root(PREVIEW_ROOT, MATERIAL_A)]
      })
    );
    const transport = await createVercelSensitiveEnvironmentKmsTransport({
      environment: previewEnvironment,
      expectedRootKeyIds: [PREVIEW_ROOT]
    });
    await expect(
      transport.generateDataKey({
        EncryptionContext: CONTEXT,
        KeyId: PREVIEW_ROOT,
        KeySpec: "AES_256"
      })
    ).resolves.toMatchObject({ KeyId: PREVIEW_ROOT });
    transport.destroy();

    await expect(
      createVercelSensitiveEnvironmentKmsTransport({
        environment: previewEnvironment,
        expectedRootKeyIds: [ROOT_A]
      })
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["leading whitespace", ` ${ring()}`],
    ["trailing whitespace", `${ring()} `],
    ["invalid JSON", "{"],
    ["non-object JSON", "[]"],
    ["empty object", "{}"],
    [
      "duplicate property",
      `{"deploymentEnvironment":"production","projectId":"${PROJECT_ID}","roots":[{"keyMaterial":"${MATERIAL_A}","rootKeyId":"${ROOT_A}"},{"keyMaterial":"${MATERIAL_B}","rootKeyId":"${ROOT_B}"}],"version":1,"version":1}`
    ],
    ["extra top-level property", JSON.stringify({ ...JSON.parse(ring()), extra: true })],
    ["wrong version", ring({ version: 2 })],
    ["wrong environment", ring({ deploymentEnvironment: "preview" })],
    ["wrong project", ring({ projectId: "prj_otherproject123" })],
    ["roots not an array", JSON.stringify({ ...JSON.parse(ring()), roots: {} })],
    ["empty roots", ring({ roots: [] })],
    ["missing root field", ring({ roots: [{ rootKeyId: ROOT_A }] })],
    ["extra root field", ring({ roots: [{ ...root(ROOT_A, MATERIAL_A), extra: true }] })],
    [
      "invalid root identifier",
      ring({
        roots: [
          root(
            "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
            MATERIAL_A
          )
        ]
      })
    ],
    ["wrong-environment root", ring({ roots: [root(PREVIEW_ROOT, MATERIAL_A)] })],
    ["short key material", ring({ roots: [root(ROOT_A, Buffer.alloc(31).toString("base64url"))] })],
    ["long key material", ring({ roots: [root(ROOT_A, Buffer.alloc(33).toString("base64url"))] })],
    ["non-canonical key material", ring({ roots: [root(ROOT_A, `${MATERIAL_A}=`)] })],
    ["duplicate root", ring({ roots: [root(ROOT_A, MATERIAL_A), root(ROOT_A, MATERIAL_B)] })],
    ["duplicate material", ring({ roots: [root(ROOT_A, MATERIAL_A), root(ROOT_B, MATERIAL_A)] })],
    ["missing expected root", ring({ roots: [root(ROOT_A, MATERIAL_A)] })],
    ["unexpected root", ring({ roots: [root(ROOT_A, MATERIAL_A), root(ROOT_C, MATERIAL_C)] })]
  ])("rejects a %s sensitive root-key ring", async (_name, serializedRing) => {
    await expect(
      createVercelSensitiveEnvironmentKmsTransport(
        options({
          environment: environment({ [SECRET_VARIABLE]: serializedRing }, serializedRing ?? ring())
        })
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
  });

  it("bounds root counts and the serialized secret size", async () => {
    const tooManyRoots = Array.from({ length: 101 }, (_value, index) => ({
      keyMaterial: Buffer.alloc(32, index + 1).toString("base64url"),
      rootKeyId: `urn:unfiled:key-root:vercel-sensitive-env-v1:production:${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`
    }));
    await expect(
      createVercelSensitiveEnvironmentKmsTransport(
        options({
          environment: environment({}, ring({ roots: tooManyRoots })),
          expectedRootKeyIds: tooManyRoots.map((entry) => entry.rootKeyId)
        })
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));

    await expect(
      createVercelSensitiveEnvironmentKmsTransport(
        options({ environment: environment({}, "x".repeat(32_769)) })
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
  });

  it.each([
    ["missing list", undefined],
    ["empty list", []],
    ["duplicate root", [ROOT_A, ROOT_A]],
    ["whitespace", [`${ROOT_A} `]],
    ["AWS ARN", ["arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111"]],
    ["Preview root in Production", [PREVIEW_ROOT]],
    ["invalid URN", ["urn:unfiled:key-root:vercel-sensitive-env-v1:production:nope"]]
  ])("rejects a %s expected-root contract", async (_name, expectedRootKeyIds) => {
    await expect(
      createVercelSensitiveEnvironmentKmsTransport(
        options({ expectedRootKeyIds: expectedRootKeyIds as readonly string[] })
      )
    ).rejects.toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
  });

  it("rejects an unavailable or failing Web Crypto implementation without reflecting secrets", async () => {
    const badImplementations = [
      {} as Crypto,
      { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) } as Crypto,
      {
        getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
        subtle: {
          decrypt: globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle),
          encrypt: globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle),
          importKey(): Promise<never> {
            return Promise.reject(new Error(MATERIAL_A));
          }
        }
      } as unknown as Crypto
    ];
    for (const crypto of badImplementations) {
      let failure: unknown;
      try {
        await createVercelSensitiveEnvironmentKmsTransport(options({ crypto }));
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
      expect(String(failure)).not.toContain(MATERIAL_A);
      expect(String(failure)).not.toContain(MATERIAL_B);
    }
  });
});
