import {
  KEY_CLASSES,
  KEY_PURPOSES,
  type IntermediateKeyCustodian,
  type KeyBinding,
  type KeyClass,
  type KeyPurpose,
  type ManagedKeyRecord,
  type ManagedKeyStore
} from "@unfiled/key-management";

import {
  parseManagedKeyRecordForSchema,
  type ManagedKeyRecordSchemaVersion
} from "./managed-key-record";
import type { ServiceRpcClient } from "./service-rpc-client";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_BOOTSTRAP_ATTEMPTS = 3;
const INTERMEDIATE_KEY_BYTES = 32;

type KeyStatusReference = Readonly<{ keyId: string; keyVersion: number }>;
type KeyStatusProjection = Readonly<{
  keyClass: KeyClass;
  keyPurpose: KeyPurpose;
  active: KeyStatusReference | null;
  pending: KeyStatusReference | null;
  nextVersion: number;
}>;

type KeyMutationProjection = Readonly<{
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: KeyPurpose;
  keyVersion: number;
  state: "active" | "pending";
  replayed: boolean;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function failClosed(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function parseReference(value: unknown): KeyStatusReference | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["keyId", "keyVersion"]) ||
    typeof value.keyId !== "string" ||
    !IDENTIFIER_PATTERN.test(value.keyId) ||
    !validVersion(value.keyVersion)
  ) {
    return failClosed();
  }
  return Object.freeze({ keyId: value.keyId, keyVersion: value.keyVersion });
}

function parseStatus(value: unknown, expected: KeyBinding): KeyStatusProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["keyClass", "keyPurpose", "active", "pending", "nextVersion"]) ||
    value.keyClass !== expected.keyClass ||
    value.keyPurpose !== expected.purpose ||
    !validVersion(value.nextVersion)
  ) {
    return failClosed();
  }
  const active = parseReference(value.active);
  const pending = parseReference(value.pending);
  if (
    active !== null &&
    pending !== null &&
    (active.keyId === pending.keyId || active.keyVersion === pending.keyVersion)
  ) {
    return failClosed();
  }
  const maximumVersion = Math.max(active?.keyVersion ?? 0, pending?.keyVersion ?? 0);
  if (value.nextVersion <= maximumVersion) return failClosed();
  return Object.freeze({
    keyClass: expected.keyClass,
    keyPurpose: expected.purpose,
    active,
    pending,
    nextVersion: value.nextVersion
  });
}

function parseMutation(
  value: unknown,
  expected: KeyBinding & Readonly<{ keyId: string; keyVersion: number }>,
  state: "active" | "pending"
): KeyMutationProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["keyId", "keyClass", "keyPurpose", "keyVersion", "state", "replayed"]) ||
    value.keyId !== expected.keyId ||
    value.keyClass !== expected.keyClass ||
    value.keyPurpose !== expected.purpose ||
    value.keyVersion !== expected.keyVersion ||
    value.state !== state ||
    typeof value.replayed !== "boolean"
  ) {
    return failClosed();
  }
  return Object.freeze({
    keyId: expected.keyId,
    keyClass: expected.keyClass,
    keyPurpose: expected.purpose,
    keyVersion: expected.keyVersion,
    state,
    replayed: value.replayed
  });
}

function assertStoredRecord<Record extends ManagedKeyRecord>(
  value: unknown,
  expected: KeyBinding & Readonly<{ keyId: string; keyVersion: number }>,
  schemaVersion: Record["schemaVersion"]
): Record {
  let record: ManagedKeyRecord;
  try {
    record = parseManagedKeyRecordForSchema(value, schemaVersion);
  } catch {
    return failClosed();
  }
  if (
    record.ownerId !== expected.ownerId ||
    record.keyClass !== expected.keyClass ||
    record.purpose !== expected.purpose ||
    record.keyId !== expected.keyId ||
    record.keyVersion !== expected.keyVersion
  ) {
    return failClosed();
  }
  return record as Record;
}

function postgresByteaFromBase64Url(value: string): string {
  const ciphertext = Buffer.from(value, "base64url");
  try {
    if (ciphertext.length < 1 || ciphertext.length > 8192) return failClosed();
    return `\\x${ciphertext.toString("hex")}`;
  } finally {
    ciphertext.fill(0);
  }
}

async function statusFor(
  client: ServiceRpcClient,
  binding: KeyBinding
): Promise<KeyStatusProjection> {
  return parseStatus(
    await client.rpc("get_user_content_key_status", {
      p_owner_id: binding.ownerId,
      p_key_class: binding.keyClass,
      p_key_purpose: binding.purpose
    }),
    binding
  );
}

async function provePendingKey<Record extends ManagedKeyRecord>(
  custodian: IntermediateKeyCustodian<Record>,
  store: ManagedKeyStore,
  binding: KeyBinding,
  pending: KeyStatusReference,
  schemaVersion: Record["schemaVersion"],
  signal?: AbortSignal
): Promise<void> {
  const stored = assertStoredRecord<Record>(
    await store.findById({ ...binding, keyId: pending.keyId }),
    {
      ...binding,
      keyId: pending.keyId,
      keyVersion: pending.keyVersion
    },
    schemaVersion
  );
  if (stored.status !== "pending") failClosed();
  await custodian.withUnwrappedIntermediateKey(
    stored,
    (keyBytes, record): Promise<void> => {
      if (
        keyBytes.byteLength !== INTERMEDIATE_KEY_BYTES ||
        record.keyId !== pending.keyId ||
        record.keyVersion !== pending.keyVersion
      ) {
        failClosed();
      }
      return Promise.resolve();
    },
    signal === undefined ? undefined : { signal }
  );
}

async function activate(
  client: ServiceRpcClient,
  binding: KeyBinding,
  pending: KeyStatusReference
): Promise<void> {
  parseMutation(
    await client.rpc("activate_user_content_key", {
      p_owner_id: binding.ownerId,
      p_key_id: pending.keyId
    }),
    { ...binding, keyId: pending.keyId, keyVersion: pending.keyVersion },
    "active"
  );
}

async function createAndActivate<Record extends ManagedKeyRecord>(
  client: ServiceRpcClient,
  custodian: IntermediateKeyCustodian<Record>,
  binding: KeyBinding,
  nextVersion: number,
  keyId: string,
  createdAt: string,
  schemaVersion: Record["schemaVersion"],
  signal?: AbortSignal
): Promise<void> {
  await custodian.withGeneratedIntermediateKey(
    {
      ...binding,
      keyId,
      keyVersion: nextVersion,
      createdAt,
      predecessorKeyId: null
    },
    async (keyBytes, record): Promise<void> => {
      if (keyBytes.byteLength !== INTERMEDIATE_KEY_BYTES) failClosed();
      const generated = assertStoredRecord<Record>(
        record,
        {
          ...binding,
          keyId,
          keyVersion: nextVersion
        },
        schemaVersion
      );
      if (generated.status !== "pending") failClosed();
      parseMutation(
        await (generated.schemaVersion === 1
          ? client.rpc("register_user_content_key", {
              p_owner_id: binding.ownerId,
              p_key_id: generated.keyId,
              p_key_class: generated.keyClass,
              p_key_purpose: generated.purpose,
              p_key_version: generated.keyVersion,
              p_kms_key_id: generated.rootKeyArn,
              p_wrapped_intermediate_key: postgresByteaFromBase64Url(generated.encryptedKeyMaterial)
            })
          : client.rpc("register_user_content_key_v2", {
              p_owner_id: binding.ownerId,
              p_key_id: generated.keyId,
              p_key_class: generated.keyClass,
              p_key_purpose: generated.purpose,
              p_key_version: generated.keyVersion,
              p_root_key_id: generated.rootKeyId,
              p_wrap_algorithm: generated.wrapAlgorithm,
              p_wrapped_intermediate_key: postgresByteaFromBase64Url(generated.encryptedKeyMaterial)
            })),
        { ...binding, keyId, keyVersion: nextVersion },
        "pending"
      );
      await activate(client, binding, { keyId, keyVersion: nextVersion });
    },
    signal === undefined ? undefined : { signal }
  );
}

async function ensureBinding<Record extends ManagedKeyRecord>(
  client: ServiceRpcClient,
  custodian: IntermediateKeyCustodian<Record>,
  store: ManagedKeyStore,
  binding: KeyBinding,
  createKeyId: () => string,
  now: () => string,
  schemaVersion: Record["schemaVersion"],
  signal?: AbortSignal
): Promise<void> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) failClosed();
    const status = await statusFor(client, binding);
    if (status.active !== null) return;
    try {
      if (status.pending !== null) {
        await provePendingKey(custodian, store, binding, status.pending, schemaVersion, signal);
        await activate(client, binding, status.pending);
      } else {
        const keyId = createKeyId();
        if (!IDENTIFIER_PATTERN.test(keyId)) failClosed();
        await createAndActivate(
          client,
          custodian,
          binding,
          status.nextVersion,
          keyId,
          now(),
          schemaVersion,
          signal
        );
      }
      const completed = await statusFor(client, binding);
      if (completed.active !== null && completed.pending === null) return;
      lastFailure = new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
    } catch (error: unknown) {
      lastFailure = error;
      const raced = await statusFor(client, binding).catch(() => null);
      if (raced?.active !== null && raced?.active !== undefined) return;
    }
  }
  if (lastFailure instanceof Error) throw lastFailure;
  failClosed();
}

export type ManagedKeyBootstrapOptions = Readonly<{
  createKeyId?: () => string;
  now?: () => string;
  schemaVersion?: ManagedKeyRecordSchemaVersion;
  signal?: AbortSignal;
}>;

/**
 * Ensures one usable active intermediate key exists in each owner/class/purpose
 * domain. Every pending key is unwrapped under its exact KMS context before it
 * may be activated; concurrent registration races are reconciled by rereading
 * authoritative database state.
 */
export async function ensureOwnerContentKeys<Record extends ManagedKeyRecord>(
  client: ServiceRpcClient,
  custodian: IntermediateKeyCustodian<Record>,
  store: ManagedKeyStore,
  ownerId: string,
  options: ManagedKeyBootstrapOptions = {}
): Promise<void> {
  const createKeyId =
    options.createKeyId ?? (() => `key_${crypto.randomUUID().replaceAll("-", "")}`);
  const now = options.now ?? (() => new Date().toISOString());
  const schemaVersion = (options.schemaVersion ?? 1) as Record["schemaVersion"];
  for (const keyClass of KEY_CLASSES) {
    for (const purpose of KEY_PURPOSES) {
      await ensureBinding(
        client,
        custodian,
        store,
        { ownerId, keyClass, purpose },
        createKeyId,
        now,
        schemaVersion,
        options.signal
      );
    }
  }
}

export const managedKeyBootstrapRpcFunctions = Object.freeze([
  "activate_user_content_key",
  "get_user_content_key_status",
  "register_user_content_key",
  "register_user_content_key_v2"
] as const);
