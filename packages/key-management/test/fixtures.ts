import type {
  AiAssistedRootKeySet,
  KeyClass,
  KeyPurpose,
  ManagedKeyRecordV1,
  RootKeySet
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

export const RETIRED_AI_OBJECT_ROOT =
  "arn:aws:kms:us-west-2:123456789012:key/55555555-5555-4555-8555-555555555555";

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

export function rawKey(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

export function base64UrlKey(seed: number): string {
  return Buffer.from(rawKey(seed)).toString("base64url");
}
