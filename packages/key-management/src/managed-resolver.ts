import {
  importKeyEncryptionKey,
  type ContentKeyResolver,
  type KeyEncryptionKey
} from "@unfiled/content-crypto";

import {
  KeyManagementErrorCode,
  keyManagementFailure,
  type IntermediateKeyCustodian,
  type KeyBinding,
  type KeyPurpose,
  type KeyReference,
  type KeySelector,
  type KeyWorkload,
  type ManagedContentMacKey,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser,
  type ManagedKeyRecordV1,
  type ManagedKeyStore,
  type ManagedObjectWrappingKey,
  type OwnerBoundKeyResolver
} from "./types.js";
import {
  assertWorkload,
  assertWorkloadCanAccess,
  isDecryptableStatus,
  parseKeyBinding,
  parseKeySelector,
  parseManagedKeyRecord,
  sameBinding,
  sameSelector
} from "./validation.js";

const INTERMEDIATE_KEY_BYTES = 32;

function reference(record: ManagedKeyRecord): KeyReference {
  return Object.freeze({
    ownerId: record.ownerId,
    keyClass: record.keyClass,
    purpose: record.purpose,
    keyId: record.keyId,
    keyVersion: record.keyVersion
  });
}

function withPurpose(binding: Omit<KeyBinding, "purpose">, purpose: KeyPurpose): KeyBinding {
  return parseKeyBinding({ ...binding, purpose });
}

function selectorWithPurpose(
  selector: Omit<KeySelector, "purpose">,
  purpose: KeyPurpose
): KeySelector {
  return parseKeySelector({ ...selector, purpose });
}

function parseStoreRecordForSelector<KeyRecord extends ManagedKeyRecord>(
  value: unknown,
  expected: KeySelector,
  parseRecord: ManagedKeyRecordParser<KeyRecord>
): KeyRecord {
  const record = parseRecord(value);
  if (!sameSelector(record, expected) || !isDecryptableStatus(record.status)) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Stored key record is invalid");
  }
  return record;
}

function parseActiveStoreRecord<KeyRecord extends ManagedKeyRecord>(
  value: unknown,
  expected: KeyBinding,
  parseRecord: ManagedKeyRecordParser<KeyRecord>
): KeyRecord {
  const record = parseRecord(value);
  if (!sameBinding(record, expected) || record.status !== "active") {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Stored key record is invalid");
  }
  return record;
}

async function importContentMacKey(
  bytes: Uint8Array,
  cryptoImplementation: Crypto
): Promise<CryptoKey> {
  if (bytes.length !== INTERMEDIATE_KEY_BYTES) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key material is invalid");
  }
  const importBytes = Uint8Array.from(bytes);
  try {
    return await cryptoImplementation.subtle.importKey(
      "raw",
      importBytes,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"]
    );
  } catch {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key material is invalid");
  } finally {
    importBytes.fill(0);
  }
}

function runtimeCrypto(provided?: Crypto): Crypto {
  const implementation =
    (provided as Partial<Crypto> | undefined) ??
    (globalThis as unknown as { crypto?: Partial<Crypto> }).crypto;
  if (implementation?.subtle === undefined) {
    keyManagementFailure(KeyManagementErrorCode.CONFIGURATION_INVALID, "Web Crypto is unavailable");
  }
  return implementation as Crypto;
}

export type ManagedKeyResolverOptions<KeyRecord extends ManagedKeyRecord = ManagedKeyRecordV1> =
  Readonly<{
    crypto?: Crypto;
    custodian: IntermediateKeyCustodian<KeyRecord>;
    parseRecord?: ManagedKeyRecordParser<KeyRecord>;
    store: ManagedKeyStore;
    workload: KeyWorkload;
  }>;

export function createManagedKeyResolver(options: ManagedKeyResolverOptions): OwnerBoundKeyResolver;
export function createManagedKeyResolver<KeyRecord extends ManagedKeyRecord>(
  options: ManagedKeyResolverOptions<KeyRecord> &
    Readonly<{ parseRecord: ManagedKeyRecordParser<KeyRecord> }>
): OwnerBoundKeyResolver;
export function createManagedKeyResolver(
  options: ManagedKeyResolverOptions<ManagedKeyRecord>
): OwnerBoundKeyResolver {
  assertWorkload(options.workload);
  const cryptoImplementation = runtimeCrypto(options.crypto);
  const parseRecord = (options.parseRecord ?? parseManagedKeyRecord) as ManagedKeyRecordParser;

  async function resolveObject(selector: KeySelector): Promise<ManagedObjectWrappingKey | null> {
    assertWorkloadCanAccess(options.workload, selector.keyClass, selector.purpose);
    const stored = await options.store.findById(selector);
    if (stored === null) return null;
    const record = parseStoreRecordForSelector(stored, selector, parseRecord);
    return options.custodian.withUnwrappedIntermediateKey(record, async (bytes) => {
      const key = await importKeyEncryptionKey(record.keyId, bytes, cryptoImplementation);
      return Object.freeze({ reference: reference(record), key });
    });
  }

  async function resolveMac(selector: KeySelector): Promise<ManagedContentMacKey | null> {
    assertWorkloadCanAccess(options.workload, selector.keyClass, selector.purpose);
    const stored = await options.store.findById(selector);
    if (stored === null) return null;
    const record = parseStoreRecordForSelector(stored, selector, parseRecord);
    return options.custodian.withUnwrappedIntermediateKey(record, async (bytes) => {
      const key = await importContentMacKey(bytes, cryptoImplementation);
      return Object.freeze({ reference: reference(record), key });
    });
  }

  async function activeRecord(binding: KeyBinding): Promise<ManagedKeyRecord> {
    assertWorkloadCanAccess(options.workload, binding.keyClass, binding.purpose);
    const stored = await options.store.findActive(binding);
    if (stored === null) {
      keyManagementFailure(KeyManagementErrorCode.KEY_NOT_FOUND, "Active key is unavailable");
    }
    return parseActiveStoreRecord(stored, binding, parseRecord);
  }

  return Object.freeze({
    async activeContentMacKey(bindingValue): Promise<ManagedContentMacKey> {
      const binding = withPurpose(bindingValue, "content_mac");
      const record = await activeRecord(binding);
      return options.custodian.withUnwrappedIntermediateKey(record, async (bytes) =>
        Object.freeze({
          reference: reference(record),
          key: await importContentMacKey(bytes, cryptoImplementation)
        })
      );
    },

    async activeObjectWrappingKey(bindingValue): Promise<ManagedObjectWrappingKey> {
      const binding = withPurpose(bindingValue, "object_wrap");
      const record = await activeRecord(binding);
      if (record.wrapOperations >= record.wrapOperationLimit) {
        keyManagementFailure(KeyManagementErrorCode.KEY_STATE_INVALID, "Active key is unavailable");
      }
      return options.custodian.withUnwrappedIntermediateKey(record, async (bytes) =>
        Object.freeze({
          reference: reference(record),
          key: await importKeyEncryptionKey(record.keyId, bytes, cryptoImplementation)
        })
      );
    },

    contentKeyResolver(bindingValue): ContentKeyResolver {
      const binding = withPurpose(bindingValue, "object_wrap");
      assertWorkloadCanAccess(options.workload, binding.keyClass, binding.purpose);
      return async (keyId: string): Promise<KeyEncryptionKey | null> => {
        const resolved = await resolveObject(parseKeySelector({ ...binding, keyId }));
        return resolved?.key ?? null;
      };
    },

    resolveContentMacKey(selectorValue): Promise<ManagedContentMacKey | null> {
      return resolveMac(selectorWithPurpose(selectorValue, "content_mac"));
    },

    resolveObjectWrappingKey(selectorValue): Promise<ManagedObjectWrappingKey | null> {
      return resolveObject(selectorWithPurpose(selectorValue, "object_wrap"));
    }
  });
}
