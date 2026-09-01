import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  createEncryptedAggregateService,
  type EncryptedAggregateRecord,
  type ObjectWrapReservation
} from "@unfiled/encrypted-aggregate";
import {
  createManagedKeyResolver,
  parseManagedKeyRecord,
  type IntermediateKeyCustodian,
  type ManagedKeyRecordV1,
  type ManagedKeyStore
} from "@unfiled/key-management";
import {
  buildPrivateRagPayloadValue,
  createPrivateRagPayloadCodec,
  serializePrivateRagIndexDocument,
  type PrivateRagGenerationSnapshot,
  type PrivateRagPageItem,
  type PrivateRagPayloadValueV1
} from "@unfiled/search";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrganizerRagRecord } from "../src/drain.js";
import { OrganizerUnavailableError } from "../src/errors.js";
import type * as OrganizerKeyManagementModule from "../src/key-management.js";
import { createOrganizerRagPayloadOpener } from "../src/rag-crypto.js";

const keyManagementMocks = vi.hoisted(() => ({
  custodianForOrganizerAuthority: vi.fn()
}));

vi.mock("../src/key-management.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OrganizerKeyManagementModule>()),
  custodianForOrganizerAuthority: keyManagementMocks.custodianForOrganizerAuthority
}));

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER_ID = "33333333-3333-4333-8333-333333333333";
const INDEX_ID = "irw_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const OTHER_INDEX_ID = "irw_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const NOTE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const OTHER_NOTE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const MODEL_ID = "text-embedding-3-small";
const INDEXED_REVISION = 7;
const DIMENSIONS = 2;
const CANARY = "ORGANIZER_RAG_PRIVATE_CANARY_5f1c6c";
const AUTHORITY = Object.freeze({}) as OrganizerKeyManagementModule.OrganizerKeyAuthority;

const SNAPSHOT: PrivateRagGenerationSnapshot = Object.freeze({
  dimensions: DIMENSIONS,
  expectedNoteCount: 1,
  generationId: "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  indexedNoteCount: 1,
  modelId: MODEL_ID,
  revisionToken: "9"
});

function managedKey(overrides: Partial<ManagedKeyRecordV1> = {}): ManagedKeyRecordV1 {
  return parseManagedKeyRecord({
    activatedAt: "2026-08-30T12:00:00.000Z",
    createdAt: "2026-08-30T12:00:00.000Z",
    encryptedKeyMaterial: "AQIDBA",
    keyClass: "ai_assisted",
    keyId: "key.ai.object_wrap.v1",
    keyVersion: 1,
    ownerId: OWNER_ID,
    purpose: "object_wrap",
    retiredAt: null,
    revokedAt: null,
    rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
    rotation: {
      lastRootRewrappedAt: null,
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0
    },
    schemaVersion: 1,
    status: "active",
    wrapOperationLimit: 16_777_216,
    wrapOperations: 0,
    ...overrides
  });
}

const OBJECT_KEY = managedKey();

function keyStore(key: ManagedKeyRecordV1): ManagedKeyStore {
  const matches = (value: Readonly<{ keyClass: string; ownerId: string; purpose: string }>) =>
    value.ownerId === key.ownerId &&
    value.keyClass === key.keyClass &&
    value.purpose === key.purpose;
  return Object.freeze({
    findActive(binding) {
      return Promise.resolve(matches(binding) && key.status === "active" ? key : null);
    },
    findById(selector) {
      return Promise.resolve(matches(selector) && selector.keyId === key.keyId ? key : null);
    }
  });
}

type CustodyFixture = Readonly<{
  custodian: IntermediateKeyCustodian;
  issued: Uint8Array[];
}>;

function custody(
  options: Readonly<{ beforeUse?: () => void; keyByte?: number; reject?: boolean }> = {}
): CustodyFixture {
  const issued: Uint8Array[] = [];
  const custodian: IntermediateKeyCustodian = Object.freeze({
    withGeneratedIntermediateKey() {
      return Promise.reject(new Error("generation is not used by this fixture"));
    },
    async withUnwrappedIntermediateKey(recordValue, use, operationOptions) {
      if (operationOptions?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      if (options.reject === true) throw new Error("PRIVATE-CUSTODY-FAILURE");
      const record = parseManagedKeyRecord(recordValue);
      const bytes = new Uint8Array(32).fill(options.keyByte ?? 17);
      issued.push(bytes);
      try {
        options.beforeUse?.();
        return await use(bytes, record);
      } finally {
        bytes.fill(0);
      }
    }
  });
  return Object.freeze({ custodian, issued });
}

type CipherProjection = Readonly<{
  envelope: ContentEnvelopeV1;
  keyClass: string;
  keyId: string;
  keyPurpose: string;
  keyVersion: number;
}>;

function organizerRecord(
  encrypted: EncryptedAggregateRecord<"note_rag_index">,
  key: unknown = OBJECT_KEY
): OrganizerRagRecord {
  return Object.freeze({
    cipher: Object.freeze({
      envelope: encrypted.envelope,
      keyClass: encrypted.keyClass,
      keyId: encrypted.keyId,
      keyPurpose: encrypted.keyPurpose,
      keyVersion: encrypted.keyVersion
    }),
    key,
    recordVersion: encrypted.recordVersion,
    resourceId: encrypted.resourceId
  });
}

type OpenInput = Readonly<{
  item: PrivateRagPageItem<OrganizerRagRecord>;
  ownerId: string;
  signal?: AbortSignal;
  snapshot: PrivateRagGenerationSnapshot;
}>;
type OpenInputOverrides = Readonly<{
  item?: Partial<PrivateRagPageItem<OrganizerRagRecord>>;
  ownerId?: string;
  signal?: AbortSignal;
  snapshot?: Partial<PrivateRagGenerationSnapshot>;
}>;

let payload: PrivateRagPayloadValueV1;
let baseInput: OpenInput;

function input(overrides: OpenInputOverrides = {}): OpenInput {
  return Object.freeze({
    item: Object.freeze({ ...baseInput.item, ...overrides.item }),
    ownerId: overrides.ownerId ?? baseInput.ownerId,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    snapshot: Object.freeze({ ...baseInput.snapshot, ...overrides.snapshot })
  });
}

function cipher(record = baseInput.item.record): CipherProjection {
  return record.cipher as CipherProjection;
}

function withCipher(
  changes: Partial<CipherProjection>,
  record = baseInput.item.record
): OrganizerRagRecord {
  return Object.freeze({ ...record, cipher: Object.freeze({ ...cipher(record), ...changes }) });
}

function mutateBase64(value: string, index = 0): string {
  const safeIndex = Math.max(0, Math.min(index, value.length - 1));
  const replacement = value[safeIndex] === "A" ? "B" : "A";
  return `${value.slice(0, safeIndex)}${replacement}${value.slice(safeIndex + 1)}`;
}

async function expectUnavailable(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrganizerUnavailableError);
  expect(String(caught)).not.toContain(CANARY);
}

beforeAll(async () => {
  payload = buildPrivateRagPayloadValue({
    embedding: new Float32Array([1, 0]),
    headings: ["Private heading"],
    indexedRevision: INDEXED_REVISION,
    isOpen: true,
    latestSnippet: `Private snippet ${CANARY}`,
    modelId: MODEL_ID,
    noteId: NOTE_ID,
    noteType: "list",
    pinned: false,
    searchableText: `groceries eggs ${CANARY}`,
    spaceId: null,
    title: `Groceries ${CANARY}`,
    updatedAt: "2026-08-31T12:00:00.000Z"
  });
  const sealingCustody = custody();
  const resolver = createManagedKeyResolver({
    custodian: sealingCustody.custodian,
    store: keyStore(OBJECT_KEY),
    workload: "organization_worker"
  });
  const aggregate = createEncryptedAggregateService({
    keyResolver: resolver,
    objectWrapReservations: {
      reserveObjectWrappingKey(binding): Promise<ObjectWrapReservation> {
        if (binding.ownerId !== OWNER_ID || binding.keyClass !== "ai_assisted") {
          return Promise.reject(new Error("unexpected reservation binding"));
        }
        return Promise.resolve(
          Object.freeze({
            reference: Object.freeze({
              keyClass: OBJECT_KEY.keyClass,
              keyId: OBJECT_KEY.keyId,
              keyVersion: OBJECT_KEY.keyVersion,
              ownerId: OBJECT_KEY.ownerId,
              purpose: "object_wrap" as const
            }),
            reservationId: "rag-crypto-fixture"
          })
        );
      }
    }
  });
  const encrypted = await aggregate.sealNoteRagIndex(
    authorizeAggregateOwner({
      authenticatedOwnerId: OWNER_ID,
      resourceOwnerId: OWNER_ID
    }),
    {
      indexId: INDEX_ID,
      indexedRevision: INDEXED_REVISION,
      payload,
      payloadCodec: createPrivateRagPayloadCodec({
        dimensions: DIMENSIONS,
        indexedRevision: INDEXED_REVISION,
        modelId: MODEL_ID,
        noteId: NOTE_ID
      })
    }
  );
  expect(sealingCustody.issued.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  const record = organizerRecord(encrypted);
  baseInput = Object.freeze({
    item: Object.freeze({
      ciphertextBytes: JSON.stringify(record).length,
      indexId: INDEX_ID,
      indexedRevision: INDEXED_REVISION,
      noteId: NOTE_ID,
      record
    }),
    ownerId: OWNER_ID,
    snapshot: SNAPSHOT
  });
});

beforeEach(() => {
  keyManagementMocks.custodianForOrganizerAuthority.mockReset();
});

describe("production organizer RAG payload crypto", () => {
  it("opens an authenticated, exactly bound payload and wipes transient plaintext and key bytes", async () => {
    const openingCustody = custody();
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValue(openingCustody.custodian);
    const expectedBytes = serializePrivateRagIndexDocument(payload, {
      dimensions: DIMENSIONS,
      indexedRevision: INDEXED_REVISION,
      modelId: MODEL_ID,
      noteId: NOTE_ID
    }).byteLength;
    const fill = vi.spyOn(Uint8Array.prototype, "fill");
    try {
      const opened = await createOrganizerRagPayloadOpener(AUTHORITY).openPayload(input());
      const zeroedLengths = fill.mock.calls.flatMap(([value], index) => {
        const receiver: unknown = fill.mock.instances[index];
        return value === 0 && receiver instanceof Uint8Array ? [receiver.byteLength] : [];
      });
      expect(opened).toEqual({ plaintextBytes: expectedBytes, value: payload });
      expect(JSON.stringify(baseInput.item.record)).not.toContain(CANARY);
      expect(
        zeroedLengths.filter((length) => length === expectedBytes).length
      ).toBeGreaterThanOrEqual(2);
      expect(openingCustody.issued).toHaveLength(1);
      expect(openingCustody.issued[0]?.every((value) => value === 0)).toBe(true);
      expect(keyManagementMocks.custodianForOrganizerAuthority).toHaveBeenCalledWith(AUTHORITY);
    } finally {
      fill.mockRestore();
    }
  });

  it("accepts a retired matching object-wrapping key", async () => {
    const openingCustody = custody();
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValue(openingCustody.custodian);
    const retired = managedKey({
      retiredAt: "2026-08-31T12:00:00.000Z",
      status: "retired"
    });

    await expect(
      createOrganizerRagPayloadOpener(AUTHORITY).openPayload(
        input({ item: { record: Object.freeze({ ...baseInput.item.record, key: retired }) } })
      )
    ).resolves.toMatchObject({ value: payload });
    expect(openingCustody.issued[0]?.every((value) => value === 0)).toBe(true);
  });

  it("rejects owner, item, record, envelope, key, and exact-shape substitutions before decrypt", async () => {
    const openingCustody = custody();
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValue(openingCustody.custodian);
    const baseCipher = cipher();
    const revoked = managedKey({
      revokedAt: "2026-08-31T12:00:00.000Z",
      status: "revoked"
    });
    const malformedKey = Object.freeze({ ...OBJECT_KEY, unknown: CANARY });
    const changedContext = Object.freeze({
      ...baseCipher.envelope,
      context: Object.freeze({ ...baseCipher.envelope.context, tenantId: OTHER_OWNER_ID })
    });
    const attempts: readonly OpenInput[] = [
      input({ ownerId: OTHER_OWNER_ID }),
      input({ item: { indexId: OTHER_INDEX_ID } }),
      input({ item: { indexedRevision: INDEXED_REVISION + 1 } }),
      input({ item: { indexId: "irw_invalid" } }),
      input({
        item: { record: Object.freeze({ ...baseInput.item.record, resourceId: OTHER_INDEX_ID }) }
      }),
      input({
        item: {
          record: Object.freeze({
            ...baseInput.item.record,
            recordVersion: INDEXED_REVISION + 1
          })
        }
      }),
      input({ item: { record: withCipher({ envelope: changedContext }) } }),
      input({ item: { record: withCipher({ keyClass: "private_manual" }) } }),
      input({ item: { record: withCipher({ keyPurpose: "content_mac" }) } }),
      input({ item: { record: Object.freeze({ ...baseInput.item.record, key: revoked }) } }),
      input({ item: { record: Object.freeze({ ...baseInput.item.record, key: malformedKey }) } }),
      input({ item: { record: Object.freeze({ ...baseInput.item.record, cipher: null }) } }),
      input({
        item: {
          record: Object.freeze({
            ...baseInput.item.record,
            cipher: Object.freeze({ ...baseCipher, unknown: CANARY })
          })
        }
      })
    ];

    for (const attempt of attempts) {
      await expectUnavailable(createOrganizerRagPayloadOpener(AUTHORITY).openPayload(attempt));
    }
    expect(openingCustody.issued).toHaveLength(0);
  });

  it("rejects note, model, and dimension substitutions after authenticated decryption", async () => {
    const openingCustody = custody();
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValue(openingCustody.custodian);
    const attempts: readonly OpenInput[] = [
      input({ item: { noteId: OTHER_NOTE_ID } }),
      input({ snapshot: { modelId: "text-embedding-other" } }),
      input({ snapshot: { dimensions: DIMENSIONS + 1 } })
    ];

    for (const attempt of attempts) {
      await expectUnavailable(createOrganizerRagPayloadOpener(AUTHORITY).openPayload(attempt));
    }
    expect(openingCustody.issued).toHaveLength(attempts.length);
    expect(openingCustody.issued.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  });

  it("rejects ciphertext, authentication-tag, and wrapped-key tampering", async () => {
    const openingCustody = custody();
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValue(openingCustody.custodian);
    const baseEnvelope = cipher().envelope;
    const attempts = [
      Object.freeze({
        ...baseEnvelope,
        payload: Object.freeze({
          ...baseEnvelope.payload,
          ciphertext: mutateBase64(baseEnvelope.payload.ciphertext)
        })
      }),
      Object.freeze({
        ...baseEnvelope,
        payload: Object.freeze({
          ...baseEnvelope.payload,
          ciphertext: mutateBase64(
            baseEnvelope.payload.ciphertext,
            baseEnvelope.payload.ciphertext.length - 2
          )
        })
      }),
      Object.freeze({
        ...baseEnvelope,
        wrappedDataKey: Object.freeze({
          ...baseEnvelope.wrappedDataKey,
          ciphertext: mutateBase64(baseEnvelope.wrappedDataKey.ciphertext)
        })
      })
    ] as const;

    for (const envelope of attempts) {
      await expectUnavailable(
        createOrganizerRagPayloadOpener(AUTHORITY).openPayload(
          input({ item: { record: withCipher({ envelope }) } })
        )
      );
    }
    expect(openingCustody.issued.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  });

  it("fails closed for unavailable or cryptographically wrong key custody", async () => {
    const unavailableCustody = custody({ reject: true });
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValueOnce(
      unavailableCustody.custodian
    );
    await expectUnavailable(createOrganizerRagPayloadOpener(AUTHORITY).openPayload(input()));

    const wrongCustody = custody({ keyByte: 18 });
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValueOnce(wrongCustody.custodian);
    await expectUnavailable(createOrganizerRagPayloadOpener(AUTHORITY).openPayload(input()));
    expect(wrongCustody.issued[0]?.every((value) => value === 0)).toBe(true);
  });

  it("rejects pre-abort before custody and late abort after decrypt while zeroing keys", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const untouchedCustody = custody();
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValueOnce(
      untouchedCustody.custodian
    );
    await expectUnavailable(
      createOrganizerRagPayloadOpener(AUTHORITY).openPayload(input({ signal: preAborted.signal }))
    );
    expect(untouchedCustody.issued).toHaveLength(0);

    const lateAbort = new AbortController();
    const abortingCustody = custody({ beforeUse: () => lateAbort.abort() });
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValueOnce(
      abortingCustody.custodian
    );
    await expectUnavailable(
      createOrganizerRagPayloadOpener(AUTHORITY).openPayload(input({ signal: lateAbort.signal }))
    );
    expect(abortingCustody.issued).toHaveLength(1);
    expect(abortingCustody.issued[0]?.every((value) => value === 0)).toBe(true);
  });
});
