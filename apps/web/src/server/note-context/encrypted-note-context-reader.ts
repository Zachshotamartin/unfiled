import {
  NoteBacklinksResponseSchema,
  NoteSourcesResponseSchema,
  type EntityId,
  type NoteBacklinksQuery,
  type NoteBacklinksResponse,
  type NoteSourcesQuery,
  type NoteSourcesResponse
} from "@unfiled/contracts";
import type {
  AuthorizedOwnerAccess,
  EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";

import { ServiceRpcError, ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";

import {
  decodeNoteContextCursor,
  encodeNoteContextCursor,
  type NoteContextCursorSurface
} from "./cursor";
import type {
  EncryptedNoteBacklinkRow,
  EncryptedNoteSourceRow,
  NoteContextRpcAdapter,
  NoteSourcePageCursor,
  NoteBacklinkPageCursor
} from "./note-context-rpc-adapter";

// A note-content envelope may be up to 1.5 MB. Five rows keep every privileged
// RPC response below the service client's 8 MiB ceiling even at the storage
// maximum; the public API page is assembled across these bounded batches.
const MAX_ENCRYPTED_BACKLINK_RPC_PAGE_SIZE = 5;

type Dependencies = Readonly<{
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  cursorKey: Buffer;
  ownerId: string;
  rpc: NoteContextRpcAdapter;
}>;

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function checkedResponse<T>(
  schema: Readonly<{
    safeParse(value: unknown): Readonly<{ data: T; success: true } | { success: false }>;
  }>,
  value: unknown
): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : unavailable();
}

function sourceCursor(row: EncryptedNoteSourceRow): NoteSourcePageCursor {
  return Object.freeze({
    captureId: row.captureId,
    mutationId: row.mutationId,
    createdAt: row.createdAt
  });
}

function backlinkCursor(row: EncryptedNoteBacklinkRow): NoteBacklinkPageCursor {
  return Object.freeze({ linkId: row.linkId, createdAt: row.createdAt });
}

export class EncryptedNoteContextReader {
  public constructor(private readonly dependencies: Dependencies) {}

  private decodedCursor(
    cursor: string | undefined,
    noteId: EntityId<"note">,
    surface: NoteContextCursorSurface
  ) {
    return cursor === undefined
      ? null
      : decodeNoteContextCursor({
          cursor,
          key: this.dependencies.cursorKey,
          noteId,
          ownerId: this.dependencies.ownerId,
          surface
        });
  }

  public async listSources(
    noteId: EntityId<"note">,
    query: NoteSourcesQuery
  ): Promise<NoteSourcesResponse> {
    const cursor = this.decodedCursor(query.cursor, noteId, "sources");
    const page = await this.dependencies.rpc.listSources({
      ownerId: this.dependencies.ownerId,
      noteId,
      limit: query.limit + 1,
      expectedNoteRevision: cursor?.expectedNoteRevision ?? null,
      after: (cursor?.after as NoteSourcePageCursor | undefined) ?? null
    });
    const hasMore = page.items.length > query.limit;
    const visible = page.items.slice(0, query.limit);
    const items = await Promise.all(
      visible.map(async (row) => {
        const payload = await this.dependencies.aggregate.openCapture(
          this.dependencies.access,
          Object.freeze({ encrypted: row.contentCipher, contentMac: row.contentMac }),
          { captureId: row.captureId, recordVersion: 1, privacy: row.privacy }
        );
        if (payload.rawContent.length !== row.contentLength) return unavailable();
        return {
          captureId: row.captureId,
          mutationId: row.mutationId,
          relation: row.relation,
          rawContent: payload.rawContent,
          source: row.source,
          clientCreatedAt: row.clientCreatedAt,
          insertedItemIds: [...row.insertedItemIds],
          createdAt: row.createdAt
        };
      })
    );
    const last = visible.at(-1);
    return checkedResponse(NoteSourcesResponseSchema, {
      items,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? encodeNoteContextCursor({
                after: sourceCursor(last),
                key: this.dependencies.cursorKey,
                noteId,
                ownerId: this.dependencies.ownerId,
                revision: page.currentRevision,
                surface: "sources"
              })
            : null
      }
    });
  }

  public async listBacklinks(
    noteId: EntityId<"note">,
    query: NoteBacklinksQuery
  ): Promise<NoteBacklinksResponse> {
    const cursor = this.decodedCursor(query.cursor, noteId, "backlinks");
    const requestedCount = query.limit + 1;
    const rows: EncryptedNoteBacklinkRow[] = [];
    let expectedNoteRevision = cursor?.expectedNoteRevision ?? null;
    let after = (cursor?.after as NoteBacklinkPageCursor | undefined) ?? null;
    while (rows.length < requestedCount) {
      const batchLimit = Math.min(
        MAX_ENCRYPTED_BACKLINK_RPC_PAGE_SIZE,
        requestedCount - rows.length
      );
      const page = await this.dependencies.rpc.listBacklinks({
        ownerId: this.dependencies.ownerId,
        noteId,
        limit: batchLimit,
        expectedNoteRevision,
        after
      });
      if (expectedNoteRevision !== null && page.currentRevision !== expectedNoteRevision) {
        return unavailable();
      }
      expectedNoteRevision = page.currentRevision;
      rows.push(...page.items);
      if (page.items.length < batchLimit) break;
      const batchLast = page.items.at(-1);
      if (batchLast === undefined) return unavailable();
      after = backlinkCursor(batchLast);
    }
    if (expectedNoteRevision === null) return unavailable();
    const hasMore = rows.length > query.limit;
    const visible = rows.slice(0, query.limit);
    const items = await Promise.all(
      visible.map(async (row) => {
        const payload = await this.dependencies.aggregate.openNoteContent(
          this.dependencies.access,
          row.fromContentCipher,
          {
            noteId: row.fromNoteId,
            currentRevision: row.fromNoteRevision,
            privacy: row.fromPrivacy
          }
        );
        return {
          linkId: row.linkId,
          fromNoteId: row.fromNoteId,
          fromTitle: payload.title,
          linkType: row.linkType,
          createdAt: row.createdAt
        };
      })
    );
    const last = visible.at(-1);
    return checkedResponse(NoteBacklinksResponseSchema, {
      items,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? encodeNoteContextCursor({
                after: backlinkCursor(last),
                key: this.dependencies.cursorKey,
                noteId,
                ownerId: this.dependencies.ownerId,
                revision: expectedNoteRevision,
                surface: "backlinks"
              })
            : null
      }
    });
  }
}
