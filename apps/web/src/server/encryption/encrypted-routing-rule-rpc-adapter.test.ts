import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import type {
  AggregateContentKind,
  EncryptedFieldRpcValue,
  KeyedMacRpcValue
} from "@unfiled/encrypted-aggregate";
import type { ManagedKeyRecordV1 } from "@unfiled/key-management";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedRoutingRuleRpcAdapter,
  encryptedRoutingRuleRpcFunctions,
  type PreparedEncryptedRoutingRuleWrite
} from "./encrypted-routing-rule-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER = "11111111-1111-4111-8111-111111111111";
const RULE = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const AT = "2026-09-01T18:00:00.123Z";
const RESERVATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function envelope(
  kind: AggregateContentKind,
  resourceId: string,
  recordVersion = 1
): ContentEnvelopeV1 {
  return {
    version: 1,
    suite: "A256GCM",
    keyId: "private-wrap-v1",
    context: { tenantId: OWNER, resourceId, recordVersion, kind },
    wrappedDataKey: { nonce: "A".repeat(16), ciphertext: "a".repeat(64) },
    payload: { nonce: "B".repeat(16), ciphertext: "b".repeat(64) }
  };
}

function cipher<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  reservationId: string,
  recordVersion = 1
): EncryptedFieldRpcValue<Kind> {
  return {
    envelope: envelope(kind, resourceId, recordVersion),
    keyId: "private-wrap-v1",
    keyClass: "private_manual",
    keyPurpose: "object_wrap",
    keyVersion: 1,
    reservationId
  };
}

function storedCipher(kind: AggregateContentKind, resourceId: string, recordVersion = 1) {
  const { reservationId, ...stored } = cipher(
    kind,
    resourceId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    recordVersion
  );
  void reservationId;
  return stored;
}

function mac(): KeyedMacRpcValue {
  return {
    mac: "a".repeat(64),
    keyId: "private-mac-v1",
    keyClass: "private_manual",
    keyPurpose: "content_mac",
    keyVersion: 1
  };
}

function objectWrapKey(status: "active" | "retired" = "active"): ManagedKeyRecordV1 {
  return {
    schemaVersion: 1,
    ownerId: OWNER,
    keyClass: "private_manual",
    purpose: "object_wrap",
    keyId: "private-wrap-v1",
    keyVersion: 1,
    status,
    encryptedKeyMaterial: "AQIDBA",
    rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555",
    createdAt: AT,
    activatedAt: AT,
    retiredAt: status === "retired" ? AT : null,
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

function preparation(): PreparedEncryptedRoutingRuleWrite {
  return {
    scope: "create_routing_rule",
    ruleId: RULE,
    expectedRevision: 0,
    targetRevision: 1,
    conditionRevision: 0,
    targetConditionRevision: 1,
    expectedObservationEpoch: null,
    occurredAt: AT,
    requestMacKey: {
      keyId: "private-mac-v1",
      keyClass: "private_manual",
      keyPurpose: "content_mac",
      keyVersion: 1
    },
    reservation: null,
    completed: false,
    encryptedResponse: null,
    replayed: false
  };
}

function client(rpc: ServiceRpcClient["rpc"]): ServiceRpcClient {
  return { rpc };
}

describe("encrypted routing-rule RPC adapter", () => {
  it("exposes exactly the five frozen E2 rule capabilities", () => {
    expect(encryptedRoutingRuleRpcFunctions).toEqual([
      "get_encrypted_routing_rule_observation_epoch",
      "get_encrypted_routing_rule_write_claim",
      "prepare_encrypted_routing_rule_write",
      "commit_encrypted_routing_rule_write",
      "delete_encrypted_routing_rule"
    ]);
  });

  it("reads the owner observation epoch and an unambiguous idempotency claim", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((functionName) => {
      if (functionName === "get_encrypted_routing_rule_observation_epoch") {
        return Promise.resolve({ observationEpoch: 7 });
      }
      return Promise.resolve({
        found: true,
        scope: "delete_routing_rule",
        ruleId: RULE,
        expectedRevision: 2,
        targetRevision: 2,
        conditionRevision: 1,
        targetConditionRevision: 1,
        expectedObservationEpoch: null,
        occurredAt: AT,
        requestMacKey: {
          keyId: "private-mac-v1",
          keyClass: "private_manual",
          keyPurpose: "content_mac",
          keyVersion: 1
        },
        reservation: null,
        completed: true,
        encryptedResponse: storedCipher("idempotency_response", "idempotency:delete-rule-1"),
        replayed: true
      });
    });
    const adapter = createEncryptedRoutingRuleRpcAdapter(client(rpc));

    await expect(adapter.observationEpoch({ ownerId: OWNER })).resolves.toBe(7);
    await expect(
      adapter.claim({ ownerId: OWNER, idempotencyKey: "delete-rule-1" })
    ).resolves.toMatchObject({
      found: true,
      scope: "delete_routing_rule",
      ruleId: RULE,
      completed: true,
      replayed: true
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_encrypted_routing_rule_write_claim", {
      p_owner_id: OWNER,
      p_idempotency_key: "delete-rule-1",
      p_request_mac: null
    });
    await adapter.claim({
      ownerId: OWNER,
      idempotencyKey: "delete-rule-1",
      requestMac: mac()
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "get_encrypted_routing_rule_write_claim", {
      p_owner_id: OWNER,
      p_idempotency_key: "delete-rule-1",
      p_request_mac: mac()
    });
  });

  it("strictly prepares a private rule write and binds its request-MAC key", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      scope: "create_routing_rule",
      ruleId: RULE,
      expectedRevision: 0,
      targetRevision: 1,
      conditionRevision: 0,
      targetConditionRevision: 1,
      expectedObservationEpoch: null,
      occurredAt: AT,
      requestMacKey: {
        keyId: "private-mac-v1",
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: false,
      encryptedResponse: null,
      replayed: false
    });
    await expect(
      createEncryptedRoutingRuleRpcAdapter(client(rpc)).prepare({
        ownerId: OWNER,
        scope: "create_routing_rule",
        idempotencyKey: "create-rule-1",
        ruleId: null,
        expectedRevision: 0,
        expectedObservationEpoch: null,
        requestMac: mac()
      })
    ).resolves.toEqual(preparation());
    expect(rpc).toHaveBeenCalledWith("prepare_encrypted_routing_rule_write", {
      p_owner_id: OWNER,
      p_scope: "create_routing_rule",
      p_idempotency_key: "create-rule-1",
      p_rule_id: null,
      p_expected_revision: 0,
      p_expected_observation_epoch: null,
      p_request_mac: mac()
    });
  });

  it("abandons only an authenticated stale observation through the existing prepare RPC", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({ abandoned: true });
    await expect(
      createEncryptedRoutingRuleRpcAdapter(client(rpc)).abandonStaleObservation({
        ownerId: OWNER,
        idempotencyKey: "ruleobs:fbk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        currentObservationEpoch: 3,
        requestMac: mac()
      })
    ).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("prepare_encrypted_routing_rule_write", {
      p_owner_id: OWNER,
      p_scope: "abandon_stale_routing_rule_observation",
      p_idempotency_key: "ruleobs:fbk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      p_rule_id: null,
      p_expected_revision: 0,
      p_expected_observation_epoch: 3,
      p_request_mac: mac()
    });

    rpc.mockResolvedValueOnce({ abandoned: false });
    await expect(
      createEncryptedRoutingRuleRpcAdapter(client(rpc)).abandonStaleObservation({
        ownerId: OWNER,
        idempotencyKey: "ruleobs:fbk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        currentObservationEpoch: 3,
        requestMac: mac()
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("accepts only the exact prepare-owned observation reservation plan", async () => {
    const base = {
      scope: "observe_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 0,
      targetRevision: 1,
      conditionRevision: 0,
      targetConditionRevision: 1,
      expectedObservationEpoch: 3,
      occurredAt: AT,
      requestMacKey: {
        keyId: "private-mac-v1",
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      completed: false,
      encryptedResponse: null,
      replayed: false
    } as const;
    const projection = {
      ...base,
      reservation: {
        reservationId: RESERVATION_A,
        operationCount: 2,
        key: objectWrapKey("retired")
      }
    };
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue(projection);
    const input = {
      ownerId: OWNER,
      scope: "observe_routing_rule_proposal" as const,
      idempotencyKey: "ruleobs:fbk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      ruleId: null,
      expectedRevision: 0,
      expectedObservationEpoch: 3,
      requestMac: mac()
    };
    const adapter = createEncryptedRoutingRuleRpcAdapter(client(rpc));

    await expect(adapter.prepare(input)).resolves.toMatchObject({
      reservation: {
        reservationId: RESERVATION_A,
        operationCount: 2,
        key: { status: "retired" }
      }
    });
    rpc.mockResolvedValueOnce({ ...projection, replayed: true });
    await expect(adapter.prepare(input)).resolves.toMatchObject({
      completed: false,
      replayed: true,
      reservation: { reservationId: RESERVATION_A, operationCount: 2 }
    });

    for (const reservation of [
      null,
      { ...projection.reservation, operationCount: 1 },
      {
        ...projection.reservation,
        key: { ...objectWrapKey(), ownerId: "22222222-2222-4222-8222-222222222222" }
      },
      { ...projection.reservation, key: { ...objectWrapKey(), status: "revoked" } }
    ]) {
      rpc.mockResolvedValueOnce({ ...base, reservation });
      await expect(adapter.prepare(input)).rejects.toMatchObject({
        code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
      });
    }
  });

  it("commits only the strict content-free command and parses its encrypted result", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      ruleId: RULE,
      currentRevision: 1,
      conditionRevision: 1,
      proposalState: null,
      encryptedResponse: storedCipher("idempotency_response", "idempotency:create-rule-1"),
      replayed: false
    });
    const command = {
      scope: "create_routing_rule" as const,
      occurredAt: AT,
      enabled: true,
      ruleType: "prefix" as const,
      destinationKind: "note" as const,
      destinationId: NOTE,
      priority: 900,
      condition: {
        cipher: cipher("routing_rule", RULE, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        verificationMac: mac()
      },
      requestMac: mac(),
      responseCipher: cipher(
        "idempotency_response",
        "idempotency:create-rule-1",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      ),
      responseVerificationMac: mac()
    };
    await expect(
      createEncryptedRoutingRuleRpcAdapter(client(rpc)).commit({
        ownerId: OWNER,
        idempotencyKey: "create-rule-1",
        ruleId: RULE,
        expectedRevision: 0,
        preparation: preparation(),
        command
      })
    ).resolves.toMatchObject({ ruleId: RULE, currentRevision: 1, replayed: false });
    expect(rpc).toHaveBeenCalledWith(
      "commit_encrypted_routing_rule_write",
      expect.objectContaining({ p_command: command })
    );
  });

  it("rejects extra fields and invalid destination identities before RPC", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const adapter = createEncryptedRoutingRuleRpcAdapter(client(rpc));
    const command = {
      scope: "create_routing_rule" as const,
      occurredAt: AT,
      enabled: true,
      ruleType: "prefix" as const,
      destinationKind: "note" as const,
      destinationId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      priority: 1,
      condition: null,
      requestMac: mac(),
      responseCipher: cipher(
        "idempotency_response",
        "idempotency:create-rule-1",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      ),
      responseVerificationMac: mac()
    };
    let error: unknown;
    try {
      await adapter.commit({
        ownerId: OWNER,
        idempotencyKey: "create-rule-1",
        ruleId: RULE,
        expectedRevision: 0,
        preparation: preparation(),
        command
      });
    } catch (cause: unknown) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ServiceRpcError);
    expect(error).toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    expect(rpc).not.toHaveBeenCalled();
  });
});
