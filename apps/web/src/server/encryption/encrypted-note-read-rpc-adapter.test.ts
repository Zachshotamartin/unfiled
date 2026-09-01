import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedNoteReadRpcAdapter,
  encryptedNoteReadRpcFunctions
} from "./encrypted-note-read-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = `note_${"0".repeat(26)}` as const;
const OTHER_NOTE_ID = `note_${"1".repeat(26)}` as const;
const THIRD_NOTE_ID = `note_${"2".repeat(26)}` as const;
const REVISION_ID = `rev_${"3".repeat(26)}` as const;
const OTHER_REVISION_ID = `rev_${"4".repeat(26)}` as const;
const MUTATION_ID = `mut_${"5".repeat(26)}` as const;
const DECISION_ID = `dec_${"6".repeat(26)}` as const;
const SPACE_ID = `spc_${"7".repeat(26)}` as const;
const PARENT_SPACE_ID = `spc_${"8".repeat(26)}` as const;
const TAG_ID = `tag_${"9".repeat(26)}` as const;
const LINK_ID = `lnk_${"B".repeat(26)}` as const;
const OTHER_LINK_ID = `lnk_${"C".repeat(26)}` as const;
const CREATED_AT = "2026-08-30T20:00:00.000000+00:00";
const UPDATED_AT = "2026-08-30T22:54:12.345200+00:00";
const OLDER_UPDATED_AT = "2026-08-30T22:54:12.345100+00:00";
const CANONICAL_CREATED_AT = "2026-08-30T20:00:00.000Z";
const CANONICAL_UPDATED_AT = "2026-08-30T22:54:12.3452Z";
const CANONICAL_OLDER_UPDATED_AT = "2026-08-30T22:54:12.3451Z";
const RESPONSE_CANARY = "legacy-plaintext-note-body";

type TestKind =
  "note_content" | "note_mutation" | "note_revision" | "space_display" | "tag_display";
type TestKeyClass = "ai_assisted" | "private_manual";

function serviceClient(implementation: ServiceRpcClient["rpc"]): ServiceRpcClient {
  return Object.freeze({ rpc: implementation });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new TypeError("missing_test_fixture");
  return value;
}

function firstRecord(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new TypeError("invalid_test_fixture");
  const item: unknown = value[0];
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new TypeError("missing_test_fixture");
  }
  return item as Record<string, unknown>;
}

function keyId(keyClass: TestKeyClass): string {
  return `key_${keyClass}_object_wrap_v1`;
}

function envelope(
  kind: TestKind,
  resourceId: string,
  recordVersion: number,
  keyClass: TestKeyClass,
  ownerId = OWNER_ID
): ContentEnvelopeV1 {
  return {
    version: 1,
    suite: "A256GCM",
    keyId: keyId(keyClass),
    context: { tenantId: ownerId, resourceId, recordVersion, kind },
    wrappedDataKey: {
      nonce: "A".repeat(16),
      ciphertext: "A".repeat(64)
    },
    payload: {
      nonce: "A".repeat(16),
      ciphertext: "A".repeat(22)
    }
  };
}

function cipher(
  kind: TestKind,
  resourceId: string,
  recordVersion: number,
  keyClass: TestKeyClass
): Record<string, unknown> {
  return {
    envelope: envelope(kind, resourceId, recordVersion, keyClass),
    keyId: keyId(keyClass),
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1
  };
}

function snapshotMac(keyClass: TestKeyClass): Record<string, unknown> {
  return {
    mac: "a".repeat(64),
    keyId: `key_${keyClass}_content_mac_v1`,
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: 1
  };
}

function noteSummary(
  options: {
    noteId?: string;
    currentRevision?: number;
    privacy?: TestKeyClass;
    updatedAt?: string;
  } = {}
): Record<string, unknown> {
  const noteId = options.noteId ?? NOTE_ID;
  const currentRevision = options.currentRevision ?? 3;
  const privacy = options.privacy ?? "ai_assisted";
  return {
    noteId,
    currentRevision,
    spaceId: SPACE_ID,
    type: "generic",
    dailyDate: null,
    isOpen: false,
    pinnedAt: null,
    privacy,
    archivedAt: null,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: options.updatedAt ?? UPDATED_AT,
    contentCipher: cipher("note_content", noteId, currentRevision, privacy)
  };
}

function noteDetail(
  options: {
    noteId?: string;
    currentRevision?: number;
    privacy?: TestKeyClass;
  } = {}
): Record<string, unknown> {
  return {
    ...noteSummary(options),
    space: {
      spaceId: SPACE_ID,
      currentRevision: 2,
      parentId: PARENT_SPACE_ID,
      displayCipher: cipher("space_display", SPACE_ID, 2, "private_manual"),
      displayMac: snapshotMac("private_manual"),
      parent: {
        spaceId: PARENT_SPACE_ID,
        currentRevision: 1,
        displayCipher: cipher("space_display", PARENT_SPACE_ID, 1, "private_manual"),
        displayMac: snapshotMac("private_manual")
      }
    },
    tags: [
      {
        tagId: TAG_ID,
        currentRevision: 4,
        createdAt: CREATED_AT,
        displayCipher: cipher("tag_display", TAG_ID, 4, "private_manual"),
        displayMac: snapshotMac("private_manual")
      }
    ],
    links: [
      {
        linkId: LINK_ID,
        toNoteId: OTHER_NOTE_ID,
        linkType: "reference",
        source: "manual",
        targetType: "project",
        targetPrivacy: "private_manual",
        targetRevision: 5,
        targetContentCipher: cipher("note_content", OTHER_NOTE_ID, 5, "private_manual")
      }
    ]
  };
}

function revision(
  options: {
    revision?: number;
    revisionId?: string;
    privacy?: TestKeyClass;
    keyClass?: TestKeyClass;
  } = {}
): Record<string, unknown> {
  const revisionNumber = options.revision ?? 3;
  const revisionId = options.revisionId ?? REVISION_ID;
  const privacy = options.privacy ?? "ai_assisted";
  const keyClass = options.keyClass ?? privacy;
  return {
    revisionId,
    noteId: NOTE_ID,
    revision: revisionNumber,
    source: "interactive",
    spaceId: SPACE_ID,
    type: "generic",
    isOpen: false,
    pinnedAt: null,
    privacy,
    archivedAt: null,
    deletedAt: null,
    actor: "user:interactive",
    mutationId: MUTATION_ID,
    createdAt: UPDATED_AT,
    snapshotCipher: cipher("note_revision", revisionId, revisionNumber, keyClass),
    snapshotMac: snapshotMac(keyClass)
  };
}

function mutationSnapshot(
  revisionId: string,
  revisionNumber: number,
  privacy: TestKeyClass,
  keyClass = privacy
): Record<string, unknown> {
  return {
    revisionId,
    revision: revisionNumber,
    privacy,
    snapshotCipher: cipher("note_revision", revisionId, revisionNumber, keyClass),
    snapshotMac: snapshotMac(keyClass)
  };
}

function mutationProjection(): Record<string, unknown> {
  return {
    mutationId: MUTATION_ID,
    noteId: NOTE_ID,
    decisionId: DECISION_ID,
    idempotencyKey: "mutation-request-1",
    beforeRevision: 1,
    afterRevision: 2,
    undoneAt: null,
    createdAt: UPDATED_AT,
    mutationCipher: cipher("note_mutation", MUTATION_ID, 2, "private_manual"),
    currentNote: noteDetail({ currentRevision: 2, privacy: "private_manual" }),
    beforeSnapshot: mutationSnapshot(REVISION_ID, 1, "ai_assisted"),
    afterSnapshot: mutationSnapshot(OTHER_REVISION_ID, 2, "private_manual", "private_manual")
  };
}

async function expectServiceFailure(
  result: Promise<unknown>,
  code: (typeof ServiceRpcErrorCode)[keyof typeof ServiceRpcErrorCode],
  canary?: string
): Promise<void> {
  let reason: unknown;
  try {
    await result;
  } catch (error: unknown) {
    reason = error;
  }
  expect(reason).toBeInstanceOf(ServiceRpcError);
  expect(reason).toMatchObject({ code });
  if (canary !== undefined) {
    expect(String(reason)).not.toContain(canary);
    expect(JSON.stringify(reason)).not.toContain(canary);
  }
}

describe("encrypted note read RPC adapter", () => {
  it("keeps the specialized four-function capability allowlist exact", () => {
    expect(encryptedNoteReadRpcFunctions).toEqual([
      "list_encrypted_notes",
      "get_encrypted_note",
      "list_encrypted_note_revisions",
      "get_encrypted_note_mutation"
    ]);
  });

  it("binds list cursors and preserves microsecond descending order", async () => {
    const first = noteSummary({ noteId: OTHER_NOTE_ID, updatedAt: UPDATED_AT });
    const second = noteSummary({ noteId: NOTE_ID, updatedAt: OLDER_UPDATED_AT });
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      notes: [first, second],
      nextCursor: { updatedAt: OLDER_UPDATED_AT, noteId: NOTE_ID }
    });
    const result = await createEncryptedNoteReadRpcAdapter(serviceClient(rpc)).listNotes({
      ownerId: OWNER_ID,
      cursor: { updatedAt: "2026-08-30T22:54:12.345300+00:00", noteId: THIRD_NOTE_ID },
      limit: 2
    });

    expect(rpc).toHaveBeenCalledWith("list_encrypted_notes", {
      p_owner_id: OWNER_ID,
      p_after_updated_at: "2026-08-30T22:54:12.3453Z",
      p_after_note_id: THIRD_NOTE_ID,
      p_limit: 2
    });
    expect(result.notes.map((note) => note.noteId)).toEqual([OTHER_NOTE_ID, NOTE_ID]);
    expect(result.notes.map((note) => note.updatedAt)).toEqual([
      CANONICAL_UPDATED_AT,
      CANONICAL_OLDER_UPDATED_AT
    ]);
    expect(result.nextCursor).toEqual({
      updatedAt: CANONICAL_OLDER_UPDATED_AT,
      noteId: NOTE_ID
    });
    expect(result.notes[0]?.contentCipher).toMatchObject({
      ownerId: OWNER_ID,
      resourceId: OTHER_NOTE_ID,
      recordVersion: 3,
      kind: "note_content"
    });
  });

  it("defaults bounded list input and rejects malformed or overbroad inputs", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({ notes: [], nextCursor: null });
    const adapter = createEncryptedNoteReadRpcAdapter(serviceClient(rpc));
    await adapter.listNotes({ ownerId: OWNER_ID });
    expect(rpc).toHaveBeenCalledWith("list_encrypted_notes", {
      p_owner_id: OWNER_ID,
      p_after_updated_at: null,
      p_after_note_id: null,
      p_limit: 25
    });

    for (const input of [
      { ownerId: OWNER_ID, limit: 0 },
      { ownerId: OWNER_ID, limit: 51 },
      { ownerId: OWNER_ID, limit: 1.5 },
      { ownerId: OWNER_ID, cursor: { updatedAt: UPDATED_AT, noteId: "note_invalid" } },
      {
        ownerId: OTHER_OWNER_ID.toUpperCase(),
        cursor: { updatedAt: "not-a-time", noteId: NOTE_ID }
      },
      { ownerId: OWNER_ID, extra: RESPONSE_CANARY }
    ]) {
      await expectServiceFailure(
        adapter.listNotes(input as never),
        ServiceRpcErrorCode.VALIDATION_FAILED,
        RESPONSE_CANARY
      );
    }
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed for list projection, envelope, ordering, and cursor tampering", async () => {
    const first = noteSummary({ noteId: OTHER_NOTE_ID, updatedAt: UPDATED_AT });
    const second = noteSummary({ noteId: NOTE_ID, updatedAt: OLDER_UPDATED_AT });
    const valid = {
      notes: [first, second],
      nextCursor: { updatedAt: OLDER_UPDATED_AT, noteId: NOTE_ID }
    };
    const plaintext = clone(valid);
    firstRecord(plaintext.notes).bodyMarkdown = RESPONSE_CANARY;
    const wrongOwner = clone(valid);
    (firstRecord(wrongOwner.notes).contentCipher as Record<string, unknown>).envelope = envelope(
      "note_content",
      OTHER_NOTE_ID,
      3,
      "ai_assisted",
      OTHER_OWNER_ID
    );
    const wrongResource = clone(valid);
    (firstRecord(wrongResource.notes).contentCipher as Record<string, unknown>).envelope = envelope(
      "note_content",
      NOTE_ID,
      3,
      "ai_assisted"
    );
    const wrongVersion = clone(valid);
    (firstRecord(wrongVersion.notes).contentCipher as Record<string, unknown>).envelope = envelope(
      "note_content",
      OTHER_NOTE_ID,
      2,
      "ai_assisted"
    );
    const wrongClass = clone(valid);
    firstRecord(wrongClass.notes).privacy = "private_manual";
    const wrongKeyId = clone(valid);
    (firstRecord(wrongKeyId.notes).contentCipher as Record<string, unknown>).keyId =
      "different_key";
    const unordered = { ...valid, notes: [second, first], nextCursor: valid.nextCursor };
    const wrongCursor = { ...valid, nextCursor: { updatedAt: UPDATED_AT, noteId: OTHER_NOTE_ID } };
    const missingCursor = { ...valid, nextCursor: null };
    const duplicateNote = noteSummary({
      noteId: OTHER_NOTE_ID,
      updatedAt: OLDER_UPDATED_AT
    });
    const duplicateIdentity = {
      notes: [first, duplicateNote],
      nextCursor: { updatedAt: OLDER_UPDATED_AT, noteId: OTHER_NOTE_ID }
    };
    const nullCipher = clone(valid);
    firstRecord(nullCipher.notes).contentCipher = null;

    for (const projection of [
      plaintext,
      wrongOwner,
      wrongResource,
      wrongVersion,
      wrongClass,
      wrongKeyId,
      unordered,
      wrongCursor,
      missingCursor,
      duplicateIdentity,
      nullCipher,
      { notes: [first, second], nextCursor: valid.nextCursor, legacy: RESPONSE_CANARY },
      { notes: [first, second, clone(second)], nextCursor: valid.nextCursor }
    ]) {
      const adapter = createEncryptedNoteReadRpcAdapter(
        serviceClient(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection))
      );
      await expectServiceFailure(
        adapter.listNotes({ ownerId: OWNER_ID, limit: 2 }),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
        RESPONSE_CANARY
      );
    }
  });

  it("parses relations and canonicalizes every note lifecycle timestamp", async () => {
    const projection = noteDetail();
    projection.pinnedAt = "2026-08-30T15:54:12.345201-07:00";
    projection.archivedAt = "2026-08-30T22:54:12.345202+00:00";
    projection.deletedAt = "2026-08-30T22:54:12.345203+00:00";
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection);
    const result = await createEncryptedNoteReadRpcAdapter(serviceClient(rpc)).getNote({
      ownerId: OWNER_ID,
      noteId: NOTE_ID
    });

    expect(rpc).toHaveBeenCalledWith("get_encrypted_note", {
      p_owner_id: OWNER_ID,
      p_note_id: NOTE_ID
    });
    expect(result.space?.displayCipher).toMatchObject({
      ownerId: OWNER_ID,
      resourceId: SPACE_ID,
      recordVersion: 2,
      kind: "space_display",
      keyClass: "private_manual"
    });
    expect(result.space?.parent?.displayCipher.resourceId).toBe(PARENT_SPACE_ID);
    expect(result.tags[0]?.displayCipher).toMatchObject({ resourceId: TAG_ID, recordVersion: 4 });
    expect(result.space?.displayMac.keyClass).toBe("private_manual");
    expect(result.space?.parent?.displayMac.keyClass).toBe("private_manual");
    expect(result.tags[0]?.displayMac.keyClass).toBe("private_manual");
    expect(result).toMatchObject({
      pinnedAt: "2026-08-30T22:54:12.345201Z",
      archivedAt: "2026-08-30T22:54:12.345202Z",
      deletedAt: "2026-08-30T22:54:12.345203Z",
      createdAt: CANONICAL_CREATED_AT,
      updatedAt: CANONICAL_UPDATED_AT
    });
    expect(result.tags[0]?.createdAt).toBe(CANONICAL_CREATED_AT);
    expect(result.links[0]?.targetContentCipher).toMatchObject({
      resourceId: OTHER_NOTE_ID,
      recordVersion: 5,
      keyClass: "private_manual"
    });
  });

  it("rejects plaintext and nested relation identity, version, class, and ordering drift", async () => {
    const valid = noteDetail();
    const plaintext = { ...clone(valid), title: RESPONSE_CANARY };
    const wrongSpaceRevision = clone(valid);
    (
      (wrongSpaceRevision.space as Record<string, unknown>).displayCipher as Record<string, unknown>
    ).envelope = envelope("space_display", SPACE_ID, 1, "private_manual");
    const wrongParent = clone(valid);
    (
      ((wrongParent.space as Record<string, unknown>).parent as Record<string, unknown>)
        .displayCipher as Record<string, unknown>
    ).envelope = envelope("space_display", PARENT_SPACE_ID, 1, "private_manual", OTHER_OWNER_ID);
    const wrongTagClass = clone(valid);
    const tag = first(wrongTagClass.tags as Record<string, unknown>[]);
    tag.displayCipher = cipher("tag_display", TAG_ID, 4, "ai_assisted");
    const wrongSpaceMac = clone(valid);
    (wrongSpaceMac.space as Record<string, unknown>).displayMac = snapshotMac("ai_assisted");
    const wrongTagMac = clone(valid);
    first(wrongTagMac.tags as Record<string, unknown>[]).displayMac = snapshotMac("ai_assisted");
    const wrongTagTimestamp = clone(valid);
    first(wrongTagTimestamp.tags as Record<string, unknown>[]).createdAt = "not-a-timestamp";
    const wrongTargetResource = clone(valid);
    const target = first(wrongTargetResource.links as Record<string, unknown>[]);
    target.targetContentCipher = cipher("note_content", NOTE_ID, 5, "private_manual");
    const linkPlaintext = clone(valid);
    first(linkPlaintext.links as Record<string, unknown>[]).targetTitle = RESPONSE_CANARY;
    const duplicateTags = clone(valid);
    duplicateTags.tags = [
      ...(duplicateTags.tags as unknown[]),
      {
        tagId: TAG_ID,
        currentRevision: 4,
        createdAt: CREATED_AT,
        displayCipher: cipher("tag_display", TAG_ID, 4, "private_manual")
      }
    ];
    const unorderedLinks = clone(valid);
    unorderedLinks.links = [
      {
        linkId: OTHER_LINK_ID,
        toNoteId: THIRD_NOTE_ID,
        linkType: "related",
        source: "organization",
        targetType: "generic",
        targetPrivacy: "ai_assisted",
        targetRevision: 1,
        targetContentCipher: cipher("note_content", THIRD_NOTE_ID, 1, "ai_assisted")
      },
      ...(unorderedLinks.links as unknown[])
    ];
    const missingNestedCipher = clone(valid);
    (
      (missingNestedCipher.space as Record<string, unknown>).parent as Record<string, unknown>
    ).displayCipher = null;

    for (const projection of [
      plaintext,
      wrongSpaceRevision,
      wrongParent,
      wrongTagClass,
      wrongSpaceMac,
      wrongTagMac,
      wrongTagTimestamp,
      wrongTargetResource,
      linkPlaintext,
      duplicateTags,
      unorderedLinks,
      missingNestedCipher
    ]) {
      const adapter = createEncryptedNoteReadRpcAdapter(
        serviceClient(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection))
      );
      await expectServiceFailure(
        adapter.getNote({ ownerId: OWNER_ID, noteId: NOTE_ID }),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
        RESPONSE_CANARY
      );
    }
  });

  it("parses revision snapshots, MACs, and descending keyset pagination", async () => {
    const newer = revision({ revision: 3, revisionId: REVISION_ID });
    const older = revision({ revision: 2, revisionId: OTHER_REVISION_ID });
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      revisions: [newer, older],
      nextRevision: 2
    });
    const result = await createEncryptedNoteReadRpcAdapter(serviceClient(rpc)).listRevisions({
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      afterRevision: 4,
      limit: 2
    });

    expect(rpc).toHaveBeenCalledWith("list_encrypted_note_revisions", {
      p_owner_id: OWNER_ID,
      p_note_id: NOTE_ID,
      p_after_revision: 4,
      p_limit: 2
    });
    expect(result.nextRevision).toBe(2);
    expect(result.revisions[0]?.snapshotMac).toEqual({
      value: "a".repeat(64),
      keyId: "key_ai_assisted_content_mac_v1",
      keyClass: "ai_assisted",
      keyPurpose: "content_mac",
      keyVersion: 1
    });
    expect(result.revisions[0]?.createdAt).toBe(CANONICAL_UPDATED_AT);
  });

  it("rejects revision plaintext, context, MAC, privacy, and pagination tampering", async () => {
    const newer = revision({ revision: 3, revisionId: REVISION_ID });
    const older = revision({ revision: 2, revisionId: OTHER_REVISION_ID });
    const valid = { revisions: [newer, older], nextRevision: 2 };
    const plaintext = clone(valid);
    first(plaintext.revisions).bodyMarkdown = RESPONSE_CANARY;
    const wrongNote = clone(valid);
    first(wrongNote.revisions).noteId = OTHER_NOTE_ID;
    const wrongVersion = clone(valid);
    (first(wrongVersion.revisions).snapshotCipher as Record<string, unknown>).envelope = envelope(
      "note_revision",
      REVISION_ID,
      2,
      "ai_assisted"
    );
    const wrongMacClass = clone(valid);
    first(wrongMacClass.revisions).snapshotMac = snapshotMac("private_manual");
    const privateOnAiKey = clone(valid);
    first(privateOnAiKey.revisions).privacy = "private_manual";
    const unsafeActor = clone(valid);
    first(unsafeActor.revisions).actor = RESPONSE_CANARY;
    const duplicateRevisionIdentity = {
      revisions: [newer, revision({ revision: 2, revisionId: REVISION_ID })],
      nextRevision: 2
    };
    const unordered = { ...valid, revisions: [older, newer] };
    const wrongNext = { ...valid, nextRevision: 3 };

    for (const projection of [
      plaintext,
      wrongNote,
      wrongVersion,
      wrongMacClass,
      privateOnAiKey,
      unsafeActor,
      duplicateRevisionIdentity,
      unordered,
      wrongNext,
      { revisions: [newer, older, clone(older)], nextRevision: 2 }
    ]) {
      const adapter = createEncryptedNoteReadRpcAdapter(
        serviceClient(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection))
      );
      await expectServiceFailure(
        adapter.listRevisions({ ownerId: OWNER_ID, noteId: NOTE_ID, limit: 2 }),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
        RESPONSE_CANARY
      );
    }
  });

  it("parses an AI-to-private mutation using before/after privacy and exact history class", async () => {
    const projection = mutationProjection();
    projection.undoneAt = "2026-08-30T22:54:13.000001+00:00";
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection);
    const result = await createEncryptedNoteReadRpcAdapter(serviceClient(rpc)).getMutation({
      ownerId: OWNER_ID,
      mutationId: MUTATION_ID
    });

    expect(rpc).toHaveBeenCalledWith("get_encrypted_note_mutation", {
      p_owner_id: OWNER_ID,
      p_mutation_id: MUTATION_ID
    });
    expect(result.beforeSnapshot).toMatchObject({ revision: 1, privacy: "ai_assisted" });
    expect(result.afterSnapshot).toMatchObject({ revision: 2, privacy: "private_manual" });
    expect(result.beforeSnapshot?.snapshotMac.keyClass).toBe("ai_assisted");
    expect(result.afterSnapshot.snapshotMac.keyClass).toBe("private_manual");
    expect(result.mutationCipher.keyClass).toBe("private_manual");
    expect(result.currentNote.currentRevision).toBe(2);
    expect(result.createdAt).toBe(CANONICAL_UPDATED_AT);
    expect(result.undoneAt).toBe("2026-08-30T22:54:13.000001Z");
  });

  it("accepts the exact create-mutation null-before projection", async () => {
    const projection = mutationProjection();
    projection.beforeRevision = 0;
    projection.afterRevision = 1;
    projection.decisionId = null;
    projection.beforeSnapshot = null;
    projection.afterSnapshot = mutationSnapshot(OTHER_REVISION_ID, 1, "ai_assisted");
    projection.mutationCipher = cipher("note_mutation", MUTATION_ID, 1, "ai_assisted");
    projection.currentNote = noteDetail({ currentRevision: 1, privacy: "ai_assisted" });
    const result = await createEncryptedNoteReadRpcAdapter(
      serviceClient(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection))
    ).getMutation({ ownerId: OWNER_ID, mutationId: MUTATION_ID });
    expect(result.beforeSnapshot).toBeNull();
    expect(result.mutationCipher.keyClass).toBe("ai_assisted");
  });

  it("accepts a decision-bound organizer create mutation without loosening user creates", async () => {
    const projection = mutationProjection();
    projection.beforeRevision = 0;
    projection.afterRevision = 1;
    projection.idempotencyKey = `organizer:job_${"A".repeat(26)}`;
    projection.beforeSnapshot = null;
    projection.afterSnapshot = mutationSnapshot(OTHER_REVISION_ID, 1, "ai_assisted");
    projection.mutationCipher = cipher("note_mutation", MUTATION_ID, 1, "ai_assisted");
    projection.currentNote = noteDetail({ currentRevision: 1, privacy: "ai_assisted" });

    const result = await createEncryptedNoteReadRpcAdapter(
      serviceClient(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection))
    ).getMutation({ ownerId: OWNER_ID, mutationId: MUTATION_ID });

    expect(result.beforeSnapshot).toBeNull();
    expect(result.decisionId).toBe(DECISION_ID);
    expect(result.idempotencyKey).toBe(`organizer:job_${"A".repeat(26)}`);
  });

  it("accepts a decision-bound owner-interaction create mutation with exact member provenance", async () => {
    const projection = mutationProjection();
    projection.beforeRevision = 0;
    projection.afterRevision = 1;
    projection.idempotencyKey = "review-create-request:member:0";
    projection.beforeSnapshot = null;
    projection.afterSnapshot = mutationSnapshot(OTHER_REVISION_ID, 1, "ai_assisted");
    projection.mutationCipher = cipher("note_mutation", MUTATION_ID, 1, "ai_assisted");
    projection.currentNote = noteDetail({ currentRevision: 1, privacy: "ai_assisted" });

    const result = await createEncryptedNoteReadRpcAdapter(
      serviceClient(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection))
    ).getMutation({ ownerId: OWNER_ID, mutationId: MUTATION_ID });

    expect(result.beforeSnapshot).toBeNull();
    expect(result.decisionId).toBe(DECISION_ID);
    expect(result.idempotencyKey).toBe("review-create-request:member:0");
  });

  it("rejects mutation plaintext, continuity, privacy, class, and current-note drift", async () => {
    const valid = mutationProjection();
    const plaintext = { ...clone(valid), operations: RESPONSE_CANARY };
    const missingBefore = clone(valid);
    missingBefore.beforeSnapshot = null;
    const wrongAfterRevision = clone(valid);
    (wrongAfterRevision.afterSnapshot as Record<string, unknown>).revision = 3;
    const wrongMutationClass = clone(valid);
    wrongMutationClass.mutationCipher = cipher("note_mutation", MUTATION_ID, 2, "ai_assisted");
    const wrongAfterClass = clone(valid);
    (wrongAfterClass.afterSnapshot as Record<string, unknown>).snapshotCipher = cipher(
      "note_revision",
      OTHER_REVISION_ID,
      2,
      "ai_assisted"
    );
    const missingSnapshotMac = clone(valid);
    delete (missingSnapshotMac.afterSnapshot as Record<string, unknown>).snapshotMac;
    const wrongSnapshotMacClass = clone(valid);
    (wrongSnapshotMacClass.afterSnapshot as Record<string, unknown>).snapshotMac =
      snapshotMac("ai_assisted");
    const wrongCurrentNote = clone(valid);
    (wrongCurrentNote.currentNote as Record<string, unknown>).noteId = OTHER_NOTE_ID;
    const staleCurrentNote = clone(valid);
    (staleCurrentNote.currentNote as Record<string, unknown>).currentRevision = 1;
    const currentPrivacyDrift = clone(valid);
    currentPrivacyDrift.currentNote = noteDetail({ currentRevision: 2, privacy: "ai_assisted" });
    const missingPrivacy = clone(valid);
    delete (missingPrivacy.beforeSnapshot as Record<string, unknown>).privacy;
    const reusedRevisionIdentity = clone(valid);
    reusedRevisionIdentity.afterSnapshot = mutationSnapshot(
      REVISION_ID,
      2,
      "private_manual",
      "private_manual"
    );
    const createWithBefore = clone(valid);
    createWithBefore.beforeRevision = 0;
    createWithBefore.afterRevision = 1;
    const createWithDecision = clone(valid);
    createWithDecision.beforeRevision = 0;
    createWithDecision.afterRevision = 1;
    createWithDecision.beforeSnapshot = null;
    createWithDecision.afterSnapshot = mutationSnapshot(OTHER_REVISION_ID, 1, "ai_assisted");
    createWithDecision.mutationCipher = cipher("note_mutation", MUTATION_ID, 1, "ai_assisted");
    createWithDecision.currentNote = noteDetail({ currentRevision: 1, privacy: "ai_assisted" });
    const createWithInvalidOwnerInteractionMember = clone(createWithDecision);
    createWithInvalidOwnerInteractionMember.idempotencyKey = "review-create-request:member:16";

    for (const projection of [
      plaintext,
      missingBefore,
      wrongAfterRevision,
      wrongMutationClass,
      wrongAfterClass,
      missingSnapshotMac,
      wrongSnapshotMacClass,
      wrongCurrentNote,
      staleCurrentNote,
      currentPrivacyDrift,
      missingPrivacy,
      reusedRevisionIdentity,
      createWithBefore,
      createWithDecision,
      createWithInvalidOwnerInteractionMember
    ]) {
      const adapter = createEncryptedNoteReadRpcAdapter(
        serviceClient(vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection))
      );
      await expectServiceFailure(
        adapter.getMutation({ ownerId: OWNER_ID, mutationId: MUTATION_ID }),
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
        RESPONSE_CANARY
      );
    }
  });

  it("rejects malformed exact-key point-read inputs before invoking the service", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const adapter = createEncryptedNoteReadRpcAdapter(serviceClient(rpc));
    for (const result of [
      adapter.getNote({ ownerId: OWNER_ID, noteId: "note_bad", extra: RESPONSE_CANARY } as never),
      adapter.listRevisions({ ownerId: OWNER_ID, noteId: NOTE_ID, afterRevision: 0 }),
      adapter.getMutation({ ownerId: OTHER_OWNER_ID, mutationId: "mut_bad" } as never)
    ]) {
      await expectServiceFailure(result, ServiceRpcErrorCode.VALIDATION_FAILED, RESPONSE_CANARY);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
