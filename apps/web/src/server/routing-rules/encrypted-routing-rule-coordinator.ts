import {
  RoutingRuleCreateRequestSchema,
  RoutingRuleDeleteRequestSchema,
  RoutingRuleDeleteResponseSchema,
  RoutingRuleDtoSchema,
  RoutingRuleMutationResponseSchema,
  RoutingRuleUpdateRequestSchema,
  entityIdSchema,
  type EntityId,
  type RoutingRuleCreateRequest,
  type RoutingRuleDeleteRequest,
  type RoutingRuleDeleteResponse,
  type RoutingRuleDto,
  type RoutingRuleListQuery,
  type RoutingRuleListResponse,
  type RoutingRuleMutationResponse,
  type RoutingRuleUpdateRequest
} from "@unfiled/contracts";
import { normalizeRoutingRuleText } from "@unfiled/ai-routing/routing-rules";
import {
  RoutingRulePayloadSchema,
  encryptedFieldForRpc,
  keyedMacForRpc,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateService,
  type EncryptedIdempotencyRecord,
  type KeyedMacRecord,
  type LogicalApiRequest,
  type ObjectWrapReservation,
  type PayloadCodec,
  type PrivacyTransition,
  type RoutingRulePayload
} from "@unfiled/encrypted-aggregate";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  objectWrapReservationsFromRoutingRulePreparation,
  type EncryptedRoutingRuleCommitCommand,
  type EncryptedRoutingRuleRpcAdapter,
  type EncryptedRoutingRuleWriteResult,
  type EncryptedRoutingRuleWriteScope,
  type PreparedEncryptedRoutingRuleWrite,
  type RoutingRuleRequestMacKey
} from "@/server/encryption/encrypted-routing-rule-rpc-adapter";
import type { PreparedOwnerEncryptedAggregateService } from "@/server/encryption/encrypted-aggregate-runtime";
import {
  ServiceRpcError,
  ServiceRpcErrorCode,
  throwIfServiceOperationAborted
} from "@/server/encryption/service-rpc-client";

import type { EncryptedRoutingRuleReader } from "./encrypted-routing-rule-reader";

const StoredRoutingRuleMutationSchema = z.strictObject({ rule: RoutingRuleDtoSchema });
type StoredRoutingRuleMutation = z.infer<typeof StoredRoutingRuleMutationSchema>;

const StoredRoutingRuleDeleteSchema = z.strictObject({
  ruleId: z.string(),
  deleted: z.literal(true)
});
type StoredRoutingRuleDelete = z.infer<typeof StoredRoutingRuleDeleteSchema>;

const LearnedRuleObservationSchema = z.strictObject({
  feedbackEventId: entityIdSchema("fbk"),
  captureText: z.string().min(1).max(10_000),
  destination: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("note"), noteId: entityIdSchema("note") }),
    z.strictObject({ type: z.literal("space"), spaceId: entityIdSchema("spc") })
  ])
});
export type LearnedRuleObservation = z.infer<typeof LearnedRuleObservationSchema>;

const LearnedRuleLogicalPayloadSchema = z.strictObject({
  feedbackEventId: entityIdSchema("fbk"),
  ruleType: z.enum(["prefix", "phrase"]),
  condition: z.string().min(1).max(500),
  normalizedCondition: z.string().min(1).max(500),
  destination: LearnedRuleObservationSchema.shape.destination,
  priority: z.number().int().min(0).max(10_000)
});
type LearnedRuleLogicalPayload = z.infer<typeof LearnedRuleLogicalPayloadSchema>;

const StoredLearnedRuleObservationSchema = z.strictObject({
  ruleId: entityIdSchema("rule"),
  proposalState: z.enum(["observing", "offered"])
});
type StoredLearnedRuleObservation = z.infer<typeof StoredLearnedRuleObservationSchema>;

export type EncryptedRoutingRuleCoordinatorDependencies = Readonly<{
  ownerId: string;
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  createPreparedService(
    reservations: readonly ObjectWrapReservation[]
  ): PreparedOwnerEncryptedAggregateService;
  adapter: EncryptedRoutingRuleRpcAdapter;
  reader: EncryptedRoutingRuleReader;
  signal?: AbortSignal;
  now?: () => Date;
}>;

type RuleWriteContext<Request, Response> = Readonly<{
  scope: EncryptedRoutingRuleWriteScope;
  ruleId: EntityId<"rule"> | null;
  expectedRevision: number;
  expectedObservationEpoch: number | null;
  idempotencyKey: string;
  request: Request;
  requestCodec: PayloadCodec<Request>;
  responseCodec: PayloadCodec<Response>;
}>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function validatedInput<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalidInput();
  return parsed.data;
}

function notFound(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND);
}

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function invalidIdempotencyKey(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY);
}

function observationStale(error: unknown): boolean {
  return (
    error instanceof ServiceRpcError &&
    error.code === ServiceRpcErrorCode.ROUTING_RULE_OBSERVATION_STALE
  );
}

function logicalRequest<Payload>(
  scope: string,
  targetResourceId: string | null,
  expectedRevision: number | null,
  payload: Payload
): LogicalApiRequest<Payload> {
  return Object.freeze({
    schemaVersion: 1,
    scope,
    targetResourceId,
    expectedRevision,
    payload
  });
}

function transitionFor(expectedRevision: number): PrivacyTransition {
  return Object.freeze({
    before: expectedRevision === 0 ? null : "private_manual",
    after: "private_manual"
  });
}

function payload(condition: string): RoutingRulePayload {
  const normalizedCondition = normalizeRoutingRuleText(condition);
  if (normalizedCondition.length === 0) return invalidInput();
  const parsed = RoutingRulePayloadSchema.safeParse({
    schemaVersion: 1,
    condition,
    normalizedCondition,
    aliases: []
  });
  if (!parsed.success) return invalidInput();
  return parsed.data;
}

function learnedCondition(captureText: string): Readonly<{
  ruleType: "prefix" | "phrase";
  payload: RoutingRulePayload;
}> {
  const normalizedCapture = normalizeRoutingRuleText(captureText);
  if (normalizedCapture.length === 0) return invalidInput();
  const prefixDelimiter = normalizedCapture.indexOf(":");
  let ruleType: "prefix" | "phrase" = "phrase";
  let candidate = Array.from(normalizedCapture).slice(0, 80).join("");
  if (prefixDelimiter > 0 && prefixDelimiter <= 32) {
    ruleType = "prefix";
    candidate = normalizedCapture.slice(0, prefixDelimiter);
  }

  // Truncation can turn an internal space or punctuation mark into trailing
  // syntax. Canonicalize after choosing the learned boundary, then carry this
  // one value through request identity, encrypted storage, and lookup.
  const condition = normalizeRoutingRuleText(candidate);
  if (condition.length === 0) return invalidInput();
  const parsed = RoutingRulePayloadSchema.safeParse({
    schemaVersion: 1,
    condition,
    normalizedCondition: condition,
    aliases: []
  });
  if (!parsed.success) return invalidInput();
  return Object.freeze({
    ruleType,
    payload: parsed.data
  });
}

function destinationColumns(destination: RoutingRuleDto["destination"]): Readonly<{
  destinationKind: "note" | "space";
  destinationId: string;
}> {
  return destination.type === "note"
    ? Object.freeze({ destinationKind: "note" as const, destinationId: destination.noteId })
    : Object.freeze({ destinationKind: "space" as const, destinationId: destination.spaceId });
}

function idempotencyRecord(
  ownerId: string,
  idempotencyKey: string,
  requestMac: KeyedMacRecord,
  response: EncryptedRoutingRuleWriteResult["encryptedResponse"]
): EncryptedIdempotencyRecord {
  return Object.freeze({
    ownerId,
    idempotencyKey,
    keyClass: "private_manual",
    requestMac,
    response
  });
}

function exactAcceptRequest(request: RoutingRuleUpdateRequest): boolean {
  return (
    request.enabled === true &&
    request.ruleType === undefined &&
    request.condition === undefined &&
    request.destination === undefined &&
    request.priority === undefined
  );
}

function mergedRule(
  current: RoutingRuleDto,
  request: RoutingRuleUpdateRequest,
  preparation: PreparedEncryptedRoutingRuleWrite,
  accepting: boolean,
  updatedCondition: RoutingRulePayload | null
): RoutingRuleDto {
  return RoutingRuleDtoSchema.parse({
    ...current,
    revision: preparation.targetRevision,
    enabled: accepting ? true : (request.enabled ?? current.enabled),
    ruleType: request.ruleType ?? current.ruleType,
    condition: updatedCondition?.condition ?? current.condition,
    normalizedCondition: updatedCondition?.normalizedCondition ?? current.normalizedCondition,
    aliases: updatedCondition?.aliases ?? current.aliases,
    destination: request.destination ?? current.destination,
    destinationStatus: request.destination === undefined ? current.destinationStatus : "active",
    priority: request.priority ?? current.priority,
    proposalState: accepting ? "accepted" : current.proposalState,
    updatedAt: preparation.occurredAt
  });
}

export class EncryptedRoutingRuleCoordinator {
  private readonly ownerId: string;
  private readonly now: () => Date;

  public constructor(private readonly dependencies: EncryptedRoutingRuleCoordinatorDependencies) {
    this.ownerId = dependencies.ownerId.toLowerCase();
    this.now = dependencies.now ?? (() => new Date());
  }

  private active(): void {
    if (this.dependencies.signal !== undefined) {
      throwIfServiceOperationAborted(this.dependencies.signal);
    }
  }

  private async requestMac<Request, Response>(
    context: RuleWriteContext<Request, Response>,
    logical: LogicalApiRequest<Request>,
    key?: RoutingRuleRequestMacKey
  ): Promise<KeyedMacRecord> {
    this.active();
    const requestMac = await this.dependencies.aggregate.createIdempotencyRequestMac(
      this.dependencies.access,
      {
        idempotencyKey: context.idempotencyKey,
        transition: transitionFor(context.expectedRevision),
        logicalRequest: logical,
        requestCodec: context.requestCodec,
        ...(key === undefined
          ? {}
          : {
              keyReference: {
                ownerId: this.ownerId,
                keyClass: key.keyClass,
                purpose: key.keyPurpose,
                keyId: key.keyId,
                keyVersion: key.keyVersion
              }
            })
      }
    );
    this.active();
    return requestMac;
  }

  private async prepare<Request, Response>(
    context: RuleWriteContext<Request, Response>,
    logical: LogicalApiRequest<Request>,
    requestMac: KeyedMacRecord
  ): Promise<PreparedEncryptedRoutingRuleWrite> {
    this.active();
    const preparation = await this.dependencies.adapter.prepare({
      ownerId: this.ownerId,
      scope: context.scope,
      idempotencyKey: context.idempotencyKey,
      ruleId: context.ruleId,
      expectedRevision: context.expectedRevision,
      expectedObservationEpoch: context.expectedObservationEpoch,
      requestMac: keyedMacForRpc(requestMac)
    });
    this.active();
    return preparation;
  }

  private async openResponse<Request, Response>(
    context: RuleWriteContext<Request, Response>,
    logical: LogicalApiRequest<Request>,
    requestMac: KeyedMacRecord,
    result: EncryptedRoutingRuleWriteResult
  ): Promise<Response> {
    this.active();
    const response = await this.dependencies.aggregate.openIdempotencyResponse(
      this.dependencies.access,
      idempotencyRecord(this.ownerId, context.idempotencyKey, requestMac, result.encryptedResponse),
      {
        idempotencyKey: context.idempotencyKey,
        transition: transitionFor(context.expectedRevision),
        logicalRequest: logical,
        requestCodec: context.requestCodec,
        responseCodec: context.responseCodec
      }
    );
    this.active();
    return response;
  }

  private async openPreparedReplay<Request, Response>(
    context: RuleWriteContext<Request, Response>,
    logical: LogicalApiRequest<Request>,
    requestMac: KeyedMacRecord,
    preparation: PreparedEncryptedRoutingRuleWrite
  ): Promise<Response> {
    if (!preparation.completed || preparation.encryptedResponse === null) return unavailable();
    return this.openResponse(context, logical, requestMac, {
      ruleId: preparation.ruleId,
      currentRevision: preparation.targetRevision,
      conditionRevision: preparation.targetConditionRevision,
      proposalState: null,
      encryptedResponse: preparation.encryptedResponse,
      replayed: true
    });
  }

  private async sealResponse<Request, Response>(
    context: RuleWriteContext<Request, Response>,
    logical: LogicalApiRequest<Request>,
    requestMac: KeyedMacRecord,
    preparation: PreparedEncryptedRoutingRuleWrite,
    response: Response,
    commandFields: Omit<
      Extract<EncryptedRoutingRuleCommitCommand, Readonly<{ scope: typeof context.scope }>>,
      "scope" | "occurredAt" | "requestMac" | "responseCipher" | "responseVerificationMac"
    >,
    aggregate: EncryptedAggregateService = this.dependencies.aggregate
  ): Promise<EncryptedRoutingRuleCommitCommand> {
    this.active();
    const transition = transitionFor(context.expectedRevision);
    const [responseCipher, responseVerificationMac] = await Promise.all([
      aggregate.sealIdempotencyResponse(this.dependencies.access, {
        idempotencyKey: context.idempotencyKey,
        transition,
        response,
        responseCodec: context.responseCodec
      }),
      aggregate.createAggregateVerificationMac(this.dependencies.access, {
        surface: "idempotency_response",
        idempotencyKey: context.idempotencyKey,
        transition,
        payload: response,
        payloadCodec: context.responseCodec
      })
    ]);
    this.active();
    void logical;
    return {
      scope: context.scope,
      occurredAt: preparation.occurredAt,
      requestMac: keyedMacForRpc(requestMac),
      responseCipher: encryptedFieldForRpc(responseCipher),
      responseVerificationMac: keyedMacForRpc(responseVerificationMac),
      ...commandFields
    } as EncryptedRoutingRuleCommitCommand;
  }

  private async commit<Request, Response>(
    context: RuleWriteContext<Request, Response>,
    logical: LogicalApiRequest<Request>,
    requestMac: KeyedMacRecord,
    preparation: PreparedEncryptedRoutingRuleWrite,
    expectedResponse: Response,
    command: EncryptedRoutingRuleCommitCommand
  ): Promise<Readonly<{ response: Response; result: EncryptedRoutingRuleWriteResult }>> {
    this.active();
    const result = await this.dependencies.adapter.commit({
      ownerId: this.ownerId,
      idempotencyKey: context.idempotencyKey,
      ruleId: preparation.ruleId,
      expectedRevision: context.expectedRevision,
      preparation,
      command
    });
    const response = await this.openResponse(context, logical, requestMac, result);
    if (!isDeepStrictEqual(response, expectedResponse)) return unavailable();
    return Object.freeze({ response, result });
  }

  private async sealedCondition(
    preparation: PreparedEncryptedRoutingRuleWrite,
    value: RoutingRulePayload,
    aggregate: EncryptedAggregateService = this.dependencies.aggregate
  ) {
    const input = Object.freeze({
      ruleId: preparation.ruleId,
      recordVersion: preparation.targetConditionRevision,
      payload: value
    });
    const [cipher, verificationMac] = await Promise.all([
      aggregate.sealRoutingRule(this.dependencies.access, input),
      aggregate.createAggregateVerificationMac(this.dependencies.access, {
        surface: "routing_rule",
        ...input
      })
    ]);
    this.active();
    return Object.freeze({
      cipher: encryptedFieldForRpc(cipher),
      verificationMac: keyedMacForRpc(verificationMac)
    });
  }

  public list(query: RoutingRuleListQuery = {}): Promise<RoutingRuleListResponse> {
    return this.dependencies.reader.list(query.cursor ?? null);
  }

  public async create(
    requestValue: RoutingRuleCreateRequest
  ): Promise<RoutingRuleMutationResponse> {
    const request = validatedInput(RoutingRuleCreateRequestSchema, requestValue);
    const conditionPayload = payload(request.condition);
    const claim = await this.dependencies.adapter.claim({
      ownerId: this.ownerId,
      idempotencyKey: request.idempotencyKey
    });
    if (claim.found && (claim.scope !== "create_routing_rule" || claim.expectedRevision !== 0)) {
      return invalidIdempotencyKey();
    }
    const context: RuleWriteContext<RoutingRuleCreateRequest, StoredRoutingRuleMutation> = {
      scope: "create_routing_rule",
      ruleId: null,
      expectedRevision: 0,
      expectedObservationEpoch: null,
      idempotencyKey: request.idempotencyKey,
      request,
      requestCodec: RoutingRuleCreateRequestSchema,
      responseCodec: StoredRoutingRuleMutationSchema
    };
    const logical = logicalRequest(context.scope, null, null, request);
    const requestMac = await this.requestMac(
      context,
      logical,
      claim.found ? claim.requestMacKey : undefined
    );
    const preparation = await this.prepare(context, logical, requestMac);
    if (preparation.completed) {
      const replay = await this.openPreparedReplay(context, logical, requestMac, preparation);
      return RoutingRuleMutationResponseSchema.parse({ ...replay, replayed: true });
    }
    const rule = RoutingRuleDtoSchema.parse({
      id: preparation.ruleId,
      revision: preparation.targetRevision,
      enabled: request.enabled,
      ruleType: request.ruleType,
      condition: conditionPayload.condition,
      normalizedCondition: conditionPayload.normalizedCondition,
      aliases: conditionPayload.aliases,
      destination: request.destination,
      destinationStatus: "active",
      priority: request.priority,
      source: "explicit",
      proposalState: null,
      lastFiredAt: null,
      createdAt: preparation.occurredAt,
      updatedAt: preparation.occurredAt
    });
    const stored: StoredRoutingRuleMutation = Object.freeze({ rule });
    const command = await this.sealResponse(context, logical, requestMac, preparation, stored, {
      enabled: rule.enabled,
      ruleType: rule.ruleType,
      ...destinationColumns(rule.destination),
      priority: rule.priority,
      condition: await this.sealedCondition(preparation, conditionPayload)
    });
    const committed = await this.commit(context, logical, requestMac, preparation, stored, command);
    if (
      committed.result.currentRevision !== rule.revision ||
      committed.result.conditionRevision !== preparation.targetConditionRevision ||
      committed.result.proposalState !== null
    ) {
      return unavailable();
    }
    return RoutingRuleMutationResponseSchema.parse({
      ...committed.response,
      replayed: committed.result.replayed
    });
  }

  public async update(
    ruleId: EntityId<"rule">,
    requestValue: RoutingRuleUpdateRequest
  ): Promise<RoutingRuleMutationResponse> {
    const request = validatedInput(RoutingRuleUpdateRequestSchema, requestValue);
    const updatedCondition = request.condition === undefined ? null : payload(request.condition);
    const claim = await this.dependencies.adapter.claim({
      ownerId: this.ownerId,
      idempotencyKey: request.idempotencyKey
    });
    let opened = null;
    let scope: EncryptedRoutingRuleWriteScope;
    if (claim.found) {
      if (
        claim.ruleId !== ruleId ||
        claim.expectedRevision !== request.expectedRevision ||
        (claim.scope !== "update_routing_rule" && claim.scope !== "accept_routing_rule_proposal")
      ) {
        return invalidIdempotencyKey();
      }
      scope = claim.scope;
    } else {
      opened = await this.dependencies.reader.get(ruleId);
      if (opened === null) return notFound();
      if (opened.dto.revision !== request.expectedRevision) {
        throw new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION);
      }
      const accepting = opened.dto.proposalState === "offered";
      if (accepting ? !exactAcceptRequest(request) : opened.dto.proposalState === "offered") {
        return invalidInput();
      }
      scope = accepting ? "accept_routing_rule_proposal" : "update_routing_rule";
    }
    const context: RuleWriteContext<RoutingRuleUpdateRequest, StoredRoutingRuleMutation> = {
      scope,
      ruleId,
      expectedRevision: request.expectedRevision,
      expectedObservationEpoch: null,
      idempotencyKey: request.idempotencyKey,
      request,
      requestCodec: RoutingRuleUpdateRequestSchema,
      responseCodec: StoredRoutingRuleMutationSchema
    };
    const logical = logicalRequest(scope, ruleId, request.expectedRevision, request);
    const requestMac = await this.requestMac(
      context,
      logical,
      claim.found ? claim.requestMacKey : undefined
    );
    const preparation = await this.prepare(context, logical, requestMac);
    if (preparation.completed) {
      const replay = await this.openPreparedReplay(context, logical, requestMac, preparation);
      return RoutingRuleMutationResponseSchema.parse({ ...replay, replayed: true });
    }
    opened ??= await this.dependencies.reader.get(ruleId);
    if (opened === null) return notFound();
    if (opened.dto.revision !== request.expectedRevision) {
      throw new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION);
    }
    const accepting = scope === "accept_routing_rule_proposal";
    if (
      accepting
        ? opened.dto.proposalState !== "offered" || !exactAcceptRequest(request)
        : opened.dto.proposalState === "offered"
    ) {
      return invalidInput();
    }
    const rule = mergedRule(opened.dto, request, preparation, accepting, updatedCondition);
    const stored: StoredRoutingRuleMutation = Object.freeze({ rule });
    const command = accepting
      ? await this.sealResponse(context, logical, requestMac, preparation, stored, {})
      : await this.sealResponse(context, logical, requestMac, preparation, stored, {
          enabled: rule.enabled,
          ruleType: rule.ruleType,
          ...destinationColumns(rule.destination),
          priority: rule.priority,
          condition:
            updatedCondition === null
              ? null
              : await this.sealedCondition(preparation, updatedCondition)
        });
    const committed = await this.commit(context, logical, requestMac, preparation, stored, command);
    if (
      committed.result.currentRevision !== rule.revision ||
      committed.result.conditionRevision !==
        (request.condition === undefined
          ? preparation.conditionRevision
          : preparation.targetConditionRevision) ||
      committed.result.proposalState !== rule.proposalState
    ) {
      return unavailable();
    }
    return RoutingRuleMutationResponseSchema.parse({
      ...committed.response,
      replayed: committed.result.replayed
    });
  }

  public async delete(
    ruleId: EntityId<"rule">,
    requestValue: RoutingRuleDeleteRequest
  ): Promise<RoutingRuleDeleteResponse> {
    const request = validatedInput(RoutingRuleDeleteRequestSchema, requestValue);
    const context: RuleWriteContext<RoutingRuleDeleteRequest, StoredRoutingRuleDelete> = {
      scope: "decline_routing_rule_proposal",
      ruleId,
      expectedRevision: request.expectedRevision,
      expectedObservationEpoch: null,
      idempotencyKey: request.idempotencyKey,
      request,
      requestCodec: RoutingRuleDeleteRequestSchema,
      responseCodec: StoredRoutingRuleDeleteSchema
    };
    const logical = logicalRequest(
      "delete_routing_rule",
      ruleId,
      request.expectedRevision,
      request
    );
    const locator = await this.dependencies.adapter.claim({
      ownerId: this.ownerId,
      idempotencyKey: request.idempotencyKey
    });
    if (
      locator.found &&
      (locator.scope !== "delete_routing_rule" ||
        locator.ruleId !== ruleId ||
        locator.expectedRevision !== request.expectedRevision)
    ) {
      return invalidIdempotencyKey();
    }
    const requestMac = await this.requestMac(
      context,
      logical,
      locator.found ? locator.requestMacKey : undefined
    );
    const requestMacRpc = keyedMacForRpc(requestMac);
    const claim = await this.dependencies.adapter.claim({
      ownerId: this.ownerId,
      idempotencyKey: request.idempotencyKey,
      requestMac: requestMacRpc
    });
    if (claim.found) {
      if (
        claim.scope !== "delete_routing_rule" ||
        claim.ruleId !== ruleId ||
        claim.expectedRevision !== request.expectedRevision
      ) {
        return invalidIdempotencyKey();
      }
      if (!claim.completed || claim.encryptedResponse === null) return unavailable();
      const replay = await this.openResponse(context, logical, requestMac, {
        ruleId,
        currentRevision: claim.targetRevision,
        conditionRevision: claim.targetConditionRevision,
        proposalState: null,
        encryptedResponse: claim.encryptedResponse,
        replayed: true
      });
      return RoutingRuleDeleteResponseSchema.parse({ ...replay, replayed: true });
    }
    if (locator.found) return unavailable();
    const occurredDate = this.now();
    if (!(occurredDate instanceof Date) || !Number.isFinite(occurredDate.valueOf())) {
      return unavailable();
    }
    const transition: PrivacyTransition = Object.freeze({
      before: "private_manual",
      after: "private_manual"
    });
    const stored = StoredRoutingRuleDeleteSchema.parse({ ruleId, deleted: true });
    const [responseCipher, responseVerificationMac] = await Promise.all([
      this.dependencies.aggregate.sealIdempotencyResponse(this.dependencies.access, {
        idempotencyKey: request.idempotencyKey,
        transition,
        response: stored,
        responseCodec: StoredRoutingRuleDeleteSchema
      }),
      this.dependencies.aggregate.createAggregateVerificationMac(this.dependencies.access, {
        surface: "idempotency_response",
        idempotencyKey: request.idempotencyKey,
        transition,
        payload: stored,
        payloadCodec: StoredRoutingRuleDeleteSchema
      })
    ]);
    const result = await this.dependencies.adapter.delete({
      ownerId: this.ownerId,
      ruleId,
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey,
      command: {
        occurredAt: occurredDate.toISOString(),
        requestMac: requestMacRpc,
        responseCipher: encryptedFieldForRpc(responseCipher),
        responseVerificationMac: keyedMacForRpc(responseVerificationMac)
      }
    });
    const response = await this.openResponse(context, logical, requestMac, result);
    if (!isDeepStrictEqual(response, stored)) return unavailable();
    return RoutingRuleDeleteResponseSchema.parse({
      ...response,
      replayed: result.replayed
    });
  }

  public async observeCorrection(value: LearnedRuleObservation): Promise<void> {
    const observation = validatedInput(LearnedRuleObservationSchema, value);
    const learned = learnedCondition(observation.captureText);
    const conditionPayload = learned.payload;
    const priority = 500;
    const request: LearnedRuleLogicalPayload = LearnedRuleLogicalPayloadSchema.parse({
      feedbackEventId: observation.feedbackEventId,
      ruleType: learned.ruleType,
      condition: conditionPayload.condition,
      normalizedCondition: conditionPayload.normalizedCondition,
      destination: observation.destination,
      priority
    });
    const idempotencyKey = `ruleobs:${observation.feedbackEventId}`;
    let claim = await this.dependencies.adapter.claim({ ownerId: this.ownerId, idempotencyKey });
    if (claim.found && claim.scope !== "observe_routing_rule_proposal") {
      return invalidIdempotencyKey();
    }
    let requestMacKey = claim.found ? claim.requestMacKey : undefined;
    let staleRequestMac: KeyedMacRecord | null = null;
    let hasStaleClaim = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let ruleId: EntityId<"rule"> | null;
      let expectedRevision: number;
      let expectedObservationEpoch: number;
      if (claim.found) {
        ruleId = claim.expectedRevision === 0 ? null : claim.ruleId;
        expectedRevision = claim.expectedRevision;
        expectedObservationEpoch = claim.expectedObservationEpoch ?? unavailable();
      } else {
        expectedObservationEpoch = await this.dependencies.adapter.observationEpoch({
          ownerId: this.ownerId
        });
        const existing = await this.dependencies.reader.findLearnedProposal({
          ruleType: learned.ruleType,
          normalizedCondition: conditionPayload.normalizedCondition,
          destination: observation.destination
        });
        const state = existing?.row.operational.proposalState ?? null;
        if (state === "declined" || state === "offered" || state === "accepted") {
          if (hasStaleClaim) {
            if (staleRequestMac === null) return unavailable();
            await this.dependencies.adapter.abandonStaleObservation({
              ownerId: this.ownerId,
              idempotencyKey,
              currentObservationEpoch: expectedObservationEpoch,
              requestMac: keyedMacForRpc(staleRequestMac)
            });
          }
          return;
        }
        if (existing !== null && state !== "observing") return unavailable();
        expectedRevision = existing?.row.operational.currentRevision ?? 0;
        ruleId = (existing?.row.resourceId as EntityId<"rule"> | undefined) ?? null;
      }

      const context: RuleWriteContext<LearnedRuleLogicalPayload, StoredLearnedRuleObservation> = {
        scope: "observe_routing_rule_proposal",
        ruleId,
        expectedRevision,
        expectedObservationEpoch,
        idempotencyKey,
        request,
        requestCodec: LearnedRuleLogicalPayloadSchema,
        responseCodec: StoredLearnedRuleObservationSchema
      };
      // Keep learned-input identity stable while only the content-free
      // rule/revision/epoch plan is replaced after a concurrent observation.
      const logical = logicalRequest(context.scope, null, null, request);
      let requestMac: KeyedMacRecord | null = null;
      let claimPrepared = claim.found && !claim.completed;
      try {
        requestMac = await this.requestMac(context, logical, requestMacKey);
        const preparation = await this.prepare(context, logical, requestMac);
        requestMacKey ??= preparation.requestMacKey;
        if (preparation.completed) {
          await this.openPreparedReplay(context, logical, requestMac, preparation);
          return;
        }
        claimPrepared = true;
        const proposalState = expectedRevision === 0 ? "observing" : "offered";
        const stored = StoredLearnedRuleObservationSchema.parse({
          ruleId: preparation.ruleId,
          proposalState
        });
        if (preparation.reservation === null) return unavailable();
        const expectedOperationCount = expectedRevision === 0 ? 2 : 1;
        if (preparation.reservation.operationCount !== expectedOperationCount) {
          return unavailable();
        }
        const preparedAggregate = this.dependencies.createPreparedService(
          objectWrapReservationsFromRoutingRulePreparation(preparation.reservation)
        );
        const condition =
          expectedRevision === 0
            ? await this.sealedCondition(preparation, conditionPayload, preparedAggregate.service)
            : null;
        const command = await this.sealResponse(
          context,
          logical,
          requestMac,
          preparation,
          stored,
          {
            ruleType: learned.ruleType,
            ...destinationColumns(observation.destination),
            priority,
            feedbackEventId: observation.feedbackEventId,
            condition
          },
          preparedAggregate.service
        );
        if (command.scope !== "observe_routing_rule_proposal") return unavailable();
        preparedAggregate.assertConsumed();
        const committed = await this.commit(
          context,
          logical,
          requestMac,
          preparation,
          stored,
          command
        );
        if (
          committed.result.currentRevision !== preparation.targetRevision ||
          committed.result.conditionRevision !==
            (expectedRevision === 0
              ? preparation.targetConditionRevision
              : preparation.conditionRevision) ||
          committed.result.proposalState !== proposalState
        ) {
          return unavailable();
        }
        return;
      } catch (error: unknown) {
        if (!observationStale(error) || attempt === 2) throw error;
        if (claimPrepared && requestMac !== null) {
          staleRequestMac = requestMac;
          hasStaleClaim = true;
        }
        claim = Object.freeze({ found: false as const });
      }
    }
  }
}
