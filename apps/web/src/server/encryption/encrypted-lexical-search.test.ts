import type { EntityId, NoteType, PrivacyMode } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { NoteRecord } from "@/lib/product/types";

import { EncryptedLexicalSearch } from "./encrypted-lexical-search";
import { ServiceRpcErrorCode } from "./service-rpc-client";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

function note(
  id: string,
  title: string,
  bodyMarkdown: string,
  options: Readonly<{
    archivedAt?: string | null;
    pinnedAt?: string | null;
    privacy?: PrivacyMode;
    revision?: number;
    type?: NoteType;
    updatedAt?: string;
  }> = {}
): NoteRecord {
  return Object.freeze({
    id: id as EntityId<"note">,
    spaceId: null,
    spacePath: "Mindset",
    type: options.type ?? "generic",
    title,
    bodyMarkdown,
    structuredData: { schemaVersion: 1 as const },
    currentRevision: options.revision ?? 1,
    isOpen: true,
    pinnedAt: options.pinnedAt ?? null,
    privacy: options.privacy ?? "ai_assisted",
    archivedAt: options.archivedAt ?? null,
    deletedAt: null,
    tagIds: [],
    tags: [],
    links: [],
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-08-30T12:00:00.000Z"
  });
}

describe("encrypted lexical search", () => {
  it("finds exact, prefix, and typo-trigram matches and revalidates current notes", async () => {
    const exact = note(
      "note_01K5F0A0000000000000000001",
      "Roosevelt method",
      "Promise first, then figure out how to deliver.",
      { pinnedAt: "2026-08-30T12:00:00.000Z", privacy: "private_manual" }
    );
    const typo = note("note_01K5F0A0000000000000000002", "Shopping", "spinach milk batteries", {
      type: "list"
    });
    const stale = note("note_01K5F0A0000000000000000003", "Spinning ideas", "spinach", {
      revision: 1
    });
    const listNotes = vi.fn().mockResolvedValue([stale, typo, exact]);
    const getNote = vi.fn((id: EntityId<"note">) =>
      Promise.resolve(
        id === stale.id ? { ...stale, currentRevision: 2 } : id === typo.id ? typo : exact
      )
    );
    const search = new EncryptedLexicalSearch({ getNote, listNotes }, () => NOW);

    await expect(search.search("Roose", "exclude", { limit: 10, offset: 0 })).resolves.toEqual({
      query: "Roose",
      results: [expect.objectContaining({ note: exact })]
    });
    const typoResult = await search.search("spinich", "exclude", { limit: 10, offset: 0 });
    expect(typoResult.results.map(({ note: result }) => result.id)).toEqual([typo.id]);
    expect(typoResult.results[0]?.snippet).toContain("spinach");
    expect(listNotes).toHaveBeenCalledWith({
      archived: "exclude",
      deleted: "exclude",
      limit: 1_000,
      offset: 0
    });
    expect(getNote).toHaveBeenCalled();
  });

  it("keeps archive filtering and paging inside the authorized decrypted result set", async () => {
    const active = note("note_01K5F0A0000000000000000004", "Alpha", "shared search phrase");
    const archived = note("note_01K5F0A0000000000000000005", "Beta", "shared search phrase", {
      archivedAt: "2026-08-20T12:00:00.000Z"
    });
    const listNotes = vi.fn().mockResolvedValue([active, archived]);
    const getNote = vi.fn((id: EntityId<"note">) =>
      Promise.resolve(id === active.id ? active : archived)
    );
    const search = new EncryptedLexicalSearch({ getNote, listNotes }, () => NOW);

    await expect(search.search("search phrase", "only", { limit: 1, offset: 0 })).resolves.toEqual({
      query: "search phrase",
      results: [expect.objectContaining({ note: archived })]
    });
    await expect(
      search.search("search phrase", "exclude", { limit: 1, offset: 0 })
    ).resolves.toEqual({
      query: "search phrase",
      results: [expect.objectContaining({ note: active })]
    });
  });

  it("bounds snippets and rejects invalid query/page values before reading notes", async () => {
    const long = note(
      "note_01K5F0A0000000000000000006",
      "Long note",
      `${"x".repeat(300)} needle ${"y".repeat(600)}`
    );
    const listNotes = vi.fn().mockResolvedValue([long]);
    const getNote = vi.fn().mockResolvedValue(long);
    const search = new EncryptedLexicalSearch({ getNote, listNotes }, () => NOW);

    const result = await search.search("needle", "include", { limit: 1, offset: 0 });
    expect(result.results[0]?.snippet).toContain("needle");
    expect(result.results[0]?.snippet.length).toBeLessThanOrEqual(500);

    for (const invoke of [
      () => search.search(" ", "exclude"),
      () => search.search("x".repeat(201), "exclude"),
      () => search.search("valid", "exclude", { limit: 0, offset: 0 }),
      () => search.search("valid", "exclude", { limit: 100, offset: 901 })
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: ServiceRpcErrorCode.VALIDATION_FAILED
      });
    }
  });
});
