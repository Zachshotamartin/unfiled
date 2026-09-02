import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { importKeyEncryptionKey, sealBytes } from "@unfiled/content-crypto";
import {
  RAG_GENERATION_VERIFICATION_NOTE_CAPACITY,
  type EncryptedUserSearchInvocation,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";
import {
  parseManagedKeyRecord,
  type DecryptOnlyIntermediateKeyCustodian,
  type ManagedKeyRecordV1
} from "@unfiled/key-management";
import {
  buildPrivateRagPayloadValue,
  serializePrivateRagIndexDocument,
  type PrivateRagGenerationSnapshot,
  type PrivateRagPage,
  type PrivateRagPageItem
} from "@unfiled/search";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SEARCH_EMBEDDING_DIMENSIONS, SEARCH_EMBEDDING_MODEL_ID } from "../src/config.js";
import type {
  ClaimedEncryptedUserSearch,
  EncryptedUserSearchRepository,
  SearchRagMetadata,
  SearchRagRecord
} from "../src/database.js";
import type { SearchEmbeddingProvider } from "../src/embedding-provider.js";
import type * as SearchKeyManagementModule from "../src/key-management.js";
import { createEncryptedUserSearchQuery } from "../src/query.js";

const keyManagementMocks = vi.hoisted(() => ({
  custodianForSearchAuthority: vi.fn()
}));

vi.mock("../src/key-management.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SearchKeyManagementModule>()),
  custodianForSearchAuthority: keyManagementMocks.custodianForSearchAuthority
}));

const SEARCH_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";
const GENERATION_ID = "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const GENERATION_ATTESTATION_DIGEST = "d".repeat(64);
const REQUEST_DIGEST = "a".repeat(64);
const FILTER_DIGEST = "c".repeat(64);
const CANDIDATE_DIGEST = "b".repeat(64);
const CORPUS_VERSION = "encrypted-search-relevance-v1";
const NOTE_COUNT = RAG_GENERATION_VERIFICATION_NOTE_CAPACITY;
const PAGE_SIZE = 50;
const TOP_K = 8;
const DISTINCT_KEY_COUNT = 4;
const INDEXED_REVISION = 7;
const SAMPLE_COUNT = 20;
const P95_LIMIT_MS = 2_000;
const MAX_ADDED_HEAP_MIB = 512;
const MAX_ADDED_RSS_MIB = 768;
const FIXED_KEY_BYTE = 0x5a;
const TEST_TIMEOUT_MS = 180_000;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const AUTHORITY = Object.freeze({}) as SearchKeyManagementModule.SearchKeyAuthority;

type RelevanceCategory =
  "exact_title" | "misspelling" | "mixed_signal" | "semantic_paraphrase" | "stable_tie";

type RelevanceCase = Readonly<{
  category: RelevanceCategory;
  query: string;
  queryAxis: number;
  searchableText: string;
  targetIndex: number;
  title: string;
  tiePartnerIndex: number | null;
}>;

const MISSPELLING_PAIRS = Object.freeze([
  ["spinich", "spinach"],
  ["grocreies", "groceries"],
  ["workuot", "workout"],
  ["jounral", "journal"],
  ["meditaion", "meditation"],
  ["apointment", "appointment"],
  ["birhtday", "birthday"],
  ["restarant", "restaurant"],
  ["proejct", "project"],
  ["remidner", "reminder"]
] as const);

const EXACT_TITLES = Object.freeze([
  "Morning pages",
  "Weekly review",
  "Packing list",
  "Reading queue",
  "Training log"
]);

const RELEVANCE_CASES: readonly RelevanceCase[] = Object.freeze([
  Object.freeze({
    category: "semantic_paraphrase" as const,
    query: "that quote about promising first",
    queryAxis: 0,
    searchableText: "Tell people you can do it, then work out how.",
    targetIndex: 0,
    title: "Roosevelt method",
    tiePartnerIndex: null
  }),
  ...Array.from({ length: 19 }, (_value, offset) => {
    const targetIndex = offset + 1;
    return Object.freeze({
      category: "semantic_paraphrase" as const,
      query: `intent phrase ${String.fromCharCode(97 + offset)} azure`,
      queryAxis: targetIndex,
      searchableText: `Personal concept record ${String.fromCharCode(65 + offset)} amber`,
      targetIndex,
      title: `Concept ${String.fromCharCode(65 + offset)}`,
      tiePartnerIndex: null
    });
  }),
  ...MISSPELLING_PAIRS.map(([query, correct], offset) => {
    const targetIndex = 20 + offset;
    return Object.freeze({
      category: "misspelling" as const,
      query,
      queryAxis: 1_500,
      searchableText: `${correct} personal note`,
      targetIndex,
      title: `${correct} note`,
      tiePartnerIndex: null
    });
  }),
  ...EXACT_TITLES.map((query, offset) => {
    const targetIndex = 30 + offset;
    return Object.freeze({
      category: "exact_title" as const,
      query,
      queryAxis: 1_500,
      searchableText: `${query} details`,
      targetIndex,
      title: query,
      tiePartnerIndex: null
    });
  }),
  ...Array.from({ length: 10 }, (_value, offset) => {
    const targetIndex = 35 + offset;
    const query = `shared planning signal ${String.fromCharCode(97 + offset)}`;
    return Object.freeze({
      category: "mixed_signal" as const,
      query,
      queryAxis: targetIndex,
      searchableText: `${query} preferred context`,
      targetIndex,
      title: query,
      tiePartnerIndex: 55 + offset
    });
  }),
  ...Array.from({ length: 5 }, (_value, offset) => {
    const targetIndex = 45 + offset;
    const query = `stable tied result ${String.fromCharCode(97 + offset)}`;
    return Object.freeze({
      category: "stable_tie" as const,
      query,
      queryAxis: targetIndex,
      searchableText: query,
      targetIndex,
      title: query,
      tiePartnerIndex: 50 + offset
    });
  })
]);

if (RELEVANCE_CASES.length !== 50) throw new TypeError("invalid relevance corpus");

const FILTERS: EncryptedUserSearchInvocation["material"]["filters"] = {
  archive: "exclude",
  privacy: "ai_assisted",
  space: { id: null, mode: "any" },
  tagIds: [],
  type: null,
  updatedFrom: null,
  updatedTo: null
};

const SNAPSHOT: PrivateRagGenerationSnapshot = Object.freeze({
  dimensions: SEARCH_EMBEDDING_DIMENSIONS,
  expectedNoteCount: NOTE_COUNT,
  generationId: GENERATION_ID,
  indexedNoteCount: NOTE_COUNT,
  modelId: SEARCH_EMBEDDING_MODEL_ID,
  revisionToken: "12"
});

const COVERAGE = Object.freeze({
  missingOrStaleCount: 0,
  repairCandidates: Object.freeze([]),
  repairOverflow: false,
  status: "complete" as const
});

const CLAIM: ClaimedEncryptedUserSearch = Object.freeze({
  filterDigest: FILTER_DIGEST,
  generation: Object.freeze({
    attestationDigest: GENERATION_ATTESTATION_DIGEST,
    embeddingDimensions: SEARCH_EMBEDDING_DIMENSIONS,
    embeddingModelId: SEARCH_EMBEDDING_MODEL_ID,
    envelopeSchemaVersion: 1,
    generationId: GENERATION_ID,
    revisionToken: SNAPSHOT.revisionToken
  }),
  leaseExpiresAt: "2099-09-01T12:00:00.000Z",
  leaseToken: LEASE_TOKEN,
  ownerId: OWNER_ID,
  requestDigest: REQUEST_DIGEST,
  searchId: SEARCH_ID
});

const OBJECT_KEYS: readonly ManagedKeyRecordV1[] = Object.freeze(
  Array.from({ length: DISTINCT_KEY_COUNT }, (_value, index) =>
    parseManagedKeyRecord({
      activatedAt: "2026-08-30T12:00:00.000Z",
      createdAt: "2026-08-30T12:00:00.000Z",
      encryptedKeyMaterial: Buffer.from(`encrypted-search-key-${index}`).toString("base64url"),
      keyClass: "ai_assisted",
      keyId: `key.ai.object_wrap.search.capacity.v${index + 1}`,
      keyVersion: index + 1,
      ownerId: OWNER_ID,
      purpose: "object_wrap",
      retiredAt: index === 0 ? null : "2026-08-31T12:00:00.000Z",
      revokedAt: null,
      rootKeyArn: `arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-${String(
        index + 1
      ).padStart(12, "0")}`,
      rotation: {
        lastRootRewrappedAt: null,
        predecessorKeyId: null,
        previousRootKeyArn: null,
        rootRewrapCount: 0
      },
      schemaVersion: 1,
      status: index === 0 ? "active" : "retired",
      wrapOperationLimit: 16_777_216,
      wrapOperations: 0
    })
  )
);

type CapacityFixture = Readonly<{
  fixturePreparationMs: number;
  noteIdsByIndex: readonly string[];
  pages: readonly PrivateRagPage<SearchRagRecord>[];
}>;

type RepositoryFixture = Readonly<{
  claim: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["claim"]>>;
  complete: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["complete"]>>;
  fail: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["fail"]>>;
  page: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["page"]>>;
  port: EncryptedUserSearchRepository;
  verify: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["verify"]>>;
}>;

type Sample = Readonly<{
  durationMs: number;
  unwrappedKeys: number;
}>;

type SearchRun = Readonly<{
  durationMs: number;
  result: EncryptedUserSearchResult;
  unwrappedKeys: number;
}>;

let fixture: CapacityFixture;
let unwrapCalls = 0;

function suffixFor(index: number): string {
  let value = index;
  let suffix = "";
  for (let position = 0; position < 26; position += 1) {
    suffix = `${CROCKFORD_BASE32[value % CROCKFORD_BASE32.length]}${suffix}`;
    value = Math.floor(value / CROCKFORD_BASE32.length);
  }
  return suffix;
}

function deterministicCrypto(seed: number): Crypto {
  let invocation = 0;
  return {
    getRandomValues(array: ArrayBufferView): ArrayBufferView {
      const output = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      let offset = 0;
      while (offset < output.byteLength) {
        const digest = createHash("sha256").update(`${seed}:${invocation}`).digest();
        invocation += 1;
        const length = Math.min(digest.byteLength, output.byteLength - offset);
        output.set(digest.subarray(0, length), offset);
        digest.fill(0);
        offset += length;
      }
      return array;
    },
    randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
      return "00000000-0000-4000-8000-000000000000";
    },
    subtle: globalThis.crypto.subtle
  } as unknown as Crypto;
}

function fixtureCustodian(): DecryptOnlyIntermediateKeyCustodian {
  return Object.freeze({
    async withUnwrappedIntermediateKey(recordValue, use, options) {
      if (options?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      const record = parseManagedKeyRecord(recordValue);
      const bytes = new Uint8Array(32).fill(FIXED_KEY_BYTE);
      unwrapCalls += 1;
      try {
        return await use(bytes, record);
      } finally {
        bytes.fill(0);
      }
    }
  });
}

type DocumentProfile = Readonly<{
  axis: number;
  searchableText: string;
  title: string;
}>;

function documentProfile(index: number): DocumentProfile {
  const target = RELEVANCE_CASES.find((entry) => entry.targetIndex === index);
  if (target !== undefined) {
    return Object.freeze({
      axis:
        target.category === "misspelling" || target.category === "exact_title"
          ? 1_499
          : target.queryAxis,
      searchableText: target.searchableText,
      title: target.title
    });
  }
  const companion = RELEVANCE_CASES.find((entry) => entry.tiePartnerIndex === index);
  if (companion !== undefined) {
    return Object.freeze({
      axis: companion.category === "stable_tie" ? companion.queryAxis : 1_499,
      searchableText: companion.searchableText,
      title: companion.title
    });
  }
  return Object.freeze({
    axis: 1_499,
    searchableText: `background archive material ${index}`,
    title: `Reference ${index}`
  });
}

function vectorFor(axis: number): Float32Array {
  const embedding = new Float32Array(SEARCH_EMBEDDING_DIMENSIONS);
  embedding[axis] = 1;
  return embedding;
}

function metadata(): SearchRagMetadata {
  return Object.freeze({
    archivedAt: null,
    pinnedAt: null,
    spaceId: null,
    tagIds: Object.freeze([]),
    type: "principle",
    updatedAt: "2026-08-31T12:00:00.000Z"
  });
}

async function encryptedItem(
  index: number,
  key: Awaited<ReturnType<typeof importKeyEncryptionKey>>,
  objectKey: ManagedKeyRecordV1
): Promise<PrivateRagPageItem<SearchRagRecord>> {
  const suffix = suffixFor(index);
  const noteId = `note_${suffix}`;
  const indexId = `irw_${suffix}`;
  const noteMetadata = metadata();
  const profile = documentProfile(index);
  const payload = buildPrivateRagPayloadValue({
    embedding: vectorFor(profile.axis),
    headings: [],
    indexedRevision: INDEXED_REVISION,
    isOpen: true,
    latestSnippet: profile.searchableText,
    modelId: SEARCH_EMBEDDING_MODEL_ID,
    noteId,
    noteType: noteMetadata.type,
    pinned: false,
    searchableText: profile.searchableText,
    spaceId: null,
    title: profile.title,
    updatedAt: noteMetadata.updatedAt
  });
  const plaintext = serializePrivateRagIndexDocument(payload, {
    dimensions: SEARCH_EMBEDDING_DIMENSIONS,
    indexedRevision: INDEXED_REVISION,
    modelId: SEARCH_EMBEDDING_MODEL_ID,
    noteId
  });
  try {
    const envelope = await sealBytes(
      plaintext,
      {
        kind: "note_rag_index",
        recordVersion: INDEXED_REVISION,
        resourceId: indexId,
        tenantId: OWNER_ID
      },
      key,
      deterministicCrypto(index)
    );
    const ciphertextBytes = Buffer.from(envelope.payload.ciphertext, "base64url").byteLength;
    const record: SearchRagRecord = Object.freeze({
      cipher: Object.freeze({
        envelope,
        keyClass: "ai_assisted",
        keyId: objectKey.keyId,
        keyPurpose: "object_wrap",
        keyVersion: objectKey.keyVersion
      }),
      encryptedByteLength: ciphertextBytes,
      key: objectKey,
      metadata: noteMetadata,
      recordVersion: INDEXED_REVISION,
      resourceId: indexId
    });
    return Object.freeze({
      ciphertextBytes,
      indexId,
      indexedRevision: INDEXED_REVISION,
      noteId,
      record
    });
  } finally {
    plaintext.fill(0);
  }
}

async function buildFixture(): Promise<CapacityFixture> {
  const startedAt = performance.now();
  const keys = await Promise.all(
    OBJECT_KEYS.map(async (objectKey) => {
      const rawKey = new Uint8Array(32).fill(FIXED_KEY_BYTE);
      try {
        return await importKeyEncryptionKey(objectKey.keyId, rawKey);
      } finally {
        rawKey.fill(0);
      }
    })
  );
  const items = await Promise.all(
    Array.from({ length: NOTE_COUNT }, (_value, index) => {
      const keyIndex = index % DISTINCT_KEY_COUNT;
      const key = keys[keyIndex];
      const objectKey = OBJECT_KEYS[keyIndex];
      if (key === undefined || objectKey === undefined) throw new TypeError("fixture key missing");
      return encryptedItem(index, key, objectKey);
    })
  );
  const pages = Object.freeze(
    Array.from({ length: Math.ceil(items.length / PAGE_SIZE) }, (_value, pageIndex) => {
      const pageItems = Object.freeze(
        items.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)
      );
      const nextPage = pageIndex + 1;
      return Object.freeze({
        coverage: COVERAGE,
        items: pageItems,
        nextCursor: nextPage * PAGE_SIZE < items.length ? `page:${nextPage}` : null,
        snapshot: SNAPSHOT
      });
    })
  );
  return Object.freeze({
    fixturePreparationMs: performance.now() - startedAt,
    noteIdsByIndex: Object.freeze(items.map(({ noteId }) => noteId)),
    pages
  });
}

function invocation(query: string): EncryptedUserSearchInvocation {
  return Object.freeze({
    claimSecret: "A".repeat(43),
    material: Object.freeze({
      requestVersion: "encrypted-user-search-request-v1",
      hybridRankingVersion: "encrypted-hybrid-rank-v1",
      continuation: null,
      filters: FILTERS,
      maxResults: TOP_K,
      pageLimit: 30,
      query
    }),
    requestDigest: REQUEST_DIGEST,
    searchId: SEARCH_ID
  });
}

function pageIndex(cursor: string | null): number {
  if (cursor === null) return 0;
  if (!/^page:\d+$/u.test(cursor)) throw new TypeError("invalid fixture cursor");
  return Number(cursor.slice("page:".length));
}

function repository(firstPage?: PrivateRagPage<SearchRagRecord>): RepositoryFixture {
  const claim = vi.fn<EncryptedUserSearchRepository["claim"]>(() => Promise.resolve(CLAIM));
  const page = vi.fn<EncryptedUserSearchRepository["page"]>((input) => {
    const index = pageIndex(input.cursor);
    const current = index === 0 && firstPage !== undefined ? firstPage : fixture.pages[index];
    if (current === undefined) return Promise.reject(new Error("fixture page missing"));
    return Promise.resolve(Object.freeze({ status: "page" as const, page: current }));
  });
  const verify = vi.fn<EncryptedUserSearchRepository["verify"]>((input) =>
    Promise.resolve({
      candidateDigest: CANDIDATE_DIGEST,
      verifiedCandidateCount: input.candidates.length
    })
  );
  const complete = vi.fn<EncryptedUserSearchRepository["complete"]>(() => Promise.resolve());
  const fail = vi.fn<EncryptedUserSearchRepository["fail"]>(() => Promise.resolve());
  return Object.freeze({
    claim,
    complete,
    fail,
    page,
    port: Object.freeze({ claim, complete, fail, page, verify }),
    verify
  });
}

function provider(issued: Float32Array[]): SearchEmbeddingProvider {
  return Object.freeze({
    embed(input) {
      const relevanceCase = RELEVANCE_CASES.find(({ query }) => query === input.text);
      if (input.signal.aborted || relevanceCase === undefined) {
        return Promise.reject(new Error("invalid capacity query"));
      }
      const embedding = new Float32Array(SEARCH_EMBEDDING_DIMENSIONS);
      embedding[relevanceCase.queryAxis] = 1;
      issued.push(embedding);
      return Promise.resolve(embedding);
    }
  });
}

async function executeSearch(queryText: string): Promise<SearchRun> {
  const repositoryFixture = repository();
  const issued: Float32Array[] = [];
  const query = createEncryptedUserSearchQuery({
    embeddingProvider: provider(issued),
    repository: repositoryFixture.port
  });
  const unwrapsBefore = unwrapCalls;
  const startedAt = performance.now();
  const result = await query.query({
    authority: AUTHORITY,
    invocation: invocation(queryText),
    signal: new AbortController().signal
  });
  const durationMs = performance.now() - startedAt;
  const unwrappedKeys = unwrapCalls - unwrapsBefore;

  expect(result.scannedNoteCount).toBe(NOTE_COUNT);
  expect(result.items).toHaveLength(TOP_K);
  expect(
    result.items.every(
      (item) => Object.keys(item).sort().join(",") === "indexedRevision,noteId,score"
    )
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain(queryText);
  expect(unwrappedKeys).toBe(DISTINCT_KEY_COUNT);
  expect(issued).toHaveLength(1);
  expect(issued[0]?.every((component) => component === 0)).toBe(true);
  expect(repositoryFixture.claim).toHaveBeenCalledOnce();
  expect(repositoryFixture.page).toHaveBeenCalledTimes(Math.ceil(NOTE_COUNT / PAGE_SIZE) + 1);
  expect(repositoryFixture.verify).toHaveBeenCalledOnce();
  expect(repositoryFixture.verify.mock.calls[0]?.[0].candidates).toHaveLength(TOP_K);
  expect(repositoryFixture.complete).toHaveBeenCalledOnce();
  expect(repositoryFixture.fail).not.toHaveBeenCalled();
  return Object.freeze({ durationMs, result, unwrappedKeys });
}

async function expectUnavailable(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "provider_unavailable", status: 503 });
}

function percentile(samples: readonly number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index] ?? Number.POSITIVE_INFINITY;
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function mebibytes(value: number): number {
  return rounded(value / (1024 * 1024));
}

function summary(samples: readonly Sample[]) {
  const durations = samples.map(({ durationMs }) => durationMs);
  return Object.freeze({
    maxMs: rounded(Math.max(...durations)),
    unwrappedKeys: Object.freeze(samples.map(({ unwrappedKeys }) => unwrappedKeys)),
    p50Ms: rounded(percentile(durations, 0.5)),
    p95Ms: rounded(percentile(durations, 0.95)),
    samplesMs: Object.freeze(durations.map(rounded))
  });
}

function changedFirstPage(
  update: (page: PrivateRagPage<SearchRagRecord>) => PrivateRagPage<SearchRagRecord>
): PrivateRagPage<SearchRagRecord> {
  const first = fixture.pages[0];
  if (first === undefined) throw new TypeError("capacity fixture is empty");
  return update(first);
}

beforeAll(async () => {
  fixture = await buildFixture();
  keyManagementMocks.custodianForSearchAuthority.mockReturnValue(fixtureCustodian());
}, TEST_TIMEOUT_MS);

describe("isolated search 1,000-note encrypted exact-scan capacity", () => {
  it(
    "meets the credential-free latency and deterministic relevance gate",
    async () => {
      const capacityCase = RELEVANCE_CASES[0];
      if (capacityCase === undefined) throw new TypeError("relevance fixture missing");
      const samples: Sample[] = [];
      const baselineMemory = process.memoryUsage();
      let peakHeap = baselineMemory.heapUsed;
      let peakRss = baselineMemory.rss;
      const sampleMemory = (): void => {
        const current = process.memoryUsage();
        peakHeap = Math.max(peakHeap, current.heapUsed);
        peakRss = Math.max(peakRss, current.rss);
      };
      const memoryTimer = setInterval(sampleMemory, 25);
      let recallHits = 0;
      let reciprocalRank = 0;
      let topOneHits = 0;
      let stableTieCases = 0;
      let baselineItems: EncryptedUserSearchResult["items"];
      try {
        const warmup = await executeSearch(capacityCase.query);
        baselineItems = warmup.result.items;
        for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
          const sample = await executeSearch(capacityCase.query);
          expect(sample.result.items).toEqual(baselineItems);
          samples.push(
            Object.freeze({
              durationMs: sample.durationMs,
              unwrappedKeys: sample.unwrappedKeys
            })
          );
          sampleMemory();
        }

        for (const relevanceCase of RELEVANCE_CASES) {
          const expectedNoteId = fixture.noteIdsByIndex[relevanceCase.targetIndex];
          if (expectedNoteId === undefined) throw new TypeError("relevance target missing");
          const result = await executeSearch(relevanceCase.query);
          const rank = result.result.items.findIndex(({ noteId }) => noteId === expectedNoteId);
          if (rank >= 0) {
            recallHits += 1;
            reciprocalRank += 1 / (rank + 1);
          }
          if (rank === 0) topOneHits += 1;
          if (relevanceCase.category === "stable_tie") {
            const partnerNoteId =
              relevanceCase.tiePartnerIndex === null
                ? undefined
                : fixture.noteIdsByIndex[relevanceCase.tiePartnerIndex];
            if (partnerNoteId === undefined) throw new TypeError("tie partner missing");
            expect(result.result.items.slice(0, 2).map(({ noteId }) => noteId)).toEqual([
              expectedNoteId,
              partnerNoteId
            ]);
            const repeated = await executeSearch(relevanceCase.query);
            expect(repeated.result.items).toEqual(result.result.items);
            stableTieCases += 1;
          }
          sampleMemory();
        }
      } finally {
        clearInterval(memoryTimer);
        sampleMemory();
      }

      const latency = summary(samples);
      const relevance = Object.freeze({
        caseCount: RELEVANCE_CASES.length,
        categories: Object.freeze(
          RELEVANCE_CASES.reduce<Record<RelevanceCategory, number>>(
            (counts, relevanceCase) => ({
              ...counts,
              [relevanceCase.category]: counts[relevanceCase.category] + 1
            }),
            {
              exact_title: 0,
              misspelling: 0,
              mixed_signal: 0,
              semantic_paraphrase: 0,
              stable_tie: 0
            }
          )
        ),
        mrrAt8: rounded(reciprocalRank / RELEVANCE_CASES.length),
        recallAt8: rounded(recallHits / RELEVANCE_CASES.length),
        stableTieCases,
        topOneRate: rounded(topOneHits / RELEVANCE_CASES.length)
      });
      const memory = Object.freeze({
        addedHeapMiB: mebibytes(Math.max(0, peakHeap - baselineMemory.heapUsed)),
        addedRssMiB: mebibytes(Math.max(0, peakRss - baselineMemory.rss)),
        thresholdAddedHeapMiB: MAX_ADDED_HEAP_MIB,
        thresholdAddedRssMiB: MAX_ADDED_RSS_MIB
      });
      console.info(
        JSON.stringify(
          {
            gate: "isolated-search-encrypted-exact-scan",
            corpusVersion: CORPUS_VERSION,
            scope:
              "credential-free local strict projection, AES decrypt/decode, rank, revalidate, and digest",
            noteCount: NOTE_COUNT,
            dimensions: SEARCH_EMBEDDING_DIMENSIONS,
            distinctKeyCount: DISTINCT_KEY_COUNT,
            topK: TOP_K,
            sampleCount: SAMPLE_COUNT,
            fixturePreparationMs: rounded(fixture.fixturePreparationMs),
            provider: "excluded; deterministic precomputed query vector",
            networkAndCloud:
              "excluded; no OpenAI, PostgreSQL network, STS/KMS network, HTTP, Trusted Sources, or Vercel cold start",
            relevance,
            memory,
            latency: { thresholdP95Ms: P95_LIMIT_MS, ...latency }
          },
          null,
          2
        )
      );

      expect(latency.unwrappedKeys).toEqual(Array(SAMPLE_COUNT).fill(DISTINCT_KEY_COUNT));
      expect(latency.p95Ms).toBeLessThan(P95_LIMIT_MS);
      expect(relevance.recallAt8).toBeGreaterThanOrEqual(0.98);
      expect(relevance.mrrAt8).toBeGreaterThanOrEqual(0.9);
      expect(relevance.topOneRate).toBeGreaterThanOrEqual(0.9);
      expect(relevance.stableTieCases).toBe(5);
      expect(memory.addedHeapMiB).toBeLessThan(MAX_ADDED_HEAP_MIB);
      expect(memory.addedRssMiB).toBeLessThan(MAX_ADDED_RSS_MIB);
    },
    TEST_TIMEOUT_MS
  );

  it.each([
    [
      "stale generation",
      () =>
        changedFirstPage((page) =>
          Object.freeze({
            ...page,
            snapshot: Object.freeze({ ...page.snapshot, revisionToken: "13" })
          })
        )
    ],
    [
      "incomplete generation",
      () =>
        changedFirstPage((page) =>
          Object.freeze({
            ...page,
            coverage: Object.freeze({
              missingOrStaleCount: 1,
              repairCandidates: Object.freeze([
                Object.freeze({
                  currentRevision: INDEXED_REVISION + 1,
                  noteId: fixture.noteIdsByIndex[0] ?? ""
                })
              ]),
              repairOverflow: false,
              status: "incomplete" as const
            })
          })
        )
    ]
  ])("fails a %s closed before verification or completion", async (_name, firstPage) => {
    const repositoryFixture = repository(firstPage());
    const issued: Float32Array[] = [];
    const query = createEncryptedUserSearchQuery({
      embeddingProvider: provider(issued),
      repository: repositoryFixture.port
    });
    const opensBefore = unwrapCalls;
    const capacityCase = RELEVANCE_CASES[0];
    if (capacityCase === undefined) throw new TypeError("relevance fixture missing");

    await expectUnavailable(
      query.query({
        authority: AUTHORITY,
        invocation: invocation(capacityCase.query),
        signal: new AbortController().signal
      })
    );

    expect(unwrapCalls - opensBefore).toBe(0);
    expect(repositoryFixture.verify).not.toHaveBeenCalled();
    expect(repositoryFixture.complete).not.toHaveBeenCalled();
    expect(repositoryFixture.fail).toHaveBeenCalledOnce();
  });
});
