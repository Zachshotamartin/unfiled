import {
  MutationResultSchema,
  NoteRevisionSchema,
  NoteSchema,
  UndoEligibilitySchema,
  UserOperationSchema,
  createEntityId,
  entityIdSchema,
  type EntityId,
  type EntityKind,
  type NoteDto,
  type NoteLinkValue,
  type NoteRevisionDto,
  type PrivacyMode,
  type UserOperation
} from "@unfiled/contracts";
import {
  applyNoteOperations,
  createInitialNote,
  noteSnapshot,
  restoreNoteRevision,
  undoNoteMutation,
  type EntityIdFactory,
  type Note,
  type NoteMutation,
  type NoteMutationResult as DomainNoteMutationResult
} from "@unfiled/domain";
import {
  NoteContentPayloadSchema,
  NoteMutationPayloadSchema,
  NoteRevisionPayloadSchema,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateService,
  type KeyedMacRecord,
  type LogicalApiRequest,
  type NoteMutationPayload,
  type PayloadCodec
} from "@unfiled/encrypted-aggregate";
import { z } from "zod";

import type {
  CreateNoteInput,
  NoteListFilters,
  NoteLinkRecord,
  NoteMutationResult,
  NoteRecord,
  RevisionRecord,
  UpdateNoteInput
} from "@/lib/product/types";

import type {
  EncryptedNoteMutationRead,
  EncryptedNoteRead,
  EncryptedNoteReadRpcAdapter,
  EncryptedNoteReadSummary,
  EncryptedNoteRevisionRead
} from "./encrypted-note-read-rpc-adapter";
import type {
  EncryptedNoteRpcAdapter,
  EncryptedNoteState,
  IncompleteEncryptedNoteWriteClaim
} from "./encrypted-note-rpc-adapter";
import {
  executeEncryptedNoteWrite,
  type EncryptedNoteWriteMaterial
} from "./encrypted-note-write-executor";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const MAX_READ_PAGE_SIZE = 50;
const MAX_LIST_SCAN = 1_000;

const CreateIntentSchema = z.strictObject({
  action: z.literal("create"),
  title: z.string().trim().min(1).max(200),
  type: z.enum(["generic", "list", "log", "principle", "project"]),
  spaceId: entityIdSchema("spc").nullable(),
  privacy: z.enum(["ai_assisted", "private_manual"]),
  bodyMarkdown: z.string().max(200_000),
  tagIds: z.array(entityIdSchema("tag")).max(100),
  links: z
    .array(
      z.strictObject({
        linkType: z.enum(["reference", "related"]),
        toNoteId: entityIdSchema("note")
      })
    )
    .max(100)
});

const OperationsIntentSchema = z.strictObject({
  action: z.literal("apply_operations"),
  operations: z.array(UserOperationSchema).min(1).max(20)
});

const RestoreIntentSchema = z.strictObject({
  action: z.literal("restore_revision"),
  revisionId: entityIdSchema("rev")
});
const UndoIntentSchema = z.strictObject({
  action: z.literal("undo_mutation"),
  mutationId: entityIdSchema("mut")
});

const ArchiveIntentSchema = z.strictObject({
  action: z.literal("archive"),
  archived: z.boolean()
});
const DeleteNoteIntentSchema = z.strictObject({ action: z.literal("delete_note") });
const RestoreDeletedIntentSchema = z.strictObject({ action: z.literal("restore_deleted") });
const LinkTagIntentSchema = z.strictObject({
  action: z.literal("link_tag"),
  tagId: entityIdSchema("tag")
});
const UnlinkTagIntentSchema = z.strictObject({
  action: z.literal("unlink_tag"),
  tagId: entityIdSchema("tag")
});
const CreateLinkIntentSchema = z.strictObject({
  action: z.literal("create_link"),
  linkType: z.enum(["reference", "related"]),
  toNoteId: entityIdSchema("note")
});
const DeleteLinkIntentSchema = z.strictObject({
  action: z.literal("delete_link"),
  linkId: entityIdSchema("lnk"),
  linkType: z.enum(["reference", "related"]),
  toNoteId: entityIdSchema("note")
});

const MutationIntentSchema = z.discriminatedUnion("action", [
  OperationsIntentSchema,
  RestoreIntentSchema,
  UndoIntentSchema,
  ArchiveIntentSchema,
  DeleteNoteIntentSchema,
  RestoreDeletedIntentSchema,
  LinkTagIntentSchema,
  UnlinkTagIntentSchema,
  CreateLinkIntentSchema,
  DeleteLinkIntentSchema
]);

const StoredMutationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  note: NoteSchema,
  revision: NoteRevisionSchema,
  mutationId: entityIdSchema("mut"),
  undo: UndoEligibilitySchema
});
type StoredMutationResponse = z.infer<typeof StoredMutationResponseSchema>;
type MutationIntent = z.infer<typeof MutationIntentSchema>;

type RepositoryDependencies = Readonly<{
  ownerId: string;
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  reads: EncryptedNoteReadRpcAdapter;
  writes: EncryptedNoteRpcAdapter;
}>;

type DecryptedNote = Readonly<{
  dailyDate: string | null;
  note: Note;
  record: NoteRecord;
}>;

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function claimIdFactory(claim: IncompleteEncryptedNoteWriteClaim): EntityIdFactory {
  return ((kind: EntityKind) => {
    if (kind === "rev") return claim.revisionId;
    if (kind === "mut") return claim.mutationId;
    return createEntityId(kind);
  }) as EntityIdFactory;
}

function noteDto(note: Note): NoteDto {
  return NoteSchema.parse({
    id: note.id,
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData,
    currentRevision: note.currentRevision,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: note.tagIds,
    links: note.links,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  });
}

function revisionWithMac(revision: NoteRevisionDto, mac: KeyedMacRecord): NoteRevisionDto {
  return NoteRevisionSchema.parse({ ...revision, contentHash: mac.value });
}

function mutationResponse(
  result: DomainNoteMutationResult | Readonly<{ note: Note; revision: NoteRevisionDto }>,
  mutationId: EntityId<"mut">,
  revisionMac: KeyedMacRecord
): StoredMutationResponse {
  return StoredMutationResponseSchema.parse({
    schemaVersion: 1,
    note: noteDto(result.note),
    revision: revisionWithMac(result.revision, revisionMac),
    mutationId,
    undo: { eligible: true, expiresAt: null }
  });
}

function syntheticMutationRecord(note: NoteDto): NoteRecord {
  return Object.freeze({
    ...note,
    spacePath: null,
    tags: Object.freeze([]),
    links: Object.freeze(
      note.links.map((link, index): NoteLinkRecord => ({
        id: `lnk_${String(index + 1).padStart(26, "0")}`,
        fromNoteId: note.id,
        toNoteId: link.toNoteId,
        linkType: link.linkType,
        targetTitle: "Linked note"
      }))
    )
  });
}

function publicMutationResult(
  stored: StoredMutationResponse,
  replayed: boolean
): NoteMutationResult {
  const parsed = MutationResultSchema.parse({
    note: stored.note,
    revision: stored.revision,
    mutationId: stored.mutationId,
    undo: stored.undo,
    replayed
  });
  return Object.freeze({
    note: syntheticMutationRecord(parsed.note),
    revision: parsed.revision,
    mutation: Object.freeze({
      id: parsed.mutationId,
      beforeRevision: Math.max(0, parsed.note.currentRevision - 1),
      afterRevision: parsed.note.currentRevision,
      replayed: parsed.replayed,
      undoAvailable: parsed.undo.eligible
    })
  });
}

function stateFor(note: Note, dailyDate: string | null): EncryptedNoteState {
  return Object.freeze({
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData,
    dailyDate,
    isOpen: note.isOpen,
    privacy: note.privacy,
    pinnedAt: note.pinnedAt,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: note.tagIds,
    links: note.links
  });
}

function createMaterial(
  claim: IncompleteEncryptedNoteWriteClaim,
  input: CreateNoteInput
): EncryptedNoteWriteMaterial<StoredMutationResponse> {
  const created = createInitialNote({
    id: claim.noteId,
    userId: claim.ownerId,
    title: input.title,
    type: input.type,
    privacy: input.privacy,
    now: claim.occurredAt,
    spaceId: input.spaceId,
    bodyMarkdown: input.bodyMarkdown,
    tagIds: input.tagIds,
    links: input.links,
    idFactory: claimIdFactory(claim)
  });
  const snapshot = noteSnapshot(created.note);
  const mutation = NoteMutationPayloadSchema.parse({
    schemaVersion: 1,
    action: "create",
    beforeRevision: 0,
    afterRevision: 1,
    operations: [{ type: "create_note" }],
    inverse: { type: "soft_delete_created_note" },
    beforeSnapshot: null,
    afterSnapshot: snapshot
  });
  return Object.freeze({
    noteState: stateFor(created.note, null),
    noteContent: NoteContentPayloadSchema.parse({
      schemaVersion: 1,
      title: created.note.title,
      bodyMarkdown: created.note.bodyMarkdown,
      structuredData: created.note.structuredData
    }),
    revision: Object.freeze({
      id: claim.revisionId,
      source: created.revision.source,
      actor: created.revision.actor,
      payload: NoteRevisionPayloadSchema.parse({ schemaVersion: 1, snapshot })
    }),
    mutation: Object.freeze({
      id: claim.mutationId,
      decisionId: null,
      undoTargetMutationId: null,
      payload: mutation
    }),
    buildResponse: (revisionMac) => mutationResponse(created, claim.mutationId, revisionMac)
  });
}

function updateMaterial(
  claim: IncompleteEncryptedNoteWriteClaim,
  current: DecryptedNote,
  operations: readonly UserOperation[],
  metadata: Readonly<{
    actor?: string;
    source?: NoteRevisionDto["source"];
    undoTargetMutationId?: EntityId<"mut"> | null;
  }> = {}
): EncryptedNoteWriteMaterial<StoredMutationResponse> {
  const result = applyNoteOperations(current.note, {
    expectedRevision: claim.expectedRevision,
    operations,
    now: claim.occurredAt,
    idFactory: claimIdFactory(claim),
    ...(metadata.actor === undefined ? {} : { actor: metadata.actor }),
    ...(metadata.source === undefined ? {} : { source: metadata.source })
  });
  const revisionPayload = NoteRevisionPayloadSchema.parse({
    schemaVersion: 1,
    snapshot: noteSnapshot(result.note)
  });
  const mutationPayload = NoteMutationPayloadSchema.parse({
    schemaVersion: 1,
    action: "update",
    beforeRevision: result.mutation.beforeRevision,
    afterRevision: result.mutation.afterRevision,
    operations: result.mutation.operations,
    inverse: result.mutation.inverse,
    beforeSnapshot: result.mutation.beforeSnapshot,
    afterSnapshot: result.mutation.afterSnapshot
  });
  return Object.freeze({
    noteState: stateFor(result.note, current.dailyDate),
    noteContent: NoteContentPayloadSchema.parse({
      schemaVersion: 1,
      title: result.note.title,
      bodyMarkdown: result.note.bodyMarkdown,
      structuredData: result.note.structuredData
    }),
    revision: Object.freeze({
      id: claim.revisionId,
      source: result.revision.source,
      actor: result.revision.actor,
      payload: revisionPayload
    }),
    mutation: Object.freeze({
      id: claim.mutationId,
      decisionId: null,
      undoTargetMutationId: metadata.undoTargetMutationId ?? null,
      payload: mutationPayload
    }),
    buildResponse: (revisionMac) => mutationResponse(result, claim.mutationId, revisionMac)
  });
}

function transitionAfter(operations: readonly UserOperation[], before: PrivacyMode): PrivacyMode {
  let privacy = before;
  for (const operation of operations) {
    if (operation.type === "set_privacy") privacy = operation.privacy;
    if (operation.type === "restore_snapshot") privacy = operation.privacy;
  }
  return privacy;
}

function matchesFilters(note: EncryptedNoteReadSummary, filters: NoteListFilters): boolean {
  const deleted = filters.deleted ?? "exclude";
  const archived = filters.archived ?? "exclude";
  return (
    (deleted === "only" ? note.deletedAt !== null : note.deletedAt === null) &&
    (archived === "include" ||
      (archived === "only" ? note.archivedAt !== null : note.archivedAt === null)) &&
    (filters.spaceId === undefined || note.spaceId === filters.spaceId) &&
    (filters.type === undefined || note.type === filters.type)
  );
}

function noteFromRecord(ownerId: string, record: NoteRecord): Note {
  return Object.freeze({
    ...NoteSchema.parse({
      id: record.id,
      spaceId: record.spaceId,
      type: record.type,
      title: record.title,
      bodyMarkdown: record.bodyMarkdown,
      structuredData: record.structuredData,
      currentRevision: record.currentRevision,
      isOpen: record.isOpen,
      pinnedAt: record.pinnedAt,
      privacy: record.privacy,
      archivedAt: record.archivedAt,
      deletedAt: record.deletedAt,
      tagIds: record.tagIds,
      links: record.links.map(({ linkType, toNoteId }) => ({ linkType, toNoteId })),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }),
    userId: ownerId
  });
}

function revisionTransition(row: EncryptedNoteRevisionRead) {
  const before =
    row.snapshotCipher.keyClass === "private_manual" && row.privacy === "ai_assisted"
      ? "private_manual"
      : row.privacy;
  return Object.freeze({ before, after: row.privacy });
}

/** Owner-scoped encrypted note CRUD. Taxonomy/search/review adapters join this
 * core in C.5c/d before the rollout router can enter encrypted_read. */
export class EncryptedNoteAggregateRepository {
  public constructor(private readonly dependencies: RepositoryDependencies) {}

  private async decryptSummary(row: EncryptedNoteReadSummary): Promise<NoteRecord> {
    const content = await this.dependencies.aggregate.openNoteContent(
      this.dependencies.access,
      row.contentCipher,
      {
        noteId: row.noteId,
        currentRevision: row.currentRevision,
        privacy: row.privacy
      }
    );
    return Object.freeze({
      id: row.noteId,
      spaceId: row.spaceId,
      spacePath: null,
      type: row.type,
      title: content.title,
      bodyMarkdown: content.bodyMarkdown,
      structuredData: content.structuredData,
      currentRevision: row.currentRevision,
      isOpen: row.isOpen,
      pinnedAt: row.pinnedAt,
      privacy: row.privacy,
      archivedAt: row.archivedAt,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      tagIds: [],
      tags: [],
      links: []
    });
  }

  private async decryptDetail(row: EncryptedNoteRead): Promise<DecryptedNote> {
    const base = await this.decryptSummary(row);
    const spaceRow = row.space;
    const spacePath =
      spaceRow === null
        ? null
        : await (async () => {
            const [space, parent] = await Promise.all([
              this.dependencies.aggregate.openSpaceDisplay(
                this.dependencies.access,
                spaceRow.displayCipher,
                {
                  spaceId: spaceRow.spaceId,
                  currentRevision: spaceRow.currentRevision
                }
              ),
              spaceRow.parent === null
                ? Promise.resolve(null)
                : this.dependencies.aggregate.openSpaceDisplay(
                    this.dependencies.access,
                    spaceRow.parent.displayCipher,
                    {
                      spaceId: spaceRow.parent.spaceId,
                      currentRevision: spaceRow.parent.currentRevision
                    }
                  )
            ]);
            return parent === null ? space.name : `${parent.name} / ${space.name}`;
          })();
    const [tags, links] = await Promise.all([
      Promise.all(
        row.tags.map(async (tag) => {
          const display = await this.dependencies.aggregate.openTagDisplay(
            this.dependencies.access,
            tag.displayCipher,
            { tagId: tag.tagId, currentRevision: tag.currentRevision }
          );
          return Object.freeze({
            id: tag.tagId,
            name: display.name,
            currentRevision: tag.currentRevision,
            createdAt: tag.createdAt
          });
        })
      ),
      Promise.all(
        row.links.map(async (link): Promise<NoteLinkRecord> => {
          const target = await this.dependencies.aggregate.openNoteContent(
            this.dependencies.access,
            link.targetContentCipher,
            {
              noteId: link.toNoteId,
              currentRevision: link.targetRevision,
              privacy: link.targetPrivacy
            }
          );
          return Object.freeze({
            id: link.linkId,
            fromNoteId: row.noteId,
            toNoteId: link.toNoteId,
            linkType: link.linkType,
            targetTitle: target.title
          });
        })
      )
    ]);
    const record: NoteRecord = Object.freeze({
      ...base,
      spacePath,
      tagIds: tags.map(({ id }) => id),
      tags,
      links
    });
    return Object.freeze({
      dailyDate: row.dailyDate,
      note: noteFromRecord(row.contentCipher.ownerId, record),
      record
    });
  }

  private async current(noteId: EntityId<"note">): Promise<DecryptedNote> {
    return this.decryptDetail(
      await this.dependencies.reads.getNote({ ownerId: this.dependencies.ownerId, noteId })
    );
  }

  public async getNote(noteId: EntityId<"note">): Promise<NoteRecord> {
    return (await this.current(noteId)).record;
  }

  public async listNotes(filters: NoteListFilters): Promise<readonly NoteRecord[]> {
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      return invalidInput();
    }
    const selected: EncryptedNoteReadSummary[] = [];
    let cursor = null;
    let scanned = 0;
    while (selected.length < offset + limit && scanned < MAX_LIST_SCAN) {
      const page = await this.dependencies.reads.listNotes({
        ownerId: this.dependencies.ownerId,
        cursor,
        limit: MAX_READ_PAGE_SIZE
      });
      scanned += page.notes.length;
      selected.push(...page.notes.filter((note) => matchesFilters(note, filters)));
      if (page.nextCursor === null || page.notes.length === 0) break;
      cursor = page.nextCursor;
    }
    if (scanned >= MAX_LIST_SCAN && selected.length < offset + limit && cursor !== null) {
      return unavailable();
    }
    return Promise.all(
      selected.slice(offset, offset + limit).map((row) => this.decryptSummary(row))
    );
  }

  public async listRevisions(
    noteId: EntityId<"note">,
    page: Readonly<{ limit: number; offset: number }> = { limit: 100, offset: 0 }
  ): Promise<readonly RevisionRecord[]> {
    if (
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0
    ) {
      return invalidInput();
    }
    const requestedEnd = page.offset + page.limit;
    if (!Number.isSafeInteger(requestedEnd)) return invalidInput();
    const rows: EncryptedNoteRevisionRead[] = [];
    let afterRevision: number | null = null;
    while (rows.length < requestedEnd && rows.length < MAX_LIST_SCAN) {
      const batch = await this.dependencies.reads.listRevisions({
        ownerId: this.dependencies.ownerId,
        noteId,
        afterRevision,
        limit: Math.min(MAX_READ_PAGE_SIZE, requestedEnd - rows.length, MAX_LIST_SCAN - rows.length)
      });
      rows.push(...batch.revisions);
      if (batch.nextRevision === null || batch.revisions.length === 0) break;
      afterRevision = batch.nextRevision;
    }
    if (rows.length >= MAX_LIST_SCAN && rows.length < requestedEnd && afterRevision !== null) {
      return unavailable();
    }
    return Promise.all(
      rows.slice(page.offset, page.offset + page.limit).map(async (row) => {
        const payload = await this.dependencies.aggregate.openNoteRevision(
          this.dependencies.access,
          row.snapshotCipher,
          {
            revisionId: row.revisionId,
            revision: row.revision,
            transition: revisionTransition(row)
          }
        );
        if (
          payload.snapshot.spaceId !== row.spaceId ||
          payload.snapshot.type !== row.type ||
          payload.snapshot.isOpen !== row.isOpen ||
          payload.snapshot.pinnedAt !== row.pinnedAt ||
          payload.snapshot.privacy !== row.privacy ||
          payload.snapshot.archivedAt !== row.archivedAt ||
          payload.snapshot.deletedAt !== row.deletedAt
        ) {
          return unavailable();
        }
        return NoteRevisionSchema.parse({
          ...payload.snapshot,
          id: row.revisionId,
          noteId: row.noteId,
          revision: row.revision,
          source: row.source,
          actor: row.actor,
          contentHash: row.snapshotMac.value,
          createdAt: row.createdAt
        });
      })
    );
  }

  private async revision(
    noteId: EntityId<"note">,
    revisionId: EntityId<"rev">
  ): Promise<RevisionRecord> {
    let offset = 0;
    while (offset < MAX_LIST_SCAN) {
      const page = await this.listRevisions(noteId, { limit: MAX_READ_PAGE_SIZE, offset });
      const match = page.find(({ id }) => id === revisionId);
      if (match !== undefined) return match;
      if (page.length < MAX_READ_PAGE_SIZE) break;
      offset += page.length;
    }
    throw new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND);
  }

  public async createNote(
    input: CreateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult> {
    const intent = CreateIntentSchema.parse({ action: "create", ...input });
    const logicalRequest: LogicalApiRequest<typeof intent> = Object.freeze({
      schemaVersion: 1,
      scope: "create_encrypted_note",
      targetResourceId: null,
      expectedRevision: 0,
      payload: intent
    });
    const result = await executeEncryptedNoteWrite(
      {
        adapter: this.dependencies.writes,
        aggregate: this.dependencies.aggregate,
        access: this.dependencies.access
      },
      {
        coordinates: Object.freeze({
          ownerId: this.dependencies.ownerId,
          scope: "create_encrypted_note",
          idempotencyKey,
          noteId: null,
          expectedRevision: 0
        }),
        logicalRequest,
        requestCodec: CreateIntentSchema,
        responseCodec: StoredMutationResponseSchema,
        resolveNewTransition: () =>
          Promise.resolve(Object.freeze({ before: null, after: input.privacy })),
        buildMaterial: (claim) => Promise.resolve(createMaterial(claim, input))
      }
    );
    return publicMutationResult(result.response, result.replayed);
  }

  private async mutate(
    noteId: EntityId<"note">,
    expectedRevision: number,
    idempotencyKey: string,
    intent: MutationIntent,
    operationsFor: (
      claim: IncompleteEncryptedNoteWriteClaim,
      current: DecryptedNote
    ) => readonly UserOperation[] | Promise<readonly UserOperation[]>,
    targetPrivacyFor?: (current: DecryptedNote) => PrivacyMode | Promise<PrivacyMode>,
    metadata: Readonly<{
      actor?: string;
      source?: NoteRevisionDto["source"];
      undoTargetMutationId?: EntityId<"mut"> | null;
    }> = {}
  ): Promise<NoteMutationResult> {
    let cached: DecryptedNote | null = null;
    const read = async () => {
      cached ??= await this.current(noteId);
      return cached;
    };
    const logicalRequest: LogicalApiRequest<MutationIntent> = Object.freeze({
      schemaVersion: 1,
      scope: "apply_encrypted_note_mutation",
      targetResourceId: noteId,
      expectedRevision,
      payload: MutationIntentSchema.parse(intent)
    });
    const result = await executeEncryptedNoteWrite(
      {
        adapter: this.dependencies.writes,
        aggregate: this.dependencies.aggregate,
        access: this.dependencies.access
      },
      {
        coordinates: Object.freeze({
          ownerId: this.dependencies.ownerId,
          scope: "apply_encrypted_note_mutation",
          idempotencyKey,
          noteId,
          expectedRevision
        }),
        logicalRequest,
        requestCodec: MutationIntentSchema,
        responseCodec: StoredMutationResponseSchema,
        resolveNewTransition: async () => {
          const current = await read();
          const after =
            targetPrivacyFor === undefined ? current.note.privacy : await targetPrivacyFor(current);
          return Object.freeze({ before: current.note.privacy, after });
        },
        buildMaterial: async (claim) =>
          updateMaterial(claim, await read(), await operationsFor(claim, await read()), metadata)
      }
    );
    return publicMutationResult(result.response, result.replayed);
  }

  public async applyOperations(
    noteId: EntityId<"note">,
    operations: readonly UserOperation[],
    input: Readonly<{ expectedRevision: number; idempotencyKey: string }>
  ): Promise<NoteMutationResult> {
    const parsed = OperationsIntentSchema.parse({ action: "apply_operations", operations });
    return this.mutate(
      noteId,
      input.expectedRevision,
      input.idempotencyKey,
      parsed,
      () => parsed.operations,
      (current) => transitionAfter(parsed.operations, current.note.privacy)
    );
  }

  public async updateNote(
    noteId: EntityId<"note">,
    input: UpdateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult> {
    const operations: UserOperation[] = [
      ...(input.title === undefined ? [] : [{ type: "set_title" as const, title: input.title }]),
      ...(input.bodyMarkdown === undefined
        ? []
        : [{ type: "replace_body_markdown" as const, bodyMarkdown: input.bodyMarkdown }]),
      ...(input.privacy === undefined
        ? []
        : [{ type: "set_privacy" as const, privacy: input.privacy }]),
      ...(input.spaceId === undefined
        ? []
        : [{ type: "move_to_space" as const, spaceId: input.spaceId }]),
      ...(input.tagIds === undefined
        ? []
        : [{ type: "set_tags" as const, tagIds: [...input.tagIds] }]),
      ...(input.links === undefined
        ? []
        : [{ type: "set_note_links" as const, links: [...input.links] }])
    ];
    return this.applyOperations(noteId, operations, {
      expectedRevision: input.expectedRevision,
      idempotencyKey
    });
  }

  public async moveNote(
    noteId: EntityId<"note">,
    input: Readonly<{
      expectedRevision: number;
      idempotencyKey: string;
      spaceId: EntityId<"spc"> | null;
    }>
  ) {
    return this.applyOperations(noteId, [{ type: "move_to_space", spaceId: input.spaceId }], input);
  }

  public async archiveNote(
    noteId: EntityId<"note">,
    input: Readonly<{
      expectedRevision: number;
      idempotencyKey: string;
      archived: boolean;
    }>
  ) {
    const intent = ArchiveIntentSchema.parse({ action: "archive", archived: input.archived });
    return this.mutate(noteId, input.expectedRevision, input.idempotencyKey, intent, (claim) => [
      { type: "set_archived", archivedAt: input.archived ? claim.occurredAt : null }
    ]);
  }

  public async deleteNote(
    noteId: EntityId<"note">,
    input: Readonly<{ expectedRevision: number; idempotencyKey: string }>
  ) {
    const intent = DeleteNoteIntentSchema.parse({ action: "delete_note" });
    return this.mutate(noteId, input.expectedRevision, input.idempotencyKey, intent, (claim) => [
      { type: "set_deleted", deletedAt: claim.occurredAt }
    ]);
  }

  public async restoreDeletedNote(
    noteId: EntityId<"note">,
    input: Readonly<{ expectedRevision: number; idempotencyKey: string }>
  ) {
    return this.mutate(
      noteId,
      input.expectedRevision,
      input.idempotencyKey,
      RestoreDeletedIntentSchema.parse({ action: "restore_deleted" }),
      () => [{ type: "set_deleted", deletedAt: null }]
    );
  }

  public async restoreRevision(
    noteId: EntityId<"note">,
    revisionId: EntityId<"rev">,
    input: Readonly<{ expectedRevision: number; idempotencyKey: string }>
  ): Promise<NoteMutationResult> {
    let target: RevisionRecord | null = null;
    const targetRevision = async () => {
      target ??= await this.revision(noteId, revisionId);
      return target;
    };
    return this.mutate(
      noteId,
      input.expectedRevision,
      input.idempotencyKey,
      RestoreIntentSchema.parse({ action: "restore_revision", revisionId }),
      async (claim, current) => {
        const restored = restoreNoteRevision(current.note, await targetRevision(), {
          expectedRevision: claim.expectedRevision,
          now: claim.occurredAt,
          idFactory: claimIdFactory(claim)
        });
        return restored.mutation.operations;
      },
      async () => (await targetRevision()).privacy,
      { actor: "user:restore", source: "manual" }
    );
  }

  public async linkTag(
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: Readonly<{ expectedRevision: number; idempotencyKey: string }>
  ) {
    return this.mutate(
      noteId,
      input.expectedRevision,
      input.idempotencyKey,
      LinkTagIntentSchema.parse({ action: "link_tag", tagId }),
      (_claim, current) => [
        { type: "set_tags", tagIds: [...new Set([...current.note.tagIds, tagId])] }
      ]
    );
  }

  public async unlinkTag(
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: Readonly<{ expectedRevision: number; idempotencyKey: string }>
  ) {
    return this.mutate(
      noteId,
      input.expectedRevision,
      input.idempotencyKey,
      UnlinkTagIntentSchema.parse({ action: "unlink_tag", tagId }),
      (_claim, current) => [
        { type: "set_tags", tagIds: current.note.tagIds.filter((id) => id !== tagId) }
      ]
    );
  }

  public async createLink(
    noteId: EntityId<"note">,
    input: Readonly<{
      expectedRevision: number;
      idempotencyKey: string;
      linkType: "reference" | "related";
      toNoteId: EntityId<"note">;
    }>
  ) {
    const requested: NoteLinkValue = { linkType: input.linkType, toNoteId: input.toNoteId };
    return this.mutate(
      noteId,
      input.expectedRevision,
      input.idempotencyKey,
      CreateLinkIntentSchema.parse({
        action: "create_link",
        linkType: input.linkType,
        toNoteId: input.toNoteId
      }),
      (_claim, current) => [{ type: "set_note_links", links: [...current.note.links, requested] }]
    );
  }

  public async deleteLink(
    noteId: EntityId<"note">,
    linkId: EntityId<"lnk">,
    input: Readonly<{
      expectedRevision: number;
      idempotencyKey: string;
      linkType: "reference" | "related";
      toNoteId: EntityId<"note">;
    }>
  ) {
    return this.mutate(
      noteId,
      input.expectedRevision,
      input.idempotencyKey,
      DeleteLinkIntentSchema.parse({
        action: "delete_link",
        linkId,
        linkType: input.linkType,
        toNoteId: input.toNoteId
      }),
      (_claim, current) => {
        const persisted = current.record.links.find(({ id }) => id === linkId);
        if (persisted?.linkType !== input.linkType || persisted.toNoteId !== input.toNoteId) {
          throw new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND);
        }
        return [
          {
            type: "set_note_links",
            links: current.note.links.filter(
              (link) => link.linkType !== input.linkType || link.toNoteId !== input.toNoteId
            )
          }
        ];
      }
    );
  }

  private async openMutation(row: EncryptedNoteMutationRead): Promise<NoteMutationPayload> {
    const transition = Object.freeze({
      before: row.beforeSnapshot?.privacy ?? null,
      after: row.afterSnapshot.privacy
    });
    const payload = await this.dependencies.aggregate.openNoteMutation(
      this.dependencies.access,
      row.mutationCipher,
      {
        mutationId: row.mutationId,
        afterRevision: row.afterRevision,
        transition
      }
    );
    if (
      payload.beforeRevision !== row.beforeRevision ||
      payload.afterRevision !== row.afterRevision ||
      payload.beforeSnapshot?.privacy !== (row.beforeSnapshot?.privacy ?? undefined) ||
      payload.afterSnapshot.privacy !== row.afterSnapshot.privacy
    ) {
      return unavailable();
    }
    return payload;
  }

  public async undoMutation(
    mutationId: EntityId<"mut">,
    input: Readonly<{ expectedRevision: number; idempotencyKey: string }>
  ): Promise<NoteMutationResult> {
    const existingClaim = await this.dependencies.writes.getWriteClaim({
      ownerId: this.dependencies.ownerId,
      scope: "apply_encrypted_note_mutation",
      idempotencyKey: input.idempotencyKey
    });
    let storedMutation: EncryptedNoteMutationRead | null = null;
    const stored = async () => {
      storedMutation ??= await this.getMutation(mutationId);
      return storedMutation;
    };
    const noteId = existingClaim?.noteId ?? (await stored()).noteId;
    let openedMutation: NoteMutationPayload | null = null;
    const opened = async () => {
      openedMutation ??= await this.openMutation(await stored());
      return openedMutation;
    };
    return this.mutate(
      noteId,
      input.expectedRevision,
      input.idempotencyKey,
      UndoIntentSchema.parse({ action: "undo_mutation", mutationId }),
      async (claim, current) => {
        const row = await stored();
        const payload = await opened();
        if (
          row.noteId !== current.note.id ||
          row.undoneAt !== null ||
          row.afterRevision !== claim.expectedRevision
        ) {
          throw new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION);
        }
        if (payload.action === "create") {
          return [{ type: "set_deleted", deletedAt: claim.occurredAt }];
        }
        const original: NoteMutation = Object.freeze({
          id: mutationId,
          noteId: row.noteId,
          beforeRevision: payload.beforeRevision,
          afterRevision: payload.afterRevision,
          operations: payload.operations,
          inverse: payload.inverse,
          beforeSnapshot: payload.beforeSnapshot,
          afterSnapshot: payload.afterSnapshot,
          createdAt: row.createdAt,
          undoneAt: row.undoneAt
        });
        return undoNoteMutation(current.note, original, {
          expectedRevision: claim.expectedRevision,
          now: claim.occurredAt,
          idFactory: claimIdFactory(claim)
        }).mutation.operations;
      },
      async (current) => (await opened()).beforeSnapshot?.privacy ?? current.note.privacy,
      {
        actor: "user:undo",
        source: "undo",
        undoTargetMutationId: mutationId
      }
    );
  }

  public async getMutation(mutationId: EntityId<"mut">): Promise<EncryptedNoteMutationRead> {
    return this.dependencies.reads.getMutation({
      ownerId: this.dependencies.ownerId,
      mutationId
    });
  }
}

export const encryptedNoteMutationResponseCodec: PayloadCodec<StoredMutationResponse> =
  StoredMutationResponseSchema;
