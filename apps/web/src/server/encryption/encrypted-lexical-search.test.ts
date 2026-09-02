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
    spaceId?: EntityId<"spc"> | null;
    tagIds?: readonly EntityId<"tag">[];
    type?: NoteType;
    updatedAt?: string;
  }> = {}
): NoteRecord {
  return Object.freeze({
    id: id as EntityId<"note">,
    spaceId: options.spaceId ?? null,
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
    tagIds: [...(options.tagIds ?? [])],
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

    await expect(
      search.search("Roose", { archived: "exclude", limit: 10, offset: 0 })
    ).resolves.toEqual({
      query: "Roose",
      results: [expect.objectContaining({ note: exact })]
    });
    const typoResult = await search.search("spinich", {
      archived: "exclude",
      limit: 10,
      offset: 0
    });
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

    await expect(
      search.search("search phrase", { archived: "only", limit: 1, offset: 0 })
    ).resolves.toEqual({
      query: "search phrase",
      results: [expect.objectContaining({ note: archived })]
    });
    await expect(
      search.search("search phrase", { archived: "exclude", limit: 1, offset: 0 })
    ).resolves.toEqual({
      query: "search phrase",
      results: [expect.objectContaining({ note: active })]
    });
  });

  it("admits one bounded 1,000-result candidate window for signed HTTP pagination", async () => {
    const current = note(
      "note_01K5F0A0000000000000000010",
      "Capacity boundary",
      "shared search phrase"
    );
    const listNotes = vi.fn().mockResolvedValue([current]);
    const getNote = vi.fn().mockResolvedValue(current);
    const search = new EncryptedLexicalSearch({ getNote, listNotes }, () => NOW);

    await expect(
      search.search("search phrase", { archived: "exclude", limit: 1_000, offset: 0 })
    ).resolves.toEqual({
      query: "search phrase",
      results: [expect.objectContaining({ note: current })]
    });
    await expect(
      search.search("search phrase", { archived: "exclude", limit: 1_001, offset: 0 })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
  });

  it("composes type, space, tag, date, privacy, and archive filters", async () => {
    const spaceId = "spc_01K5F0A0000000000000000001" as EntityId<"spc">;
    const tagA = "tag_01K5F0A0000000000000000001" as EntityId<"tag">;
    const tagB = "tag_01K5F0A0000000000000000002" as EntityId<"tag">;
    const matching = note(
      "note_01K5F0A0000000000000000007",
      "Roosevelt method",
      "Promise first, then deliver the result.",
      {
        privacy: "private_manual",
        spaceId,
        tagIds: [tagA, tagB],
        type: "principle",
        updatedAt: "2026-08-20T12:00:00.000Z"
      }
    );
    const wrongTag = note(
      "note_01K5F0A0000000000000000008",
      "Roosevelt variant",
      "Promise first, then deliver the result.",
      {
        privacy: "private_manual",
        spaceId,
        tagIds: [tagA],
        type: "principle",
        updatedAt: "2026-08-20T12:00:00.000Z"
      }
    );
    const wrongPrivacy = note(
      "note_01K5F0A0000000000000000009",
      "Roosevelt public",
      "Promise first, then deliver the result.",
      {
        privacy: "ai_assisted",
        spaceId,
        tagIds: [tagA, tagB],
        type: "principle",
        updatedAt: "2026-08-20T12:00:00.000Z"
      }
    );
    const listNotes = vi.fn().mockResolvedValue([wrongTag, wrongPrivacy, matching]);
    const getNote = vi.fn((id: EntityId<"note">) =>
      Promise.resolve(id === matching.id ? matching : id === wrongTag.id ? wrongTag : wrongPrivacy)
    );
    const search = new EncryptedLexicalSearch({ getNote, listNotes }, () => NOW);

    const result = await search.search("promise", {
      archived: "exclude",
      limit: 10,
      offset: 0,
      privacy: "private_manual",
      spaceId,
      tagIds: [tagA, tagB],
      type: "principle",
      updatedFrom: "2026-08-20T12:00:00.000Z",
      updatedTo: "2026-08-21T12:00:00.000Z"
    });

    expect(result.results.map(({ note: resultNote }) => resultNote.id)).toEqual([matching.id]);
    expect(listNotes).toHaveBeenCalledWith({
      archived: "exclude",
      deleted: "exclude",
      limit: 1_000,
      offset: 0,
      spaceId,
      type: "principle"
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

    const result = await search.search("needle", {
      archived: "include",
      limit: 1,
      offset: 0
    });
    expect(result.results[0]?.snippet).toContain("needle");
    expect(result.results[0]?.snippet.length).toBeLessThanOrEqual(500);

    for (const invoke of [
      () => search.search(" ", { archived: "exclude" }),
      () => search.search("x".repeat(201), { archived: "exclude" }),
      () => search.search("valid", { archived: "exclude", limit: 0, offset: 0 }),
      () => search.search("valid", { archived: "exclude", limit: 100, offset: 901 })
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: ServiceRpcErrorCode.VALIDATION_FAILED
      });
    }
  });
});
