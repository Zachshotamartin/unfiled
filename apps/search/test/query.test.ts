import {
  encryptedUserSearchGenerationBindingDigest,
  encryptedUserSearchResultDigest,
  type EncryptedUserSearchContinuation,
  type EncryptedUserSearchInvocation,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";
import type { ManagedKeyRecordV1 } from "@unfiled/key-management";
import {
  buildPrivateRagPayloadValue,
  type PrivateRagGenerationSnapshot,
  type PrivateRagPageReadResult,
  type PrivateRagPayloadOpener,
  type PrivateRagPayloadValueV1
} from "@unfiled/search";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEARCH_EMBEDDING_DIMENSIONS, SEARCH_EMBEDDING_MODEL_ID } from "../src/config.js";
import type {
  ClaimedEncryptedUserSearch,
  EncryptedUserSearchRepository,
  SearchRagMetadata,
  SearchRagRecord
} from "../src/database.js";
import type { SearchEmbeddingProvider } from "../src/embedding-provider.js";
import { SearchServiceError } from "../src/errors.js";
import type { SearchKeyAuthority } from "../src/key-management.js";
import { createEncryptedUserSearchQuery } from "../src/query.js";

const SEARCH_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const GENERATION_ID = "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const GENERATION_ATTESTATION_DIGEST = "d".repeat(64);
const NOTE_A = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const NOTE_B = "note_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const INDEX_A = "irw_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const INDEX_B = "irw_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const TAG_ID = "tag_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const REQUEST_DIGEST = "a".repeat(64);
const CANDIDATE_DIGEST = "b".repeat(64);
const AUTHORITY = Object.freeze({}) as SearchKeyAuthority;

const FILTERS: EncryptedUserSearchInvocation["material"]["filters"] = {
  archive: "exclude",
  privacy: "ai_assisted",
  space: { id: null, mode: "any" },
  tagIds: [TAG_ID],
  type: null,
  updatedFrom: null,
  updatedTo: null
};

function invocation(
  changes: Partial<EncryptedUserSearchInvocation["material"]> = {}
): EncryptedUserSearchInvocation {
  return Object.freeze({
    claimSecret: "A".repeat(43),
    material: Object.freeze({
      requestVersion: "encrypted-user-search-request-v1",
      hybridRankingVersion: "encrypted-hybrid-rank-v1",
      filters: FILTERS,
      pageLimit: 1,
      maxResults: 8,
      query: "Roosevelt method",
      continuation: null,
      ...changes
    }),
    requestDigest: REQUEST_DIGEST,
    searchId: SEARCH_ID
  });
}

const CLAIM: ClaimedEncryptedUserSearch = Object.freeze({
  filterDigest: "c".repeat(64),
  generation: Object.freeze({
    attestationDigest: GENERATION_ATTESTATION_DIGEST,
    embeddingDimensions: SEARCH_EMBEDDING_DIMENSIONS,
    embeddingModelId: SEARCH_EMBEDDING_MODEL_ID,
    envelopeSchemaVersion: 1,
    generationId: GENERATION_ID,
    revisionToken: "12"
  }),
  leaseExpiresAt: "2099-09-01T12:00:00.000Z",
  leaseToken: "33333333-3333-4333-8333-333333333333",
  ownerId: OWNER_ID,
  requestDigest: REQUEST_DIGEST,
  searchId: SEARCH_ID
});

function snapshot(
  changes: Partial<PrivateRagGenerationSnapshot> = {}
): PrivateRagGenerationSnapshot {
  return Object.freeze({
    dimensions: SEARCH_EMBEDDING_DIMENSIONS,
    expectedNoteCount: 2,
    generationId: GENERATION_ID,
    indexedNoteCount: 2,
    modelId: SEARCH_EMBEDDING_MODEL_ID,
    revisionToken: "12",
    ...changes
  });
}

function metadata(changes: Partial<SearchRagMetadata> = {}): SearchRagMetadata {
  return Object.freeze({
    archivedAt: null,
    pinnedAt: null,
    spaceId: null,
    tagIds: Object.freeze([TAG_ID]),
    type: "principle",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...changes
  });
}

function record(indexId: string, noteMetadata: SearchRagMetadata): SearchRagRecord {
  return Object.freeze({
    cipher: Object.freeze({}) as SearchRagRecord["cipher"],
    encryptedByteLength: 128,
    key: Object.freeze({}) as ManagedKeyRecordV1,
    metadata: noteMetadata,
    recordVersion: 7,
    resourceId: indexId
  });
}

function item(noteId: string, indexId: string, noteMetadata: SearchRagMetadata = metadata()) {
  return Object.freeze({
    ciphertextBytes: 128,
    indexId,
    indexedRevision: 7,
    noteId,
    record: record(indexId, noteMetadata)
  });
}

function completePage(
  items = [item(NOTE_A, INDEX_A), item(NOTE_B, INDEX_B)],
  pageSnapshot = snapshot()
): PrivateRagPageReadResult<SearchRagRecord> {
  return Object.freeze({
    status: "page" as const,
    page: Object.freeze({
      coverage: Object.freeze({
        missingOrStaleCount: 0,
        repairCandidates: Object.freeze([]),
        repairOverflow: false,
        status: "complete" as const
      }),
      items: Object.freeze(items),
      nextCursor: null,
      snapshot: pageSnapshot
    })
  });
}

function vector(axis: number): Float32Array {
  const result = new Float32Array(SEARCH_EMBEDDING_DIMENSIONS);
  result[axis] = 1;
  return result;
}

function payload(
  noteId: string,
  searchableText: string,
  embedding: Float32Array,
  noteMetadata: SearchRagMetadata = metadata()
): PrivateRagPayloadValueV1 {
  return buildPrivateRagPayloadValue({
    embedding,
    headings: [],
    indexedRevision: 7,
    isOpen: true,
    latestSnippet: searchableText,
    modelId: SEARCH_EMBEDDING_MODEL_ID,
    noteId,
    noteType: noteMetadata.type,
    pinned: noteMetadata.pinnedAt !== null,
    searchableText,
    spaceId: noteMetadata.spaceId,
    title: searchableText,
    updatedAt: noteMetadata.updatedAt
  });
}

type RepositoryFixture = Readonly<{
  complete: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["complete"]>>;
  fail: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["fail"]>>;
  page: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["page"]>>;
  port: EncryptedUserSearchRepository;
  verify: ReturnType<typeof vi.fn<EncryptedUserSearchRepository["verify"]>>;
}>;

function repository(
  options: Readonly<{
    claim?: EncryptedUserSearchRepository["claim"] | undefined;
    complete?: EncryptedUserSearchRepository["complete"] | undefined;
    fail?: EncryptedUserSearchRepository["fail"] | undefined;
    page?: EncryptedUserSearchRepository["page"] | undefined;
    verify?: EncryptedUserSearchRepository["verify"] | undefined;
  }> = {}
): RepositoryFixture {
  const claim = vi.fn<EncryptedUserSearchRepository["claim"]>(
    options.claim ?? (() => Promise.resolve(CLAIM))
  );
  const page = vi.fn<EncryptedUserSearchRepository["page"]>(
    options.page ?? (() => Promise.resolve(completePage()))
  );
  const verify = vi.fn<EncryptedUserSearchRepository["verify"]>(
    options.verify ??
      ((input) =>
        Promise.resolve({
          candidateDigest: CANDIDATE_DIGEST,
          verifiedCandidateCount: input.candidates.length
        }))
  );
  const complete = vi.fn<EncryptedUserSearchRepository["complete"]>(
    options.complete ?? (() => Promise.resolve())
  );
  const fail = vi.fn<EncryptedUserSearchRepository["fail"]>(
    options.fail ?? (() => Promise.resolve())
  );
  return Object.freeze({
    claim,
    complete,
    fail,
    page,
    port: Object.freeze({ claim, complete, fail, page, verify }),
    verify
  });
}

function opener(
  values: ReadonlyMap<string, PrivateRagPayloadValueV1>,
  failure?: Error
): Readonly<{
  open: ReturnType<typeof vi.fn<PrivateRagPayloadOpener<SearchRagRecord>["openPayload"]>>;
  port: PrivateRagPayloadOpener<SearchRagRecord>;
}> {
  const open = vi.fn<PrivateRagPayloadOpener<SearchRagRecord>["openPayload"]>((request) => {
    if (failure !== undefined) return Promise.reject(failure);
    const value = values.get(request.item.noteId);
    return value === undefined
      ? Promise.reject(new Error("missing fixture"))
      : Promise.resolve(Object.freeze({ plaintextBytes: 1_024, value }));
  });
  return Object.freeze({ open, port: Object.freeze({ openPayload: open }) });
}

function service(
  repositoryFixture: RepositoryFixture,
  provider: SearchEmbeddingProvider,
  payloads: PrivateRagPayloadOpener<SearchRagRecord>
) {
  return createEncryptedUserSearchQuery({
    embeddingProvider: provider,
    payloadsForAuthority: () => payloads,
    repository: repositoryFixture.port
  });
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

async function continuationFor(
  result: EncryptedUserSearchResult
): Promise<EncryptedUserSearchContinuation> {
  const generationBindingDigest = await encryptedUserSearchGenerationBindingDigest(result);
  return Object.freeze({
    generationBindingDigest,
    rankingVersion: result.rankingVersion,
    resultDigest: await encryptedUserSearchResultDigest({
      generationBindingDigest,
      rankingVersion: result.rankingVersion,
      items: result.items
    }),
    boundary: result.items.at(-1) ?? null
  });
}

beforeEach(() => vi.restoreAllMocks());

describe("encrypted user search query", () => {
  it("ranks a fixed snapshot, verifies only the selected candidate, completes, wipes, and never caches", async () => {
    const repositoryFixture = repository();
    const issuedVectors: Float32Array[] = [];
    const embed = vi.fn<SearchEmbeddingProvider["embed"]>(() => {
      const value = vector(0);
      issuedVectors.push(value);
      return Promise.resolve(value);
    });
    const provider = Object.freeze({ embed });
    const payloads = opener(
      new Map([
        [NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0))],
        [NOTE_B, payload(NOTE_B, "Workout log", vector(1))]
      ])
    );
    const query = service(repositoryFixture, provider, payloads.port);

    for (let run = 0; run < 2; run += 1) {
      const result = await query.query({
        authority: AUTHORITY,
        invocation: invocation(),
        signal: new AbortController().signal
      });
      expect(result).toMatchObject({
        generationAttestationDigest: GENERATION_ATTESTATION_DIGEST,
        generationId: GENERATION_ID,
        generationRevisionToken: "12",
        items: [
          { indexedRevision: 7, noteId: NOTE_A },
          { indexedRevision: 7, noteId: NOTE_B }
        ],
        scannedNoteCount: 2,
        searchId: SEARCH_ID
      });
      expect(Object.keys(result.items[0] ?? {}).sort()).toEqual([
        "indexedRevision",
        "noteId",
        "score"
      ]);
      expect(JSON.stringify(result)).not.toContain("Roosevelt method");
      expect(JSON.stringify(result)).not.toContain("Workout log");
    }

    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[0]?.[0]).toMatchObject({ text: "Roosevelt method" });
    expect(issuedVectors.every((value) => value.every((component) => component === 0))).toBe(true);
    expect(payloads.open).toHaveBeenCalledTimes(4);
    expect(repositoryFixture.page).toHaveBeenCalledTimes(4);
    expect(repositoryFixture.verify).toHaveBeenCalledTimes(2);
    for (const [verification] of repositoryFixture.verify.mock.calls) {
      expect(verification.candidates).toEqual([
        { indexId: INDEX_A, indexedRevision: 7, noteId: NOTE_A },
        { indexId: INDEX_B, indexedRevision: 7, noteId: NOTE_B }
      ]);
      expect(verification.filterManifest).toEqual(FILTERS);
    }
    expect(repositoryFixture.complete).toHaveBeenCalledTimes(2);
    expect(repositoryFixture.complete.mock.calls[0]?.[0]).toMatchObject({
      candidateDigest: CANDIDATE_DIGEST,
      claim: CLAIM
    });
    expect(repositoryFixture.fail).not.toHaveBeenCalled();
  });

  it("releases an injected request-scoped opener on success and failure", async () => {
    const successfulRepository = repository();
    const successfulPayloads = opener(
      new Map([
        [NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0))],
        [NOTE_B, payload(NOTE_B, "Workout log", vector(1))]
      ])
    );
    const successfulRelease = vi.fn();
    const successfulQuery = createEncryptedUserSearchQuery({
      embeddingProvider: Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
      payloadsForAuthority: () =>
        Object.freeze({ ...successfulPayloads.port, release: successfulRelease }),
      repository: successfulRepository.port
    });

    await expect(
      successfulQuery.query({
        authority: AUTHORITY,
        invocation: invocation(),
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ searchId: SEARCH_ID });
    expect(successfulRelease).toHaveBeenCalledOnce();

    const failedRepository = repository();
    const failedRelease = vi.fn();
    const failedQuery = createEncryptedUserSearchQuery({
      embeddingProvider: Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
      payloadsForAuthority: () =>
        Object.freeze({
          openPayload: () => Promise.reject(new Error("PRIVATE-OPENER-FAILURE")),
          release: failedRelease
        }),
      repository: failedRepository.port
    });

    await expectUnavailable(
      failedQuery.query({
        authority: AUTHORITY,
        invocation: invocation(),
        signal: new AbortController().signal
      })
    );
    expect(failedRelease).toHaveBeenCalledOnce();
  });

  it("reranks all eight semantic slots for a page-limit-one continuation", async () => {
    let wallClock = Date.parse("2026-09-01T12:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => {
      wallClock += 86_400_000;
      return wallClock;
    });
    const repositoryFixture = repository();
    const embed = vi.fn<SearchEmbeddingProvider["embed"]>(() => Promise.resolve(vector(0)));
    const payloads = opener(
      new Map([
        [NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0))],
        [NOTE_B, payload(NOTE_B, "Workout log", vector(1))]
      ])
    );
    const query = service(repositoryFixture, Object.freeze({ embed }), payloads.port);
    const first = await query.query({
      authority: AUTHORITY,
      invocation: invocation(),
      signal: new AbortController().signal
    });

    const continued = await query.query({
      authority: AUTHORITY,
      invocation: invocation({ continuation: await continuationFor(first) }),
      signal: new AbortController().signal
    });

    expect(continued.items).toEqual(first.items);
    expect(continued.items).toHaveLength(2);
    expect(invocation().material.pageLimit).toBe(1);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(payloads.open).toHaveBeenCalledTimes(4);
    expect(repositoryFixture.verify).toHaveBeenCalledTimes(2);
    expect(repositoryFixture.complete).toHaveBeenCalledTimes(2);
    expect(repositoryFixture.fail).not.toHaveBeenCalled();
  });

  it("fails closed after a real generation revision rollover", async () => {
    const baselineRepository = repository();
    const baselinePayloads = opener(
      new Map([
        [NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0))],
        [NOTE_B, payload(NOTE_B, "Workout log", vector(1))]
      ])
    );
    const first = await service(
      baselineRepository,
      Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
      baselinePayloads.port
    ).query({
      authority: AUTHORITY,
      invocation: invocation(),
      signal: new AbortController().signal
    });
    const rolledClaim = Object.freeze({
      ...CLAIM,
      generation: Object.freeze({ ...CLAIM.generation, revisionToken: "13" })
    });
    const rolledRepository = repository({
      claim: () => Promise.resolve(rolledClaim),
      page: () => Promise.resolve(completePage(undefined, snapshot({ revisionToken: "13" })))
    });

    await expectUnavailable(
      service(
        rolledRepository,
        Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
        baselinePayloads.port
      ).query({
        authority: AUTHORITY,
        invocation: invocation({ continuation: await continuationFor(first) }),
        signal: new AbortController().signal
      })
    );
    expect(rolledRepository.verify).not.toHaveBeenCalled();
    expect(rolledRepository.complete).not.toHaveBeenCalled();
    expect(rolledRepository.fail).toHaveBeenCalledOnce();
  });

  it("fails closed when a fresh rerank reorders the exact semantic top-K", async () => {
    const verify = (input: Parameters<EncryptedUserSearchRepository["verify"]>[0]) =>
      Promise.resolve({
        candidateDigest: CANDIDATE_DIGEST,
        verifiedCandidateCount: input.candidates.length
      });
    const baselineRepository = repository({ verify });
    const baseline = service(
      baselineRepository,
      Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
      opener(
        new Map([
          [NOTE_A, payload(NOTE_A, "neutral text", vector(0))],
          [NOTE_B, payload(NOTE_B, "neutral text", vector(1))]
        ])
      ).port
    );
    const first = await baseline.query({
      authority: AUTHORITY,
      invocation: invocation(),
      signal: new AbortController().signal
    });
    expect(first.items.map(({ noteId }) => noteId)).toEqual([NOTE_A, NOTE_B]);

    const reorderedRepository = repository({ verify });
    await expectUnavailable(
      service(
        reorderedRepository,
        Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
        opener(
          new Map([
            [NOTE_A, payload(NOTE_A, "neutral text", vector(1))],
            [NOTE_B, payload(NOTE_B, "neutral text", vector(0))]
          ])
        ).port
      ).query({
        authority: AUTHORITY,
        invocation: invocation({ continuation: await continuationFor(first) }),
        signal: new AbortController().signal
      })
    );
    expect(reorderedRepository.verify).not.toHaveBeenCalled();
    expect(reorderedRepository.complete).not.toHaveBeenCalled();
    expect(reorderedRepository.fail).toHaveBeenCalledOnce();
  });

  it("fails closed on continuation digest, boundary, score, or ranking tampering", async () => {
    const repositoryFixture = repository();
    const payloads = opener(
      new Map([
        [NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0))],
        [NOTE_B, payload(NOTE_B, "Workout log", vector(1))]
      ])
    );
    const query = service(
      repositoryFixture,
      Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
      payloads.port
    );
    const first = await query.query({
      authority: AUTHORITY,
      invocation: invocation(),
      signal: new AbortController().signal
    });
    const valid = await continuationFor(first);
    if (valid.boundary === null) throw new Error("expected semantic boundary");
    const changed = (value: string): string =>
      `${value.startsWith("a") ? "b" : "a"}${value.slice(1)}`;
    const attempts: EncryptedUserSearchContinuation[] = [
      { ...valid, generationBindingDigest: changed(valid.generationBindingDigest) },
      { ...valid, resultDigest: changed(valid.resultDigest) },
      { ...valid, boundary: { ...valid.boundary, noteId: NOTE_A } },
      { ...valid, boundary: { ...valid.boundary, indexedRevision: 8 } },
      { ...valid, boundary: { ...valid.boundary, score: valid.boundary.score + 0.001 } },
      {
        ...valid,
        rankingVersion: "encrypted-semantic-rank-v0"
      } as unknown as EncryptedUserSearchContinuation
    ];

    for (const continuation of attempts) {
      await expectUnavailable(
        query.query({
          authority: AUTHORITY,
          invocation: invocation({ continuation }),
          signal: new AbortController().signal
        })
      );
    }
    expect(repositoryFixture.verify).toHaveBeenCalledOnce();
    expect(repositoryFixture.complete).toHaveBeenCalledOnce();
    expect(repositoryFixture.fail).toHaveBeenCalledTimes(attempts.length);
  });

  it.each([
    ["type", metadata({ type: "project" }), { ...FILTERS, type: "principle" }],
    ["archive", metadata({ archivedAt: "2026-09-01T13:00:00.000Z" }), FILTERS],
    ["tag", metadata({ tagIds: [] }), FILTERS],
    [
      "space",
      metadata({ spaceId: null }),
      { ...FILTERS, space: { id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FAA", mode: "exact" as const } }
    ],
    ["updated from", metadata(), { ...FILTERS, updatedFrom: "2026-09-01T13:00:00.000Z" }],
    ["updated to", metadata(), { ...FILTERS, updatedTo: "2026-09-01T12:00:00.000Z" }]
  ] as const)(
    "fails closed on a %s metadata/filter mismatch",
    async (_name, noteMetadata, filters) => {
      const selected = item(NOTE_A, INDEX_A, noteMetadata);
      const repositoryFixture = repository({
        page: () =>
          Promise.resolve(
            completePage([selected], snapshot({ expectedNoteCount: 1, indexedNoteCount: 1 }))
          )
      });
      const providerVector = vector(0);
      const payloads = opener(
        new Map([[NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0), noteMetadata)]])
      );

      await expectUnavailable(
        service(
          repositoryFixture,
          Object.freeze({ embed: () => Promise.resolve(providerVector) }),
          payloads.port
        ).query({
          authority: AUTHORITY,
          invocation: invocation({ filters }),
          signal: new AbortController().signal
        })
      );
      expect(providerVector.every((component) => component === 0)).toBe(true);
      expect(repositoryFixture.verify).not.toHaveBeenCalled();
      expect(repositoryFixture.complete).not.toHaveBeenCalled();
      expect(repositoryFixture.fail).toHaveBeenCalledOnce();
    }
  );

  it("fails closed when authenticated payload metadata differs from the selected DB projection", async () => {
    const projected = metadata({ type: "project" });
    const repositoryFixture = repository({
      page: () =>
        Promise.resolve(
          completePage(
            [item(NOTE_A, INDEX_A, projected)],
            snapshot({ expectedNoteCount: 1, indexedNoteCount: 1 })
          )
        )
    });
    const payloads = opener(
      new Map([[NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0), metadata())]])
    );

    await expectUnavailable(
      service(
        repositoryFixture,
        Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
        payloads.port
      ).query({
        authority: AUTHORITY,
        invocation: invocation(),
        signal: new AbortController().signal
      })
    );
    expect(repositoryFixture.verify).not.toHaveBeenCalled();
    expect(repositoryFixture.fail).toHaveBeenCalledOnce();
  });

  it.each(["provider", "page", "decrypt", "verify", "complete"] as const)(
    "fails the claimed ticket after a redacted %s failure and wipes any provider vector",
    async (stage) => {
      const providerVector = vector(0);
      const repositoryFixture = repository({
        page: stage === "page" ? () => Promise.reject(new Error("PRIVATE-PAGE-CANARY")) : undefined,
        verify:
          stage === "verify" ? () => Promise.reject(new Error("PRIVATE-VERIFY-CANARY")) : undefined,
        complete:
          stage === "complete"
            ? () => Promise.reject(new Error("PRIVATE-COMPLETE-CANARY"))
            : undefined
      });
      const provider: SearchEmbeddingProvider = Object.freeze({
        embed: () =>
          stage === "provider"
            ? Promise.reject(new SearchServiceError(503, "rate_limited", { retryable: true }))
            : Promise.resolve(providerVector)
      });
      const payloads = opener(
        new Map([
          [NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0))],
          [NOTE_B, payload(NOTE_B, "Workout log", vector(1))]
        ]),
        stage === "decrypt" ? new Error("PRIVATE-DECRYPT-CANARY") : undefined
      );

      let caught: unknown;
      try {
        await service(repositoryFixture, provider, payloads.port).query({
          authority: AUTHORITY,
          invocation: invocation(),
          signal: new AbortController().signal
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "provider_unavailable", status: 503 });
      expect(String(caught)).not.toContain("CANARY");
      expect(providerVector.every((component) => component === 0)).toBe(stage !== "provider");
      expect(repositoryFixture.complete).toHaveBeenCalledTimes(stage === "complete" ? 1 : 0);
      expect(repositoryFixture.fail).toHaveBeenCalledOnce();
      expect(repositoryFixture.fail.mock.calls[0]?.[0].failureCode).toBe(
        stage === "provider" ? "rate_limited" : "provider_unavailable"
      );
    }
  );

  it("fails closed when a repository reports a mismatched verified-candidate count", async () => {
    const repositoryFixture = repository({
      verify: () =>
        Promise.resolve({ candidateDigest: CANDIDATE_DIGEST, verifiedCandidateCount: 0 })
    });
    const payloads = opener(
      new Map([
        [NOTE_A, payload(NOTE_A, "Roosevelt method", vector(0))],
        [NOTE_B, payload(NOTE_B, "Workout log", vector(1))]
      ])
    );

    await expectUnavailable(
      service(
        repositoryFixture,
        Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
        payloads.port
      ).query({
        authority: AUTHORITY,
        invocation: invocation(),
        signal: new AbortController().signal
      })
    );
    expect(repositoryFixture.complete).not.toHaveBeenCalled();
    expect(repositoryFixture.fail).toHaveBeenCalledOnce();
  });

  it("fails closed for incomplete coverage, no generation, or a stale claim snapshot", async () => {
    const incompleteSnapshot = snapshot({ indexedNoteCount: 1 });
    const cases: PrivateRagPageReadResult<SearchRagRecord>[] = [
      Object.freeze({ status: "no_active_generation" as const }),
      Object.freeze({
        status: "page" as const,
        page: Object.freeze({
          coverage: Object.freeze({
            missingOrStaleCount: 1,
            repairCandidates: Object.freeze([{ currentRevision: 8, noteId: NOTE_B }]),
            repairOverflow: false,
            status: "incomplete" as const
          }),
          items: Object.freeze([item(NOTE_A, INDEX_A)]),
          nextCursor: null,
          snapshot: incompleteSnapshot
        })
      }),
      completePage(undefined, snapshot({ revisionToken: "13" }))
    ];
    for (const pageResult of cases) {
      const repositoryFixture = repository({ page: () => Promise.resolve(pageResult) });
      await expectUnavailable(
        service(
          repositoryFixture,
          Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
          opener(new Map()).port
        ).query({
          authority: AUTHORITY,
          invocation: invocation(),
          signal: new AbortController().signal
        })
      );
      expect(repositoryFixture.verify).not.toHaveBeenCalled();
      expect(repositoryFixture.fail).toHaveBeenCalledOnce();
    }
  });

  it("fails an expired claim without embedding and preserves the original error if cleanup fails", async () => {
    const expired = Object.freeze({ ...CLAIM, leaseExpiresAt: "2020-01-01T00:00:00.000Z" });
    const embed = vi.fn<SearchEmbeddingProvider["embed"]>();
    const repositoryFixture = repository({
      claim: () => Promise.resolve(expired),
      fail: () => Promise.reject(new Error("PRIVATE-CLEANUP-CANARY"))
    });

    let caught: unknown;
    try {
      await service(repositoryFixture, Object.freeze({ embed }), opener(new Map()).port).query({
        authority: AUTHORITY,
        invocation: invocation(),
        signal: new AbortController().signal
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(String(caught)).not.toContain("PRIVATE-CLEANUP-CANARY");
    expect(embed).not.toHaveBeenCalled();
    expect(repositoryFixture.fail).toHaveBeenCalledOnce();
  });

  it("does not attempt ticket cleanup when claiming itself fails", async () => {
    const repositoryFixture = repository({
      claim: () => Promise.reject(new Error("PRIVATE-CLAIM-CANARY"))
    });
    await expectUnavailable(
      service(
        repositoryFixture,
        Object.freeze({ embed: () => Promise.resolve(vector(0)) }),
        opener(new Map()).port
      ).query({
        authority: AUTHORITY,
        invocation: invocation(),
        signal: new AbortController().signal
      })
    );
    expect(repositoryFixture.fail).not.toHaveBeenCalled();
  });
});
