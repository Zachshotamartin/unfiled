import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { importKeyEncryptionKey, sealBytes } from "@unfiled/content-crypto";
import type { OrganizerRagRecord } from "../src/drain.js";
import type * as OrganizerKeyManagementModule from "../src/key-management.js";
import { createOrganizerRagPayloadOpener } from "../src/rag-crypto.js";
import {
  createPrivateRagRetriever,
  buildPrivateRagPayloadValue,
  serializePrivateRagIndexDocument,
  type PrivateRagGenerationSnapshot,
  type PrivateRagPage,
  type PrivateRagPageItem
} from "@unfiled/search";
import {
  parseManagedKeyRecord,
  type IntermediateKeyCustodian,
  type ManagedKeyRecordV1
} from "@unfiled/key-management";
import { beforeAll, describe, expect, it, vi } from "vitest";

const keyManagementMocks = vi.hoisted(() => ({
  custodianForOrganizerAuthority: vi.fn()
}));

vi.mock("../src/key-management.js", async (importOriginal) => {
  const original = await importOriginal<typeof OrganizerKeyManagementModule>();
  return {
    ...original,
    custodianForOrganizerAuthority: keyManagementMocks.custodianForOrganizerAuthority,
    managedKeyRecordParserForOrganizerAuthority: () =>
      original.managedKeyRecordParserForOrganizerBoundary({
        kind: "local-synthetic",
        keyClass: "ai_assisted"
      })
  };
});

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const GENERATION_ID = "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const MODEL_ID = "text-embedding-3-small";
const NOTE_COUNT = 1_000;
const DIMENSIONS = 1_536;
const PAGE_SIZE = 50;
const INDEXED_REVISION = 1;
const COLD_SAMPLE_COUNT = 5;
const WARM_SAMPLE_COUNT = 20;
const COLD_P95_LIMIT_MS = 2_000;
const WARM_P95_LIMIT_MS = 250;
const FIXED_KEY_BYTE = 0x5a;
const TEST_TIMEOUT_MS = 120_000;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const AUTHORITY = Object.freeze({}) as OrganizerKeyManagementModule.OrganizerKeyAuthority;
const SNAPSHOT: PrivateRagGenerationSnapshot = Object.freeze({
  dimensions: DIMENSIONS,
  expectedNoteCount: NOTE_COUNT,
  generationId: GENERATION_ID,
  indexedNoteCount: NOTE_COUNT,
  modelId: MODEL_ID,
  revisionToken: "1"
});
const COVERAGE = Object.freeze({
  missingOrStaleCount: 0,
  repairCandidates: Object.freeze([]),
  repairOverflow: false,
  status: "complete" as const
});
const QUERY_TEXT = "shopping groceries milk";
const QUERY_EMBEDDING = (() => {
  const embedding = new Float32Array(DIMENSIONS);
  embedding[0] = 1;
  return embedding;
})();
const OBJECT_KEY: ManagedKeyRecordV1 = parseManagedKeyRecord({
  activatedAt: "2026-08-30T12:00:00.000Z",
  createdAt: "2026-08-30T12:00:00.000Z",
  encryptedKeyMaterial: "AQIDBA",
  keyClass: "ai_assisted",
  keyId: "key.ai.object_wrap.capacity.v1",
  keyVersion: 1,
  ownerId: OWNER_ID,
  purpose: "object_wrap",
  retiredAt: null,
  revokedAt: null,
  rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
  rotation: {
    lastRootRewrappedAt: null,
    predecessorKeyId: null,
    previousRootKeyArn: null,
    rootRewrapCount: 0
  },
  schemaVersion: 1,
  status: "active",
  wrapOperationLimit: 16_777_216,
  wrapOperations: 0
});

type CapacityFixture = Readonly<{
  fixturePreparationMs: number;
  pages: readonly PrivateRagPage<OrganizerRagRecord>[];
  targetNoteId: string;
}>;

type Sample = Readonly<{
  durationMs: number;
  openedPayloads: number;
}>;

let fixture: CapacityFixture;

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

function fixtureCustodian(): IntermediateKeyCustodian {
  return Object.freeze({
    withGeneratedIntermediateKey() {
      return Promise.reject(new Error("capacity fixture never generates an intermediate key"));
    },
    async withUnwrappedIntermediateKey(recordValue, use, options) {
      if (options?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      const record = parseManagedKeyRecord(recordValue);
      const bytes = new Uint8Array(32).fill(FIXED_KEY_BYTE);
      try {
        return await use(bytes, record);
      } finally {
        bytes.fill(0);
      }
    }
  });
}

function embeddingFor(index: number): Float32Array {
  const embedding = new Float32Array(DIMENSIONS);
  embedding[index === 0 ? 0 : 1] = 1;
  return embedding;
}

async function encryptedItem(
  index: number,
  key: Awaited<ReturnType<typeof importKeyEncryptionKey>>
): Promise<PrivateRagPageItem<OrganizerRagRecord>> {
  const suffix = suffixFor(index);
  const noteId = `note_${suffix}`;
  const indexId = `irw_${suffix}`;
  const payload = buildPrivateRagPayloadValue({
    embedding: embeddingFor(index),
    headings: index === 0 ? ["Open items"] : ["Archive"],
    indexedRevision: INDEXED_REVISION,
    isOpen: true,
    latestSnippet: index === 0 ? "milk" : `reference ${index}`,
    modelId: MODEL_ID,
    noteId,
    noteType: index === 0 ? "list" : "generic",
    pinned: false,
    searchableText: index === 0 ? QUERY_TEXT : `archive reference topic ${index}`,
    spaceId: null,
    title: index === 0 ? "Shopping" : `Reference ${index}`,
    updatedAt: "2026-08-31T12:00:00.000Z"
  });
  const plaintext = serializePrivateRagIndexDocument(payload, {
    dimensions: DIMENSIONS,
    indexedRevision: INDEXED_REVISION,
    modelId: MODEL_ID,
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
    const record: OrganizerRagRecord = Object.freeze({
      cipher: Object.freeze({
        envelope,
        keyClass: "ai_assisted",
        keyId: OBJECT_KEY.keyId,
        keyPurpose: "object_wrap",
        keyVersion: OBJECT_KEY.keyVersion
      }),
      key: OBJECT_KEY,
      recordVersion: INDEXED_REVISION,
      resourceId: indexId
    });
    return Object.freeze({
      ciphertextBytes: Buffer.from(envelope.payload.ciphertext, "base64url").byteLength,
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
  const rawKey = new Uint8Array(32).fill(FIXED_KEY_BYTE);
  let key: Awaited<ReturnType<typeof importKeyEncryptionKey>>;
  try {
    key = await importKeyEncryptionKey(OBJECT_KEY.keyId, rawKey);
  } finally {
    rawKey.fill(0);
  }
  const items = await Promise.all(
    Array.from({ length: NOTE_COUNT }, (_value, index) => encryptedItem(index, key))
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
    pages,
    targetNoteId: items[0]?.noteId ?? ""
  });
}

function percentile(samples: readonly number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index] ?? Number.POSITIVE_INFINITY;
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function summary(samples: readonly Sample[]) {
  const durations = samples.map(({ durationMs }) => durationMs);
  return Object.freeze({
    maxMs: rounded(Math.max(...durations)),
    openedPayloads: Object.freeze(samples.map(({ openedPayloads }) => openedPayloads)),
    p50Ms: rounded(percentile(durations, 0.5)),
    p95Ms: rounded(percentile(durations, 0.95)),
    samplesMs: Object.freeze(durations.map(rounded))
  });
}

beforeAll(async () => {
  fixture = await buildFixture();
  keyManagementMocks.custodianForOrganizerAuthority.mockReturnValue(fixtureCustodian());
}, TEST_TIMEOUT_MS);

describe("organizer 1,000-note encrypted retrieval capacity", () => {
  it(
    "meets the exact cold and warm p95 gates through authenticated decrypt and private-RAG rank",
    async () => {
      let openPayloadCalls = 0;
      const productionOpener = createOrganizerRagPayloadOpener(AUTHORITY);
      const pages = {
        readPage(input: Readonly<{ cursor: string | null; ownerId: string }>) {
          if (input.ownerId !== OWNER_ID) throw new Error("owner mismatch");
          const pageIndex = input.cursor === null ? 0 : Number(input.cursor.replace("page:", ""));
          const page = fixture.pages[pageIndex];
          if (page === undefined) throw new Error("page cursor mismatch");
          return Promise.resolve(Object.freeze({ status: "page" as const, page }));
        },
        verifySnapshot(
          input: Readonly<{
            ownerId: string;
            snapshot: PrivateRagGenerationSnapshot;
          }>
        ) {
          return Promise.resolve(
            input.ownerId === OWNER_ID &&
              input.snapshot.generationId === SNAPSHOT.generationId &&
              input.snapshot.revisionToken === SNAPSHOT.revisionToken
          );
        }
      };
      const retriever = createPrivateRagRetriever<OrganizerRagRecord>({
        pages,
        payloads: {
          async openPayload(input) {
            openPayloadCalls += 1;
            return productionOpener.openPayload(input);
          }
        },
        topK: 8
      });

      async function sample(expectedCache: "hit" | "miss"): Promise<Sample> {
        const queryEmbedding = new Float32Array(QUERY_EMBEDDING);
        const opensBefore = openPayloadCalls;
        const startedAt = performance.now();
        const result = await retriever.retrieve({
          ownerId: OWNER_ID,
          query: { embedding: queryEmbedding, modelId: MODEL_ID, text: QUERY_TEXT }
        });
        const durationMs = performance.now() - startedAt;
        queryEmbedding.fill(0);
        expect(result.status).toBe("complete");
        if (result.status !== "complete") throw new Error(`retrieval failed: ${result.reason}`);
        expect(result.cache).toBe(expectedCache);
        expect(result.scannedNoteCount).toBe(NOTE_COUNT);
        expect(result.matches[0]?.noteId).toBe(fixture.targetNoteId);
        return Object.freeze({ durationMs, openedPayloads: openPayloadCalls - opensBefore });
      }

      const coldSamples: Sample[] = [];
      for (let index = 0; index < COLD_SAMPLE_COUNT; index += 1) {
        retriever.clearCache();
        coldSamples.push(await sample("miss"));
      }

      retriever.clearCache();
      const prime = await sample("miss");
      expect(prime.openedPayloads).toBe(NOTE_COUNT);
      const warmSamples: Sample[] = [];
      for (let index = 0; index < WARM_SAMPLE_COUNT; index += 1) {
        warmSamples.push(await sample("hit"));
      }

      const cold = summary(coldSamples);
      const warm = summary(warmSamples);
      console.info(
        JSON.stringify(
          {
            gate: "organizer-private-rag-exact-retrieval",
            noteCount: NOTE_COUNT,
            dimensions: DIMENSIONS,
            queryEmbeddingProvider: "excluded; precomputed vector exists before each timed sample",
            fixturePreparationMs: rounded(fixture.fixturePreparationMs),
            cold: { cache: "miss", thresholdP95Ms: COLD_P95_LIMIT_MS, ...cold },
            warm: { cache: "hit", thresholdP95Ms: WARM_P95_LIMIT_MS, ...warm }
          },
          null,
          2
        )
      );

      expect(cold.openedPayloads).toEqual(Array(COLD_SAMPLE_COUNT).fill(NOTE_COUNT));
      expect(warm.openedPayloads).toEqual(Array(WARM_SAMPLE_COUNT).fill(0));
      expect(cold.p95Ms).toBeLessThan(COLD_P95_LIMIT_MS);
      expect(warm.p95Ms).toBeLessThan(WARM_P95_LIMIT_MS);
      expect(retriever.cacheStats()).toMatchObject({ entries: 1 });
      retriever.clearCache();
    },
    TEST_TIMEOUT_MS
  );
});
