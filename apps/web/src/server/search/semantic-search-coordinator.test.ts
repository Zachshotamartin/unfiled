import { createHash } from "node:crypto";

import {
  ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  USER_HYBRID_SEARCH_RANKING_VERSION,
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  serializeEncryptedUserSearchMaterial,
  type EncryptedUserSearchMaterial,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  BegunEncryptedUserSearch,
  EncryptedUserSearchCapabilityRpcAdapter
} from "./capability-rpc-adapter";
import { EncryptedUserSearchError } from "./errors";
import type { EncryptedUserSearchClient } from "./search-client";
import { SemanticSearchCoordinator } from "./semantic-search-coordinator";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const SEARCH_ID = "00000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-09-01T20:00:00.000Z");
const GENERATION_ID = `igen_${"0".repeat(26)}`;
const ATTESTATION_DIGEST = "a".repeat(64);
const SECRET_SEED = 9;

function material(
  overrides: Partial<EncryptedUserSearchMaterial> = {}
): EncryptedUserSearchMaterial {
  return {
    requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
    hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
    query: "semantic-query-canary",
    filters: {
      archive: "exclude",
      privacy: "ai_assisted",
      type: null,
      space: { mode: "any", id: null },
      tagIds: [],
      updatedFrom: null,
      updatedTo: null
    },
    pageLimit: 30,
    maxResults: 8,
    continuation: null,
    ...overrides
  };
}

function begun(overrides: Partial<BegunEncryptedUserSearch> = {}): BegunEncryptedUserSearch {
  return {
    searchId: SEARCH_ID,
    claimExpiresAt: "2026-09-01T20:00:30.000Z",
    requestDigest: createHash("sha256")
      .update(serializeEncryptedUserSearchMaterial(material()), "utf8")
      .digest("hex"),
    filterDigest: "f".repeat(64),
    generation: {
      generationId: GENERATION_ID,
      revisionToken: "7",
      attestationDigest: ATTESTATION_DIGEST,
      embeddingModelId: "text-embedding-3-small",
      embeddingDimensions: 1_536,
      envelopeSchemaVersion: 1
    },
    ...overrides
  };
}

function result(overrides: Partial<EncryptedUserSearchResult> = {}): EncryptedUserSearchResult {
  return {
    searchId: SEARCH_ID,
    generationId: GENERATION_ID,
    generationAttestationDigest: ATTESTATION_DIGEST,
    generationRevisionToken: "7",
    rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
    items: [],
    scannedNoteCount: 0,
    ...overrides
  };
}

function dependencies(overrides: {
  begin?: EncryptedUserSearchCapabilityRpcAdapter["begin"];
  query?: EncryptedUserSearchClient["query"];
  randomBytes?: (size: number) => Buffer;
  utf8Bytes?: (value: string) => Buffer;
}) {
  return {
    ownerId: OWNER_ID,
    capability: {
      begin: overrides.begin ?? vi.fn().mockResolvedValue(begun())
    },
    client: {
      query: overrides.query ?? vi.fn().mockResolvedValue(result())
    },
    now: () => NOW,
    randomBytes: overrides.randomBytes ?? (() => Buffer.alloc(32, SECRET_SEED)),
    ...(overrides.utf8Bytes === undefined ? {} : { utf8Bytes: overrides.utf8Bytes })
  };
}

describe("semantic-search coordinator", () => {
  it("hashes canonical material, mints one ticket, and sends no owner to search", async () => {
    const begin = vi.fn<EncryptedUserSearchCapabilityRpcAdapter["begin"]>();
    const query = vi.fn<EncryptedUserSearchClient["query"]>().mockResolvedValue(result());
    const input = material();
    const serialized = serializeEncryptedUserSearchMaterial(input);
    const requestDigest = createHash("sha256").update(serialized, "utf8").digest("hex");
    const claimSecret = Buffer.alloc(32, SECRET_SEED).toString("base64url");
    const claimSecretDigest = createHash("sha256").update(claimSecret, "utf8").digest("hex");
    begin.mockResolvedValue(begun({ requestDigest }));
    const coordinator = new SemanticSearchCoordinator(dependencies({ begin, query }));

    await expect(coordinator.search(input)).resolves.toEqual(result());
    expect(begin).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      requestDigest,
      filterManifest: input.filters,
      claimSecretDigest
    });
    expect(query).toHaveBeenCalledOnce();
    const [invocation, signal] = query.mock.calls[0] ?? [];
    expect(invocation).toEqual({
      searchId: SEARCH_ID,
      claimSecret,
      requestDigest,
      material: input
    });
    expect(Object.keys(invocation as object)).toEqual([
      "searchId",
      "claimSecret",
      "requestDigest",
      "material"
    ]);
    expect(JSON.stringify(invocation)).not.toContain(OWNER_ID);
    expect(signal).toBeUndefined();
  });

  it("keeps the digest stable while binding every material filter", async () => {
    const digests: string[] = [];
    const begin = vi.fn<EncryptedUserSearchCapabilityRpcAdapter["begin"]>((input) => {
      digests.push(input.requestDigest);
      return Promise.resolve(begun({ requestDigest: input.requestDigest }));
    });
    const coordinator = new SemanticSearchCoordinator(dependencies({ begin }));
    const sameWithDifferentInsertionOrder = {
      requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
      hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
      maxResults: 8,
      pageLimit: 30,
      filters: {
        updatedTo: null,
        tagIds: [],
        privacy: "ai_assisted",
        space: { id: null, mode: "any" },
        archive: "exclude",
        updatedFrom: null,
        type: null
      },
      query: "semantic-query-canary",
      continuation: null
    } as EncryptedUserSearchMaterial;

    await coordinator.search(material());
    await coordinator.search(sameWithDifferentInsertionOrder);
    for (const changed of [
      material({ query: "changed query" }),
      material({ pageLimit: 31 }),
      material({ filters: { ...material().filters, archive: "include" } }),
      material({ filters: { ...material().filters, type: "project" } }),
      material({
        filters: {
          ...material().filters,
          space: { mode: "exact", id: `spc_${"0".repeat(26)}` }
        }
      }),
      material({
        filters: { ...material().filters, tagIds: [`tag_${"0".repeat(26)}`] }
      }),
      material({
        filters: { ...material().filters, updatedFrom: "2026-08-01T00:00:00.000Z" }
      }),
      material({
        filters: { ...material().filters, updatedTo: "2026-09-01T00:00:00.000Z" }
      })
    ]) {
      await coordinator.search(changed);
    }

    expect(digests[0]).toBe(digests[1]);
    expect(new Set(digests).size).toBe(digests.length - 1);
  });

  it("makes mixed and private-manual material impossible at runtime", async () => {
    const begin = vi.fn<EncryptedUserSearchCapabilityRpcAdapter["begin"]>();
    const query = vi.fn<EncryptedUserSearchClient["query"]>();
    const coordinator = new SemanticSearchCoordinator(dependencies({ begin, query }));

    for (const privacy of [undefined, "mixed", "private_manual"] as const) {
      const input = material({
        filters: { ...material().filters, privacy }
      } as unknown as Partial<EncryptedUserSearchMaterial>);
      await expect(coordinator.search(input)).rejects.toBeInstanceOf(EncryptedUserSearchError);
    }
    expect(begin).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects expired/substituted tickets and replay-looking generation results", async () => {
    const requestDigest = createHash("sha256")
      .update(serializeEncryptedUserSearchMaterial(material()), "utf8")
      .digest("hex");
    const cases: readonly BegunEncryptedUserSearch[] = [
      begun({ requestDigest: "b".repeat(64) }),
      begun({ requestDigest, claimExpiresAt: "2026-09-01T20:00:00.000Z" }),
      begun({ requestDigest, claimExpiresAt: "2026-09-01T20:01:00.000Z" })
    ];
    for (const ticket of cases) {
      const query = vi.fn<EncryptedUserSearchClient["query"]>();
      const coordinator = new SemanticSearchCoordinator(
        dependencies({ begin: vi.fn().mockResolvedValue(ticket), query })
      );
      await expect(coordinator.search(material())).rejects.toBeInstanceOf(EncryptedUserSearchError);
      expect(query).not.toHaveBeenCalled();
    }

    for (const substituted of [
      result({ generationId: `igen_${"1".repeat(26)}` }),
      result({ generationRevisionToken: "6" }),
      result({ generationAttestationDigest: "b".repeat(64) }),
      {
        ...result(),
        rankingVersion: "encrypted-semantic-rank-substituted"
      } as unknown as EncryptedUserSearchResult
    ]) {
      const coordinator = new SemanticSearchCoordinator(
        dependencies({ query: vi.fn().mockResolvedValue(substituted) })
      );
      await expect(coordinator.search(material())).rejects.toBeInstanceOf(EncryptedUserSearchError);
    }
  });

  it("zeroes every mutable secret and material buffer on success and failure", async () => {
    for (const query of [
      vi.fn<EncryptedUserSearchClient["query"]>().mockResolvedValue(result()),
      vi
        .fn<EncryptedUserSearchClient["query"]>()
        .mockRejectedValue(new Error("semantic-query-canary provider failure"))
    ]) {
      const secret = Buffer.alloc(32, SECRET_SEED);
      const encoded: Buffer[] = [];
      const coordinator = new SemanticSearchCoordinator(
        dependencies({
          query,
          randomBytes: () => secret,
          utf8Bytes(value) {
            const buffer = Buffer.from(value, "utf8");
            encoded.push(buffer);
            return buffer;
          }
        })
      );

      await coordinator.search(material()).catch(() => undefined);
      expect([...secret]).toEqual(new Array<number>(32).fill(0));
      expect(encoded).toHaveLength(2);
      for (const buffer of encoded) {
        expect([...buffer]).toEqual(new Array<number>(buffer.byteLength).fill(0));
      }
    }
  });

  it("uses one redacted failure for dependency errors and pre-cancellation", async () => {
    const begin = vi
      .fn<EncryptedUserSearchCapabilityRpcAdapter["begin"]>()
      .mockRejectedValue(new Error("semantic-query-canary database failure"));
    const coordinator = new SemanticSearchCoordinator(dependencies({ begin }));
    const reason = await coordinator.search(material()).catch((error: unknown) => error);
    expect(reason).toBeInstanceOf(EncryptedUserSearchError);
    expect(String(reason)).not.toContain("semantic-query-canary");

    const controller = new AbortController();
    controller.abort();
    await expect(coordinator.search(material(), controller.signal)).rejects.toBeInstanceOf(
      EncryptedUserSearchError
    );
    expect(begin).toHaveBeenCalledOnce();
  });
});
