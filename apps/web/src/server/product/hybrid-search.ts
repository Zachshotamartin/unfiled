import {
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  encryptedUserSearchGenerationBindingDigest,
  encryptedUserSearchResultDigest,
  type EncryptedUserSearchContinuation,
  type EncryptedUserSearchMaterial,
  type EncryptedUserSearchResult,
  type EntityId
} from "@unfiled/contracts";
import { normalizePrivateRagText } from "@unfiled/search";

import type {
  NoteRecord,
  NoteSearchOptions,
  SearchResponse,
  SearchResult
} from "@/lib/product/types";

import type { ManualNotesRepository, RepositoryContext } from "./repository";
import { noteMatchesSearchOptions } from "./search-filters";

export const USER_SEARCH_LEXICAL_PREFIX_LIMIT = 1_000 as const;
const MAX_COMPARABLE_SCORE = 1.2;
const CROSS_SIGNAL_BONUS = 0.05;
const MAX_SNIPPET_LENGTH = 500;

export type HybridSearchOutcome = Readonly<{
  response: SearchResponse;
  semanticContinuation: EncryptedUserSearchContinuation | null;
  semanticStatus: "fallback" | "not_requested" | "used";
}>;

export type HybridSearchInput = Readonly<{
  context: RepositoryContext;
  material: EncryptedUserSearchMaterial | null;
  options: NoteSearchOptions;
  query: string;
  repository: Pick<ManualNotesRepository, "getNote" | "search">;
  semantic?: () => Readonly<{
    search(
      material: EncryptedUserSearchMaterial,
      signal?: AbortSignal
    ): Promise<EncryptedUserSearchResult>;
  }>;
  signal?: AbortSignal;
}>;

type MergedCandidate = Readonly<{
  lexicalScore: number | null;
  note: NoteRecord;
  semanticScore: number | null;
  snippet: string;
}>;

function comparableScore(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_COMPARABLE_SCORE) {
    throw new TypeError("invalid search score");
  }
  return value;
}

function combinedScore(candidate: MergedCandidate): number {
  const lexical = candidate.lexicalScore ?? 0;
  const semantic = candidate.semanticScore ?? 0;
  const corroboration =
    candidate.lexicalScore === null || candidate.semanticScore === null
      ? 0
      : Math.min(lexical, semantic) * CROSS_SIGNAL_BONUS;
  return Math.min(MAX_COMPARABLE_SCORE, Math.max(lexical, semantic) + corroboration);
}

function hydratedSnippet(note: NoteRecord, query: string): string {
  const source = note.bodyMarkdown.trim().length > 0 ? note.bodyMarkdown : note.title;
  const normalizedSource = normalizePrivateRagText(source);
  const normalizedQuery = normalizePrivateRagText(query);
  const firstToken = /[\p{L}\p{N}]+/u.exec(normalizedQuery)?.[0] ?? normalizedQuery;
  const match = normalizedSource.indexOf(firstToken);
  const start = Math.max(0, match < 0 ? 0 : match - 120);
  const prefix = start > 0 ? "…" : "";
  const available = MAX_SNIPPET_LENGTH - prefix.length;
  const selected = source.slice(start, start + available);
  const suffix = start + selected.length < source.length ? "…" : "";
  return `${prefix}${selected.slice(0, MAX_SNIPPET_LENGTH - prefix.length - suffix.length)}${suffix}`;
}

async function lexicalPrefix(input: HybridSearchInput): Promise<SearchResponse> {
  return input.repository.search(input.context, input.query, {
    ...input.options,
    limit: USER_SEARCH_LEXICAL_PREFIX_LIMIT,
    offset: 0
  });
}

function lexicalCandidates(response: SearchResponse): Map<EntityId<"note">, MergedCandidate> {
  const candidates = new Map<EntityId<"note">, MergedCandidate>();
  for (const result of response.results) {
    const score = comparableScore(result.score);
    const previous = candidates.get(result.note.id);
    if (previous === undefined || score > (previous.lexicalScore ?? -1)) {
      candidates.set(
        result.note.id,
        Object.freeze({
          lexicalScore: score,
          note: result.note,
          semanticScore: previous?.semanticScore ?? null,
          snippet: result.snippet
        })
      );
    }
  }
  return candidates;
}

async function addSemanticCandidates(
  input: HybridSearchInput,
  semanticResult: EncryptedUserSearchResult,
  candidates: Map<EntityId<"note">, MergedCandidate>
): Promise<void> {
  const seen = new Set<EntityId<"note">>();
  for (const reference of semanticResult.items) {
    if (seen.has(reference.noteId)) throw new TypeError("duplicate semantic reference");
    seen.add(reference.noteId);
    const note = await input.repository.getNote(input.context, reference.noteId);
    if (
      note.id !== reference.noteId ||
      note.currentRevision !== reference.indexedRevision ||
      note.deletedAt !== null ||
      note.privacy !== "ai_assisted" ||
      !noteMatchesSearchOptions(note, input.options)
    ) {
      throw new TypeError("stale semantic reference");
    }
    const semanticScore = comparableScore(reference.score);
    const previous = candidates.get(note.id);
    candidates.set(
      note.id,
      Object.freeze({
        lexicalScore: previous?.lexicalScore ?? null,
        note,
        semanticScore,
        snippet: previous?.snippet ?? hydratedSnippet(note, input.query)
      })
    );
  }
}

function mergedResponse(
  query: string,
  candidates: Map<EntityId<"note">, MergedCandidate>
): SearchResponse {
  const results: SearchResult[] = [...candidates.values()]
    .map((candidate) =>
      Object.freeze({
        note: candidate.note,
        score: combinedScore(candidate),
        snippet: candidate.snippet
      })
    )
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const updated = right.note.updatedAt.localeCompare(left.note.updatedAt);
      return updated === 0 ? left.note.id.localeCompare(right.note.id) : updated;
    });
  return Object.freeze({ query: query.trim(), results: Object.freeze(results) });
}

export async function runHybridSearch(input: HybridSearchInput): Promise<HybridSearchOutcome> {
  const lexical = await lexicalPrefix(input);
  if (input.material === null) {
    return Object.freeze({
      response: mergedResponse(input.query, lexicalCandidates(lexical)),
      semanticContinuation: null,
      semanticStatus: "not_requested"
    });
  }
  if (input.semantic === undefined) {
    return Object.freeze({
      response: mergedResponse(input.query, lexicalCandidates(lexical)),
      semanticContinuation: null,
      semanticStatus: "fallback"
    });
  }

  try {
    const semantic = input.semantic();
    const semanticResult = await semantic.search(input.material, input.signal);
    const observedRankingVersion: unknown = semanticResult.rankingVersion;
    if (observedRankingVersion !== USER_SEMANTIC_SEARCH_RANKING_VERSION) {
      throw new TypeError("unsupported semantic ranking version");
    }
    const candidates = lexicalCandidates(lexical);
    await addSemanticCandidates(input, semanticResult, candidates);
    const generationBindingDigest = await encryptedUserSearchGenerationBindingDigest({
      generationId: semanticResult.generationId,
      generationRevisionToken: semanticResult.generationRevisionToken,
      generationAttestationDigest: semanticResult.generationAttestationDigest
    });
    const resultDigest = await encryptedUserSearchResultDigest({
      generationBindingDigest,
      items: semanticResult.items,
      rankingVersion: semanticResult.rankingVersion
    });
    return Object.freeze({
      response: mergedResponse(input.query, candidates),
      semanticContinuation: Object.freeze({
        boundary: semanticResult.items.at(-1) ?? null,
        generationBindingDigest,
        rankingVersion: semanticResult.rankingVersion,
        resultDigest
      }),
      semanticStatus: "used"
    });
  } catch {
    if (input.signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
    const fresh = await lexicalPrefix(input);
    return Object.freeze({
      response: mergedResponse(input.query, lexicalCandidates(fresh)),
      semanticContinuation: null,
      semanticStatus: "fallback"
    });
  }
}
