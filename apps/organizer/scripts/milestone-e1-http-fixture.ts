import {
  applyMaterializedOrganizationCommand,
  materializeAuthorizedOrganizationPlan,
  parseAuthorizedOrganizationPlan
} from "@unfiled/ai-routing";
import { entityIdSchema, type EntityId, type EntityKind } from "@unfiled/contracts";
import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import type { EntityIdFactory } from "@unfiled/domain";
import {
  authorizeAggregateOwner,
  CaptureReceiptPayloadSchema,
  createEncryptedAggregateService,
  encryptedFieldForRpc,
  jsonPayloadCodec,
  keyedMacForRpc,
  NoteContentPayloadSchema,
  NoteMutationPayloadSchema,
  NoteRevisionPayloadSchema,
  OrganizationDecisionPayloadSchema,
  type EncryptedAggregateService,
  type JsonValue,
  type LogicalApiRequest,
  type ObjectWrapReservation
} from "@unfiled/encrypted-aggregate";
import {
  createLocalEnvironmentKeyResolver,
  parseManagedKeyRecord,
  type OwnerBoundKeyResolver
} from "@unfiled/key-management";
import { createHash, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";

import { createOrganizerRepository } from "../src/database.js";
import type {
  ClaimedOrganizerJob,
  OrganizerCandidatePage,
  OrganizerPreparation
} from "../src/drain.js";
import { createOrganizerDatabaseExecutor } from "../src/postgres.js";
import { proposedNoteIdForJob } from "../src/planner.js";

const INPUT_VARIABLE = "UNFILED_E1_HTTP_FIXTURE_JSON";
const DATABASE_VARIABLE = "UNFILED_E1_LOCAL_DATABASE_URL";
const WORKER_PASSWORD_VARIABLE = "UNFILED_E1_ORGANIZER_PASSWORD";
const LOCAL_KEY_RING_VARIABLE = "UNFILED_LOCAL_KEY_RING_V1";
const MAX_INPUT_BYTES = 16_384;
const WORKER_ROLE = "unfiled_organizer_worker";
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let diagnosticStage = "input";

type FixtureInput = Readonly<{
  ownerId: string;
  captureId: EntityId<"cap">;
  jobId: EntityId<"job">;
  sourceTitle: string;
  captureText: string;
}>;

type OrganizerWriteRequestPayload = Readonly<{
  captureId: string;
  decisionId: string;
  jobId: string;
}>;

type OrganizerWriteResponsePayload = Readonly<{
  jobId: string;
  mutationId: string;
  noteId: string;
  revision: number;
  schemaVersion: 1;
}>;

function fail(): never {
  throw new Error("The local E1 organizer fixture could not be provisioned");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Readonly<Record<string, unknown>>;
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const parsed = record(value);
  const actual = Object.keys(parsed).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    return fail();
  }
  return parsed;
}

function readInput(): FixtureInput {
  const raw = process.env[INPUT_VARIABLE];
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed !== raw) {
    return fail();
  }
  if (new TextEncoder().encode(trimmed).byteLength > MAX_INPUT_BYTES) {
    return fail();
  }
  try {
    const value = exactRecord(JSON.parse(trimmed), [
      "captureId",
      "captureText",
      "jobId",
      "ownerId",
      "sourceTitle"
    ]);
    const captureId = entityIdSchema("cap").safeParse(value.captureId);
    const jobId = entityIdSchema("job").safeParse(value.jobId);
    if (
      typeof value.ownerId !== "string" ||
      !OWNER_ID_PATTERN.test(value.ownerId) ||
      !captureId.success ||
      !jobId.success ||
      typeof value.sourceTitle !== "string" ||
      value.sourceTitle.length < 1 ||
      value.sourceTitle.length > 60 ||
      typeof value.captureText !== "string" ||
      value.captureText.length < 1 ||
      value.captureText.length > 10_000
    ) {
      return fail();
    }
    return Object.freeze({
      ownerId: value.ownerId,
      captureId: captureId.data,
      jobId: jobId.data,
      sourceTitle: value.sourceTitle,
      captureText: value.captureText
    });
  } catch {
    return fail();
  }
}

function localDatabaseUrl(): URL {
  const raw = process.env[DATABASE_VARIABLE];
  if (raw === undefined) return fail();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "54322" ||
    url.username !== "postgres" ||
    url.password.length === 0 ||
    url.pathname !== "/postgres" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return fail();
  }
  return url;
}

function workerPassword(): string {
  const value = process.env[WORKER_PASSWORD_VARIABLE];
  if (value === undefined || !/^[A-Za-z0-9]{32,120}$/u.test(value)) return fail();
  return value;
}

function aiOnlyLocalEnvironment(): NodeJS.ProcessEnv {
  const serialized = process.env[LOCAL_KEY_RING_VARIABLE];
  if (serialized === undefined) return fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return fail();
  }
  const ring = exactRecord(parsed, ["keys", "version"]);
  if (ring.version !== 1 || !Array.isArray(ring.keys) || ring.keys.length < 1) return fail();
  const keys = ring.keys.filter((entry) => record(entry).keyClass === "ai_assisted");
  if (keys.length !== 2) return fail();
  return {
    ...process.env,
    [LOCAL_KEY_RING_VARIABLE]: JSON.stringify({ version: 1, keys })
  };
}

async function configureWorkerLogin(admin: Client, password: string | null): Promise<void> {
  if (password === null) {
    await admin.query(`alter role ${WORKER_ROLE} nologin password null`);
    const role = await admin.query<{ canLogin: boolean }>(
      'select rolcanlogin as "canLogin" from pg_catalog.pg_roles where rolname = $1',
      [WORKER_ROLE]
    );
    if (role.rows.length !== 1 || role.rows[0]?.canLogin !== false) return fail();
    return;
  }
  const role = await admin.query<{ canLogin: boolean }>(
    'select rolcanlogin as "canLogin" from pg_catalog.pg_roles where rolname = $1',
    [WORKER_ROLE]
  );
  if (role.rows.length !== 1 || role.rows[0]?.canLogin !== false) return fail();
  const quoted = await admin.query<{ value: string }>(
    'select pg_catalog.quote_literal($1::text) as "value"',
    [password]
  );
  const value = quoted.rows[0]?.value;
  if (quoted.rows.length !== 1 || value === undefined) return fail();
  await admin.query(`alter role ${WORKER_ROLE} login password ${value}`);
}

function workerDatabaseUrl(adminUrl: URL, password: string): string {
  const value = new URL(adminUrl);
  value.username = WORKER_ROLE;
  value.password = password;
  return value.toString();
}

function deterministicIdFactory(jobId: string, decisionId: string): EntityIdFactory {
  const offsets = new Map<EntityKind, number>();
  return <Kind extends EntityKind>(kind: Kind): EntityId<Kind> => {
    const offset = offsets.get(kind) ?? 0;
    offsets.set(kind, offset + 1);
    const digest = createHash("sha256")
      .update(`unfiled.organizer.entity.v1:${jobId}:${decisionId}:${kind}:${offset}`, "utf8")
      .digest();
    let value = BigInt(`0x${digest.subarray(0, 16).toString("hex")}`);
    digest.fill(0);
    let suffix = "";
    for (let index = 0; index < 26; index += 1) {
      suffix = `${CROCKFORD_BASE32.charAt(Number(value & 31n))}${suffix}`;
      value >>= 5n;
    }
    return `${kind}_${suffix}`;
  };
}

function exactJob(jobs: readonly ClaimedOrganizerJob[], input: FixtureInput): ClaimedOrganizerJob {
  const job = jobs[0];
  if (
    jobs.length !== 1 ||
    job?.jobId !== input.jobId ||
    job.captureId !== input.captureId ||
    job.ownerId !== input.ownerId ||
    job.commandProjection !== "encrypted_only"
  ) {
    return fail();
  }
  return job;
}

async function assertStoredCapture(
  resolver: OwnerBoundKeyResolver,
  job: ClaimedOrganizerJob,
  expectedText: string
): Promise<void> {
  const cipher = exactRecord(job.source.cipher, [
    "envelope",
    "keyClass",
    "keyId",
    "keyPurpose",
    "keyVersion"
  ]);
  const contentMac = exactRecord(job.source.contentMac, [
    "keyClass",
    "keyId",
    "keyPurpose",
    "keyVersion",
    "value"
  ]);
  const objectKey = parseManagedKeyRecord(job.source.key);
  const contentMacKey = parseManagedKeyRecord(job.source.contentMacKey);
  const envelope = parseContentEnvelope(serializeContentEnvelope(cipher.envelope));
  if (
    cipher.keyClass !== "ai_assisted" ||
    typeof cipher.keyId !== "string" ||
    cipher.keyPurpose !== "object_wrap" ||
    !Number.isSafeInteger(cipher.keyVersion) ||
    Number(cipher.keyVersion) < 1 ||
    contentMac.keyClass !== "ai_assisted" ||
    typeof contentMac.keyId !== "string" ||
    contentMac.keyPurpose !== "content_mac" ||
    !Number.isSafeInteger(contentMac.keyVersion) ||
    Number(contentMac.keyVersion) < 1 ||
    typeof contentMac.value !== "string" ||
    !/^[0-9a-f]{64}$/u.test(contentMac.value) ||
    job.source.resourceId !== job.captureId ||
    job.source.recordVersion !== 1 ||
    objectKey.ownerId !== job.ownerId ||
    objectKey.keyId !== cipher.keyId ||
    objectKey.keyVersion !== cipher.keyVersion ||
    contentMacKey.ownerId !== job.ownerId ||
    contentMacKey.keyId !== contentMac.keyId ||
    contentMacKey.keyVersion !== contentMac.keyVersion
  ) {
    return fail();
  }
  const service = createEncryptedAggregateService({
    keyResolver: resolver,
    objectWrapReservations: {
      reserveObjectWrappingKey(): Promise<never> {
        return Promise.reject(new Error("Read-only aggregate service"));
      }
    }
  });
  const payload = await service.openCapture(
    authorizeAggregateOwner({
      authenticatedOwnerId: job.ownerId,
      resourceOwnerId: job.ownerId
    }),
    Object.freeze({
      encrypted: Object.freeze({
        ownerId: job.ownerId,
        resourceId: job.captureId,
        recordVersion: 1,
        kind: "capture" as const,
        envelope,
        keyId: cipher.keyId,
        keyClass: "ai_assisted" as const,
        keyPurpose: "object_wrap" as const,
        keyVersion: cipher.keyVersion
      }),
      contentMac: Object.freeze({
        value: contentMac.value,
        keyId: contentMac.keyId,
        keyClass: "ai_assisted" as const,
        keyPurpose: "content_mac" as const,
        keyVersion: contentMac.keyVersion
      })
    }),
    { captureId: job.captureId, privacy: "ai_assisted", recordVersion: 1 }
  );
  if (payload.rawContent !== expectedText) return fail();
}

function candidateManifest(page: OrganizerCandidatePage) {
  return Object.freeze({
    schemaVersion: 1 as const,
    candidates: Object.freeze(
      page.candidates.map(({ candidateId, isOpen, noteId, noteType, revision }) =>
        Object.freeze({ candidateId, isOpen, noteId, noteType, revision })
      )
    ),
    controls: page.controls,
    authorizedSpaceIds: Object.freeze([]),
    authorizedTagIds: Object.freeze([])
  });
}

function preparedAggregate(
  resolver: OwnerBoundKeyResolver,
  preparation: OrganizerPreparation
): Readonly<{ assertConsumed(): void; service: EncryptedAggregateService }> {
  const objectKey = parseManagedKeyRecord(preparation.keys.objectWrap);
  const reservation = (reservationId: string, operationIndex?: number): ObjectWrapReservation =>
    Object.freeze({
      reference: Object.freeze({
        ownerId: objectKey.ownerId,
        keyClass: "ai_assisted" as const,
        purpose: "object_wrap" as const,
        keyId: objectKey.keyId,
        keyVersion: objectKey.keyVersion
      }),
      reservationId,
      ...(operationIndex === undefined
        ? {}
        : { groupUse: Object.freeze({ operationCount: 4, operationIndex }) })
    });
  const plan = Object.freeze([
    reservation(preparation.reservations.noteWrite.reservationId, 0),
    reservation(preparation.reservations.noteWrite.reservationId, 1),
    reservation(preparation.reservations.noteWrite.reservationId, 2),
    reservation(preparation.reservations.noteWrite.reservationId, 3),
    reservation(preparation.reservations.decision.reservationId),
    reservation(preparation.reservations.receipt.reservationId)
  ]);
  let index = 0;
  const service = createEncryptedAggregateService({
    keyResolver: resolver,
    objectWrapReservations: {
      reserveObjectWrappingKey(binding): Promise<ObjectWrapReservation> {
        const value = plan[index];
        if (
          value === undefined ||
          binding.ownerId !== objectKey.ownerId ||
          binding.keyClass !== "ai_assisted"
        ) {
          return Promise.reject(new Error("Prepared reservation plan mismatch"));
        }
        index += 1;
        return Promise.resolve(value);
      }
    }
  });
  return Object.freeze({
    service,
    assertConsumed(): void {
      if (index !== plan.length) fail();
    }
  });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function sealCommand(
  resolver: OwnerBoundKeyResolver,
  job: ClaimedOrganizerJob,
  preparation: OrganizerPreparation,
  input: FixtureInput,
  manifest: ReturnType<typeof candidateManifest>
) {
  const planInput = {
    schemaVersion: 1,
    captureKind: "freeform",
    decision: "create_note",
    destination: {
      candidateId: null,
      newNote: { title: input.sourceTitle, noteType: "generic", spaceCandidateId: null }
    },
    operations: [{ type: "append_raw", content: input.captureText }],
    generatedExpansion: null,
    alternatives: [],
    reasonCodes: ["no_candidate_fit"]
  } as const;
  const authorized = parseAuthorizedOrganizationPlan({
    unknownPlan: planInput,
    manifest,
    captureText: input.captureText
  });
  const stableIds = Object.freeze({
    createdNoteId: preparation.noteId,
    decisionId: preparation.ids.decisionId,
    generatedBlockId: null,
    mutationId: preparation.ids.mutationId,
    reviewItemId: null,
    revisionId: preparation.ids.revisionId
  });
  const plan = materializeAuthorizedOrganizationPlan({
    ...authorized,
    stableIds,
    captureText: input.captureText
  });
  if (plan.kind !== "create") return fail();
  const applied = applyMaterializedOrganizationCommand({
    captureText: input.captureText,
    command: plan,
    idFactory: deterministicIdFactory(job.jobId, preparation.ids.decisionId),
    occurredAt: job.occurredAt,
    ownerId: job.ownerId
  });
  if (
    applied.note.id !== preparation.noteId ||
    applied.note.currentRevision !== preparation.targetRevision ||
    applied.revision.id !== preparation.ids.revisionId ||
    applied.mutationId !== preparation.ids.mutationId
  ) {
    return fail();
  }

  const noteContentPayload = NoteContentPayloadSchema.parse(applied.noteContentPayload);
  const noteRevisionPayload = NoteRevisionPayloadSchema.parse(applied.noteRevisionPayload);
  const noteMutationPayload = NoteMutationPayloadSchema.parse(applied.noteMutationPayload);
  const runtime = preparedAggregate(resolver, preparation);
  const aggregate = runtime.service;
  const access = authorizeAggregateOwner({
    authenticatedOwnerId: job.ownerId,
    resourceOwnerId: job.ownerId
  });
  const transition = Object.freeze({ after: "ai_assisted" as const, before: null });
  const requestCodec = jsonPayloadCodec<OrganizerWriteRequestPayload & JsonValue>();
  const responseCodec = jsonPayloadCodec<OrganizerWriteResponsePayload & JsonValue>();
  const idempotencyKey = `organizer:${job.jobId}`;
  const logicalRequest: LogicalApiRequest<OrganizerWriteRequestPayload> = Object.freeze({
    expectedRevision: null,
    payload: Object.freeze({
      captureId: job.captureId,
      decisionId: preparation.ids.decisionId,
      jobId: job.jobId
    }),
    schemaVersion: 1,
    scope: "create_encrypted_note",
    targetResourceId: preparation.noteId
  });
  const contentMacKey = parseManagedKeyRecord(preparation.keys.contentMac);
  const requestMac = await aggregate.createIdempotencyRequestMac(access, {
    idempotencyKey,
    keyReference: Object.freeze({
      ownerId: contentMacKey.ownerId,
      keyClass: contentMacKey.keyClass,
      purpose: "content_mac" as const,
      keyId: contentMacKey.keyId,
      keyVersion: contentMacKey.keyVersion
    }),
    logicalRequest,
    requestCodec,
    transition
  });
  const noteCipher = await aggregate.sealNoteContent(access, {
    currentRevision: applied.note.currentRevision,
    noteId: applied.note.id,
    payload: noteContentPayload,
    privacy: "ai_assisted"
  });
  const revision = await aggregate.sealNoteRevision(access, {
    payload: noteRevisionPayload,
    revision: applied.note.currentRevision,
    revisionId: preparation.ids.revisionId,
    transition
  });
  const mutation = await aggregate.sealNoteMutation(access, {
    afterRevision: applied.note.currentRevision,
    mutationId: preparation.ids.mutationId,
    payload: noteMutationPayload
  });
  const responseValue: OrganizerWriteResponsePayload = Object.freeze({
    jobId: job.jobId,
    mutationId: preparation.ids.mutationId,
    noteId: applied.note.id,
    revision: applied.note.currentRevision,
    schemaVersion: 1
  });
  const responseCipher = await aggregate.sealIdempotencyResponse(access, {
    idempotencyKey,
    response: responseValue,
    responseCodec,
    transition
  });
  const decisionValue = OrganizationDecisionPayloadSchema.parse({
    schemaVersion: 1,
    candidateManifest: { generationId: null, candidates: [] },
    signals: {
      captureOrdinal: job.accountCaptureOrdinal,
      explicitDestination: false,
      policyFailClosed: false,
      policyMargin: null,
      policyReasons: [],
      policyScore: null,
      promptVersion: job.promptVersion,
      routingMode: job.routingMode,
      schemaVersion: job.schemaVersion
    },
    validatedPlan: plan.validatedPlan,
    band: "auto"
  });
  const decision = await aggregate.sealOrganizationDecision(access, {
    decisionId: preparation.ids.decisionId,
    payload: decisionValue
  });
  const receiptValue = CaptureReceiptPayloadSchema.parse({
    schemaVersion: 2,
    captureId: job.captureId,
    jobId: job.jobId,
    decisionId: preparation.ids.decisionId,
    reviewItemId: null,
    mutationId: preparation.ids.mutationId,
    outcome: "created_note",
    headline: "Created a note",
    destination: { noteId: applied.note.id, title: applied.note.title },
    insertedContentReferences: [{ type: "captured", itemId: null }],
    actions: [
      { type: "open", noteId: applied.note.id },
      { type: "move", noteId: applied.note.id, decisionId: preparation.ids.decisionId },
      {
        type: "undo",
        mutationId: preparation.ids.mutationId,
        expectedRevision: applied.note.currentRevision
      }
    ],
    reasonCodes: plan.validatedPlan.reasonCodes,
    createdAt: job.occurredAt,
    undoTargets: [
      {
        noteId: applied.note.id,
        mutationId: preparation.ids.mutationId,
        expectedRevision: applied.note.currentRevision
      }
    ]
  });
  const receipt = await aggregate.sealCaptureReceipt(access, {
    captureId: job.captureId,
    payload: receiptValue,
    recordVersion: 1,
    sourcePrivacy: "ai_assisted"
  });
  runtime.assertConsumed();

  const [noteMac, mutationMac, responseMac, decisionMac, receiptMac] = await Promise.all([
    aggregate.createAggregateVerificationMac(access, {
      noteId: applied.note.id,
      payload: noteContentPayload,
      privacy: "ai_assisted",
      recordVersion: applied.note.currentRevision,
      surface: "note_content"
    }),
    aggregate.createAggregateVerificationMac(access, {
      mutationId: preparation.ids.mutationId,
      payload: noteMutationPayload,
      recordVersion: applied.note.currentRevision,
      surface: "note_mutation"
    }),
    aggregate.createAggregateVerificationMac(access, {
      idempotencyKey,
      payload: responseValue as OrganizerWriteResponsePayload & JsonValue,
      payloadCodec: responseCodec,
      surface: "idempotency_response",
      transition
    }),
    aggregate.createAggregateVerificationMac(access, {
      decisionId: preparation.ids.decisionId,
      payload: decisionValue,
      surface: "organization_decision"
    }),
    aggregate.createAggregateVerificationMac(access, {
      captureId: job.captureId,
      payload: receiptValue,
      recordVersion: 1,
      sourcePrivacy: "ai_assisted",
      surface: "capture_receipt"
    })
  ]);
  const opened = await Promise.all([
    aggregate.openNoteContent(access, noteCipher, {
      currentRevision: applied.note.currentRevision,
      noteId: applied.note.id,
      privacy: "ai_assisted"
    }),
    aggregate.openNoteRevision(access, revision, {
      revision: applied.note.currentRevision,
      revisionId: preparation.ids.revisionId,
      transition
    }),
    aggregate.openNoteMutation(access, mutation, {
      afterRevision: applied.note.currentRevision,
      mutationId: preparation.ids.mutationId,
      transition
    }),
    aggregate.openIdempotencyResponse(
      access,
      Object.freeze({
        idempotencyKey,
        keyClass: "ai_assisted" as const,
        ownerId: job.ownerId,
        requestMac,
        response: responseCipher
      }),
      { idempotencyKey, logicalRequest, requestCodec, responseCodec, transition }
    )
  ]);
  const verified = await Promise.all([
    aggregate.verifyAggregateVerificationMac(access, noteMac, {
      noteId: applied.note.id,
      payload: noteContentPayload,
      privacy: "ai_assisted",
      recordVersion: applied.note.currentRevision,
      surface: "note_content"
    }),
    aggregate.verifyAggregateVerificationMac(access, mutationMac, {
      mutationId: preparation.ids.mutationId,
      payload: noteMutationPayload,
      recordVersion: applied.note.currentRevision,
      surface: "note_mutation"
    }),
    aggregate.verifyAggregateVerificationMac(access, responseMac, {
      idempotencyKey,
      payload: responseValue as OrganizerWriteResponsePayload & JsonValue,
      payloadCodec: responseCodec,
      surface: "idempotency_response",
      transition
    }),
    aggregate.verifyAggregateVerificationMac(access, decisionMac, {
      decisionId: preparation.ids.decisionId,
      payload: decisionValue,
      surface: "organization_decision"
    }),
    aggregate.verifyAggregateVerificationMac(access, receiptMac, {
      captureId: job.captureId,
      payload: receiptValue,
      recordVersion: 1,
      sourcePrivacy: "ai_assisted",
      surface: "capture_receipt"
    })
  ]);
  if (
    !sameCanonical(opened[0], noteContentPayload) ||
    !sameCanonical(opened[1], noteRevisionPayload) ||
    !sameCanonical(opened[2], noteMutationPayload) ||
    !sameCanonical(opened[3], responseValue) ||
    !verified.every(Boolean)
  ) {
    return fail();
  }

  return Object.freeze({
    decision: Object.freeze({
      band: "auto",
      cipher: encryptedFieldForRpc(decision),
      reasonCodes: plan.validatedPlan.reasonCodes,
      verificationMac: keyedMacForRpc(decisionMac)
    }),
    noteWrite: Object.freeze({
      mutation: Object.freeze({
        cipher: encryptedFieldForRpc(mutation),
        decisionId: null,
        id: preparation.ids.mutationId,
        inverse: Object.freeze({ type: "soft_delete_created_note" as const }),
        operations: Object.freeze([Object.freeze({ type: "create_note" as const })]),
        undoTargetMutationId: null
      }),
      noteCipher: encryptedFieldForRpc(noteCipher),
      noteState: Object.freeze({
        archivedAt: applied.note.archivedAt,
        bodyMarkdown: "",
        dailyDate: null,
        deletedAt: applied.note.deletedAt,
        isOpen: applied.note.isOpen,
        links: applied.note.links,
        pinnedAt: applied.note.pinnedAt,
        privacy: "ai_assisted",
        spaceId: applied.note.spaceId,
        structuredData: { schemaVersion: 1 },
        tagIds: applied.note.tagIds,
        title: `e-${applied.note.id.toLowerCase()}`,
        type: applied.note.type
      }),
      occurredAt: job.occurredAt,
      requestMac: keyedMacForRpc(requestMac),
      responseCipher: encryptedFieldForRpc(responseCipher),
      revision: Object.freeze({
        actor: "organization:organizer",
        cipher: encryptedFieldForRpc(revision.encrypted),
        id: preparation.ids.revisionId,
        mac: keyedMacForRpc(revision.contentMac),
        source: "organization"
      }),
      verification: Object.freeze({
        idempotencyResponse: keyedMacForRpc(responseMac),
        noteContent: keyedMacForRpc(noteMac),
        noteMutation: keyedMacForRpc(mutationMac)
      })
    }),
    outcome: "created" as const,
    receipt: Object.freeze({
      cipher: encryptedFieldForRpc(receipt),
      verificationMac: keyedMacForRpc(receiptMac)
    }),
    review: null,
    reviewReason: null
  });
}

async function assertPersistedParity(
  admin: Client,
  input: FixtureInput,
  decisionId: string
): Promise<void> {
  const verification = await admin.query<{ count: string }>(
    `select count(*)::text as count
       from public.content_encryption_verifications
      where user_id = $1
        and ((surface = 'organization_decision' and resource_id = $2)
          or (surface = 'capture_receipt' and resource_id = $3))`,
    [input.ownerId, decisionId, input.captureId]
  );
  const rollout = await admin.query<{ encryptedCount: string; verifiedCount: string }>(
    `select encrypted_object_count::text as "encryptedCount",
            verified_object_count::text as "verifiedCount"
       from public.content_encryption_rollouts where user_id = $1`,
    [input.ownerId]
  );
  const counts = rollout.rows[0];
  if (
    verification.rows.length !== 1 ||
    verification.rows[0]?.count !== "2" ||
    rollout.rows.length !== 1 ||
    counts === undefined ||
    BigInt(counts.encryptedCount) !== BigInt(counts.verifiedCount)
  ) {
    return fail();
  }
}

async function main(): Promise<void> {
  const input = readInput();
  const adminUrl = localDatabaseUrl();
  const password = workerPassword();
  const admin = new Client({ connectionString: adminUrl.toString(), ssl: false });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let workerLoginConfigured = false;
  let worker: ReturnType<typeof createOrganizerDatabaseExecutor> | undefined;
  try {
    diagnosticStage = "admin-connect";
    await admin.connect();
    diagnosticStage = "worker-login";
    await configureWorkerLogin(admin, password);
    workerLoginConfigured = true;
    const pool = new Pool({
      allowExitOnIdle: true,
      application_name: "unfiled-e1-local-organizer-fixture",
      connectionString: workerDatabaseUrl(adminUrl, password),
      max: 1,
      ssl: false
    });
    worker = createOrganizerDatabaseExecutor(pool);
    const repository = createOrganizerRepository(worker.executor);
    diagnosticStage = "preflight";
    await repository.preflight(controller.signal);
    diagnosticStage = "claim";
    const job = exactJob(
      await repository.claim({
        leaseSeconds: 300,
        limit: 1,
        signal: controller.signal,
        workerId: `milestone-e1-${randomUUID()}`
      }),
      input
    );
    diagnosticStage = "key-resolver";
    const resolver = await createLocalEnvironmentKeyResolver({
      environment: aiOnlyLocalEnvironment(),
      workload: "organization_worker"
    });
    diagnosticStage = "capture-open";
    await assertStoredCapture(resolver, job, input.captureText);
    diagnosticStage = "candidates";
    const page = await repository.candidates({
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      limit: 8,
      signal: controller.signal
    });
    const manifest = candidateManifest(page);
    diagnosticStage = "authorize-candidates";
    const heartbeat = await repository.heartbeat({
      candidateManifest: Object.freeze({
        candidates: manifest.candidates.map(({ candidateId, isOpen, noteId, revision }) =>
          Object.freeze({ candidateId, isOpen, noteId, revision })
        ),
        controls: manifest.controls
      }),
      jobId: job.jobId,
      leaseSeconds: 300,
      leaseToken: job.leaseToken,
      signal: controller.signal
    });
    if (heartbeat.outcome !== "authorized") return fail();
    diagnosticStage = "prepare-create";
    const preparation = await repository.prepareCreate({
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      reservationId: randomUUID(),
      signal: controller.signal,
      stableNoteId: proposedNoteIdForJob(job.jobId)
    });
    diagnosticStage = "seal-command";
    const command = await sealCommand(resolver, job, preparation, input, manifest);
    diagnosticStage = "commit";
    const committed = await repository.commit({
      command,
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      signal: controller.signal
    });
    if (
      committed.outcome !== "created" ||
      committed.jobId !== job.jobId ||
      committed.noteId !== preparation.noteId ||
      committed.revision !== 1 ||
      committed.replayed
    ) {
      return fail();
    }
    diagnosticStage = "persisted-parity";
    await assertPersistedParity(admin, input, preparation.ids.decisionId);
    diagnosticStage = "complete";
    process.stdout.write(
      JSON.stringify({
        decisionId: preparation.ids.decisionId,
        sourceMutationId: preparation.ids.mutationId,
        sourceNoteId: preparation.noteId
      })
    );
  } finally {
    controller.abort();
    clearTimeout(timeout);
    let cleanupFailed = false;
    try {
      await worker?.close();
    } catch {
      cleanupFailed = true;
    }
    if (workerLoginConfigured) {
      try {
        await configureWorkerLogin(admin, null);
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await admin.end();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) fail();
  }
}

await main().catch(() => {
  process.stderr.write(`The local E1 organizer fixture failed at ${diagnosticStage}.\n`);
  process.exitCode = 1;
});
