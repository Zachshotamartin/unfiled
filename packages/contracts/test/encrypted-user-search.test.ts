import { describe, expect, it } from "vitest";

import {
  ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  EncryptedUserSearchContinuationSchema,
  EncryptedUserSearchFilterManifestSchema,
  EncryptedUserSearchInvocationSchema,
  EncryptedUserSearchMaterialSchema,
  EncryptedUserSearchResultSchema,
  SearchNotesRequestSchema,
  USER_HYBRID_SEARCH_RANKING_VERSION,
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  encryptedUserSearchGenerationBindingDigest,
  encryptedUserSearchMaterialFromRequest,
  encryptedUserSearchResultDigest,
  serializeEncryptedUserSearchMaterial
} from "../src/search.js";

const SPACE = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const TAG_A = "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const TAG_B = "tag_01J6M9Q7G4BMKB33GSG3NJ6D1Y";

describe("encrypted user-search trust contract", () => {
  it("canonicalizes every semantic filter and sorts conjunctive tags", () => {
    const request = SearchNotesRequestSchema.parse({
      query: "  Roosevelt method  ",
      archive: "include",
      privacy: "ai_assisted",
      type: "principle",
      spaceId: SPACE,
      tagIds: [TAG_B, TAG_A],
      updatedFrom: "2026-08-01T00:00:00.000Z",
      updatedTo: "2026-09-01T00:00:00.000Z",
      limit: 30
    });
    const material = encryptedUserSearchMaterialFromRequest(request);
    if (material === null) throw new Error("expected semantic material");

    expect(material).toEqual({
      requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
      hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
      query: "Roosevelt method",
      filters: {
        archive: "include",
        privacy: "ai_assisted",
        type: "principle",
        space: { mode: "exact", id: SPACE },
        tagIds: [TAG_A, TAG_B],
        updatedFrom: "2026-08-01T00:00:00.000Z",
        updatedTo: "2026-09-01T00:00:00.000Z"
      },
      pageLimit: 30,
      maxResults: 8,
      continuation: null
    });
    expect(serializeEncryptedUserSearchMaterial(material)).toBe(
      `{"requestVersion":"encrypted-user-search-request-v1","hybridRankingVersion":"encrypted-hybrid-rank-v1","query":"Roosevelt method","filters":{"archive":"include","privacy":"ai_assisted","type":"principle","space":{"mode":"exact","id":"${SPACE}"},"tagIds":["${TAG_A}","${TAG_B}"],"updatedFrom":"2026-08-01T00:00:00.000Z","updatedTo":"2026-09-01T00:00:00.000Z"},"pageLimit":30,"maxResults":8,"continuation":null}`
    );
  });

  it("requires an exact semantic continuation shape", () => {
    const continuation = {
      generationBindingDigest: "a".repeat(64),
      rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
      resultDigest: "b".repeat(64),
      boundary: {
        score: 0.75,
        noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        indexedRevision: 2
      }
    } as const;
    expect(EncryptedUserSearchContinuationSchema.safeParse(continuation).success).toBe(true);
    expect(
      EncryptedUserSearchContinuationSchema.safeParse({ ...continuation, extra: true }).success
    ).toBe(false);
    expect(
      EncryptedUserSearchContinuationSchema.safeParse({
        ...continuation,
        rankingVersion: "semantic-rank-v0"
      }).success
    ).toBe(false);
    expect(
      EncryptedUserSearchContinuationSchema.safeParse({
        ...continuation,
        boundary: { ...continuation.boundary, score: 1.21 }
      }).success
    ).toBe(false);
  });

  it("produces stable framed generation and ordered-result digests", async () => {
    const generationBindingDigest = await encryptedUserSearchGenerationBindingDigest({
      generationId: "igen_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      generationRevisionToken: "generation-token",
      generationAttestationDigest: "a".repeat(64)
    });
    expect(generationBindingDigest).toBe(
      "8cad2e6541c87b5d4d51298e2d057d420e47ac0c6df0e43358c2bc126b210318"
    );
    await expect(
      encryptedUserSearchResultDigest({
        generationBindingDigest,
        rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
        items: [
          {
            score: 0.75,
            noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            indexedRevision: 2
          },
          {
            score: 0.5,
            noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
            indexedRevision: 7
          }
        ]
      })
    ).resolves.toBe("8d2a5a425069c4fcc3204479289fa78c9ca130e535787ce16173ff27f57c6a3e");
  });

  it("never creates semantic material for default or private-manual search", () => {
    expect(
      encryptedUserSearchMaterialFromRequest(SearchNotesRequestSchema.parse({ query: "private" }))
    ).toBeNull();
    expect(
      encryptedUserSearchMaterialFromRequest(
        SearchNotesRequestSchema.parse({ query: "private", privacy: "private_manual" })
      )
    ).toBeNull();
  });

  it("keeps page size exact while fixing the semantic ranking set at eight", () => {
    const material = encryptedUserSearchMaterialFromRequest(
      SearchNotesRequestSchema.parse({ query: "private", privacy: "ai_assisted", limit: 1 })
    );
    if (material === null) throw new Error("expected semantic material");
    expect(material).toMatchObject({
      pageLimit: 1,
      maxResults: 8,
      requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
      hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION
    });
    expect(
      EncryptedUserSearchMaterialSchema.safeParse({ ...material, maxResults: 7 }).success
    ).toBe(false);
    expect(
      EncryptedUserSearchMaterialSchema.safeParse({
        ...material,
        requestVersion: "encrypted-user-search-request-v0"
      }).success
    ).toBe(false);
  });

  it("rejects noncanonical filters and malformed capability invocations", () => {
    const filters = {
      archive: "exclude",
      privacy: "ai_assisted",
      type: null,
      space: { mode: "any", id: null },
      tagIds: [TAG_B, TAG_A],
      updatedFrom: null,
      updatedTo: null
    } as const;
    expect(EncryptedUserSearchFilterManifestSchema.safeParse(filters).success).toBe(false);
    expect(
      EncryptedUserSearchFilterManifestSchema.safeParse({
        ...filters,
        tagIds: [],
        space: { mode: "exact", id: null }
      }).success
    ).toBe(false);
    expect(
      EncryptedUserSearchInvocationSchema.safeParse({
        searchId: "00000000-0000-4000-8000-000000000001",
        claimSecret: "too-short",
        requestDigest: "0".repeat(64),
        material: {
          requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
          hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
          query: "valid",
          filters: { ...filters, tagIds: [] },
          pageLimit: 30,
          maxResults: 8,
          continuation: null
        }
      }).success
    ).toBe(false);
  });

  it("bounds semantic results to the encrypted generation capacity", () => {
    const item = {
      noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      indexedRevision: 2,
      score: 1.2
    } as const;
    expect(
      EncryptedUserSearchResultSchema.safeParse({
        searchId: "00000000-0000-4000-8000-000000000001",
        generationId: "igen_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        generationAttestationDigest: "a".repeat(64),
        generationRevisionToken: "generation-token",
        rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
        items: Array.from({ length: 8 }, () => item),
        scannedNoteCount: 1_000
      }).success
    ).toBe(true);
    expect(
      EncryptedUserSearchResultSchema.safeParse({
        searchId: "00000000-0000-4000-8000-000000000001",
        generationId: "igen_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        generationAttestationDigest: "a".repeat(64),
        generationRevisionToken: "generation-token",
        rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
        items: Array.from({ length: 9 }, () => item),
        scannedNoteCount: 1_001
      }).success
    ).toBe(false);
  });
});
