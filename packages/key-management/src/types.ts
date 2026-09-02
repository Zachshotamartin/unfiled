import type { ContentKeyResolver, KeyEncryptionKey } from "@unfiled/content-crypto";

export const KEY_CLASSES = Object.freeze(["ai_assisted", "private_manual"] as const);
export const KEY_PURPOSES = Object.freeze(["object_wrap", "content_mac"] as const);
export const KEY_STATUSES = Object.freeze(["pending", "active", "retired", "revoked"] as const);
export const KEY_WORKLOADS = Object.freeze([
  "interactive_api",
  "organization_worker",
  "index_worker",
  "search_worker"
] as const);

export type KeyClass = (typeof KEY_CLASSES)[number];
export type KeyPurpose = (typeof KEY_PURPOSES)[number];
export type KeyStatus = (typeof KEY_STATUSES)[number];
export type KeyWorkload = (typeof KEY_WORKLOADS)[number];

export type KeyBinding = Readonly<{
  ownerId: string;
  keyClass: KeyClass;
  purpose: KeyPurpose;
}>;

export type KeySelector = KeyBinding &
  Readonly<{
    keyId: string;
  }>;

export type KeyReference = KeySelector &
  Readonly<{
    keyVersion: number;
  }>;

export type KeyRotationMetadata = Readonly<{
  predecessorKeyId: string | null;
  previousRootKeyArn: string | null;
  rootRewrapCount: number;
  lastRootRewrappedAt: string | null;
}>;

export type ManagedKeyRecordV1 = KeyReference &
  Readonly<{
    schemaVersion: 1;
    status: KeyStatus;
    encryptedKeyMaterial: string;
    rootKeyArn: string;
    createdAt: string;
    activatedAt: string | null;
    retiredAt: string | null;
    revokedAt: string | null;
    wrapOperations: number;
    wrapOperationLimit: number;
    rotation: KeyRotationMetadata;
  }>;

export type CreateIntermediateKeyRequest = KeyReference &
  Readonly<{
    createdAt: string;
    predecessorKeyId: string | null;
    wrapOperationLimit?: number;
  }>;

export type PurposeRootKeySet = Readonly<Record<KeyPurpose, string>>;

export type AiAssistedRootKeySet = Readonly<{
  ai_assisted: PurposeRootKeySet;
}>;

export type IndexWorkerRootKeySet = Readonly<{
  ai_assisted: Readonly<{
    object_wrap: string;
  }>;
}>;

/** The user-search workload can open existing AI index envelopes only. */
export type SearchWorkerRootKeySet = IndexWorkerRootKeySet;

export type RootKeySet = Readonly<Record<KeyClass, PurposeRootKeySet>>;

export type WorkloadRootKeySet = RootKeySet | AiAssistedRootKeySet | IndexWorkerRootKeySet;

export type RetiredRootKeySet = Readonly<
  Partial<Record<KeyClass, Readonly<Partial<Record<KeyPurpose, readonly string[]>>>>>
>;

export type AiAssistedRetiredRootKeySet = Readonly<{
  ai_assisted?: Readonly<Partial<Record<KeyPurpose, readonly string[]>>>;
}>;

export type IndexWorkerRetiredRootKeySet = Readonly<{
  ai_assisted?: Readonly<{
    object_wrap?: readonly string[];
  }>;
}>;

export type SearchWorkerRetiredRootKeySet = IndexWorkerRetiredRootKeySet;

export type ManagedKeyStore = Readonly<{
  findActive(binding: KeyBinding): Promise<unknown>;
  findById(selector: KeySelector): Promise<unknown>;
}>;

export type ManagedObjectWrappingKey = Readonly<{
  reference: KeyReference;
  key: KeyEncryptionKey;
}>;

export type ManagedContentMacKey = Readonly<{
  reference: KeyReference;
  key: CryptoKey;
}>;

export type OwnerBoundKeyResolver = Readonly<{
  activeContentMacKey(binding: Omit<KeyBinding, "purpose">): Promise<ManagedContentMacKey>;
  activeObjectWrappingKey(binding: Omit<KeyBinding, "purpose">): Promise<ManagedObjectWrappingKey>;
  contentKeyResolver(binding: Omit<KeyBinding, "purpose">): ContentKeyResolver;
  resolveContentMacKey(
    selector: Omit<KeySelector, "purpose">
  ): Promise<ManagedContentMacKey | null>;
  resolveObjectWrappingKey(
    selector: Omit<KeySelector, "purpose">
  ): Promise<ManagedObjectWrappingKey | null>;
}>;

/**
 * A decrypt-only resolver view for workloads that may open existing object
 * envelopes but must never select active key material for new writes.
 */
export type DecryptOnlyOwnerBoundKeyResolver = Pick<
  OwnerBoundKeyResolver,
  "contentKeyResolver" | "resolveObjectWrappingKey"
>;

export type KeyCustodyOperationOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type IntermediateKeyCustodian = Readonly<{
  withGeneratedIntermediateKey<Result>(
    request: CreateIntermediateKeyRequest,
    use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
    options?: KeyCustodyOperationOptions
  ): Promise<Result>;
  withUnwrappedIntermediateKey<Result>(
    record: unknown,
    use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
    options?: KeyCustodyOperationOptions
  ): Promise<Result>;
}>;

/**
 * A decrypt-only view used by workloads that must never mint intermediate
 * keys. Keeping generation out of the object shape makes the boundary
 * enforceable before an IAM denial is needed.
 */
export type DecryptOnlyIntermediateKeyCustodian = Pick<
  IntermediateKeyCustodian,
  "withUnwrappedIntermediateKey"
>;

export type InteractiveKeyCustodian = IntermediateKeyCustodian &
  Readonly<{
    rewrapIntermediateKey(
      record: unknown,
      rewrappedAt: string,
      options?: KeyCustodyOperationOptions
    ): Promise<ManagedKeyRecordV1>;
  }>;

export const KeyManagementErrorCode = Object.freeze({
  ACCESS_DENIED: "access_denied",
  CONFIGURATION_INVALID: "configuration_invalid",
  KEY_INVALID: "key_invalid",
  KEY_NOT_FOUND: "key_not_found",
  KEY_STATE_INVALID: "key_state_invalid",
  KMS_UNAVAILABLE: "kms_unavailable"
} as const);

export type KeyManagementErrorCodeValue =
  (typeof KeyManagementErrorCode)[keyof typeof KeyManagementErrorCode];

export class KeyManagementError extends Error {
  readonly code: KeyManagementErrorCodeValue;

  constructor(code: KeyManagementErrorCodeValue, message: string) {
    super(message);
    this.name = "KeyManagementError";
    this.code = code;
  }
}

export function keyManagementFailure(code: KeyManagementErrorCodeValue, message: string): never {
  throw new KeyManagementError(code, message);
}
