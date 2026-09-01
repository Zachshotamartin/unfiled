import {
  parseContentEnvelope,
  serializeContentEnvelope,
  type ContentEnvelopeV1
} from "@unfiled/content-crypto";
import { IdempotencyKeySchema, parseEntityId, type EntityId } from "@unfiled/contracts";
import type { EncryptedFieldRpcValue, KeyedMacRpcValue } from "@unfiled/encrypted-aggregate";

import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_KEY_VERSION = 999_999_999;

export const encryptedTaxonomyWriteRpcFunctions = Object.freeze([
  "get_encrypted_taxonomy_write_claim",
  "prepare_encrypted_taxonomy_write",
  "commit_encrypted_taxonomy_write"
] as const);

export type EncryptedTaxonomyWriteScope =
  "create_space" | "update_space" | "archive_space" | "create_tag" | "update_tag" | "delete_tag";

export type EncryptedTaxonomyResponseCipher = Readonly<{
  envelope: ContentEnvelopeV1;
  keyId: string;
  keyClass: "private_manual";
  keyPurpose: "object_wrap";
  keyVersion: number;
}>;

export type EncryptedTaxonomyMacKey = Readonly<{
  keyId: string;
  keyClass: "private_manual";
  keyPurpose: "content_mac";
  keyVersion: number;
}>;

type ClaimFields = Readonly<{
  ownerId: string;
  idempotencyKey: string;
  scope: EncryptedTaxonomyWriteScope;
  resourceId: EntityId<"spc"> | EntityId<"tag">;
  expectedRevision: number;
  occurredAt: string;
  requestMacKey: EncryptedTaxonomyMacKey;
}>;

export type IncompleteEncryptedTaxonomyWriteClaim = ClaimFields &
  Readonly<{ completed: false; encryptedResponse: null }>;
export type CompletedEncryptedTaxonomyWriteClaim = ClaimFields &
  Readonly<{ completed: true; encryptedResponse: EncryptedTaxonomyResponseCipher }>;
export type EncryptedTaxonomyWriteClaim =
  IncompleteEncryptedTaxonomyWriteClaim | CompletedEncryptedTaxonomyWriteClaim;

export type PrepareEncryptedTaxonomyWriteInput = Readonly<{
  ownerId: string;
  scope: EncryptedTaxonomyWriteScope;
  idempotencyKey: string;
  resourceId: EntityId<"spc"> | EntityId<"tag"> | null;
  expectedRevision: number;
  requestMac: KeyedMacRpcValue;
}>;

export type EncryptedTaxonomyDisplayCommand<Kind extends "space_display" | "tag_display"> =
  Readonly<{
    cipher: EncryptedFieldRpcValue<Kind>;
    semanticMac: KeyedMacRpcValue;
    verificationMac: KeyedMacRpcValue;
  }>;

type CommandBase = Readonly<{
  occurredAt: string;
  requestMac: KeyedMacRpcValue;
  responseCipher: EncryptedFieldRpcValue<"idempotency_response">;
  responseVerificationMac: KeyedMacRpcValue;
}>;

export type EncryptedTaxonomyCommand =
  | (CommandBase &
      Readonly<{
        scope: "create_space" | "update_space" | "archive_space";
        parentId: EntityId<"spc"> | null;
        sortKey: string;
        archivedAt: string | null;
        display: EncryptedTaxonomyDisplayCommand<"space_display">;
      }>)
  | (CommandBase &
      Readonly<{
        scope: "create_tag" | "update_tag";
        display: EncryptedTaxonomyDisplayCommand<"tag_display">;
      }>)
  | (CommandBase & Readonly<{ scope: "delete_tag" }>);

export type EncryptedTaxonomyWriteResult = Readonly<{
  resourceId: EntityId<"spc"> | EntityId<"tag">;
  currentRevision: number;
  encryptedResponse: EncryptedTaxonomyResponseCipher;
  replayed: boolean;
}>;

export type EncryptedTaxonomyRpcAdapter = Readonly<{
  getWriteClaim(input: {
    ownerId: string;
    scope: EncryptedTaxonomyWriteScope;
    idempotencyKey: string;
  }): Promise<EncryptedTaxonomyWriteClaim | null>;
  prepareWrite(input: PrepareEncryptedTaxonomyWriteInput): Promise<{
    claim: EncryptedTaxonomyWriteClaim;
    replayed: boolean;
  }>;
  commitWrite(input: {
    claim: IncompleteEncryptedTaxonomyWriteClaim;
    command: EncryptedTaxonomyCommand;
  }): Promise<EncryptedTaxonomyWriteResult>;
}>;

const CLAIM_KEYS = [
  "scope",
  "resourceId",
  "expectedRevision",
  "occurredAt",
  "requestMacKey",
  "completed",
  "encryptedResponse"
] as const;

type Failure = () => never;

function inputFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function projectionFailure(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function ownerId(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failure();
  return value.toLowerCase();
}

function idempotencyKey(value: unknown, failure: Failure): string {
  const parsed = IdempotencyKeySchema.safeParse(value);
  if (!parsed.success) return failure();
  return parsed.data;
}

function scope(value: unknown, failure: Failure): EncryptedTaxonomyWriteScope {
  if (
    value !== "create_space" &&
    value !== "update_space" &&
    value !== "archive_space" &&
    value !== "create_tag" &&
    value !== "update_tag" &&
    value !== "delete_tag"
  ) {
    return failure();
  }
  return value;
}

function resourceKind(value: EncryptedTaxonomyWriteScope): "spc" | "tag" {
  return value.endsWith("_space") ? "spc" : "tag";
}

function resourceId(
  value: unknown,
  writeScope: EncryptedTaxonomyWriteScope,
  failure: Failure
): EntityId<"spc"> | EntityId<"tag"> {
  if (typeof value !== "string") return failure();
  const kind = resourceKind(writeScope);
  try {
    parseEntityId(value, kind);
  } catch {
    return failure();
  }
  return value as EntityId<"spc"> | EntityId<"tag">;
}

function integer(value: unknown, minimum: number, maximum: number, failure: Failure): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return failure();
  }
  return value;
}

function timestamp(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return failure();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return failure();
  return value;
}

function parseMac(value: unknown, failure: Failure): KeyedMacRpcValue {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["mac", "keyId", "keyClass", "keyPurpose", "keyVersion"]) ||
    typeof value.mac !== "string" ||
    !MAC_PATTERN.test(value.mac) ||
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    value.keyClass !== "private_manual" ||
    value.keyPurpose !== "content_mac"
  ) {
    return failure();
  }
  return Object.freeze({
    mac: value.mac,
    keyId: value.keyId,
    keyClass: "private_manual",
    keyPurpose: "content_mac",
    keyVersion: integer(value.keyVersion, 1, MAX_KEY_VERSION, failure)
  });
}

function parseMacKey(value: unknown, failure: Failure): EncryptedTaxonomyMacKey {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["keyId", "keyClass", "keyPurpose", "keyVersion"]) ||
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    value.keyClass !== "private_manual" ||
    value.keyPurpose !== "content_mac"
  ) {
    return failure();
  }
  return Object.freeze({
    keyId: value.keyId,
    keyClass: "private_manual",
    keyPurpose: "content_mac",
    keyVersion: integer(value.keyVersion, 1, MAX_KEY_VERSION, failure)
  });
}

function envelope(value: unknown, failure: Failure): ContentEnvelopeV1 {
  try {
    return parseContentEnvelope(serializeContentEnvelope(value));
  } catch {
    return failure();
  }
}

function parseCipher<Kind extends "space_display" | "tag_display" | "idempotency_response">(
  value: unknown,
  expected: {
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: Kind;
  },
  includeReservation: boolean,
  failure: Failure
): EncryptedTaxonomyResponseCipher | EncryptedFieldRpcValue<Kind> {
  const keys = ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"];
  if (includeReservation) keys.push("reservationId");
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    value.keyClass !== "private_manual" ||
    value.keyPurpose !== "object_wrap" ||
    (includeReservation &&
      (typeof value.reservationId !== "string" || !UUID_PATTERN.test(value.reservationId)))
  ) {
    return failure();
  }
  const parsedEnvelope = envelope(value.envelope, failure);
  if (
    parsedEnvelope.keyId !== value.keyId ||
    parsedEnvelope.context.tenantId !== expected.ownerId ||
    parsedEnvelope.context.resourceId !== expected.resourceId ||
    parsedEnvelope.context.recordVersion !== expected.recordVersion ||
    parsedEnvelope.context.kind !== expected.kind
  ) {
    return failure();
  }
  const base = {
    envelope: parsedEnvelope,
    keyId: value.keyId,
    keyClass: "private_manual" as const,
    keyPurpose: "object_wrap" as const,
    keyVersion: integer(value.keyVersion, 1, MAX_KEY_VERSION, failure)
  };
  return includeReservation
    ? Object.freeze({ ...base, reservationId: value.reservationId as string })
    : Object.freeze(base);
}

function sameMacKey(left: EncryptedTaxonomyMacKey, right: KeyedMacRpcValue): boolean {
  return (
    left.keyId === right.keyId &&
    left.keyClass === right.keyClass &&
    left.keyVersion === right.keyVersion
  );
}

function parseClaim(
  value: unknown,
  expected: { ownerId: string; idempotencyKey: string; scope: EncryptedTaxonomyWriteScope },
  failure: Failure
): EncryptedTaxonomyWriteClaim {
  if (!isRecord(value) || !hasExactKeys(value, CLAIM_KEYS) || value.scope !== expected.scope) {
    return failure();
  }
  const parsedResourceId = resourceId(value.resourceId, expected.scope, failure);
  const expectedRevision = integer(value.expectedRevision, 0, MAX_DATABASE_INTEGER - 1, failure);
  if (
    ((expected.scope === "create_space" || expected.scope === "create_tag") &&
      expectedRevision !== 0) ||
    (expected.scope !== "create_space" &&
      expected.scope !== "create_tag" &&
      expectedRevision < 1) ||
    typeof value.completed !== "boolean"
  ) {
    return failure();
  }
  const requestMacKey = parseMacKey(value.requestMacKey, failure);
  const base = {
    ownerId: expected.ownerId,
    idempotencyKey: expected.idempotencyKey,
    scope: expected.scope,
    resourceId: parsedResourceId,
    expectedRevision,
    occurredAt: timestamp(value.occurredAt, failure),
    requestMacKey
  };
  if (!value.completed) {
    if (value.encryptedResponse !== null) return failure();
    return Object.freeze({ ...base, completed: false, encryptedResponse: null });
  }
  if (value.encryptedResponse === null) return failure();
  return Object.freeze({
    ...base,
    completed: true,
    encryptedResponse: parseCipher(
      value.encryptedResponse,
      {
        ownerId: expected.ownerId,
        resourceId: `idempotency:${expected.idempotencyKey}`,
        recordVersion: 1,
        kind: "idempotency_response"
      },
      false,
      failure
    ) as EncryptedTaxonomyResponseCipher
  });
}

function parseLookup(value: unknown): {
  ownerId: string;
  scope: EncryptedTaxonomyWriteScope;
  idempotencyKey: string;
} {
  if (!isRecord(value) || !hasExactKeys(value, ["ownerId", "scope", "idempotencyKey"])) {
    return inputFailure();
  }
  return Object.freeze({
    ownerId: ownerId(value.ownerId, inputFailure),
    scope: scope(value.scope, inputFailure),
    idempotencyKey: idempotencyKey(value.idempotencyKey, inputFailure)
  });
}

function parsePrepare(value: unknown): PrepareEncryptedTaxonomyWriteInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ownerId",
      "scope",
      "idempotencyKey",
      "resourceId",
      "expectedRevision",
      "requestMac"
    ])
  ) {
    return inputFailure();
  }
  const parsedScope = scope(value.scope, inputFailure);
  const creating = parsedScope === "create_space" || parsedScope === "create_tag";
  const parsedRevision = integer(
    value.expectedRevision,
    creating ? 0 : 1,
    MAX_DATABASE_INTEGER - 1,
    inputFailure
  );
  if (
    (creating && (value.resourceId !== null || parsedRevision !== 0)) ||
    (!creating && value.resourceId === null)
  ) {
    return inputFailure();
  }
  return Object.freeze({
    ownerId: ownerId(value.ownerId, inputFailure),
    scope: parsedScope,
    idempotencyKey: idempotencyKey(value.idempotencyKey, inputFailure),
    resourceId: creating ? null : resourceId(value.resourceId, parsedScope, inputFailure),
    expectedRevision: parsedRevision,
    requestMac: parseMac(value.requestMac, inputFailure)
  });
}

function afterRevision(claim: IncompleteEncryptedTaxonomyWriteClaim): number {
  return claim.scope === "delete_tag" ? claim.expectedRevision : claim.expectedRevision + 1;
}

function parseCommand(
  value: unknown,
  claim: IncompleteEncryptedTaxonomyWriteClaim,
  failure: Failure
): EncryptedTaxonomyCommand {
  if (!isRecord(value)) return failure();
  const commonKeys = [
    "scope",
    "occurredAt",
    "requestMac",
    "responseCipher",
    "responseVerificationMac"
  ];
  const space =
    claim.scope === "create_space" ||
    claim.scope === "update_space" ||
    claim.scope === "archive_space";
  const tagDisplay = claim.scope === "create_tag" || claim.scope === "update_tag";
  const expectedKeys = space
    ? [...commonKeys, "parentId", "sortKey", "archivedAt", "display"]
    : tagDisplay
      ? [...commonKeys, "display"]
      : commonKeys;
  if (!hasExactKeys(value, expectedKeys) || value.scope !== claim.scope) return failure();
  const requestMac = parseMac(value.requestMac, failure);
  if (!sameMacKey(claim.requestMacKey, requestMac)) return failure();
  const responseCipher = parseCipher(
    value.responseCipher,
    {
      ownerId: claim.ownerId,
      resourceId: `idempotency:${claim.idempotencyKey}`,
      recordVersion: 1,
      kind: "idempotency_response"
    },
    true,
    failure
  ) as EncryptedFieldRpcValue<"idempotency_response">;
  const base = {
    scope: claim.scope,
    occurredAt: timestamp(value.occurredAt, failure),
    requestMac,
    responseCipher,
    responseVerificationMac: parseMac(value.responseVerificationMac, failure)
  };
  if (!space && !tagDisplay) return Object.freeze(base) as EncryptedTaxonomyCommand;
  if (
    !isRecord(value.display) ||
    !hasExactKeys(value.display, ["cipher", "semanticMac", "verificationMac"])
  ) {
    return failure();
  }
  const kind = space ? "space_display" : "tag_display";
  const display = Object.freeze({
    cipher: parseCipher(
      value.display.cipher,
      {
        ownerId: claim.ownerId,
        resourceId: claim.resourceId,
        recordVersion: afterRevision(claim),
        kind
      },
      true,
      failure
    ),
    semanticMac: parseMac(value.display.semanticMac, failure),
    verificationMac: parseMac(value.display.verificationMac, failure)
  });
  if (!space) return Object.freeze({ ...base, display }) as EncryptedTaxonomyCommand;
  if (
    value.parentId !== null &&
    (typeof value.parentId !== "string" ||
      resourceId(value.parentId, "create_space", failure) === claim.resourceId)
  ) {
    return failure();
  }
  if (
    typeof value.sortKey !== "string" ||
    value.sortKey.length < 1 ||
    value.sortKey.length > 100 ||
    value.sortKey.trim() !== value.sortKey ||
    (value.archivedAt !== null && typeof value.archivedAt !== "string")
  ) {
    return failure();
  }
  const archivedAt = value.archivedAt === null ? null : timestamp(value.archivedAt, failure);
  return Object.freeze({
    ...base,
    parentId: value.parentId as EntityId<"spc"> | null,
    sortKey: value.sortKey,
    archivedAt,
    display
  }) as EncryptedTaxonomyCommand;
}

function sameEnvelope(left: ContentEnvelopeV1, right: ContentEnvelopeV1): boolean {
  return serializeContentEnvelope(left) === serializeContentEnvelope(right);
}

export function createEncryptedTaxonomyRpcAdapter(
  client: ServiceRpcClient
): EncryptedTaxonomyRpcAdapter {
  return Object.freeze({
    async getWriteClaim(input) {
      const request = parseLookup(input);
      const value = await client.rpc("get_encrypted_taxonomy_write_claim", {
        p_owner_id: request.ownerId,
        p_scope: request.scope,
        p_idempotency_key: request.idempotencyKey
      });
      if (!isRecord(value) || typeof value.found !== "boolean") return projectionFailure();
      if (!value.found) {
        if (!hasExactKeys(value, ["found"])) return projectionFailure();
        return null;
      }
      if (!hasExactKeys(value, ["found", ...CLAIM_KEYS])) return projectionFailure();
      const claimValue = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "found")
      );
      return parseClaim(claimValue, request, projectionFailure);
    },

    async prepareWrite(input) {
      const request = parsePrepare(input);
      const value = await client.rpc("prepare_encrypted_taxonomy_write", {
        p_owner_id: request.ownerId,
        p_scope: request.scope,
        p_idempotency_key: request.idempotencyKey,
        p_resource_id: request.resourceId,
        p_expected_revision: request.expectedRevision,
        p_request_mac: request.requestMac
      });
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [...CLAIM_KEYS, "replayed"]) ||
        typeof value.replayed !== "boolean"
      ) {
        return projectionFailure();
      }
      const { replayed, ...claimValue } = value;
      const claim = parseClaim(
        claimValue,
        {
          ownerId: request.ownerId,
          idempotencyKey: request.idempotencyKey,
          scope: request.scope
        },
        projectionFailure
      );
      if (
        (request.resourceId !== null && claim.resourceId !== request.resourceId) ||
        claim.expectedRevision !== request.expectedRevision ||
        !sameMacKey(claim.requestMacKey, request.requestMac) ||
        (claim.completed && !replayed)
      ) {
        return projectionFailure();
      }
      return Object.freeze({ claim, replayed });
    },

    async commitWrite(input) {
      if (!isRecord(input) || !hasExactKeys(input, ["claim", "command"])) return inputFailure();
      const claim = input.claim;
      const parsedCommand = parseCommand(input.command, claim, inputFailure);
      const value = await client.rpc("commit_encrypted_taxonomy_write", {
        p_owner_id: claim.ownerId,
        p_scope: claim.scope,
        p_idempotency_key: claim.idempotencyKey,
        p_resource_id: claim.resourceId,
        p_expected_revision: claim.expectedRevision,
        p_command: parsedCommand
      });
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ["resourceId", "currentRevision", "encryptedResponse", "replayed"]) ||
        value.resourceId !== claim.resourceId ||
        value.currentRevision !== afterRevision(claim) ||
        typeof value.replayed !== "boolean"
      ) {
        return projectionFailure();
      }
      const encryptedResponse = parseCipher(
        value.encryptedResponse,
        {
          ownerId: claim.ownerId,
          resourceId: `idempotency:${claim.idempotencyKey}`,
          recordVersion: 1,
          kind: "idempotency_response"
        },
        false,
        projectionFailure
      ) as EncryptedTaxonomyResponseCipher;
      if (
        !value.replayed &&
        (encryptedResponse.keyId !== parsedCommand.responseCipher.keyId ||
          encryptedResponse.keyVersion !== parsedCommand.responseCipher.keyVersion ||
          !sameEnvelope(encryptedResponse.envelope, parsedCommand.responseCipher.envelope))
      ) {
        return projectionFailure();
      }
      return Object.freeze({
        resourceId: claim.resourceId,
        currentRevision: afterRevision(claim),
        encryptedResponse,
        replayed: value.replayed
      });
    }
  });
}
