import {
  DeleteMutationResultSchema,
  SpaceSchema,
  TagNameSchema,
  TagSchema,
  entityIdSchema,
  type EntityId
} from "@unfiled/contracts";
import {
  encryptedFieldForRpc,
  keyedMacForRpc,
  SpaceDisplayPayloadSchema,
  TagDisplayPayloadSchema,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type EncryptedIdempotencyRecord,
  type KeyedMacRecord,
  type LogicalApiRequest,
  type PayloadCodec,
  type PrivacyTransition,
  type SpaceDisplayPayload,
  type TagDisplayPayload
} from "@unfiled/encrypted-aggregate";
import { z } from "zod";

import type {
  SpaceMutationRecord,
  SpaceRecord,
  TagDeleteMutationRecord,
  TagMutationRecord,
  TagRecord
} from "@/lib/product/types";

import type { EncryptedTaxonomyReadRepository } from "./encrypted-taxonomy-read-repository";
import type {
  EncryptedTaxonomyCommand,
  EncryptedTaxonomyResponseCipher,
  EncryptedTaxonomyRpcAdapter,
  EncryptedTaxonomyWriteClaim,
  EncryptedTaxonomyWriteScope,
  IncompleteEncryptedTaxonomyWriteClaim
} from "./encrypted-taxonomy-rpc-adapter";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const SpaceIntentSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    name: z.string().trim().min(1).max(60),
    parentId: entityIdSchema("spc").nullable(),
    sortKey: z.string().trim().min(1).max(100)
  }),
  z.strictObject({
    action: z.literal("update"),
    patch: z
      .strictObject({
        name: z.string().trim().min(1).max(60).optional(),
        parentId: entityIdSchema("spc").nullable().optional(),
        sortKey: z.string().trim().min(1).max(100).optional()
      })
      .refine(
        ({ name, parentId, sortKey }) =>
          name !== undefined || parentId !== undefined || sortKey !== undefined
      )
  }),
  z.strictObject({ action: z.literal("archive"), archived: z.boolean() })
]);

const TagIntentSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), name: TagNameSchema }),
  z.strictObject({ action: z.literal("update"), name: TagNameSchema }),
  z.strictObject({ action: z.literal("delete") })
]);

const StoredSpaceResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  space: SpaceSchema.extend({ path: z.string().min(1).max(500) })
});
const StoredTagResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tag: TagSchema
});
const StoredTagDeleteResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deletedId: entityIdSchema("tag")
});

type SpaceIntent = z.infer<typeof SpaceIntentSchema>;
type TagIntent = z.infer<typeof TagIntentSchema>;
type Dependencies = Readonly<{
  ownerId: string;
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  adapter: EncryptedTaxonomyRpcAdapter;
  reads: EncryptedTaxonomyReadRepository;
}>;

type Coordinates = Readonly<{
  scope: EncryptedTaxonomyWriteScope;
  idempotencyKey: string;
  resourceId: EntityId<"spc"> | EntityId<"tag"> | null;
  expectedRevision: number;
}>;

type Ready = Readonly<{
  claim: IncompleteEncryptedTaxonomyWriteClaim;
  requestMac: KeyedMacRecord;
  transition: PrivacyTransition;
}>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function invalidIdempotency(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY);
}

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function canonical(value: unknown): string {
  if (value === undefined) return unavailable();
  return JSON.stringify(value);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function transition(scope: EncryptedTaxonomyWriteScope): PrivacyTransition {
  return Object.freeze({
    before: scope === "create_space" || scope === "create_tag" ? null : "private_manual",
    after: "private_manual"
  });
}

function exactRequestMacKey(claim: EncryptedTaxonomyWriteClaim) {
  return Object.freeze({
    ownerId: claim.ownerId,
    keyClass: claim.requestMacKey.keyClass,
    purpose: claim.requestMacKey.keyPurpose,
    keyId: claim.requestMacKey.keyId,
    keyVersion: claim.requestMacKey.keyVersion
  });
}

function assertClaim(
  claim: EncryptedTaxonomyWriteClaim,
  ownerId: string,
  input: Coordinates
): void {
  if (
    claim.ownerId !== ownerId ||
    claim.scope !== input.scope ||
    claim.idempotencyKey !== input.idempotencyKey ||
    claim.expectedRevision !== input.expectedRevision ||
    (input.resourceId !== null && claim.resourceId !== input.resourceId)
  ) {
    invalidIdempotency();
  }
}

function responseAggregateRecord(
  claim: EncryptedTaxonomyWriteClaim,
  response: EncryptedTaxonomyResponseCipher
): EncryptedAggregateRecord<"idempotency_response"> {
  return Object.freeze({
    ownerId: claim.ownerId,
    resourceId: `idempotency:${claim.idempotencyKey}`,
    recordVersion: 1,
    kind: "idempotency_response",
    envelope: response.envelope,
    keyId: response.keyId,
    keyClass: response.keyClass,
    keyPurpose: response.keyPurpose,
    keyVersion: response.keyVersion
  });
}

function idempotencyRecord(
  claim: EncryptedTaxonomyWriteClaim,
  requestMac: KeyedMacRecord,
  response: EncryptedTaxonomyResponseCipher
): EncryptedIdempotencyRecord {
  return Object.freeze({
    ownerId: claim.ownerId,
    idempotencyKey: claim.idempotencyKey,
    keyClass: "private_manual",
    requestMac,
    response: responseAggregateRecord(claim, response)
  });
}

function privateResponseCipher(
  response: Awaited<ReturnType<EncryptedAggregateService["sealIdempotencyResponse"]>>
): EncryptedTaxonomyResponseCipher {
  if (response.keyClass !== "private_manual") return unavailable();
  return Object.freeze({
    envelope: response.envelope,
    keyId: response.keyId,
    keyClass: response.keyClass,
    keyPurpose: response.keyPurpose,
    keyVersion: response.keyVersion
  });
}

function logicalRequest<Payload>(
  coordinates: Coordinates,
  payload: Payload
): LogicalApiRequest<Payload> {
  return Object.freeze({
    schemaVersion: 1,
    scope: coordinates.scope,
    targetResourceId: coordinates.resourceId,
    expectedRevision: coordinates.expectedRevision,
    payload
  });
}

async function requestMac<Payload>(
  dependencies: Dependencies,
  coordinates: Coordinates,
  payload: Payload,
  codec: PayloadCodec<Payload>,
  claim?: EncryptedTaxonomyWriteClaim
): Promise<KeyedMacRecord> {
  return dependencies.aggregate.createIdempotencyRequestMac(dependencies.access, {
    idempotencyKey: coordinates.idempotencyKey,
    transition: transition(coordinates.scope),
    logicalRequest: logicalRequest(coordinates, payload),
    requestCodec: codec,
    ...(claim === undefined ? {} : { keyReference: exactRequestMacKey(claim) })
  });
}

async function openResponse<Payload, Response>(
  dependencies: Dependencies,
  claim: EncryptedTaxonomyWriteClaim,
  request: KeyedMacRecord,
  encryptedResponse: EncryptedTaxonomyResponseCipher,
  coordinates: Coordinates,
  payload: Payload,
  requestCodec: PayloadCodec<Payload>,
  responseCodec: PayloadCodec<Response>
): Promise<Response> {
  return dependencies.aggregate.openIdempotencyResponse(
    dependencies.access,
    idempotencyRecord(claim, request, encryptedResponse),
    {
      idempotencyKey: coordinates.idempotencyKey,
      transition: transition(coordinates.scope),
      logicalRequest: logicalRequest(coordinates, payload),
      requestCodec,
      responseCodec
    }
  );
}

async function prepare<Payload, Response>(
  dependencies: Dependencies,
  coordinates: Coordinates,
  payload: Payload,
  requestCodec: PayloadCodec<Payload>,
  responseCodec: PayloadCodec<Response>
): Promise<Ready | Readonly<{ response: Response }>> {
  const existing = await dependencies.adapter.getWriteClaim({
    ownerId: dependencies.ownerId,
    scope: coordinates.scope,
    idempotencyKey: coordinates.idempotencyKey
  });
  if (existing !== null) assertClaim(existing, dependencies.ownerId, coordinates);
  const request = await requestMac(
    dependencies,
    coordinates,
    payload,
    requestCodec,
    existing ?? undefined
  );
  const prepared = await dependencies.adapter.prepareWrite({
    ownerId: dependencies.ownerId,
    scope: coordinates.scope,
    idempotencyKey: coordinates.idempotencyKey,
    resourceId: coordinates.resourceId,
    expectedRevision: coordinates.expectedRevision,
    requestMac: keyedMacForRpc(request)
  });
  assertClaim(prepared.claim, dependencies.ownerId, coordinates);
  if (
    existing !== null &&
    (!prepared.replayed || prepared.claim.resourceId !== existing.resourceId)
  ) {
    return invalidIdempotency();
  }
  if (prepared.claim.completed) {
    return Object.freeze({
      response: await openResponse(
        dependencies,
        prepared.claim,
        request,
        prepared.claim.encryptedResponse,
        coordinates,
        payload,
        requestCodec,
        responseCodec
      )
    });
  }
  return Object.freeze({
    claim: prepared.claim,
    requestMac: request,
    transition: transition(coordinates.scope)
  });
}

async function verified(valid: Promise<boolean>): Promise<void> {
  if (!(await valid)) unavailable();
}

function slugFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (slug.length < 1 || slug.length > 80) return invalidInput();
  return slug;
}

function ensureCurrent(record: { currentRevision: number }, expectedRevision: number): void {
  if (record.currentRevision !== expectedRevision) {
    throw new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION);
  }
}

async function parentPath(
  dependencies: Dependencies,
  parentId: EntityId<"spc"> | null
): Promise<string | null> {
  if (parentId === null) return null;
  const parent = await dependencies.reads.getSpace(parentId);
  if (parent.parentId !== null || parent.archivedAt !== null) return invalidInput();
  return parent.name;
}

async function execute<Payload, Response>(
  dependencies: Dependencies,
  coordinates: Coordinates,
  payload: Payload,
  requestCodec: PayloadCodec<Payload>,
  responseCodec: PayloadCodec<Response>,
  build: (claim: IncompleteEncryptedTaxonomyWriteClaim) => Promise<{
    response: Response;
    command: Omit<
      EncryptedTaxonomyCommand,
      "requestMac" | "responseCipher" | "responseVerificationMac"
    >;
  }>
): Promise<Readonly<{ response: Response; replayed: boolean }>> {
  const prepared = await prepare(dependencies, coordinates, payload, requestCodec, responseCodec);
  if ("response" in prepared) return Object.freeze({ response: prepared.response, replayed: true });

  const material = await build(prepared.claim);
  let parsedResponse: Response;
  try {
    parsedResponse = responseCodec.parse(material.response);
  } catch {
    return invalidInput();
  }
  const responseCipher = await dependencies.aggregate.sealIdempotencyResponse(dependencies.access, {
    idempotencyKey: coordinates.idempotencyKey,
    transition: prepared.transition,
    response: parsedResponse,
    responseCodec
  });
  const responseVerificationMac = await dependencies.aggregate.createAggregateVerificationMac(
    dependencies.access,
    {
      surface: "idempotency_response",
      idempotencyKey: coordinates.idempotencyKey,
      transition: prepared.transition,
      payload: parsedResponse,
      payloadCodec: responseCodec
    }
  );
  await verified(
    dependencies.aggregate.verifyAggregateVerificationMac(
      dependencies.access,
      responseVerificationMac,
      {
        surface: "idempotency_response",
        idempotencyKey: coordinates.idempotencyKey,
        transition: prepared.transition,
        payload: parsedResponse,
        payloadCodec: responseCodec
      }
    )
  );
  const openedBeforeCommit = await dependencies.aggregate.openIdempotencyResponse(
    dependencies.access,
    idempotencyRecord(prepared.claim, prepared.requestMac, privateResponseCipher(responseCipher)),
    {
      idempotencyKey: coordinates.idempotencyKey,
      transition: prepared.transition,
      logicalRequest: logicalRequest(coordinates, payload),
      requestCodec,
      responseCodec
    }
  );
  if (!sameCanonical(openedBeforeCommit, parsedResponse)) unavailable();

  const command = Object.freeze({
    ...material.command,
    requestMac: keyedMacForRpc(prepared.requestMac),
    responseCipher: encryptedFieldForRpc(responseCipher),
    responseVerificationMac: keyedMacForRpc(responseVerificationMac)
  }) as EncryptedTaxonomyCommand;
  const result = await dependencies.adapter.commitWrite({ claim: prepared.claim, command });
  const committed = await openResponse(
    dependencies,
    prepared.claim,
    prepared.requestMac,
    result.encryptedResponse,
    coordinates,
    payload,
    requestCodec,
    responseCodec
  );
  if (!sameCanonical(committed, parsedResponse)) unavailable();
  return Object.freeze({ response: committed, replayed: result.replayed });
}

async function sealSpaceDisplay(
  dependencies: Dependencies,
  claim: IncompleteEncryptedTaxonomyWriteClaim,
  payload: SpaceDisplayPayload
) {
  const currentRevision = claim.expectedRevision + 1;
  const sealed = await dependencies.aggregate.sealSpaceDisplay(dependencies.access, {
    spaceId: claim.resourceId as EntityId<"spc">,
    currentRevision,
    payload
  });
  const opened = await dependencies.aggregate.openSpaceDisplay(dependencies.access, sealed, {
    spaceId: claim.resourceId as EntityId<"spc">,
    currentRevision
  });
  if (!sameCanonical(opened, payload)) unavailable();
  const verificationMac = await dependencies.aggregate.createAggregateVerificationMac(
    dependencies.access,
    {
      surface: "space_display",
      spaceId: claim.resourceId as EntityId<"spc">,
      currentRevision,
      payload
    }
  );
  await verified(
    dependencies.aggregate.verifyAggregateVerificationMac(dependencies.access, verificationMac, {
      surface: "space_display",
      spaceId: claim.resourceId as EntityId<"spc">,
      currentRevision,
      payload
    })
  );
  return Object.freeze({
    cipher: encryptedFieldForRpc(sealed.encrypted),
    semanticMac: keyedMacForRpc(sealed.contentMac),
    verificationMac: keyedMacForRpc(verificationMac)
  });
}

async function sealTagDisplay(
  dependencies: Dependencies,
  claim: IncompleteEncryptedTaxonomyWriteClaim,
  payload: TagDisplayPayload
) {
  const currentRevision = claim.expectedRevision + 1;
  const sealed = await dependencies.aggregate.sealTagDisplay(dependencies.access, {
    tagId: claim.resourceId as EntityId<"tag">,
    currentRevision,
    payload
  });
  const opened = await dependencies.aggregate.openTagDisplay(dependencies.access, sealed, {
    tagId: claim.resourceId as EntityId<"tag">,
    currentRevision
  });
  if (!sameCanonical(opened, payload)) unavailable();
  const verificationMac = await dependencies.aggregate.createAggregateVerificationMac(
    dependencies.access,
    {
      surface: "tag_display",
      tagId: claim.resourceId as EntityId<"tag">,
      currentRevision,
      payload
    }
  );
  await verified(
    dependencies.aggregate.verifyAggregateVerificationMac(dependencies.access, verificationMac, {
      surface: "tag_display",
      tagId: claim.resourceId as EntityId<"tag">,
      currentRevision,
      payload
    })
  );
  return Object.freeze({
    cipher: encryptedFieldForRpc(sealed.encrypted),
    semanticMac: keyedMacForRpc(sealed.contentMac),
    verificationMac: keyedMacForRpc(verificationMac)
  });
}

/** Ciphertext-only, exact-revision taxonomy command coordinator. */
export class EncryptedTaxonomyWriteCoordinator {
  public constructor(private readonly dependencies: Dependencies) {}

  public async createSpace(
    input: Readonly<{ name: string; parentId: EntityId<"spc"> | null; sortKey?: string }>,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    const parsed = SpaceIntentSchema.safeParse({
      action: "create",
      name: input.name,
      parentId: input.parentId,
      sortKey: input.sortKey ?? "a0"
    });
    if (!parsed.success || parsed.data.action !== "create") return invalidInput();
    const intent = parsed.data;
    const coordinates: Coordinates = {
      scope: "create_space",
      idempotencyKey,
      resourceId: null,
      expectedRevision: 0
    };
    const result = await execute(
      this.dependencies,
      coordinates,
      intent,
      SpaceIntentSchema as PayloadCodec<SpaceIntent>,
      StoredSpaceResponseSchema,
      async (claim) => {
        const name = intent.name;
        const parentName = await parentPath(this.dependencies, intent.parentId);
        const payload = SpaceDisplayPayloadSchema.parse({
          schemaVersion: 1,
          name,
          slug: slugFor(name)
        });
        const space: SpaceRecord = {
          id: claim.resourceId as EntityId<"spc">,
          parentId: intent.parentId,
          name,
          slug: payload.slug,
          path: parentName === null ? name : `${parentName} / ${name}`,
          sortKey: intent.sortKey,
          archivedAt: null,
          currentRevision: 1,
          createdAt: claim.occurredAt,
          updatedAt: claim.occurredAt
        };
        return Object.freeze({
          response: StoredSpaceResponseSchema.parse({ schemaVersion: 1, space }),
          command: Object.freeze({
            scope: claim.scope,
            occurredAt: claim.occurredAt,
            parentId: intent.parentId,
            sortKey: intent.sortKey,
            archivedAt: null,
            display: await sealSpaceDisplay(this.dependencies, claim, payload)
          })
        });
      }
    );
    return Object.freeze({ space: result.response.space, replayed: result.replayed });
  }

  public async updateSpace(
    spaceId: EntityId<"spc">,
    input: Readonly<{ name?: string; parentId?: EntityId<"spc"> | null; sortKey?: string }>,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    const parsed = SpaceIntentSchema.safeParse({ action: "update", patch: input });
    if (!parsed.success || parsed.data.action !== "update") return invalidInput();
    const intent = parsed.data;
    const coordinates: Coordinates = {
      scope: "update_space",
      idempotencyKey,
      resourceId: spaceId,
      expectedRevision
    };
    const result = await execute(
      this.dependencies,
      coordinates,
      intent,
      SpaceIntentSchema as PayloadCodec<SpaceIntent>,
      StoredSpaceResponseSchema,
      async (claim) => {
        const current = await this.dependencies.reads.getSpace(spaceId);
        ensureCurrent(current, expectedRevision);
        const name = intent.patch.name ?? current.name;
        const parentId =
          intent.patch.parentId === undefined ? current.parentId : intent.patch.parentId;
        if (parentId === spaceId) return invalidInput();
        const parentName = await parentPath(this.dependencies, parentId);
        const payload = SpaceDisplayPayloadSchema.parse({
          schemaVersion: 1,
          name,
          slug: current.slug
        });
        const space: SpaceRecord = {
          ...current,
          parentId,
          name,
          path: parentName === null ? name : `${parentName} / ${name}`,
          sortKey: intent.patch.sortKey ?? current.sortKey,
          currentRevision: expectedRevision + 1,
          updatedAt: claim.occurredAt
        };
        return Object.freeze({
          response: StoredSpaceResponseSchema.parse({ schemaVersion: 1, space }),
          command: Object.freeze({
            scope: claim.scope,
            occurredAt: claim.occurredAt,
            parentId,
            sortKey: space.sortKey,
            archivedAt: current.archivedAt,
            display: await sealSpaceDisplay(this.dependencies, claim, payload)
          })
        });
      }
    );
    return Object.freeze({ space: result.response.space, replayed: result.replayed });
  }

  public async archiveSpace(
    spaceId: EntityId<"spc">,
    archived: boolean,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<SpaceMutationRecord> {
    const parsed = SpaceIntentSchema.safeParse({ action: "archive", archived });
    if (!parsed.success || parsed.data.action !== "archive") return invalidInput();
    const intent = parsed.data;
    const coordinates: Coordinates = {
      scope: "archive_space",
      idempotencyKey,
      resourceId: spaceId,
      expectedRevision
    };
    const result = await execute(
      this.dependencies,
      coordinates,
      intent,
      SpaceIntentSchema as PayloadCodec<SpaceIntent>,
      StoredSpaceResponseSchema,
      async (claim) => {
        const current = await this.dependencies.reads.getSpace(spaceId);
        ensureCurrent(current, expectedRevision);
        const archivedAt = intent.archived ? claim.occurredAt : null;
        const space: SpaceRecord = {
          ...current,
          archivedAt,
          currentRevision: expectedRevision + 1,
          updatedAt: claim.occurredAt
        };
        const payload = SpaceDisplayPayloadSchema.parse({
          schemaVersion: 1,
          name: current.name,
          slug: current.slug
        });
        return Object.freeze({
          response: StoredSpaceResponseSchema.parse({ schemaVersion: 1, space }),
          command: Object.freeze({
            scope: claim.scope,
            occurredAt: claim.occurredAt,
            parentId: current.parentId,
            sortKey: current.sortKey,
            archivedAt,
            display: await sealSpaceDisplay(this.dependencies, claim, payload)
          })
        });
      }
    );
    return Object.freeze({ space: result.response.space, replayed: result.replayed });
  }

  public async createTag(name: string, idempotencyKey: string): Promise<TagMutationRecord> {
    const parsed = TagIntentSchema.safeParse({ action: "create", name });
    if (!parsed.success || parsed.data.action !== "create") return invalidInput();
    const intent = parsed.data;
    const coordinates: Coordinates = {
      scope: "create_tag",
      idempotencyKey,
      resourceId: null,
      expectedRevision: 0
    };
    const result = await execute(
      this.dependencies,
      coordinates,
      intent,
      TagIntentSchema as PayloadCodec<TagIntent>,
      StoredTagResponseSchema,
      async (claim) => {
        const payload = TagDisplayPayloadSchema.parse({ schemaVersion: 1, name: intent.name });
        const tag: TagRecord = {
          id: claim.resourceId as EntityId<"tag">,
          name: payload.name,
          currentRevision: 1,
          createdAt: claim.occurredAt
        };
        return Object.freeze({
          response: StoredTagResponseSchema.parse({ schemaVersion: 1, tag }),
          command: Object.freeze({
            scope: claim.scope,
            occurredAt: claim.occurredAt,
            display: await sealTagDisplay(this.dependencies, claim, payload)
          })
        });
      }
    );
    return Object.freeze({ tag: result.response.tag, replayed: result.replayed });
  }

  public async updateTag(
    tagId: EntityId<"tag">,
    name: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagMutationRecord> {
    const parsed = TagIntentSchema.safeParse({ action: "update", name });
    if (!parsed.success || parsed.data.action !== "update") return invalidInput();
    const intent = parsed.data;
    const coordinates: Coordinates = {
      scope: "update_tag",
      idempotencyKey,
      resourceId: tagId,
      expectedRevision
    };
    const result = await execute(
      this.dependencies,
      coordinates,
      intent,
      TagIntentSchema as PayloadCodec<TagIntent>,
      StoredTagResponseSchema,
      async (claim) => {
        const current = await this.dependencies.reads.getTag(tagId);
        ensureCurrent(current, expectedRevision);
        const payload = TagDisplayPayloadSchema.parse({ schemaVersion: 1, name: intent.name });
        const tag: TagRecord = {
          id: tagId,
          name: payload.name,
          currentRevision: expectedRevision + 1,
          createdAt: current.createdAt
        };
        return Object.freeze({
          response: StoredTagResponseSchema.parse({ schemaVersion: 1, tag }),
          command: Object.freeze({
            scope: claim.scope,
            occurredAt: claim.occurredAt,
            display: await sealTagDisplay(this.dependencies, claim, payload)
          })
        });
      }
    );
    return Object.freeze({ tag: result.response.tag, replayed: result.replayed });
  }

  public async deleteTag(
    tagId: EntityId<"tag">,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<TagDeleteMutationRecord> {
    const intent = TagIntentSchema.parse({ action: "delete" });
    const coordinates: Coordinates = {
      scope: "delete_tag",
      idempotencyKey,
      resourceId: tagId,
      expectedRevision
    };
    const result = await execute(
      this.dependencies,
      coordinates,
      intent,
      TagIntentSchema as PayloadCodec<TagIntent>,
      StoredTagDeleteResponseSchema,
      async (claim) => {
        const current = await this.dependencies.reads.getTag(tagId);
        ensureCurrent(current, expectedRevision);
        return Object.freeze({
          response: StoredTagDeleteResponseSchema.parse({ schemaVersion: 1, deletedId: tagId }),
          command: Object.freeze({ scope: claim.scope, occurredAt: claim.occurredAt })
        });
      }
    );
    const parsedResult = DeleteMutationResultSchema.parse({
      deletedId: result.response.deletedId,
      replayed: result.replayed
    });
    return Object.freeze({
      deletedId: parsedResult.deletedId as EntityId<"tag">,
      replayed: parsedResult.replayed
    });
  }
}
