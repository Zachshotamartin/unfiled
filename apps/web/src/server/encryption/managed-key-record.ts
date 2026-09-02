import {
  parseManagedKeyRecordV1,
  parseManagedKeyRecordV2,
  type ManagedKeyRecord
} from "@unfiled/key-management";

export type ManagedKeyRecordSchemaVersion = 1 | 2;

export function parseManagedKeyRecordForSchema(
  value: unknown,
  schemaVersion: ManagedKeyRecordSchemaVersion
): ManagedKeyRecord {
  return schemaVersion === 1 ? parseManagedKeyRecordV1(value) : parseManagedKeyRecordV2(value);
}
