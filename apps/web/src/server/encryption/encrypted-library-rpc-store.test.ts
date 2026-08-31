import {
  generateKeyEncryptionKey,
  sealBytes,
  type ContentEnvelopeV1,
  type KeyEncryptionKey
} from "@unfiled/content-crypto";
import type { KeyedMacRecord, SealedEncryptedAggregateRecord } from "@unfiled/encrypted-aggregate";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createEncryptedLibraryRpcStore,
  encryptedLibraryRpcFunctions,
  encryptedLibrarySurfaces,
  verifiableEncryptedContentSurfaces,
  type EncryptedLibrarySurface
} from "./encrypted-library-rpc-store";
import { ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER_ID = "22222222-2222-4222-8222-222222222222";
const TIME = "2026-08-30T12:00:00.000Z";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const RESERVATION_ID = "33333333-3333-4333-8333-333333333333";

const IDS = Object.freeze({
  block: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  capture: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  decision: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  job: "job_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  mutation: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  note: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  noteTwo: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  revision: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  review: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  rule: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  space: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  tag: "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"
});

const NOTE_SNAPSHOT = Object.freeze({
  spaceId: IDS.space,
  type: "generic" as const,
  title: "A note",
  bodyMarkdown: "Body",
  structuredData: { schemaVersion: 1 as const },
  isOpen: true,
  pinnedAt: null,
  privacy: "ai_assisted" as const,
  archivedAt: null,
  deletedAt: null,
  tagIds: [],
  links: []
});

type UnknownRecord = Readonly<Record<string, unknown>>;
type KeyClass = "ai_assisted" | "private_manual";

type StoredCipher = Readonly<{
  envelope: ContentEnvelopeV1;
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "object_wrap";
  keyVersion: number;
}>;

type StoredMac = Readonly<{
  mac: string;
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "content_mac";
  keyVersion: number;
}>;

type LibraryRow = Readonly<{
  resource_id: string;
  record_version: number;
  operational: UnknownRecord;
  content_cipher: StoredCipher;
  content_mac: StoredMac | null;
}>;

type BackfillRow = Readonly<{
  cursor: string;
  resource_id: string;
  record_version: number;
  key_class: KeyClass;
  expected_content: UnknownRecord;
  operational: UnknownRecord;
}>;

const RESOURCE_BY_SURFACE: Readonly<Record<EncryptedLibrarySurface, string>> = Object.freeze({
  space_display: IDS.space,
  tag_display: IDS.tag,
  note_content: IDS.note,
  note_revision: IDS.revision,
  organization_decision: IDS.decision,
  note_mutation: IDS.mutation,
  generated_block: IDS.block,
  review_item: IDS.review,
  routing_rule: IDS.rule,
  organization_mutation_attempt: `${IDS.job}:${IDS.note}`,
  idempotency_response: "idempotency:request-1",
  capture_receipt: IDS.capture,
  capture: IDS.capture
});

const VERSION_BY_SURFACE: Readonly<Record<EncryptedLibrarySurface, number>> = Object.freeze({
  space_display: 2,
  tag_display: 2,
  note_content: 2,
  note_revision: 2,
  organization_decision: 1,
  note_mutation: 2,
  generated_block: 1,
  review_item: 2,
  routing_rule: 2,
  organization_mutation_attempt: 2,
  idempotency_response: 1,
  capture_receipt: 2,
  capture: 1
});

const CLASS_BY_SURFACE: Readonly<Record<EncryptedLibrarySurface, KeyClass>> = Object.freeze({
  space_display: "private_manual",
  tag_display: "private_manual",
  note_content: "ai_assisted",
  note_revision: "ai_assisted",
  organization_decision: "ai_assisted",
  note_mutation: "ai_assisted",
  generated_block: "ai_assisted",
  review_item: "ai_assisted",
  routing_rule: "private_manual",
  organization_mutation_attempt: "ai_assisted",
  idempotency_response: "private_manual",
  capture_receipt: "ai_assisted",
  capture: "ai_assisted"
});

const RANK_BY_SURFACE: Readonly<Record<EncryptedLibrarySurface, string>> = Object.freeze({
  space_display: "01",
  tag_display: "02",
  note_content: "03",
  note_revision: "04",
  organization_decision: "05",
  note_mutation: "06",
  generated_block: "07",
  review_item: "08",
  routing_rule: "09",
  organization_mutation_attempt: "10",
  idempotency_response: "11",
  capture_receipt: "12",
  capture: "13"
});

const LIST_OPERATIONAL: Readonly<Record<EncryptedLibrarySurface, UnknownRecord>> = Object.freeze({
  space_display: {
    parentId: null,
    sortKey: "a0",
    archivedAt: null,
    createdAt: TIME,
    updatedAt: TIME
  },
  tag_display: { createdAt: TIME, updatedAt: TIME },
  note_content: {
    spaceId: IDS.space,
    type: "generic",
    dailyDate: null,
    isOpen: true,
    pinnedAt: null,
    privacy: "ai_assisted",
    archivedAt: null,
    deletedAt: null,
    createdAt: TIME,
    updatedAt: TIME
  },
  note_revision: {
    noteId: IDS.note,
    source: "manual",
    privacy: "ai_assisted",
    actor: `user:${OWNER_ID}`,
    mutationId: IDS.mutation,
    createdAt: TIME
  },
  organization_decision: {
    captureId: IDS.capture,
    band: "auto",
    score: 0.9,
    margin: 0.4,
    destinationNoteId: IDS.note,
    reasonCodes: ["explicit_destination"],
    createdAt: TIME
  },
  note_mutation: {
    decisionId: IDS.decision,
    noteId: IDS.note,
    beforeRevision: 1,
    afterRevision: 2,
    undoneAt: null,
    createdAt: TIME
  },
  generated_block: {
    noteId: IDS.note,
    decisionId: IDS.decision,
    kind: "summary",
    state: "proposed",
    modelId: "gpt-test",
    promptVersion: "v1",
    resolvedAt: null,
    createdAt: TIME
  },
  review_item: {
    captureId: IDS.capture,
    noteId: null,
    type: "low_confidence",
    state: "open",
    createdAt: TIME,
    resolvedAt: null
  },
  routing_rule: {
    enabled: true,
    ruleType: "prefix",
    destinationNoteId: IDS.note,
    destinationSpaceId: null,
    priority: 100,
    source: "explicit",
    lastFiredAt: null,
    createdAt: TIME,
    updatedAt: TIME
  },
  organization_mutation_attempt: {
    jobId: IDS.job,
    noteId: IDS.note,
    plannedRevision: 1,
    replanCount: 0,
    state: "applied",
    reviewItemId: null,
    createdAt: TIME,
    updatedAt: TIME
  },
  idempotency_response: {
    scope: "create_note",
    requestResourceType: "legacy_idempotency",
    requestResourceId: "idempotency:request-1",
    responseResourceType: "legacy_response",
    responseResourceId: "idempotency:request-1",
    responseRecordVersion: 1,
    createdAt: TIME,
    completedAt: TIME,
    replayPolicy: "legacy_nonreplayable",
    requestMac: null
  },
  capture_receipt: {
    jobId: IDS.job,
    decisionId: IDS.decision,
    reviewItemId: null,
    mutationId: IDS.mutation,
    outcome: "added_to_note",
    headline: "Added to note",
    destinationNoteId: IDS.note,
    reasonCodes: ["explicit_destination"],
    createdAt: TIME
  },
  capture: {
    source: "web",
    deviceId: "browser-1",
    contentLength: 18,
    privacy: "ai_assisted",
    explicitDestinationNoteId: IDS.note,
    expansionDisabled: false,
    clientCreatedAt: TIME,
    clientTimezone: "America/Los_Angeles",
    receivedAt: TIME,
    status: "organized",
    lastErrorCode: null,
    deletedAt: null
  }
});

const BACKFILL_OPERATIONAL: Readonly<Record<EncryptedLibrarySurface, UnknownRecord>> =
  Object.freeze({
    space_display: { parentId: null, sortKey: "a0", archivedAt: null, updatedAt: TIME },
    tag_display: { updatedAt: TIME },
    note_content: {
      spaceId: IDS.space,
      type: "generic",
      dailyDate: null,
      isOpen: true,
      privacy: "ai_assisted",
      archivedAt: null,
      deletedAt: null,
      updatedAt: TIME
    },
    note_revision: { ...LIST_OPERATIONAL.note_revision, legacyContentHash: HEX_A },
    organization_decision: {
      captureId: IDS.capture,
      destinationNoteId: IDS.note,
      score: 0.9,
      margin: 0.4,
      reasonCodes: ["explicit_destination"],
      createdAt: TIME
    },
    note_mutation: {
      noteId: IDS.note,
      decisionId: IDS.decision,
      beforeRevision: 1,
      afterRevision: 2,
      idempotencyKey: "mutation-request-1",
      undoneAt: null,
      createdAt: TIME
    },
    generated_block: LIST_OPERATIONAL.generated_block,
    review_item: {
      captureId: IDS.capture,
      noteId: null,
      type: "low_confidence",
      createdAt: TIME,
      resolvedAt: null
    },
    routing_rule: {
      enabled: true,
      ruleType: "prefix",
      destinationNoteId: IDS.note,
      destinationSpaceId: null,
      priority: 100,
      source: "explicit",
      lastFiredAt: null,
      updatedAt: TIME
    },
    organization_mutation_attempt: {
      jobId: IDS.job,
      noteId: IDS.note,
      plannedRevision: 1,
      replanCount: 0,
      state: "applied",
      reviewItemId: null,
      updatedAt: TIME
    },
    idempotency_response: {
      scope: "create_note",
      createdAt: TIME,
      completedAt: TIME,
      replayPolicy: "legacy_nonreplayable"
    },
    capture_receipt: {
      jobId: IDS.job,
      decisionId: IDS.decision,
      reviewItemId: null,
      mutationId: IDS.mutation,
      outcome: "added_to_note",
      destinationNoteId: IDS.note,
      reasonCodes: ["explicit_destination"],
      createdAt: TIME
    },
    capture: {
      source: "web",
      deviceId: "browser-1",
      contentLength: 18,
      clientCreatedAt: TIME,
      clientTimezone: "America/Los_Angeles",
      privacy: "ai_assisted",
      status: "organized"
    }
  });

let wrappingKeys: Readonly<Record<KeyClass, KeyEncryptionKey>>;

beforeAll(async () => {
  wrappingKeys = Object.freeze({
    ai_assisted: await generateKeyEncryptionKey("key_ai_wrap_v1"),
    private_manual: await generateKeyEncryptionKey("key_private_wrap_v1")
  });
});

function rpcHarness(value: unknown) {
  const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(value);
  return { rpc, store: createEncryptedLibraryRpcStore(Object.freeze({ rpc })) };
}

async function envelopeFor(
  surface: EncryptedLibrarySurface,
  resourceId = RESOURCE_BY_SURFACE[surface],
  recordVersion = VERSION_BY_SURFACE[surface],
  ownerId = OWNER_ID,
  keyClass = CLASS_BY_SURFACE[surface]
): Promise<ContentEnvelopeV1> {
  return sealBytes(
    new TextEncoder().encode("encrypted test payload"),
    { tenantId: ownerId, resourceId, recordVersion, kind: surface },
    wrappingKeys[keyClass]
  );
}

function storedMac(keyClass: KeyClass, value = HEX_A): StoredMac {
  return Object.freeze({
    mac: value,
    keyId: keyClass === "private_manual" ? "key_private_mac_v1" : "key_ai_mac_v1",
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: 1
  });
}

function internalMac(keyClass: KeyClass, value = HEX_A): KeyedMacRecord {
  const stored = storedMac(keyClass, value);
  return Object.freeze({
    value: stored.mac,
    keyId: stored.keyId,
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: stored.keyVersion
  });
}

async function libraryRow(
  surface: EncryptedLibrarySurface,
  options: Readonly<{
    resourceId?: string;
    operational?: UnknownRecord;
    keyClass?: KeyClass;
  }> = {}
): Promise<LibraryRow> {
  const resourceId = options.resourceId ?? RESOURCE_BY_SURFACE[surface];
  const recordVersion = VERSION_BY_SURFACE[surface];
  const keyClass = options.keyClass ?? CLASS_BY_SURFACE[surface];
  const envelope = await envelopeFor(surface, resourceId, recordVersion, OWNER_ID, keyClass);
  return Object.freeze({
    resource_id: resourceId,
    record_version: recordVersion,
    operational: options.operational ?? LIST_OPERATIONAL[surface],
    content_cipher: Object.freeze({
      envelope,
      keyId: envelope.keyId,
      keyClass,
      keyPurpose: "object_wrap",
      keyVersion: 1
    }),
    content_mac: (["space_display", "tag_display", "note_revision", "capture"] as const).includes(
      surface as "capture"
    )
      ? storedMac(keyClass)
      : null
  });
}

async function expectedBackfillContent(
  surface: EncryptedLibrarySurface,
  resourceId: string,
  recordVersion: number
): Promise<UnknownRecord> {
  switch (surface) {
    case "space_display":
      return { schemaVersion: 1, name: "Inbox", slug: "inbox" };
    case "tag_display":
      return { schemaVersion: 1, name: "health" };
    case "note_content":
      return {
        schemaVersion: 1,
        title: "A note",
        bodyMarkdown: "Body",
        structuredData: { schemaVersion: 1 }
      };
    case "note_revision":
      return {
        schemaVersion: 1,
        snapshot: NOTE_SNAPSHOT
      };
    case "organization_decision":
      return {
        schemaVersion: 1,
        candidateManifest: { generationId: null, candidates: [] },
        signals: {},
        validatedPlan: null,
        band: "auto"
      };
    case "note_mutation":
      return {
        schemaVersion: 1,
        action: "update",
        beforeRevision: 1,
        afterRevision: 2,
        operations: [{ type: "set_title", title: "A note" }],
        inverse: [{ type: "set_title", title: "Old note" }],
        beforeSnapshot: { ...NOTE_SNAPSHOT, title: "Old note" },
        afterSnapshot: NOTE_SNAPSHOT
      };
    case "generated_block":
      return { schemaVersion: 1, content: "Generated summary" };
    case "review_item":
      return { schemaVersion: 1, choices: [], state: "open", resolution: null };
    case "routing_rule":
      return {
        schemaVersion: 1,
        condition: "grocer",
        normalizedCondition: "grocer",
        aliases: []
      };
    case "organization_mutation_attempt":
      return {
        schemaVersion: 1,
        operations: [{ type: "set_title", title: "A note" }]
      };
    case "idempotency_response":
      return {
        requestHash: HEX_A,
        responseJson: { resourceType: "legacy_response" },
        requestResourceType: "legacy_idempotency",
        requestResourceId: resourceId,
        responseResourceType: "legacy_response",
        responseResourceId: resourceId,
        responseRecordVersion: 1
      };
    case "capture_receipt":
      return {
        schemaVersion: 1,
        captureId: IDS.capture,
        jobId: IDS.job,
        decisionId: IDS.decision,
        reviewItemId: null,
        mutationId: IDS.mutation,
        outcome: "added_to_note",
        headline: "Added to note",
        destination: { noteId: IDS.note, title: "A note" },
        insertedContentReferences: [{ type: "captured", itemId: null }],
        actions: [{ type: "open", noteId: IDS.note }],
        reasonCodes: ["explicit_destination"],
        createdAt: TIME
      };
    case "capture":
      return {
        contentEnvelope: await envelopeFor("capture", resourceId, recordVersion),
        contentFingerprint: HEX_A
      };
  }
}

async function backfillRow(
  surface: EncryptedLibrarySurface,
  options: Readonly<{ resourceId?: string; operational?: UnknownRecord }> = {}
): Promise<BackfillRow> {
  const resourceId = options.resourceId ?? RESOURCE_BY_SURFACE[surface];
  const recordVersion = VERSION_BY_SURFACE[surface];
  return Object.freeze({
    cursor: `${RANK_BY_SURFACE[surface]}:${surface}:${resourceId}`,
    resource_id: resourceId,
    record_version: recordVersion,
    key_class: CLASS_BY_SURFACE[surface],
    expected_content: await expectedBackfillContent(surface, resourceId, recordVersion),
    operational: options.operational ?? BACKFILL_OPERATIONAL[surface]
  });
}

async function sealedCipher<Surface extends EncryptedLibrarySurface>(
  surface: Surface,
  resourceId = RESOURCE_BY_SURFACE[surface],
  recordVersion = VERSION_BY_SURFACE[surface],
  ownerId = OWNER_ID,
  keyClass = CLASS_BY_SURFACE[surface]
): Promise<SealedEncryptedAggregateRecord<Surface>> {
  const envelope = await envelopeFor(surface, resourceId, recordVersion, ownerId, keyClass);
  return Object.freeze({
    ownerId,
    resourceId,
    recordVersion,
    kind: surface,
    envelope,
    keyId: envelope.keyId,
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1,
    reservationId: RESERVATION_ID
  });
}

function expectProviderFailure(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
}

function expectInputFailure(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
}

describe("encrypted library stored-object listing", () => {
  it.each(encryptedLibrarySurfaces)(
    "parses and binds the exact %s row projection",
    async (surface) => {
      const row = await libraryRow(surface);
      const { rpc, store } = rpcHarness([row]);
      const result = await store.listEncryptedLibraryObjects({
        ownerId: OWNER_ID.toUpperCase(),
        surface,
        limit: 2
      });

      expect(rpc).toHaveBeenCalledWith("list_encrypted_library_objects", {
        p_owner_id: OWNER_ID,
        p_surface: surface,
        p_after_resource_id: null,
        p_limit: 2
      });
      expect(result.surface).toBe(surface);
      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        surface,
        ownerId: OWNER_ID,
        resourceId: RESOURCE_BY_SURFACE[surface],
        recordVersion: VERSION_BY_SURFACE[surface],
        encrypted: {
          kind: surface,
          keyClass: CLASS_BY_SURFACE[surface],
          keyPurpose: "object_wrap"
        }
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.items)).toBe(true);
      expect(Object.isFrozen(result.items[0])).toBe(true);
      expect("reservationId" in (result.items[0]?.encrypted ?? {})).toBe(false);
      if (row.content_mac === null) {
        expect(result.items[0]?.contentMac).toBeNull();
      } else {
        expect(result.items[0]?.contentMac?.value).toBe(HEX_A);
      }
    }
  );

  it.each(["ai_assisted", "private_manual"] as const)(
    "accepts %s sticky idempotency history only when request MAC and response cipher agree",
    async (keyClass) => {
      const requestMac = storedMac(keyClass);
      const row = await libraryRow("idempotency_response", {
        keyClass,
        operational: {
          ...LIST_OPERATIONAL.idempotency_response,
          replayPolicy: "logical_mac",
          requestMac
        }
      });
      const { store } = rpcHarness([row]);
      const result = await store.listEncryptedLibraryObjects({
        ownerId: OWNER_ID,
        surface: "idempotency_response"
      });
      expect(result.items[0]?.encrypted.keyClass).toBe(keyClass);
      expect(result.items[0]?.operational.requestMac?.keyClass).toBe(keyClass);

      const mismatched = {
        ...row,
        operational: {
          ...row.operational,
          requestMac: storedMac(keyClass === "ai_assisted" ? "private_manual" : "ai_assisted")
        }
      };
      await expectProviderFailure(
        rpcHarness([mismatched]).store.listEncryptedLibraryObjects({
          ownerId: OWNER_ID,
          surface: "idempotency_response"
        })
      );
    }
  );

  it.each(encryptedLibrarySurfaces)("rejects extra operational keys for %s", async (surface) => {
    const row = await libraryRow(surface, {
      operational: { ...LIST_OPERATIONAL[surface], smuggledContent: "secret" }
    });
    const { store } = rpcHarness([row]);
    await expectProviderFailure(store.listEncryptedLibraryObjects({ ownerId: OWNER_ID, surface }));
  });

  it("enforces bounded, strictly ascending pages and derives the continuation cursor", async () => {
    const first = await libraryRow("note_content");
    const second = await libraryRow("note_content", { resourceId: IDS.noteTwo });
    const good = rpcHarness([first, second]);
    await expect(
      good.store.listEncryptedLibraryObjects({
        ownerId: OWNER_ID,
        surface: "note_content",
        limit: 2
      })
    ).resolves.toMatchObject({ nextCursor: IDS.noteTwo });

    const reversed = rpcHarness([second, first]);
    await expectProviderFailure(
      reversed.store.listEncryptedLibraryObjects({
        ownerId: OWNER_ID,
        surface: "note_content",
        limit: 2
      })
    );

    const oversized = rpcHarness([first, second, second]);
    await expectProviderFailure(
      oversized.store.listEncryptedLibraryObjects({
        ownerId: OWNER_ID,
        surface: "note_content",
        limit: 2
      })
    );
  });

  it("rejects malformed row, cipher, envelope, and MAC projections", async () => {
    const base = await libraryRow("capture");
    const wrongContext = {
      ...base,
      content_cipher: {
        ...base.content_cipher,
        envelope: {
          ...base.content_cipher.envelope,
          context: { ...base.content_cipher.envelope.context, tenantId: OTHER_OWNER_ID }
        }
      }
    };
    const variants: unknown[] = [
      { ...base, extra: true },
      { ...base, content_cipher: { ...base.content_cipher, extra: true } },
      wrongContext,
      { ...base, content_cipher: { ...base.content_cipher, keyId: "key_wrong" } },
      { ...base, content_cipher: { ...base.content_cipher, keyPurpose: "content_mac" } },
      { ...base, content_mac: null },
      { ...base, content_mac: { ...storedMac("ai_assisted"), mac: "bad" } },
      { ...base, content_mac: { ...storedMac("private_manual") } }
    ];
    for (const variant of variants) {
      const { store } = rpcHarness([variant]);
      await expectProviderFailure(
        store.listEncryptedLibraryObjects({ ownerId: OWNER_ID, surface: "capture" })
      );
    }
  });

  it("rejects invalid owners, surfaces, resource cursors, and page limits before RPC", async () => {
    const { rpc, store } = rpcHarness([]);
    await expectInputFailure(
      store.listEncryptedLibraryObjects({ ownerId: "bad", surface: "note_content" })
    );
    await expectInputFailure(
      store.listEncryptedLibraryObjects({
        ownerId: OWNER_ID,
        surface: "note_content",
        afterResourceId: IDS.capture
      })
    );
    await expectInputFailure(
      store.listEncryptedLibraryObjects({ ownerId: OWNER_ID, surface: "note_content", limit: 0 })
    );
    await expectInputFailure(
      store.listEncryptedLibraryObjects({ ownerId: OWNER_ID, surface: "note_content", limit: 51 })
    );
    await expectInputFailure(
      store.listEncryptedLibraryObjects({
        ownerId: OWNER_ID,
        surface: "not_a_surface" as EncryptedLibrarySurface
      })
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("content-encryption backfill candidate listing", () => {
  it.each(encryptedLibrarySurfaces)(
    "strictly parses the surface-discriminated %s candidate",
    async (surface) => {
      const row = await backfillRow(surface);
      const { rpc, store } = rpcHarness([row]);
      const result = await store.listContentEncryptionBackfillCandidates({
        ownerId: OWNER_ID,
        surface,
        limit: 2
      });
      expect(rpc).toHaveBeenCalledWith("list_content_encryption_backfill_candidates", {
        p_owner_id: OWNER_ID,
        p_surface: surface,
        p_after_cursor: null,
        p_limit: 2
      });
      expect(result.items[0]).toMatchObject({
        surface,
        ownerId: OWNER_ID,
        cursor: `${RANK_BY_SURFACE[surface]}:${surface}:${RESOURCE_BY_SURFACE[surface]}`,
        resourceId: RESOURCE_BY_SURFACE[surface],
        recordVersion: VERSION_BY_SURFACE[surface],
        keyClass: CLASS_BY_SURFACE[surface]
      });
      expect(result.nextCursor).toBeNull();
      expect(Object.isFrozen(result.items[0]?.expectedContent)).toBe(true);
      expect(Object.isFrozen(result.items[0]?.operational)).toBe(true);
    }
  );

  it.each(encryptedLibrarySurfaces)("rejects unchecked %s candidate fields", async (surface) => {
    const row = await backfillRow(surface, {
      operational: { ...BACKFILL_OPERATIONAL[surface], unexpected: true }
    });
    const { store } = rpcHarness([row]);
    await expectProviderFailure(
      store.listContentEncryptionBackfillCandidates({ ownerId: OWNER_ID, surface })
    );
  });

  it("binds ranked global cursors and rejects malformed, mismatched, or non-ascending pages", async () => {
    const row = await backfillRow("note_content");
    const malformed = [
      { ...row, cursor: `99:note_content:${IDS.note}` },
      { ...row, cursor: `03:tag_display:${IDS.note}` },
      { ...row, resource_id: IDS.noteTwo },
      { ...row, key_class: "private_manual" },
      { ...row, extra: true }
    ];
    for (const value of malformed) {
      const { store } = rpcHarness([value]);
      await expectProviderFailure(
        store.listContentEncryptionBackfillCandidates({
          ownerId: OWNER_ID,
          surface: "note_content"
        })
      );
    }

    const afterCursor = `03:note_content:${IDS.noteTwo}`;
    const { rpc, store } = rpcHarness([row]);
    await expectProviderFailure(
      store.listContentEncryptionBackfillCandidates({
        ownerId: OWNER_ID,
        surface: "note_content",
        afterCursor
      })
    );
    expect(rpc).toHaveBeenCalledWith("list_content_encryption_backfill_candidates", {
      p_owner_id: OWNER_ID,
      p_surface: "note_content",
      p_after_cursor: afterCursor,
      p_limit: 25
    });
  });

  it("validates candidate cursors and bounds before contacting the provider", async () => {
    const { rpc, store } = rpcHarness([]);
    for (const afterCursor of [
      "bad",
      `99:note_content:${IDS.note}`,
      `03:tag_display:${IDS.tag}`,
      `03:note_content:${IDS.capture}`
    ]) {
      await expectInputFailure(
        store.listContentEncryptionBackfillCandidates({
          ownerId: OWNER_ID,
          surface: "note_content",
          afterCursor
        })
      );
    }
    await expectInputFailure(
      store.listContentEncryptionBackfillCandidates({
        ownerId: OWNER_ID,
        surface: "capture",
        limit: 51
      })
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("backfill mutation RPCs", () => {
  it("maps an exact reserved cipher and verification MAC for atomic commit and replay", async () => {
    const cipher = await sealedCipher("note_content");
    const verificationMac = internalMac("ai_assisted");
    const response = {
      surface: "note_content",
      resourceId: IDS.note,
      recordVersion: 2,
      cursor: `03:note_content:${IDS.note}`,
      complete: false,
      replayed: true
    };
    const { rpc, store } = rpcHarness(response);
    const expectedContent = {
      schemaVersion: 1 as const,
      title: "A note",
      bodyMarkdown: "Body",
      structuredData: { schemaVersion: 1 as const }
    };
    await expect(
      store.commitContentEncryptionBackfill({
        ownerId: OWNER_ID,
        surface: "note_content",
        resourceId: IDS.note,
        expectedRecordVersion: 2,
        expectedContent,
        cipher,
        contentMac: null,
        verificationMac,
        batchReference: "batch-1",
        expectedCursor: null,
        nextCursor: `03:note_content:${IDS.note}`,
        complete: false
      })
    ).resolves.toEqual(response);
    expect(rpc).toHaveBeenCalledWith("commit_content_encryption_backfill", {
      p_owner_id: OWNER_ID,
      p_surface: "note_content",
      p_resource_id: IDS.note,
      p_expected_record_version: 2,
      p_expected_content: expectedContent,
      p_cipher: {
        envelope: cipher.envelope,
        keyId: cipher.keyId,
        keyClass: "ai_assisted",
        keyPurpose: "object_wrap",
        keyVersion: 1,
        reservationId: RESERVATION_ID
      },
      p_content_mac: null,
      p_verification_mac: {
        mac: HEX_A,
        keyId: verificationMac.keyId,
        keyClass: "ai_assisted",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      p_batch_reference: "batch-1",
      p_expected_cursor: null,
      p_next_cursor: `03:note_content:${IDS.note}`,
      p_complete: false
    });
  });

  it("rejects forged commit capabilities, unsafe content, invalid cursors, and capture commits", async () => {
    const cipher = await sealedCipher("note_content");
    const base = {
      ownerId: OWNER_ID,
      surface: "note_content" as const,
      resourceId: IDS.note,
      expectedRecordVersion: 2,
      expectedContent: {
        schemaVersion: 1 as const,
        title: "A note",
        bodyMarkdown: "Body",
        structuredData: { schemaVersion: 1 as const }
      },
      cipher,
      contentMac: null,
      verificationMac: internalMac("ai_assisted"),
      batchReference: "batch-1",
      expectedCursor: null,
      nextCursor: `03:note_content:${IDS.note}`,
      complete: false
    };
    const variants: unknown[] = [
      { ...base, ownerId: "bad" },
      { ...base, resourceId: IDS.noteTwo },
      { ...base, expectedRecordVersion: 3 },
      { ...base, cipher: { ...cipher, reservationId: "forged" } },
      { ...base, cipher: { ...cipher, ownerId: OTHER_OWNER_ID } },
      { ...base, verificationMac: internalMac("private_manual") },
      { ...base, expectedContent: { value: Number.NaN } },
      { ...base, expectedCursor: "cursor-z", nextCursor: "cursor-a" },
      { ...base, complete: true },
      { ...base, batchReference: "" },
      { ...base, surface: "capture" }
    ];
    for (const variant of variants) {
      const { rpc, store } = rpcHarness({});
      await expectInputFailure(
        store.commitContentEncryptionBackfill(
          variant as Parameters<typeof store.commitContentEncryptionBackfill>[0]
        )
      );
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("rejects non-exact or request-mismatched commit responses", async () => {
    const cipher = await sealedCipher("note_content");
    const input = {
      ownerId: OWNER_ID,
      surface: "note_content" as const,
      resourceId: IDS.note,
      expectedRecordVersion: 2,
      expectedContent: {
        schemaVersion: 1 as const,
        title: "A note",
        bodyMarkdown: "Body",
        structuredData: { schemaVersion: 1 as const }
      },
      cipher,
      contentMac: null,
      verificationMac: internalMac("ai_assisted"),
      batchReference: "batch-1",
      expectedCursor: null,
      nextCursor: `03:note_content:${IDS.note}`,
      complete: false
    };
    const valid = {
      surface: "note_content",
      resourceId: IDS.note,
      recordVersion: 2,
      cursor: `03:note_content:${IDS.note}`,
      complete: false,
      replayed: false
    };
    for (const response of [
      { ...valid, extra: true },
      { ...valid, surface: "note_mutation" },
      { ...valid, resourceId: IDS.noteTwo },
      { ...valid, recordVersion: 3 },
      { ...valid, cursor: null },
      { ...valid, complete: true },
      { ...valid, replayed: "false" }
    ]) {
      const { store } = rpcHarness(response);
      await expectProviderFailure(store.commitContentEncryptionBackfill(input));
    }
  });

  it("completes a backfill with exact parameters and strict replay shape", async () => {
    const { rpc, store } = rpcHarness({ complete: true, replayed: true });
    await expect(
      store.completeContentEncryptionBackfill({
        ownerId: OWNER_ID,
        batchReference: "complete-1",
        expectedCursor: `12:capture_receipt:${IDS.capture}`
      })
    ).resolves.toEqual({ complete: true, replayed: true });
    expect(rpc).toHaveBeenCalledWith("complete_content_encryption_backfill", {
      p_owner_id: OWNER_ID,
      p_batch_reference: "complete-1",
      p_expected_cursor: `12:capture_receipt:${IDS.capture}`
    });

    for (const response of [
      { complete: false, replayed: false },
      { complete: true, replayed: "yes" },
      { complete: true, replayed: false, extra: true }
    ]) {
      await expectProviderFailure(
        rpcHarness(response).store.completeContentEncryptionBackfill({
          ownerId: OWNER_ID,
          batchReference: "complete-1",
          expectedCursor: null
        })
      );
    }
  });

  it("advances only the two legal transitions and validates fresh or replay results", async () => {
    for (const [expectedState, nextState, readMode] of [
      ["expanded", "dual_write", "legacy"],
      ["dual_write", "encrypted_read", "encrypted"]
    ] as const) {
      const { rpc, store } = rpcHarness({ state: nextState, readMode, replayed: true });
      await expect(
        store.advanceContentEncryptionRollout({ ownerId: OWNER_ID, expectedState, nextState })
      ).resolves.toEqual({ state: nextState, readMode, replayed: true });
      expect(rpc).toHaveBeenCalledWith("advance_content_encryption_rollout", {
        p_owner_id: OWNER_ID,
        p_expected_state: expectedState,
        p_next_state: nextState
      });
    }

    const invalid = rpcHarness({});
    await expectInputFailure(
      invalid.store.advanceContentEncryptionRollout({
        ownerId: OWNER_ID,
        expectedState: "expanded",
        nextState: "encrypted_read"
      })
    );
    expect(invalid.rpc).not.toHaveBeenCalled();

    for (const response of [
      { state: "expanded", readMode: "legacy", replayed: false },
      { state: "dual_write", readMode: "encrypted", replayed: false },
      { state: "dual_write", readMode: "legacy", replayed: false, extra: true }
    ]) {
      await expectProviderFailure(
        rpcHarness(response).store.advanceContentEncryptionRollout({
          ownerId: OWNER_ID,
          expectedState: "expanded",
          nextState: "dual_write"
        })
      );
    }
  });
});

describe("capture reseal and post-decrypt verification", () => {
  it("reseals a capture with exact legacy CAS and reserved-write shapes", async () => {
    const expectedEnvelope = await envelopeFor("capture");
    const contentCipher = await sealedCipher("capture");
    const contentMac = internalMac("ai_assisted");
    const verificationMac = internalMac("ai_assisted", HEX_B);
    const { rpc, store } = rpcHarness({
      captureId: IDS.capture,
      envelopeDigest: HEX_B,
      replayed: false
    });
    await expect(
      store.resealCaptureContent({
        ownerId: OWNER_ID,
        captureId: IDS.capture,
        expectedEnvelope,
        expectedFingerprint: HEX_A,
        contentCipher,
        contentMac,
        verificationMac
      })
    ).resolves.toEqual({ captureId: IDS.capture, envelopeDigest: HEX_B, replayed: false });
    expect(rpc).toHaveBeenCalledWith("reseal_capture_content", {
      p_owner_id: OWNER_ID,
      p_capture_id: IDS.capture,
      p_expected_envelope: expectedEnvelope,
      p_expected_fingerprint: HEX_A,
      p_content_cipher: {
        envelope: contentCipher.envelope,
        keyId: contentCipher.keyId,
        keyClass: "ai_assisted",
        keyPurpose: "object_wrap",
        keyVersion: 1,
        reservationId: RESERVATION_ID
      },
      p_content_mac: {
        mac: HEX_A,
        keyId: contentMac.keyId,
        keyClass: "ai_assisted",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      p_verification_mac: {
        mac: HEX_B,
        keyId: verificationMac.keyId,
        keyClass: "ai_assisted",
        keyPurpose: "content_mac",
        keyVersion: 1
      }
    });
  });

  it("accepts the compact reseal replay and rejects malformed/mismatched results", async () => {
    const input = {
      ownerId: OWNER_ID,
      captureId: IDS.capture,
      expectedEnvelope: await envelopeFor("capture"),
      expectedFingerprint: HEX_A,
      contentCipher: await sealedCipher("capture"),
      contentMac: internalMac("ai_assisted"),
      verificationMac: internalMac("ai_assisted", HEX_B)
    };
    await expect(
      rpcHarness({ captureId: IDS.capture, replayed: true }).store.resealCaptureContent(input)
    ).resolves.toEqual({
      captureId: IDS.capture,
      envelopeDigest: null,
      replayed: true
    });
    for (const response of [
      { captureId: IDS.note, replayed: true },
      { captureId: IDS.capture, replayed: true, envelopeDigest: HEX_A },
      { captureId: IDS.capture, replayed: false },
      { captureId: IDS.capture, replayed: false, envelopeDigest: "bad" }
    ]) {
      await expectProviderFailure(rpcHarness(response).store.resealCaptureContent(input));
    }
  });

  it("rejects reseal input whose legacy envelope, new cipher, fingerprint, or MAC is unbound", async () => {
    const expectedEnvelope = await envelopeFor("capture");
    const contentCipher = await sealedCipher("capture");
    const base = {
      ownerId: OWNER_ID,
      captureId: IDS.capture,
      expectedEnvelope,
      expectedFingerprint: HEX_A,
      contentCipher,
      contentMac: internalMac("ai_assisted"),
      verificationMac: internalMac("ai_assisted", HEX_B)
    };
    const variants: unknown[] = [
      { ...base, expectedFingerprint: "bad" },
      {
        ...base,
        expectedEnvelope: {
          ...expectedEnvelope,
          context: { ...expectedEnvelope.context, tenantId: OTHER_OWNER_ID }
        }
      },
      { ...base, contentCipher: { ...contentCipher, resourceId: IDS.note } },
      { ...base, contentCipher: { ...contentCipher, reservationId: "forged" } },
      { ...base, contentMac: internalMac("private_manual") },
      { ...base, verificationMac: internalMac("private_manual") }
    ];
    for (const value of variants) {
      const { rpc, store } = rpcHarness({});
      await expectInputFailure(
        store.resealCaptureContent(value as Parameters<typeof store.resealCaptureContent>[0])
      );
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it.each(verifiableEncryptedContentSurfaces)(
    "verifies exact %s envelope state using a keyed canonical MAC",
    async (surface) => {
      const resourceId = RESOURCE_BY_SURFACE[surface];
      const recordVersion = VERSION_BY_SURFACE[surface];
      const expectedEnvelope = await envelopeFor(surface);
      const verificationMac = internalMac(CLASS_BY_SURFACE[surface]);
      const response = {
        surface,
        resourceId,
        recordVersion,
        envelopeDigest: HEX_B,
        replayed: false
      };
      const { rpc, store } = rpcHarness(response);
      await expect(
        store.verifyEncryptedContentObject({
          ownerId: OWNER_ID,
          surface,
          resourceId,
          expectedRecordVersion: recordVersion,
          expectedEnvelope,
          verificationMac
        })
      ).resolves.toEqual(response);
      expect(rpc).toHaveBeenCalledWith("verify_encrypted_content_object", {
        p_owner_id: OWNER_ID,
        p_surface: surface,
        p_resource_id: resourceId,
        p_expected_record_version: recordVersion,
        p_expected_envelope: expectedEnvelope,
        p_verification_mac: {
          mac: HEX_A,
          keyId: verificationMac.keyId,
          keyClass: verificationMac.keyClass,
          keyPurpose: "content_mac",
          keyVersion: 1
        }
      });
    }
  );

  it("fails closed for unsupported verification surfaces, context tampering, and response drift", async () => {
    const envelope = await envelopeFor("note_content");
    const input = {
      ownerId: OWNER_ID,
      surface: "note_content" as const,
      resourceId: IDS.note,
      expectedRecordVersion: 2,
      expectedEnvelope: envelope,
      verificationMac: internalMac("ai_assisted")
    };
    const invalid = rpcHarness({});
    await expectInputFailure(
      invalid.store.verifyEncryptedContentObject({
        ...input,
        surface: "capture" as "note_content"
      })
    );
    await expectInputFailure(
      invalid.store.verifyEncryptedContentObject({
        ...input,
        expectedEnvelope: {
          ...envelope,
          context: { ...envelope.context, recordVersion: 3 }
        }
      })
    );
    expect(invalid.rpc).not.toHaveBeenCalled();

    const valid = {
      surface: "note_content",
      resourceId: IDS.note,
      recordVersion: 2,
      envelopeDigest: HEX_A,
      replayed: true
    };
    for (const response of [
      { ...valid, surface: "note_mutation" },
      { ...valid, resourceId: IDS.noteTwo },
      { ...valid, recordVersion: 3 },
      { ...valid, envelopeDigest: "bad" },
      { ...valid, replayed: "yes" },
      { ...valid, extra: true }
    ]) {
      await expectProviderFailure(rpcHarness(response).store.verifyEncryptedContentObject(input));
    }
  });
});

describe("encrypted library RPC capability allowlist", () => {
  it("is frozen, exact, and duplicate-free", () => {
    expect(encryptedLibraryRpcFunctions).toEqual([
      "list_encrypted_library_objects",
      "list_content_encryption_backfill_candidates",
      "commit_content_encryption_backfill",
      "complete_content_encryption_backfill",
      "advance_content_encryption_rollout",
      "reseal_capture_content",
      "verify_encrypted_content_object"
    ]);
    expect(Object.isFrozen(encryptedLibraryRpcFunctions)).toBe(true);
    expect(new Set(encryptedLibraryRpcFunctions).size).toBe(encryptedLibraryRpcFunctions.length);
  });
});
