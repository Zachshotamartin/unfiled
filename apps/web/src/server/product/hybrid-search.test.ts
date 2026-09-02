import {
  ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  USER_HYBRID_SEARCH_RANKING_VERSION,
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  type EncryptedUserSearchMatch,
  type EncryptedUserSearchMaterial,
  type EncryptedUserSearchResult,
  type EntityId,
  type NoteType,
  type PrivacyMode
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { NoteRecord, NoteSearchOptions, SearchResponse } from "@/lib/product/types";

import type { RepositoryContext } from "./repository";
import { runHybridSearch, USER_SEARCH_LEXICAL_PREFIX_LIMIT } from "./hybrid-search";

const CONTEXT: RepositoryContext = Object.freeze({
  accessToken: "owner-access-token",
  userId: "00000000-0000-4000-8000-000000000001"
});
const NOTE_A = "note_01K5F0A0000000000000000001" as EntityId<"note">;
const NOTE_B = "note_01K5F0A0000000000000000002" as EntityId<"note">;
const NOTE_C = "note_01K5F0A0000000000000000003" as EntityId<"note">;
const NOTE_D = "note_01K5F0A0000000000000000004" as EntityId<"note">;
const NOTE_E = "note_01K5F0A0000000000000000005" as EntityId<"note">;
const SPACE_ID = "spc_01K5F0A0000000000000000001" as EntityId<"spc">;
const TAG_ID = "tag_01K5F0A0000000000000000001" as EntityId<"tag">;

function note(
  id: EntityId<"note">,
  title: string,
  options: Readonly<{
    bodyMarkdown?: string;
    currentRevision?: number;
    privacy?: PrivacyMode;
    spaceId?: EntityId<"spc"> | null;
    tagIds?: readonly EntityId<"tag">[];
    type?: NoteType;
    updatedAt?: string;
  }> = {}
): NoteRecord {
  return Object.freeze({
    id,
    spaceId: options.spaceId ?? null,
    spacePath: options.spaceId === undefined || options.spaceId === null ? null : "Mindset",
    type: options.type ?? "generic",
    title,
    bodyMarkdown: options.bodyMarkdown ?? `${title} owner-authorized body`,
    structuredData: { schemaVersion: 1 as const },
    currentRevision: options.currentRevision ?? 1,
    isOpen: true,
    pinnedAt: null,
    privacy: options.privacy ?? "ai_assisted",
    archivedAt: null,
    deletedAt: null,
    tagIds: [...(options.tagIds ?? [])],
    tags: Object.freeze([]),
    links: Object.freeze([]),
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-08-30T12:00:00.000Z"
  });
}

function material(
  overrides: Partial<EncryptedUserSearchMaterial> = {}
): EncryptedUserSearchMaterial {
  return {
    requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
    hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
    query: "promise",
    filters: {
      archive: "exclude",
      privacy: "ai_assisted",
      type: null,
      space: { id: null, mode: "any" },
      tagIds: [],
      updatedFrom: null,
      updatedTo: null
    },
    pageLimit: 30,
    maxResults: 8,
    continuation: null,
    ...overrides
  };
}

function match(
  current: NoteRecord,
  score: number,
  overrides: Partial<EncryptedUserSearchMatch> = {}
): EncryptedUserSearchMatch {
  return {
    noteId: current.id,
    indexedRevision: current.currentRevision,
    score,
    ...overrides
  };
}

function semanticResult(
  items: readonly EncryptedUserSearchMatch[],
  generationRevisionToken = "generation-7"
): EncryptedUserSearchResult {
  return {
    searchId: "00000000-0000-4000-8000-000000000007",
    generationId: "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    generationAttestationDigest: "a".repeat(64),
    generationRevisionToken,
    rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
    items: [...items],
    scannedNoteCount: items.length
  };
}

function lexical(...results: SearchResponse["results"]): SearchResponse {
  return { query: "promise", results };
}

const AI_OPTIONS: NoteSearchOptions = Object.freeze({
  archived: "exclude",
  privacy: "ai_assisted"
});

describe("hybrid user search", () => {
  it("merges a stable lexical prefix with hydrated semantic matches deterministically", async () => {
    const a = note(NOTE_A, "Alpha", { updatedAt: "2026-08-30T12:00:00.000Z" });
    const b = note(NOTE_B, "Beta", { updatedAt: "2026-08-29T12:00:00.000Z" });
    const c = note(NOTE_C, "Gamma", {
      bodyMarkdown: "Hydrated gamma owner content",
      updatedAt: "2026-08-28T12:00:00.000Z"
    });
    const d = note(NOTE_D, "Delta", { updatedAt: "2026-08-27T12:00:00.000Z" });
    const e = note(NOTE_E, "Epsilon", { updatedAt: "2026-08-27T12:00:00.000Z" });
    const search = vi
      .fn()
      .mockResolvedValue(
        lexical(
          { note: b, score: 0.8, snippet: "lexical beta" },
          { note: a, score: 0.6, snippet: "lexical alpha" },
          { note: e, score: 0.5, snippet: "lexical epsilon" },
          { note: d, score: 0.5, snippet: "lexical delta" }
        )
      );
    const getNote = vi.fn((_: RepositoryContext, id: EntityId<"note">) => {
      if (id === a.id) return Promise.resolve(a);
      if (id === c.id) return Promise.resolve(c);
      throw new Error("unexpected hydration");
    });
    const semanticSearch = vi
      .fn()
      .mockResolvedValue(semanticResult([match(a, 0.9), match(c, 0.85)]));

    const outcome = await runHybridSearch({
      context: CONTEXT,
      material: material(),
      options: AI_OPTIONS,
      query: "promise",
      repository: { getNote, search },
      semantic: () => ({ search: semanticSearch })
    });

    expect(outcome.semanticStatus).toBe("used");
    expect(outcome.semanticContinuation?.boundary).toEqual({
      indexedRevision: c.currentRevision,
      noteId: NOTE_C,
      score: 0.85
    });
    expect(outcome.semanticContinuation?.generationBindingDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(outcome.semanticContinuation?.resultDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(outcome.response.results.map(({ note: current }) => current.id)).toEqual([
      NOTE_A,
      NOTE_C,
      NOTE_B,
      NOTE_D,
      NOTE_E
    ]);
    expect(outcome.response.results[0]?.score).toBeCloseTo(0.93);
    expect(outcome.response.results[1]).toMatchObject({
      note: { id: NOTE_C, title: "Gamma" },
      score: 0.85
    });
    expect(search).toHaveBeenCalledExactlyOnceWith(CONTEXT, "promise", {
      ...AI_OPTIONS,
      limit: USER_SEARCH_LEXICAL_PREFIX_LIMIT,
      offset: 0
    });
    expect(getNote.mock.calls.map((call) => call[1])).toEqual([NOTE_A, NOTE_C]);
  });

  it("never constructs the semantic port when no semantic material was admitted", async () => {
    const current = note(NOTE_A, "Private principle", { privacy: "private_manual" });
    const search = vi
      .fn()
      .mockResolvedValue(
        lexical({ note: current, score: 0.7, snippet: "private lexical snippet" })
      );
    const semantic = vi.fn();

    const outcome = await runHybridSearch({
      context: CONTEXT,
      material: null,
      options: { archived: "exclude", privacy: "private_manual" },
      query: "promise",
      repository: { getNote: vi.fn(), search },
      semantic
    });

    expect(outcome.semanticStatus).toBe("not_requested");
    expect(outcome.semanticContinuation).toBeNull();
    expect(outcome.response.results.map(({ note: result }) => result.id)).toEqual([NOTE_A]);
    expect(semantic).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledOnce();
  });

  it("discards an unauthorized semantic reference and reruns fresh lexical search", async () => {
    const initial = note(NOTE_A, "Initial lexical");
    const fresh = note(NOTE_B, "Fresh lexical");
    const unauthorized = note(NOTE_C, "Unauthorized");
    const search = vi
      .fn()
      .mockResolvedValueOnce(
        lexical({ note: initial, score: 0.7, snippet: "initial lexical snippet" })
      )
      .mockResolvedValueOnce(
        lexical({ note: fresh, score: 0.75, snippet: "fresh lexical snippet" })
      );
    const getNote = vi.fn().mockRejectedValue(new Error("not found"));
    const untrustedReference = {
      ...match(unauthorized, 1),
      title: "CROSS OWNER CANARY",
      snippet: "CROSS OWNER BODY CANARY"
    };

    const outcome = await runHybridSearch({
      context: CONTEXT,
      material: material(),
      options: AI_OPTIONS,
      query: "promise",
      repository: { getNote, search },
      semantic: () => ({
        search: vi.fn().mockResolvedValue(semanticResult([untrustedReference]))
      })
    });

    expect(outcome.semanticStatus).toBe("fallback");
    expect(outcome.semanticContinuation).toBeNull();
    expect(outcome.response.results).toEqual([
      { note: fresh, score: 0.75, snippet: "fresh lexical snippet" }
    ]);
    expect(JSON.stringify(outcome)).not.toContain("CANARY");
    expect(getNote).toHaveBeenCalledWith(CONTEXT, NOTE_C);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("fails a stale or filter-incomplete semantic reference closed to fresh lexical-only", async () => {
    const initial = note(NOTE_A, "Initial lexical");
    const fresh = note(NOTE_B, "Fresh lexical");
    const stale = note(NOTE_C, "Stale semantic", {
      currentRevision: 2,
      spaceId: SPACE_ID,
      tagIds: [],
      type: "principle"
    });
    const options: NoteSearchOptions = {
      archived: "exclude",
      privacy: "ai_assisted",
      spaceId: SPACE_ID,
      tagIds: [TAG_ID],
      type: "principle",
      updatedFrom: "2026-08-01T00:00:00.000Z",
      updatedTo: "2026-09-01T00:00:00.000Z"
    };
    const search = vi
      .fn()
      .mockResolvedValueOnce(lexical({ note: initial, score: 0.6, snippet: "initial" }))
      .mockResolvedValueOnce(lexical({ note: fresh, score: 0.7, snippet: "fresh" }));

    const outcome = await runHybridSearch({
      context: CONTEXT,
      material: material({
        filters: {
          archive: "exclude",
          privacy: "ai_assisted",
          type: "principle",
          space: { id: SPACE_ID, mode: "exact" },
          tagIds: [TAG_ID],
          updatedFrom: "2026-08-01T00:00:00.000Z",
          updatedTo: "2026-09-01T00:00:00.000Z"
        }
      }),
      options,
      query: "promise",
      repository: { getNote: vi.fn().mockResolvedValue(stale), search },
      semantic: () => ({
        search: vi.fn().mockResolvedValue(
          semanticResult([
            match(stale, 0.9, {
              indexedRevision: 1
            })
          ])
        )
      })
    });

    expect(outcome).toMatchObject({
      semanticContinuation: null,
      semanticStatus: "fallback",
      response: { results: [{ note: fresh, score: 0.7, snippet: "fresh" }] }
    });
    expect(search).toHaveBeenNthCalledWith(2, CONTEXT, "promise", {
      ...options,
      limit: USER_SEARCH_LEXICAL_PREFIX_LIMIT,
      offset: 0
    });
  });

  it("degrades a semantic service failure to a second fresh lexical snapshot", async () => {
    const staleLexical = note(NOTE_A, "Stale lexical");
    const freshLexical = note(NOTE_B, "Fresh lexical");
    const search = vi
      .fn()
      .mockResolvedValueOnce(lexical({ note: staleLexical, score: 0.6, snippet: "stale" }))
      .mockResolvedValueOnce(lexical({ note: freshLexical, score: 0.8, snippet: "fresh" }));

    const outcome = await runHybridSearch({
      context: CONTEXT,
      material: material(),
      options: AI_OPTIONS,
      query: "promise",
      repository: { getNote: vi.fn(), search },
      semantic: () => ({ search: vi.fn().mockRejectedValue(new Error("provider failed")) })
    });

    expect(outcome.semanticStatus).toBe("fallback");
    expect(outcome.response.results).toEqual([
      { note: freshLexical, score: 0.8, snippet: "fresh" }
    ]);
    expect(search).toHaveBeenCalledTimes(2);
  });
});
