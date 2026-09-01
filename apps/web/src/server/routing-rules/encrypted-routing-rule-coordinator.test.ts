import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  type AggregateContentKind,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type KeyedMacRecord,
  type ObjectWrapReservation,
  type RoutingRulePayload,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EncryptedRoutingRuleRpcAdapter,
  EncryptedRoutingRuleWriteResult,
  PreparedEncryptedRoutingRuleWrite,
  PreparedRoutingRuleObservationReservation
} from "@/server/encryption/encrypted-routing-rule-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";

import type {
  EncryptedRoutingRuleReader,
  EncryptedRoutingRuleProposalCandidate,
  OpenedEncryptedRoutingRule
} from "./encrypted-routing-rule-reader";
import { EncryptedRoutingRuleCoordinator } from "./encrypted-routing-rule-coordinator";

const OWNER = "11111111-1111-4111-8111-111111111111";
const RULE = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const FEEDBACK = "fbk_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const SECOND_FEEDBACK = "fbk_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;
const NOW = "2026-09-01T18:00:00.123Z";
const RETIRED_MAC_KEY = "private_manual-mac-retired-v1";
const access = authorizeAggregateOwner({ authenticatedOwnerId: OWNER, resourceOwnerId: OWNER });

function envelope(
  kind: AggregateContentKind,
  resourceId: string,
  recordVersion = 1
): ContentEnvelopeV1 {
  return {
    version: 1,
    suite: "A256GCM",
    keyId: "private_manual-wrap-v1",
    context: { tenantId: OWNER, resourceId, recordVersion, kind },
    wrappedDataKey: { nonce: "A".repeat(16), ciphertext: "a".repeat(64) },
    payload: { nonce: "B".repeat(16), ciphertext: "b".repeat(64) }
  };
}

function encrypted<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  recordVersion = 1
): EncryptedAggregateRecord<Kind> {
  return {
    ownerId: OWNER,
    resourceId,
    recordVersion,
    kind,
    envelope: envelope(kind, resourceId, recordVersion),
    keyId: "private_manual-wrap-v1",
    keyClass: "private_manual",
    keyPurpose: "object_wrap",
    keyVersion: 1
  };
}

function sealed<Kind extends AggregateContentKind>(
  kind: Kind,
  resourceId: string,
  recordVersion = 1
): SealedEncryptedAggregateRecord<Kind> {
  return {
    ...encrypted(kind, resourceId, recordVersion),
    reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  };
}

function mac(keyId = "private_manual-mac-v1", keyVersion = 1): KeyedMacRecord {
  return {
    value: "a".repeat(64),
    keyId,
    keyClass: "private_manual",
    keyPurpose: "content_mac",
    keyVersion
  };
}

function observationReservation(
  operationCount: 1 | 2,
  status: "active" | "retired" = "active"
): PreparedRoutingRuleObservationReservation {
  return Object.freeze({
    reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    operationCount,
    key: Object.freeze({
      schemaVersion: 1 as const,
      ownerId: OWNER,
      keyClass: "private_manual" as const,
      purpose: "object_wrap" as const,
      keyId: "private_manual-wrap-v1",
      keyVersion: 1,
      status,
      encryptedKeyMaterial: "AQIDBA",
      rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555",
      createdAt: NOW,
      activatedAt: NOW,
      retiredAt: status === "retired" ? NOW : null,
      revokedAt: null,
      wrapOperations: operationCount,
      wrapOperationLimit: 16_777_216,
      rotation: Object.freeze({
        predecessorKeyId: null,
        previousRootKeyArn: null,
        rootRewrapCount: 0,
        lastRootRewrappedAt: null
      })
    })
  });
}

function offeredRule(): OpenedEncryptedRoutingRule {
  const dto = {
    id: RULE,
    revision: 2,
    enabled: false,
    ruleType: "phrase" as const,
    condition: "morning workout",
    normalizedCondition: "morning workout",
    aliases: [],
    destination: { type: "note" as const, noteId: NOTE },
    destinationStatus: "active" as const,
    priority: 500,
    source: "correction_suggested" as const,
    proposalState: "offered" as const,
    lastFiredAt: null,
    createdAt: NOW,
    updatedAt: NOW
  };
  return {
    row: {
      surface: "routing_rule",
      ownerId: OWNER,
      resourceId: RULE,
      recordVersion: 1,
      operational: {
        currentRevision: 2,
        enabled: false,
        ruleType: "phrase",
        destinationNoteId: NOTE,
        destinationSpaceId: null,
        priority: 500,
        source: "correction_suggested",
        proposalState: "offered",
        destinationStatus: "active",
        lastFiredAt: null,
        createdAt: NOW,
        updatedAt: NOW
      },
      encrypted: encrypted("routing_rule", RULE),
      contentMac: null
    },
    payload: {
      schemaVersion: 1,
      condition: dto.condition,
      normalizedCondition: dto.normalizedCondition,
      aliases: []
    },
    dto
  };
}

function learnedProposal(
  proposalState: "observing" | "offered" | "accepted" | "declined",
  currentRevision = 1,
  condition = "morning workout"
): EncryptedRoutingRuleProposalCandidate {
  const offered = offeredRule();
  return Object.freeze({
    row: Object.freeze({
      ...offered.row,
      operational: Object.freeze({
        ...offered.row.operational,
        currentRevision,
        proposalState
      })
    }),
    payload: Object.freeze({
      ...offered.payload,
      condition,
      normalizedCondition: condition
    })
  });
}

function setup(
  current: OpenedEncryptedRoutingRule | null = null,
  proposal: EncryptedRoutingRuleProposalCandidate | null = null
) {
  const responses = new Map<string, unknown>();
  const sealRoutingRule = vi.fn(
    (_access, input: { ruleId: string; recordVersion: number; payload: RoutingRulePayload }) =>
      Promise.resolve(sealed("routing_rule", input.ruleId, input.recordVersion))
  );
  const sealIdempotencyResponse = vi.fn(
    (_access, input: { idempotencyKey: string; response: unknown }) => {
      responses.set(input.idempotencyKey, input.response);
      return Promise.resolve(sealed("idempotency_response", `idempotency:${input.idempotencyKey}`));
    }
  );
  const createIdempotencyRequestMac = vi.fn(
    (
      accessValue: unknown,
      inputValue: Readonly<{
        logicalRequest: Readonly<{
          targetResourceId: string | null;
          expectedRevision: number | null;
          payload: unknown;
        }>;
        keyReference?: Readonly<{
          keyId: string;
          keyVersion: number;
        }>;
      }>
    ) => {
      void accessValue;
      return Promise.resolve(
        inputValue.keyReference === undefined
          ? mac()
          : mac(inputValue.keyReference.keyId, inputValue.keyReference.keyVersion)
      );
    }
  );
  const aggregate = {
    createIdempotencyRequestMac,
    sealRoutingRule,
    sealIdempotencyResponse,
    createAggregateVerificationMac: vi.fn(() => Promise.resolve(mac())),
    openIdempotencyResponse: vi.fn((_access, _record, input: { idempotencyKey: string }) =>
      Promise.resolve(responses.get(input.idempotencyKey))
    )
  } as unknown as EncryptedAggregateService;
  const prepare = vi.fn<EncryptedRoutingRuleRpcAdapter["prepare"]>((input) => {
    const conditionRevision = input.expectedRevision === 0 ? 0 : 1;
    return Promise.resolve({
      scope: input.scope,
      ruleId: input.ruleId ?? RULE,
      expectedRevision: input.expectedRevision,
      targetRevision: input.expectedRevision + 1,
      conditionRevision,
      targetConditionRevision:
        input.scope === "update_routing_rule"
          ? conditionRevision + 1
          : Math.max(1, conditionRevision),
      expectedObservationEpoch: input.expectedObservationEpoch,
      occurredAt: NOW,
      requestMacKey: {
        keyId: input.requestMac.keyId,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: input.requestMac.keyVersion
      },
      reservation:
        input.scope === "observe_routing_rule_proposal"
          ? observationReservation(input.expectedRevision === 0 ? 2 : 1)
          : null,
      completed: false,
      encryptedResponse: null,
      replayed: false
    } satisfies PreparedEncryptedRoutingRuleWrite);
  });
  const commit = vi.fn<EncryptedRoutingRuleRpcAdapter["commit"]>((input) => {
    const accepting = input.command.scope === "accept_routing_rule_proposal";
    const observing = input.command.scope === "observe_routing_rule_proposal";
    const changedCondition = "condition" in input.command && input.command.condition !== null;
    const result: EncryptedRoutingRuleWriteResult = {
      ruleId: input.ruleId,
      currentRevision: input.expectedRevision + 1,
      conditionRevision: changedCondition
        ? input.preparation.targetConditionRevision
        : input.preparation.conditionRevision,
      proposalState: accepting
        ? "accepted"
        : observing
          ? input.expectedRevision === 0
            ? "observing"
            : "offered"
          : null,
      encryptedResponse: encrypted("idempotency_response", `idempotency:${input.idempotencyKey}`),
      replayed: false
    };
    return Promise.resolve(result);
  });
  const deleteRule = vi.fn<EncryptedRoutingRuleRpcAdapter["delete"]>((input) =>
    Promise.resolve({
      ruleId: input.ruleId,
      currentRevision: input.expectedRevision,
      conditionRevision: 1,
      proposalState: null,
      encryptedResponse: encrypted("idempotency_response", `idempotency:${input.idempotencyKey}`),
      replayed: false
    })
  );
  const observationEpoch = vi.fn<EncryptedRoutingRuleRpcAdapter["observationEpoch"]>(() =>
    Promise.resolve(0)
  );
  const claim = vi.fn<EncryptedRoutingRuleRpcAdapter["claim"]>(() =>
    Promise.resolve({ found: false })
  );
  const abandonStaleObservation = vi.fn<EncryptedRoutingRuleRpcAdapter["abandonStaleObservation"]>(
    () => Promise.resolve()
  );
  const adapter = {
    observationEpoch,
    claim,
    prepare,
    abandonStaleObservation,
    commit,
    delete: deleteRule
  } satisfies EncryptedRoutingRuleRpcAdapter;
  const getRule = vi.fn(() => Promise.resolve(current));
  const findLearnedProposal = vi.fn(
    (input: Parameters<EncryptedRoutingRuleReader["findLearnedProposal"]>[0]) => {
      void input;
      return Promise.resolve(proposal);
    }
  );
  const reader = {
    list: vi.fn(() =>
      Promise.resolve({
        items: current === null ? [] : [current.dto],
        pageInfo: { hasMore: false, nextCursor: null }
      })
    ),
    get: getRule,
    findLearnedProposal
  } as unknown as EncryptedRoutingRuleReader;
  const assertPreparedConsumed = vi.fn();
  const createPreparedService = vi.fn((reservations: readonly ObjectWrapReservation[]) => {
    void reservations;
    return { service: aggregate, assertConsumed: assertPreparedConsumed };
  });
  const coordinator = new EncryptedRoutingRuleCoordinator({
    ownerId: OWNER,
    access,
    aggregate,
    createPreparedService,
    adapter,
    reader,
    now: () => new Date(NOW)
  });
  return {
    coordinator,
    aggregate,
    adapter,
    reader,
    getRule,
    findLearnedProposal,
    prepare,
    commit,
    deleteRule,
    observationEpoch,
    claim,
    abandonStaleObservation,
    createPreparedService,
    assertPreparedConsumed,
    createIdempotencyRequestMac,
    sealIdempotencyResponse,
    sealRoutingRule
  };
}

describe("encrypted routing-rule coordinator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a private encrypted explicit rule and returns only its owner DTO", async () => {
    const { coordinator, prepare, commit, sealRoutingRule } = setup();
    const result = await coordinator.create({
      idempotencyKey: "create-rule-1",
      enabled: true,
      ruleType: "prefix",
      condition: "Shop",
      destination: { type: "note", noteId: NOTE },
      priority: 900
    });

    expect(result).toMatchObject({
      replayed: false,
      rule: {
        id: RULE,
        revision: 1,
        condition: "Shop",
        normalizedCondition: "shop",
        source: "explicit",
        proposalState: null
      }
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "create_routing_rule", ruleId: null, expectedRevision: 0 })
    );
    expect(sealRoutingRule).toHaveBeenCalledTimes(1);
    const command = commit.mock.calls[0]?.[0].command;
    expect(command).toMatchObject({
      scope: "create_routing_rule",
      destinationKind: "note",
      destinationId: NOTE,
      condition: { cipher: { keyClass: "private_manual" } }
    });
    expect(JSON.stringify(command)).not.toContain("Shop");
  });

  it("rejects compatibility-normalization expansion before any durable prepare", async () => {
    const { coordinator, claim, prepare } = setup();
    const expandingCondition = "\uFDFA".repeat(500);

    await expect(
      coordinator.create({
        idempotencyKey: "create-expanded-condition",
        enabled: true,
        ruleType: "phrase",
        condition: expandingCondition,
        destination: { type: "note", noteId: NOTE },
        priority: 100
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    await expect(
      coordinator.update(RULE, {
        expectedRevision: 2,
        idempotencyKey: "update-expanded-condition",
        condition: expandingCondition
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });

    expect(claim).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("replays a completed create with its retired request-MAC key", async () => {
    const { coordinator, claim, prepare, commit, sealRoutingRule, createIdempotencyRequestMac } =
      setup();
    const request = {
      idempotencyKey: "create-rule-replay",
      enabled: true,
      ruleType: "prefix" as const,
      condition: "Shop",
      destination: { type: "note" as const, noteId: NOTE },
      priority: 900
    };
    await coordinator.create(request);
    claim.mockResolvedValue({
      found: true,
      scope: "create_routing_rule",
      ruleId: RULE,
      expectedRevision: 0,
      targetRevision: 1,
      conditionRevision: 0,
      targetConditionRevision: 1,
      expectedObservationEpoch: null,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", "idempotency:create-rule-replay"),
      replayed: true
    });
    prepare.mockResolvedValueOnce({
      scope: "create_routing_rule",
      ruleId: RULE,
      expectedRevision: 0,
      targetRevision: 1,
      conditionRevision: 0,
      targetConditionRevision: 1,
      expectedObservationEpoch: null,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", "idempotency:create-rule-replay"),
      replayed: true
    });

    await expect(coordinator.create(request)).resolves.toMatchObject({ replayed: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(sealRoutingRule).toHaveBeenCalledTimes(1);
    expect(createIdempotencyRequestMac.mock.calls.at(-1)?.[1].keyReference).toMatchObject({
      keyId: RETIRED_MAC_KEY
    });
  });

  it("accepts an offered learned rule without resealing or exposing its condition", async () => {
    const { coordinator, prepare, commit, sealRoutingRule } = setup(offeredRule());
    const result = await coordinator.update(RULE, {
      expectedRevision: 2,
      idempotencyKey: "accept-rule-1",
      enabled: true
    });

    expect(result.rule).toMatchObject({
      revision: 3,
      enabled: true,
      source: "correction_suggested",
      proposalState: "accepted"
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "accept_routing_rule_proposal" })
    );
    expect(sealRoutingRule).not.toHaveBeenCalled();
    expect(Object.keys(commit.mock.calls[0]?.[0].command ?? {}).sort()).toEqual([
      "occurredAt",
      "requestMac",
      "responseCipher",
      "responseVerificationMac",
      "scope"
    ]);
  });

  it("replays a completed acceptance before reading its now-advanced rule", async () => {
    const current = offeredRule();
    const { coordinator, claim, prepare, commit, getRule, createIdempotencyRequestMac } =
      setup(current);
    const request = {
      expectedRevision: 2,
      idempotencyKey: "accept-rule-replay",
      enabled: true
    } as const;
    await coordinator.update(RULE, request);
    current.dto.revision = 3;
    current.dto.enabled = true;
    current.dto.proposalState = "accepted";
    claim.mockResolvedValue({
      found: true,
      scope: "accept_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 2,
      targetRevision: 3,
      conditionRevision: 1,
      targetConditionRevision: 1,
      expectedObservationEpoch: null,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", "idempotency:accept-rule-replay"),
      replayed: true
    });
    prepare.mockResolvedValueOnce({
      scope: "accept_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 2,
      targetRevision: 3,
      conditionRevision: 1,
      targetConditionRevision: 1,
      expectedObservationEpoch: null,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", "idempotency:accept-rule-replay"),
      replayed: true
    });

    await expect(coordinator.update(RULE, request)).resolves.toMatchObject({ replayed: true });
    expect(getRule).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(createIdempotencyRequestMac.mock.calls.at(-1)?.[1].keyReference).toMatchObject({
      keyId: RETIRED_MAC_KEY
    });
  });

  it("replays a completed ordinary update with its retired request-MAC key", async () => {
    const current = offeredRule();
    current.dto.source = "explicit";
    current.dto.proposalState = null;
    current.dto.enabled = true;
    const { coordinator, claim, prepare, commit, createIdempotencyRequestMac } = setup(current);
    const request = {
      expectedRevision: 2,
      idempotencyKey: "update-rule-replay",
      priority: 525
    } as const;
    await coordinator.update(RULE, request);
    claim.mockResolvedValue({
      found: true,
      scope: "update_routing_rule",
      ruleId: RULE,
      expectedRevision: 2,
      targetRevision: 3,
      conditionRevision: 1,
      targetConditionRevision: 2,
      expectedObservationEpoch: null,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", "idempotency:update-rule-replay"),
      replayed: true
    });
    prepare.mockResolvedValueOnce({
      scope: "update_routing_rule",
      ruleId: RULE,
      expectedRevision: 2,
      targetRevision: 3,
      conditionRevision: 1,
      targetConditionRevision: 2,
      expectedObservationEpoch: null,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", "idempotency:update-rule-replay"),
      replayed: true
    });

    await expect(coordinator.update(RULE, request)).resolves.toMatchObject({ replayed: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(createIdempotencyRequestMac.mock.calls.at(-1)?.[1].keyReference).toMatchObject({
      keyId: RETIRED_MAC_KEY
    });
  });

  it("preserves a blocked destination while pausing an enabled explicit rule", async () => {
    const current = offeredRule();
    current.dto.source = "explicit";
    current.dto.proposalState = null;
    current.dto.enabled = true;
    current.dto.destinationStatus = "missing";
    const { coordinator, commit, sealRoutingRule } = setup(current);

    await expect(
      coordinator.update(RULE, {
        expectedRevision: 2,
        idempotencyKey: "pause-blocked-rule",
        enabled: false
      })
    ).resolves.toMatchObject({
      replayed: false,
      rule: {
        enabled: false,
        destination: { type: "note", noteId: NOTE },
        destinationStatus: "missing"
      }
    });

    expect(sealRoutingRule).not.toHaveBeenCalled();
    expect(commit.mock.calls[0]?.[0].command).toMatchObject({
      scope: "update_routing_rule",
      enabled: false,
      destinationKind: "note",
      destinationId: NOTE
    });
  });

  it("deletes through one encrypted idempotent command", async () => {
    const current = offeredRule();
    current.dto.proposalState = "accepted";
    current.dto.enabled = true;
    const { coordinator, claim, deleteRule, createIdempotencyRequestMac, sealIdempotencyResponse } =
      setup(current);

    await expect(
      coordinator.delete(RULE, { expectedRevision: 2, idempotencyKey: "delete-rule-1" })
    ).resolves.toEqual({ ruleId: RULE, deleted: true, replayed: false });
    expect(deleteRule).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deleteRule.mock.calls[0]?.[0].command)).not.toContain("morning workout");
    claim.mockResolvedValue({
      found: true,
      scope: "delete_routing_rule",
      ruleId: RULE,
      expectedRevision: 2,
      targetRevision: 2,
      conditionRevision: 1,
      targetConditionRevision: 1,
      expectedObservationEpoch: null,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", "idempotency:delete-rule-1"),
      replayed: true
    });
    await expect(
      coordinator.delete(RULE, { expectedRevision: 2, idempotencyKey: "delete-rule-1" })
    ).resolves.toEqual({ ruleId: RULE, deleted: true, replayed: true });
    expect(deleteRule).toHaveBeenCalledTimes(1);
    expect(sealIdempotencyResponse).toHaveBeenCalledTimes(1);
    expect(createIdempotencyRequestMac.mock.calls.at(-1)?.[1].keyReference).toMatchObject({
      keyId: RETIRED_MAC_KEY
    });
  });

  it("records a first distinct correction as an encrypted observing proposal", async () => {
    const {
      coordinator,
      aggregate,
      prepare,
      commit,
      createPreparedService,
      assertPreparedConsumed,
      sealIdempotencyResponse,
      sealRoutingRule
    } = setup();

    await expect(
      coordinator.observeCorrection({
        feedbackEventId: FEEDBACK,
        captureText: "Morning workout",
        destination: { type: "note", noteId: NOTE }
      })
    ).resolves.toBeUndefined();

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "observe_routing_rule_proposal",
        ruleId: null,
        expectedRevision: 0,
        idempotencyKey: `ruleobs:${FEEDBACK}`
      })
    );
    expect(aggregate.createIdempotencyRequestMac).toHaveBeenCalledWith(
      access,
      expect.objectContaining({ transition: { before: null, after: "private_manual" } })
    );
    expect(sealRoutingRule).toHaveBeenCalledTimes(1);
    expect(createPreparedService).toHaveBeenCalledWith([
      expect.objectContaining({
        reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        groupUse: { operationCount: 2, operationIndex: 0 }
      }),
      expect.objectContaining({
        reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        groupUse: { operationCount: 2, operationIndex: 1 }
      })
    ]);
    expect(sealRoutingRule.mock.invocationCallOrder[0]).toBeLessThan(
      sealIdempotencyResponse.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(sealIdempotencyResponse.mock.invocationCallOrder[0]).toBeLessThan(
      assertPreparedConsumed.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(assertPreparedConsumed.mock.invocationCallOrder[0]).toBeLessThan(
      commit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(commit.mock.calls[0]?.[0].command).toMatchObject({
      scope: "observe_routing_rule_proposal",
      ruleType: "phrase",
      destinationKind: "note",
      destinationId: NOTE,
      feedbackEventId: FEEDBACK,
      condition: { cipher: { keyClass: "private_manual" } }
    });
    expect(JSON.stringify(commit.mock.calls[0]?.[0].command)).not.toContain("Morning workout");
  });

  it.each([
    {
      boundary: "space",
      captureText: `${"A".repeat(79)} tail`,
      canonicalCondition: "a".repeat(79)
    },
    {
      boundary: "punctuation",
      captureText: `${"B".repeat(79)},tail`,
      canonicalCondition: "b".repeat(79)
    }
  ])(
    "uses one canonical learned condition for identical long corrections ending at a $boundary boundary",
    async ({ captureText, canonicalCondition }) => {
      const {
        coordinator,
        findLearnedProposal,
        prepare,
        createIdempotencyRequestMac,
        sealRoutingRule
      } = setup();
      findLearnedProposal
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(learnedProposal("observing", 1, canonicalCondition));

      await coordinator.observeCorrection({
        feedbackEventId: FEEDBACK,
        captureText,
        destination: { type: "note", noteId: NOTE }
      });
      await coordinator.observeCorrection({
        feedbackEventId: SECOND_FEEDBACK,
        captureText,
        destination: { type: "note", noteId: NOTE }
      });

      expect(findLearnedProposal.mock.calls.map(([input]) => input.normalizedCondition)).toEqual([
        canonicalCondition,
        canonicalCondition
      ]);
      expect(prepare.mock.calls.map(([input]) => input.expectedRevision)).toEqual([0, 1]);
      expect(sealRoutingRule).toHaveBeenCalledTimes(1);
      expect(sealRoutingRule.mock.calls[0]?.[1].payload).toEqual({
        schemaVersion: 1,
        condition: canonicalCondition,
        normalizedCondition: canonicalCondition,
        aliases: []
      });

      const logicalPayloads = createIdempotencyRequestMac.mock.calls.map(
        ([, input]) => input.logicalRequest.payload
      );
      expect(logicalPayloads).toHaveLength(2);
      for (const logicalPayload of logicalPayloads) {
        expect(logicalPayload).toMatchObject({
          condition: canonicalCondition,
          normalizedCondition: canonicalCondition
        });
      }
    }
  );

  it("finishes an incomplete observation retry with its frozen retired reservation plan", async () => {
    const {
      coordinator,
      claim,
      prepare,
      commit,
      observationEpoch,
      findLearnedProposal,
      createPreparedService,
      createIdempotencyRequestMac
    } = setup();
    const frozenReservation = observationReservation(2, "retired");
    claim.mockResolvedValue({
      found: true,
      scope: "observe_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 0,
      targetRevision: 1,
      conditionRevision: 0,
      targetConditionRevision: 1,
      expectedObservationEpoch: 0,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: frozenReservation,
      completed: false,
      encryptedResponse: null,
      replayed: true
    });
    prepare.mockResolvedValueOnce({
      scope: "observe_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 0,
      targetRevision: 1,
      conditionRevision: 0,
      targetConditionRevision: 1,
      expectedObservationEpoch: 0,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: frozenReservation,
      completed: false,
      encryptedResponse: null,
      replayed: true
    });

    await expect(
      coordinator.observeCorrection({
        feedbackEventId: FEEDBACK,
        captureText: "Morning workout",
        destination: { type: "note", noteId: NOTE }
      })
    ).resolves.toBeUndefined();

    expect(observationEpoch).not.toHaveBeenCalled();
    expect(findLearnedProposal).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(createPreparedService.mock.calls[0]?.[0][0]?.reference).toMatchObject({
      keyId: "private_manual-wrap-v1",
      keyVersion: 1
    });
    expect(createIdempotencyRequestMac.mock.calls.at(-1)?.[1].keyReference).toMatchObject({
      keyId: RETIRED_MAC_KEY
    });
  });

  it("promotes the second distinct correction to an offered but disabled proposal", async () => {
    const proposal = learnedProposal("observing");
    const {
      coordinator,
      aggregate,
      prepare,
      commit,
      createPreparedService,
      assertPreparedConsumed,
      sealRoutingRule
    } = setup(null, proposal);

    await expect(
      coordinator.observeCorrection({
        feedbackEventId: FEEDBACK,
        captureText: "Morning workout",
        destination: { type: "note", noteId: NOTE }
      })
    ).resolves.toBeUndefined();

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "observe_routing_rule_proposal",
        ruleId: RULE,
        expectedRevision: 1
      })
    );
    expect(aggregate.createIdempotencyRequestMac).toHaveBeenCalledWith(
      access,
      expect.objectContaining({
        transition: { before: "private_manual", after: "private_manual" }
      })
    );
    expect(sealRoutingRule).not.toHaveBeenCalled();
    expect(createPreparedService.mock.calls[0]?.[0]).toEqual([
      {
        reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        reference: {
          ownerId: OWNER,
          keyClass: "private_manual",
          purpose: "object_wrap",
          keyId: "private_manual-wrap-v1",
          keyVersion: 1
        }
      }
    ]);
    expect(createPreparedService.mock.calls[0]?.[0][0]).not.toHaveProperty("groupUse");
    expect(assertPreparedConsumed).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0].command).toMatchObject({
      scope: "observe_routing_rule_proposal",
      condition: null,
      feedbackEventId: FEEDBACK
    });
  });

  it("replans once at a new observation epoch when a distinct correction races", async () => {
    const {
      coordinator,
      findLearnedProposal,
      observationEpoch,
      prepare,
      commit,
      createIdempotencyRequestMac
    } = setup();
    findLearnedProposal
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(learnedProposal("observing"));
    observationEpoch.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    commit.mockRejectedValueOnce(
      new ServiceRpcError(ServiceRpcErrorCode.ROUTING_RULE_OBSERVATION_STALE)
    );

    await expect(
      coordinator.observeCorrection({
        feedbackEventId: FEEDBACK,
        captureText: "Morning workout",
        destination: { type: "note", noteId: NOTE }
      })
    ).resolves.toBeUndefined();

    expect(
      prepare.mock.calls.map(([input]) => ({
        ruleId: input.ruleId,
        expectedRevision: input.expectedRevision,
        expectedObservationEpoch: input.expectedObservationEpoch
      }))
    ).toEqual([
      { ruleId: null, expectedRevision: 0, expectedObservationEpoch: 0 },
      { ruleId: RULE, expectedRevision: 1, expectedObservationEpoch: 1 }
    ]);
    expect(
      createIdempotencyRequestMac.mock.calls.map(([, input]) => ({
        targetResourceId: input.logicalRequest.targetResourceId,
        expectedRevision: input.logicalRequest.expectedRevision
      }))
    ).toEqual([
      { targetResourceId: null, expectedRevision: null },
      { targetResourceId: null, expectedRevision: null }
    ]);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("abandons a third stale observation claim after another writer offers the rule", async () => {
    const {
      coordinator,
      findLearnedProposal,
      observationEpoch,
      prepare,
      commit,
      abandonStaleObservation,
      createIdempotencyRequestMac
    } = setup();
    findLearnedProposal.mockResolvedValue(learnedProposal("offered", 2));
    findLearnedProposal.mockResolvedValueOnce(null);
    observationEpoch.mockResolvedValueOnce(0).mockResolvedValue(2);
    commit.mockRejectedValueOnce(
      new ServiceRpcError(ServiceRpcErrorCode.ROUTING_RULE_OBSERVATION_STALE)
    );
    const observation = {
      feedbackEventId: FEEDBACK,
      captureText: "Morning workout",
      destination: { type: "note" as const, noteId: NOTE }
    };

    await expect(coordinator.observeCorrection(observation)).resolves.toBeUndefined();

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(abandonStaleObservation).toHaveBeenCalledWith({
      ownerId: OWNER,
      idempotencyKey: `ruleobs:${FEEDBACK}`,
      currentObservationEpoch: 2,
      requestMac: {
        mac: "a".repeat(64),
        keyId: "private_manual-mac-v1",
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      }
    });
    expect(createIdempotencyRequestMac).toHaveBeenCalledTimes(1);

    await expect(coordinator.observeCorrection(observation)).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(abandonStaleObservation).toHaveBeenCalledTimes(1);
  });

  it("validates and opens a completed observation replay without counting it twice", async () => {
    const {
      coordinator,
      claim,
      prepare,
      commit,
      findLearnedProposal,
      createIdempotencyRequestMac
    } = setup();
    const observation = {
      feedbackEventId: FEEDBACK,
      captureText: "Morning workout",
      destination: { type: "note" as const, noteId: NOTE }
    };
    await coordinator.observeCorrection(observation);
    claim.mockResolvedValue({
      found: true,
      scope: "observe_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 0,
      targetRevision: 1,
      conditionRevision: 0,
      targetConditionRevision: 1,
      expectedObservationEpoch: 0,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", `idempotency:ruleobs:${FEEDBACK}`),
      replayed: true
    });
    prepare.mockResolvedValueOnce({
      scope: "observe_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 0,
      targetRevision: 1,
      conditionRevision: 0,
      targetConditionRevision: 1,
      expectedObservationEpoch: 0,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", `idempotency:ruleobs:${FEEDBACK}`),
      replayed: true
    });

    await expect(coordinator.observeCorrection(observation)).resolves.toBeUndefined();
    expect(prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ ruleId: null, expectedRevision: 0 })
    );
    expect(findLearnedProposal).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(createIdempotencyRequestMac.mock.calls.at(-1)?.[1].keyReference).toMatchObject({
      keyId: RETIRED_MAC_KEY
    });
  });

  it("replays a completed second observation with its retired request-MAC key", async () => {
    const proposal = learnedProposal("observing");
    const {
      coordinator,
      claim,
      prepare,
      commit,
      observationEpoch,
      findLearnedProposal,
      createIdempotencyRequestMac
    } = setup(null, proposal);
    observationEpoch.mockResolvedValue(1);
    const observation = {
      feedbackEventId: FEEDBACK,
      captureText: "Morning workout",
      destination: { type: "note" as const, noteId: NOTE }
    };
    await coordinator.observeCorrection(observation);
    claim.mockResolvedValue({
      found: true,
      scope: "observe_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 1,
      targetRevision: 2,
      conditionRevision: 1,
      targetConditionRevision: 1,
      expectedObservationEpoch: 1,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", `idempotency:ruleobs:${FEEDBACK}`),
      replayed: true
    });
    prepare.mockResolvedValueOnce({
      scope: "observe_routing_rule_proposal",
      ruleId: RULE,
      expectedRevision: 1,
      targetRevision: 2,
      conditionRevision: 1,
      targetConditionRevision: 1,
      expectedObservationEpoch: 1,
      occurredAt: NOW,
      requestMacKey: {
        keyId: RETIRED_MAC_KEY,
        keyClass: "private_manual",
        keyPurpose: "content_mac",
        keyVersion: 1
      },
      reservation: null,
      completed: true,
      encryptedResponse: encrypted("idempotency_response", `idempotency:ruleobs:${FEEDBACK}`),
      replayed: true
    });

    await expect(coordinator.observeCorrection(observation)).resolves.toBeUndefined();
    expect(findLearnedProposal).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(createIdempotencyRequestMac.mock.calls.at(-1)?.[1].keyReference).toMatchObject({
      keyId: RETIRED_MAC_KEY
    });
  });

  it("suppresses a correction pattern after the owner declines its proposal", async () => {
    const proposal = learnedProposal("declined", 2);
    const { coordinator, prepare, commit, sealRoutingRule } = setup(null, proposal);

    await expect(
      coordinator.observeCorrection({
        feedbackEventId: FEEDBACK,
        captureText: "Morning workout",
        destination: { type: "note", noteId: NOTE }
      })
    ).resolves.toBeUndefined();

    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(sealRoutingRule).not.toHaveBeenCalled();
  });
});
