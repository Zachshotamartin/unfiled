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

import type { SearchRagRecord } from "../src/database.js";
import type * as SearchKeyManagementModule from "../src/key-management.js";
import { createSearchRagPayloadOpener } from "../src/rag-crypto.js";

const keyMocks = vi.hoisted(() => ({ custodianForSearchAuthority: vi.fn() }));

vi.mock("../src/key-management.js", async (importOriginal) => {
  const original = await importOriginal<typeof SearchKeyManagementModule>();
  return {
    ...original,
    custodianForSearchAuthority: keyMocks.custodianForSearchAuthority,
    managedKeyRecordParserForSearchAuthority: () =>
      original.managedKeyRecordParserForSearchBoundary({ kind: "local-disabled" })
  };
});

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER_ID = "33333333-3333-4333-8333-333333333333";
const INDEX_ID = "irw_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const OTHER_INDEX_ID = "irw_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const NOTE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const OTHER_NOTE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const MODEL_ID = "text-embedding-3-small";
const INDEXED_REVISION = 7;
const DIMENSIONS = 2;
const ENCRYPTED_BYTES = 2_048;
const CANARY = "SEARCH_RAG_PRIVATE_CANARY_5f1c6c";
const AUTHORITY = Object.freeze({}) as SearchKeyManagementModule.SearchKeyAuthority;

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

function custody(options: Readonly<{ reject?: boolean }> = {}): Readonly<{
  custodian: IntermediateKeyCustodian;
  issued: Uint8Array[];
}> {
  const issued: Uint8Array[] = [];
  return {
    custodian: Object.freeze({
      withGeneratedIntermediateKey() {
        return Promise.reject(new Error("generation not configured in test custody"));
      },
      async withUnwrappedIntermediateKey(record, use, operationOptions) {
        if (operationOptions?.signal?.aborted === true) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        if (options.reject === true) throw new Error("PRIVATE-CUSTODY-FAILURE");
        const parsed = parseManagedKeyRecord(record);
        const bytes = new Uint8Array(32).fill(17);
        issued.push(bytes);
        try {
          return await use(bytes, parsed);
        } finally {
          bytes.fill(0);
        }
      }
    }),
    issued
  };
}

function searchRecord(
  encrypted: EncryptedAggregateRecord<"note_rag_index">,
  key: ManagedKeyRecordV1 = OBJECT_KEY
): SearchRagRecord {
  return Object.freeze({
    cipher: Object.freeze({
      envelope: encrypted.envelope,
      keyClass: "ai_assisted" as const,
      keyId: encrypted.keyId,
      keyPurpose: "object_wrap" as const,
      keyVersion: encrypted.keyVersion
    }),
    encryptedByteLength: ENCRYPTED_BYTES,
    key,
    metadata: Object.freeze({
      archivedAt: null,
      pinnedAt: null,
      spaceId: null,
      tagIds: Object.freeze(["tag_01ARZ3NDEKTSV4RRFFQ69G5FAA"]),
      type: "list" as const,
      updatedAt: "2026-08-31T12:00:00.000Z"
    }),
    recordVersion: encrypted.recordVersion,
    resourceId: encrypted.resourceId
  });
}

type OpenInput = Readonly<{
  item: PrivateRagPageItem<SearchRagRecord>;
  ownerId: string;
  signal?: AbortSignal;
  snapshot: PrivateRagGenerationSnapshot;
}>;

let payload: PrivateRagPayloadValueV1;
let baseInput: OpenInput;
let distinctKeyInputs: readonly OpenInput[];

function input(
  overrides: Readonly<{
    item?: Partial<PrivateRagPageItem<SearchRagRecord>>;
    ownerId?: string;
    signal?: AbortSignal;
    snapshot?: Partial<PrivateRagGenerationSnapshot>;
  }> = {}
): OpenInput {
  return Object.freeze({
    item: Object.freeze({ ...baseInput.item, ...overrides.item }),
    ownerId: overrides.ownerId ?? baseInput.ownerId,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    snapshot: Object.freeze({ ...baseInput.snapshot, ...overrides.snapshot })
  });
}

function withRecord(changes: Partial<SearchRagRecord>): SearchRagRecord {
  return Object.freeze({ ...baseInput.item.record, ...changes });
}

function withCipher(
  changes: Partial<SearchRagRecord["cipher"]>,
  record = baseInput.item.record
): SearchRagRecord {
  return Object.freeze({
    ...record,
    cipher: Object.freeze({ ...record.cipher, ...changes })
  });
}

function mutateBase64(value: string): string {
  const replacement = value.startsWith("A") ? "B" : "A";
  return `${replacement}${value.slice(1)}`;
}

async function expectUnavailable(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "provider_unavailable", status: 503 });
  expect(String(caught)).not.toContain(CANARY);
}

async function encryptedFixture(
  noteId: string,
  indexId: string,
  key: ManagedKeyRecordV1
): Promise<Readonly<{ input: OpenInput; payload: PrivateRagPayloadValueV1 }>> {
  const fixturePayload = buildPrivateRagPayloadValue({
    embedding: new Float32Array([1, 0]),
    headings: ["Private heading"],
    indexedRevision: INDEXED_REVISION,
    isOpen: true,
    latestSnippet: `Private snippet ${CANARY}`,
    modelId: MODEL_ID,
    noteId,
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
    store: keyStore(key),
    workload: "organization_worker"
  });
  const aggregate = createEncryptedAggregateService({
    keyResolver: resolver,
    objectWrapReservations: {
      reserveObjectWrappingKey(binding): Promise<ObjectWrapReservation> {
        if (binding.ownerId !== OWNER_ID || binding.keyClass !== "ai_assisted") {
          return Promise.reject(new Error("unexpected binding"));
        }
        return Promise.resolve(
          Object.freeze({
            reference: Object.freeze({
              keyClass: key.keyClass,
              keyId: key.keyId,
              keyVersion: key.keyVersion,
              ownerId: key.ownerId,
              purpose: "object_wrap" as const
            }),
            reservationId: `search-rag-fixture:${key.keyId}`
          })
        );
      }
    }
  });
  const encrypted = await aggregate.sealNoteRagIndex(
    authorizeAggregateOwner({ authenticatedOwnerId: OWNER_ID, resourceOwnerId: OWNER_ID }),
    {
      indexId: indexId as `irw_${string}`,
      indexedRevision: INDEXED_REVISION,
      payload: fixturePayload,
      payloadCodec: createPrivateRagPayloadCodec({
        dimensions: DIMENSIONS,
        indexedRevision: INDEXED_REVISION,
        modelId: MODEL_ID,
        noteId
      })
    }
  );
  const record = searchRecord(encrypted, key);
  const fixtureInput = Object.freeze({
    item: Object.freeze({
      ciphertextBytes: ENCRYPTED_BYTES,
      indexId,
      indexedRevision: INDEXED_REVISION,
      noteId,
      record
    }),
    ownerId: OWNER_ID,
    snapshot: SNAPSHOT
  });
  expect(sealingCustody.issued.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  return Object.freeze({ input: fixtureInput, payload: fixturePayload });
}

beforeAll(async () => {
  const base = await encryptedFixture(NOTE_ID, INDEX_ID, OBJECT_KEY);
  payload = base.payload;
  baseInput = base.input;
  const additional = await Promise.all(
    ["B", "C", "D", "E"].map((suffix, index) =>
      encryptedFixture(
        `${NOTE_ID.slice(0, -1)}${suffix}`,
        `${INDEX_ID.slice(0, -1)}${suffix}`,
        managedKey({
          keyId: `key.ai.object_wrap.v${index + 2}`,
          keyVersion: index + 2
        })
      )
    )
  );
  distinctKeyInputs = Object.freeze([baseInput, ...additional.map((fixture) => fixture.input)]);
});

beforeEach(() => keyMocks.custodianForSearchAuthority.mockReset());

describe("search RAG payload decryption", () => {
  it("deduplicates concurrent unwrap/import work within one request and never across requests", async () => {
    const opening = custody();
    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    const first = createSearchRagPayloadOpener(AUTHORITY);

    await expect(
      Promise.all(Array.from({ length: 8 }, () => first.openPayload(input())))
    ).resolves.toHaveLength(8);
    expect(opening.issued).toHaveLength(1);

    const second = createSearchRagPayloadOpener(AUTHORITY);
    await expect(second.openPayload(input())).resolves.toMatchObject({ value: payload });
    expect(opening.issued).toHaveLength(2);

    first.release();
    second.release();
    await expectUnavailable(first.openPayload(input()));
    expect(opening.issued).toHaveLength(2);
  });

  it("rejects key-record drift for a cached key ID without another unwrap", async () => {
    const opening = custody();
    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    const session = createSearchRagPayloadOpener(AUTHORITY);
    await expect(session.openPayload(input())).resolves.toMatchObject({ value: payload });

    await expectUnavailable(
      session.openPayload(
        input({
          item: {
            record: withRecord({ key: managedKey({ wrapOperations: 1 }) })
          }
        })
      )
    );
    expect(opening.issued).toHaveLength(1);
    session.release();
  });

  it("opens at most four authenticated distinct key records in one request", async () => {
    const opening = custody();
    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    const session = createSearchRagPayloadOpener(AUTHORITY);

    for (const distinctInput of distinctKeyInputs.slice(0, 4)) {
      await expect(session.openPayload(distinctInput)).resolves.toBeDefined();
    }
    const fifth = distinctKeyInputs[4];
    if (fifth === undefined) throw new Error("missing fifth key fixture");
    await expectUnavailable(session.openPayload(fifth));
    expect(opening.issued).toHaveLength(4);
    session.release();
  });

  it("opens an exactly owner-bound payload and wipes transient plaintext and key bytes", async () => {
    const opening = custody();
    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    const serialized = serializePrivateRagIndexDocument(payload, {
      dimensions: DIMENSIONS,
      indexedRevision: INDEXED_REVISION,
      modelId: MODEL_ID,
      noteId: NOTE_ID
    });
    const expectedBytes = serialized.byteLength;
    serialized.fill(0);
    const fill = vi.spyOn(Uint8Array.prototype, "fill");
    try {
      await expect(createSearchRagPayloadOpener(AUTHORITY).openPayload(input())).resolves.toEqual({
        plaintextBytes: expectedBytes,
        value: payload
      });
      const zeroedLengths = fill.mock.calls.flatMap(([value], index) => {
        const receiver: unknown = fill.mock.instances[index];
        return value === 0 && receiver instanceof Uint8Array ? [receiver.byteLength] : [];
      });
      expect(zeroedLengths.filter((length) => length === expectedBytes).length).toBeGreaterThan(0);
      expect(opening.issued).toHaveLength(1);
      expect(opening.issued[0]?.every((byte) => byte === 0)).toBe(true);
      expect(JSON.stringify(baseInput.item.record)).not.toContain(CANARY);
    } finally {
      fill.mockRestore();
    }
  });

  it("accepts a matching retired AI object-wrap record", async () => {
    const opening = custody();
    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    const retired = managedKey({
      retiredAt: "2026-08-31T12:00:00.000Z",
      status: "retired"
    });

    await expect(
      createSearchRagPayloadOpener(AUTHORITY).openPayload(
        input({ item: { record: withRecord({ key: retired }) } })
      )
    ).resolves.toMatchObject({ value: payload });
  });

  it("rejects cross-owner, private, revoked, malformed, and projection substitutions before decrypt", async () => {
    const opening = custody();
    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    const envelope = baseInput.item.record.cipher.envelope;
    const attempts: OpenInput[] = [
      input({ ownerId: OTHER_OWNER_ID }),
      input({ item: { indexId: OTHER_INDEX_ID } }),
      input({ item: { indexedRevision: INDEXED_REVISION + 1 } }),
      input({ item: { ciphertextBytes: ENCRYPTED_BYTES + 1 } }),
      input({ item: { record: withRecord({ resourceId: OTHER_INDEX_ID }) } }),
      input({ item: { record: withRecord({ recordVersion: INDEXED_REVISION + 1 }) } }),
      input({
        item: {
          record: withCipher({
            envelope: Object.freeze({
              ...envelope,
              context: Object.freeze({ ...envelope.context, tenantId: OTHER_OWNER_ID })
            })
          })
        }
      }),
      input({ item: { record: withCipher({ keyClass: "private_manual" as never }) } }),
      input({ item: { record: withCipher({ keyPurpose: "content_mac" as never }) } }),
      input({
        item: {
          record: withRecord({
            key: managedKey({ keyClass: "private_manual" })
          })
        }
      }),
      input({
        item: {
          record: withRecord({
            key: managedKey({
              revokedAt: "2026-08-31T12:00:00.000Z",
              status: "revoked"
            })
          })
        }
      }),
      input({
        item: {
          record: Object.freeze({ ...baseInput.item.record, extra: CANARY })
        }
      }),
      input({
        item: {
          record: withRecord({
            cipher: Object.freeze({ ...baseInput.item.record.cipher, extra: true })
          })
        }
      })
    ];

    for (const attempt of attempts) {
      await expectUnavailable(createSearchRagPayloadOpener(AUTHORITY).openPayload(attempt));
    }
    expect(opening.issued).toHaveLength(0);
  });

  it("authenticates note/model/dimensions and mirrored metadata after decryption", async () => {
    const opening = custody();
    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    const metadata = baseInput.item.record.metadata;
    const attempts: OpenInput[] = [
      input({ item: { noteId: OTHER_NOTE_ID } }),
      input({ snapshot: { modelId: "text-embedding-other" } }),
      input({ snapshot: { dimensions: DIMENSIONS + 1 } }),
      input({
        item: {
          record: withRecord({ metadata: Object.freeze({ ...metadata, type: "project" }) })
        }
      }),
      input({
        item: {
          record: withRecord({
            metadata: Object.freeze({
              ...metadata,
              updatedAt: "2026-08-31T13:00:00.000Z"
            })
          })
        }
      }),
      input({
        item: {
          record: withRecord({
            metadata: Object.freeze({ ...metadata, pinnedAt: "2026-08-31T12:00:00.000Z" })
          })
        }
      })
    ];

    for (const attempt of attempts) {
      await expectUnavailable(createSearchRagPayloadOpener(AUTHORITY).openPayload(attempt));
    }
    expect(opening.issued).toHaveLength(attempts.length);
    expect(opening.issued.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  it("rejects ciphertext tampering, unavailable custody, and aborted requests", async () => {
    const opening = custody();
    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    const envelope: ContentEnvelopeV1 = baseInput.item.record.cipher.envelope;
    const tampered = Object.freeze({
      ...envelope,
      payload: Object.freeze({
        ...envelope.payload,
        ciphertext: mutateBase64(envelope.payload.ciphertext)
      })
    });
    await expectUnavailable(
      createSearchRagPayloadOpener(AUTHORITY).openPayload(
        input({ item: { record: withCipher({ envelope: tampered }) } })
      )
    );

    const rejected = custody({ reject: true });
    keyMocks.custodianForSearchAuthority.mockReturnValue(rejected.custodian);
    await expectUnavailable(createSearchRagPayloadOpener(AUTHORITY).openPayload(input()));

    keyMocks.custodianForSearchAuthority.mockReturnValue(opening.custodian);
    await expectUnavailable(
      createSearchRagPayloadOpener(AUTHORITY).openPayload(input({ signal: AbortSignal.abort() }))
    );
  });
});
