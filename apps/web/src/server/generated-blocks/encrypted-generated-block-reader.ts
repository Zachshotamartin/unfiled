import {
  GENERATED_BLOCK_PAGE_SIZE,
  GeneratedBlockDtoSchema,
  GeneratedBlockListResponseSchema,
  entityIdSchema,
  type EntityId,
  type GeneratedBlockDto,
  type GeneratedBlockListResponse
} from "@unfiled/contracts";
import type {
  AuthorizedOwnerAccess,
  EncryptedAggregateService,
  GeneratedBlockPayload
} from "@unfiled/encrypted-aggregate";

import type {
  EncryptedCaptureRpcAdapter,
  EncryptedGeneratedBlockRead
} from "@/server/encryption/encrypted-capture-rpc-adapter";
import type {
  EncryptedLibraryObject,
  EncryptedLibraryPage,
  EncryptedLibraryRpcStore
} from "@/server/encryption/encrypted-library-rpc-store";
import {
  ServiceRpcError,
  ServiceRpcErrorCode,
  throwIfServiceOperationAborted
} from "@/server/encryption/service-rpc-client";

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function parsedBlockId(value: string): EntityId<"blk"> {
  const parsed = entityIdSchema("blk").safeParse(value);
  return parsed.success ? parsed.data : unavailable();
}

function parsedBlock(value: unknown): GeneratedBlockDto {
  const parsed = GeneratedBlockDtoSchema.safeParse(value);
  return parsed.success ? parsed.data : unavailable();
}

function dtoFromOpened(
  row: EncryptedGeneratedBlockRead,
  payload: GeneratedBlockPayload
): GeneratedBlockDto {
  return parsedBlock({
    id: row.blockId,
    noteId: row.noteId,
    decisionId: row.decisionId,
    kind: row.kind,
    content: payload.content,
    state: row.state,
    stateRevision: row.stateRevision,
    modelId: row.modelId,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt
  });
}

export type EncryptedGeneratedBlockResolutionSource = Readonly<{
  block: GeneratedBlockDto;
  payload: GeneratedBlockPayload;
  source: EncryptedGeneratedBlockRead;
}>;

export type EncryptedGeneratedBlockReaderDependencies = Readonly<{
  ownerId: string;
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  captureAdapter: EncryptedCaptureRpcAdapter;
  store: EncryptedLibraryRpcStore;
  signal?: AbortSignal;
}>;

/** Owner-authorized, fail-closed reader for separately encrypted E3 blocks. */
export class EncryptedGeneratedBlockReader {
  public constructor(private readonly dependencies: EncryptedGeneratedBlockReaderDependencies) {}

  private active(): void {
    if (this.dependencies.signal !== undefined) {
      throwIfServiceOperationAborted(this.dependencies.signal);
    }
  }

  private async openLibraryRow(
    row: EncryptedLibraryObject<"generated_block">
  ): Promise<GeneratedBlockDto> {
    this.active();
    const blockId = parsedBlockId(row.resourceId);
    const payload = await this.dependencies.aggregate.openGeneratedBlock(
      this.dependencies.access,
      row.encrypted,
      { blockId }
    );
    this.active();
    const operational = row.operational;
    return parsedBlock({
      id: blockId,
      noteId: operational.noteId,
      decisionId: operational.decisionId,
      kind: operational.kind,
      content: payload.content,
      state: operational.state,
      stateRevision: operational.stateRevision,
      modelId: operational.modelId,
      promptVersion: operational.promptVersion,
      createdAt: operational.createdAt,
      resolvedAt: operational.resolvedAt
    });
  }

  public async find(
    blockId: EntityId<"blk">
  ): Promise<EncryptedGeneratedBlockResolutionSource | null> {
    this.active();
    const rows = await this.dependencies.captureAdapter.getGeneratedBlocks({
      ownerId: this.dependencies.ownerId,
      blockIds: Object.freeze([blockId])
    });
    this.active();
    if (rows.length === 0) return null;
    const source = rows[0];
    if (rows.length !== 1 || source?.blockId !== blockId) return unavailable();
    const payload = await this.dependencies.aggregate.openGeneratedBlock(
      this.dependencies.access,
      source.contentCipher,
      { blockId }
    );
    this.active();
    return Object.freeze({ source, payload, block: dtoFromOpened(source, payload) });
  }

  public async get(blockId: EntityId<"blk">): Promise<EncryptedGeneratedBlockResolutionSource> {
    return (await this.find(blockId)) ?? unavailable();
  }

  public async listForNote(
    noteId: EntityId<"note">,
    afterBlockId: EntityId<"blk"> | null = null
  ): Promise<GeneratedBlockListResponse> {
    const seenBlockIds = new Set<string>();
    const items: GeneratedBlockDto[] = [];
    this.active();
    const page: EncryptedLibraryPage<"generated_block"> =
      await this.dependencies.store.listEncryptedGeneratedBlocksForNote({
        ownerId: this.dependencies.ownerId,
        noteId,
        afterBlockId
      });
    this.active();

    let previousBlockId: string | null = afterBlockId;
    for (const row of page.items) {
      if (
        seenBlockIds.has(row.resourceId) ||
        row.operational.noteId !== noteId ||
        row.operational.state === "rejected" ||
        (previousBlockId !== null && row.resourceId <= previousBlockId)
      ) {
        return unavailable();
      }
      seenBlockIds.add(row.resourceId);
      previousBlockId = row.resourceId;
    }

    const nextCursor = page.nextCursor;
    const lastBlockId = page.items.at(-1)?.resourceId ?? null;
    if (
      page.items.length > GENERATED_BLOCK_PAGE_SIZE ||
      (nextCursor !== null &&
        (page.items.length !== GENERATED_BLOCK_PAGE_SIZE ||
          nextCursor !== lastBlockId ||
          (afterBlockId !== null && nextCursor <= afterBlockId)))
    ) {
      return unavailable();
    }
    for (const row of page.items) {
      const block = await this.openLibraryRow(row);
      if (block.noteId !== noteId) return unavailable();
      items.push(block);
    }
    const parsed = GeneratedBlockListResponseSchema.safeParse({
      items,
      pageInfo: {
        hasMore: nextCursor !== null,
        nextCursor
      }
    });
    return parsed.success ? parsed.data : unavailable();
  }
}
