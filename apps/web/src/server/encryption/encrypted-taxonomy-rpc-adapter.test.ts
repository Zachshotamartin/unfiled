import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import type { EncryptedFieldRpcValue, KeyedMacRpcValue } from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedTaxonomyRpcAdapter,
  encryptedTaxonomyWriteRpcFunctions,
  type EncryptedTaxonomyCommand,
  type IncompleteEncryptedTaxonomyWriteClaim
} from "./encrypted-taxonomy-rpc-adapter";
import { ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SPACE = `spc_${"0".repeat(26)}` as const;
const KEY = "taxonomy-request-1";
const OCCURRED_AT = "2026-08-30T22:54:12.345+00:00";
const RESERVATION = "80000000-0000-4000-8000-000000000001";

function mac(seed = "a"): KeyedMacRpcValue {
  return Object.freeze({
    mac: seed.repeat(64),
    keyId: "private-mac-v1",
    keyClass: "private_manual",
    keyPurpose: "content_mac",
    keyVersion: 1
  });
}

function envelope(
  resourceId: string,
  recordVersion: number,
  kind: "space_display" | "idempotency_response",
  ownerId = OWNER
): ContentEnvelopeV1 {
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: "private-wrap-v1",
    context: Object.freeze({ tenantId: ownerId, resourceId, recordVersion, kind }),
    wrappedDataKey: Object.freeze({ nonce: "A".repeat(16), ciphertext: "a".repeat(64) }),
    payload: Object.freeze({ nonce: "B".repeat(16), ciphertext: "b".repeat(64) })
  });
}

function cipher<Kind extends "space_display" | "idempotency_response">(
  kind: Kind,
  resourceId: string,
  recordVersion: number
): EncryptedFieldRpcValue<Kind> {
  return Object.freeze({
    envelope: envelope(resourceId, recordVersion, kind),
    keyId: "private-wrap-v1",
    keyClass: "private_manual",
    keyPurpose: "object_wrap",
    keyVersion: 1,
    reservationId: RESERVATION
  });
}

function stored(value: EncryptedFieldRpcValue<"idempotency_response">) {
  return {
    envelope: value.envelope,
    keyId: value.keyId,
    keyClass: value.keyClass,
    keyPurpose: value.keyPurpose,
    keyVersion: value.keyVersion
  };
}

function claim(): IncompleteEncryptedTaxonomyWriteClaim {
  return Object.freeze({
    ownerId: OWNER,
    idempotencyKey: KEY,
    scope: "create_space",
    resourceId: SPACE,
    expectedRevision: 0,
    occurredAt: OCCURRED_AT,
    requestMacKey: Object.freeze({
      keyId: "private-mac-v1",
      keyClass: "private_manual",
      keyPurpose: "content_mac",
      keyVersion: 1
    }),
    completed: false,
    encryptedResponse: null
  });
}

function claimProjection() {
  const value = claim();
  return {
    scope: value.scope,
    resourceId: value.resourceId,
    expectedRevision: value.expectedRevision,
    occurredAt: value.occurredAt,
    requestMacKey: value.requestMacKey,
    completed: false,
    encryptedResponse: null
  };
}

function command(): EncryptedTaxonomyCommand {
  return Object.freeze({
    scope: "create_space",
    occurredAt: OCCURRED_AT,
    parentId: null,
    sortKey: "a0",
    archivedAt: null,
    display: Object.freeze({
      cipher: cipher("space_display", SPACE, 1),
      semanticMac: mac("b"),
      verificationMac: mac("c")
    }),
    requestMac: mac(),
    responseCipher: cipher("idempotency_response", `idempotency:${KEY}`, 1),
    responseVerificationMac: mac("d")
  });
}

describe("encrypted taxonomy RPC adapter", () => {
  it("exposes exactly the three scoped command functions", () => {
    expect(encryptedTaxonomyWriteRpcFunctions).toEqual([
      "get_encrypted_taxonomy_write_claim",
      "prepare_encrypted_taxonomy_write",
      "commit_encrypted_taxonomy_write"
    ]);
    expect(Object.isFrozen(encryptedTaxonomyWriteRpcFunctions)).toBe(true);
  });

  it("normalizes the exact claim, prepare, and commit protocol", async () => {
    const responseCipher = cipher("idempotency_response", `idempotency:${KEY}`, 1);
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name) => {
      if (name === "get_encrypted_taxonomy_write_claim") {
        return Promise.resolve({ found: false });
      }
      if (name === "prepare_encrypted_taxonomy_write") {
        return Promise.resolve({ ...claimProjection(), replayed: false });
      }
      return Promise.resolve({
        resourceId: SPACE,
        currentRevision: 1,
        encryptedResponse: stored(responseCipher),
        replayed: false
      });
    });
    const adapter = createEncryptedTaxonomyRpcAdapter(Object.freeze({ rpc }));

    await expect(
      adapter.getWriteClaim({ ownerId: OWNER, scope: "create_space", idempotencyKey: KEY })
    ).resolves.toBeNull();
    const prepared = await adapter.prepareWrite({
      ownerId: OWNER,
      scope: "create_space",
      idempotencyKey: KEY,
      resourceId: null,
      expectedRevision: 0,
      requestMac: mac()
    });
    if (prepared.claim.completed) throw new TypeError("expected incomplete claim");
    await expect(
      adapter.commitWrite({ claim: prepared.claim, command: command() })
    ).resolves.toMatchObject({ resourceId: SPACE, currentRevision: 1, replayed: false });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(encryptedTaxonomyWriteRpcFunctions);
    expect(rpc.mock.calls[2]?.[1]).toEqual({
      p_owner_id: OWNER,
      p_scope: "create_space",
      p_idempotency_key: KEY,
      p_resource_id: SPACE,
      p_expected_revision: 0,
      p_command: command()
    });
  });

  it("rejects provider claim projection drift without reflecting it", async () => {
    const canary = "plaintext display should never escape";
    const adapter = createEncryptedTaxonomyRpcAdapter(
      Object.freeze({
        rpc: () => Promise.resolve({ found: true, ...claimProjection(), plaintext: canary })
      })
    );
    const error = await adapter
      .getWriteClaim({ ownerId: OWNER, scope: "create_space", idempotencyKey: KEY })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    expect(String(error)).not.toContain(canary);
  });

  it("rejects a command whose display cipher is bound to another owner before RPC", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const adapter = createEncryptedTaxonomyRpcAdapter(Object.freeze({ rpc }));
    const valid = command();
    if (!("display" in valid)) throw new TypeError("expected display command");
    const tampered = {
      ...valid,
      display: {
        ...valid.display,
        cipher: {
          ...valid.display.cipher,
          envelope: envelope(SPACE, 1, "space_display", "22222222-2222-4222-8222-222222222222")
        }
      }
    } as EncryptedTaxonomyCommand;
    const error = await adapter
      .commitWrite({ claim: claim(), command: tampered })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a success response that substitutes a different encrypted envelope", async () => {
    const submitted = command();
    const substituted = cipher("idempotency_response", `idempotency:${KEY}`, 1);
    const adapter = createEncryptedTaxonomyRpcAdapter(
      Object.freeze({
        rpc: () =>
          Promise.resolve({
            resourceId: SPACE,
            currentRevision: 1,
            encryptedResponse: {
              ...stored(substituted),
              envelope: {
                ...substituted.envelope,
                payload: { ...substituted.envelope.payload, ciphertext: "z".repeat(64) }
              }
            },
            replayed: false
          })
      })
    );
    await expect(adapter.commitWrite({ claim: claim(), command: submitted })).rejects.toMatchObject(
      {
        code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
      }
    );
  });
});
