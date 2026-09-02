import type { EncryptedUserSearchFilterManifest } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  SEARCH_RPC_SQL,
  createEncryptedUserSearchRepository,
  type ClaimedEncryptedUserSearch,
  type SearchDatabaseExecutor
} from "../src/database.js";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ULID_C = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const SEARCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SEARCH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_OWNER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LEASE_TOKEN = "11111111-1111-4111-8111-111111111111";
const CLAIM_SECRET = "s".repeat(43);
const REQUEST_DIGEST = "a".repeat(64);
const FILTER_DIGEST = "b".repeat(64);
const CANDIDATE_DIGEST = "c".repeat(64);
const ATTESTATION_DIGEST = "d".repeat(64);
const GENERATION_ID = `igen_${ULID_A}`;
const INDEX_A = `irw_${ULID_A}`;
const INDEX_B = `irw_${ULID_B}`;
const NOTE_A = `note_${ULID_A}`;
const NOTE_B = `note_${ULID_B}`;
const SPACE_ID = `spc_${ULID_A}`;
const TAG_A = `tag_${ULID_A}`;
const TAG_B = `tag_${ULID_B}`;
const TAG_C = `tag_${ULID_C}`;
const NOW = "2026-09-01T20:00:00.000Z";
const LATER = "2026-09-01T20:00:30.000Z";
const PAGE_BYTES = 262_160;
const KEY_ID = "ai_assisted.object_wrap.v1";

const FILTER: EncryptedUserSearchFilterManifest = {
  archive: "exclude",
  privacy: "ai_assisted",
  type: null,
  space: { mode: "any", id: null },
  tagIds: [],
  updatedFrom: null,
  updatedTo: null
};

const CLAIM: ClaimedEncryptedUserSearch = Object.freeze({
  searchId: SEARCH_ID,
  ownerId: OWNER_ID,
  leaseToken: LEASE_TOKEN,
  leaseExpiresAt: LATER,
  requestDigest: REQUEST_DIGEST,
  filterDigest: FILTER_DIGEST,
  generation: Object.freeze({
    generationId: GENERATION_ID,
    revisionToken: "7",
    attestationDigest: ATTESTATION_DIGEST,
    embeddingModelId: "text-embedding-3-small",
    embeddingDimensions: 1_536,
    envelopeSchemaVersion: 1
  })
});

function b64(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString("base64url");
}

function generation() {
  return {
    generationId: GENERATION_ID,
    revisionToken: 7,
    attestationDigest: ATTESTATION_DIGEST,
    embeddingModelId: "text-embedding-3-small",
    embeddingDimensions: 1_536,
    envelopeSchemaVersion: 1
  };
}

function claimResult() {
  return {
    searchId: SEARCH_ID,
    ownerId: OWNER_ID,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: LATER,
    requestDigest: REQUEST_DIGEST,
    filterDigest: FILTER_DIGEST,
    generation: generation()
  };
}

function managedKey() {
  return {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    keyClass: "ai_assisted",
    purpose: "object_wrap",
    keyId: KEY_ID,
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: "AQIDBA",
    rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
    createdAt: NOW,
    activatedAt: NOW,
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 2,
    wrapOperationLimit: 16_777_216,
    rotation: {
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    }
  };
}

function envelope(indexId = INDEX_A, indexedRevision = 2) {
  return {
    version: 1,
    suite: "A256GCM",
    keyId: KEY_ID,
    context: {
      tenantId: OWNER_ID,
      resourceId: indexId,
      recordVersion: indexedRevision,
      kind: "note_rag_index"
    },
    wrappedDataKey: { nonce: b64(12, 1), ciphertext: b64(48, 2) },
    payload: { nonce: b64(12, 3), ciphertext: b64(16, 4) }
  };
}

function ragItem(
  indexId = INDEX_A,
  noteId = NOTE_A,
  indexedRevision = 2,
  metadataOverrides: Record<string, unknown> = {}
) {
  return {
    indexId,
    noteId,
    indexedRevision,
    cipher: {
      envelope: envelope(indexId, indexedRevision),
      keyClass: "ai_assisted",
      keyId: KEY_ID,
      keyPurpose: "object_wrap",
      keyVersion: 1
    },
    encryptedByteLength: 16,
    metadata: {
      type: "list",
      spaceId: SPACE_ID,
      updatedAt: NOW,
      pinnedAt: null,
      archivedAt: null,
      tagIds: [TAG_A, TAG_B],
      ...metadataOverrides
    }
  };
}

function cursor(afterIndexId = INDEX_A) {
  return {
    searchId: SEARCH_ID,
    requestDigest: REQUEST_DIGEST,
    generationId: GENERATION_ID,
    generationRevisionToken: 7,
    afterIndexId
  };
}

interface PageOptions {
  expectedNoteCount?: number;
  indexedNoteCount?: number;
  items?: ReturnType<typeof ragItem>[];
  coverage?: {
    status: "complete" | "incomplete";
    missingOrStaleCount: number;
    repairCandidates: { noteId: string; currentRevision: number }[];
    repairOverflow: boolean;
  };
  hasMore?: boolean;
  nextCursor?: ReturnType<typeof cursor> | null;
  limit?: number;
  maxBytes?: number;
}

function pageResult(options: PageOptions = {}) {
  const items = options.items ?? [ragItem()];
  const expectedNoteCount = options.expectedNoteCount ?? 1;
  const indexedNoteCount = options.indexedNoteCount ?? 1;
  const hasMore = options.hasMore ?? false;
  return {
    searchId: SEARCH_ID,
    ownerId: OWNER_ID,
    generation: {
      ...generation(),
      expectedNoteCount,
      indexedNoteCount
    },
    coverage:
      options.coverage ??
      ({
        status: "complete",
        missingOrStaleCount: 0,
        repairCandidates: [],
        repairOverflow: false
      } as const),
    items,
    keys: items.length === 0 ? [] : [managedKey()],
    page: {
      limit: options.limit ?? 2,
      ciphertextByteBudget: options.maxBytes ?? PAGE_BYTES,
      returnedCount: items.length,
      ciphertextBytes: items.reduce((total, item) => total + item.encryptedByteLength, 0),
      hasMore,
      nextCursor:
        "nextCursor" in options
          ? (options.nextCursor ?? null)
          : hasMore
            ? cursor(items.at(-1)?.indexId)
            : null
    }
  };
}

function first<Value>(values: readonly Value[]): Value {
  const value = values[0];
  if (value === undefined) throw new Error("Expected fixture entry");
  return value;
}

function set(target: object, key: string, value: unknown): void {
  if (!Reflect.set(target, key, value)) throw new Error(`Could not set ${key}`);
}

function executorForRows(rows: readonly unknown[]): Readonly<{
  executor: SearchDatabaseExecutor;
  query: ReturnType<typeof vi.fn<SearchDatabaseExecutor["query"]>>;
}> {
  const query = vi.fn<SearchDatabaseExecutor["query"]>(() => Promise.resolve({ rows }));
  return { executor: { query }, query };
}

function executorFor(result: unknown) {
  return executorForRows([{ result }]);
}

function repositoryFor(result: unknown) {
  const fixture = executorFor(result);
  return { ...fixture, repository: createEncryptedUserSearchRepository(fixture.executor) };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function claimInput(
  overrides: Partial<
    Parameters<ReturnType<typeof createEncryptedUserSearchRepository>["claim"]>[0]
  > = {}
) {
  return {
    searchId: SEARCH_ID,
    claimSecret: CLAIM_SECRET,
    requestDigest: REQUEST_DIGEST,
    signal: signal(),
    ...overrides
  };
}

function pageInput(
  overrides: Partial<
    Parameters<ReturnType<typeof createEncryptedUserSearchRepository>["page"]>[0]
  > = {}
) {
  return {
    claim: CLAIM,
    filterManifest: FILTER,
    cursor: null,
    limit: 2,
    maxBytes: PAGE_BYTES,
    signal: signal(),
    ...overrides
  };
}

async function expectContract(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: "contract_violation" });
}

describe("encrypted user-search database contract", () => {
  it("claims once through the exact claim RPC and parses its bound lease", async () => {
    const { query, repository } = repositoryFor(claimResult());
    const result = await repository.claim(claimInput());

    expect(result).toEqual(CLAIM);
    expect(Object.isFrozen(result)).toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      text: SEARCH_RPC_SQL.claim,
      values: [SEARCH_ID, CLAIM_SECRET, REQUEST_DIGEST]
    });
    expect(query.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects malformed claim inputs before database access", async () => {
    const { query, repository } = repositoryFor(claimResult());
    for (const input of [
      claimInput({ searchId: "not-a-search" }),
      claimInput({ claimSecret: "short" }),
      claimInput({ claimSecret: `${"s".repeat(42)}+` }),
      claimInput({ requestDigest: "A".repeat(64) }),
      claimInput({ requestDigest: "a".repeat(63) })
    ]) {
      await expectContract(repository.claim(input));
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("strictly rejects claim response drift and ambiguous row wrappers", async () => {
    const mutations: readonly [string, (value: ReturnType<typeof claimResult>) => void][] = [
      ["extra key", (value) => set(value, "extra", true)],
      ["wrong search", (value) => set(value, "searchId", OTHER_SEARCH_ID)],
      ["bad owner", (value) => set(value, "ownerId", "postgres")],
      ["wrong request digest", (value) => set(value, "requestDigest", "d".repeat(64))],
      ["bad filter digest", (value) => set(value, "filterDigest", "short")],
      ["bad lease", (value) => set(value, "leaseToken", "not-a-lease")],
      ["bad expiry", (value) => set(value, "leaseExpiresAt", "2026-09-01")],
      ["bad generation id", (value) => set(value.generation, "generationId", "bad")],
      ["bad revision", (value) => set(value.generation, "revisionToken", -1)],
      ["wrong model", (value) => set(value.generation, "embeddingModelId", "other")],
      ["wrong dimensions", (value) => set(value.generation, "embeddingDimensions", 3)],
      ["wrong schema", (value) => set(value.generation, "envelopeSchemaVersion", 2)],
      ["extra generation key", (value) => set(value.generation, "extra", true)]
    ];
    for (const [, mutate] of mutations) {
      const value = claimResult();
      mutate(value);
      await expectContract(repositoryFor(value).repository.claim(claimInput()));
    }
    for (const rows of [
      [],
      [{ result: claimResult() }, { result: claimResult() }],
      [claimResult()],
      [{ result: claimResult(), extra: true }]
    ]) {
      await expectContract(
        createEncryptedUserSearchRepository(executorForRows(rows).executor).claim(claimInput())
      );
    }
  });

  it("parses one exact encrypted page and forwards only bound non-plaintext parameters", async () => {
    const value = pageResult();
    const { query, repository } = repositoryFor(value);
    const result = await repository.page(pageInput());

    expect(result).toMatchObject({
      status: "page",
      page: {
        snapshot: {
          generationId: GENERATION_ID,
          revisionToken: "7",
          modelId: "text-embedding-3-small",
          dimensions: 1_536,
          expectedNoteCount: 1,
          indexedNoteCount: 1
        },
        coverage: {
          status: "complete",
          missingOrStaleCount: 0,
          repairCandidates: [],
          repairOverflow: false
        },
        items: [
          {
            indexId: INDEX_A,
            noteId: NOTE_A,
            indexedRevision: 2,
            ciphertextBytes: 16,
            record: {
              resourceId: INDEX_A,
              recordVersion: 2,
              encryptedByteLength: 16,
              metadata: {
                type: "list",
                spaceId: SPACE_ID,
                updatedAt: NOW,
                tagIds: [TAG_A, TAG_B]
              },
              key: { ownerId: OWNER_ID, keyClass: "ai_assisted", purpose: "object_wrap" }
            }
          }
        ],
        nextCursor: null
      }
    });
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      text: SEARCH_RPC_SQL.page,
      values: [SEARCH_ID, LEASE_TOKEN, REQUEST_DIGEST, FILTER, null, 2, PAGE_BYTES]
    });
    expect(query.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(query.mock.calls[0]?.[0]?.values)).not.toContain("private search query");
  });

  it("rejects malicious cross-owner, key, envelope, and item drift", async () => {
    type Page = ReturnType<typeof pageResult>;
    const mutations: readonly [string, (value: Page) => void][] = [
      ["extra root field", (value) => set(value, "plaintextQuery", "steal me")],
      ["wrong search", (value) => set(value, "searchId", OTHER_SEARCH_ID)],
      ["wrong page owner", (value) => set(value, "ownerId", OTHER_OWNER_ID)],
      ["generation drift", (value) => set(value.generation, "revisionToken", 8)],
      ["missing key", (value) => value.keys.splice(0)],
      ["unreferenced key", (value) => value.keys.push({ ...managedKey(), keyId: "unused.v1" })],
      ["duplicate key", (value) => value.keys.push(structuredClone(first(value.keys)))],
      ["cross-owner key", (value) => set(first(value.keys), "ownerId", OTHER_OWNER_ID)],
      ["private key", (value) => set(first(value.keys), "keyClass", "private_manual")],
      ["content-mac key", (value) => set(first(value.keys), "purpose", "content_mac")],
      [
        "pending key",
        (value) => {
          const key = first(value.keys);
          set(key, "status", "pending");
          set(key, "activatedAt", null);
        }
      ],
      [
        "revoked key",
        (value) => {
          const key = first(value.keys);
          set(key, "status", "revoked");
          set(key, "revokedAt", LATER);
        }
      ],
      ["malformed key material", (value) => set(first(value.keys), "encryptedKeyMaterial", "A+")],
      ["duplicate index", (value) => value.items.push({ ...ragItem(), noteId: NOTE_B })],
      ["duplicate note", (value) => value.items.push({ ...ragItem(INDEX_B), noteId: NOTE_A })],
      ["bad index id", (value) => set(first(value.items), "indexId", "index-bad")],
      ["bad note id", (value) => set(first(value.items), "noteId", "note-bad")],
      ["zero revision", (value) => set(first(value.items), "indexedRevision", 0)],
      ["private cipher", (value) => set(first(value.items).cipher, "keyClass", "private_manual")],
      [
        "wrong cipher purpose",
        (value) => set(first(value.items).cipher, "keyPurpose", "content_mac")
      ],
      ["unknown cipher key", (value) => set(first(value.items).cipher, "keyId", "unknown.v1")],
      ["wrong cipher key version", (value) => set(first(value.items).cipher, "keyVersion", 2)],
      [
        "cross-owner envelope",
        (value) => set(first(value.items).cipher.envelope.context, "tenantId", OTHER_OWNER_ID)
      ],
      [
        "wrong envelope resource",
        (value) => set(first(value.items).cipher.envelope.context, "resourceId", INDEX_B)
      ],
      [
        "wrong envelope revision",
        (value) => set(first(value.items).cipher.envelope.context, "recordVersion", 3)
      ],
      [
        "wrong envelope kind",
        (value) => set(first(value.items).cipher.envelope.context, "kind", "note_content")
      ],
      [
        "wrong envelope key",
        (value) => set(first(value.items).cipher.envelope, "keyId", "other.v1")
      ],
      [
        "noncanonical ciphertext",
        (value) =>
          set(first(value.items).cipher.envelope.payload, "ciphertext", `${"A".repeat(21)}B`)
      ],
      ["ciphertext length mismatch", (value) => set(first(value.items), "encryptedByteLength", 17)],
      [
        "extra envelope field",
        (value) => set(first(value.items).cipher.envelope, "plaintext", true)
      ]
    ];
    for (const [, mutate] of mutations) {
      const value = pageResult();
      mutate(value);
      await expectContract(repositoryFor(value).repository.page(pageInput()));
    }
  });

  it("strictly parses metadata and rejects filter-incompatible manifests", async () => {
    type Page = ReturnType<typeof pageResult>;
    const metadataMutations: readonly [string, (value: Page) => void][] = [
      ["extra metadata", (value) => set(first(value.items).metadata, "title", "plaintext")],
      ["bad type", (value) => set(first(value.items).metadata, "type", "secret")],
      ["bad space", (value) => set(first(value.items).metadata, "spaceId", "space-bad")],
      ["bad updated timestamp", (value) => set(first(value.items).metadata, "updatedAt", "today")],
      [
        "bad pinned timestamp",
        (value) => set(first(value.items).metadata, "pinnedAt", NOW.slice(0, -1))
      ],
      ["bad archived timestamp", (value) => set(first(value.items).metadata, "archivedAt", 1)],
      ["bad tag", (value) => set(first(value.items).metadata, "tagIds", ["tag-bad"])],
      ["duplicate tags", (value) => set(first(value.items).metadata, "tagIds", [TAG_A, TAG_A])],
      ["unsorted tags", (value) => set(first(value.items).metadata, "tagIds", [TAG_B, TAG_A])]
    ];
    for (const [, mutate] of metadataMutations) {
      const value = pageResult();
      mutate(value);
      await expectContract(repositoryFor(value).repository.page(pageInput()));
    }

    const invalidFilters: unknown[] = [
      { ...FILTER, privacy: "private_manual" },
      { ...FILTER, tagIds: [TAG_B, TAG_A] },
      { ...FILTER, tagIds: [TAG_A, TAG_A] },
      { ...FILTER, space: { mode: "exact", id: null } },
      { ...FILTER, updatedFrom: LATER, updatedTo: NOW },
      { ...FILTER, plaintextQuery: "must not enter database" }
    ];
    const { query, repository } = repositoryFor(pageResult());
    for (const filterManifest of invalidFilters) {
      await expectContract(
        repository.page(
          pageInput({ filterManifest: filterManifest as EncryptedUserSearchFilterManifest })
        )
      );
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a page whose metadata drifts from its bound filter", async () => {
    const cases: readonly [EncryptedUserSearchFilterManifest, ReturnType<typeof pageResult>][] = [
      [{ ...FILTER, type: "project" }, pageResult()],
      [{ ...FILTER, archive: "only" }, pageResult()],
      [
        { ...FILTER, archive: "exclude" },
        pageResult({ items: [ragItem(INDEX_A, NOTE_A, 2, { archivedAt: NOW })] })
      ],
      [{ ...FILTER, space: { mode: "root", id: null } }, pageResult()],
      [{ ...FILTER, space: { mode: "exact", id: `spc_${ULID_B}` } }, pageResult()],
      [{ ...FILTER, tagIds: [TAG_C] }, pageResult()],
      [{ ...FILTER, updatedFrom: LATER }, pageResult()],
      [{ ...FILTER, updatedTo: NOW }, pageResult()]
    ];
    for (const [filterManifest, value] of cases) {
      await expectContract(repositoryFor(value).repository.page(pageInput({ filterManifest })));
    }
  });

  it("accepts exact complete and incomplete coverage and rejects inconsistent coverage", async () => {
    await expect(repositoryFor(pageResult()).repository.page(pageInput())).resolves.toMatchObject({
      page: { coverage: { status: "complete", missingOrStaleCount: 0 } }
    });
    const incomplete = pageResult({
      expectedNoteCount: 2,
      indexedNoteCount: 1,
      coverage: {
        status: "incomplete",
        missingOrStaleCount: 1,
        repairCandidates: [{ noteId: NOTE_B, currentRevision: 4 }],
        repairOverflow: false
      }
    });
    await expect(repositoryFor(incomplete).repository.page(pageInput())).resolves.toMatchObject({
      page: {
        snapshot: { expectedNoteCount: 2, indexedNoteCount: 1 },
        coverage: {
          status: "incomplete",
          missingOrStaleCount: 1,
          repairCandidates: [{ noteId: NOTE_B, currentRevision: 4 }],
          repairOverflow: false
        }
      }
    });

    type Page = ReturnType<typeof pageResult>;
    const mutations: readonly [string, (value: Page) => void][] = [
      ["indexed exceeds expected", (value) => set(value.generation, "indexedNoteCount", 2)],
      ["over capacity", (value) => set(value.generation, "expectedNoteCount", 1_001)],
      ["wrong missing count", (value) => set(value.coverage, "missingOrStaleCount", 1)],
      [
        "complete has repair",
        (value) => set(value.coverage, "repairCandidates", [{ noteId: NOTE_B, currentRevision: 1 }])
      ],
      ["complete overflows", (value) => set(value.coverage, "repairOverflow", true)],
      ["bad coverage state", (value) => set(value.coverage, "status", "partial")],
      [
        "bad repair note",
        (value) => {
          set(value.generation, "expectedNoteCount", 2);
          set(value.coverage, "status", "incomplete");
          set(value.coverage, "missingOrStaleCount", 1);
          set(value.coverage, "repairCandidates", [{ noteId: "bad", currentRevision: 1 }]);
        }
      ],
      [
        "bad repair revision",
        (value) => {
          set(value.generation, "expectedNoteCount", 2);
          set(value.coverage, "status", "incomplete");
          set(value.coverage, "missingOrStaleCount", 1);
          set(value.coverage, "repairCandidates", [{ noteId: NOTE_B, currentRevision: 0 }]);
        }
      ],
      [
        "incomplete missing repair",
        (value) => {
          set(value.generation, "expectedNoteCount", 2);
          set(value.coverage, "status", "incomplete");
          set(value.coverage, "missingOrStaleCount", 1);
        }
      ],
      [
        "incomplete wrong overflow",
        (value) => {
          set(value.generation, "expectedNoteCount", 2);
          set(value.coverage, "status", "incomplete");
          set(value.coverage, "missingOrStaleCount", 1);
          set(value.coverage, "repairCandidates", [{ noteId: NOTE_B, currentRevision: 1 }]);
          set(value.coverage, "repairOverflow", true);
        }
      ],
      [
        "duplicate repair candidates",
        (value) => {
          set(value.generation, "expectedNoteCount", 3);
          set(value.coverage, "status", "incomplete");
          set(value.coverage, "missingOrStaleCount", 2);
          set(value.coverage, "repairCandidates", [
            { noteId: NOTE_B, currentRevision: 1 },
            { noteId: NOTE_B, currentRevision: 1 }
          ]);
        }
      ],
      ["extra coverage field", (value) => set(value.coverage, "covered", true)]
    ];
    for (const [, mutate] of mutations) {
      const value = pageResult();
      mutate(value);
      await expectContract(repositoryFor(value).repository.page(pageInput()));
    }
  });

  it("binds both cursor directions and rejects replay, ordering, and cursor drift", async () => {
    const previous = cursor(INDEX_A);
    const nextValue = pageResult({ items: [ragItem(INDEX_B, NOTE_B, 3)] });
    const accepted = repositoryFor(nextValue);
    await expect(
      accepted.repository.page(pageInput({ cursor: JSON.stringify(previous) }))
    ).resolves.toMatchObject({ status: "page" });
    expect(accepted.query.mock.calls[0]?.[0]?.values[4]).toEqual(previous);

    const nonterminal = pageResult({
      hasMore: true,
      nextCursor: cursor(INDEX_A)
    });
    await expect(repositoryFor(nonterminal).repository.page(pageInput())).resolves.toMatchObject({
      page: {
        nextCursor: JSON.stringify(cursor(INDEX_A))
      }
    });

    for (const value of [
      "not-json",
      JSON.stringify({ ...cursor(), searchId: OTHER_SEARCH_ID }),
      JSON.stringify({ ...cursor(), requestDigest: "d".repeat(64) }),
      JSON.stringify({ ...cursor(), generationId: `igen_${ULID_B}` }),
      JSON.stringify({ ...cursor(), generationRevisionToken: 8 }),
      JSON.stringify({ ...cursor(), afterIndexId: "bad" }),
      JSON.stringify({ ...cursor(), extra: true }),
      "x".repeat(4_097)
    ]) {
      const fixture = repositoryFor(pageResult());
      await expectContract(fixture.repository.page(pageInput({ cursor: value })));
      expect(fixture.query).not.toHaveBeenCalled();
    }

    const resultDrifts = [
      pageResult({ hasMore: true, nextCursor: cursor(INDEX_B) }),
      pageResult({ hasMore: false, nextCursor: cursor(INDEX_A) }),
      pageResult({ hasMore: true, nextCursor: null })
    ];
    for (const result of resultDrifts) {
      await expectContract(repositoryFor(result).repository.page(pageInput()));
    }
    await expectContract(
      repositoryFor(pageResult()).repository.page(pageInput({ cursor: JSON.stringify(previous) }))
    );
  });

  it("rejects page accounting, bounds, item order, and extra page fields", async () => {
    type Page = ReturnType<typeof pageResult>;
    const mutations: readonly [string, (value: Page) => void][] = [
      ["wrong limit", (value) => set(value.page, "limit", 1)],
      ["wrong byte budget", (value) => set(value.page, "ciphertextByteBudget", PAGE_BYTES + 1)],
      ["wrong returned count", (value) => set(value.page, "returnedCount", 0)],
      ["wrong ciphertext total", (value) => set(value.page, "ciphertextBytes", 15)],
      ["nonboolean hasMore", (value) => set(value.page, "hasMore", 1)],
      ["extra page field", (value) => set(value.page, "offset", 0)]
    ];
    for (const [, mutate] of mutations) {
      const value = pageResult();
      mutate(value);
      await expectContract(repositoryFor(value).repository.page(pageInput()));
    }

    const tooMany = pageResult({
      items: [ragItem(INDEX_A, NOTE_A), ragItem(INDEX_B, NOTE_B)],
      limit: 1
    });
    await expectContract(repositoryFor(tooMany).repository.page(pageInput({ limit: 1 })));
    for (const input of [
      pageInput({ limit: 0 }),
      pageInput({ limit: 51 }),
      pageInput({ maxBytes: PAGE_BYTES - 1 }),
      pageInput({ maxBytes: 8_388_609 })
    ]) {
      await expectContract(repositoryFor(pageResult()).repository.page(input));
    }

    const descending = pageResult({
      expectedNoteCount: 2,
      indexedNoteCount: 2,
      items: [ragItem(INDEX_B, NOTE_B), ragItem(INDEX_A, NOTE_A)]
    });
    await expectContract(repositoryFor(descending).repository.page(pageInput()));
  });

  it("verifies exact candidates and rejects malformed, duplicate, or drifted verification", async () => {
    const response = {
      searchId: SEARCH_ID,
      snapshotVerified: true,
      verifiedCandidateCount: 1,
      candidateDigest: CANDIDATE_DIGEST,
      generationRevisionToken: 7
    };
    const { query, repository } = repositoryFor(response);
    const candidates = [{ indexId: INDEX_A, noteId: NOTE_A, indexedRevision: 2 }];
    await expect(
      repository.verify({ claim: CLAIM, filterManifest: FILTER, candidates, signal: signal() })
    ).resolves.toEqual({ candidateDigest: CANDIDATE_DIGEST, verifiedCandidateCount: 1 });
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      text: SEARCH_RPC_SQL.verify,
      values: [SEARCH_ID, LEASE_TOKEN, REQUEST_DIGEST, FILTER, JSON.stringify(candidates)]
    });
    expect(query.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);

    const responseMutations: readonly [string, Record<string, unknown>][] = [
      ["wrong search", { searchId: OTHER_SEARCH_ID }],
      ["not verified", { snapshotVerified: false }],
      ["count drift", { verifiedCandidateCount: 0 }],
      ["bad digest", { candidateDigest: "short" }],
      ["generation drift", { generationRevisionToken: 8 }],
      ["extra key", { extra: true }]
    ];
    for (const [, change] of responseMutations) {
      await expectContract(
        repositoryFor({ ...response, ...change }).repository.verify({
          claim: CLAIM,
          filterManifest: FILTER,
          candidates,
          signal: signal()
        })
      );
    }

    const invalidCandidates = [
      [{ indexId: "bad", noteId: NOTE_A, indexedRevision: 2 }],
      [{ indexId: INDEX_A, noteId: "bad", indexedRevision: 2 }],
      [{ indexId: INDEX_A, noteId: NOTE_A, indexedRevision: 0 }],
      [
        { indexId: INDEX_A, noteId: NOTE_A, indexedRevision: 2 },
        { indexId: INDEX_A, noteId: NOTE_B, indexedRevision: 2 }
      ],
      [
        { indexId: INDEX_A, noteId: NOTE_A, indexedRevision: 2 },
        { indexId: INDEX_B, noteId: NOTE_A, indexedRevision: 2 }
      ]
    ];
    for (const invalid of invalidCandidates) {
      const fixture = repositoryFor(response);
      await expectContract(
        fixture.repository.verify({
          claim: CLAIM,
          filterManifest: FILTER,
          candidates: invalid,
          signal: signal()
        })
      );
      expect(fixture.query).not.toHaveBeenCalled();
    }
    const tooMany = Array.from({ length: 101 }, (_value, index) => ({
      indexId: index === 0 ? INDEX_A : `irw_${ULID_B}`,
      noteId: index === 0 ? NOTE_A : `note_${ULID_B}`,
      indexedRevision: 2
    }));
    await expectContract(
      repositoryFor(response).repository.verify({
        claim: CLAIM,
        filterManifest: FILTER,
        candidates: tooMany,
        signal: signal()
      })
    );
  });

  it("strictly parses terminal complete and fail responses", async () => {
    const completed = {
      searchId: SEARCH_ID,
      state: "completed",
      completedAt: LATER,
      candidateDigest: CANDIDATE_DIGEST
    };
    const completion = repositoryFor(completed);
    await expect(
      completion.repository.complete({
        claim: CLAIM,
        candidateDigest: CANDIDATE_DIGEST,
        signal: signal()
      })
    ).resolves.toBeUndefined();
    expect(completion.query.mock.calls[0]?.[0]).toMatchObject({
      text: SEARCH_RPC_SQL.complete,
      values: [SEARCH_ID, LEASE_TOKEN, REQUEST_DIGEST]
    });
    expect(completion.query.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);

    for (const change of [
      { searchId: OTHER_SEARCH_ID },
      { state: "leased" },
      { completedAt: "today" },
      { candidateDigest: "d".repeat(64) },
      { extra: true }
    ]) {
      await expectContract(
        repositoryFor({ ...completed, ...change }).repository.complete({
          claim: CLAIM,
          candidateDigest: CANDIDATE_DIGEST,
          signal: signal()
        })
      );
    }

    const failed = {
      searchId: SEARCH_ID,
      state: "failed",
      failedAt: LATER,
      failureCode: "provider_unavailable"
    };
    const failure = repositoryFor(failed);
    await expect(
      failure.repository.fail({
        claim: CLAIM,
        failureCode: "provider_unavailable",
        signal: signal()
      })
    ).resolves.toBeUndefined();
    expect(failure.query.mock.calls[0]?.[0]).toMatchObject({
      text: SEARCH_RPC_SQL.fail,
      values: [SEARCH_ID, LEASE_TOKEN, REQUEST_DIGEST, "provider_unavailable"]
    });
    expect(failure.query.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);

    for (const change of [
      { searchId: OTHER_SEARCH_ID },
      { state: "leased" },
      { failedAt: "today" },
      { failureCode: "validation_failed" },
      { extra: true }
    ]) {
      await expectContract(
        repositoryFor({ ...failed, ...change }).repository.fail({
          claim: CLAIM,
          failureCode: "provider_unavailable",
          signal: signal()
        })
      );
    }
  });

  it("does not execute pre-aborted operations and rejects post-query abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const pre = repositoryFor(claimResult());
    await expect(
      pre.repository.claim(claimInput({ signal: controller.signal }))
    ).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(pre.query).not.toHaveBeenCalled();

    const after = new AbortController();
    const query = vi.fn<SearchDatabaseExecutor["query"]>(() => {
      after.abort();
      return Promise.resolve({ rows: [{ result: claimResult() }] });
    });
    await expect(
      createEncryptedUserSearchRepository({ query }).claim(claimInput({ signal: after.signal }))
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
