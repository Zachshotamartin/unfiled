import {
  ReviewItemDtoSchema,
  ReviewProposalSchema,
  type EntityId,
  type ReviewItemDto,
  type ReviewProposal,
  type ReviewState,
  type ReviewType
} from "@unfiled/contracts";
import type {
  AuthorizedOwnerAccess,
  EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";

import type { SpaceRecord, TagRecord } from "@/lib/product/types";
import type { RepositoryPage } from "@/server/product/repository";

import type {
  EncryptedLibraryPage,
  EncryptedLibraryObject,
  EncryptedLibraryRpcStore,
  EncryptedLibrarySurface
} from "./encrypted-library-rpc-store";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const PAGE_SIZE = 50;
const MAX_OBJECTS_PER_SURFACE = 1_000;

type Dependencies = Readonly<{
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  ownerId: string;
  store: EncryptedLibraryRpcStore;
}>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

/** The contract's largest page, plus the one row the API reads past it to detect a next page. */
const MAX_REPOSITORY_PAGE = 100 + 1;

function boundedPage(page: RepositoryPage | undefined): RepositoryPage {
  const value = page ?? { limit: 100, offset: 0 };
  if (
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_REPOSITORY_PAGE ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    !Number.isSafeInteger(value.limit + value.offset)
  ) {
    return invalidInput();
  }
  return value;
}

function legacyReviewProposal(type: ReviewType, choices: readonly unknown[]): ReviewProposal {
  if (type === "revision_conflict") return { type: "conflict", reason: "revision" };
  if (type === "structure_conflict") return { type: "conflict", reason: "structure" };
  if (type === "pending_expansion") {
    return { type: "conflict", reason: "consent_controls" };
  }
  if (type === "duplicate_suggestion") {
    const duplicate = ReviewProposalSchema.safeParse({ type: "duplicate_notes", notes: choices });
    if (duplicate.success) return duplicate.data;
  }

  // Low-confidence routing and failed-job V1 ciphertext lack the plan/error
  // required by their frozen proposal types. Arbitrary choices cannot safely
  // recreate those authenticated semantics.
  return unavailable();
}

async function readCompleteSurface<Surface extends EncryptedLibrarySurface>(
  dependencies: Dependencies,
  surface: Surface
): Promise<readonly EncryptedLibraryObject<Surface>[]> {
  const items: EncryptedLibraryObject<Surface>[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
    const page: EncryptedLibraryPage<Surface> =
      await dependencies.store.listEncryptedLibraryObjects({
        ownerId: dependencies.ownerId,
        surface,
        afterResourceId: cursor,
        limit: PAGE_SIZE
      });
    if (page.surface !== surface || page.items.length > PAGE_SIZE) return unavailable();
    items.push(...page.items);
    if (items.length > MAX_OBJECTS_PER_SURFACE) return unavailable();
    if (page.nextCursor === null) return Object.freeze(items);
    if (page.items.length === 0 || page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
      return unavailable();
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/**
 * Owner-authorized taxonomy and Review reads over ciphertext-only database
 * projections. The complete bounded surface is decrypted before display-name
 * sorting/path construction because names are deliberately unavailable to SQL.
 */
export class EncryptedTaxonomyReadRepository {
  public constructor(private readonly dependencies: Dependencies) {}

  private async decryptedSpaces(): Promise<readonly SpaceRecord[]> {
    const rows = await readCompleteSurface(this.dependencies, "space_display");
    const decrypted = await Promise.all(
      rows.map(async (row) => {
        if (row.contentMac === null) return unavailable();
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
    const byId = new Map(decrypted.map((entry) => [entry.row.resourceId, entry] as const));
    return Object.freeze(
      decrypted.map(({ row, display }): SpaceRecord => {
        const operational = row.operational;
        const parent =
          operational.parentId === null ? null : (byId.get(operational.parentId) ?? unavailable());
        if (parent !== null && parent.row.operational.parentId !== null) return unavailable();
        return Object.freeze({
          id: row.resourceId as EntityId<"spc">,
          parentId: operational.parentId as EntityId<"spc"> | null,
          name: display.name,
          slug: display.slug,
          path: parent === null ? display.name : `${parent.display.name} / ${display.name}`,
          sortKey: operational.sortKey,
          archivedAt: operational.archivedAt,
          currentRevision: row.recordVersion,
          createdAt: operational.createdAt,
          updatedAt: operational.updatedAt
        });
      })
    );
  }

  private async decryptedTags(): Promise<readonly TagRecord[]> {
    const rows = await readCompleteSurface(this.dependencies, "tag_display");
    return Object.freeze(
      await Promise.all(
        rows.map(async (row): Promise<TagRecord> => {
          if (row.contentMac === null) return unavailable();
          const display = await this.dependencies.aggregate.openTagDisplay(
            this.dependencies.access,
            Object.freeze({ encrypted: row.encrypted, contentMac: row.contentMac }),
            {
              tagId: row.resourceId as EntityId<"tag">,
              currentRevision: row.recordVersion
            }
          );
          return Object.freeze({
            id: row.resourceId as EntityId<"tag">,
            name: display.name,
            currentRevision: row.recordVersion,
            createdAt: row.operational.createdAt
          });
        })
      )
    );
  }

  public async getSpace(spaceId: EntityId<"spc">): Promise<SpaceRecord> {
    const record = (await this.decryptedSpaces()).find(({ id }) => id === spaceId);
    if (record === undefined) throw new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND);
    return record;
  }

  public async getTag(tagId: EntityId<"tag">): Promise<TagRecord> {
    const record = (await this.decryptedTags()).find(({ id }) => id === tagId);
    if (record === undefined) throw new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND);
    return record;
  }

  public async listSpaces(
    includeArchived: boolean,
    page?: RepositoryPage
  ): Promise<readonly SpaceRecord[]> {
    const window = boundedPage(page);
    return (await this.decryptedSpaces())
      .filter(({ archivedAt }) => includeArchived || archivedAt === null)
      .sort((left, right) => {
        const sortOrder = left.sortKey.localeCompare(right.sortKey);
        return sortOrder === 0 ? left.id.localeCompare(right.id) : sortOrder;
      })
      .slice(window.offset, window.offset + window.limit);
  }

  public async listTags(page?: RepositoryPage): Promise<readonly TagRecord[]> {
    const window = boundedPage(page);
    return [...(await this.decryptedTags())]
      .sort((left, right) => {
        const nameOrder = left.name.localeCompare(right.name);
        return nameOrder === 0 ? left.id.localeCompare(right.id) : nameOrder;
      })
      .slice(window.offset, window.offset + window.limit);
  }

  public async listReviewItems(
    state: ReviewState,
    page?: RepositoryPage
  ): Promise<readonly ReviewItemDto[]> {
    const window = boundedPage(page);
    const rows = await readCompleteSurface(this.dependencies, "review_item");
    const selected = rows.filter(({ operational }) => operational.state === state);
    const records = await Promise.all(
      selected.map(async (row): Promise<ReviewItemDto> => {
        const payload = await this.dependencies.aggregate.openReview(
          this.dependencies.access,
          row.encrypted,
          {
            reviewId: row.resourceId as EntityId<"rvw">,
            recordVersion: row.recordVersion,
            sourcePrivacy: row.encrypted.keyClass
          }
        );
        if (payload.state !== row.operational.state) return unavailable();
        if (
          payload.schemaVersion === 1 &&
          (payload.state !== "open" || payload.resolution !== null)
        ) {
          return unavailable();
        }
        const proposal =
          payload.schemaVersion === 2
            ? payload.proposal
            : legacyReviewProposal(row.operational.type, payload.choices);
        const resolution = payload.schemaVersion === 2 ? payload.resolution : null;
        const parsed = ReviewItemDtoSchema.safeParse({
          id: row.resourceId as EntityId<"rvw">,
          captureId: row.operational.captureId as EntityId<"cap"> | null,
          noteId: row.operational.noteId as EntityId<"note"> | null,
          type: row.operational.type,
          proposal,
          state: payload.state,
          resolution,
          createdAt: row.operational.createdAt,
          resolvedAt: row.operational.resolvedAt
        });
        if (!parsed.success) return unavailable();
        return Object.freeze(parsed.data);
      })
    );
    return records
      .sort((left, right) => {
        const createdOrder = right.createdAt.localeCompare(left.createdAt);
        return createdOrder === 0 ? left.id.localeCompare(right.id) : createdOrder;
      })
      .slice(window.offset, window.offset + window.limit);
  }
}
