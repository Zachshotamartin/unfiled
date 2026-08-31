import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  type AggregateContentKind,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type KeyedMacRecord,
  type NoteMutationPayload,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import type {
  EncryptedNoteMutationRead,
  EncryptedNoteRead,
  EncryptedNoteReadRpcAdapter,
  EncryptedNoteReadSummary,
  EncryptedNoteRevisionRead
} from "./encrypted-note-read-rpc-adapter";
import { EncryptedNoteAggregateRepository } from "./encrypted-note-aggregate-repository";
import type {
  CompletedEncryptedNoteWriteClaim,
  EncryptedNoteRpcAdapter,
  IncompleteEncryptedNoteWriteClaim
} from "./encrypted-note-rpc-adapter";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const TARGET_NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const SPACE = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const PARENT_SPACE = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const TAG = "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const LINK = "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const REVISION = "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const ORIGINAL_REVISION = "rev_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const ORIGINAL_MUTATION = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const CREATED_AT = "2026-08-28T12:00:00.000Z";
const UPDATED_AT = "2026-08-29T12:00:00.000Z";
const CLAIM_TIME = "2026-08-30T22:54:12.345Z";
const MAC_VALUE = "a".repeat(64);
const REVISION_MAC_VALUE = "b".repeat(64);

function envelope(
  kind: AggregateContentKind,
  resourceId: string,
  recordVersion: number
): ContentEnvelopeV1 {
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: "private-wrap-v1",
    context: Object.freeze({
      tenantId: OWNER,
      resourceId,
      recordVersion,
      kind
    }),
    wrappedDataKey: Object.freeze({ nonce: "A".repeat(16), ciphertext: "a".repeat(64) }),
    payload: Object.freeze({ nonce: "B".repeat(16), ciphertext: "b".repeat(64) })
  });
}

function encrypted<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  recordVersion: number,
  keyClass: "ai_assisted" | "private_manual" = "private_manual"
): EncryptedAggregateRecord<Kind> {
  return Object.freeze({
    ownerId: OWNER,
    resourceId,
    recordVersion,
    kind,
    envelope: envelope(kind, resourceId, recordVersion),
    keyId: `${keyClass}-wrap-v1`,
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1
  });
}

function sealed<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  recordVersion: number,
  keyClass: "ai_assisted" | "private_manual" = "private_manual"
): SealedEncryptedAggregateRecord<Kind> {
  return Object.freeze({
    ...encrypted(kind, resourceId, recordVersion, keyClass),
    reservationId: `reservation:${kind}:${resourceId}:${String(recordVersion)}`
  });
}

function mac(
  keyClass: "ai_assisted" | "private_manual" = "private_manual",
  value = MAC_VALUE
): KeyedMacRecord {
  return Object.freeze({
    value,
    keyId: `${keyClass}-mac-v1`,
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: 1
  });
}

function snapshot(
  input: Readonly<{
    privacy?: "ai_assisted" | "private_manual";
    revision?: number;
    archivedAt?: string | null;
    deletedAt?: string | null;
    links?: readonly Readonly<{
      linkType: "reference" | "related";
      toNoteId: typeof NOTE | typeof TARGET_NOTE;
    }>[];
    tagIds?: readonly (typeof TAG)[];
  }> = {}
) {
  return {
    spaceId: null,
    type: "generic" as const,
    title: "Roosevelt method",
    bodyMarkdown: "Commit publicly, then solve the details.",
    structuredData: { schemaVersion: 1 as const },
    isOpen: true,
    pinnedAt: null,
    privacy: input.privacy ?? ("ai_assisted" as const),
    archivedAt: input.archivedAt ?? null,
    deletedAt: input.deletedAt ?? null,
    tagIds: [...(input.tagIds ?? [])],
    links: (input.links ?? []).map((link) => ({ ...link }))
  };
}

function summary(
  input: Readonly<{
    privacy?: "ai_assisted" | "private_manual";
    currentRevision?: number;
    archivedAt?: string | null;
    deletedAt?: string | null;
  }> = {}
): EncryptedNoteReadSummary {
  const privacy = input.privacy ?? "ai_assisted";
  const currentRevision = input.currentRevision ?? 3;
  return Object.freeze({
    noteId: NOTE,
    currentRevision,
    spaceId: null,
    type: "generic",
    dailyDate: null,
    isOpen: true,
    pinnedAt: null,
    privacy,
    archivedAt: input.archivedAt ?? null,
    deletedAt: input.deletedAt ?? null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    contentCipher: encrypted("note_content", NOTE, currentRevision, privacy)
  });
}

function detail(
  input: Readonly<{
    privacy?: "ai_assisted" | "private_manual";
    currentRevision?: number;
    archivedAt?: string | null;
    deletedAt?: string | null;
  }> = {}
): EncryptedNoteRead {
  return Object.freeze({
    ...summary(input),
    space: null,
    tags: [],
    links: []
  });
}

function repository(
  input: Readonly<{
    aggregate: EncryptedAggregateService;
    reads: EncryptedNoteReadRpcAdapter;
    writes?: EncryptedNoteRpcAdapter;
  }>
): EncryptedNoteAggregateRepository {
  const unexpectedWrites = Object.freeze({
    getWriteClaim: vi.fn(() => Promise.reject(new Error("unexpected write"))),
    prepareWrite: vi.fn(() => Promise.reject(new Error("unexpected write"))),
    createNote: vi.fn(() => Promise.reject(new Error("unexpected write"))),
    applyMutation: vi.fn(() => Promise.reject(new Error("unexpected write")))
  }) satisfies EncryptedNoteRpcAdapter;
  return new EncryptedNoteAggregateRepository({
    ownerId: OWNER,
    access: authorizeAggregateOwner({ authenticatedOwnerId: OWNER, resourceOwnerId: OWNER }),
    aggregate: input.aggregate,
    reads: input.reads,
    writes: input.writes ?? unexpectedWrites
  });
}

function readHarness() {
  const row = Object.freeze({
    ...summary({ privacy: "private_manual", currentRevision: 7 }),
    spaceId: SPACE,
    dailyDate: "2026-08-30",
    space: Object.freeze({
      spaceId: SPACE,
      currentRevision: 4,
      parentId: PARENT_SPACE,
      displayCipher: encrypted("space_display", SPACE, 4),
      parent: Object.freeze({
        spaceId: PARENT_SPACE,
        currentRevision: 2,
        displayCipher: encrypted("space_display", PARENT_SPACE, 2)
      })
    }),
    tags: [
      Object.freeze({
        tagId: TAG,
        currentRevision: 5,
        createdAt: CREATED_AT,
        displayCipher: encrypted("tag_display", TAG, 5)
      })
    ],
    links: [
      Object.freeze({
        linkId: LINK,
        toNoteId: TARGET_NOTE,
        linkType: "reference" as const,
        source: "manual" as const,
        targetType: "generic" as const,
        targetPrivacy: "ai_assisted" as const,
        targetRevision: 9,
        targetContentCipher: encrypted("note_content", TARGET_NOTE, 9, "ai_assisted")
      })
    ]
  }) satisfies EncryptedNoteRead;
  const openNoteContent = vi.fn<EncryptedAggregateService["openNoteContent"]>(
    (_access, _record, expected) =>
      Promise.resolve(
        expected.noteId === NOTE
          ? Object.freeze({
              schemaVersion: 1 as const,
              title: "Roosevelt method",
              bodyMarkdown: "Commit publicly, then solve the details.",
              structuredData: Object.freeze({ schemaVersion: 1 as const })
            })
          : Object.freeze({
              schemaVersion: 1 as const,
              title: "Related principle",
              bodyMarkdown: "A related note",
              structuredData: Object.freeze({ schemaVersion: 1 as const })
            })
      )
  );
  const openSpaceDisplay = vi.fn<EncryptedAggregateService["openSpaceDisplay"]>(
    (_access, _record, expected) =>
      Promise.resolve(
        Object.freeze({
          schemaVersion: 1 as const,
          name: expected.spaceId === SPACE ? "Mindset" : "Goals",
          slug: expected.spaceId === SPACE ? "mindset" : "goals"
        })
      )
  );
  const openTagDisplay = vi.fn<EncryptedAggregateService["openTagDisplay"]>(() =>
    Promise.resolve(Object.freeze({ schemaVersion: 1 as const, name: "Commitment devices" }))
  );
  const aggregate = {
    openNoteContent,
    openSpaceDisplay,
    openTagDisplay
  } as unknown as EncryptedAggregateService;
  const reads = Object.freeze({
    getNote: vi.fn(() => Promise.resolve(row)),
    listNotes: vi.fn(() => Promise.resolve({ notes: [], nextCursor: null })),
    listRevisions: vi.fn(() => Promise.resolve({ revisions: [], nextRevision: null })),
    getMutation: vi.fn(() => Promise.reject(new Error("unexpected mutation read")))
  }) satisfies EncryptedNoteReadRpcAdapter;
  return { aggregate, reads, row, openNoteContent, openSpaceDisplay, openTagDisplay };
}

type WriteHarnessOptions = Readonly<{
  currentPrivacy?: "ai_assisted" | "private_manual";
  currentRevision?: number;
  archivedAt?: string | null;
  deletedAt?: string | null;
  links?: readonly Readonly<{
    id: typeof LINK;
    linkType: "reference" | "related";
    toNoteId: typeof TARGET_NOTE;
  }>[];
  existingClaim?: CompletedEncryptedNoteWriteClaim;
  replayResponse?: ReturnType<typeof storedResponse>;
  mutationRow?: EncryptedNoteMutationRead;
  mutationPayload?: NoteMutationPayload;
}>;

function storedResponse(
  input: Readonly<{
    privacy?: "ai_assisted" | "private_manual";
    currentRevision?: number;
    archivedAt?: string | null;
    deletedAt?: string | null;
  }> = {}
) {
  const currentRevision = input.currentRevision ?? 4;
  const noteSnapshot = snapshot({
    ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
    ...(input.archivedAt === undefined ? {} : { archivedAt: input.archivedAt }),
    ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt })
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    note: Object.freeze({
      id: NOTE,
      ...noteSnapshot,
      currentRevision,
      createdAt: CREATED_AT,
      updatedAt: CLAIM_TIME
    }),
    revision: Object.freeze({
      id: REVISION,
      noteId: NOTE,
      ...noteSnapshot,
      revision: currentRevision,
      source: "manual" as const,
      contentHash: REVISION_MAC_VALUE,
      actor: "user:manual",
      createdAt: CLAIM_TIME
    }),
    mutationId: MUTATION,
    undo: Object.freeze({ eligible: true, expiresAt: null })
  });
}

function writeHarness(options: WriteHarnessOptions = {}) {
  const currentPrivacy = options.currentPrivacy ?? "ai_assisted";
  const currentRevision = options.currentRevision ?? 3;
  const currentRow = Object.freeze({
    ...detail({
      privacy: currentPrivacy,
      currentRevision,
      ...(options.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
      ...(options.deletedAt === undefined ? {} : { deletedAt: options.deletedAt })
    }),
    links: (options.links ?? []).map((link) =>
      Object.freeze({
        linkId: link.id,
        toNoteId: link.toNoteId,
        linkType: link.linkType,
        source: "manual" as const,
        targetType: "generic" as const,
        targetPrivacy: "ai_assisted" as const,
        targetRevision: 1,
        targetContentCipher: encrypted("note_content", link.toNoteId, 1, "ai_assisted")
      })
    )
  }) satisfies EncryptedNoteRead;
  const payloads = new Map<string, unknown>();
  const payloadKey = (
    record: Readonly<{ kind: string; resourceId: string; recordVersion: number }>
  ) => `${record.kind}:${record.resourceId}:${String(record.recordVersion)}`;
  payloads.set(
    payloadKey(currentRow.contentCipher),
    Object.freeze({
      schemaVersion: 1 as const,
      title: "Roosevelt method",
      bodyMarkdown: "Commit publicly, then solve the details.",
      structuredData: Object.freeze({ schemaVersion: 1 as const })
    })
  );
  for (const link of currentRow.links) {
    payloads.set(
      payloadKey(link.targetContentCipher),
      Object.freeze({
        schemaVersion: 1 as const,
        title: "Related principle",
        bodyMarkdown: "Related",
        structuredData: Object.freeze({ schemaVersion: 1 as const })
      })
    );
  }

  let lastResponse: unknown = options.replayResponse ?? null;
  let responseCipher = sealed("idempotency_response", "idempotency:pending", 1);

  const createIdempotencyRequestMac = vi.fn<
    EncryptedAggregateService["createIdempotencyRequestMac"]
  >((_access, input) => {
    const keyClass =
      input.transition.before === "private_manual" || input.transition.after === "private_manual"
        ? "private_manual"
        : "ai_assisted";
    return Promise.resolve(mac(keyClass));
  });
  const sealNoteContent = vi.fn<EncryptedAggregateService["sealNoteContent"]>((_access, input) => {
    const record = sealed("note_content", input.noteId, input.currentRevision, input.privacy);
    payloads.set(payloadKey(record), input.payload);
    return Promise.resolve(record);
  });
  const sealNoteRevision = vi.fn<EncryptedAggregateService["sealNoteRevision"]>(
    (_access, input) => {
      const keyClass =
        input.transition.before === "private_manual" || input.transition.after === "private_manual"
          ? "private_manual"
          : "ai_assisted";
      const record = sealed("note_revision", input.revisionId, input.revision, keyClass);
      payloads.set(payloadKey(record), input.payload);
      return Promise.resolve(
        Object.freeze({ encrypted: record, contentMac: mac(keyClass, REVISION_MAC_VALUE) })
      );
    }
  );
  const sealNoteMutation = vi.fn<EncryptedAggregateService["sealNoteMutation"]>(
    (_access, input) => {
      const keyClass =
        input.payload.beforeSnapshot?.privacy === "private_manual" ||
        input.payload.afterSnapshot.privacy === "private_manual"
          ? "private_manual"
          : "ai_assisted";
      const record = sealed("note_mutation", input.mutationId, input.afterRevision, keyClass);
      payloads.set(payloadKey(record), input.payload);
      return Promise.resolve(record);
    }
  );
  const sealIdempotencyResponse = vi.fn<EncryptedAggregateService["sealIdempotencyResponse"]>(
    (_access, input) => {
      const keyClass =
        input.transition.before === "private_manual" || input.transition.after === "private_manual"
          ? "private_manual"
          : "ai_assisted";
      lastResponse = input.response;
      responseCipher = sealed("idempotency_response", "idempotency:pending", 1, keyClass);
      return Promise.resolve(responseCipher);
    }
  );
  const openNoteContent = vi.fn<EncryptedAggregateService["openNoteContent"]>((_access, record) =>
    Promise.resolve(
      payloads.get(payloadKey(record as EncryptedAggregateRecord<"note_content">)) as never
    )
  );
  const openNoteRevision = vi.fn<EncryptedAggregateService["openNoteRevision"]>((_access, record) =>
    Promise.resolve(
      payloads.get(payloadKey(record as EncryptedAggregateRecord<"note_revision">)) as never
    )
  );
  const openNoteMutation = vi.fn<EncryptedAggregateService["openNoteMutation"]>(
    (_access, record) => {
      if (
        options.mutationPayload !== undefined &&
        (record as { resourceId?: string }).resourceId === ORIGINAL_MUTATION
      ) {
        return Promise.resolve(options.mutationPayload);
      }
      return Promise.resolve(
        payloads.get(payloadKey(record as EncryptedAggregateRecord<"note_mutation">)) as never
      );
    }
  );
  const openIdempotencyResponse = vi.fn<EncryptedAggregateService["openIdempotencyResponse"]>(() =>
    Promise.resolve(lastResponse as never)
  );
  const aggregate = {
    createIdempotencyRequestMac,
    sealNoteContent,
    sealNoteRevision,
    sealNoteMutation,
    sealIdempotencyResponse,
    openNoteContent,
    openNoteRevision,
    openNoteMutation,
    openIdempotencyResponse,
    createAggregateVerificationMac: vi.fn((_access, input: { surface: string }) =>
      Promise.resolve(
        mac(
          input.surface === "note_content" && currentPrivacy === "ai_assisted"
            ? "ai_assisted"
            : "private_manual"
        )
      )
    ),
    verifyAggregateVerificationMac: vi.fn(() => Promise.resolve(true)),
    openSpaceDisplay: vi.fn(() => Promise.reject(new Error("unexpected space read"))),
    openTagDisplay: vi.fn(() => Promise.reject(new Error("unexpected tag read")))
  } as unknown as EncryptedAggregateService;

  const claimFor = (
    input: Parameters<EncryptedNoteRpcAdapter["prepareWrite"]>[0]
  ): IncompleteEncryptedNoteWriteClaim => {
    const sourcePrivacy = input.scope === "create_encrypted_note" ? null : currentPrivacy;
    const keyClass =
      sourcePrivacy === "private_manual" || input.targetPrivacy === "private_manual"
        ? "private_manual"
        : "ai_assisted";
    return Object.freeze({
      ownerId: OWNER,
      idempotencyKey: input.idempotencyKey,
      scope: input.scope,
      noteId: input.noteId ?? NOTE,
      expectedRevision: input.expectedRevision,
      sourcePrivacy,
      targetPrivacy: input.targetPrivacy,
      historyKeyClass: keyClass,
      revisionId: REVISION,
      mutationId: MUTATION,
      occurredAt: CLAIM_TIME,
      requestMacKey: Object.freeze({
        keyId: `${keyClass}-mac-v1`,
        keyClass,
        keyPurpose: "content_mac",
        keyVersion: 1
      }),
      completed: false,
      encryptedResponse: null
    });
  };
  const getWriteClaim = vi.fn<EncryptedNoteRpcAdapter["getWriteClaim"]>(() =>
    Promise.resolve(options.existingClaim ?? null)
  );
  const prepareWrite = vi.fn<EncryptedNoteRpcAdapter["prepareWrite"]>((input) => {
    if (options.existingClaim !== undefined) {
      return Promise.resolve({ claim: options.existingClaim, replayed: true });
    }
    return Promise.resolve({ claim: claimFor(input), replayed: false });
  });
  const submit = (input: Parameters<EncryptedNoteRpcAdapter["applyMutation"]>[0]) => {
    const cipher = input.command.responseCipher;
    return Promise.resolve({
      noteId: input.claim.noteId,
      mutationId: input.claim.mutationId,
      currentRevision: input.claim.expectedRevision + 1,
      encryptedResponse: Object.freeze({
        envelope: cipher.envelope,
        keyId: cipher.keyId,
        keyClass: cipher.keyClass,
        keyPurpose: cipher.keyPurpose,
        keyVersion: cipher.keyVersion
      }),
      replayed: false,
      indexJobCount: 0
    });
  };
  const createNote = vi.fn<EncryptedNoteRpcAdapter["createNote"]>(submit);
  const applyMutation = vi.fn<EncryptedNoteRpcAdapter["applyMutation"]>(submit);
  const writes = Object.freeze({ getWriteClaim, prepareWrite, createNote, applyMutation });
  const reads = Object.freeze({
    getNote: vi.fn(() => Promise.resolve(currentRow)),
    listNotes: vi.fn(() => Promise.resolve({ notes: [], nextCursor: null })),
    listRevisions: vi.fn(() => Promise.resolve({ revisions: [], nextRevision: null })),
    getMutation: vi.fn(() =>
      options.mutationRow === undefined
        ? Promise.reject(new Error("unexpected mutation read"))
        : Promise.resolve(options.mutationRow)
    )
  }) satisfies EncryptedNoteReadRpcAdapter;
  return {
    repository: repository({ aggregate, reads, writes }),
    aggregate,
    reads,
    writes,
    createIdempotencyRequestMac,
    sealNoteContent,
    sealNoteRevision,
    sealNoteMutation,
    sealIdempotencyResponse,
    openNoteContent,
    openNoteMutation,
    openIdempotencyResponse,
    createNote,
    applyMutation
  };
}

describe("encrypted note aggregate repository", () => {
  it("hydrates encrypted note context for content, taxonomy, and linked titles", async () => {
    const harness = readHarness();
    const result = await repository(harness).getNote(NOTE);

    expect(result).toMatchObject({
      id: NOTE,
      title: "Roosevelt method",
      spaceId: SPACE,
      spacePath: "Goals / Mindset",
      tagIds: [TAG],
      tags: [{ id: TAG, name: "Commitment devices", currentRevision: 5 }],
      links: [
        {
          id: LINK,
          fromNoteId: NOTE,
          toNoteId: TARGET_NOTE,
          linkType: "reference",
          targetTitle: "Related principle"
        }
      ]
    });
    expect(harness.openNoteContent.mock.calls.map((call) => call[2])).toEqual([
      { noteId: NOTE, currentRevision: 7, privacy: "private_manual" },
      { noteId: TARGET_NOTE, currentRevision: 9, privacy: "ai_assisted" }
    ]);
    expect(harness.openSpaceDisplay.mock.calls.map((call) => call[2])).toEqual([
      { spaceId: SPACE, currentRevision: 4 },
      { spaceId: PARENT_SPACE, currentRevision: 2 }
    ]);
    expect(harness.openTagDisplay).toHaveBeenCalledWith(
      expect.anything(),
      harness.row.tags[0]?.displayCipher,
      { tagId: TAG, currentRevision: 5 }
    );
  });

  it("uses the encrypted revision context and exposes only its keyed content MAC", async () => {
    const noteSnapshot = snapshot({ privacy: "ai_assisted" });
    const revisionRow = Object.freeze({
      revisionId: ORIGINAL_REVISION,
      noteId: NOTE,
      revision: 2,
      source: "manual" as const,
      spaceId: null,
      type: "generic" as const,
      isOpen: true,
      pinnedAt: null,
      privacy: "ai_assisted" as const,
      archivedAt: null,
      deletedAt: null,
      actor: "user:manual",
      mutationId: ORIGINAL_MUTATION,
      createdAt: UPDATED_AT,
      snapshotCipher: encrypted("note_revision", ORIGINAL_REVISION, 2, "private_manual"),
      snapshotMac: mac("private_manual", REVISION_MAC_VALUE)
    }) satisfies EncryptedNoteRevisionRead;
    const openNoteRevision = vi.fn<EncryptedAggregateService["openNoteRevision"]>(() =>
      Promise.resolve(Object.freeze({ schemaVersion: 1 as const, snapshot: noteSnapshot }))
    );
    const reads = Object.freeze({
      getNote: vi.fn(() => Promise.reject(new Error("unexpected detail read"))),
      listNotes: vi.fn(() => Promise.resolve({ notes: [], nextCursor: null })),
      listRevisions: vi.fn(() => Promise.resolve({ revisions: [revisionRow], nextRevision: null })),
      getMutation: vi.fn(() => Promise.reject(new Error("unexpected mutation read")))
    }) satisfies EncryptedNoteReadRpcAdapter;
    const aggregate = { openNoteRevision } as unknown as EncryptedAggregateService;

    const [revision] = await repository({ aggregate, reads }).listRevisions(NOTE);

    expect(openNoteRevision).toHaveBeenCalledWith(expect.anything(), revisionRow.snapshotCipher, {
      revisionId: ORIGINAL_REVISION,
      revision: 2,
      transition: { before: "private_manual", after: "ai_assisted" }
    });
    expect(revision?.contentHash).toBe(REVISION_MAC_VALUE);
  });

  it("validates revision pagination and fails closed at the bounded scan limit", async () => {
    const revisionRow = Object.freeze({
      revisionId: ORIGINAL_REVISION,
      noteId: NOTE,
      revision: 2,
      source: "manual" as const,
      spaceId: null,
      type: "generic" as const,
      isOpen: true,
      pinnedAt: null,
      privacy: "ai_assisted" as const,
      archivedAt: null,
      deletedAt: null,
      actor: "user:manual",
      mutationId: ORIGINAL_MUTATION,
      createdAt: UPDATED_AT,
      snapshotCipher: encrypted("note_revision", ORIGINAL_REVISION, 2, "ai_assisted"),
      snapshotMac: mac("ai_assisted", REVISION_MAC_VALUE)
    }) satisfies EncryptedNoteRevisionRead;
    const listRevisions = vi.fn<EncryptedNoteReadRpcAdapter["listRevisions"]>((input) => {
      const limit = input.limit ?? 25;
      return Promise.resolve({
        revisions: Array.from({ length: limit }, () => revisionRow),
        nextRevision: (input.afterRevision ?? 0) + limit
      });
    });
    const reads = Object.freeze({
      getNote: vi.fn(() => Promise.reject(new Error("unexpected detail read"))),
      listNotes: vi.fn(() => Promise.resolve({ notes: [], nextCursor: null })),
      listRevisions,
      getMutation: vi.fn(() => Promise.reject(new Error("unexpected mutation read")))
    }) satisfies EncryptedNoteReadRpcAdapter;
    const subject = repository({ aggregate: {} as EncryptedAggregateService, reads });

    await expect(subject.listRevisions(NOTE, { limit: 1.5, offset: 0 })).rejects.toMatchObject({
      code: "validation_failed"
    });
    await expect(
      subject.listRevisions(NOTE, { limit: 2, offset: Number.MAX_SAFE_INTEGER })
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(subject.listRevisions(NOTE, { limit: 1, offset: 1_000 })).rejects.toMatchObject({
      code: "provider_unavailable"
    });
    expect(listRevisions).toHaveBeenCalledTimes(20);
    expect(listRevisions.mock.calls.every(([input]) => input.limit === 50)).toBe(true);
  });

  it("fails closed when a read projection supplies another owner's ciphertext", async () => {
    const otherOwner = "22222222-2222-4222-8222-222222222222";
    const otherOwnerCipher = Object.freeze({
      ...encrypted("note_content", NOTE, 3, "private_manual"),
      ownerId: otherOwner
    });
    const row = Object.freeze({
      ...detail({ privacy: "private_manual", currentRevision: 3 }),
      contentCipher: otherOwnerCipher
    }) satisfies EncryptedNoteRead;
    const openNoteContent = vi.fn<EncryptedAggregateService["openNoteContent"]>(
      (_access, record) =>
        (record as { ownerId?: string }).ownerId === OWNER
          ? Promise.resolve({
              schemaVersion: 1,
              title: "Must not escape",
              bodyMarkdown: "Must not escape",
              structuredData: { schemaVersion: 1 }
            })
          : Promise.reject(new Error("owner mismatch"))
    );
    const reads = Object.freeze({
      getNote: vi.fn(() => Promise.resolve(row)),
      listNotes: vi.fn(() => Promise.resolve({ notes: [], nextCursor: null })),
      listRevisions: vi.fn(() => Promise.resolve({ revisions: [], nextRevision: null })),
      getMutation: vi.fn(() => Promise.reject(new Error("unexpected mutation read")))
    }) satisfies EncryptedNoteReadRpcAdapter;

    await expect(
      repository({
        aggregate: { openNoteContent } as unknown as EncryptedAggregateService,
        reads
      }).getNote(NOTE)
    ).rejects.toThrow("owner mismatch");
    expect(reads.getNote).toHaveBeenCalledWith({ ownerId: OWNER, noteId: NOTE });
  });

  it("uses server-claimed IDs and timestamp and returns the keyed revision MAC", async () => {
    const harness = writeHarness();
    const result = await harness.repository.createNote(
      {
        title: "Inbox thought",
        type: "generic",
        spaceId: null,
        privacy: "private_manual",
        bodyMarkdown: "Write it now",
        tagIds: [],
        links: []
      },
      "create-server-claim"
    );

    expect(harness.createNote).toHaveBeenCalledOnce();
    const submitted = harness.createNote.mock.calls[0]?.[0];
    expect(submitted?.claim).toMatchObject({
      noteId: NOTE,
      revisionId: REVISION,
      mutationId: MUTATION,
      occurredAt: CLAIM_TIME
    });
    expect(submitted?.command).toMatchObject({
      occurredAt: CLAIM_TIME,
      revision: { id: REVISION },
      mutation: { id: MUTATION }
    });
    expect(result.note).toMatchObject({
      id: NOTE,
      createdAt: CLAIM_TIME,
      updatedAt: CLAIM_TIME
    });
    expect(result.revision).toMatchObject({
      id: REVISION,
      createdAt: CLAIM_TIME,
      contentHash: REVISION_MAC_VALUE
    });
  });

  it("submits protected aggregate payloads only as ciphertext records", async () => {
    const harness = writeHarness();
    await harness.repository.createNote(
      {
        title: "Unique protected title",
        type: "generic",
        spaceId: null,
        privacy: "private_manual",
        bodyMarkdown: "Unique protected body",
        tagIds: [],
        links: []
      },
      "ciphertext-only-protected-fields"
    );

    const command = harness.createNote.mock.calls[0]?.[0].command;
    const protectedRecords = {
      note: command?.noteCipher,
      revision: command?.revision.cipher,
      mutation: command?.mutation.cipher,
      response: command?.responseCipher
    };
    const serialized = JSON.stringify(protectedRecords);
    expect(serialized).not.toContain("Unique protected title");
    expect(serialized).not.toContain("Unique protected body");
    expect(protectedRecords.note).toMatchObject({
      keyId: "private_manual-wrap-v1",
      keyClass: "private_manual",
      keyPurpose: "object_wrap",
      keyVersion: 1
    });
    expect(protectedRecords.note?.envelope).toBeDefined();
    expect(typeof protectedRecords.note?.reservationId).toBe("string");
    expect(Object.keys(protectedRecords.revision ?? {}).sort()).toEqual([
      "envelope",
      "keyClass",
      "keyId",
      "keyPurpose",
      "keyVersion",
      "reservationId"
    ]);
    expect(Object.keys(protectedRecords.mutation ?? {}).sort()).toEqual([
      "envelope",
      "keyClass",
      "keyId",
      "keyPurpose",
      "keyVersion",
      "reservationId"
    ]);
  });

  it("binds an ai-to-private transition into request, revision, and response cryptography", async () => {
    const harness = writeHarness({ currentPrivacy: "ai_assisted" });
    await harness.repository.updateNote(
      NOTE,
      { expectedRevision: 3, privacy: "private_manual" },
      "privacy-transition"
    );

    expect(harness.createIdempotencyRequestMac.mock.calls[0]?.[1]).toMatchObject({
      transition: { before: "ai_assisted", after: "private_manual" },
      logicalRequest: {
        scope: "apply_encrypted_note_mutation",
        targetResourceId: NOTE,
        expectedRevision: 3,
        payload: {
          action: "apply_operations",
          operations: [{ type: "set_privacy", privacy: "private_manual" }]
        }
      }
    });
    expect(harness.sealNoteRevision.mock.calls[0]?.[1]).toMatchObject({
      transition: { before: "ai_assisted", after: "private_manual" }
    });
    expect(harness.sealIdempotencyResponse.mock.calls[0]?.[1]).toMatchObject({
      transition: { before: "ai_assisted", after: "private_manual" }
    });
    expect(harness.applyMutation.mock.calls[0]?.[0].command.noteState.privacy).toBe(
      "private_manual"
    );
  });

  it.each([
    {
      name: "archive true",
      run: (repo: EncryptedNoteAggregateRepository) =>
        repo.archiveNote(NOTE, {
          expectedRevision: 3,
          idempotencyKey: "archive-true",
          archived: true
        }),
      intent: { action: "archive", archived: true },
      state: { archivedAt: CLAIM_TIME }
    },
    {
      name: "archive false",
      options: { archivedAt: UPDATED_AT },
      run: (repo: EncryptedNoteAggregateRepository) =>
        repo.archiveNote(NOTE, {
          expectedRevision: 3,
          idempotencyKey: "archive-false",
          archived: false
        }),
      intent: { action: "archive", archived: false },
      state: { archivedAt: null }
    },
    {
      name: "delete",
      run: (repo: EncryptedNoteAggregateRepository) =>
        repo.deleteNote(NOTE, { expectedRevision: 3, idempotencyKey: "delete" }),
      intent: { action: "delete_note" },
      state: { deletedAt: CLAIM_TIME }
    },
    {
      name: "restore deleted",
      options: { deletedAt: UPDATED_AT },
      run: (repo: EncryptedNoteAggregateRepository) =>
        repo.restoreDeletedNote(NOTE, { expectedRevision: 3, idempotencyKey: "restore" }),
      intent: { action: "restore_deleted" },
      state: { deletedAt: null }
    },
    {
      name: "create link identity",
      run: (repo: EncryptedNoteAggregateRepository) =>
        repo.createLink(NOTE, {
          expectedRevision: 3,
          idempotencyKey: "create-link",
          linkType: "related",
          toNoteId: TARGET_NOTE
        }),
      intent: { action: "create_link", linkType: "related", toNoteId: TARGET_NOTE },
      state: {}
    },
    {
      name: "delete link identity",
      options: {
        links: [{ id: LINK, linkType: "reference" as const, toNoteId: TARGET_NOTE }]
      },
      run: (repo: EncryptedNoteAggregateRepository) =>
        repo.deleteLink(NOTE, LINK, {
          expectedRevision: 3,
          idempotencyKey: "delete-link",
          linkType: "reference",
          toNoteId: TARGET_NOTE
        }),
      intent: {
        action: "delete_link",
        linkId: LINK,
        linkType: "reference",
        toNoteId: TARGET_NOTE
      },
      state: {}
    }
  ])("MACs the exact semantic intent for $name", async ({ options, run, intent, state }) => {
    const harness = writeHarness(options);
    await run(harness.repository);

    expect(harness.createIdempotencyRequestMac.mock.calls[0]?.[1].logicalRequest.payload).toEqual(
      intent
    );
    expect(harness.applyMutation.mock.calls[0]?.[0].command.noteState).toMatchObject(state);
    expect(harness.applyMutation.mock.calls[0]?.[0].command.occurredAt).toBe(CLAIM_TIME);
  });

  it("replays a completed semantic request without reading or rebuilding the note", async () => {
    const response = storedResponse({ archivedAt: CLAIM_TIME });
    const responseEnvelope = envelope("idempotency_response", "idempotency:archive-replay", 1);
    const existingClaim: CompletedEncryptedNoteWriteClaim = Object.freeze({
      ownerId: OWNER,
      idempotencyKey: "archive-replay",
      scope: "apply_encrypted_note_mutation",
      noteId: NOTE,
      expectedRevision: 3,
      sourcePrivacy: "ai_assisted",
      targetPrivacy: "ai_assisted",
      historyKeyClass: "ai_assisted",
      revisionId: REVISION,
      mutationId: MUTATION,
      occurredAt: CLAIM_TIME,
      requestMacKey: Object.freeze({
        keyId: "ai_assisted-mac-v1",
        keyClass: "ai_assisted",
        keyPurpose: "content_mac",
        keyVersion: 1
      }),
      completed: true,
      encryptedResponse: Object.freeze({
        envelope: responseEnvelope,
        keyId: "ai_assisted-wrap-v1",
        keyClass: "ai_assisted",
        keyPurpose: "object_wrap",
        keyVersion: 1
      })
    });
    const harness = writeHarness({ existingClaim, replayResponse: response });

    const result = await harness.repository.archiveNote(NOTE, {
      expectedRevision: 3,
      idempotencyKey: "archive-replay",
      archived: true
    });

    expect(result.mutation.replayed).toBe(true);
    expect(harness.reads.getNote).not.toHaveBeenCalled();
    expect(harness.sealNoteContent).not.toHaveBeenCalled();
    expect(harness.sealNoteRevision).not.toHaveBeenCalled();
    expect(harness.sealNoteMutation).not.toHaveBeenCalled();
    expect(harness.applyMutation).not.toHaveBeenCalled();
    expect(harness.openIdempotencyResponse).toHaveBeenCalledOnce();
    expect(harness.createIdempotencyRequestMac.mock.calls[0]?.[1]).toMatchObject({
      keyReference: {
        keyId: "ai_assisted-mac-v1",
        keyClass: "ai_assisted",
        purpose: "content_mac",
        keyVersion: 1
      },
      logicalRequest: { payload: { action: "archive", archived: true } }
    });
  });

  it("binds undo to the exact target mutation and source/target privacy semantics", async () => {
    const before = snapshot({ privacy: "ai_assisted" });
    const after = snapshot({ privacy: "private_manual" });
    const originalPayload = Object.freeze({
      schemaVersion: 1 as const,
      action: "update" as const,
      beforeRevision: 1,
      afterRevision: 2,
      operations: [
        Object.freeze({ type: "set_privacy" as const, privacy: "private_manual" as const })
      ],
      inverse: [
        {
          type: "restore_snapshot" as const,
          spaceId: before.spaceId,
          noteType: before.type,
          title: before.title,
          bodyMarkdown: before.bodyMarkdown,
          structuredData: before.structuredData,
          privacy: before.privacy,
          isOpen: before.isOpen,
          pinnedAt: before.pinnedAt,
          archivedAt: before.archivedAt,
          deletedAt: before.deletedAt,
          tagIds: before.tagIds,
          links: before.links
        }
      ],
      beforeSnapshot: before,
      afterSnapshot: after
    }) satisfies NoteMutationPayload;
    const currentNote = detail({ privacy: "private_manual", currentRevision: 2 });
    const mutationRow = Object.freeze({
      mutationId: ORIGINAL_MUTATION,
      noteId: NOTE,
      decisionId: null,
      idempotencyKey: "original-mutation",
      beforeRevision: 1,
      afterRevision: 2,
      undoneAt: null,
      createdAt: UPDATED_AT,
      mutationCipher: encrypted("note_mutation", ORIGINAL_MUTATION, 2, "private_manual"),
      currentNote,
      beforeSnapshot: Object.freeze({
        revisionId: ORIGINAL_REVISION,
        revision: 1,
        privacy: "ai_assisted" as const,
        snapshotCipher: encrypted("note_revision", ORIGINAL_REVISION, 1, "ai_assisted")
      }),
      afterSnapshot: Object.freeze({
        revisionId: REVISION,
        revision: 2,
        privacy: "private_manual" as const,
        snapshotCipher: encrypted("note_revision", REVISION, 2, "private_manual")
      })
    }) satisfies EncryptedNoteMutationRead;
    const harness = writeHarness({
      currentPrivacy: "private_manual",
      currentRevision: 2,
      mutationRow,
      mutationPayload: originalPayload
    });

    await harness.repository.undoMutation(ORIGINAL_MUTATION, {
      expectedRevision: 2,
      idempotencyKey: "undo-exact-target"
    });

    expect(harness.openNoteMutation.mock.calls[0]?.[2]).toEqual({
      mutationId: ORIGINAL_MUTATION,
      afterRevision: 2,
      transition: { before: "ai_assisted", after: "private_manual" }
    });
    expect(harness.createIdempotencyRequestMac.mock.calls[0]?.[1]).toMatchObject({
      transition: { before: "private_manual", after: "ai_assisted" },
      logicalRequest: {
        payload: { action: "undo_mutation", mutationId: ORIGINAL_MUTATION }
      }
    });
    const submitted = harness.applyMutation.mock.calls[0]?.[0];
    expect(submitted?.command.noteState.privacy).toBe("ai_assisted");
    expect(submitted?.command.revision).toMatchObject({ source: "undo", actor: "user:undo" });
    expect(submitted?.command.mutation).toMatchObject({
      undoTargetMutationId: ORIGINAL_MUTATION,
      operations: [{ type: "restore_snapshot", privacy: "ai_assisted" }]
    });
    expect(harness.sealNoteRevision.mock.calls[0]?.[1].transition).toEqual({
      before: "private_manual",
      after: "ai_assisted"
    });
  });
});
