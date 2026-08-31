import { describe, expect, it, vi } from "vitest";

import {
  MAX_PRIVATE_RAG_CACHE_BYTE_BUDGET,
  MAX_PRIVATE_RAG_CONCURRENT_RETRIEVALS,
  MAX_PRIVATE_RAG_PAGE_BYTE_BUDGET,
  MAX_PRIVATE_RAG_PAGES,
  MAX_PRIVATE_RAG_SCAN_BYTE_BUDGET,
  buildPrivateRagPayloadValue,
  createPrivateRagRetriever,
  type PrivateRagCoverage,
  type PrivateRagGenerationSnapshot,
  type PrivateRagPage,
  type PrivateRagPagePort,
  type PrivateRagPageReadResult,
  type PrivateRagPayloadOpener,
  type PrivateRagPayloadValueV1,
  type PrivateRagRetrieverOptions
} from "../src/index.js";

type ReadPageInput = Parameters<PrivateRagPagePort<PrivateRagPayloadValueV1>["readPage"]>[0];
type OpenPayloadInput = Parameters<
  PrivateRagPayloadOpener<PrivateRagPayloadValueV1>["openPayload"]
>[0];

const OWNER_ID = "37b92af4-c390-4e14-bdc4-2c6573196c5b";
const MODEL_ID = "embed.v1";
const ID_BASE = "01J6M9Q7G4BMKB33GSG3NJ6D1";
const ID_CHARACTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function noteId(index: number): string {
  return `note_${ID_BASE}${ID_CHARACTERS[index]}`;
}

function indexId(index: number): string {
  return `irw_${ID_BASE}${ID_CHARACTERS[index]}`;
}

function document(index: number): PrivateRagPayloadValueV1 {
  return buildPrivateRagPayloadValue({
    noteId: noteId(index),
    indexedRevision: 1,
    noteType: index % 2 === 0 ? "project" : "generic",
    spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
    title: `Alpha ${index}`,
    headings: ["One", "Two", "Three", "Four"],
    latestSnippet: `alpha candidate ${index}`,
    isOpen: true,
    pinned: index === 9,
    updatedAt: "2026-08-31T12:00:00.000Z",
    searchableText: `alpha launch candidate ${index}`,
    modelId: MODEL_ID,
    embedding: [1, index / 20 + 0.01]
  });
}

function item(index: number, value = document(index), ciphertextBytes = 100) {
  return {
    indexId: indexId(index),
    noteId: noteId(index),
    indexedRevision: 1,
    ciphertextBytes,
    record: value
  } as const;
}

function snapshot(
  expectedNoteCount: number,
  revisionToken = "1",
  indexedNoteCount = expectedNoteCount
): PrivateRagGenerationSnapshot {
  return {
    generationId: "rig_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
    modelId: MODEL_ID,
    dimensions: 2,
    revisionToken,
    expectedNoteCount,
    indexedNoteCount
  };
}

function completeCoverage(): PrivateRagCoverage {
  return {
    status: "complete",
    missingOrStaleCount: 0,
    repairCandidates: [],
    repairOverflow: false
  };
}

function page(
  generation: PrivateRagGenerationSnapshot,
  items: readonly ReturnType<typeof item>[],
  nextCursor: string | null,
  coverage = completeCoverage()
): PrivateRagPage<PrivateRagPayloadValueV1> {
  return { snapshot: generation, coverage, items, nextCursor };
}

function plaintextBytes(value: PrivateRagPayloadValueV1): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function options(
  readPage: PrivateRagRetrieverOptions<PrivateRagPayloadValueV1>["pages"]["readPage"],
  overrides: Partial<PrivateRagRetrieverOptions<PrivateRagPayloadValueV1>> = {}
): PrivateRagRetrieverOptions<PrivateRagPayloadValueV1> {
  return {
    pages: {
      readPage,
      verifySnapshot: vi.fn(() => Promise.resolve(true))
    },
    payloads: {
      openPayload: vi.fn((input: OpenPayloadInput) =>
        Promise.resolve({
          value: input.item.record,
          plaintextBytes: plaintextBytes(input.item.record)
        })
      )
    },
    now: () => Date.parse("2026-08-31T12:00:00.000Z"),
    ...overrides
  };
}

const QUERY = { text: "alpha launch", modelId: MODEL_ID, embedding: [1, 0] } as const;

describe("private RAG exact retrieval", () => {
  it("pins every page, bounds decrypt concurrency, scans exactly, and keeps only eight", async () => {
    const generation = snapshot(10);
    const reads: Readonly<{ cursor: string | null; expected: unknown }>[] = [];
    const readPage = vi.fn(
      (input: ReadPageInput): Promise<PrivateRagPageReadResult<PrivateRagPayloadValueV1>> => {
        reads.push({ cursor: input.cursor, expected: input.expectedSnapshot });
        return Promise.resolve({
          status: "page",
          page:
            input.cursor === null
              ? page(
                  generation,
                  [0, 1, 2, 3, 4].map((index) => item(index)),
                  "cursor-1"
                )
              : page(
                  generation,
                  [5, 6, 7, 8, 9].map((index) => item(index)),
                  null
                )
        });
      }
    );
    let active = 0;
    let maximumActive = 0;
    const openPayload = vi.fn(async (input: OpenPayloadInput) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        value: input.item.record,
        plaintextBytes: plaintextBytes(input.item.record)
      };
    });
    const retriever = createPrivateRagRetriever(
      options(readPage, { payloads: { openPayload }, pageSize: 5, decryptConcurrency: 2 })
    );

    const result = await retriever.retrieve({ ownerId: OWNER_ID, query: QUERY });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.scannedNoteCount).toBe(10);
    expect(result.matches).toHaveLength(8);
    expect(result.matches[0]?.headings).toHaveLength(3);
    expect(result.matches[0]?.noteType).toBeTypeOf("string");
    expect(result.matches[0]?.spaceId).toBe("spc_01J6M9Q7G4BMKB33GSG3NJ6D1Z");
    expect(maximumActive).toBe(2);
    expect(reads[1]).toEqual({
      cursor: "cursor-1",
      expected: { generationId: generation.generationId, revisionToken: "1" }
    });
  });

  it("uses a revision-token cache, expires it at five minutes, and supports owner invalidation", async () => {
    let now = 1_000;
    const generation = snapshot(1);
    const readPage = vi.fn(() =>
      Promise.resolve({ status: "page", page: page(generation, [item(0)], null) } as const)
    );
    const openPayload = vi.fn((input: OpenPayloadInput) =>
      Promise.resolve({
        value: input.item.record,
        plaintextBytes: plaintextBytes(input.item.record)
      })
    );
    const retriever = createPrivateRagRetriever(
      options(readPage, { payloads: { openPayload }, now: () => now, cacheTtlMs: 300_000 })
    );

    expect((await retriever.retrieve({ ownerId: OWNER_ID, query: QUERY })).status).toBe("complete");
    const warm = await retriever.retrieve({ ownerId: OWNER_ID, query: QUERY });
    expect(warm).toMatchObject({ status: "complete", cache: "hit" });
    expect(openPayload).toHaveBeenCalledTimes(1);
    expect(retriever.invalidateOwner(OWNER_ID)).toBe(1);
    await retriever.retrieve({ ownerId: OWNER_ID, query: QUERY });
    now += 300_001;
    await retriever.retrieve({ ownerId: OWNER_ID, query: QUERY });
    expect(openPayload).toHaveBeenCalledTimes(3);
  });

  it("repairs at most fifty missing or stale documents, then restarts on a new token", async () => {
    const candidate = { noteId: noteId(0), currentRevision: 1 } as const;
    let repaired = false;
    const readPage = vi.fn((): Promise<PrivateRagPageReadResult<PrivateRagPayloadValueV1>> =>
      Promise.resolve(
        repaired
          ? { status: "page", page: page(snapshot(1, "2"), [item(0)], null) }
          : {
              status: "page",
              page: page(snapshot(1, "1", 0), [], null, {
                status: "incomplete",
                missingOrStaleCount: 1,
                repairCandidates: [candidate],
                repairOverflow: false
              })
            }
      )
    );
    const repair = vi.fn(() => {
      repaired = true;
      return Promise.resolve({ repairedCount: 1 });
    });
    const retriever = createPrivateRagRetriever(options(readPage, { repairs: { repair } }));
    const result = await retriever.retrieve({ ownerId: OWNER_ID, query: QUERY });
    expect(result).toMatchObject({ status: "complete", repaired: true, autoApplyAllowed: true });
    expect(repair).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER_ID, candidates: [candidate] })
    );
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it("fails closed when repair coverage exceeds fifty or repair fails", async () => {
    const candidates = Array.from({ length: 32 }, (_value, index) => ({
      noteId: noteId(index),
      currentRevision: 1
    }));
    const overLimit = vi.fn(() =>
      Promise.resolve({
        status: "page",
        page: page(snapshot(51, "1", 0), [], null, {
          status: "incomplete",
          missingOrStaleCount: 51,
          repairCandidates: candidates,
          repairOverflow: true
        })
      } as const)
    );
    await expect(
      createPrivateRagRetriever(options(overLimit)).retrieve({ ownerId: OWNER_ID, query: QUERY })
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "repair_limit_exceeded",
      autoApplyAllowed: false,
      matches: []
    });

    const missingOne = vi.fn(() =>
      Promise.resolve({
        status: "page",
        page: page(snapshot(1, "1", 0), [], null, {
          status: "incomplete",
          missingOrStaleCount: 1,
          repairCandidates: [{ noteId: noteId(0), currentRevision: 1 }],
          repairOverflow: false
        })
      } as const)
    );
    const repair = vi.fn(() => Promise.reject(new Error("provider unavailable")));
    await expect(
      createPrivateRagRetriever(options(missingOne, { repairs: { repair } })).retrieve({
        ownerId: OWNER_ID,
        query: QUERY
      })
    ).resolves.toMatchObject({ status: "incomplete", reason: "repair_failed", matches: [] });
  });

  it.each([
    ["changed page token", "snapshot_changed"],
    ["incomplete later page", "coverage_incomplete"],
    ["failed final verification", "snapshot_changed"]
  ] as const)("returns no partial candidates for %s", async (scenario, reason) => {
    const generation = snapshot(2);
    const readPage = vi.fn(
      (input: ReadPageInput): Promise<PrivateRagPageReadResult<PrivateRagPayloadValueV1>> => {
        if (input.cursor === null)
          return Promise.resolve({
            status: "page",
            page: page(generation, [item(0)], "next")
          });
        if (scenario === "changed page token") {
          return Promise.resolve({
            status: "page",
            page: page(snapshot(2, "changed"), [item(1)], null)
          });
        }
        if (scenario === "incomplete later page") {
          return Promise.resolve({
            status: "page",
            page: page(generation, [item(1)], null, {
              status: "incomplete",
              missingOrStaleCount: 1,
              repairCandidates: [{ noteId: noteId(2), currentRevision: 1 }],
              repairOverflow: false
            })
          });
        }
        return Promise.resolve({ status: "page", page: page(generation, [item(1)], null) });
      }
    );
    const base = options(readPage);
    const retriever = createPrivateRagRetriever({
      ...base,
      pages: {
        readPage,
        verifySnapshot: vi.fn(() => Promise.resolve(scenario !== "failed final verification"))
      }
    });
    const result = await retriever.retrieve({ ownerId: OWNER_ID, query: QUERY });
    expect(result).toMatchObject({
      status: "incomplete",
      reason,
      autoApplyAllowed: false,
      matches: []
    });
  });

  it("fails closed for payload context substitution, byte limits, and zero query vectors", async () => {
    const generation = snapshot(1);
    const substituted = item(0, document(1));
    const readPage = vi.fn(() =>
      Promise.resolve({
        status: "page",
        page: page(generation, [substituted], null)
      } as const)
    );
    await expect(
      createPrivateRagRetriever(options(readPage)).retrieve({ ownerId: OWNER_ID, query: QUERY })
    ).resolves.toMatchObject({ status: "incomplete", reason: "payload_invalid", matches: [] });

    const validRead = vi.fn(() =>
      Promise.resolve({
        status: "page",
        page: page(generation, [item(0, document(0), 60)], null)
      } as const)
    );
    const bytesRetriever = createPrivateRagRetriever(
      options(validRead, {
        maxPageBytes: 100,
        maxScanBytes: 200,
        payloads: {
          openPayload: vi.fn((input: OpenPayloadInput) =>
            Promise.resolve({
              value: input.item.record,
              plaintextBytes: 150
            })
          )
        }
      })
    );
    await expect(
      bytesRetriever.retrieve({ ownerId: OWNER_ID, query: QUERY })
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "byte_budget_exceeded",
      matches: []
    });
    await expect(
      bytesRetriever.retrieve({
        ownerId: OWNER_ID,
        query: { text: "alpha", modelId: MODEL_ID, embedding: [0, 0] }
      })
    ).resolves.toMatchObject({ status: "incomplete", reason: "query_embedding_invalid" });
  });

  it("rejects configuration that exceeds any hard memory or scan ceiling", () => {
    const readPage = vi.fn(() => Promise.resolve({ status: "no_active_generation" } as const));

    expect(() =>
      createPrivateRagRetriever(
        options(readPage, { maxPageBytes: MAX_PRIVATE_RAG_PAGE_BYTE_BUDGET + 1 })
      )
    ).toThrow("max_page_bytes_out_of_range");
    expect(() =>
      createPrivateRagRetriever(
        options(readPage, { maxScanBytes: MAX_PRIVATE_RAG_SCAN_BYTE_BUDGET + 1 })
      )
    ).toThrow("max_scan_bytes_out_of_range");
    expect(() =>
      createPrivateRagRetriever(options(readPage, { maxPages: MAX_PRIVATE_RAG_PAGES + 1 }))
    ).toThrow("max_pages_out_of_range");
    expect(() =>
      createPrivateRagRetriever(
        options(readPage, { cacheMaxBytes: MAX_PRIVATE_RAG_CACHE_BYTE_BUDGET + 1 })
      )
    ).toThrow("cache_max_bytes_out_of_range");
  });

  it("fails closed above the process-wide concurrent retrieval ceiling", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const readPage = vi.fn(
      async (): Promise<PrivateRagPageReadResult<PrivateRagPayloadValueV1>> => {
        await gate;
        return { status: "no_active_generation" };
      }
    );
    const retriever = createPrivateRagRetriever(options(readPage, { cacheMaxBytes: 0 }));
    const inFlight = Array.from({ length: MAX_PRIVATE_RAG_CONCURRENT_RETRIEVALS }, () =>
      retriever.retrieve({ ownerId: OWNER_ID, query: QUERY })
    );

    await expect(retriever.retrieve({ ownerId: OWNER_ID, query: QUERY })).resolves.toMatchObject({
      status: "incomplete",
      reason: "concurrency_limit_exceeded",
      autoApplyAllowed: false,
      matches: []
    });
    expect(readPage).toHaveBeenCalledTimes(MAX_PRIVATE_RAG_CONCURRENT_RETRIEVALS);

    if (releaseGate === undefined) throw new Error("test gate was not initialized");
    releaseGate();
    await Promise.all(inFlight);
    await expect(retriever.retrieve({ ownerId: OWNER_ID, query: QUERY })).resolves.toMatchObject({
      status: "incomplete",
      reason: "no_active_generation"
    });
  });
});
