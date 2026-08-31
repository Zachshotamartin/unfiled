import type { PrivateRagNoteType } from "./private-rag-payload.js";
import type { SearchSignals } from "./ranking.js";

export const MAX_PRIVATE_RAG_RESULTS = 8;
export const MAX_PRIVATE_RAG_REPAIRS = 50;
export const MAX_PRIVATE_RAG_DECRYPT_CONCURRENCY = 8;
export const MAX_PRIVATE_RAG_CONCURRENT_RETRIEVALS = 4;
export const MAX_PRIVATE_RAG_PAGE_SIZE = 50;
export const DEFAULT_PRIVATE_RAG_PAGE_SIZE = 50;
export const DEFAULT_PRIVATE_RAG_DECRYPT_CONCURRENCY = 4;
export const DEFAULT_PRIVATE_RAG_PAGE_BYTE_BUDGET = 2 * 1024 * 1024;
export const DEFAULT_PRIVATE_RAG_SCAN_BYTE_BUDGET = 512 * 1024 * 1024;
export const DEFAULT_PRIVATE_RAG_CACHE_BYTE_BUDGET = 64 * 1024 * 1024;
export const MAX_PRIVATE_RAG_PAGE_BYTE_BUDGET = 8 * 1024 * 1024;
export const MAX_PRIVATE_RAG_SCAN_BYTE_BUDGET = DEFAULT_PRIVATE_RAG_SCAN_BYTE_BUDGET;
export const MAX_PRIVATE_RAG_CACHE_BYTE_BUDGET = DEFAULT_PRIVATE_RAG_CACHE_BYTE_BUDGET;
export const MAX_PRIVATE_RAG_PAGES = 10_000;
export const MAX_PRIVATE_RAG_QUERY_BYTES = 4096;

export type PrivateRagGenerationSnapshot = Readonly<{
  generationId: string;
  modelId: string;
  dimensions: number;
  revisionToken: string;
  expectedNoteCount: number;
  indexedNoteCount: number;
}>;

export type PrivateRagRepairCandidate = Readonly<{
  noteId: string;
  currentRevision: number;
}>;

export type PrivateRagCoverage = Readonly<{
  status: "complete" | "incomplete";
  missingOrStaleCount: number;
  repairCandidates: readonly PrivateRagRepairCandidate[];
  repairOverflow: boolean;
}>;

export type PrivateRagPageItem<RecordValue> = Readonly<{
  indexId: string;
  noteId: string;
  indexedRevision: number;
  ciphertextBytes: number;
  record: RecordValue;
}>;

export type PrivateRagPage<RecordValue> = Readonly<{
  snapshot: PrivateRagGenerationSnapshot;
  coverage: PrivateRagCoverage;
  items: readonly PrivateRagPageItem<RecordValue>[];
  nextCursor: string | null;
}>;

export type PrivateRagPageReadResult<RecordValue> =
  | Readonly<{ status: "no_active_generation" }>
  | Readonly<{ status: "page"; page: PrivateRagPage<RecordValue> }>;

export type PrivateRagPagePort<RecordValue> = Readonly<{
  readPage(
    input: Readonly<{
      ownerId: string;
      cursor: string | null;
      limit: number;
      maxBytes: number;
      expectedSnapshot: Readonly<{
        generationId: string;
        revisionToken: string;
      }> | null;
      signal?: AbortSignal;
    }>
  ): Promise<PrivateRagPageReadResult<RecordValue>>;
  verifySnapshot(
    input: Readonly<{
      ownerId: string;
      snapshot: PrivateRagGenerationSnapshot;
      signal?: AbortSignal;
    }>
  ): Promise<boolean>;
}>;

export type PrivateRagPayloadOpener<RecordValue> = Readonly<{
  openPayload(
    input: Readonly<{
      ownerId: string;
      snapshot: PrivateRagGenerationSnapshot;
      item: PrivateRagPageItem<RecordValue>;
      signal?: AbortSignal;
    }>
  ): Promise<Readonly<{ value: unknown; plaintextBytes: number }>>;
}>;

export type PrivateRagRepairPort = Readonly<{
  repair(
    input: Readonly<{
      ownerId: string;
      snapshot: PrivateRagGenerationSnapshot;
      candidates: readonly PrivateRagRepairCandidate[];
      signal?: AbortSignal;
    }>
  ): Promise<Readonly<{ repairedCount: number }>>;
}>;

export type PrivateRagQuery = Readonly<{
  text: string;
  modelId: string;
  embedding: readonly number[] | Float32Array;
}>;

export type PrivateRagMatch = Readonly<{
  noteId: string;
  indexedRevision: number;
  noteType: PrivateRagNoteType;
  spaceId: string | null;
  title: string;
  headings: readonly string[];
  latestSnippet: string;
  isOpen: boolean;
  pinned: boolean;
  updatedAt: string;
  score: number;
  signals: SearchSignals;
}>;

export const privateRagIncompleteReasons = [
  "aborted",
  "backend_unavailable",
  "no_active_generation",
  "invalid_query",
  "query_embedding_invalid",
  "query_embedding_mismatch",
  "invalid_page",
  "snapshot_changed",
  "coverage_incomplete",
  "repair_limit_exceeded",
  "repair_unavailable",
  "repair_failed",
  "repair_incomplete",
  "decrypt_failed",
  "payload_invalid",
  "numeric_instability",
  "byte_budget_exceeded",
  "scan_limit_exceeded",
  "concurrency_limit_exceeded",
  "snapshot_verification_failed"
] as const;

export type PrivateRagIncompleteReason = (typeof privateRagIncompleteReasons)[number];

export type CompletePrivateRagResult = Readonly<{
  status: "complete";
  coverage: "complete";
  autoApplyAllowed: true;
  snapshot: PrivateRagGenerationSnapshot;
  matches: readonly PrivateRagMatch[];
  scannedNoteCount: number;
  scannedBytes: number;
  repaired: boolean;
  cache: "hit" | "miss" | "bypassed";
}>;

export type IncompletePrivateRagResult = Readonly<{
  status: "incomplete";
  coverage: "incomplete";
  autoApplyAllowed: false;
  reason: PrivateRagIncompleteReason;
  matches: readonly [];
  snapshot?: PrivateRagGenerationSnapshot;
}>;

export type PrivateRagResult = CompletePrivateRagResult | IncompletePrivateRagResult;

export type PrivateRagRetrieverOptions<RecordValue> = Readonly<{
  pages: PrivateRagPagePort<RecordValue>;
  payloads: PrivateRagPayloadOpener<RecordValue>;
  repairs?: PrivateRagRepairPort;
  pageSize?: number;
  decryptConcurrency?: number;
  topK?: number;
  maxPageBytes?: number;
  maxScanBytes?: number;
  maxPages?: number;
  cacheMaxBytes?: number;
  cacheTtlMs?: number;
  now?: () => number;
}>;

export type PrivateRagRetriever = Readonly<{
  retrieve(
    input: Readonly<{
      ownerId: string;
      query: PrivateRagQuery;
      signal?: AbortSignal;
    }>
  ): Promise<PrivateRagResult>;
  clearCache(): void;
  invalidateOwner(ownerId: string): number;
  cacheStats(): Readonly<{ entries: number; bytes: number; maxBytes: number }>;
}>;
