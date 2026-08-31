import type { ObjectWrapReservationPort } from "@unfiled/encrypted-aggregate";
import {
  parseManagedKeyRecord,
  type KeyBinding,
  type KeyClass,
  type KeyPurpose,
  type KeySelector,
  type ManagedKeyRecordV1,
  type ManagedKeyStore
} from "@unfiled/key-management";

import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type ActiveKeyProjection = Readonly<{
  found: boolean;
  nextVersion: number;
  record?: ManagedKeyRecordV1;
}>;

type ReservationProjection = Readonly<{
  reservationId: string;
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "object_wrap";
  keyVersion: number;
  operationCount: number;
  consumed: boolean;
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

function invalidProjection(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function parseActiveKeyProjection(value: unknown): ActiveKeyProjection {
  if (!isRecord(value) || typeof value.found !== "boolean" || !validVersion(value.nextVersion)) {
    return invalidProjection();
  }
  if (!value.found) {
    if (!hasExactKeys(value, ["found", "nextVersion"])) return invalidProjection();
    return Object.freeze({ found: false, nextVersion: value.nextVersion });
  }
  if (!hasExactKeys(value, ["found", "nextVersion", "record"])) return invalidProjection();
  let record: ManagedKeyRecordV1;
  try {
    record = parseManagedKeyRecord(value.record);
  } catch {
    return invalidProjection();
  }
  return Object.freeze({ found: true, nextVersion: value.nextVersion, record });
}

function parseStoredKey(value: unknown): ManagedKeyRecordV1 {
  try {
    return parseManagedKeyRecord(value);
  } catch {
    return invalidProjection();
  }
}

function parseReservation(value: unknown, binding: KeyBinding): ReservationProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "reservationId",
      "keyId",
      "keyClass",
      "keyPurpose",
      "keyVersion",
      "operationCount",
      "consumed",
      "replayed"
    ]) ||
    typeof value.reservationId !== "string" ||
    !UUID_PATTERN.test(value.reservationId) ||
    typeof value.keyId !== "string" ||
    !IDENTIFIER_PATTERN.test(value.keyId) ||
    value.keyClass !== binding.keyClass ||
    value.keyPurpose !== "object_wrap" ||
    !validVersion(value.keyVersion) ||
    value.operationCount !== 1 ||
    typeof value.consumed !== "boolean" ||
    typeof value.replayed !== "boolean" ||
    value.consumed
  ) {
    return invalidProjection();
  }
  return Object.freeze({
    reservationId: value.reservationId,
    keyId: value.keyId,
    keyClass: binding.keyClass,
    keyPurpose: value.keyPurpose,
    keyVersion: value.keyVersion,
    operationCount: value.operationCount,
    consumed: value.consumed,
    replayed: value.replayed
  });
}

function assertMatchingRecord(
  record: ManagedKeyRecordV1,
  expected: KeyBinding | KeySelector
): void {
  if (
    record.ownerId !== expected.ownerId ||
    record.keyClass !== expected.keyClass ||
    record.purpose !== expected.purpose ||
    ("keyId" in expected && record.keyId !== expected.keyId)
  ) {
    invalidProjection();
  }
}

export function createManagedKeyRpcStore(client: ServiceRpcClient): ManagedKeyStore {
  return Object.freeze({
    async findActive(binding: KeyBinding): Promise<unknown> {
      const projection = parseActiveKeyProjection(
        await client.rpc("get_active_user_content_key", {
          p_owner_id: binding.ownerId,
          p_key_class: binding.keyClass,
          p_key_purpose: binding.purpose
        })
      );
      if (!projection.found || projection.record === undefined) return null;
      assertMatchingRecord(projection.record, binding);
      if (projection.record.status !== "active") return invalidProjection();
      return projection.record;
    },

    async findById(selector: KeySelector): Promise<unknown> {
      const record = parseStoredKey(
        await client.rpc("get_user_content_key_by_id", {
          p_owner_id: selector.ownerId,
          p_key_id: selector.keyId,
          p_key_class: selector.keyClass,
          p_key_purpose: selector.purpose
        })
      );
      assertMatchingRecord(record, selector);
      return record;
    }
  });
}

export type ObjectWrapReservationPortOptions = Readonly<{
  createReservationId?: () => string;
}>;

export function createObjectWrapReservationPort(
  client: ServiceRpcClient,
  store: ManagedKeyStore,
  options: ObjectWrapReservationPortOptions = {}
): ObjectWrapReservationPort {
  const createReservationId = options.createReservationId ?? (() => crypto.randomUUID());
  return Object.freeze({
    async reserveObjectWrappingKey(binding) {
      const keyValue = await store.findActive({
        ownerId: binding.ownerId,
        keyClass: binding.keyClass,
        purpose: "object_wrap"
      });
      if (keyValue === null) {
        throw new ServiceRpcError(ServiceRpcErrorCode.KEY_UNAVAILABLE);
      }
      const key = parseStoredKey(keyValue);
      assertMatchingRecord(key, {
        ownerId: binding.ownerId,
        keyClass: binding.keyClass,
        purpose: "object_wrap"
      });
      if (key.status !== "active") invalidProjection();

      const reservationId = createReservationId();
      if (!UUID_PATTERN.test(reservationId)) invalidProjection();
      const reservation = parseReservation(
        await client.rpc("reserve_content_key_operations", {
          p_owner_id: binding.ownerId,
          p_reservation_id: reservationId,
          p_key_class: binding.keyClass,
          p_key_id: key.keyId,
          p_key_version: key.keyVersion,
          p_operation_count: 1
        }),
        { ownerId: binding.ownerId, keyClass: binding.keyClass, purpose: "object_wrap" }
      );
      if (reservation.keyId !== key.keyId || reservation.keyVersion !== key.keyVersion) {
        invalidProjection();
      }
      return Object.freeze({
        reservationId: reservation.reservationId,
        reference: Object.freeze({
          ownerId: binding.ownerId,
          keyClass: binding.keyClass,
          purpose: "object_wrap" as const,
          keyId: reservation.keyId,
          keyVersion: reservation.keyVersion
        })
      });
    }
  });
}

export const managedKeyRpcFunctions = Object.freeze([
  "get_active_user_content_key",
  "get_user_content_key_by_id",
  "reserve_content_key_operations"
] as const);

export type ManagedKeyRpcFunction = (typeof managedKeyRpcFunctions)[number];

export function keyBinding(ownerId: string, keyClass: KeyClass, purpose: KeyPurpose): KeyBinding {
  return Object.freeze({ ownerId, keyClass, purpose });
}
