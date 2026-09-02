import { entityIdSchema, type EntityId } from "@unfiled/contracts";
import { parseContentEnvelope } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  CaptureReceiptPayloadSchema,
  createEncryptedAggregateService,
  encryptedFieldForRpc,
  GeneratedBlockPayloadSchema,
  keyedMacForRpc,
  ReviewPayloadSchema,
  type CaptureReceiptPayload,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type ObjectWrapReservation
} from "@unfiled/encrypted-aggregate";
import { createLocalEnvironmentKeyResolver } from "@unfiled/key-management";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const INPUT_VARIABLE = "UNFILED_E3_HTTP_FIXTURE_JSON";
const DATABASE_VARIABLE = "UNFILED_E3_LOCAL_DATABASE_URL";
const LOCAL_KEY_RING_VARIABLE = "UNFILED_LOCAL_KEY_RING_V1";
const MAX_INPUT_BYTES = 32_768;
const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let diagnosticStage = "input";

type GeneratedFixture = Readonly<{
  blockId: EntityId<"blk">;
  captureId: EntityId<"cap">;
  content: string;
  decisionId: EntityId<"dec">;
  noteId: EntityId<"note">;
  reviewId: EntityId<"rvw">;
}>;

type DuplicateFixture = Readonly<{
  captureId: EntityId<"cap">;
  decisionId: EntityId<"dec">;
  explanation: string;
  noteIds: readonly [EntityId<"note">, EntityId<"note">];
  reviewId: EntityId<"rvw">;
}>;

type FixtureInput = Readonly<{
  duplicateDismiss: DuplicateFixture;
  duplicateKeep: DuplicateFixture;
  generatedAccept: GeneratedFixture;
  generatedReject: GeneratedFixture;
  ownerId: string;
}>;

type ReceiptRow = Readonly<{
  captureId: string;
  createdAt: Date;
  decisionId: string | null;
  destinationNoteId: string | null;
  jobId: string;
  mutationId: string | null;
  outcome: string;
  reasonCodes: string[];
  receiptEnvelope: unknown;
  receiptKeyClass: string;
  receiptKeyId: string;
  receiptKeyPurpose: string;
  receiptKeyVersion: number;
  receiptRevision: number;
}>;

type JobRow = Readonly<{ modelId: string; promptVersion: string }>;

function fail(): never {
  throw new Error("The local E3 HTTP fixture could not be provisioned");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const parsed = record(value);
  const actual = Object.keys(parsed).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    return fail();
  }
  return parsed;
}

function entity<Kind extends "blk" | "cap" | "dec" | "note" | "rvw">(
  kind: Kind,
  value: unknown
): EntityId<Kind> {
  const parsed = entityIdSchema(kind).safeParse(value);
  return parsed.success ? parsed.data : fail();
}

function bounded(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) return fail();
  return value;
}

function generated(value: unknown): GeneratedFixture {
  const parsed = exact(value, [
    "blockId",
    "captureId",
    "content",
    "decisionId",
    "noteId",
    "reviewId"
  ]);
  return Object.freeze({
    blockId: entity("blk", parsed.blockId),
    captureId: entity("cap", parsed.captureId),
    content: bounded(parsed.content, 600),
    decisionId: entity("dec", parsed.decisionId),
    noteId: entity("note", parsed.noteId),
    reviewId: entity("rvw", parsed.reviewId)
  });
}

function duplicate(value: unknown): DuplicateFixture {
  const parsed = exact(value, ["captureId", "decisionId", "explanation", "noteIds", "reviewId"]);
  if (!Array.isArray(parsed.noteIds) || parsed.noteIds.length !== 2) return fail();
  const first = entity("note", parsed.noteIds[0]);
  const second = entity("note", parsed.noteIds[1]);
  if (first === second) return fail();
  const explanation = bounded(parsed.explanation, 600);
  if (explanation.trim() !== explanation) return fail();
  const noteIds: DuplicateFixture["noteIds"] = [first, second];
  return Object.freeze({
    captureId: entity("cap", parsed.captureId),
    decisionId: entity("dec", parsed.decisionId),
    explanation,
    noteIds,
    reviewId: entity("rvw", parsed.reviewId)
  });
}

function readInput(): FixtureInput {
  const raw = process.env[INPUT_VARIABLE];
  const trimmed = raw?.trim();
  if (
    trimmed === undefined ||
    trimmed !== raw ||
    new TextEncoder().encode(trimmed).byteLength > MAX_INPUT_BYTES
  ) {
    return fail();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail();
  }
  const value = exact(parsed, [
    "duplicateDismiss",
    "duplicateKeep",
    "generatedAccept",
    "generatedReject",
    "ownerId"
  ]);
  if (typeof value.ownerId !== "string" || !OWNER_ID_PATTERN.test(value.ownerId)) return fail();
  const input = Object.freeze({
    duplicateDismiss: duplicate(value.duplicateDismiss),
    duplicateKeep: duplicate(value.duplicateKeep),
    generatedAccept: generated(value.generatedAccept),
    generatedReject: generated(value.generatedReject),
    ownerId: value.ownerId
  });
  const identities = [
    input.duplicateDismiss.reviewId,
    input.duplicateKeep.reviewId,
    input.generatedAccept.reviewId,
    input.generatedReject.reviewId,
    input.generatedAccept.blockId,
    input.generatedReject.blockId
  ];
  if (new Set(identities).size !== identities.length) return fail();
  return input;
}

function localDatabaseUrl(): string {
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
  return url.toString();
}

function aiOnlyEnvironment(): NodeJS.ProcessEnv {
  const raw = process.env[LOCAL_KEY_RING_VARIABLE];
  if (raw === undefined) return fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail();
  }
  const ring = exact(parsed, ["keys", "version"]);
  if (ring.version !== 1 || !Array.isArray(ring.keys)) return fail();
  const keys = ring.keys.filter((entry) => record(entry).keyClass === "ai_assisted");
  if (keys.length !== 2) return fail();
  return { ...process.env, [LOCAL_KEY_RING_VARIABLE]: JSON.stringify({ version: 1, keys }) };
}

function aggregateForOwner(ownerId: string): Promise<EncryptedAggregateService> {
  return createLocalEnvironmentKeyResolver({
    environment: aiOnlyEnvironment(),
    workload: "organization_worker"
  }).then((keyResolver) =>
    createEncryptedAggregateService({
      keyResolver,
      objectWrapReservations: {
        reserveObjectWrappingKey(): Promise<ObjectWrapReservation> {
          return Promise.resolve(
            Object.freeze({
              reference: Object.freeze({
                ownerId,
                keyClass: "ai_assisted" as const,
                purpose: "object_wrap" as const,
                keyId: "milestone-e1.ai.object.v1",
                keyVersion: 1
              }),
              reservationId: randomUUID()
            })
          );
        }
      }
    })
  );
}

async function receiptRow(client: Client, ownerId: string, captureId: string): Promise<ReceiptRow> {
  const result = await client.query<ReceiptRow>(
    `select receipt.capture_id as "captureId", receipt.job_id as "jobId",
            receipt.created_at as "createdAt",
            receipt.decision_id as "decisionId", receipt.mutation_id as "mutationId",
            receipt.outcome::text as "outcome",
            receipt.destination_note_id as "destinationNoteId",
            receipt.reason_codes as "reasonCodes",
            receipt.receipt_revision as "receiptRevision",
            receipt.receipt_envelope as "receiptEnvelope",
            receipt.receipt_key_id as "receiptKeyId",
            receipt.receipt_key_class::text as "receiptKeyClass",
            receipt.receipt_key_purpose::text as "receiptKeyPurpose",
            receipt.receipt_key_version as "receiptKeyVersion"
       from public.capture_receipts as receipt
      where receipt.user_id = $1 and receipt.capture_id = $2`,
    [ownerId, captureId]
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.receiptRevision !== 1 ||
    !(row.createdAt instanceof Date) ||
    Number.isNaN(row.createdAt.getTime()) ||
    row.receiptKeyClass !== "ai_assisted" ||
    row.receiptKeyPurpose !== "object_wrap"
  ) {
    return fail();
  }
  return row;
}

function receiptRecord(
  ownerId: string,
  row: ReceiptRow
): EncryptedAggregateRecord<"capture_receipt"> {
  return Object.freeze({
    envelope: parseContentEnvelope(JSON.stringify(row.receiptEnvelope)),
    keyClass: "ai_assisted",
    keyId: row.receiptKeyId,
    keyPurpose: "object_wrap",
    keyVersion: row.receiptKeyVersion,
    kind: "capture_receipt" as const,
    ownerId,
    recordVersion: row.receiptRevision,
    resourceId: row.captureId
  });
}

async function storeVerification(
  client: Client,
  ownerId: string,
  surface: "capture_receipt" | "generated_block" | "review_item",
  resourceId: string,
  recordVersion: number,
  cipher: ReturnType<typeof encryptedFieldForRpc>,
  mac: ReturnType<typeof keyedMacForRpc>
): Promise<void> {
  await client.query(
    `select private.record_content_encryption_verification(
       $1::uuid,$2::text,$3::text,$4::integer,$5::jsonb,$6::jsonb
     )`,
    [
      ownerId,
      surface,
      resourceId,
      recordVersion,
      JSON.stringify(cipher.envelope),
      JSON.stringify(mac)
    ]
  );
}

async function jobProvenance(client: Client, ownerId: string, captureId: string): Promise<JobRow> {
  const result = await client.query<JobRow>(
    `select job.model_id as "modelId", job.prompt_version as "promptVersion"
       from public.organization_jobs as job
      where job.user_id = $1 and job.capture_id = $2`,
    [ownerId, captureId]
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) return fail();
  return row;
}

async function seedGenerated(
  client: Client,
  aggregate: EncryptedAggregateService,
  ownerId: string,
  fixture: GeneratedFixture
): Promise<JobRow> {
  const prefix = diagnosticStage;
  diagnosticStage = `${prefix}-read`;
  const access = authorizeAggregateOwner({
    authenticatedOwnerId: ownerId,
    resourceOwnerId: ownerId
  });
  const row = await receiptRow(client, ownerId, fixture.captureId);
  const provenance = await jobProvenance(client, ownerId, fixture.captureId);
  if (row.decisionId !== fixture.decisionId || row.destinationNoteId !== fixture.noteId)
    return fail();
  if (
    row.mutationId === null ||
    (row.outcome !== "created_note" && row.outcome !== "added_to_note")
  ) {
    return fail();
  }
  const sourceReceipt = CaptureReceiptPayloadSchema.parse(
    await aggregate.openCaptureReceipt(access, receiptRecord(ownerId, row), {
      captureId: fixture.captureId,
      recordVersion: row.receiptRevision,
      sourcePrivacy: "ai_assisted"
    })
  );
  if (sourceReceipt.reviewItemId !== null || sourceReceipt.mutationId === null) return fail();
  const blockPayload = GeneratedBlockPayloadSchema.parse({
    schemaVersion: 1,
    content: fixture.content
  });
  const reviewPayload = ReviewPayloadSchema.parse({
    schemaVersion: 2,
    proposal: { type: "generated_block", blockId: fixture.blockId },
    state: "open",
    resolution: null
  });
  const receiptPayload = CaptureReceiptPayloadSchema.parse({
    ...sourceReceipt,
    reviewItemId: fixture.reviewId,
    insertedContentReferences: [
      ...sourceReceipt.insertedContentReferences,
      { type: "ai_generated", blockId: fixture.blockId }
    ]
  });
  diagnosticStage = `${prefix}-seal`;
  const [block, review, receipt] = await Promise.all([
    aggregate.sealGeneratedBlock(access, { blockId: fixture.blockId, payload: blockPayload }),
    aggregate.sealReview(access, {
      reviewId: fixture.reviewId,
      recordVersion: 1,
      sourcePrivacy: "ai_assisted",
      payload: reviewPayload
    }),
    aggregate.sealCaptureReceipt(access, {
      captureId: fixture.captureId,
      recordVersion: row.receiptRevision,
      sourcePrivacy: "ai_assisted",
      payload: receiptPayload
    })
  ]);
  const [blockMac, reviewMac, receiptMac] = await Promise.all([
    aggregate.createAggregateVerificationMac(access, {
      surface: "generated_block",
      blockId: fixture.blockId,
      payload: blockPayload
    }),
    aggregate.createAggregateVerificationMac(access, {
      surface: "review_item",
      reviewId: fixture.reviewId,
      recordVersion: 1,
      sourcePrivacy: "ai_assisted",
      payload: reviewPayload
    }),
    aggregate.createAggregateVerificationMac(access, {
      surface: "capture_receipt",
      captureId: fixture.captureId,
      recordVersion: row.receiptRevision,
      sourcePrivacy: "ai_assisted",
      payload: receiptPayload
    })
  ]);
  const blockField = encryptedFieldForRpc(block);
  const reviewField = encryptedFieldForRpc(review);
  const receiptField = encryptedFieldForRpc(receipt);
  diagnosticStage = `${prefix}-insert-review`;
  await client.query(
    `insert into public.review_items (
       id,user_id,capture_id,note_id,type,state,review_content_revision,
       review_envelope,review_key_id,review_key_class,review_key_purpose,review_key_version
     ) values ($1,$2,$3,$4,'pending_expansion','open',1,$5::jsonb,$6,'ai_assisted','object_wrap',$7)`,
    [
      fixture.reviewId,
      ownerId,
      fixture.captureId,
      fixture.noteId,
      JSON.stringify(reviewField.envelope),
      reviewField.keyId,
      reviewField.keyVersion
    ]
  );
  diagnosticStage = `${prefix}-insert-block`;
  await client.query(
    `insert into public.generated_blocks (
       id,user_id,note_id,decision_id,kind,state,model_id,prompt_version,
       review_item_id,state_revision,resolved_at,content_envelope,content_key_id,
       content_key_class,content_key_purpose,content_key_version
     ) values ($1,$2,$3,$4,'suggestion','proposed',$5,$6,$7,1,null,$8::jsonb,$9,
       'ai_assisted','object_wrap',$10)`,
    [
      fixture.blockId,
      ownerId,
      fixture.noteId,
      fixture.decisionId,
      provenance.modelId,
      provenance.promptVersion,
      fixture.reviewId,
      JSON.stringify(blockField.envelope),
      blockField.keyId,
      blockField.keyVersion
    ]
  );
  // Production publishes this E3 projection on the receipt's initial INSERT.
  // The synthetic base fixture already has a routed receipt, so replace that
  // row inside this transaction instead of weakening the revision guard.
  diagnosticStage = `${prefix}-replace-receipt-delete`;
  const receiptDelete = await client.query(
    `delete from public.capture_receipts
      where user_id = $1 and capture_id = $2 and receipt_revision = $3`,
    [ownerId, fixture.captureId, row.receiptRevision]
  );
  if (receiptDelete.rowCount !== 1) return fail();
  diagnosticStage = `${prefix}-replace-receipt-insert`;
  const receiptInsert = await client.query(
    `insert into public.capture_receipts (
       capture_id,job_id,user_id,decision_id,review_item_id,mutation_id,outcome,
       destination_note_id,reason_codes,created_at,receipt_envelope,receipt_key_id,
       receipt_key_class,receipt_key_purpose,receipt_key_version,receipt_revision
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,array['expansion_pending']::text[],$9,$10::jsonb,$11,
       'ai_assisted','object_wrap',$12,$13
     )`,
    [
      fixture.captureId,
      row.jobId,
      ownerId,
      fixture.decisionId,
      fixture.reviewId,
      row.mutationId,
      row.outcome,
      row.destinationNoteId,
      row.createdAt,
      JSON.stringify(receiptField.envelope),
      receiptField.keyId,
      receiptField.keyVersion,
      row.receiptRevision
    ]
  );
  if (receiptInsert.rowCount !== 1) return fail();
  diagnosticStage = `${prefix}-update-capture`;
  await client.query(
    `update public.captures set status = 'needs_review', last_error_code = null
      where user_id = $1 and id = $2`,
    [ownerId, fixture.captureId]
  );
  diagnosticStage = `${prefix}-verification`;
  await storeVerification(
    client,
    ownerId,
    "generated_block",
    fixture.blockId,
    1,
    blockField,
    keyedMacForRpc(blockMac)
  );
  await storeVerification(
    client,
    ownerId,
    "review_item",
    fixture.reviewId,
    1,
    reviewField,
    keyedMacForRpc(reviewMac)
  );
  await storeVerification(
    client,
    ownerId,
    "capture_receipt",
    fixture.captureId,
    row.receiptRevision,
    receiptField,
    keyedMacForRpc(receiptMac)
  );
  return provenance;
}

async function seedDuplicate(
  client: Client,
  aggregate: EncryptedAggregateService,
  ownerId: string,
  fixture: DuplicateFixture
): Promise<void> {
  const prefix = diagnosticStage;
  diagnosticStage = `${prefix}-read`;
  const access = authorizeAggregateOwner({
    authenticatedOwnerId: ownerId,
    resourceOwnerId: ownerId
  });
  const row = await receiptRow(client, ownerId, fixture.captureId);
  if (row.decisionId !== fixture.decisionId) return fail();
  const nextReceiptRevision = row.receiptRevision + 1;
  const sourceReceipt = CaptureReceiptPayloadSchema.parse(
    await aggregate.openCaptureReceipt(access, receiptRecord(ownerId, row), {
      captureId: fixture.captureId,
      recordVersion: row.receiptRevision,
      sourcePrivacy: "ai_assisted"
    })
  );
  const revisions = await client.query<{ currentRevision: number; id: string }>(
    `select id,current_revision as "currentRevision" from public.notes
      where user_id = $1 and id = any($2::text[]) order by array_position($2::text[],id)`,
    [ownerId, fixture.noteIds]
  );
  if (revisions.rows.length !== 2 || revisions.rows.some((note) => note.currentRevision < 1))
    return fail();
  const reviewPayload = ReviewPayloadSchema.parse({
    schemaVersion: 2,
    proposal: {
      type: "duplicate_notes",
      explanation: fixture.explanation,
      notes: revisions.rows.map((note) => ({ noteId: note.id, revision: note.currentRevision }))
    },
    state: "open",
    resolution: null
  });
  const reasonCodes = ["ambiguous_intent", "duplicate_suspected"] as const;
  const receiptPayload: CaptureReceiptPayload = CaptureReceiptPayloadSchema.parse({
    schemaVersion: 2,
    captureId: fixture.captureId,
    jobId: sourceReceipt.jobId,
    decisionId: fixture.decisionId,
    reviewItemId: fixture.reviewId,
    mutationId: null,
    outcome: "needs_review",
    headline: "Needs your review",
    destination: null,
    insertedContentReferences: [],
    actions: [],
    reasonCodes,
    createdAt: sourceReceipt.createdAt,
    undoTargets: []
  });
  diagnosticStage = `${prefix}-seal`;
  const [review, receipt] = await Promise.all([
    aggregate.sealReview(access, {
      reviewId: fixture.reviewId,
      recordVersion: 1,
      sourcePrivacy: "ai_assisted",
      payload: reviewPayload
    }),
    aggregate.sealCaptureReceipt(access, {
      captureId: fixture.captureId,
      recordVersion: nextReceiptRevision,
      sourcePrivacy: "ai_assisted",
      payload: receiptPayload
    })
  ]);
  const [reviewMac, receiptMac] = await Promise.all([
    aggregate.createAggregateVerificationMac(access, {
      surface: "review_item",
      reviewId: fixture.reviewId,
      recordVersion: 1,
      sourcePrivacy: "ai_assisted",
      payload: reviewPayload
    }),
    aggregate.createAggregateVerificationMac(access, {
      surface: "capture_receipt",
      captureId: fixture.captureId,
      recordVersion: nextReceiptRevision,
      sourcePrivacy: "ai_assisted",
      payload: receiptPayload
    })
  ]);
  const reviewField = encryptedFieldForRpc(review);
  const receiptField = encryptedFieldForRpc(receipt);
  diagnosticStage = `${prefix}-insert-review`;
  await client.query(
    `insert into public.review_items (
       id,user_id,capture_id,note_id,type,state,review_content_revision,
       review_envelope,review_key_id,review_key_class,review_key_purpose,review_key_version
     ) values ($1,$2,$3,null,'duplicate_suggestion','open',1,$4::jsonb,$5,
       'ai_assisted','object_wrap',$6)`,
    [
      fixture.reviewId,
      ownerId,
      fixture.captureId,
      JSON.stringify(reviewField.envelope),
      reviewField.keyId,
      reviewField.keyVersion
    ]
  );
  diagnosticStage = `${prefix}-update-receipt`;
  const receiptUpdate = await client.query(
    `update public.capture_receipts
        set review_item_id = $3, mutation_id = null, outcome = 'needs_review',
            destination_note_id = null, reason_codes = $4::text[],
            receipt_envelope = $5::jsonb, receipt_key_id = $6,
            receipt_key_class = 'ai_assisted', receipt_key_purpose = 'object_wrap',
            receipt_key_version = $7, receipt_revision = $8
      where user_id = $1 and capture_id = $2 and receipt_revision = $9`,
    [
      ownerId,
      fixture.captureId,
      fixture.reviewId,
      reasonCodes,
      JSON.stringify(receiptField.envelope),
      receiptField.keyId,
      receiptField.keyVersion,
      nextReceiptRevision,
      row.receiptRevision
    ]
  );
  if (receiptUpdate.rowCount !== 1) return fail();
  diagnosticStage = `${prefix}-update-capture`;
  await client.query(
    `update public.captures set status = 'needs_review', last_error_code = null
      where user_id = $1 and id = $2`,
    [ownerId, fixture.captureId]
  );
  diagnosticStage = `${prefix}-verification`;
  await storeVerification(
    client,
    ownerId,
    "review_item",
    fixture.reviewId,
    1,
    reviewField,
    keyedMacForRpc(reviewMac)
  );
  await storeVerification(
    client,
    ownerId,
    "capture_receipt",
    fixture.captureId,
    nextReceiptRevision,
    receiptField,
    keyedMacForRpc(receiptMac)
  );
}

async function main(): Promise<void> {
  const input = readInput();
  const aggregate = await aggregateForOwner(input.ownerId);
  const client = new Client({ connectionString: localDatabaseUrl(), ssl: false });
  await client.connect();
  try {
    diagnosticStage = "transaction";
    await client.query("begin");
    diagnosticStage = "generated-accept";
    await seedGenerated(client, aggregate, input.ownerId, input.generatedAccept);
    diagnosticStage = "generated-reject";
    const generatedRejectProvenance = await seedGenerated(
      client,
      aggregate,
      input.ownerId,
      input.generatedReject
    );
    diagnosticStage = "duplicate-keep";
    await seedDuplicate(client, aggregate, input.ownerId, input.duplicateKeep);
    diagnosticStage = "duplicate-dismiss";
    await seedDuplicate(client, aggregate, input.ownerId, input.duplicateDismiss);
    diagnosticStage = "rollout-counts";
    await client.query(
      `update public.content_encryption_rollouts
          set encrypted_object_count = encrypted_object_count + 6,
              verified_object_count = verified_object_count + 6
        where user_id = $1`,
      [input.ownerId]
    );
    diagnosticStage = "commit";
    await client.query("commit");
    process.stdout.write(
      JSON.stringify({ generated: 2, duplicateReviews: 2, generatedRejectProvenance })
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

await main().catch(() => {
  process.stderr.write(`The local E3 HTTP fixture failed at ${diagnosticStage}.\n`);
  process.exitCode = 1;
});
