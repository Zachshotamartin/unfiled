import { describe, expect, it } from "vitest";

import {
  ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  USER_HYBRID_SEARCH_RANKING_VERSION,
  type EncryptedUserSearchInvocation,
  type EncryptedUserSearchMaterial
} from "@unfiled/contracts";

import {
  encryptedUserSearchRequestDigest,
  hasValidEncryptedUserSearchDigest
} from "../src/material.js";

const material: EncryptedUserSearchMaterial = {
  requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
  query: "Roosevelt method",
  filters: {
    archive: "exclude" as const,
    privacy: "ai_assisted" as const,
    type: "principle" as const,
    space: { mode: "any" as const, id: null },
    tagIds: [],
    updatedFrom: null,
    updatedTo: null
  },
  pageLimit: 9,
  maxResults: 8,
  continuation: null
};

describe("search request material digest", () => {
  it("uses the canonical cross-service SHA-256 bytes", () => {
    expect(encryptedUserSearchRequestDigest(material)).toBe(
      "6c461f0fd3151519baba4b4013d40d09d60f4718c3f3ba083a3c4796e6446e77"
    );
    expect(encryptedUserSearchRequestDigest({ ...material, pageLimit: 100 })).toBe(
      "9546e45a121b3f4299ee52baf6f7e9c8819c3fe7b0e6590c3b838619102663f4"
    );
  });

  it("compares the complete digest and rejects any material drift", () => {
    const invocation: EncryptedUserSearchInvocation = {
      searchId: "11111111-1111-4111-8111-111111111111",
      claimSecret: "A".repeat(43),
      requestDigest: encryptedUserSearchRequestDigest(material),
      material
    };
    expect(hasValidEncryptedUserSearchDigest(invocation)).toBe(true);
    expect(
      hasValidEncryptedUserSearchDigest({
        ...invocation,
        material: { ...material, query: "Roosevelt method changed" }
      })
    ).toBe(false);
    expect(
      hasValidEncryptedUserSearchDigest({
        ...invocation,
        material: {
          ...material,
          continuation: {
            generationBindingDigest: "b".repeat(64),
            rankingVersion: "encrypted-semantic-rank-v1",
            resultDigest: "c".repeat(64),
            boundary: null
          }
        }
      })
    ).toBe(false);
  });
});
