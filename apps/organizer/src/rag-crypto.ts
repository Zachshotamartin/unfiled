import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  createEncryptedAggregateService,
  type EncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import {
  createManagedKeyResolver,
  parseManagedKeyRecord,
  type ManagedKeyRecordV1,
  type ManagedKeyStore
} from "@unfiled/key-management";
import {
  createPrivateRagPayloadCodec,
  serializePrivateRagIndexDocument,
  type PrivateRagPayloadOpener
} from "@unfiled/search";

import type { OrganizerRagRecord } from "./drain.js";
import { OrganizerUnavailableError } from "./errors.js";
import { custodianForOrganizerAuthority, type OrganizerKeyAuthority } from "./key-management.js";

const INDEX_ID = /^irw_[0-9A-HJKMNP-TV-Z]{26}$/u;

function unavailable(): never {
  throw new OrganizerUnavailableError();
}

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) unavailable();
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const row = object(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    unavailable();
  }
  return row;
}

function matchingStore(key: ManagedKeyRecordV1): ManagedKeyStore {
  return Object.freeze({
    findActive(): Promise<null> {
      return Promise.resolve(null);
    },
    findById(selector): Promise<ManagedKeyRecordV1 | null> {
      return Promise.resolve(
        selector.ownerId === key.ownerId &&
          selector.keyClass === key.keyClass &&
          selector.purpose === key.purpose &&
          selector.keyId === key.keyId
          ? key
          : null
      );
    }
  });
}

function encryptedRecord(
  ownerId: string,
  item: Readonly<{
    indexId: string;
    indexedRevision: number;
    record: OrganizerRagRecord;
  }>
): Readonly<{
  key: ManagedKeyRecordV1;
  record: EncryptedAggregateRecord<"note_rag_index">;
}> {
  if (
    !INDEX_ID.test(item.indexId) ||
    item.record.resourceId !== item.indexId ||
    item.record.recordVersion !== item.indexedRevision
  ) {
    unavailable();
  }
  const cipher = exact(item.record.cipher, [
    "envelope",
    "keyClass",
    "keyId",
    "keyPurpose",
    "keyVersion"
  ]);
  let key: ManagedKeyRecordV1;
  let envelope: ReturnType<typeof parseContentEnvelope>;
  try {
    key = parseManagedKeyRecord(item.record.key);
    envelope = parseContentEnvelope(serializeContentEnvelope(cipher.envelope));
  } catch {
    return unavailable();
  }
  if (
    cipher.keyClass !== "ai_assisted" ||
    cipher.keyPurpose !== "object_wrap" ||
    cipher.keyId !== key.keyId ||
    cipher.keyVersion !== key.keyVersion ||
    key.ownerId !== ownerId ||
    key.keyClass !== "ai_assisted" ||
    key.purpose !== "object_wrap" ||
    (key.status !== "active" && key.status !== "retired") ||
    envelope.keyId !== key.keyId ||
    envelope.context.tenantId !== ownerId ||
    envelope.context.resourceId !== item.indexId ||
    envelope.context.recordVersion !== item.indexedRevision ||
    envelope.context.kind !== "note_rag_index"
  ) {
    unavailable();
  }
  return Object.freeze({
    key,
    record: Object.freeze({
      envelope,
      keyClass: "ai_assisted" as const,
      keyId: key.keyId,
      keyPurpose: "object_wrap" as const,
      keyVersion: key.keyVersion,
      kind: "note_rag_index" as const,
      ownerId,
      recordVersion: item.indexedRevision,
      resourceId: item.indexId
    })
  });
}

export function createOrganizerRagPayloadOpener(
  authority: OrganizerKeyAuthority
): PrivateRagPayloadOpener<OrganizerRagRecord> {
  const custodian = custodianForOrganizerAuthority(authority);
  return Object.freeze({
    async openPayload(input) {
      assertActive(input.signal);
      try {
        const bound = encryptedRecord(input.ownerId, input.item);
        const resolver = createManagedKeyResolver({
          custodian,
          store: matchingStore(bound.key),
          workload: "organization_worker"
        });
        const aggregate = createEncryptedAggregateService({
          keyResolver: resolver,
          objectWrapReservations: {
            reserveObjectWrappingKey(): Promise<never> {
              return Promise.reject(new OrganizerUnavailableError());
            }
          }
        });
        const access = authorizeAggregateOwner({
          authenticatedOwnerId: input.ownerId,
          resourceOwnerId: input.ownerId
        });
        const expected = {
          dimensions: input.snapshot.dimensions,
          indexedRevision: input.item.indexedRevision,
          indexId: input.item.indexId as `irw_${string}`,
          modelId: input.snapshot.modelId,
          noteId: input.item.noteId
        } as const;
        const value = await aggregate.openNoteRagIndex(access, bound.record, {
          indexId: expected.indexId,
          indexedRevision: expected.indexedRevision,
          payloadCodec: createPrivateRagPayloadCodec(expected)
        });
        assertActive(input.signal);
        const plaintext = serializePrivateRagIndexDocument(value, expected);
        const plaintextBytes = plaintext.byteLength;
        plaintext.fill(0);
        return Object.freeze({ plaintextBytes, value });
      } catch {
        return unavailable();
      }
    }
  });
}
