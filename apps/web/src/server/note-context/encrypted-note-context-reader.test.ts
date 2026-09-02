import type { EntityId } from "@unfiled/contracts";
import type {
  AuthorizedOwnerAccess,
  EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import { ServiceRpcError, ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";

import { EncryptedNoteContextReader } from "./encrypted-note-context-reader";
import type {
  EncryptedNoteBacklinkRow,
  EncryptedNoteSourceRow,
  NoteContextRpcAdapter
} from "./note-context-rpc-adapter";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"note">;
const OTHER_NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as EntityId<"note">;
const KEY = Buffer.alloc(32, 9);

function identifier<Kind extends "cap" | "lnk" | "mut">(
  kind: Kind,
  suffix: "X" | "Y" | "Z"
): EntityId<Kind> {
  return `${kind}_01J6M9Q7G4BMKB33GSG3NJ6D1${suffix}` as EntityId<Kind>;
}

function source(
  suffix: "X" | "Y" | "Z",
  createdAt: string,
  relation: "routed" | "source_removed" = "routed"
): EncryptedNoteSourceRow {
  return {
    captureId: identifier("cap", suffix),
    mutationId: identifier("mut", suffix),
    relation,
    insertedItemIds: [],
    createdAt,
    source: "web",
    clientCreatedAt: createdAt,
    contentLength: 4,
    privacy: "ai_assisted",
    contentCipher: { id: suffix },
    contentMac: { id: suffix }
  };
}

function backlink(): EncryptedNoteBacklinkRow {
  return {
    linkId: identifier("lnk", "X"),
    fromNoteId: OTHER_NOTE,
    fromNoteRevision: 4,
    linkType: "related",
    createdAt: "2026-09-01T20:00:00.000Z",
    fromPrivacy: "private_manual",
    fromContentCipher: { id: "note" }
  };
}

function aggregate() {
  const openCapture = vi.fn(() =>
    Promise.resolve({ schemaVersion: 1 as const, rawContent: "milk" })
  );
  const openNoteContent = vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      title: "Linked note",
      bodyMarkdown: "body",
      structuredData: null
    })
  );
  return {
    openCapture,
    openNoteContent,
    service: { openCapture, openNoteContent } as unknown as EncryptedAggregateService
  };
}

function reader(rpc: NoteContextRpcAdapter, crypto = aggregate()) {
  return {
    crypto,
    reader: new EncryptedNoteContextReader({
      ownerId: OWNER,
      access: Object.freeze({}) as AuthorizedOwnerAccess,
      aggregate: crypto.service,
      rpc,
      cursorKey: Buffer.from(KEY)
    })
  };
}

describe("encrypted note-context reader", () => {
  it("opens only the visible source page and preserves source-removed lineage", async () => {
    const rows = [
      source("Z", "2026-09-01T22:00:00.000Z"),
      source("Y", "2026-09-01T21:00:00.000Z", "source_removed"),
      source("X", "2026-09-01T20:00:00.000Z")
    ];
    const listSources = vi
      .fn<NoteContextRpcAdapter["listSources"]>()
      .mockResolvedValueOnce({ noteId: NOTE, currentRevision: 8, items: rows })
      .mockResolvedValueOnce({ noteId: NOTE, currentRevision: 8, items: [] });
    const rpc = {
      listSources,
      listBacklinks: vi.fn<NoteContextRpcAdapter["listBacklinks"]>()
    };
    const test = reader(rpc);
    const first = await test.reader.listSources(NOTE, { limit: 2 });

    expect(first.items).toEqual([
      expect.objectContaining({ captureId: rows[0]?.captureId, rawContent: "milk" }),
      expect.objectContaining({
        captureId: rows[1]?.captureId,
        relation: "source_removed",
        rawContent: "milk"
      })
    ]);
    expect(first.pageInfo.hasMore).toBe(true);
    expect(first.pageInfo.nextCursor).not.toBeNull();
    expect(test.crypto.openCapture).toHaveBeenCalledTimes(2);

    await test.reader.listSources(NOTE, {
      limit: 2,
      cursor: first.pageInfo.nextCursor ?? undefined
    });
    expect(listSources).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedNoteRevision: 8,
        after: {
          captureId: rows[1]?.captureId,
          mutationId: rows[1]?.mutationId,
          createdAt: rows[1]?.createdAt
        }
      })
    );
  });

  it("decrypts current backlink titles with exact owner-bound note coordinates", async () => {
    const row = backlink();
    const rpc = {
      listSources: vi.fn<NoteContextRpcAdapter["listSources"]>(),
      listBacklinks: vi.fn<NoteContextRpcAdapter["listBacklinks"]>(() =>
        Promise.resolve({ noteId: NOTE, currentRevision: 3, items: [row] })
      )
    };
    const test = reader(rpc);

    await expect(test.reader.listBacklinks(NOTE, { limit: 30 })).resolves.toEqual({
      items: [
        {
          linkId: row.linkId,
          fromNoteId: OTHER_NOTE,
          fromTitle: "Linked note",
          linkType: "related",
          createdAt: row.createdAt
        }
      ],
      pageInfo: { hasMore: false, nextCursor: null }
    });
    expect(test.crypto.openNoteContent).toHaveBeenCalledWith(
      expect.anything(),
      row.fromContentCipher,
      {
        noteId: OTHER_NOTE,
        currentRevision: 4,
        privacy: "private_manual"
      }
    );
  });

  it("assembles a public backlink page from ciphertext batches below the RPC byte ceiling", async () => {
    const rows = Array.from({ length: 6 }, (_, index): EncryptedNoteBacklinkRow => {
      const suffix = String(index + 10).padStart(26, "0");
      return {
        linkId: `lnk_${suffix}`,
        fromNoteId: `note_${suffix}`,
        fromNoteRevision: 1,
        linkType: "reference",
        createdAt: `2026-09-01T${String(20 - index).padStart(2, "0")}:00:00.000Z`,
        fromPrivacy: "ai_assisted",
        fromContentCipher: { index }
      };
    });
    const listBacklinks = vi
      .fn<NoteContextRpcAdapter["listBacklinks"]>()
      .mockResolvedValueOnce({ noteId: NOTE, currentRevision: 6, items: rows.slice(0, 5) })
      .mockResolvedValueOnce({ noteId: NOTE, currentRevision: 6, items: rows.slice(5) });
    const test = reader({
      listSources: vi.fn(),
      listBacklinks
    });

    const result = await test.reader.listBacklinks(NOTE, { limit: 5 });

    expect(result.items).toHaveLength(5);
    expect(result.pageInfo).toMatchObject({ hasMore: true });
    expect(test.crypto.openNoteContent).toHaveBeenCalledTimes(5);
    expect(listBacklinks).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        limit: 1,
        expectedNoteRevision: 6,
        after: {
          linkId: rows[4]?.linkId,
          createdAt: rows[4]?.createdAt
        }
      })
    );
  });

  it("fails closed on stale pages and dishonest decrypted capture lengths", async () => {
    const row = source("X", "2026-09-01T20:00:00.000Z");
    const stale = reader({
      listSources: vi.fn(() =>
        Promise.reject(new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION))
      ),
      listBacklinks: vi.fn()
    });
    await expect(stale.reader.listSources(NOTE, { limit: 1 })).rejects.toMatchObject({
      code: ServiceRpcErrorCode.STALE_REVISION
    });

    const dishonestCrypto = aggregate();
    dishonestCrypto.openCapture.mockResolvedValue({ schemaVersion: 1, rawContent: "too long" });
    const dishonest = reader(
      {
        listSources: vi.fn(() =>
          Promise.resolve({ noteId: NOTE, currentRevision: 1, items: [row] })
        ),
        listBacklinks: vi.fn()
      },
      dishonestCrypto
    );
    await expect(dishonest.reader.listSources(NOTE, { limit: 1 })).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
  });
});
