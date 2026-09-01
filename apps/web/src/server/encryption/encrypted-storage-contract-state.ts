import type { ServiceRpcClient } from "./service-rpc-client";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

export const encryptedStorageContractStateRpcFunctions = Object.freeze([
  "get_encrypted_storage_contract_state"
] as const);

export type EncryptedStorageContractState = Readonly<{
  schemaVersion: 1;
  state: "expand_compatible" | "contracted";
  appliedAt: string | null;
}>;

function failClosed(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

export function parseEncryptedStorageContractState(value: unknown): EncryptedStorageContractState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return failClosed();
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "appliedAt" ||
    keys[1] !== "schemaVersion" ||
    keys[2] !== "state" ||
    record.schemaVersion !== 1 ||
    (record.state !== "expand_compatible" && record.state !== "contracted") ||
    (record.appliedAt !== null &&
      (typeof record.appliedAt !== "string" || !Number.isFinite(Date.parse(record.appliedAt)))) ||
    (record.state === "expand_compatible") !== (record.appliedAt === null)
  ) {
    return failClosed();
  }
  return Object.freeze({
    schemaVersion: 1,
    state: record.state,
    appliedAt: record.appliedAt
  });
}

export async function getEncryptedStorageContractState(
  client: ServiceRpcClient
): Promise<EncryptedStorageContractState> {
  return parseEncryptedStorageContractState(
    await client.rpc("get_encrypted_storage_contract_state", {})
  );
}
