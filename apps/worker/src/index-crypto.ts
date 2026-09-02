import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  createEncryptedAggregateService,
  type NoteContentPayload,
  type PayloadCodec,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import {
  createManagedKeyResolver,
  type ManagedKeyRecord,
  type ManagedKeyStore
} from "@unfiled/key-management";

import type { AiAssistedKeyAuthority } from "./key-management-adapter.js";
import {
  custodianForAiAssistedAuthority,
  managedKeyRecordParserForAiAssistedAuthority
} from "./key-management-adapter.js";

export type IndexCryptoJob = Readonly<{
  indexResourceId: string;
  noteId: string;
  reservation: Readonly<{
    consumed: false;
    keyClass: "ai_assisted";
    keyId: string;
    keyPurpose: "object_wrap";
    keyVersion: number;
    operationCount: 1;
    reservationId: string;
  }>;
  sourceKey: ManagedKeyRecord;
  sourceNoteCipher: Readonly<{
    envelope: ContentEnvelopeV1;
    keyClass: "ai_assisted";
    keyId: string;
    keyPurpose: "object_wrap";
    keyVersion: number;
  }>;
  targetKey: ManagedKeyRecord;
  targetRevision: number;
  userId: string;
}>;

export type IndexCryptoSession = Readonly<{
  openNote(): Promise<NoteContentPayload>;
  sealIndex<Payload>(
    payload: Payload,
    codec: PayloadCodec<Payload>
  ): Promise<SealedEncryptedAggregateRecord<"note_rag_index">>;
}>;

export type IndexCryptoFactory = Readonly<{
  forJob(job: IndexCryptoJob): IndexCryptoSession;
}>;

function sameSelector(
  record: ManagedKeyRecord,
  selector: Readonly<{ ownerId: string; keyClass: string; purpose: string; keyId: string }>
): boolean {
  return (
    record.ownerId === selector.ownerId &&
    record.keyClass === selector.keyClass &&
    record.purpose === selector.purpose &&
    record.keyId === selector.keyId
  );
}

function sameBinding(
  record: ManagedKeyRecord,
  binding: Readonly<{ ownerId: string; keyClass: string; purpose: string }>
): boolean {
  return (
    record.ownerId === binding.ownerId &&
    record.keyClass === binding.keyClass &&
    record.purpose === binding.purpose
  );
}

function keyStore(job: IndexCryptoJob): ManagedKeyStore {
  const records =
    job.sourceKey.keyId === job.targetKey.keyId ? [job.sourceKey] : [job.sourceKey, job.targetKey];
  return Object.freeze({
    findActive(binding): Promise<unknown> {
      return Promise.resolve(
        records.find((record) => record.status === "active" && sameBinding(record, binding)) ?? null
      );
    },
    findById(selector): Promise<unknown> {
      return Promise.resolve(records.find((record) => sameSelector(record, selector)) ?? null);
    }
  });
}

function assertJobBindings(job: IndexCryptoJob): void {
  const source = job.sourceNoteCipher;
  const reservation = job.reservation;
  const sourceKeyClass: unknown = source.keyClass;
  const sourceKeyPurpose: unknown = source.keyPurpose;
  const reservationConsumed: unknown = reservation.consumed;
  const reservationOperationCount: unknown = reservation.operationCount;
  const reservationKeyClass: unknown = reservation.keyClass;
  const reservationKeyPurpose: unknown = reservation.keyPurpose;
  if (
    sourceKeyClass !== "ai_assisted" ||
    sourceKeyPurpose !== "object_wrap" ||
    source.keyId !== job.sourceKey.keyId ||
    source.keyVersion !== job.sourceKey.keyVersion ||
    job.sourceKey.ownerId !== job.userId ||
    job.sourceKey.keyClass !== "ai_assisted" ||
    job.sourceKey.purpose !== "object_wrap" ||
    (job.sourceKey.status !== "active" && job.sourceKey.status !== "retired") ||
    job.targetKey.ownerId !== job.userId ||
    job.targetKey.keyClass !== "ai_assisted" ||
    job.targetKey.purpose !== "object_wrap" ||
    job.targetKey.status !== "active" ||
    reservationConsumed !== false ||
    reservationOperationCount !== 1 ||
    reservationKeyClass !== "ai_assisted" ||
    reservationKeyPurpose !== "object_wrap" ||
    reservation.keyId !== job.targetKey.keyId ||
    reservation.keyVersion !== job.targetKey.keyVersion
  ) {
    throw new Error("Index crypto binding is invalid.");
  }
}

export function createManagedIndexCryptoFactory(
  authority: AiAssistedKeyAuthority
): IndexCryptoFactory {
  const custodian = custodianForAiAssistedAuthority(authority);
  const parseRecord = managedKeyRecordParserForAiAssistedAuthority(authority);
  return Object.freeze({
    forJob(job): IndexCryptoSession {
      assertJobBindings(job);
      let reservationIssued = false;
      const resolver = createManagedKeyResolver({
        custodian,
        parseRecord,
        store: keyStore(job),
        workload: "index_worker"
      });
      const aggregate = createEncryptedAggregateService({
        keyResolver: resolver,
        objectWrapReservations: {
          reserveObjectWrappingKey(binding) {
            if (
              reservationIssued ||
              binding.ownerId !== job.userId ||
              binding.keyClass !== "ai_assisted"
            ) {
              return Promise.reject(new Error("Index reservation is unavailable."));
            }
            reservationIssued = true;
            return Promise.resolve(
              Object.freeze({
                reservationId: job.reservation.reservationId,
                reference: Object.freeze({
                  ownerId: job.userId,
                  keyClass: "ai_assisted" as const,
                  purpose: "object_wrap" as const,
                  keyId: job.reservation.keyId,
                  keyVersion: job.reservation.keyVersion
                })
              })
            );
          }
        }
      });
      const access = authorizeAggregateOwner({
        authenticatedOwnerId: job.userId,
        resourceOwnerId: job.userId
      });
      return Object.freeze({
        openNote(): Promise<NoteContentPayload> {
          return aggregate.openNoteContent(
            access,
            {
              ownerId: job.userId,
              resourceId: job.noteId,
              recordVersion: job.targetRevision,
              kind: "note_content",
              envelope: job.sourceNoteCipher.envelope,
              keyId: job.sourceNoteCipher.keyId,
              keyClass: job.sourceNoteCipher.keyClass,
              keyPurpose: job.sourceNoteCipher.keyPurpose,
              keyVersion: job.sourceNoteCipher.keyVersion
            },
            {
              noteId: job.noteId as `note_${string}`,
              currentRevision: job.targetRevision,
              privacy: "ai_assisted"
            }
          );
        },
        sealIndex<Payload>(
          payload: Payload,
          codec: PayloadCodec<Payload>
        ): Promise<SealedEncryptedAggregateRecord<"note_rag_index">> {
          return aggregate.sealNoteRagIndex(access, {
            indexId: job.indexResourceId as `irw_${string}`,
            indexedRevision: job.targetRevision,
            payload,
            payloadCodec: codec
          });
        }
      });
    }
  });
}
