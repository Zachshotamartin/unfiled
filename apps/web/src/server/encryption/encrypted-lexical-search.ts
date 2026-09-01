import { normalizePrivateRagText, privateRagTrigrams, rankSearchResult } from "@unfiled/search";

import type { NoteListFilters, NoteRecord, SearchResponse } from "@/lib/product/types";
import type { RepositoryPage } from "@/server/product/repository";

import type { EncryptedNoteAggregateRepository } from "./encrypted-note-aggregate-repository";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const MAX_SEARCHABLE_NOTES = 1_000;
const MAX_QUERY_LENGTH = 200;
const MAX_SNIPPET_LENGTH = 500;
const MILLISECONDS_PER_DAY = 86_400_000;
const RECENCY_HALF_LIFE_DAYS = 30;
const MIN_TRIGRAM_COVERAGE = 0.4;

type SearchableEncryptedNotes = Pick<EncryptedNoteAggregateRepository, "getNote" | "listNotes">;

type ScoredNote = Readonly<{
  note: NoteRecord;
  score: number;
}>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function normalizedQuery(value: string): string {
  if (typeof value !== "string" || value.length > MAX_QUERY_LENGTH) return invalidInput();
  const normalized = normalizePrivateRagText(value);
  if (normalized.length < 1 || normalized.length > MAX_QUERY_LENGTH) return invalidInput();
  return normalized;
}

function boundedPage(page: RepositoryPage | undefined): RepositoryPage {
  const value = page ?? { limit: 100, offset: 0 };
  if (
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    !Number.isSafeInteger(value.limit + value.offset) ||
    value.limit + value.offset > MAX_SEARCHABLE_NOTES
  ) {
    return invalidInput();
  }
  return value;
}

function tokens(value: string): ReadonlySet<string> {
  return new Set(value.match(/[\p{L}\p{N}]+/gu) ?? []);
}

function prefixCoverage(queryTokens: ReadonlySet<string>, document: string): number {
  if (queryTokens.size === 0) return 0;
  const documentTokens = document.match(/[\p{L}\p{N}]+/gu) ?? [];
  let found = 0;
  for (const queryToken of queryTokens) {
    if (documentTokens.some((documentToken) => documentToken.startsWith(queryToken))) found += 1;
  }
  return found / queryTokens.size;
}

function trigramCoverage(queryTrigrams: ReadonlySet<string>, document: string): number {
  if (queryTrigrams.size === 0) return 0;
  const documentTrigrams = privateRagTrigrams(document);
  let found = 0;
  for (const trigram of queryTrigrams) if (documentTrigrams.has(trigram)) found += 1;
  return found / queryTrigrams.size;
}

function recency(updatedAt: string, now: number): number {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) {
    throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
  }
  const ageDays = Math.max(0, now - timestamp) / MILLISECONDS_PER_DAY;
  return 1 / (1 + ageDays / RECENCY_HALF_LIFE_DAYS);
}

function scoreNote(note: NoteRecord, query: string, now: number): ScoredNote | null {
  const title = normalizePrivateRagText(note.title);
  const document = normalizePrivateRagText(`${note.title} ${note.bodyMarkdown}`);
  const queryTokens = tokens(query);
  const fullText = prefixCoverage(queryTokens, document);
  const trigrams = trigramCoverage(privateRagTrigrams(query), document);
  const directMatch = document.includes(query) || fullText === 1;
  if (!directMatch && trigrams < MIN_TRIGRAM_COVERAGE) return null;
  return Object.freeze({
    note,
    score: rankSearchResult({
      fullText,
      trigram: trigrams,
      vector: null,
      recency: recency(note.updatedAt, now),
      titleExact: title === query ? 1 : 0,
      pinned: note.pinnedAt !== null,
      privateManual: note.privacy === "private_manual"
    })
  });
}

function snippet(note: NoteRecord, normalized: string): string {
  const source = note.bodyMarkdown.trim().length > 0 ? note.bodyMarkdown : note.title;
  const lower = source.toLocaleLowerCase("en-US");
  const firstToken = [...tokens(normalized)][0] ?? normalized;
  const match = lower.indexOf(firstToken.toLocaleLowerCase("en-US"));
  const start = Math.max(0, match < 0 ? 0 : match - 120);
  const prefix = start > 0 ? "…" : "";
  const available = MAX_SNIPPET_LENGTH - prefix.length;
  const selected = source.slice(start, start + available);
  const suffix = start + selected.length < source.length ? "…" : "";
  return `${prefix}${selected.slice(0, MAX_SNIPPET_LENGTH - prefix.length - suffix.length)}${suffix}`;
}

function archiveMatches(note: NoteRecord, archived: "exclude" | "include" | "only"): boolean {
  if (archived === "include") return true;
  return archived === "only" ? note.archivedAt !== null : note.archivedAt === null;
}

/**
 * Bounded owner-authorized lexical search over decrypted in-process note
 * snapshots. It has intentionally no embedding-provider port, so private note
 * content and private queries cannot leave the interactive web trust domain.
 * Milestone F can join verified AI-assisted RAG scores without weakening this
 * private-manual path.
 */
export class EncryptedLexicalSearch {
  public constructor(
    private readonly notes: SearchableEncryptedNotes,
    private readonly now: () => number = Date.now
  ) {}

  public async search(
    query: string,
    archived: "exclude" | "include" | "only",
    page?: RepositoryPage
  ): Promise<SearchResponse> {
    const normalized = normalizedQuery(query);
    const window = boundedPage(page);
    const filters: NoteListFilters = {
      archived,
      deleted: "exclude",
      limit: MAX_SEARCHABLE_NOTES,
      offset: 0
    };
    const summaries = await this.notes.listNotes(filters);
    const now = this.now();
    const candidates = summaries
      .flatMap((note) => {
        const scored = scoreNote(note, normalized, now);
        return scored === null ? [] : [scored];
      })
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        const updated = right.note.updatedAt.localeCompare(left.note.updatedAt);
        return updated === 0 ? left.note.id.localeCompare(right.note.id) : updated;
      });

    const current: ScoredNote[] = [];
    for (const candidate of candidates) {
      if (current.length >= window.offset + window.limit) break;
      const detail = await this.notes.getNote(candidate.note.id);
      if (
        detail.currentRevision !== candidate.note.currentRevision ||
        detail.deletedAt !== null ||
        !archiveMatches(detail, archived)
      ) {
        continue;
      }
      const rescored = scoreNote(detail, normalized, now);
      if (rescored !== null) current.push(rescored);
    }

    return Object.freeze({
      query: query.trim(),
      results: current
        .slice(window.offset, window.offset + window.limit)
        .map(({ note }) => Object.freeze({ note, snippet: snippet(note, normalized) }))
    });
  }
}
