import {
  KEY_CLASSES,
  KEY_PURPOSES,
  parseManagedKeyRecord,
  type IntermediateKeyCustodian,
  type KeyBinding,
  type KeyClass,
  type KeyPurpose,
  type ManagedKeyRecordV1,
  type ManagedKeyStore
} from "@unfiled/key-management";

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

function assertStoredRecord(
  value: unknown,
  expected: KeyBinding & Readonly<{ keyId: string; keyVersion: number }>
): ManagedKeyRecordV1 {
  let record: ManagedKeyRecordV1;
  try {
    record = parseManagedKeyRecord(value);
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
  return record;
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

async function provePendingKey(
  custodian: IntermediateKeyCustodian,
  store: ManagedKeyStore,
  binding: KeyBinding,
  pending: KeyStatusReference,
  signal?: AbortSignal
): Promise<void> {
  const stored = assertStoredRecord(await store.findById({ ...binding, keyId: pending.keyId }), {
    ...binding,
    keyId: pending.keyId,
    keyVersion: pending.keyVersion
  });
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

async function createAndActivate(
  client: ServiceRpcClient,
  custodian: IntermediateKeyCustodian,
  binding: KeyBinding,
  nextVersion: number,
  keyId: string,
  createdAt: string,
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
      const generated = assertStoredRecord(record, {
        ...binding,
        keyId,
        keyVersion: nextVersion
      });
      if (generated.status !== "pending") failClosed();
      parseMutation(
        await client.rpc("register_user_content_key", {
          p_owner_id: binding.ownerId,
          p_key_id: generated.keyId,
          p_key_class: generated.keyClass,
          p_key_purpose: generated.purpose,
          p_key_version: generated.keyVersion,
          p_kms_key_id: generated.rootKeyArn,
          p_wrapped_intermediate_key: postgresByteaFromBase64Url(generated.encryptedKeyMaterial)
        }),
        { ...binding, keyId, keyVersion: nextVersion },
        "pending"
      );
      await activate(client, binding, { keyId, keyVersion: nextVersion });
    },
    signal === undefined ? undefined : { signal }
  );
}

async function ensureBinding(
  client: ServiceRpcClient,
  custodian: IntermediateKeyCustodian,
  store: ManagedKeyStore,
  binding: KeyBinding,
  createKeyId: () => string,
  now: () => string,
  signal?: AbortSignal
): Promise<void> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) failClosed();
    const status = await statusFor(client, binding);
    if (status.active !== null) return;
    try {
      if (status.pending !== null) {
        await provePendingKey(custodian, store, binding, status.pending, signal);
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
  signal?: AbortSignal;
}>;

/**
 * Ensures one usable active intermediate key exists in each owner/class/purpose
 * domain. Every pending key is unwrapped under its exact KMS context before it
 * may be activated; concurrent registration races are reconciled by rereading
 * authoritative database state.
 */
export async function ensureOwnerContentKeys(
  client: ServiceRpcClient,
  custodian: IntermediateKeyCustodian,
  store: ManagedKeyStore,
  ownerId: string,
  options: ManagedKeyBootstrapOptions = {}
): Promise<void> {
  const createKeyId =
    options.createKeyId ?? (() => `key_${crypto.randomUUID().replaceAll("-", "")}`);
  const now = options.now ?? (() => new Date().toISOString());
  for (const keyClass of KEY_CLASSES) {
    for (const purpose of KEY_PURPOSES) {
      await ensureBinding(
        client,
        custodian,
        store,
        { ownerId, keyClass, purpose },
        createKeyId,
        now,
        options.signal
      );
    }
  }
}

export const managedKeyBootstrapRpcFunctions = Object.freeze([
  "activate_user_content_key",
  "get_user_content_key_status",
  "register_user_content_key"
] as const);
