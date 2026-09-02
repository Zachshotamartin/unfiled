import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { RAG_GENERATION_VERIFICATION_NOTE_CAPACITY } from "@unfiled/contracts";
import { importKeyEncryptionKey, sealBytes, type KeyEncryptionKey } from "@unfiled/content-crypto";
import {
  MAX_FLOAT32_EMBEDDING_DIMENSIONS,
  MAX_PRIVATE_RAG_HEADING_CHARACTERS,
  MAX_PRIVATE_RAG_HEADINGS,
  MAX_PRIVATE_RAG_NORMALIZED_TEXT_BYTES,
  MAX_PRIVATE_RAG_PAYLOAD_BYTES,
  MAX_PRIVATE_RAG_SNIPPET_CHARACTERS,
  MAX_PRIVATE_RAG_TITLE_CHARACTERS,
  buildPrivateRagIndexDocument,
  serializePrivateRagIndexDocument
} from "@unfiled/search";

import {
  createGenerationVerificationRepository,
  type VerifierDatabaseQuery,
  type VerifierDatabaseQueryExecutor
} from "../src/database";
import {
  RAG_VERIFICATION_MAX_PAGES,
  RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET,
  RAG_VERIFICATION_PAGE_LIMIT
} from "../src/capacity";
import { verifierCapacityProcessingBudgetMs } from "../src/config";
import { createGenerationVerifier } from "../src/verifier";
import {
  ATTESTATION_DIGEST,
  GENERATION_ID,
  KEY_ID,
  OWNER_ID,
  ROOT_ARN,
  keyRecord
} from "./fixtures";

const DATABASE_MAX_INDEX_CIPHERTEXT_BYTES = 262_160;
const DATABASE_WORST_CASE_ROWS_PER_PAGE = Math.floor(
  RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET / DATABASE_MAX_INDEX_CIPHERTEXT_BYTES
);
const MAX_VALID_INDEX_CIPHERTEXT_BYTES = MAX_PRIVATE_RAG_PAYLOAD_BYTES + 16;
const MAX_VALID_ROWS_PER_PAGE = Math.floor(
  RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET / MAX_VALID_INDEX_CIPHERTEXT_BYTES
);
const REQUIRED_PAGE_COUNT = Math.ceil(
  RAG_GENERATION_VERIFICATION_NOTE_CAPACITY / MAX_VALID_ROWS_PER_PAGE
);
const FULL_PAGE_COUNT = REQUIRED_PAGE_COUNT - 1;
const TERMINAL_PAGE_ROWS =
  RAG_GENERATION_VERIFICATION_NOTE_CAPACITY - FULL_PAGE_COUNT * MAX_VALID_ROWS_PER_PAGE;
const MAX_ADDED_HEAP_BYTES = 512 * 1_024 * 1_024;
const MAX_ADDED_RSS_BYTES = 768 * 1_024 * 1_024;
const DECRYPT_CONCURRENCY = 8;
const MAX_GATE_DURATION_MS = verifierCapacityProcessingBudgetMs(DECRYPT_CONCURRENCY);
const TEST_TIMEOUT_MS = 150_000;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MODEL_ID = "m".repeat(200);
const INDEXED_REVISION = 1;
const MAX_TITLE = "T".repeat(MAX_PRIVATE_RAG_TITLE_CHARACTERS);
const MAX_HEADINGS = Object.freeze(
  Array.from({ length: MAX_PRIVATE_RAG_HEADINGS }, () =>
    "H".repeat(MAX_PRIVATE_RAG_HEADING_CHARACTERS)
  )
);
const MAX_SNIPPET = "S".repeat(MAX_PRIVATE_RAG_SNIPPET_CHARACTERS);
const MAX_SEARCHABLE_TEXT_CHARACTERS = MAX_PRIVATE_RAG_NORMALIZED_TEXT_BYTES - MAX_TITLE.length - 1;
// JSON-escaped but normalization-stable characters fill the remaining canonical payload budget.
const PAYLOAD_JSON_ESCAPE_CHARACTERS = 9_917;
const MAX_SEARCHABLE_TEXT = `${"\\".repeat(PAYLOAD_JSON_ESCAPE_CHARACTERS)}${"x".repeat(
  MAX_SEARCHABLE_TEXT_CHARACTERS - PAYLOAD_JSON_ESCAPE_CHARACTERS
)}`;
const MAX_EMBEDDING = new Float32Array(MAX_FLOAT32_EMBEDDING_DIMENSIONS).fill(0.25);
const ATTESTATION = Object.freeze({
  domain: "unfiled.rag-generation-verification.v1" as const,
  attestationDigest: createHash("sha256")
    .update(
      JSON.stringify([
        OWNER_ID,
        GENERATION_ID,
        "4",
        RAG_GENERATION_VERIFICATION_NOTE_CAPACITY,
        ATTESTATION_DIGEST
      ])
    )
    .digest("hex")
});

type MemorySample = Readonly<{ heapUsed: number; rss: number }>;

interface GateMetrics {
  fixturePreparationMs: number;
  identityQueries: number;
  keyRequests: number;
  listQueries: number;
  maxCiphertextBytes: number;
  maxHeapUsed: number;
  maxPageItems: number;
  maxPageJsonBytes: number;
  maxPlaintextBytes: number;
  maxRss: number;
  terminalAttestationAfterAllOpens: boolean;
  totalPageJsonBytes: number;
  verifyQueries: number;
}

function memorySample(): MemorySample {
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss };
}

function recordMemory(metrics: GateMetrics): void {
  const usage = memorySample();
  metrics.maxHeapUsed = Math.max(metrics.maxHeapUsed, usage.heapUsed);
  metrics.maxRss = Math.max(metrics.maxRss, usage.rss);
}

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

async function fixedKey(): Promise<KeyEncryptionKey> {
  const raw = new Uint8Array(32).fill(0x5a);
  try {
    return await importKeyEncryptionKey(KEY_ID, raw);
  } finally {
    raw.fill(0);
  }
}

async function encryptedItem(
  itemNumber: number,
  key: KeyEncryptionKey,
  metrics: GateMetrics
): Promise<Readonly<Record<string, unknown>>> {
  const suffix = suffixFor(itemNumber);
  const indexId = `irw_${suffix}`;
  const noteId = `note_${suffix}`;
  const document = buildPrivateRagIndexDocument({
    noteId,
    indexedRevision: INDEXED_REVISION,
    noteType: "generic",
    spaceId: null,
    title: MAX_TITLE,
    headings: MAX_HEADINGS,
    latestSnippet: MAX_SNIPPET,
    isOpen: true,
    pinned: false,
    updatedAt: "2026-08-30T12:00:00.000Z",
    searchableText: MAX_SEARCHABLE_TEXT,
    modelId: MODEL_ID,
    embedding: MAX_EMBEDDING
  });
  const plaintext = serializePrivateRagIndexDocument(document, {
    noteId,
    indexedRevision: INDEXED_REVISION,
    modelId: MODEL_ID,
    dimensions: MAX_FLOAT32_EMBEDDING_DIMENSIONS
  });
  metrics.maxPlaintextBytes = Math.max(metrics.maxPlaintextBytes, plaintext.byteLength);
  try {
    const envelope = await sealBytes(
      plaintext,
      {
        tenantId: OWNER_ID,
        resourceId: indexId,
        recordVersion: INDEXED_REVISION,
        kind: "note_rag_index"
      },
      key,
      deterministicCrypto(itemNumber)
    );
    const encryptedByteLength = Buffer.from(envelope.payload.ciphertext, "base64url").byteLength;
    metrics.maxCiphertextBytes = Math.max(metrics.maxCiphertextBytes, encryptedByteLength);
    return Object.freeze({
      indexId,
      noteId,
      indexedRevision: INDEXED_REVISION,
      cipher: Object.freeze({
        envelope,
        keyId: KEY_ID,
        keyClass: "ai_assisted",
        keyPurpose: "object_wrap",
        keyVersion: 1
      }),
      encryptedByteLength
    });
  } finally {
    plaintext.fill(0);
  }
}

function rowsForPage(pageIndex: number): number {
  return pageIndex < FULL_PAGE_COUNT ? MAX_VALID_ROWS_PER_PAGE : TERMINAL_PAGE_ROWS;
}

async function jsonPage(
  pageIndex: number,
  key: KeyEncryptionKey,
  metrics: GateMetrics
): Promise<unknown> {
  const rowCount = rowsForPage(pageIndex);
  const firstItemNumber = pageIndex * MAX_VALID_ROWS_PER_PAGE;
  const fixtureStartedAt = performance.now();
  const items = await Promise.all(
    Array.from({ length: rowCount }, (_value, offset) =>
      encryptedItem(firstItemNumber + offset, key, metrics)
    )
  );
  metrics.fixturePreparationMs += performance.now() - fixtureStartedAt;
  const lastIndexId = items.at(-1)?.indexId;
  if (typeof lastIndexId !== "string") throw new Error("capacity page unexpectedly empty");
  const hasMore = pageIndex < REQUIRED_PAGE_COUNT - 1;
  const result = {
    ownerId: OWNER_ID,
    generation: {
      generationId: GENERATION_ID,
      state: "building",
      embeddingModelId: MODEL_ID,
      embeddingDimensions: MAX_FLOAT32_EMBEDDING_DIMENSIONS,
      envelopeSchemaVersion: 1,
      expectedNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY,
      indexedNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY,
      revisionToken: "4"
    },
    items,
    keys: [keyRecord()],
    page: {
      limit: RAG_VERIFICATION_PAGE_LIMIT,
      ciphertextByteBudget: RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET,
      returnedCount: items.length,
      ciphertextBytes: items.reduce((total, item) => total + Number(item.encryptedByteLength), 0),
      hasMore,
      nextCursor: hasMore
        ? {
            generationId: GENERATION_ID,
            revisionToken: "4",
            afterIndexId: lastIndexId
          }
        : null
    },
    verification: hasMore ? null : ATTESTATION
  };

  const serialized = JSON.stringify(result);
  const serializedBytes = Buffer.byteLength(serialized);
  metrics.maxPageItems = Math.max(metrics.maxPageItems, items.length);
  metrics.maxPageJsonBytes = Math.max(metrics.maxPageJsonBytes, serializedBytes);
  metrics.totalPageJsonBytes += serializedBytes;
  recordMemory(metrics);
  const parsed = JSON.parse(serialized) as unknown;
  recordMemory(metrics);
  return parsed;
}

function queryKind(query: VerifierDatabaseQuery): "identity" | "list" | "verify" {
  if (query.text.startsWith("select session_user")) return "identity";
  if (query.text.includes("public.list_building_note_rag_index")) return "list";
  if (query.text.includes("public.verify_rag_index_generation")) return "verify";
  throw new Error("unexpected verifier query");
}

describe("production verifier capacity gate", () => {
  it(
    "strictly verifies 1,000 exact maximum-valid objects within the 33-page bound",
    async () => {
      expect(DATABASE_WORST_CASE_ROWS_PER_PAGE).toBe(31);
      expect(MAX_VALID_INDEX_CIPHERTEXT_BYTES).toBe(245_776);
      expect(MAX_VALID_ROWS_PER_PAGE).toBe(34);
      expect(REQUIRED_PAGE_COUNT).toBe(30);
      expect(FULL_PAGE_COUNT).toBe(29);
      expect(TERMINAL_PAGE_ROWS).toBe(14);
      expect(RAG_VERIFICATION_MAX_PAGES * DATABASE_WORST_CASE_ROWS_PER_PAGE).toBeGreaterThanOrEqual(
        RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
      );
      expect(REQUIRED_PAGE_COUNT).toBeLessThanOrEqual(RAG_VERIFICATION_MAX_PAGES);

      const startMemory = memorySample();
      const metrics: GateMetrics = {
        fixturePreparationMs: 0,
        identityQueries: 0,
        keyRequests: 0,
        listQueries: 0,
        maxCiphertextBytes: 0,
        maxHeapUsed: startMemory.heapUsed,
        maxPageItems: 0,
        maxPageJsonBytes: 0,
        maxPlaintextBytes: 0,
        maxRss: startMemory.rss,
        terminalAttestationAfterAllOpens: false,
        totalPageJsonBytes: 0,
        verifyQueries: 0
      };
      const key = await fixedKey();
      let expectedCursor: unknown = null;
      const executor: VerifierDatabaseQueryExecutor = {
        async query(query) {
          recordMemory(metrics);
          switch (queryKind(query)) {
            case "identity":
              metrics.identityQueries += 1;
              return {
                rows: [
                  {
                    sessionUser: "unfiled_rag_verifier",
                    currentUser: "unfiled_rag_verifier"
                  }
                ]
              };
            case "list": {
              const pageIndex = metrics.listQueries;
              expect(query.values).toEqual([
                OWNER_ID,
                GENERATION_ID,
                "4",
                expectedCursor,
                RAG_VERIFICATION_PAGE_LIMIT,
                RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET
              ]);
              const result = await jsonPage(pageIndex, key, metrics);
              metrics.listQueries += 1;
              expectedCursor =
                pageIndex < REQUIRED_PAGE_COUNT - 1
                  ? {
                      generationId: GENERATION_ID,
                      revisionToken: "4",
                      afterIndexId: `irw_${suffixFor(
                        (pageIndex + 1) * MAX_VALID_ROWS_PER_PAGE - 1
                      )}`
                    }
                  : null;
              return { rows: [{ result }] };
            }
            case "verify": {
              metrics.verifyQueries += 1;
              metrics.terminalAttestationAfterAllOpens =
                metrics.keyRequests === RAG_GENERATION_VERIFICATION_NOTE_CAPACITY;
              expect(query.values).toEqual([OWNER_ID, GENERATION_ID, "4", ATTESTATION]);
              const result = JSON.parse(
                JSON.stringify({
                  generationId: GENERATION_ID,
                  revisionToken: "4",
                  verifiedNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY,
                  attestationDomain: "unfiled.rag-generation-attestation.v1",
                  attestationDigest: ATTESTATION.attestationDigest,
                  embeddingModelId: MODEL_ID,
                  embeddingDimensions: MAX_FLOAT32_EMBEDDING_DIMENSIONS,
                  envelopeSchemaVersion: 1,
                  verified: true
                })
              ) as unknown;
              return { rows: [{ result }] };
            }
          }
        }
      };
      const repository = createGenerationVerificationRepository(executor);
      const verifier = createGenerationVerifier({
        decryptConcurrency: DECRYPT_CONCURRENCY,
        repository
      });
      const startedAt = performance.now();
      const sampler = setInterval(() => recordMemory(metrics), 25);
      sampler.unref();
      let result;
      try {
        result = await verifier.verify(
          { ownerId: OWNER_ID, generationId: GENERATION_ID, revisionToken: "4" },
          {
            keyFor(record) {
              metrics.keyRequests += 1;
              if (
                record.ownerId !== OWNER_ID ||
                record.keyId !== KEY_ID ||
                record.schemaVersion !== 1 ||
                record.rootKeyArn !== ROOT_ARN
              ) {
                throw new Error("unexpected capacity-gate key record");
              }
              return Promise.resolve(key);
            }
          },
          new AbortController().signal
        );
      } finally {
        clearInterval(sampler);
        recordMemory(metrics);
      }
      const durationMs = performance.now() - startedAt - metrics.fixturePreparationMs;

      expect(result).toEqual({
        generationId: GENERATION_ID,
        revisionToken: "4",
        verified: true,
        verifiedNoteCount: RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
      });
      expect(metrics.listQueries).toBe(REQUIRED_PAGE_COUNT);
      expect(metrics.identityQueries).toBe(1);
      expect(metrics.verifyQueries).toBe(1);
      expect(metrics.keyRequests).toBe(RAG_GENERATION_VERIFICATION_NOTE_CAPACITY);
      expect(metrics.maxPageItems).toBe(MAX_VALID_ROWS_PER_PAGE);
      expect(metrics.maxPlaintextBytes).toBe(MAX_PRIVATE_RAG_PAYLOAD_BYTES);
      expect(metrics.maxCiphertextBytes).toBe(MAX_VALID_INDEX_CIPHERTEXT_BYTES);
      expect(metrics.maxPageJsonBytes).toBeGreaterThan(
        RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET
      );
      expect(metrics.totalPageJsonBytes).toBeGreaterThan(300 * 1_024 * 1_024);
      expect(metrics.terminalAttestationAfterAllOpens).toBe(true);
      expect(durationMs).toBeLessThan(MAX_GATE_DURATION_MS);
      expect(metrics.maxHeapUsed - startMemory.heapUsed).toBeLessThan(MAX_ADDED_HEAP_BYTES);
      expect(metrics.maxRss - startMemory.rss).toBeLessThan(MAX_ADDED_RSS_BYTES);
    },
    TEST_TIMEOUT_MS
  );
});
