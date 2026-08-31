import { importKeyEncryptionKey, type KeyEncryptionKey } from "@unfiled/content-crypto";

import { decodeBase64Url } from "./base64url";
import {
  KeyManagementError,
  KeyManagementErrorCode,
  keyManagementFailure,
  type KeyBinding,
  type KeyClass,
  type KeyPurpose,
  type KeyReference,
  type KeySelector,
  type KeyWorkload,
  type ManagedContentMacKey,
  type ManagedObjectWrappingKey,
  type OwnerBoundKeyResolver
} from "./types";
import {
  assertWorkload,
  assertWorkloadCanAccess,
  parseKeyReference,
  parseKeySelector
} from "./validation";

const LOCAL_KEY_RING_VARIABLE = "UNFILED_LOCAL_KEY_RING_V1";
const LOCAL_MODE_VARIABLE = "UNFILED_KEY_CUSTODIAN";
const MAX_KEY_RING_BYTES = 131_072;
const MAX_LOCAL_KEYS = 100;
const KEY_BYTES = 32;

type LocalKeyStatus = "active" | "retired";

type LocalKeyEntry = KeyReference &
  Readonly<{
    status: LocalKeyStatus;
    keyMaterial: string;
  }>;

type LocalKeyMetadata = KeyReference & Readonly<{ status: LocalKeyStatus }>;

type ImportedLocalKey = Readonly<{
  entry: LocalKeyMetadata;
  key: CryptoKey | KeyEncryptionKey;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function failConfiguration(): never {
  return keyManagementFailure(
    KeyManagementErrorCode.CONFIGURATION_INVALID,
    "Local key configuration is invalid"
  );
}

function assertLocalOnly(environment: Readonly<Record<string, string | undefined>>): void {
  const nodeEnvironment = environment.NODE_ENV;
  if (
    environment[LOCAL_MODE_VARIABLE] !== "local" ||
    (nodeEnvironment !== "development" && nodeEnvironment !== "test") ||
    environment.VERCEL === "1" ||
    environment.VERCEL_ENV !== undefined
  ) {
    failConfiguration();
  }
}

function parseLocalEntry(value: unknown): LocalKeyEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ownerId",
      "keyClass",
      "purpose",
      "keyId",
      "keyVersion",
      "status",
      "keyMaterial"
    ]) ||
    (value.status !== "active" && value.status !== "retired") ||
    typeof value.keyMaterial !== "string"
  ) {
    failConfiguration();
  }
  try {
    const reference = parseKeyReference({
      ownerId: value.ownerId,
      keyClass: value.keyClass,
      purpose: value.purpose,
      keyId: value.keyId,
      keyVersion: value.keyVersion
    });
    const bytes = decodeBase64Url(value.keyMaterial, KEY_BYTES, KEY_BYTES);
    bytes.fill(0);
    return Object.freeze({ ...reference, status: value.status, keyMaterial: value.keyMaterial });
  } catch {
    failConfiguration();
  }
}

function parseKeyRing(serialized: string | undefined): readonly LocalKeyEntry[] {
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).length > MAX_KEY_RING_BYTES
  ) {
    failConfiguration();
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["version", "keys"]) ||
      value.version !== 1 ||
      !Array.isArray(value.keys) ||
      value.keys.length < 1 ||
      value.keys.length > MAX_LOCAL_KEYS
    ) {
      failConfiguration();
    }
    const entries = value.keys.map(parseLocalEntry);
    const identities = new Set<string>();
    const materials = new Set<string>();
    const activeBindings = new Set<string>();
    for (const entry of entries) {
      const identity = selectorIdentity(entry);
      const binding = bindingIdentity(entry);
      if (
        identities.has(identity) ||
        materials.has(entry.keyMaterial) ||
        (entry.status === "active" && activeBindings.has(binding))
      ) {
        failConfiguration();
      }
      identities.add(identity);
      materials.add(entry.keyMaterial);
      if (entry.status === "active") activeBindings.add(binding);
    }
    return Object.freeze(entries);
  } catch (error: unknown) {
    if (error instanceof KeyManagementError) throw error;
    failConfiguration();
  }
}

function bindingIdentity(binding: KeyBinding): string {
  return JSON.stringify([binding.ownerId, binding.keyClass, binding.purpose]);
}

function selectorIdentity(selector: KeySelector): string {
  return JSON.stringify([selector.ownerId, selector.keyClass, selector.purpose, selector.keyId]);
}

function reference(entry: KeyReference): KeyReference {
  return Object.freeze({
    ownerId: entry.ownerId,
    keyClass: entry.keyClass,
    purpose: entry.purpose,
    keyId: entry.keyId,
    keyVersion: entry.keyVersion
  });
}

function runtimeCrypto(provided?: Crypto): Crypto {
  const implementation =
    (provided as Partial<Crypto> | undefined) ??
    (globalThis as unknown as { crypto?: Partial<Crypto> }).crypto;
  if (implementation?.subtle === undefined) failConfiguration();
  return implementation as Crypto;
}

async function importContentMacKey(
  bytes: Uint8Array,
  cryptoImplementation: Crypto
): Promise<CryptoKey> {
  const importBytes = Uint8Array.from(bytes);
  try {
    return await cryptoImplementation.subtle.importKey(
      "raw",
      importBytes,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"]
    );
  } finally {
    importBytes.fill(0);
  }
}

async function importEntry(
  entry: LocalKeyEntry,
  cryptoImplementation: Crypto
): Promise<ImportedLocalKey> {
  const bytes = decodeBase64Url(entry.keyMaterial, KEY_BYTES, KEY_BYTES);
  try {
    const key =
      entry.purpose === "object_wrap"
        ? await importKeyEncryptionKey(entry.keyId, bytes, cryptoImplementation)
        : await importContentMacKey(bytes, cryptoImplementation);
    const metadata: LocalKeyMetadata = Object.freeze({
      ownerId: entry.ownerId,
      keyClass: entry.keyClass,
      purpose: entry.purpose,
      keyId: entry.keyId,
      keyVersion: entry.keyVersion,
      status: entry.status
    });
    return Object.freeze({ entry: metadata, key });
  } catch {
    failConfiguration();
  } finally {
    bytes.fill(0);
  }
}

export type LocalEnvironmentKeyResolverOptions = Readonly<{
  crypto?: Crypto;
  environment?: Readonly<Record<string, string | undefined>>;
  workload: KeyWorkload;
}>;

export async function createLocalEnvironmentKeyResolver(
  options: LocalEnvironmentKeyResolverOptions
): Promise<OwnerBoundKeyResolver> {
  assertWorkload(options.workload);
  const environment = options.environment ?? process.env;
  assertLocalOnly(environment);
  const cryptoImplementation = runtimeCrypto(options.crypto);
  const entries = parseKeyRing(environment[LOCAL_KEY_RING_VARIABLE]);
  if (
    options.workload === "organization_worker" &&
    entries.some((entry) => entry.keyClass === "private_manual")
  ) {
    failConfiguration();
  }
  const imported = await Promise.all(
    entries.map((entry) => importEntry(entry, cryptoImplementation))
  );
  const byId = new Map(imported.map((item) => [selectorIdentity(item.entry), item]));
  const active = new Map(
    imported
      .filter((item) => item.entry.status === "active")
      .map((item) => [bindingIdentity(item.entry), item])
  );

  function getById(selector: KeySelector): ImportedLocalKey | null {
    assertWorkloadCanAccess(options.workload, selector.keyClass);
    return byId.get(selectorIdentity(selector)) ?? null;
  }

  function getActive(binding: KeyBinding): ImportedLocalKey {
    assertWorkloadCanAccess(options.workload, binding.keyClass);
    const item = active.get(bindingIdentity(binding));
    if (item === undefined) {
      keyManagementFailure(KeyManagementErrorCode.KEY_NOT_FOUND, "Active key is unavailable");
    }
    return item;
  }

  function bindingWithPurpose(
    value: Readonly<{ ownerId: string; keyClass: KeyClass }>,
    purpose: KeyPurpose
  ): KeyBinding {
    const selector = parseKeySelector({ ...value, purpose, keyId: "validation-only" });
    return Object.freeze({ ownerId: selector.ownerId, keyClass: selector.keyClass, purpose });
  }

  function selectorWithPurpose(
    value: Readonly<{ ownerId: string; keyClass: KeyClass; keyId: string }>,
    purpose: KeyPurpose
  ): KeySelector {
    return parseKeySelector({ ...value, purpose });
  }

  function objectResult(item: ImportedLocalKey): ManagedObjectWrappingKey {
    if (item.entry.purpose !== "object_wrap" || !("keyId" in item.key)) failConfiguration();
    return Object.freeze({ reference: reference(item.entry), key: item.key });
  }

  function macResult(item: ImportedLocalKey): ManagedContentMacKey {
    if (item.entry.purpose !== "content_mac" || "keyId" in item.key) {
      failConfiguration();
    }
    return Object.freeze({ reference: reference(item.entry), key: item.key });
  }

  return Object.freeze({
    activeContentMacKey(bindingValue): Promise<ManagedContentMacKey> {
      return Promise.resolve().then(() =>
        macResult(getActive(bindingWithPurpose(bindingValue, "content_mac")))
      );
    },
    activeObjectWrappingKey(bindingValue): Promise<ManagedObjectWrappingKey> {
      return Promise.resolve().then(() =>
        objectResult(getActive(bindingWithPurpose(bindingValue, "object_wrap")))
      );
    },
    contentKeyResolver(bindingValue) {
      const binding = bindingWithPurpose(bindingValue, "object_wrap");
      assertWorkloadCanAccess(options.workload, binding.keyClass);
      return (keyId: string): Promise<KeyEncryptionKey | null> => {
        return Promise.resolve().then(() => {
          const item = getById(parseKeySelector({ ...binding, keyId }));
          return item === null ? null : objectResult(item).key;
        });
      };
    },
    resolveContentMacKey(selectorValue): Promise<ManagedContentMacKey | null> {
      return Promise.resolve().then(() => {
        const item = getById(selectorWithPurpose(selectorValue, "content_mac"));
        return item === null ? null : macResult(item);
      });
    },
    resolveObjectWrappingKey(selectorValue): Promise<ManagedObjectWrappingKey | null> {
      return Promise.resolve().then(() => {
        const item = getById(selectorWithPurpose(selectorValue, "object_wrap"));
        return item === null ? null : objectResult(item);
      });
    }
  });
}

export const localEnvironmentKeyConfiguration = Object.freeze({
  keyRingVariable: LOCAL_KEY_RING_VARIABLE,
  modeVariable: LOCAL_MODE_VARIABLE
});
