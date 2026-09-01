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
import type { EncryptedNoteReadRpcAdapter } from "./encrypted-note-read-rpc-adapter";
import { EncryptedOwnerExportSource } from "./encrypted-owner-export-source";
import type { EncryptedOwnerDataRpcAdapter } from "./encrypted-owner-data-rpc-adapter";
import { ServiceRpcErrorCode } from "./service-rpc-client";

const OWNER_ID = "0198f9ec-6f03-7b33-8d6a-127f688c8941";
const SPACE_ID = "spc_01K5F0A0000000000000000001";
const TAG_ID = "tag_01K5F0A0000000000000000001";
const CREATED_AT = "2026-08-30T12:00:00.000Z";
const UPDATED_AT = "2026-08-31T12:00:00.000Z";

function taxonomyObject<Surface extends "space_display" | "tag_display">(
  surface: Surface,
  resourceId: string
): EncryptedLibraryObject<Surface> {
  const operational =
    surface === "space_display"
      ? {
          parentId: null,
          sortKey: "a0",
          archivedAt: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT
        }
      : { createdAt: CREATED_AT, updatedAt: UPDATED_AT };
  return {
    surface,
    ownerId: OWNER_ID,
    resourceId,
    recordVersion: 1,
    operational: operational as EncryptedLibraryObject<Surface>["operational"],
    encrypted: {
      resourceId,
      keyClass: "private_manual"
    } as EncryptedLibraryObject<Surface>["encrypted"],
    contentMac: {
      value: "a".repeat(64),
      keyId: "private-taxonomy-mac-v1",
      keyClass: "private_manual",
      keyPurpose: "content_mac",
      keyVersion: 1
    }
  };
}

function dependencies(
  items: Readonly<Partial<Record<EncryptedLibrarySurface, readonly unknown[]>>>
) {
  const library = {
    listEncryptedLibraryObjects: vi.fn((input: { surface: EncryptedLibrarySurface }) =>
      Promise.resolve({
        surface: input.surface,
        items: items[input.surface] ?? [],
        nextCursor: null
      })
    )
  } as unknown as EncryptedLibraryRpcStore;
  const aggregate = {
    openSpaceDisplay: vi.fn((_access: unknown, record: { encrypted: { resourceId: string } }) =>
      Promise.resolve({
        schemaVersion: 1,
        name: record.encrypted.resourceId === SPACE_ID ? "Projects" : "Unknown",
        slug: "projects"
      })
    ),
    openTagDisplay: vi.fn((_access: unknown, record: { encrypted: { resourceId: string } }) =>
      Promise.resolve({
        schemaVersion: 1,
        name: record.encrypted.resourceId === TAG_ID ? "focus" : "unknown"
      })
    )
  } as unknown as EncryptedAggregateService;
  return {
    input: {
      ownerId: OWNER_ID,
      access: { ownerId: OWNER_ID } as unknown as AuthorizedOwnerAccess,
      aggregate,
      reads: {} as EncryptedNoteReadRpcAdapter,
      library,
      ownerData: {} as EncryptedOwnerDataRpcAdapter
    },
    aggregate
  };
}

async function collect<T>(pages: AsyncIterable<readonly T[]>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const page of pages) values.push(...page);
  return values;
}

describe("encrypted owner export taxonomy", () => {
  it("opens spaces and tags with their authenticated ciphertext wrappers", async () => {
    const space = taxonomyObject("space_display", SPACE_ID);
    const tag = taxonomyObject("tag_display", TAG_ID);
    const harness = dependencies({ space_display: [space], tag_display: [tag] });
    const source = new EncryptedOwnerExportSource(harness.input);

    await expect(collect(source.spacePages())).resolves.toEqual([
      expect.objectContaining({ id: SPACE_ID, name: "Projects", path: "Projects" })
    ]);
    await expect(collect(source.tagPages())).resolves.toEqual([
      expect.objectContaining({ id: TAG_ID, name: "focus" })
    ]);
    expect(harness.aggregate.openSpaceDisplay).toHaveBeenCalledWith(
      harness.input.access,
      { encrypted: space.encrypted, contentMac: space.contentMac },
      { spaceId: SPACE_ID, currentRevision: 1 }
    );
    expect(harness.aggregate.openTagDisplay).toHaveBeenCalledWith(
      harness.input.access,
      { encrypted: tag.encrypted, contentMac: tag.contentMac },
      { tagId: TAG_ID, currentRevision: 1 }
    );
  });

  it("fails closed before export decryption when a taxonomy content MAC is absent", async () => {
    const space = { ...taxonomyObject("space_display", SPACE_ID), contentMac: null };
    const tag = { ...taxonomyObject("tag_display", TAG_ID), contentMac: null };
    const spaceHarness = dependencies({ space_display: [space] });
    const tagHarness = dependencies({ tag_display: [tag] });

    await expect(
      collect(new EncryptedOwnerExportSource(spaceHarness.input).spacePages())
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    await expect(
      collect(new EncryptedOwnerExportSource(tagHarness.input).tagPages())
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(spaceHarness.aggregate.openSpaceDisplay).not.toHaveBeenCalled();
    expect(tagHarness.aggregate.openTagDisplay).not.toHaveBeenCalled();
  });
});
