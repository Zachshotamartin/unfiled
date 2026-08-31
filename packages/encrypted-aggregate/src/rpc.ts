import type {
  AggregateContentKind,
  EncryptedFieldRpcValue,
  EncryptedIdempotencyRpcValue,
  KeyedMacRecord,
  KeyedMacRpcValue,
  SealedEncryptedAggregateRecord,
  SealedEncryptedIdempotencyRecord
} from "./types.js";

export function encryptedFieldForRpc<Kind extends AggregateContentKind>(
  record: SealedEncryptedAggregateRecord<Kind>
): EncryptedFieldRpcValue<Kind> {
  return Object.freeze({
    envelope: record.envelope,
    keyId: record.keyId,
    keyClass: record.keyClass,
    keyPurpose: record.keyPurpose,
    keyVersion: record.keyVersion,
    reservationId: record.reservationId
  });
}

export function keyedMacForRpc(record: KeyedMacRecord): KeyedMacRpcValue {
  return Object.freeze({
    mac: record.value,
    keyId: record.keyId,
    keyClass: record.keyClass,
    keyPurpose: record.keyPurpose,
    keyVersion: record.keyVersion
  });
}

export function encryptedIdempotencyForRpc(
  record: SealedEncryptedIdempotencyRecord
): EncryptedIdempotencyRpcValue {
  return Object.freeze({
    idempotencyKey: record.idempotencyKey,
    keyClass: record.keyClass,
    requestMac: keyedMacForRpc(record.requestMac),
    response: encryptedFieldForRpc(record.response)
  });
}
