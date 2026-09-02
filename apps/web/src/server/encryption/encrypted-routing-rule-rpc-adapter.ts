import {
  RoutingRuleDestinationSchema,
  RoutingRuleTypeSchema,
  entityIdSchema,
  type EntityId,
  type RoutingRuleType
} from "@unfiled/contracts";
import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import type {
  EncryptedAggregateRecord,
  EncryptedFieldRpcValue,
  KeyedMacRpcValue,
  ObjectWrapReservation
} from "@unfiled/encrypted-aggregate";
import {
  parseAnyManagedKeyRecord,
  type KeyClass,
  type ManagedKeyRecord
} from "@unfiled/key-management";

import { canonicalUtcTimestampFromMicros } from "./canonical-rpc-timestamp";
import { encryptedCaptureTimestampMicros } from "./encrypted-capture-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;

export const encryptedRoutingRuleRpcFunctions = Object.freeze([
  "get_encrypted_routing_rule_observation_epoch",
  "get_encrypted_routing_rule_write_claim",
  "prepare_encrypted_routing_rule_write",
  "commit_encrypted_routing_rule_write",
  "delete_encrypted_routing_rule"
] as const);

export type EncryptedRoutingRuleWriteScope =
  | "create_routing_rule"
  | "update_routing_rule"
  | "observe_routing_rule_proposal"
  | "accept_routing_rule_proposal"
  | "decline_routing_rule_proposal";

export type EncryptedRoutingRuleClaimScope = EncryptedRoutingRuleWriteScope | "delete_routing_rule";

export type RoutingRuleRequestMacKey = Readonly<{
  keyId: string;
  keyClass: "private_manual";
  keyPurpose: "content_mac";
  keyVersion: number;
}>;

export type PreparedRoutingRuleObservationReservation = Readonly<{
  reservationId: string;
  operationCount: 1 | 2;
  key: ManagedKeyRecord;
}>;

export type PreparedEncryptedRoutingRuleWrite = Readonly<{
  scope: EncryptedRoutingRuleWriteScope;
  ruleId: EntityId<"rule">;
  expectedRevision: number;
  targetRevision: number;
  conditionRevision: number;
  targetConditionRevision: number;
  expectedObservationEpoch: number | null;
  occurredAt: string;
  requestMacKey: RoutingRuleRequestMacKey;
  reservation: PreparedRoutingRuleObservationReservation | null;
  completed: boolean;
  encryptedResponse: EncryptedAggregateRecord<"idempotency_response"> | null;
  replayed: boolean;
}>;

export type EncryptedRoutingRuleWriteClaim =
  | Readonly<{ found: false }>
  | (Readonly<{ found: true; scope: EncryptedRoutingRuleClaimScope }> &
      Omit<PreparedEncryptedRoutingRuleWrite, "scope" | "replayed"> &
      Readonly<{ replayed: true }>);

export type EncryptedRoutingRuleConditionCommand = Readonly<{
  cipher: EncryptedFieldRpcValue<"routing_rule">;
  verificationMac: KeyedMacRpcValue;
}>;

type EncryptedRoutingRuleCommonCommitCommand = Readonly<{
  scope: EncryptedRoutingRuleWriteScope;
  occurredAt: string;
  requestMac: KeyedMacRpcValue;
  responseCipher: EncryptedFieldRpcValue<"idempotency_response">;
  responseVerificationMac: KeyedMacRpcValue;
}>;

export type EncryptedRoutingRuleCommitCommand =
  | (EncryptedRoutingRuleCommonCommitCommand &
      Readonly<{
        scope: "create_routing_rule" | "update_routing_rule";
        enabled: boolean;
        ruleType: RoutingRuleType;
        destinationKind: "note" | "space";
        destinationId: string;
        priority: number;
        condition: EncryptedRoutingRuleConditionCommand | null;
      }>)
  | (EncryptedRoutingRuleCommonCommitCommand &
      Readonly<{
        scope: "observe_routing_rule_proposal";
        ruleType: RoutingRuleType;
        destinationKind: "note" | "space";
        destinationId: string;
        priority: number;
        feedbackEventId: EntityId<"fbk">;
        condition: EncryptedRoutingRuleConditionCommand | null;
      }>)
  | (EncryptedRoutingRuleCommonCommitCommand &
      Readonly<{
        scope: "accept_routing_rule_proposal" | "decline_routing_rule_proposal";
      }>);

export type EncryptedRoutingRuleWriteResult = Readonly<{
  ruleId: EntityId<"rule">;
  currentRevision: number;
  conditionRevision: number;
  proposalState: "observing" | "offered" | "accepted" | "declined" | null;
  encryptedResponse: EncryptedAggregateRecord<"idempotency_response">;
  replayed: boolean;
}>;

export type EncryptedRoutingRuleDeleteCommand = Readonly<{
  occurredAt: string;
  requestMac: KeyedMacRpcValue;
  responseCipher: EncryptedFieldRpcValue<"idempotency_response">;
  responseVerificationMac: KeyedMacRpcValue;
}>;

export type EncryptedRoutingRuleRpcAdapter = Readonly<{
  observationEpoch(input: Readonly<{ ownerId: string }>): Promise<number>;
  claim(
    input: Readonly<{
      ownerId: string;
      idempotencyKey: string;
      requestMac?: KeyedMacRpcValue;
    }>
  ): Promise<EncryptedRoutingRuleWriteClaim>;
  prepare(
    input: Readonly<{
      ownerId: string;
      scope: EncryptedRoutingRuleWriteScope;
      idempotencyKey: string;
      ruleId: EntityId<"rule"> | null;
      expectedRevision: number;
      expectedObservationEpoch: number | null;
      requestMac: KeyedMacRpcValue;
    }>
  ): Promise<PreparedEncryptedRoutingRuleWrite>;
  abandonStaleObservation(
    input: Readonly<{
      ownerId: string;
      idempotencyKey: string;
      currentObservationEpoch: number;
      requestMac: KeyedMacRpcValue;
    }>
  ): Promise<void>;
  commit(
    input: Readonly<{
      ownerId: string;
      idempotencyKey: string;
      ruleId: EntityId<"rule">;
      expectedRevision: number;
      preparation: PreparedEncryptedRoutingRuleWrite;
      command: EncryptedRoutingRuleCommitCommand;
    }>
  ): Promise<EncryptedRoutingRuleWriteResult>;
  delete(
    input: Readonly<{
      ownerId: string;
      ruleId: EntityId<"rule">;
      expectedRevision: number;
      idempotencyKey: string;
      command: EncryptedRoutingRuleDeleteCommand;
    }>
  ): Promise<EncryptedRoutingRuleWriteResult>;
}>;

export function objectWrapReservationsFromRoutingRulePreparation(
  reservation: PreparedRoutingRuleObservationReservation
): readonly ObjectWrapReservation[] {
  const reference = Object.freeze({
    ownerId: reservation.key.ownerId,
    keyClass: reservation.key.keyClass,
    purpose: "object_wrap" as const,
    keyId: reservation.key.keyId,
    keyVersion: reservation.key.keyVersion
  });
  if (reservation.operationCount === 1) {
    return Object.freeze([Object.freeze({ reservationId: reservation.reservationId, reference })]);
  }
  return Object.freeze(
    Array.from({ length: reservation.operationCount }, (_, operationIndex) =>
      Object.freeze({
        reservationId: reservation.reservationId,
        reference,
        groupUse: Object.freeze({
          operationCount: reservation.operationCount,
          operationIndex
        })
      })
    )
  );
}

type UnknownRecord = Readonly<Record<string, unknown>>;
type Failure = () => never;

function inputFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function projectionFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function exactRecord(value: unknown, keys: readonly string[], failure: Failure): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return failure();
  const record = value as UnknownRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return failure();
  }
  return record;
}

function integer(value: unknown, minimum: number, failure: Failure): number {
  return Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= MAX_DATABASE_INTEGER
    ? (value as number)
    : failure();
}

function string(value: unknown, maximum: number, failure: Failure): string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum
    ? value
    : failure();
}

function ownerId(value: unknown, failure: Failure): string {
  const parsed = string(value, 36, failure).toLowerCase();
  return UUID_PATTERN.test(parsed) ? parsed : failure();
}

function idempotencyKey(value: unknown, failure: Failure): string {
  const parsed = string(value, 80, failure);
  return IDEMPOTENCY_KEY_PATTERN.test(parsed) ? parsed : failure();
}

function entityId<Kind extends "fbk" | "rule">(
  value: unknown,
  kind: Kind,
  failure: Failure
): EntityId<Kind> {
  const parsed = entityIdSchema(kind).safeParse(value);
  return parsed.success ? parsed.data : failure();
}

function timestamp(value: unknown, failure: Failure): string {
  if (typeof value !== "string") return failure();
  try {
    return canonicalUtcTimestampFromMicros(
      encryptedCaptureTimestampMicros(value, failure),
      failure
    );
  } catch {
    return failure();
  }
}

function scope(value: unknown, failure: Failure): EncryptedRoutingRuleWriteScope {
  return value === "create_routing_rule" ||
    value === "update_routing_rule" ||
    value === "observe_routing_rule_proposal" ||
    value === "accept_routing_rule_proposal" ||
    value === "decline_routing_rule_proposal"
    ? value
    : failure();
}

function claimScope(value: unknown, failure: Failure): EncryptedRoutingRuleClaimScope {
  return value === "delete_routing_rule" ? value : scope(value, failure);
}

function safeInteger(value: unknown, minimum: number, failure: Failure): number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
    ? (value as number)
    : failure();
}

function requestMacKey(value: unknown, failure: Failure): RoutingRuleRequestMacKey {
  const record = exactRecord(value, ["keyId", "keyClass", "keyPurpose", "keyVersion"], failure);
  const keyId = string(record.keyId, 128, failure);
  if (
    !KEY_ID_PATTERN.test(keyId) ||
    record.keyClass !== "private_manual" ||
    record.keyPurpose !== "content_mac"
  ) {
    return failure();
  }
  return Object.freeze({
    keyId,
    keyClass: "private_manual" as const,
    keyPurpose: "content_mac" as const,
    keyVersion: integer(record.keyVersion, 1, failure)
  });
}

function observationReservation(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    scope: EncryptedRoutingRuleClaimScope;
    expectedRevision: number;
    completed: boolean;
  }>,
  failure: Failure
): PreparedRoutingRuleObservationReservation | null {
  const required = expected.scope === "observe_routing_rule_proposal" && !expected.completed;
  if (!required) return value === null ? null : failure();
  const record = exactRecord(value, ["reservationId", "operationCount", "key"], failure);
  const reservationId = string(record.reservationId, 36, failure);
  const operationCount = integer(record.operationCount, 1, failure);
  const expectedOperationCount = expected.expectedRevision === 0 ? 2 : 1;
  let key: ManagedKeyRecord;
  try {
    key = parseAnyManagedKeyRecord(record.key);
  } catch {
    return failure();
  }
  if (
    !UUID_PATTERN.test(reservationId) ||
    operationCount !== expectedOperationCount ||
    key.ownerId !== expected.ownerId ||
    key.keyClass !== "private_manual" ||
    key.purpose !== "object_wrap" ||
    (key.status !== "active" && key.status !== "retired")
  ) {
    return failure();
  }
  return Object.freeze({
    reservationId,
    operationCount,
    key
  });
}

function storedCipher<Kind extends "idempotency_response" | "routing_rule">(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
    keyClass: KeyClass;
  }>,
  failure: Failure
): EncryptedAggregateRecord<Kind> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const keyId = string(record.keyId, 128, failure);
  if (
    !KEY_ID_PATTERN.test(keyId) ||
    record.keyClass !== expected.keyClass ||
    record.keyPurpose !== "object_wrap"
  ) {
    return failure();
  }
  let envelope;
  try {
    envelope = parseContentEnvelope(serializeContentEnvelope(record.envelope));
  } catch {
    return failure();
  }
  if (
    envelope.keyId !== keyId ||
    envelope.context.tenantId !== expected.ownerId ||
    envelope.context.resourceId !== expected.resourceId ||
    envelope.context.recordVersion !== expected.recordVersion ||
    envelope.context.kind !== expected.kind
  ) {
    return failure();
  }
  return Object.freeze({
    ownerId: expected.ownerId,
    resourceId: expected.resourceId,
    recordVersion: expected.recordVersion,
    kind: expected.kind,
    envelope,
    keyId,
    keyClass: expected.keyClass,
    keyPurpose: "object_wrap" as const,
    keyVersion: integer(record.keyVersion, 1, failure)
  });
}

function commandMac(value: unknown, failure: Failure): KeyedMacRpcValue {
  const record = exactRecord(
    value,
    ["mac", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const keyId = string(record.keyId, 128, failure);
  if (
    typeof record.mac !== "string" ||
    !MAC_PATTERN.test(record.mac) ||
    !KEY_ID_PATTERN.test(keyId) ||
    record.keyClass !== "private_manual" ||
    record.keyPurpose !== "content_mac"
  ) {
    return failure();
  }
  return Object.freeze({
    mac: record.mac,
    keyId,
    keyClass: "private_manual" as const,
    keyPurpose: "content_mac" as const,
    keyVersion: integer(record.keyVersion, 1, failure)
  });
}

function commandCipher<Kind extends "idempotency_response" | "routing_rule">(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
  }>,
  failure: Failure
): EncryptedFieldRpcValue<Kind> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion", "reservationId"],
    failure
  );
  const reservationId = string(record.reservationId, 128, failure);
  if (!UUID_PATTERN.test(reservationId)) return failure();
  const stored = storedCipher(
    {
      envelope: record.envelope,
      keyId: record.keyId,
      keyClass: record.keyClass,
      keyPurpose: record.keyPurpose,
      keyVersion: record.keyVersion
    },
    { ...expected, keyClass: "private_manual" },
    failure
  );
  return Object.freeze({
    envelope: stored.envelope,
    keyId: stored.keyId,
    keyClass: "private_manual" as const,
    keyPurpose: "object_wrap" as const,
    keyVersion: stored.keyVersion,
    reservationId
  });
}

function destinationFields(
  kindValue: unknown,
  idValue: unknown,
  failure: Failure
): Readonly<{ destinationKind: "note" | "space"; destinationId: string }> {
  const candidate =
    kindValue === "note"
      ? { type: "note", noteId: idValue }
      : kindValue === "space"
        ? { type: "space", spaceId: idValue }
        : null;
  const parsed = RoutingRuleDestinationSchema.safeParse(candidate);
  if (!parsed.success) return failure();
  return parsed.data.type === "note"
    ? { destinationKind: "note", destinationId: parsed.data.noteId }
    : { destinationKind: "space", destinationId: parsed.data.spaceId };
}

function parsePrepare(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    scope: EncryptedRoutingRuleWriteScope;
    idempotencyKey: string;
    ruleId: EntityId<"rule"> | null;
    expectedRevision: number;
    expectedObservationEpoch: number | null;
    requestMac: KeyedMacRpcValue;
  }>
): PreparedEncryptedRoutingRuleWrite {
  const record = exactRecord(
    value,
    [
      "scope",
      "ruleId",
      "expectedRevision",
      "targetRevision",
      "conditionRevision",
      "targetConditionRevision",
      "expectedObservationEpoch",
      "occurredAt",
      "requestMacKey",
      "reservation",
      "completed",
      "encryptedResponse",
      "replayed"
    ],
    projectionFailure
  );
  const parsedScope = scope(record.scope, projectionFailure);
  const parsedRuleId = entityId(record.ruleId, "rule", projectionFailure);
  const parsedExpectedRevision = integer(record.expectedRevision, 0, projectionFailure);
  const targetRevision = integer(record.targetRevision, 1, projectionFailure);
  const conditionRevision = integer(record.conditionRevision, 0, projectionFailure);
  const targetConditionRevision = integer(record.targetConditionRevision, 1, projectionFailure);
  const expectedObservationEpoch =
    record.expectedObservationEpoch === null
      ? null
      : safeInteger(record.expectedObservationEpoch, 0, projectionFailure);
  const key = requestMacKey(record.requestMacKey, projectionFailure);
  if (typeof record.completed !== "boolean") return projectionFailure();
  if (
    parsedScope !== expected.scope ||
    parsedExpectedRevision !== expected.expectedRevision ||
    expectedObservationEpoch !== expected.expectedObservationEpoch ||
    (expected.ruleId !== null && parsedRuleId !== expected.ruleId) ||
    key.keyId !== expected.requestMac.keyId ||
    key.keyClass !== expected.requestMac.keyClass ||
    key.keyVersion !== expected.requestMac.keyVersion ||
    typeof record.replayed !== "boolean" ||
    (record.completed && !record.replayed) ||
    targetRevision !== parsedExpectedRevision + 1 ||
    targetConditionRevision < Math.max(1, conditionRevision)
  ) {
    return projectionFailure();
  }
  const encryptedResponse = record.completed
    ? storedCipher(
        record.encryptedResponse,
        {
          ownerId: expected.ownerId,
          resourceId: `idempotency:${expected.idempotencyKey}`,
          recordVersion: 1,
          kind: "idempotency_response",
          keyClass: "private_manual"
        },
        projectionFailure
      )
    : record.encryptedResponse === null
      ? null
      : projectionFailure();
  const reservation = observationReservation(
    record.reservation,
    {
      ownerId: expected.ownerId,
      scope: parsedScope,
      expectedRevision: parsedExpectedRevision,
      completed: record.completed
    },
    projectionFailure
  );
  return Object.freeze({
    scope: parsedScope,
    ruleId: parsedRuleId,
    expectedRevision: parsedExpectedRevision,
    targetRevision,
    conditionRevision,
    targetConditionRevision,
    expectedObservationEpoch,
    occurredAt: timestamp(record.occurredAt, projectionFailure),
    requestMacKey: key,
    reservation,
    completed: record.completed,
    encryptedResponse,
    replayed: record.replayed
  });
}

function parseObservationEpoch(value: unknown): number {
  const record = exactRecord(value, ["observationEpoch"], projectionFailure);
  return safeInteger(record.observationEpoch, 0, projectionFailure);
}

function parseAbandonedObservation(value: unknown): void {
  const record = exactRecord(value, ["abandoned"], projectionFailure);
  if (record.abandoned !== true) return projectionFailure();
}

function parseClaim(
  value: unknown,
  expected: Readonly<{ ownerId: string; idempotencyKey: string }>
): EncryptedRoutingRuleWriteClaim {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Readonly<Record<string, unknown>>).found === false
  ) {
    exactRecord(value, ["found"], projectionFailure);
    return Object.freeze({ found: false as const });
  }
  const record = exactRecord(
    value,
    [
      "found",
      "scope",
      "ruleId",
      "expectedRevision",
      "targetRevision",
      "conditionRevision",
      "targetConditionRevision",
      "expectedObservationEpoch",
      "occurredAt",
      "requestMacKey",
      "reservation",
      "completed",
      "encryptedResponse",
      "replayed"
    ],
    projectionFailure
  );
  if (record.found !== true || record.replayed !== true || typeof record.completed !== "boolean") {
    return projectionFailure();
  }
  const parsedScope = claimScope(record.scope, projectionFailure);
  const parsedRuleId = entityId(record.ruleId, "rule", projectionFailure);
  const expectedRevision = integer(record.expectedRevision, 0, projectionFailure);
  const targetRevision = integer(record.targetRevision, 1, projectionFailure);
  const conditionRevision = integer(record.conditionRevision, 0, projectionFailure);
  const targetConditionRevision = integer(record.targetConditionRevision, 1, projectionFailure);
  const expectedObservationEpoch =
    record.expectedObservationEpoch === null
      ? null
      : safeInteger(record.expectedObservationEpoch, 0, projectionFailure);
  const observe = parsedScope === "observe_routing_rule_proposal";
  if (
    (observe ? expectedObservationEpoch === null : expectedObservationEpoch !== null) ||
    (parsedScope === "delete_routing_rule"
      ? targetRevision !== expectedRevision && targetRevision !== expectedRevision + 1
      : targetRevision !== expectedRevision + 1) ||
    targetConditionRevision < Math.max(1, conditionRevision)
  ) {
    return projectionFailure();
  }
  const encryptedResponse = record.completed
    ? storedCipher(
        record.encryptedResponse,
        {
          ownerId: expected.ownerId,
          resourceId: `idempotency:${expected.idempotencyKey}`,
          recordVersion: 1,
          kind: "idempotency_response",
          keyClass: "private_manual"
        },
        projectionFailure
      )
    : record.encryptedResponse === null
      ? null
      : projectionFailure();
  const reservation = observationReservation(
    record.reservation,
    {
      ownerId: expected.ownerId,
      scope: parsedScope,
      expectedRevision,
      completed: record.completed
    },
    projectionFailure
  );
  return Object.freeze({
    found: true as const,
    scope: parsedScope,
    ruleId: parsedRuleId,
    expectedRevision,
    targetRevision,
    conditionRevision,
    targetConditionRevision,
    expectedObservationEpoch,
    occurredAt: timestamp(record.occurredAt, projectionFailure),
    requestMacKey: requestMacKey(record.requestMacKey, projectionFailure),
    reservation,
    completed: record.completed,
    encryptedResponse,
    replayed: true as const
  });
}

function parseResult(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    idempotencyKey: string;
    ruleId: EntityId<"rule">;
  }>
): EncryptedRoutingRuleWriteResult {
  const record = exactRecord(
    value,
    [
      "ruleId",
      "currentRevision",
      "conditionRevision",
      "proposalState",
      "encryptedResponse",
      "replayed"
    ],
    projectionFailure
  );
  const parsedRuleId = entityId(record.ruleId, "rule", projectionFailure);
  const proposalState =
    record.proposalState === null ||
    record.proposalState === "observing" ||
    record.proposalState === "offered" ||
    record.proposalState === "accepted" ||
    record.proposalState === "declined"
      ? record.proposalState
      : projectionFailure();
  if (parsedRuleId !== expected.ruleId || typeof record.replayed !== "boolean") {
    return projectionFailure();
  }
  return Object.freeze({
    ruleId: parsedRuleId,
    currentRevision: integer(record.currentRevision, 1, projectionFailure),
    conditionRevision: integer(record.conditionRevision, 1, projectionFailure),
    proposalState,
    encryptedResponse: storedCipher(
      record.encryptedResponse,
      {
        ownerId: expected.ownerId,
        resourceId: `idempotency:${expected.idempotencyKey}`,
        recordVersion: 1,
        kind: "idempotency_response",
        keyClass: "private_manual"
      },
      projectionFailure
    ),
    replayed: record.replayed
  });
}

function parseCommonCommand(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    idempotencyKey: string;
    scope?: EncryptedRoutingRuleWriteScope;
    ruleId: EntityId<"rule">;
    targetConditionRevision: number;
  }>,
  keys: readonly string[]
): UnknownRecord {
  const record = exactRecord(value, keys, inputFailure);
  if (expected.scope !== undefined && scope(record.scope, inputFailure) !== expected.scope) {
    return inputFailure();
  }
  timestamp(record.occurredAt, inputFailure);
  commandMac(record.requestMac, inputFailure);
  commandCipher(
    record.responseCipher,
    {
      ownerId: expected.ownerId,
      resourceId: `idempotency:${expected.idempotencyKey}`,
      recordVersion: 1,
      kind: "idempotency_response"
    },
    inputFailure
  );
  commandMac(record.responseVerificationMac, inputFailure);
  return record;
}

function parseCommitCommand(
  value: EncryptedRoutingRuleCommitCommand,
  expected: Readonly<{
    ownerId: string;
    idempotencyKey: string;
    scope: EncryptedRoutingRuleWriteScope;
    ruleId: EntityId<"rule">;
    targetConditionRevision: number;
  }>
): EncryptedRoutingRuleCommitCommand {
  const common = ["scope", "occurredAt", "requestMac", "responseCipher", "responseVerificationMac"];
  if (
    expected.scope === "accept_routing_rule_proposal" ||
    expected.scope === "decline_routing_rule_proposal"
  ) {
    parseCommonCommand(value, expected, common);
    return value;
  }
  const observe = expected.scope === "observe_routing_rule_proposal";
  const record = parseCommonCommand(value, expected, [
    ...common,
    ...(observe ? ["feedbackEventId"] : ["enabled"]),
    "ruleType",
    "destinationKind",
    "destinationId",
    "priority",
    "condition"
  ]);
  const parsedType = RoutingRuleTypeSchema.safeParse(record.ruleType);
  if (!parsedType.success) return inputFailure();
  destinationFields(record.destinationKind, record.destinationId, inputFailure);
  integer(record.priority, 0, inputFailure);
  if (observe) entityId(record.feedbackEventId, "fbk", inputFailure);
  else if (typeof record.enabled !== "boolean") return inputFailure();
  if (record.condition !== null) {
    const condition = exactRecord(record.condition, ["cipher", "verificationMac"], inputFailure);
    commandCipher(
      condition.cipher,
      {
        ownerId: expected.ownerId,
        resourceId: expected.ruleId,
        recordVersion: expected.targetConditionRevision,
        kind: "routing_rule"
      },
      inputFailure
    );
    commandMac(condition.verificationMac, inputFailure);
  }
  return value;
}

export function createEncryptedRoutingRuleRpcAdapter(
  client: ServiceRpcClient
): EncryptedRoutingRuleRpcAdapter {
  return Object.freeze({
    async observationEpoch(input) {
      const owner = ownerId(input.ownerId, inputFailure);
      return parseObservationEpoch(
        await client.rpc("get_encrypted_routing_rule_observation_epoch", {
          p_owner_id: owner
        })
      );
    },

    async claim(input) {
      const owner = ownerId(input.ownerId, inputFailure);
      const key = idempotencyKey(input.idempotencyKey, inputFailure);
      const requestMac =
        input.requestMac === undefined ? null : commandMac(input.requestMac, inputFailure);
      return parseClaim(
        await client.rpc("get_encrypted_routing_rule_write_claim", {
          p_owner_id: owner,
          p_idempotency_key: key,
          p_request_mac: requestMac
        }),
        { ownerId: owner, idempotencyKey: key }
      );
    },

    async prepare(input) {
      const owner = ownerId(input.ownerId, inputFailure);
      const key = idempotencyKey(input.idempotencyKey, inputFailure);
      const parsedScope = scope(input.scope, inputFailure);
      const expectedRevision = integer(input.expectedRevision, 0, inputFailure);
      const parsedRuleId =
        input.ruleId === null ? null : entityId(input.ruleId, "rule", inputFailure);
      const expectedObservationEpoch =
        input.expectedObservationEpoch === null
          ? null
          : safeInteger(input.expectedObservationEpoch, 0, inputFailure);
      if (
        (parsedScope === "observe_routing_rule_proposal") !==
        (expectedObservationEpoch !== null)
      ) {
        return inputFailure();
      }
      const requestMac = commandMac(input.requestMac, inputFailure);
      return parsePrepare(
        await client.rpc("prepare_encrypted_routing_rule_write", {
          p_owner_id: owner,
          p_scope: parsedScope,
          p_idempotency_key: key,
          p_rule_id: parsedRuleId,
          p_expected_revision: expectedRevision,
          p_expected_observation_epoch: expectedObservationEpoch,
          p_request_mac: requestMac
        }),
        {
          ownerId: owner,
          scope: parsedScope,
          idempotencyKey: key,
          ruleId: parsedRuleId,
          expectedRevision,
          expectedObservationEpoch,
          requestMac
        }
      );
    },

    async abandonStaleObservation(input) {
      const owner = ownerId(input.ownerId, inputFailure);
      const key = idempotencyKey(input.idempotencyKey, inputFailure);
      const currentObservationEpoch = safeInteger(input.currentObservationEpoch, 0, inputFailure);
      const requestMac = commandMac(input.requestMac, inputFailure);
      parseAbandonedObservation(
        await client.rpc("prepare_encrypted_routing_rule_write", {
          p_owner_id: owner,
          p_scope: "abandon_stale_routing_rule_observation",
          p_idempotency_key: key,
          p_rule_id: null,
          p_expected_revision: 0,
          p_expected_observation_epoch: currentObservationEpoch,
          p_request_mac: requestMac
        })
      );
    },

    async commit(input) {
      const owner = ownerId(input.ownerId, inputFailure);
      const key = idempotencyKey(input.idempotencyKey, inputFailure);
      const ruleId = entityId(input.ruleId, "rule", inputFailure);
      const expectedRevision = integer(input.expectedRevision, 0, inputFailure);
      if (
        input.preparation.ruleId !== ruleId ||
        input.preparation.expectedRevision !== expectedRevision ||
        input.preparation.scope !== input.command.scope
      ) {
        return inputFailure();
      }
      const parsedCommand = parseCommitCommand(input.command, {
        ownerId: owner,
        idempotencyKey: key,
        scope: input.command.scope,
        ruleId,
        targetConditionRevision: input.preparation.targetConditionRevision
      });
      return parseResult(
        await client.rpc("commit_encrypted_routing_rule_write", {
          p_owner_id: owner,
          p_scope: parsedCommand.scope,
          p_idempotency_key: key,
          p_rule_id: ruleId,
          p_expected_revision: expectedRevision,
          p_command: parsedCommand
        }),
        { ownerId: owner, idempotencyKey: key, ruleId }
      );
    },

    async delete(input) {
      const owner = ownerId(input.ownerId, inputFailure);
      const key = idempotencyKey(input.idempotencyKey, inputFailure);
      const ruleId = entityId(input.ruleId, "rule", inputFailure);
      const expectedRevision = integer(input.expectedRevision, 1, inputFailure);
      const command = parseCommonCommand(
        input.command,
        {
          ownerId: owner,
          idempotencyKey: key,
          ruleId,
          targetConditionRevision: expectedRevision
        },
        ["occurredAt", "requestMac", "responseCipher", "responseVerificationMac"]
      ) as EncryptedRoutingRuleDeleteCommand;
      return parseResult(
        await client.rpc("delete_encrypted_routing_rule", {
          p_owner_id: owner,
          p_rule_id: ruleId,
          p_expected_revision: expectedRevision,
          p_idempotency_key: key,
          p_command: command
        }),
        { ownerId: owner, idempotencyKey: key, ruleId }
      );
    }
  });
}
