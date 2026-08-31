import { ByteBoundedLruCache, PRIVATE_RAG_CACHE_TTL_MS } from "./byte-bounded-lru.js";
import {
  MAX_FLOAT32_EMBEDDING_DIMENSIONS,
  MIN_FLOAT32_EMBEDDING_DIMENSIONS
} from "./float32-embedding.js";
import {
  MAX_PRIVATE_RAG_PAYLOAD_BYTES,
  decodePrivateRagPayloadValue,
  normalizePrivateRagText
} from "./private-rag-payload.js";
import {
  PrivateRagScoringError,
  PrivateRagTopMatchHeap,
  privateRagTrigrams,
  scorePrivateRagDocument,
  type PreparedPrivateRagQuery,
  type PrivateRagScorableDocument
} from "./private-rag-scoring.js";
import {
  DEFAULT_PRIVATE_RAG_CACHE_BYTE_BUDGET,
  DEFAULT_PRIVATE_RAG_DECRYPT_CONCURRENCY,
  DEFAULT_PRIVATE_RAG_PAGE_BYTE_BUDGET,
  DEFAULT_PRIVATE_RAG_PAGE_SIZE,
  DEFAULT_PRIVATE_RAG_SCAN_BYTE_BUDGET,
  MAX_PRIVATE_RAG_CACHE_BYTE_BUDGET,
  MAX_PRIVATE_RAG_CONCURRENT_RETRIEVALS,
  MAX_PRIVATE_RAG_DECRYPT_CONCURRENCY,
  MAX_PRIVATE_RAG_PAGE_BYTE_BUDGET,
  MAX_PRIVATE_RAG_PAGE_SIZE,
  MAX_PRIVATE_RAG_PAGES,
  MAX_PRIVATE_RAG_QUERY_BYTES,
  MAX_PRIVATE_RAG_REPAIRS,
  MAX_PRIVATE_RAG_RESULTS,
  MAX_PRIVATE_RAG_SCAN_BYTE_BUDGET,
  type CompletePrivateRagResult,
  type IncompletePrivateRagResult,
  type PrivateRagCoverage,
  type PrivateRagGenerationSnapshot,
  type PrivateRagIncompleteReason,
  type PrivateRagPage,
  type PrivateRagPageReadResult,
  type PrivateRagQuery,
  type PrivateRagResult,
  type PrivateRagRetriever,
  type PrivateRagRetrieverOptions
} from "./private-rag-types.js";

const MAX_CURSOR_BYTES = 4096;
const MAX_IDENTIFIER_BYTES = 256;
const NOTE_ID_PATTERN = /^note_[0-9A-HJKMNP-TV-Z]{26}$/u;
const INDEX_ID_PATTERN = /^irw_[0-9A-HJKMNP-TV-Z]{26}$/u;
const textEncoder = new TextEncoder();
let activePrivateRagRetrievals = 0;

type ValidatedOptions<RecordValue> = Readonly<{
  pages: PrivateRagRetrieverOptions<RecordValue>["pages"];
  payloads: PrivateRagRetrieverOptions<RecordValue>["payloads"];
  repairs: PrivateRagRetrieverOptions<RecordValue>["repairs"];
  pageSize: number;
  decryptConcurrency: number;
  topK: number;
  maxPageBytes: number;
  maxScanBytes: number;
  maxPages: number;
  now: () => number;
}>;

type CachedCorpus = Readonly<{
  ownerId: string;
  snapshot: PrivateRagGenerationSnapshot;
  documents: readonly PrivateRagScorableDocument[];
  bytes: number;
}>;

class RetrievalFailure extends Error {
  readonly reason: PrivateRagIncompleteReason;
  readonly snapshot: PrivateRagGenerationSnapshot | undefined;

  constructor(reason: PrivateRagIncompleteReason, snapshot?: PrivateRagGenerationSnapshot) {
    super(reason);
    this.name = "RetrievalFailure";
    this.reason = reason;
    this.snapshot = snapshot;
  }
}

function fail(reason: PrivateRagIncompleteReason, snapshot?: PrivateRagGenerationSnapshot): never {
  throw new RetrievalFailure(reason, snapshot);
}

function positiveInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name}_out_of_range`);
  }
  return value;
}

function validateOptions<RecordValue>(
  options: PrivateRagRetrieverOptions<RecordValue>
): ValidatedOptions<RecordValue> {
  const pageSize = positiveInteger(
    options.pageSize ?? DEFAULT_PRIVATE_RAG_PAGE_SIZE,
    MAX_PRIVATE_RAG_PAGE_SIZE,
    "page_size"
  );
  const decryptConcurrency = positiveInteger(
    options.decryptConcurrency ?? DEFAULT_PRIVATE_RAG_DECRYPT_CONCURRENCY,
    MAX_PRIVATE_RAG_DECRYPT_CONCURRENCY,
    "decrypt_concurrency"
  );
  const maxPageBytes = positiveInteger(
    options.maxPageBytes ?? DEFAULT_PRIVATE_RAG_PAGE_BYTE_BUDGET,
    MAX_PRIVATE_RAG_PAGE_BYTE_BUDGET,
    "max_page_bytes"
  );
  const maxScanBytes = positiveInteger(
    options.maxScanBytes ?? DEFAULT_PRIVATE_RAG_SCAN_BYTE_BUDGET,
    MAX_PRIVATE_RAG_SCAN_BYTE_BUDGET,
    "max_scan_bytes"
  );
  if (maxScanBytes < maxPageBytes) throw new RangeError("max_scan_bytes_below_page_budget");
  return {
    pages: options.pages,
    payloads: options.payloads,
    repairs: options.repairs,
    pageSize,
    decryptConcurrency,
    topK: positiveInteger(
      options.topK ?? MAX_PRIVATE_RAG_RESULTS,
      MAX_PRIVATE_RAG_RESULTS,
      "top_k"
    ),
    maxPageBytes,
    maxScanBytes,
    maxPages: positiveInteger(
      options.maxPages ?? MAX_PRIVATE_RAG_PAGES,
      MAX_PRIVATE_RAG_PAGES,
      "max_pages"
    ),
    now: options.now ?? Date.now
  };
}

function incomplete(
  reason: PrivateRagIncompleteReason,
  snapshot?: PrivateRagGenerationSnapshot
): IncompletePrivateRagResult {
  return {
    status: "incomplete",
    coverage: "incomplete",
    autoApplyAllowed: false,
    reason,
    matches: [],
    ...(snapshot === undefined ? {} : { snapshot })
  };
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  snapshot?: PrivateRagGenerationSnapshot
): void {
  if (signal?.aborted === true) fail("aborted", snapshot);
}

function isSafeIdentifier(value: unknown, maximumBytes = MAX_IDENTIFIER_BYTES): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !hasControlCharacter(value) &&
    textEncoder.encode(value).byteLength <= maximumBytes
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateSnapshot(snapshot: PrivateRagGenerationSnapshot): void {
  if (
    !isSafeIdentifier(snapshot.generationId) ||
    !isSafeIdentifier(snapshot.modelId) ||
    !isSafeIdentifier(snapshot.revisionToken) ||
    !Number.isSafeInteger(snapshot.dimensions) ||
    snapshot.dimensions < MIN_FLOAT32_EMBEDDING_DIMENSIONS ||
    snapshot.dimensions > MAX_FLOAT32_EMBEDDING_DIMENSIONS ||
    !isCount(snapshot.expectedNoteCount) ||
    !isCount(snapshot.indexedNoteCount) ||
    snapshot.indexedNoteCount > snapshot.expectedNoteCount
  ) {
    fail("invalid_page", snapshot);
  }
}

function sameSnapshot(
  left: PrivateRagGenerationSnapshot,
  right: PrivateRagGenerationSnapshot
): boolean {
  return (
    left.generationId === right.generationId &&
    left.modelId === right.modelId &&
    left.dimensions === right.dimensions &&
    left.revisionToken === right.revisionToken &&
    left.expectedNoteCount === right.expectedNoteCount &&
    left.indexedNoteCount === right.indexedNoteCount
  );
}

function validateCoverage(
  coverage: unknown,
  snapshot: PrivateRagGenerationSnapshot
): asserts coverage is PrivateRagCoverage {
  if (!isRecord(coverage)) fail("invalid_page", snapshot);
  const candidates = unknownArray(coverage.repairCandidates);
  if (
    (coverage.status !== "complete" && coverage.status !== "incomplete") ||
    typeof coverage.repairOverflow !== "boolean" ||
    candidates === undefined ||
    !isCount(coverage.missingOrStaleCount)
  ) {
    fail("invalid_page", snapshot);
  }
  if (
    coverage.repairOverflow ||
    coverage.missingOrStaleCount > MAX_PRIVATE_RAG_REPAIRS ||
    candidates.length > MAX_PRIVATE_RAG_REPAIRS
  ) {
    fail("repair_limit_exceeded", snapshot);
  }
  const noteIds = new Set<string>();
  for (const candidate of candidates) {
    if (
      !isRecord(candidate) ||
      typeof candidate.noteId !== "string" ||
      !NOTE_ID_PATTERN.test(candidate.noteId) ||
      typeof candidate.currentRevision !== "number" ||
      !Number.isSafeInteger(candidate.currentRevision) ||
      candidate.currentRevision < 1 ||
      noteIds.has(candidate.noteId)
    ) {
      fail("invalid_page", snapshot);
    }
    noteIds.add(candidate.noteId);
  }
  if (coverage.status === "complete") {
    if (
      coverage.missingOrStaleCount !== 0 ||
      candidates.length !== 0 ||
      snapshot.indexedNoteCount !== snapshot.expectedNoteCount
    ) {
      fail("invalid_page", snapshot);
    }
  } else if (
    coverage.missingOrStaleCount === 0 ||
    candidates.length !== coverage.missingOrStaleCount
  ) {
    fail("coverage_incomplete", snapshot);
  }
}

function validatePage<RecordValue>(
  page: PrivateRagPage<RecordValue>,
  options: ValidatedOptions<RecordValue>,
  expectedSnapshot?: PrivateRagGenerationSnapshot
): number {
  validateSnapshot(page.snapshot);
  if (expectedSnapshot !== undefined && !sameSnapshot(page.snapshot, expectedSnapshot)) {
    fail("snapshot_changed", expectedSnapshot);
  }
  validateCoverage(page.coverage, page.snapshot);
  if (page.items.length > options.pageSize) {
    fail("invalid_page", page.snapshot);
  }
  let bytes = 0;
  for (const item of page.items) {
    if (
      !INDEX_ID_PATTERN.test(item.indexId) ||
      !NOTE_ID_PATTERN.test(item.noteId) ||
      !Number.isSafeInteger(item.indexedRevision) ||
      item.indexedRevision < 1 ||
      !Number.isSafeInteger(item.ciphertextBytes) ||
      item.ciphertextBytes < 1
    ) {
      fail("invalid_page", page.snapshot);
    }
    bytes += item.ciphertextBytes;
    if (!Number.isSafeInteger(bytes) || bytes > options.maxPageBytes) {
      fail("byte_budget_exceeded", page.snapshot);
    }
  }
  if (
    page.nextCursor !== null &&
    (page.items.length === 0 || !isSafeIdentifier(page.nextCursor, MAX_CURSOR_BYTES))
  ) {
    fail("invalid_page", page.snapshot);
  }
  return bytes;
}

function validateQuery(query: PrivateRagQuery): Readonly<{
  normalizedText: string;
  modelId: string;
  embedding: Float32Array;
}> {
  if (!isSafeIdentifier(query.modelId)) fail("invalid_query");
  const normalizedText = normalizePrivateRagText(query.text);
  if (
    normalizedText.length === 0 ||
    textEncoder.encode(normalizedText).byteLength > MAX_PRIVATE_RAG_QUERY_BYTES ||
    !Number.isSafeInteger(query.embedding.length) ||
    query.embedding.length < MIN_FLOAT32_EMBEDDING_DIMENSIONS ||
    query.embedding.length > MAX_FLOAT32_EMBEDDING_DIMENSIONS
  ) {
    fail("invalid_query");
  }
  const embedding = new Float32Array(query.embedding.length);
  let norm = 0;
  for (let index = 0; index < query.embedding.length; index += 1) {
    const value = query.embedding[index];
    const rounded = value === undefined ? Number.NaN : Math.fround(value);
    if (!Number.isFinite(rounded)) {
      embedding.fill(0);
      fail("query_embedding_invalid");
    }
    embedding[index] = rounded;
    norm += rounded * rounded;
    if (!Number.isFinite(norm)) {
      embedding.fill(0);
      fail("query_embedding_invalid");
    }
  }
  if (norm <= 0) {
    embedding.fill(0);
    fail("query_embedding_invalid");
  }
  return { normalizedText, modelId: query.modelId, embedding };
}

function cacheKey(ownerId: string, snapshot: PrivateRagGenerationSnapshot): string {
  return JSON.stringify([ownerId, snapshot.generationId, snapshot.modelId, snapshot.revisionToken]);
}

function disposeDocument(document: PrivateRagScorableDocument): void {
  document.embedding.fill(0);
}

function disposeCorpus(corpus: CachedCorpus): void {
  for (const document of corpus.documents) disposeDocument(document);
}

function preparedQuery(
  query: Readonly<{ normalizedText: string; embedding: Float32Array }>
): PreparedPrivateRagQuery {
  return {
    normalizedText: query.normalizedText,
    embedding: query.embedding,
    tokens: new Set(query.normalizedText.match(/[\p{L}\p{N}]+/gu) ?? []),
    trigrams: privateRagTrigrams(query.normalizedText)
  };
}

async function runBounded<Item>(
  items: readonly Item[],
  concurrency: number,
  operation: (item: Item) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item === undefined) return;
      try {
        await operation(item);
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => worker())
  );
  if (firstError !== undefined) {
    throw firstError instanceof Error
      ? firstError
      : new Error("bounded_operation_failed", { cause: firstError });
  }
}

async function performRepair<RecordValue>(
  ownerId: string,
  snapshot: PrivateRagGenerationSnapshot,
  coverage: PrivateRagCoverage,
  signal: AbortSignal | undefined,
  options: ValidatedOptions<RecordValue>
): Promise<void> {
  if (options.repairs === undefined) fail("repair_unavailable", snapshot);
  assertNotAborted(signal, snapshot);
  try {
    const result = await options.repairs.repair({
      ownerId,
      snapshot,
      candidates: coverage.repairCandidates,
      ...(signal === undefined ? {} : { signal })
    });
    if (
      !Number.isSafeInteger(result.repairedCount) ||
      result.repairedCount !== coverage.repairCandidates.length
    ) {
      fail("repair_failed", snapshot);
    }
  } catch (error) {
    if (error instanceof RetrievalFailure) throw error;
    if (signal?.aborted === true) fail("aborted", snapshot);
    fail("repair_failed", snapshot);
  }
}

async function verifySnapshot<RecordValue>(
  ownerId: string,
  snapshot: PrivateRagGenerationSnapshot,
  signal: AbortSignal | undefined,
  options: ValidatedOptions<RecordValue>
): Promise<void> {
  assertNotAborted(signal, snapshot);
  try {
    const valid: unknown = await options.pages.verifySnapshot({
      ownerId,
      snapshot,
      ...(signal === undefined ? {} : { signal })
    });
    if (valid !== true) fail("snapshot_changed", snapshot);
  } catch (error) {
    if (error instanceof RetrievalFailure) throw error;
    if (signal?.aborted === true) fail("aborted", snapshot);
    fail("snapshot_verification_failed", snapshot);
  }
}

export function createPrivateRagRetriever<RecordValue>(
  rawOptions: PrivateRagRetrieverOptions<RecordValue>
): PrivateRagRetriever {
  const options = validateOptions(rawOptions);
  const cacheMaxBytes = rawOptions.cacheMaxBytes ?? DEFAULT_PRIVATE_RAG_CACHE_BYTE_BUDGET;
  if (
    !Number.isSafeInteger(cacheMaxBytes) ||
    cacheMaxBytes < 0 ||
    cacheMaxBytes > MAX_PRIVATE_RAG_CACHE_BYTE_BUDGET
  ) {
    throw new RangeError("cache_max_bytes_out_of_range");
  }
  const cache =
    cacheMaxBytes === 0
      ? undefined
      : new ByteBoundedLruCache<string, CachedCorpus>({
          maxBytes: cacheMaxBytes,
          ttlMs: rawOptions.cacheTtlMs ?? PRIVATE_RAG_CACHE_TTL_MS,
          now: options.now,
          dispose: disposeCorpus
        });

  const readFirst = async (
    ownerId: string,
    signal: AbortSignal | undefined
  ): Promise<PrivateRagPageReadResult<RecordValue>> => {
    assertNotAborted(signal);
    try {
      return await options.pages.readPage({
        ownerId,
        cursor: null,
        limit: options.pageSize,
        maxBytes: options.maxPageBytes,
        expectedSnapshot: null,
        ...(signal === undefined ? {} : { signal })
      });
    } catch {
      if (signal?.aborted === true) fail("aborted");
      fail("backend_unavailable");
    }
  };

  const retrieveFresh = async (
    ownerId: string,
    query: Readonly<{ normalizedText: string; modelId: string; embedding: Float32Array }>,
    signal: AbortSignal | undefined,
    repairAttempted: boolean
  ): Promise<CompletePrivateRagResult> => {
    const firstRead = await readFirst(ownerId, signal);
    if (firstRead.status === "no_active_generation") fail("no_active_generation");
    const firstPage = firstRead.page;
    validatePage(firstPage, options);
    const snapshot = firstPage.snapshot;
    if (query.modelId !== snapshot.modelId || query.embedding.length !== snapshot.dimensions) {
      fail("query_embedding_mismatch", snapshot);
    }
    if (firstPage.coverage.status === "incomplete") {
      if (repairAttempted) fail("repair_incomplete", snapshot);
      await performRepair(ownerId, snapshot, firstPage.coverage, signal, options);
      return retrieveFresh(ownerId, query, signal, true);
    }

    const key = cacheKey(ownerId, snapshot);
    const cached = cache?.get(key);
    const now = options.now();
    if (!Number.isFinite(now)) fail("numeric_instability", snapshot);
    const scoringQuery = preparedQuery(query);
    if (
      cached !== undefined &&
      sameSnapshot(cached.snapshot, snapshot) &&
      cached.documents.length === snapshot.expectedNoteCount
    ) {
      const heap = new PrivateRagTopMatchHeap(options.topK);
      try {
        for (const document of cached.documents) {
          heap.add(scorePrivateRagDocument(document, scoringQuery, now));
        }
      } catch (error) {
        if (error instanceof PrivateRagScoringError) fail("numeric_instability", snapshot);
        throw error;
      }
      await verifySnapshot(ownerId, snapshot, signal, options);
      return {
        status: "complete",
        coverage: "complete",
        autoApplyAllowed: true,
        snapshot,
        matches: heap.sorted(),
        scannedNoteCount: cached.documents.length,
        scannedBytes: cached.bytes,
        repaired: repairAttempted,
        cache: "hit"
      };
    }
    if (cached !== undefined) cache?.delete(key);

    const heap = new PrivateRagTopMatchHeap(options.topK);
    const seenNotes = new Set<string>();
    const seenCursors = new Set<string>();
    let page = firstPage;
    let pageCount = 0;
    let scannedBytes = 0;
    let scannedNoteCount = 0;
    let cacheDocuments: PrivateRagScorableDocument[] | undefined =
      cache === undefined ? undefined : [];
    let cacheBytes = 0;

    try {
      for (;;) {
        pageCount += 1;
        if (pageCount > options.maxPages) fail("scan_limit_exceeded", snapshot);
        const pageBytes = validatePage(page, options, snapshot);
        if (page.coverage.status !== "complete") fail("coverage_incomplete", snapshot);
        scannedBytes += pageBytes;
        if (!Number.isSafeInteger(scannedBytes) || scannedBytes > options.maxScanBytes) {
          fail("byte_budget_exceeded", snapshot);
        }
        for (const item of page.items) {
          if (seenNotes.has(item.noteId)) fail("invalid_page", snapshot);
          seenNotes.add(item.noteId);
        }

        await runBounded(page.items, options.decryptConcurrency, async (item) => {
          assertNotAborted(signal, snapshot);
          let document: PrivateRagScorableDocument | undefined;
          let opened: Readonly<{ value: unknown; plaintextBytes: number }>;
          try {
            opened = await options.payloads.openPayload({
              ownerId,
              snapshot,
              item,
              ...(signal === undefined ? {} : { signal })
            });
          } catch {
            if (signal?.aborted === true) fail("aborted", snapshot);
            fail("decrypt_failed", snapshot);
          }
          if (
            !Number.isSafeInteger(opened.plaintextBytes) ||
            opened.plaintextBytes < 1 ||
            opened.plaintextBytes > MAX_PRIVATE_RAG_PAYLOAD_BYTES
          ) {
            fail("byte_budget_exceeded", snapshot);
          }
          scannedBytes += opened.plaintextBytes;
          if (!Number.isSafeInteger(scannedBytes) || scannedBytes > options.maxScanBytes) {
            fail("byte_budget_exceeded", snapshot);
          }
          try {
            const decoded = decodePrivateRagPayloadValue(opened.value, {
              noteId: item.noteId,
              indexedRevision: item.indexedRevision,
              modelId: snapshot.modelId,
              dimensions: snapshot.dimensions
            });
            document = {
              value: decoded.value,
              embedding: decoded.embedding,
              cacheBytes:
                opened.plaintextBytes * 2 +
                decoded.embedding.byteLength +
                textEncoder.encode(item.noteId).byteLength
            };
          } catch {
            fail("payload_invalid", snapshot);
          }
          try {
            try {
              heap.add(scorePrivateRagDocument(document, scoringQuery, now));
            } catch (error) {
              if (error instanceof PrivateRagScoringError) fail("numeric_instability", snapshot);
              throw error;
            }
            scannedNoteCount += 1;
            if (cacheDocuments !== undefined && cache !== undefined) {
              const nextBytes = cacheBytes + document.cacheBytes;
              if (Number.isSafeInteger(nextBytes) && nextBytes <= cache.maxBytes) {
                cacheDocuments.push(document);
                cacheBytes = nextBytes;
                document = undefined;
              } else {
                for (const entry of cacheDocuments) disposeDocument(entry);
                cacheDocuments = undefined;
                cacheBytes = 0;
              }
            }
          } finally {
            if (document !== undefined) disposeDocument(document);
          }
        });

        if (page.nextCursor === null) break;
        if (seenCursors.has(page.nextCursor)) fail("invalid_page", snapshot);
        seenCursors.add(page.nextCursor);
        assertNotAborted(signal, snapshot);
        let nextRead: PrivateRagPageReadResult<RecordValue>;
        try {
          nextRead = await options.pages.readPage({
            ownerId,
            cursor: page.nextCursor,
            limit: options.pageSize,
            maxBytes: options.maxPageBytes,
            expectedSnapshot: {
              generationId: snapshot.generationId,
              revisionToken: snapshot.revisionToken
            },
            ...(signal === undefined ? {} : { signal })
          });
        } catch {
          if (signal?.aborted === true) fail("aborted", snapshot);
          fail("backend_unavailable", snapshot);
        }
        if (nextRead.status !== "page") fail("snapshot_changed", snapshot);
        page = nextRead.page;
      }

      if (
        scannedNoteCount !== snapshot.expectedNoteCount ||
        seenNotes.size !== snapshot.expectedNoteCount
      ) {
        fail("coverage_incomplete", snapshot);
      }
      await verifySnapshot(ownerId, snapshot, signal, options);
      if (cacheDocuments !== undefined && cache !== undefined) {
        const corpus: CachedCorpus = {
          ownerId,
          snapshot,
          documents: cacheDocuments,
          bytes: scannedBytes
        };
        if (cache.set(key, corpus, cacheBytes)) {
          cacheDocuments = undefined;
        } else {
          disposeCorpus(corpus);
          cacheDocuments = undefined;
        }
      }
      return {
        status: "complete",
        coverage: "complete",
        autoApplyAllowed: true,
        snapshot,
        matches: heap.sorted(),
        scannedNoteCount,
        scannedBytes,
        repaired: repairAttempted,
        cache: cache === undefined ? "bypassed" : "miss"
      };
    } finally {
      if (cacheDocuments !== undefined) {
        for (const document of cacheDocuments) disposeDocument(document);
      }
    }
  };

  return {
    async retrieve(input): Promise<PrivateRagResult> {
      let query: ReturnType<typeof validateQuery> | undefined;
      if (activePrivateRagRetrievals >= MAX_PRIVATE_RAG_CONCURRENT_RETRIEVALS) {
        return incomplete("concurrency_limit_exceeded");
      }
      activePrivateRagRetrievals += 1;
      try {
        if (!isSafeIdentifier(input.ownerId)) fail("invalid_query");
        assertNotAborted(input.signal);
        query = validateQuery(input.query);
        return await retrieveFresh(input.ownerId, query, input.signal, false);
      } catch (error) {
        if (error instanceof RetrievalFailure) return incomplete(error.reason, error.snapshot);
        return incomplete(input.signal?.aborted === true ? "aborted" : "backend_unavailable");
      } finally {
        query?.embedding.fill(0);
        activePrivateRagRetrievals -= 1;
      }
    },
    clearCache(): void {
      cache?.clear();
    },
    invalidateOwner(ownerId: string): number {
      return cache?.deleteWhere((corpus) => corpus.ownerId === ownerId) ?? 0;
    },
    cacheStats(): Readonly<{ entries: number; bytes: number; maxBytes: number }> {
      return {
        entries: cache?.size ?? 0,
        bytes: cache?.currentBytes ?? 0,
        maxBytes: cache?.maxBytes ?? 0
      };
    }
  };
}
