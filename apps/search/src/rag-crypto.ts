import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import { RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS } from "@unfiled/contracts";
import {
  authorizeAggregateOwner,
  createEncryptedAggregateService,
  type EncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import {
  createManagedKeyResolver,
  parseManagedKeyRecord,
  type IntermediateKeyCustodian,
  type ManagedKeyRecordV1,
  type ManagedKeyStore,
  type ManagedObjectWrappingKey,
  type OwnerBoundKeyResolver
} from "@unfiled/key-management";
import {
  createPrivateRagPayloadCodec,
  serializePrivateRagIndexDocument,
  type PrivateRagPayloadOpener,
  type PrivateRagPayloadValueV1
} from "@unfiled/search";

import type { SearchRagRecord } from "./database.js";
import { unavailable } from "./errors.js";
import { custodianForSearchAuthority, type SearchKeyAuthority } from "./key-management.js";

const INDEX_ID_PATTERN = /^irw_[0-9A-HJKMNP-TV-Z]{26}$/u;
const MIN_ENCRYPTED_PAYLOAD_BYTES = 16;
const MAX_ENCRYPTED_PAYLOAD_BYTES = 262_160;

export type SearchRagPayloadOpener = PrivateRagPayloadOpener<SearchRagRecord> &
  Readonly<{
    release(): void;
  }>;

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

function sameManagedKeyRecord(left: ManagedKeyRecordV1, right: ManagedKeyRecordV1): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.keyClass === right.keyClass &&
    left.purpose === right.purpose &&
    left.keyId === right.keyId &&
    left.keyVersion === right.keyVersion &&
    left.status === right.status &&
    left.encryptedKeyMaterial === right.encryptedKeyMaterial &&
    left.rootKeyArn === right.rootKeyArn &&
    left.createdAt === right.createdAt &&
    left.activatedAt === right.activatedAt &&
    left.retiredAt === right.retiredAt &&
    left.revokedAt === right.revokedAt &&
    left.wrapOperations === right.wrapOperations &&
    left.wrapOperationLimit === right.wrapOperationLimit &&
    left.rotation.predecessorKeyId === right.rotation.predecessorKeyId &&
    left.rotation.previousRootKeyArn === right.rotation.previousRootKeyArn &&
    left.rotation.rootRewrapCount === right.rotation.rootRewrapCount &&
    left.rotation.lastRootRewrappedAt === right.rotation.lastRootRewrappedAt
  );
}

function resolverForKey(key: ManagedObjectWrappingKey): OwnerBoundKeyResolver {
  const unavailableKey = (): Promise<never> =>
    Promise.reject(new Error("Search decryption cannot access this key purpose."));
  return Object.freeze({
    activeContentMacKey: unavailableKey,
    activeObjectWrappingKey: unavailableKey,
    contentKeyResolver() {
      return () => Promise.resolve(null);
    },
    resolveContentMacKey(): Promise<null> {
      return Promise.resolve(null);
    },
    resolveObjectWrappingKey(selector): Promise<ManagedObjectWrappingKey | null> {
      return Promise.resolve(
        selector.ownerId === key.reference.ownerId &&
          selector.keyClass === key.reference.keyClass &&
          selector.keyId === key.reference.keyId
          ? key
          : null
      );
    }
  });
}

function encryptedRecord(
  ownerId: string,
  item: Readonly<{
    ciphertextBytes: number;
    indexId: string;
    indexedRevision: number;
    record: SearchRagRecord;
  }>
): Readonly<{
  key: ManagedKeyRecordV1;
  record: EncryptedAggregateRecord<"note_rag_index">;
}> {
  const projected = exact(item.record, [
    "cipher",
    "encryptedByteLength",
    "key",
    "metadata",
    "recordVersion",
    "resourceId"
  ]);
  if (
    !INDEX_ID_PATTERN.test(item.indexId) ||
    projected.resourceId !== item.indexId ||
    projected.recordVersion !== item.indexedRevision ||
    projected.encryptedByteLength !== item.ciphertextBytes ||
    !Number.isSafeInteger(projected.encryptedByteLength) ||
    projected.encryptedByteLength < MIN_ENCRYPTED_PAYLOAD_BYTES ||
    projected.encryptedByteLength > MAX_ENCRYPTED_PAYLOAD_BYTES
  ) {
    unavailable();
  }
  const cipher = exact(projected.cipher, [
    "envelope",
    "keyClass",
    "keyId",
    "keyPurpose",
    "keyVersion"
  ]);
  let key: ManagedKeyRecordV1;
  let envelope: ReturnType<typeof parseContentEnvelope>;
  try {
    key = parseManagedKeyRecord(projected.key);
    envelope = parseContentEnvelope(serializeContentEnvelope(cipher.envelope));
  } catch {
    unavailable();
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

function metadataMatchesPayload(
  record: SearchRagRecord,
  payload: PrivateRagPayloadValueV1
): boolean {
  const metadata = exact(record.metadata, [
    "archivedAt",
    "pinnedAt",
    "spaceId",
    "tagIds",
    "type",
    "updatedAt"
  ]);
  return (
    metadata.type === payload.noteType &&
    metadata.spaceId === payload.spaceId &&
    metadata.updatedAt === payload.updatedAt &&
    (metadata.pinnedAt !== null) === payload.pinned
  );
}

/**
 * Opens only owner-bound AI-assisted note-index envelopes through the active
 * request authority. Every projection that is also authenticated in the
 * encrypted payload must agree before a result can be ranked or returned.
 */
export function createSearchRagPayloadOpener(
  authority: SearchKeyAuthority
): SearchRagPayloadOpener {
  const decryptOnlyCustodian = custodianForSearchAuthority(authority);
  const records = new Map<string, ManagedKeyRecordV1>();
  const keys = new Map<string, Promise<ManagedObjectWrappingKey>>();
  let open = true;
  const sessionIsOpen = (): boolean => open;

  const keyFor = (
    record: ManagedKeyRecordV1,
    signal: AbortSignal | undefined
  ): Promise<ManagedObjectWrappingKey> => {
    if (!sessionIsOpen()) unavailable();
    const existingRecord = records.get(record.keyId);
    if (existingRecord !== undefined && !sameManagedKeyRecord(existingRecord, record)) {
      unavailable();
    }
    const existing = keys.get(record.keyId);
    if (existing !== undefined) return existing;
    if (keys.size >= RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS) unavailable();

    records.set(record.keyId, record);
    const pending = (async (): Promise<ManagedObjectWrappingKey> => {
      const resolver = createManagedKeyResolver({
        // The resolver's read path invokes only withUnwrappedIntermediateKey.
        // Its broader historical type is narrowed at the authority boundary
        // and the search facade has no generation member at runtime.
        custodian: decryptOnlyCustodian as IntermediateKeyCustodian,
        store: matchingStore(record),
        workload: "search_worker"
      });
      const resolved = await resolver.resolveObjectWrappingKey({
        ownerId: record.ownerId,
        keyClass: record.keyClass,
        keyId: record.keyId
      });
      if (!sessionIsOpen() || signal?.aborted === true || resolved === null) unavailable();
      return resolved;
    })();
    keys.set(record.keyId, pending);
    return pending;
  };

  return Object.freeze({
    release(): void {
      if (!open) return;
      open = false;
      keys.clear();
      records.clear();
    },
    async openPayload(input) {
      assertActive(input.signal);
      try {
        if (!sessionIsOpen()) unavailable();
        const bound = encryptedRecord(input.ownerId, input.item);
        const key = await keyFor(bound.key, input.signal);
        const aggregate = createEncryptedAggregateService({
          keyResolver: resolverForKey(key),
          objectWrapReservations: {
            reserveObjectWrappingKey(): Promise<never> {
              return Promise.reject(
                new Error("Search decryption cannot reserve object-wrapping keys.")
              );
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
        if (!metadataMatchesPayload(input.item.record, value)) unavailable();
        const plaintext = serializePrivateRagIndexDocument(value, expected);
        try {
          return Object.freeze({ plaintextBytes: plaintext.byteLength, value });
        } finally {
          plaintext.fill(0);
        }
      } catch {
        unavailable();
      }
    }
  });
}
