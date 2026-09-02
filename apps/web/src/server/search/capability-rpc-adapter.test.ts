import { describe, expect, it, vi } from "vitest";

import type { EncryptedUserSearchFilterManifest } from "@unfiled/contracts";

import type { ServiceRpcClient } from "@/server/encryption/service-rpc-client";

import {
  createEncryptedUserSearchCapabilityRpcAdapter,
  encryptedUserSearchCapabilityRpcFunctions
} from "./capability-rpc-adapter";
import { EncryptedUserSearchError } from "./errors";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const SEARCH_ID = "00000000-0000-4000-8000-000000000002";
const REQUEST_DIGEST = "a".repeat(64);
const CLAIM_SECRET_DIGEST = "b".repeat(64);
const FILTER_DIGEST = "c".repeat(64);
const ATTESTATION_DIGEST = "d".repeat(64);
const FILTERS: EncryptedUserSearchFilterManifest = {
  archive: "exclude" as const,
  privacy: "ai_assisted" as const,
  type: null,
  space: { mode: "any" as const, id: null },
  tagIds: [],
  updatedFrom: null,
  updatedTo: null
};

function response(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    searchId: SEARCH_ID,
    claimExpiresAt: "2026-09-01T20:00:30.000Z",
    requestDigest: REQUEST_DIGEST,
    filterDigest: FILTER_DIGEST,
    generation: {
      generationId: `igen_${"0".repeat(26)}`,
      revisionToken: 7,
      attestationDigest: ATTESTATION_DIGEST,
      embeddingModelId: "text-embedding-3-small",
      embeddingDimensions: 1_536,
      envelopeSchemaVersion: 1
    },
    ...overrides
  };
}

describe("encrypted user-search capability RPC adapter", () => {
  it("uses the service-role-only function with exact parameters", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(response());
    const adapter = createEncryptedUserSearchCapabilityRpcAdapter({ rpc });

    await expect(
      adapter.begin({
        ownerId: OWNER_ID.toUpperCase(),
        requestDigest: REQUEST_DIGEST,
        filterManifest: FILTERS,
        claimSecretDigest: CLAIM_SECRET_DIGEST
      })
    ).resolves.toEqual({
      ...response(),
      generation: { ...response().generation, revisionToken: "7" }
    });

    expect(encryptedUserSearchCapabilityRpcFunctions).toEqual(["begin_encrypted_user_search"]);
    expect(rpc).toHaveBeenCalledWith("begin_encrypted_user_search", {
      p_owner_id: OWNER_ID,
      p_request_digest: REQUEST_DIGEST,
      p_filter_manifest: FILTERS,
      p_claim_secret_digest: CLAIM_SECRET_DIGEST
    });
  });

  it("rejects owner-bearing, replay-marked, substituted, and malformed projections", async () => {
    const cases: readonly unknown[] = [
      { ...response(), ownerId: OWNER_ID },
      { ...response(), replayed: true },
      response({ requestDigest: "d".repeat(64) }),
      response({ searchId: "not-a-uuid" }),
      response({ claimExpiresAt: "private-query-canary" }),
      response({ generation: { ...response().generation, revisionToken: "7" } }),
      response({ generation: { ...response().generation, attestationDigest: "invalid" } }),
      response({ generation: { ...response().generation, privateRootKeyId: "private-canary" } })
    ];

    for (const projection of cases) {
      const adapter = createEncryptedUserSearchCapabilityRpcAdapter({
        rpc: vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection)
      });
      const reason = await adapter
        .begin({
          ownerId: OWNER_ID,
          requestDigest: REQUEST_DIGEST,
          filterManifest: FILTERS,
          claimSecretDigest: CLAIM_SECRET_DIGEST
        })
        .catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(EncryptedUserSearchError);
      expect(String(reason)).not.toContain("private-query-canary");
      expect(Object.keys(reason as object)).toEqual(["name"]);
    }
  });

  it("rejects invalid inputs before calling the database and redacts database failures", async () => {
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockRejectedValue(new Error("private-query-canary database error"));
    const adapter = createEncryptedUserSearchCapabilityRpcAdapter({ rpc });

    await expect(
      adapter.begin({
        ownerId: "not-an-owner",
        requestDigest: REQUEST_DIGEST,
        filterManifest: FILTERS,
        claimSecretDigest: CLAIM_SECRET_DIGEST
      })
    ).rejects.toBeInstanceOf(EncryptedUserSearchError);
    expect(rpc).not.toHaveBeenCalled();

    const reason = await adapter
      .begin({
        ownerId: OWNER_ID,
        requestDigest: REQUEST_DIGEST,
        filterManifest: FILTERS,
        claimSecretDigest: CLAIM_SECRET_DIGEST
      })
      .catch((error: unknown) => error);
    expect(reason).toBeInstanceOf(EncryptedUserSearchError);
    expect(String(reason)).not.toContain("private-query-canary");
  });
});
