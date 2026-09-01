import type {
  AuthorizedOwnerAccess,
  EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import type {
  EncryptedLibraryObject,
  EncryptedLibraryRpcStore,
  EncryptedLibrarySurface
} from "./encrypted-library-rpc-store";
import { EncryptedTaxonomyReadRepository } from "./encrypted-taxonomy-read-repository";
import { ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER_ID = "0198f9ec-6f03-7b33-8d6a-127f688c8941";
const SPACE_A = "spc_01K5F0A0000000000000000001";
const SPACE_B = "spc_01K5F0A0000000000000000002";
const SPACE_C = "spc_01K5F0A0000000000000000003";
const TAG_A = "tag_01K5F0A0000000000000000001";
const TAG_B = "tag_01K5F0A0000000000000000002";
const REVIEW_A = "rvw_01K5F0A0000000000000000001";
const REVIEW_B = "rvw_01K5F0A0000000000000000002";
const CREATED = "2026-08-30T12:00:00.000Z";
const UPDATED = "2026-08-31T12:00:00.000Z";

function object<Surface extends EncryptedLibrarySurface>(
  surface: Surface,
  resourceId: string,
  recordVersion: number,
  operational: EncryptedLibraryObject<Surface>["operational"],
  keyClass: "ai_assisted" | "private_manual" = "private_manual"
): EncryptedLibraryObject<Surface> {
  return {
    surface,
    ownerId: OWNER_ID,
    resourceId,
    recordVersion,
    operational,
    encrypted: {
      resourceId,
      keyClass
    } as EncryptedLibraryObject<Surface>["encrypted"],
    contentMac: null
  };
}

function dependencies(
  pages: Readonly<Partial<Record<EncryptedLibrarySurface, readonly unknown[]>>>
) {
  const store = {
    listEncryptedLibraryObjects: vi.fn((input: { surface: EncryptedLibrarySurface }) =>
      Promise.resolve({
        surface: input.surface,
        items: pages[input.surface] ?? [],
        nextCursor: null
      })
    )
  } as unknown as EncryptedLibraryRpcStore;
  const aggregate = {
    openSpaceDisplay: vi.fn((_access: unknown, record: { resourceId: string }) =>
      Promise.resolve(
        record.resourceId === SPACE_A
          ? { schemaVersion: 1, name: "Projects", slug: "projects" }
          : record.resourceId === SPACE_B
            ? { schemaVersion: 1, name: "Unfiled", slug: "unfiled" }
            : { schemaVersion: 1, name: "Archive", slug: "archive" }
      )
    ),
    openTagDisplay: vi.fn((_access: unknown, record: { resourceId: string }) =>
      Promise.resolve({
        schemaVersion: 1,
        name: record.resourceId === TAG_A ? "zebra" : "alpha"
      })
    ),
    openReview: vi.fn((_access: unknown, record: { resourceId: string }) =>
      Promise.resolve({
        schemaVersion: 1,
        choices: [record.resourceId],
        state: record.resourceId === REVIEW_A ? "open" : "resolved",
        resolution: record.resourceId === REVIEW_A ? null : { destination: "inbox" }
      })
    )
  } as unknown as EncryptedAggregateService;
  return {
    access: { ownerId: OWNER_ID } as unknown as AuthorizedOwnerAccess,
    aggregate,
    ownerId: OWNER_ID,
    store
  };
}

describe("encrypted taxonomy and Review reads", () => {
  it("decrypts complete space topology before sorting, filtering, and paging", async () => {
    const root = object("space_display", SPACE_A, 2, {
      parentId: null,
      sortKey: "b0",
      archivedAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED
    });
    const child = object("space_display", SPACE_B, 3, {
      parentId: SPACE_A,
      sortKey: "a0",
      archivedAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED
    });
    const archived = object("space_display", SPACE_C, 1, {
      parentId: null,
      sortKey: "00",
      archivedAt: UPDATED,
      createdAt: CREATED,
      updatedAt: UPDATED
    });
    const input = dependencies({ space_display: [root, child, archived] });
    const repository = new EncryptedTaxonomyReadRepository(input);

    await expect(repository.listSpaces(false, { limit: 1, offset: 0 })).resolves.toEqual([
      expect.objectContaining({ id: SPACE_B, path: "Projects / Unfiled", currentRevision: 3 })
    ]);
    await expect(repository.listSpaces(true, { limit: 3, offset: 0 })).resolves.toEqual([
      expect.objectContaining({ id: SPACE_C, archivedAt: UPDATED }),
      expect.objectContaining({ id: SPACE_B }),
      expect.objectContaining({ id: SPACE_A })
    ]);
    expect(input.aggregate.openSpaceDisplay).toHaveBeenCalledTimes(6);
  });

  it("decrypts and alphabetizes tags without exposing ciphertext metadata", async () => {
    const first = object("tag_display", TAG_A, 4, {
      createdAt: CREATED,
      updatedAt: UPDATED
    });
    const second = object("tag_display", TAG_B, 1, {
      createdAt: UPDATED,
      updatedAt: UPDATED
    });
    const repository = new EncryptedTaxonomyReadRepository(
      dependencies({ tag_display: [first, second] })
    );

    await expect(repository.listTags({ limit: 10, offset: 0 })).resolves.toEqual([
      { id: TAG_B, name: "alpha", currentRevision: 1, createdAt: UPDATED },
      { id: TAG_A, name: "zebra", currentRevision: 4, createdAt: CREATED }
    ]);
  });

  it("filters Review metadata before opening content and returns newest first", async () => {
    const open = object(
      "review_item",
      REVIEW_A,
      2,
      {
        captureId: null,
        noteId: null,
        type: "low_confidence",
        state: "open",
        createdAt: UPDATED,
        resolvedAt: null
      },
      "ai_assisted"
    );
    const resolved = object(
      "review_item",
      REVIEW_B,
      3,
      {
        captureId: null,
        noteId: null,
        type: "revision_conflict",
        state: "resolved",
        createdAt: CREATED,
        resolvedAt: UPDATED
      },
      "private_manual"
    );
    const input = dependencies({ review_item: [resolved, open] });
    const repository = new EncryptedTaxonomyReadRepository(input);

    await expect(repository.listReviewItems("open", { limit: 10, offset: 0 })).resolves.toEqual([
      expect.objectContaining({
        id: REVIEW_A,
        choices: [REVIEW_A],
        state: "open",
        resolution: null
      })
    ]);
    expect(input.aggregate.openReview).toHaveBeenCalledTimes(1);
    expect(input.aggregate.openReview).toHaveBeenCalledWith(
      input.access,
      open.encrypted,
      expect.objectContaining({ sourcePrivacy: "ai_assisted", recordVersion: 2 })
    );
  });

  it("fails closed on invalid pages, broken topology, Review mismatch, and cursor loops", async () => {
    const orphan = object("space_display", SPACE_B, 1, {
      parentId: SPACE_A,
      sortKey: "a0",
      archivedAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED
    });
    const invalidPageRepository = new EncryptedTaxonomyReadRepository(
      dependencies({ space_display: [orphan] })
    );
    await expect(
      invalidPageRepository.listSpaces(false, { limit: 0, offset: 0 })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    await expect(invalidPageRepository.listSpaces(false)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });

    const review = object(
      "review_item",
      REVIEW_A,
      1,
      {
        captureId: null,
        noteId: null,
        type: "failed_job",
        state: "open",
        createdAt: CREATED,
        resolvedAt: null
      },
      "ai_assisted"
    );
    const mismatch = dependencies({ review_item: [review] });
    vi.mocked(mismatch.aggregate.openReview).mockResolvedValue({
      schemaVersion: 1,
      choices: [],
      state: "dismissed",
      resolution: null
    });
    await expect(
      new EncryptedTaxonomyReadRepository(mismatch).listReviewItems("open")
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });

    const loopingStore = {
      listEncryptedLibraryObjects: vi.fn(() =>
        Promise.resolve({
          surface: "tag_display",
          items: [],
          nextCursor: TAG_A
        })
      )
    } as unknown as EncryptedLibraryRpcStore;
    const looping = dependencies({});
    await expect(
      new EncryptedTaxonomyReadRepository({ ...looping, store: loopingStore }).listTags()
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });
});
