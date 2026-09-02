import type {
  AiAssistedRootKeySet,
  IndexWorkerRootKeySet,
  KeyClass,
  KeyPurpose,
  ManagedKeyRecordV2,
  ManagedKeyRecordV1,
  RootKeySet,
  VercelSensitiveEnvironmentRootKeySet
} from "../src/index";

export const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const CREATED_AT = "2026-08-30T12:00:00.000Z";
export const REWRAPPED_AT = "2026-08-31T12:00:00.000Z";

export const ROOTS: RootKeySet = Object.freeze({
  ai_assisted: Object.freeze({
    object_wrap: "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
    content_mac: "arn:aws:kms:us-west-2:123456789012:key/22222222-2222-4222-8222-222222222222"
  }),
  private_manual: Object.freeze({
    object_wrap: "arn:aws:kms:us-west-2:123456789012:key/33333333-3333-4333-8333-333333333333",
    content_mac: "arn:aws:kms:us-west-2:123456789012:key/44444444-4444-4444-8444-444444444444"
  })
});

export const AI_ROOTS: AiAssistedRootKeySet = Object.freeze({
  ai_assisted: ROOTS.ai_assisted
});

export const INDEX_ROOTS: IndexWorkerRootKeySet = Object.freeze({
  ai_assisted: Object.freeze({ object_wrap: ROOTS.ai_assisted.object_wrap })
});

export const RETIRED_AI_OBJECT_ROOT =
  "arn:aws:kms:us-west-2:123456789012:key/55555555-5555-4555-8555-555555555555";

export const VERCEL_ROOTS: VercelSensitiveEnvironmentRootKeySet = Object.freeze({
  ai_assisted: Object.freeze({
    object_wrap:
      "urn:unfiled:key-root:vercel-sensitive-env-v1:production:11111111-1111-4111-8111-111111111111",
    content_mac:
      "urn:unfiled:key-root:vercel-sensitive-env-v1:production:22222222-2222-4222-8222-222222222222"
  }),
  private_manual: Object.freeze({
    object_wrap:
      "urn:unfiled:key-root:vercel-sensitive-env-v1:production:33333333-3333-4333-8333-333333333333",
    content_mac:
      "urn:unfiled:key-root:vercel-sensitive-env-v1:production:44444444-4444-4444-8444-444444444444"
  })
});

export const VERCEL_RETIRED_AI_OBJECT_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:production:55555555-5555-4555-8555-555555555555";

export function environmentEnvelope(seed: number): string {
  const bytes = new Uint8Array(65).fill(seed);
  bytes.set([0x55, 0x46, 0x45, 0x4b, 0x01]);
  return Buffer.from(bytes).toString("base64url");
}

export function managedRecord(
  overrides: Partial<ManagedKeyRecordV1> &
    Readonly<{ keyClass?: KeyClass; purpose?: KeyPurpose }> = {}
): ManagedKeyRecordV1 {
  const keyClass = overrides.keyClass ?? "ai_assisted";
  const purpose = overrides.purpose ?? "object_wrap";
  return {
    schemaVersion: 1,
    ownerId: OWNER_A,
    keyClass,
    purpose,
    keyId: `${keyClass}.${purpose}.v1`,
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: "AQIDBA",
    rootKeyArn: ROOTS[keyClass][purpose],
    createdAt: CREATED_AT,
    activatedAt: CREATED_AT,
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 2,
    wrapOperationLimit: 2 ** 24,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    },
    ...overrides
  };
}

export function managedRecordV2(
  overrides: Partial<ManagedKeyRecordV2> &
    Readonly<{ keyClass?: KeyClass; purpose?: KeyPurpose }> = {}
): ManagedKeyRecordV2 {
  const keyClass = overrides.keyClass ?? "ai_assisted";
  const purpose = overrides.purpose ?? "object_wrap";
  return {
    schemaVersion: 2,
    custodyProvider: "vercel_sensitive_environment_v1",
    ownerId: OWNER_A,
    keyClass,
    purpose,
    keyId: `${keyClass}.${purpose}.v1`,
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: environmentEnvelope(1),
    rootKeyId: VERCEL_ROOTS[keyClass][purpose],
    wrapAlgorithm: "AES-256-GCM",
    createdAt: CREATED_AT,
    activatedAt: CREATED_AT,
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 2,
    wrapOperationLimit: 2 ** 24,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyId: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    },
    ...overrides
  };
}

export function rawKey(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

export function base64UrlKey(seed: number): string {
  return Buffer.from(rawKey(seed)).toString("base64url");
}
