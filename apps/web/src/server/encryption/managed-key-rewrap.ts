import { parseManagedKeyRecordV2, type ManagedKeyRecordV2 } from "@unfiled/key-management";

import type { ServiceRpcClient } from "./service-rpc-client";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

type RewrapProjection = Readonly<{
  keyId: string;
  replayed: boolean;
  rewrapped: true;
  rootRewrapCount: number;
  state: ManagedKeyRecordV2["status"];
}>;

function failClosed(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseProjection(
  value: unknown,
  expected: Readonly<{
    keyId: string;
    rootRewrapCount: number;
    state: ManagedKeyRecordV2["status"];
  }>
): RewrapProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["keyId", "state", "rootRewrapCount", "rewrapped", "replayed"]) ||
    value.keyId !== expected.keyId ||
    value.state !== expected.state ||
    value.rootRewrapCount !== expected.rootRewrapCount ||
    value.rewrapped !== true ||
    typeof value.replayed !== "boolean"
  ) {
    return failClosed();
  }
  return Object.freeze({
    keyId: expected.keyId,
    state: expected.state,
    rootRewrapCount: expected.rootRewrapCount,
    rewrapped: true,
    replayed: value.replayed
  });
}

function postgresByteaFromBase64Url(value: string): string {
  const ciphertext = Buffer.from(value, "base64url");
  try {
    if (ciphertext.length !== 65) return failClosed();
    return `\\x${ciphertext.toString("hex")}`;
  } finally {
    ciphertext.fill(0);
  }
}

function parseRecord(value: unknown): ManagedKeyRecordV2 {
  try {
    return parseManagedKeyRecordV2(value);
  } catch {
    return failClosed();
  }
}

function assertRewrapTransition(previous: ManagedKeyRecordV2, next: ManagedKeyRecordV2): void {
  if (
    previous.ownerId !== next.ownerId ||
    previous.keyId !== next.keyId ||
    previous.keyClass !== next.keyClass ||
    previous.purpose !== next.purpose ||
    previous.keyVersion !== next.keyVersion ||
    previous.status !== next.status ||
    previous.createdAt !== next.createdAt ||
    previous.activatedAt !== next.activatedAt ||
    previous.retiredAt !== next.retiredAt ||
    previous.revokedAt !== next.revokedAt ||
    previous.wrapOperations !== next.wrapOperations ||
    previous.wrapOperationLimit !== next.wrapOperationLimit ||
    previous.rotation.predecessorKeyId !== next.rotation.predecessorKeyId ||
    previous.rootKeyId === next.rootKeyId ||
    previous.encryptedKeyMaterial === next.encryptedKeyMaterial ||
    next.rotation.previousRootKeyId !== previous.rootKeyId ||
    next.rotation.rootRewrapCount !== previous.rotation.rootRewrapCount + 1 ||
    next.rotation.lastRootRewrappedAt === null
  ) {
    failClosed();
  }
}

/**
 * Persists one already-encrypted V2 root rewrap with the database's exact
 * compare-and-swap contract. Neither root material nor plaintext intermediate
 * key bytes cross this adapter.
 */
export async function persistVercelSensitiveEnvironmentKeyRewrap(
  client: ServiceRpcClient,
  previousValue: unknown,
  nextValue: unknown
): Promise<RewrapProjection> {
  const previous = parseRecord(previousValue);
  const next = parseRecord(nextValue);
  assertRewrapTransition(previous, next);
  return parseProjection(
    await client.rpc("rewrap_user_content_key_v2", {
      p_owner_id: previous.ownerId,
      p_key_id: previous.keyId,
      p_expected_root_key_id: previous.rootKeyId,
      p_expected_root_rewrap_count: previous.rotation.rootRewrapCount,
      p_new_root_key_id: next.rootKeyId,
      p_new_wrapped_intermediate_key: postgresByteaFromBase64Url(next.encryptedKeyMaterial)
    }),
    {
      keyId: previous.keyId,
      state: previous.status,
      rootRewrapCount: next.rotation.rootRewrapCount
    }
  );
}

export const managedKeyRewrapRpcFunctions = Object.freeze(["rewrap_user_content_key_v2"] as const);
