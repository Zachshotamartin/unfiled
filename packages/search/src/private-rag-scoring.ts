import {
  MAX_PRIVATE_RAG_CANDIDATE_HEADINGS,
  normalizePrivateRagText,
  type PrivateRagIndexDocumentV1
} from "./private-rag-payload.js";
import { rankSearchResult, type SearchSignals } from "./ranking.js";
import type { PrivateRagMatch } from "./private-rag-types.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENCY_HALF_LIFE_DAYS = 30;

export class PrivateRagScoringError extends Error {
  constructor() {
    super("private_rag_numeric_instability");
    this.name = "PrivateRagScoringError";
  }
}

export type PrivateRagScorableDocument = Readonly<{
  value: PrivateRagIndexDocumentV1;
  embedding: Float32Array;
  cacheBytes: number;
}>;

export type PreparedPrivateRagQuery = Readonly<{
  normalizedText: string;
  embedding: Float32Array;
  tokens: ReadonlySet<string>;
  trigrams: ReadonlySet<string>;
}>;

export class PrivateRagTopMatchHeap {
  readonly #limit: number;
  readonly #items: PrivateRagMatch[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(match: PrivateRagMatch): void {
    if (this.#items.length < this.#limit) {
      this.#items.push(match);
      this.#siftUp(this.#items.length - 1);
      return;
    }
    const worst = this.#items[0];
    if (worst === undefined || !isBetterMatch(match, worst)) return;
    this.#items[0] = match;
    this.#siftDown(0);
  }

  sorted(): readonly PrivateRagMatch[] {
    return [...this.#items].sort(compareBestFirst);
  }

  #siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const item = this.#items[index];
      const parentItem = this.#items[parent];
      if (item === undefined || parentItem === undefined || !isWorseMatch(item, parentItem)) break;
      this.#items[index] = parentItem;
      this.#items[parent] = item;
      index = parent;
    }
  }

  #siftDown(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      const leftItem = this.#items[left];
      const worstItem = this.#items[worst];
      if (leftItem !== undefined && worstItem !== undefined && isWorseMatch(leftItem, worstItem)) {
        worst = left;
      }
      const rightItem = this.#items[right];
      const updatedWorst = this.#items[worst];
      if (
        rightItem !== undefined &&
        updatedWorst !== undefined &&
        isWorseMatch(rightItem, updatedWorst)
      ) {
        worst = right;
      }
      if (worst === index) return;
      const current = this.#items[index];
      const replacement = this.#items[worst];
      if (current === undefined || replacement === undefined) return;
      this.#items[index] = replacement;
      this.#items[worst] = current;
      index = worst;
    }
  }
}

function isWorseMatch(left: PrivateRagMatch, right: PrivateRagMatch): boolean {
  if (left.score !== right.score) return left.score < right.score;
  const noteOrder = left.noteId.localeCompare(right.noteId);
  if (noteOrder !== 0) return noteOrder > 0;
  return left.indexedRevision < right.indexedRevision;
}

function isBetterMatch(left: PrivateRagMatch, right: PrivateRagMatch): boolean {
  return isWorseMatch(right, left);
}

function compareBestFirst(left: PrivateRagMatch, right: PrivateRagMatch): number {
  if (left.score !== right.score) return right.score - left.score;
  const noteOrder = left.noteId.localeCompare(right.noteId);
  return noteOrder === 0 ? right.indexedRevision - left.indexedRevision : noteOrder;
}

function tokenCoverageScore(queryTokens: ReadonlySet<string>, document: string): number {
  if (queryTokens.size === 0) return 0;
  const found = new Set<string>();
  for (const match of document.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (queryTokens.has(token)) found.add(token);
    if (found.size === queryTokens.size) break;
  }
  return found.size / queryTokens.size;
}

export function privateRagTrigrams(value: string): ReadonlySet<string> {
  if (value.length <= 3) return value.length === 0 ? new Set() : new Set([value]);
  const result = new Set<string>();
  for (let index = 0; index <= value.length - 3; index += 1) {
    result.add(value.slice(index, index + 3));
  }
  return result;
}

function trigramCoverageScore(queryTrigrams: ReadonlySet<string>, document: string): number {
  if (queryTrigrams.size === 0) return 0;
  const found = new Set<string>();
  if (document.length <= 3) {
    if (queryTrigrams.has(document)) found.add(document);
  } else {
    for (let index = 0; index <= document.length - 3; index += 1) {
      const trigram = document.slice(index, index + 3);
      if (queryTrigrams.has(trigram)) found.add(trigram);
      if (found.size === queryTrigrams.size) break;
    }
  }
  return found.size / queryTrigrams.size;
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new PrivateRagScoringError();
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) throw new PrivateRagScoringError();
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
    if (!Number.isFinite(dot) || !Number.isFinite(leftNorm) || !Number.isFinite(rightNorm)) {
      throw new PrivateRagScoringError();
    }
  }
  if (leftNorm <= 0 || rightNorm <= 0) throw new PrivateRagScoringError();
  const similarity = dot / Math.sqrt(leftNorm * rightNorm);
  if (!Number.isFinite(similarity)) throw new PrivateRagScoringError();
  return Math.max(0, Math.min(1, similarity));
}

function recencyScore(updatedAt: string, now: number): number {
  const updatedAtEpochMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtEpochMs) || !Number.isFinite(now)) {
    throw new PrivateRagScoringError();
  }
  const ageDays = Math.max(0, now - updatedAtEpochMs) / MILLISECONDS_PER_DAY;
  return 1 / (1 + ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function scorePrivateRagDocument(
  document: PrivateRagScorableDocument,
  query: PreparedPrivateRagQuery,
  now: number
): PrivateRagMatch {
  const value = document.value;
  const signals: SearchSignals = {
    fullText: tokenCoverageScore(query.tokens, value.normalizedLexicalText),
    trigram: trigramCoverageScore(query.trigrams, value.normalizedLexicalText),
    vector: cosineSimilarity(query.embedding, document.embedding),
    recency: recencyScore(value.updatedAt, now),
    titleExact: normalizePrivateRagText(value.title) === query.normalizedText ? 1 : 0,
    pinned: value.pinned,
    privateManual: false
  };
  return {
    noteId: value.noteId,
    indexedRevision: value.indexedRevision,
    noteType: value.noteType,
    spaceId: value.spaceId,
    title: value.title,
    headings: value.headings.slice(0, MAX_PRIVATE_RAG_CANDIDATE_HEADINGS),
    latestSnippet: value.latestSnippet,
    isOpen: value.isOpen,
    pinned: value.pinned,
    updatedAt: value.updatedAt,
    score: rankSearchResult(signals),
    signals
  };
}
