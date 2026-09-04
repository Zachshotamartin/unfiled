import {
  AccountExportCaptureSchema,
  type AccountExportCapture,
  type AccountExportRoutingRule,
  type AccountExportSpace,
  type AccountExportTag,
  type EntityId,
  type NoteType,
  type PrivacyMode
} from "@unfiled/contracts";
import {
  CapturePayloadSchema,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";

import type { NoteRecord } from "@/lib/product/types";

import type {
  EncryptedLibraryObject,
  EncryptedLibraryPage,
  EncryptedLibraryRpcStore
} from "./encrypted-library-rpc-store";
import { EncryptedNoteAggregateRepository } from "./encrypted-note-aggregate-repository";
import type { EncryptedCaptureRpcAdapter } from "./encrypted-capture-rpc-adapter";
import type { EncryptedNoteReadRpcAdapter } from "./encrypted-note-read-rpc-adapter";
import type { EncryptedNoteRpcAdapter } from "./encrypted-note-rpc-adapter";
import type { EncryptedOwnerDataRpcAdapter } from "./encrypted-owner-data-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const NOTE_PAGE_SIZE = 25;
const TAXONOMY_PAGE_SIZE = 50;
const ROUTING_RULE_PAGE_SIZE = 50;
const CAPTURE_PAGE_SIZE = 25;
const MAX_EXPORT_NOTES = 100_000;
const MAX_EXPORT_TAXONOMY_RECORDS = 1_000;
const MAX_EXPORT_ROUTING_RULES = 10_000;
const MAX_EXPORT_CAPTURES = 100_000;

export type OwnerExportNote = Readonly<{
  id: EntityId<"note">;
  spaceId: EntityId<"spc"> | null;
  spacePath: string | null;
  type: NoteType;
  title: string;
  bodyMarkdown: string;
  privacy: PrivacyMode;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  tagIds: readonly EntityId<"tag">[];
  links: readonly Readonly<{
    toNoteId: EntityId<"note">;
    linkType: "reference" | "related";
  }>[];
  sourceCaptureIds: readonly EntityId<"cap">[];
}>;

export type OwnerExportAttachment = Readonly<{
  kind: "image" | "audio";
  mediaType: string;
  bytes: Uint8Array;
}>;

export type OwnerExportSource = Readonly<{
  spacePages(): AsyncIterable<readonly AccountExportSpace[]>;
  tagPages(): AsyncIterable<readonly AccountExportTag[]>;
  notePages(): AsyncIterable<readonly OwnerExportNote[]>;
  routingRulePages(): AsyncIterable<readonly AccountExportRoutingRule[]>;
  /** Every capture the owner has, including the ones no note has absorbed yet. */
  capturePages(): AsyncIterable<readonly AccountExportCapture[]>;
  /** The decrypted bytes of one attachment the owner's notes place, or null when it is gone. */
  attachment(id: EntityId<"att">): Promise<OwnerExportAttachment | null>;
}>;

type Dependencies = Readonly<{
  ownerId: string;
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  reads: EncryptedNoteReadRpcAdapter;
  library: EncryptedLibraryRpcStore;
  ownerData: EncryptedOwnerDataRpcAdapter;
  captures: Pick<EncryptedCaptureRpcAdapter, "getAttachment" | "listAttachments" | "listCaptures">;
  signal?: AbortSignal;
}>;

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

const readOnlyWrites = Object.freeze({
  getWriteClaim: () => Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.FORBIDDEN)),
  prepareWrite: () => Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.FORBIDDEN)),
  createNote: () => Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.FORBIDDEN)),
  applyMutation: () => Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.FORBIDDEN))
}) as unknown as EncryptedNoteRpcAdapter;

function exactDetail(
  summary: {
    noteId: EntityId<"note">;
    currentRevision: number;
    spaceId: EntityId<"spc"> | null;
    type: NoteType;
    privacy: PrivacyMode;
    archivedAt: string | null;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
  },
  detail: NoteRecord
): void {
  if (
    detail.id !== summary.noteId ||
    detail.currentRevision !== summary.currentRevision ||
    detail.spaceId !== summary.spaceId ||
    detail.type !== summary.type ||
    detail.privacy !== summary.privacy ||
    detail.archivedAt !== summary.archivedAt ||
    detail.deletedAt !== summary.deletedAt ||
    detail.createdAt !== summary.createdAt ||
    detail.updatedAt !== summary.updatedAt
  ) {
    unavailable();
  }
}

/**
 * Bounded, repeatable plaintext view used only inside one owner-authorized key
 * custody callback. Each page is released before the next page is opened.
 */
export class EncryptedOwnerExportSource implements OwnerExportSource {
  private readonly notes: EncryptedNoteAggregateRepository;

  public constructor(private readonly dependencies: Dependencies) {
    this.notes = new EncryptedNoteAggregateRepository({
      ownerId: dependencies.ownerId,
      access: dependencies.access,
      aggregate: dependencies.aggregate,
      reads: dependencies.reads,
      writes: readOnlyWrites
    });
  }

  public async attachment(id: EntityId<"att">): Promise<OwnerExportAttachment | null> {
    throwIfAborted(this.dependencies.signal);
    const row = await this.dependencies.captures.getAttachment({
      ownerId: this.dependencies.ownerId,
      attachmentId: id
    });
    if (row === null) return null;
    const payload = await this.dependencies.aggregate.openCaptureAttachment(
      this.dependencies.access,
      Object.freeze({ encrypted: row.contentCipher, contentMac: row.contentMac }),
      {
        attachmentId: row.attachmentId,
        captureId: row.captureId,
        recordVersion: 1,
        privacy: row.privacy
      }
    );
    const bytes = new Uint8Array(Buffer.from(payload.dataBase64, "base64"));
    if (
      payload.kind !== row.kind ||
      payload.mediaType !== row.mediaType ||
      bytes.byteLength !== row.byteLength
    )
      unavailable();
    return Object.freeze({ kind: row.kind, mediaType: row.mediaType, bytes });
  }

  /**
   * Every capture the owner has, oldest page first. A capture that is still queued, still being
   * organized, waiting in Review, kept in the Inbox, or failed exists nowhere else in the
   * archive, and the owner's words are not allowed to be the one thing an export leaves behind.
   */
  public async *capturePages(): AsyncIterable<readonly AccountExportCapture[]> {
    let cursor: Parameters<EncryptedCaptureRpcAdapter["listCaptures"]>[0]["cursor"] = null;
    let total = 0;
    const seenCursors = new Set<string>();
    for (;;) {
      throwIfAborted(this.dependencies.signal);
      const page = await this.dependencies.captures.listCaptures({
        ownerId: this.dependencies.ownerId,
        cursor,
        limit: CAPTURE_PAGE_SIZE
      });
      if (page.captures.length === 0) {
        if (page.nextCursor !== null) unavailable();
        return;
      }
      total += page.captures.length;
      if (total > MAX_EXPORT_CAPTURES) unavailable();
      const captures = await Promise.all(
        page.captures.map(async (row): Promise<AccountExportCapture> => {
          throwIfAborted(this.dependencies.signal);
          const payload = CapturePayloadSchema.parse(
            await this.dependencies.aggregate.openCapture(
              this.dependencies.access,
              Object.freeze({ encrypted: row.contentCipher, contentMac: row.contentMac }),
              {
                captureId: row.captureId,
                recordVersion: row.recordVersion,
                privacy: row.privacy
              }
            )
          );
          if (payload.rawContent.length !== row.contentLength) unavailable();
          const attachments = await this.dependencies.captures.listAttachments({
            ownerId: this.dependencies.ownerId,
            captureId: row.captureId
          });
          return AccountExportCaptureSchema.parse({
            id: row.captureId,
            rawContent: payload.rawContent,
            source: row.source,
            privacy: row.privacy,
            status: row.status,
            lastErrorCode: row.lastErrorCode,
            clientCreatedAt: row.clientCreatedAt,
            receivedAt: row.receivedAt,
            attachments: attachments.map(({ attachmentId, kind }) => ({ id: attachmentId, kind }))
          });
        })
      );
      yield Object.freeze(captures);

      const next = page.nextCursor;
      if (next === null) return;
      const serialized = `${next.receivedAt}:${next.captureId}`;
      if (seenCursors.has(serialized)) unavailable();
      seenCursors.add(serialized);
      cursor = next;
    }
  }

  public async *notePages(): AsyncIterable<readonly OwnerExportNote[]> {
    let cursor = null;
    let total = 0;
    const seenCursors = new Set<string>();
    for (;;) {
      throwIfAborted(this.dependencies.signal);
      const page = await this.dependencies.reads.listNotes({
        ownerId: this.dependencies.ownerId,
        cursor,
        limit: NOTE_PAGE_SIZE
      });
      if (page.notes.length === 0) {
        if (page.nextCursor !== null) unavailable();
        return;
      }
      total += page.notes.length;
      if (total > MAX_EXPORT_NOTES) unavailable();
      const sourceRows = await this.dependencies.ownerData.listNoteSources({
        ownerId: this.dependencies.ownerId,
        noteIds: page.notes.map(({ noteId }) => noteId)
      });
      const sources = new Map(sourceRows.map((row) => [row.noteId, row.sourceCaptureIds] as const));
      const details = await Promise.all(page.notes.map(({ noteId }) => this.notes.getNote(noteId)));
      const output = page.notes.map((summary, index): OwnerExportNote => {
        const detail = details[index] ?? unavailable();
        const sourceCaptureIds = sources.get(summary.noteId) ?? unavailable();
        exactDetail(summary, detail);
        return Object.freeze({
          id: detail.id,
          spaceId: detail.spaceId,
          spacePath: detail.spacePath,
          type: detail.type,
          title: detail.title,
          bodyMarkdown: detail.bodyMarkdown,
          privacy: detail.privacy,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          archivedAt: detail.archivedAt,
          deletedAt: detail.deletedAt,
          tagIds: Object.freeze([...detail.tagIds]),
          links: Object.freeze(
            detail.links.map(({ toNoteId, linkType }) => Object.freeze({ toNoteId, linkType }))
          ),
          sourceCaptureIds
        });
      });
      yield Object.freeze(output);

      const next = page.nextCursor;
      if (next === null) return;
      const serialized = `${next.updatedAt}:${next.noteId}`;
      if (seenCursors.has(serialized)) unavailable();
      seenCursors.add(serialized);
      cursor = next;
    }
  }

  public async *spacePages(): AsyncIterable<readonly AccountExportSpace[]> {
    const rows: EncryptedLibraryObject<"space_display">[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      throwIfAborted(this.dependencies.signal);
      const page: EncryptedLibraryPage<"space_display"> =
        await this.dependencies.library.listEncryptedLibraryObjects({
          ownerId: this.dependencies.ownerId,
          surface: "space_display",
          afterResourceId: cursor,
          limit: TAXONOMY_PAGE_SIZE
        });
      rows.push(...page.items);
      if (rows.length > MAX_EXPORT_TAXONOMY_RECORDS) unavailable();
      if (page.nextCursor === null) break;
      if (
        page.items.length === 0 ||
        page.nextCursor === cursor ||
        seenCursors.has(page.nextCursor)
      ) {
        unavailable();
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    const opened = await Promise.all(
      rows.map(async (row) => {
        throwIfAborted(this.dependencies.signal);
        if (row.contentMac === null) unavailable();
        const display = await this.dependencies.aggregate.openSpaceDisplay(
          this.dependencies.access,
          Object.freeze({ encrypted: row.encrypted, contentMac: row.contentMac }),
          {
            spaceId: row.resourceId as EntityId<"spc">,
            currentRevision: row.recordVersion
          }
        );
        return Object.freeze({ row, display });
      })
    );
    const byId = new Map(opened.map((entry) => [entry.row.resourceId, entry] as const));
    const spaces = opened
      .map(({ row, display }): AccountExportSpace => {
        const parent =
          row.operational.parentId === null
            ? null
            : (byId.get(row.operational.parentId) ?? unavailable());
        if (parent !== null && parent.row.operational.parentId !== null) unavailable();
        return {
          id: row.resourceId as EntityId<"spc">,
          parentId: row.operational.parentId as EntityId<"spc"> | null,
          name: display.name,
          path: parent === null ? display.name : `${parent.display.name} / ${display.name}`,
          archivedAt: row.operational.archivedAt,
          createdAt: row.operational.createdAt,
          updatedAt: row.operational.updatedAt
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    for (let offset = 0; offset < spaces.length; offset += TAXONOMY_PAGE_SIZE) {
      yield Object.freeze(spaces.slice(offset, offset + TAXONOMY_PAGE_SIZE));
    }
  }

  public async *tagPages(): AsyncIterable<readonly AccountExportTag[]> {
    let cursor: string | null = null;
    let total = 0;
    const seenCursors = new Set<string>();
    for (;;) {
      throwIfAborted(this.dependencies.signal);
      const page: EncryptedLibraryPage<"tag_display"> =
        await this.dependencies.library.listEncryptedLibraryObjects({
          ownerId: this.dependencies.ownerId,
          surface: "tag_display",
          afterResourceId: cursor,
          limit: TAXONOMY_PAGE_SIZE
        });
      if (page.items.length === 0) {
        if (page.nextCursor !== null) unavailable();
        return;
      }
      total += page.items.length;
      if (total > MAX_EXPORT_TAXONOMY_RECORDS) unavailable();
      const tags = await Promise.all(
        page.items.map(async (row): Promise<AccountExportTag> => {
          throwIfAborted(this.dependencies.signal);
          if (row.contentMac === null) unavailable();
          const display = await this.dependencies.aggregate.openTagDisplay(
            this.dependencies.access,
            Object.freeze({ encrypted: row.encrypted, contentMac: row.contentMac }),
            {
              tagId: row.resourceId as EntityId<"tag">,
              currentRevision: row.recordVersion
            }
          );
          return {
            id: row.resourceId as EntityId<"tag">,
            name: display.name,
            createdAt: row.operational.createdAt,
            updatedAt: row.operational.updatedAt
          };
        })
      );
      yield Object.freeze(tags.sort((left, right) => left.id.localeCompare(right.id)));
      if (page.nextCursor === null) return;
      if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) unavailable();
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  public async *routingRulePages(): AsyncIterable<readonly AccountExportRoutingRule[]> {
    let cursor: string | null = null;
    let total = 0;
    const seenCursors = new Set<string>();
    for (;;) {
      throwIfAborted(this.dependencies.signal);
      const page: EncryptedLibraryPage<"routing_rule"> =
        await this.dependencies.library.listEncryptedLibraryObjects({
          ownerId: this.dependencies.ownerId,
          surface: "routing_rule",
          afterResourceId: cursor,
          limit: ROUTING_RULE_PAGE_SIZE
        });
      if (page.items.length === 0) {
        if (page.nextCursor !== null) unavailable();
        return;
      }
      total += page.items.length;
      if (total > MAX_EXPORT_ROUTING_RULES) unavailable();
      const rules = await Promise.all(
        page.items.map(async (row): Promise<AccountExportRoutingRule> => {
          const payload = await this.dependencies.aggregate.openRoutingRule(
            this.dependencies.access,
            row.encrypted,
            { ruleId: row.resourceId as EntityId<"rule">, recordVersion: row.recordVersion }
          );
          const operational = row.operational;
          if (
            (operational.destinationNoteId === null) ===
            (operational.destinationSpaceId === null)
          ) {
            return unavailable();
          }
          return Object.freeze({
            id: row.resourceId as EntityId<"rule">,
            enabled: operational.enabled,
            ruleType: operational.ruleType,
            condition: payload.condition,
            normalizedCondition: payload.normalizedCondition,
            aliases: [...payload.aliases],
            destinationNoteId: operational.destinationNoteId as EntityId<"note"> | null,
            destinationSpaceId: operational.destinationSpaceId as EntityId<"spc"> | null,
            priority: operational.priority,
            source: operational.source,
            lastFiredAt: operational.lastFiredAt,
            createdAt: operational.createdAt,
            updatedAt: operational.updatedAt
          });
        })
      );
      yield Object.freeze(rules);
      if (page.nextCursor === null) return;
      if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) unavailable();
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
}
