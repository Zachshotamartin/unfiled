import { describe, expect, it } from "vitest";

import { ServiceRpcError } from "./service-rpc-client";
import { parseEncryptedStorageContractState } from "./encrypted-storage-contract-state";

describe("parseEncryptedStorageContractState", () => {
  it.each([
    {
      schemaVersion: 1,
      state: "expand_compatible",
      appliedAt: null
    },
    {
      schemaVersion: 1,
      state: "contracted",
      appliedAt: "2026-08-30T11:59:00.000Z"
    }
  ] as const)("accepts the exact $state projection", (projection) => {
    expect(parseEncryptedStorageContractState(projection)).toEqual(projection);
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, state: "expand_compatible", appliedAt: null },
    { schemaVersion: 1, state: "unknown", appliedAt: null },
    { schemaVersion: 1, state: "contracted", appliedAt: null },
    {
      schemaVersion: 1,
      state: "expand_compatible",
      appliedAt: "2026-08-30T11:59:00.000Z"
    },
    { schemaVersion: 1, state: "contracted", appliedAt: "not-a-date" },
    {
      schemaVersion: 1,
      state: "contracted",
      appliedAt: "2026-08-30T11:59:00.000Z",
      ownerId: "must-not-be-present"
    }
  ])("rejects malformed or expanded projections: %o", (projection) => {
    expect(() => parseEncryptedStorageContractState(projection)).toThrow(ServiceRpcError);
  });
});
