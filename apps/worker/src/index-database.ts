import {
  parseManagedKeyRecordV1,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser
} from "@unfiled/key-management";

const EXPECTED_DATABASE_ROLE = "unfiled_index_worker";
const SOURCE_ENVELOPE_BYTE_BUDGET = 8_388_608;
const MIN_INDEX_CIPHERTEXT_BYTES = 16;
const MAX_INDEX_CIPHERTEXT_BYTES = 262_160;
const MAX_SOURCE_CIPHERTEXT_BYTES = 1_048_592;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ENTITY_SUFFIX_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
const JOB_ID_PATTERN = new RegExp(`^ijob_${ENTITY_SUFFIX_PATTERN}$`, "u");
const NOTE_ID_PATTERN = new RegExp(`^note_${ENTITY_SUFFIX_PATTERN}$`, "u");
const GENERATION_ID_PATTERN = new RegExp(`^igen_${ENTITY_SUFFIX_PATTERN}$`, "u");
const INDEX_ID_PATTERN = new RegExp(`^irw_${ENTITY_SUFFIX_PATTERN}$`, "u");
const SPACE_ID_PATTERN = new RegExp(`^spc_${ENTITY_SUFFIX_PATTERN}$`, "u");
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const MODEL_ID_PATTERN = /^[\x21-\x7e]{1,200}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;

export const NOTE_INDEX_RPC_NAMES = Object.freeze([
  "claim_note_index_jobs",
  "heartbeat_note_index_job",
  "commit_note_rag_index",
  "fail_note_index_job",
  "recover_stale_note_index_jobs",
  "list_active_note_rag_index"
] as const);

export const SAFE_ERROR_CODES = Object.freeze([
  "account_deletion_failed",
  "budget_exhausted",
  "capture_too_long",
  "conflict_requires_review",
  "forbidden",
  "invalid_capture",
  "invalid_idempotency_key",
  "invalid_plan",
  "not_found",
  "offline",
  "provider_key_invalid",
  "provider_unavailable",
  "rate_limited",
  "stale_revision",
  "structure_conflict",
  "unauthorized",
  "validation_failed"
] as const);

export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];
export type NoteType = "generic" | "list" | "log" | "principle" | "project";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

export type ContentEnvelopeV1 = Readonly<{
  version: 1;
  suite: "A256GCM";
  keyId: string;
  context: Readonly<{
    tenantId: string;
    resourceId: string;
    recordVersion: number;
    kind: "note_content" | "note_rag_index";
  }>;
  wrappedDataKey: Readonly<{ nonce: string; ciphertext: string }>;
  payload: Readonly<{ nonce: string; ciphertext: string }>;
}>;

export type EncryptedObjectCipher = Readonly<{
  envelope: ContentEnvelopeV1;
  keyId: string;
  keyClass: "ai_assisted";
  keyPurpose: "object_wrap";
  keyVersion: number;
}>;

export type ObjectWrapReservationRecord = Readonly<{
  reservationId: string;
  keyId: string;
  keyClass: "ai_assisted";
  keyPurpose: "object_wrap";
  keyVersion: number;
  operationCount: 1;
  consumed: false;
}>;

export type ClaimedNoteIndexJob = Readonly<{
  jobId: string;
  userId: string;
  noteId: string;
  generationId: string;
  targetRevision: number;
  indexResourceId: string;
  noteType: NoteType;
  spaceId: string | null;
  isOpen: boolean;
  pinnedAt: string | null;
  updatedAt: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
  sourceNoteCipher: EncryptedObjectCipher;
  sourceEnvelopeBytes: number;
  sourceKey: ManagedKeyRecord;
  targetKey: ManagedKeyRecord;
  embeddingModelId: string;
  embeddingDimensions: number;
  generationRevisionToken: number;
  reservation: ObjectWrapReservationRecord;
}>;

export type ClaimNoteIndexJobsResult = Readonly<{
  jobs: readonly ClaimedNoteIndexJob[];
  sourceEnvelopeBytes: number;
  sourceEnvelopeByteBudget: typeof SOURCE_ENVELOPE_BYTE_BUDGET;
}>;

export type HeartbeatNoteIndexJobResult = Readonly<{
  jobId: string;
  leaseExpiresAt: string;
  disclosureAuthorized: true;
}>;

export type CommitNoteRagIndexResult =
  | Readonly<{
      jobId: string;
      indexId: string;
      reservationId: string;
      generationRevisionToken: number;
      committed: true;
      replayed: false;
    }>
  | Readonly<{
      jobId: string;
      indexId: string;
      reservationId: string;
      committed: true;
      replayed: true;
    }>
  | Readonly<{
      jobId: string;
      committed: false;
      errorCode: "stale_revision" | "validation_failed";
      replayed: false;
    }>;

export type FailNoteIndexJobResult = Readonly<{
  jobId: string;
  state: "queued" | "failed";
  replayed: boolean;
}>;

export type RecoverStaleNoteIndexJobsResult = Readonly<{
  recoveredCount: number;
  failedCount: number;
}>;

export type RagIndexCursor = Readonly<{
  generationId: string;
  revisionToken: number;
  afterIndexId: string;
}>;

export type ActiveRagGeneration = Readonly<{
  generationId: string;
  embeddingModelId: string;
  embeddingDimensions: number;
  envelopeSchemaVersion: 1;
  revisionToken: number;
}>;

export type RagRepairCandidate = Readonly<{
  noteId: string;
  currentRevision: number;
  updatedAt: string;
}>;

export type ActiveRagCoverage = Readonly<{
  expectedNoteCount: number;
  indexedNoteCount: number;
  eligibleNoteCount: number;
  coveredNoteCount: number;
  repairCount: number;
  repairLimitExceeded: boolean;
  repairCandidates: readonly RagRepairCandidate[];
  pendingJobCount: number;
  verified: boolean;
  complete: boolean;
}>;

export type ActiveRagIndexItem = Readonly<{
  indexId: string;
  noteId: string;
  indexedRevision: number;
  cipher: EncryptedObjectCipher;
  encryptedByteLength: number;
}>;

export type ListActiveNoteRagIndexResult = Readonly<{
  ownerId: string;
  generation: ActiveRagGeneration | null;
  coverage: ActiveRagCoverage;
  items: readonly ActiveRagIndexItem[];
  keys: readonly ManagedKeyRecord[];
  page: Readonly<{
    limit: number;
    ciphertextByteBudget: number;
    returnedCount: number;
    ciphertextBytes: number;
    hasMore: boolean;
    nextCursor: RagIndexCursor | null;
  }>;
}>;

export type IndexDatabaseQuery = Readonly<{
  text: string;
  values: readonly unknown[];
  signal: AbortSignal;
}>;

export type IndexDatabaseQueryResult = Readonly<{ rows: readonly unknown[] }>;

/**
 * The executor must either remain bound to one session for each repository call,
 * or prove the exact immutable role on every connection before that connection
 * enters its private pool and prevent all role-changing SQL.
 */
export type IndexDatabaseQueryExecutor = Readonly<{
  query(query: IndexDatabaseQuery): Promise<IndexDatabaseQueryResult>;
}>;

export class IndexDatabaseContractError extends Error {
  readonly code: "contract_violation" | "identity_denied";

  constructor(code: "contract_violation" | "identity_denied") {
    super(
      code === "identity_denied"
        ? "Index database identity was denied"
        : "Index database contract was rejected"
    );
    this.name = "IndexDatabaseContractError";
    this.code = code;
  }
}

export type ClaimNoteIndexJobsInput = Readonly<{
  workerId: string;
  limit: number;
  leaseSeconds: number;
  signal: AbortSignal;
}>;

export type HeartbeatNoteIndexJobInput = Readonly<{
  jobId: string;
  leaseToken: string;
  leaseSeconds: number;
  signal: AbortSignal;
}>;

export type CommitNoteRagIndexInput = Readonly<{
  jobId: string;
  leaseToken: string;
  indexId: string;
  indexEnvelope: ContentEnvelopeV1;
  indexKeyId: string;
  indexKeyClass: "ai_assisted";
  indexKeyPurpose: "object_wrap";
  indexKeyVersion: number;
  reservationId: string;
  encryptedByteLength: number;
  signal: AbortSignal;
}>;

export type FailNoteIndexJobInput = Readonly<{
  jobId: string;
  leaseToken: string;
  errorCode: SafeErrorCode;
  retryable: boolean;
  retryDelaySeconds: number;
  signal: AbortSignal;
}>;

export type ListActiveNoteRagIndexInput = Readonly<{
  ownerId: string;
  cursor: RagIndexCursor | null;
  limit: number;
  ciphertextByteBudget: number;
  signal: AbortSignal;
}>;

export type NoteIndexRepository = Readonly<{
  preflight(signal: AbortSignal): Promise<void>;
  recoverStale(limit: number, signal: AbortSignal): Promise<RecoverStaleNoteIndexJobsResult>;
  claim(input: ClaimNoteIndexJobsInput): Promise<ClaimNoteIndexJobsResult>;
  heartbeat(input: HeartbeatNoteIndexJobInput): Promise<HeartbeatNoteIndexJobResult>;
  commit(input: CommitNoteRagIndexInput): Promise<CommitNoteRagIndexResult>;
  fail(input: FailNoteIndexJobInput): Promise<FailNoteIndexJobResult>;
  listActive(input: ListActiveNoteRagIndexInput): Promise<ListActiveNoteRagIndexResult>;
}>;

const IDENTITY_SQL =
  'select session_user::text as "sessionUser", current_user::text as "currentUser"';
const RPC_SQL = Object.freeze({
  claim_note_index_jobs:
    "select public.claim_note_index_jobs($1::text, $2::integer, $3::integer) as result",
  heartbeat_note_index_job:
    "select public.heartbeat_note_index_job($1::text, $2::uuid, $3::integer) as result",
  commit_note_rag_index:
    "select public.commit_note_rag_index($1::text, $2::uuid, $3::text, $4::jsonb, $5::text, $6::public.content_key_class, $7::public.content_key_purpose, $8::integer, $9::integer) as result",
  fail_note_index_job:
    "select public.fail_note_index_job($1::text, $2::uuid, $3::public.safe_error_code, $4::boolean, $5::integer) as result",
  recover_stale_note_index_jobs:
    "select public.recover_stale_note_index_jobs($1::integer) as result",
  list_active_note_rag_index:
    "select public.list_active_note_rag_index($1::uuid, $2::jsonb, $3::integer, $4::integer) as result"
});

function rejectContract(): never {
  throw new IndexDatabaseContractError("contract_violation");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) rejectContract();
  return value;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    rejectContract();
  }
  return Number(value);
}

function matchingString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) rejectContract();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !TIMESTAMP_PATTERN.test(value)) {
    rejectContract();
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) rejectContract();
  return new Date(milliseconds).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function abortIfRequested(signalValue: AbortSignal): void {
  const signal = signalValue as unknown;
  if (
    !isRecord(signal) ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    rejectContract();
  }
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function decodedBase64UrlBytes(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((maximum * 4) / 3) ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    rejectContract();
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.toString("base64url") !== value ||
    bytes.byteLength < minimum ||
    bytes.byteLength > maximum
  ) {
    rejectContract();
  }
  return bytes.byteLength;
}

function encryptedPart(
  value: unknown,
  minimumCiphertextBytes: number,
  maximumCiphertextBytes: number
): Readonly<{ nonce: string; ciphertext: string }> {
  const row = exactRecord(value, ["nonce", "ciphertext"]);
  decodedBase64UrlBytes(row.nonce, 12, 12);
  decodedBase64UrlBytes(row.ciphertext, minimumCiphertextBytes, maximumCiphertextBytes);
  return Object.freeze({ nonce: String(row.nonce), ciphertext: String(row.ciphertext) });
}

function contentEnvelope(
  value: unknown,
  expected: Readonly<{
    tenantId?: string;
    resourceId?: string;
    recordVersion?: number;
    kind: "note_content" | "note_rag_index";
    keyId?: string;
  }>
): ContentEnvelopeV1 {
  const row = exactRecord(value, [
    "version",
    "suite",
    "keyId",
    "context",
    "wrappedDataKey",
    "payload"
  ]);
  const context = exactRecord(row.context, ["tenantId", "resourceId", "recordVersion", "kind"]);
  if (
    row.version !== 1 ||
    row.suite !== "A256GCM" ||
    typeof row.keyId !== "string" ||
    !IDENTIFIER_PATTERN.test(row.keyId) ||
    typeof context.tenantId !== "string" ||
    !IDENTIFIER_PATTERN.test(context.tenantId) ||
    typeof context.resourceId !== "string" ||
    !IDENTIFIER_PATTERN.test(context.resourceId) ||
    context.kind !== expected.kind
  ) {
    rejectContract();
  }
  const recordVersion = integer(context.recordVersion, 0, MAX_COUNTER);
  if (
    (expected.tenantId !== undefined && context.tenantId !== expected.tenantId) ||
    (expected.resourceId !== undefined && context.resourceId !== expected.resourceId) ||
    (expected.recordVersion !== undefined && recordVersion !== expected.recordVersion) ||
    (expected.keyId !== undefined && row.keyId !== expected.keyId)
  ) {
    rejectContract();
  }
  const payloadMaximum =
    expected.kind === "note_content" ? MAX_SOURCE_CIPHERTEXT_BYTES : MAX_INDEX_CIPHERTEXT_BYTES;
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: row.keyId,
    context: Object.freeze({
      tenantId: context.tenantId,
      resourceId: context.resourceId,
      recordVersion,
      kind: expected.kind
    }),
    wrappedDataKey: encryptedPart(row.wrappedDataKey, 48, 48),
    payload: encryptedPart(row.payload, 16, payloadMaximum)
  });
}

function encryptedCipher(
  value: unknown,
  expected: Readonly<{
    tenantId: string;
    resourceId: string;
    recordVersion: number;
    kind: "note_content" | "note_rag_index";
  }>
): EncryptedObjectCipher {
  const row = exactRecord(value, ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"]);
  if (
    typeof row.keyId !== "string" ||
    !IDENTIFIER_PATTERN.test(row.keyId) ||
    row.keyClass !== "ai_assisted" ||
    row.keyPurpose !== "object_wrap"
  ) {
    rejectContract();
  }
  const keyVersion = integer(row.keyVersion, 1, 2_147_483_647);
  return Object.freeze({
    envelope: contentEnvelope(row.envelope, { ...expected, keyId: row.keyId }),
    keyId: row.keyId,
    keyClass: "ai_assisted",
    keyPurpose: "object_wrap",
    keyVersion
  });
}

function normalizeManagedKey(
  value: unknown,
  parseRecord: ManagedKeyRecordParser
): ManagedKeyRecord {
  if (!isRecord(value) || !isRecord(value.rotation)) rejectContract();
  try {
    return parseRecord({
      ...value,
      activatedAt: nullableTimestamp(value.activatedAt),
      createdAt: timestamp(value.createdAt),
      retiredAt: nullableTimestamp(value.retiredAt),
      revokedAt: nullableTimestamp(value.revokedAt),
      rotation: {
        ...value.rotation,
        lastRootRewrappedAt: nullableTimestamp(value.rotation.lastRootRewrappedAt)
      }
    });
  } catch {
    return rejectContract();
  }
}

function reservation(value: unknown): ObjectWrapReservationRecord {
  const row = exactRecord(value, [
    "reservationId",
    "keyId",
    "keyClass",
    "keyPurpose",
    "keyVersion",
    "operationCount",
    "consumed"
  ]);
  if (
    typeof row.keyId !== "string" ||
    !IDENTIFIER_PATTERN.test(row.keyId) ||
    row.keyClass !== "ai_assisted" ||
    row.keyPurpose !== "object_wrap" ||
    row.operationCount !== 1 ||
    row.consumed !== false
  ) {
    rejectContract();
  }
  return Object.freeze({
    reservationId: matchingString(row.reservationId, UUID_PATTERN),
    keyId: row.keyId,
    keyClass: "ai_assisted",
    keyPurpose: "object_wrap",
    keyVersion: integer(row.keyVersion, 1, 2_147_483_647),
    operationCount: 1,
    consumed: false
  });
}

function sameKeyReference(
  left: Readonly<{ keyId: string; keyClass: string; keyVersion: number }>,
  right: Readonly<{ keyId: string; keyClass: string; keyVersion: number }>
): boolean {
  return (
    left.keyId === right.keyId &&
    left.keyClass === right.keyClass &&
    left.keyVersion === right.keyVersion
  );
}

function claimedJob(value: unknown, parseRecord: ManagedKeyRecordParser): ClaimedNoteIndexJob {
  const row = exactRecord(value, [
    "jobId",
    "userId",
    "noteId",
    "generationId",
    "targetRevision",
    "indexResourceId",
    "noteType",
    "spaceId",
    "isOpen",
    "pinnedAt",
    "updatedAt",
    "attempt",
    "leaseToken",
    "leaseExpiresAt",
    "sourceNoteCipher",
    "sourceEnvelopeBytes",
    "sourceKey",
    "targetKey",
    "embeddingModelId",
    "embeddingDimensions",
    "generationRevisionToken",
    "reservation"
  ]);
  const userId = matchingString(row.userId, UUID_PATTERN);
  const noteId = matchingString(row.noteId, NOTE_ID_PATTERN);
  const targetRevision = integer(row.targetRevision, 1, MAX_COUNTER);
  const sourceNoteCipher = encryptedCipher(row.sourceNoteCipher, {
    tenantId: userId,
    resourceId: noteId,
    recordVersion: targetRevision,
    kind: "note_content"
  });
  const sourceKey = normalizeManagedKey(row.sourceKey, parseRecord);
  const targetKey = normalizeManagedKey(row.targetKey, parseRecord);
  const targetReservation = reservation(row.reservation);
  if (
    !oneOf(row.noteType, ["generic", "list", "log", "principle", "project"] as const) ||
    (row.spaceId !== null &&
      (typeof row.spaceId !== "string" || !SPACE_ID_PATTERN.test(row.spaceId))) ||
    typeof row.isOpen !== "boolean" ||
    typeof row.embeddingModelId !== "string" ||
    !MODEL_ID_PATTERN.test(row.embeddingModelId) ||
    sourceKey.ownerId !== userId ||
    sourceKey.purpose !== "object_wrap" ||
    !oneOf(sourceKey.status, ["active", "retired"] as const) ||
    targetKey.ownerId !== userId ||
    targetKey.purpose !== "object_wrap" ||
    targetKey.status !== "active" ||
    !sameKeyReference(sourceNoteCipher, sourceKey) ||
    !sameKeyReference(targetReservation, targetKey)
  ) {
    rejectContract();
  }
  return Object.freeze({
    jobId: matchingString(row.jobId, JOB_ID_PATTERN),
    userId,
    noteId,
    generationId: matchingString(row.generationId, GENERATION_ID_PATTERN),
    targetRevision,
    indexResourceId: matchingString(row.indexResourceId, INDEX_ID_PATTERN),
    noteType: row.noteType,
    spaceId: row.spaceId,
    isOpen: row.isOpen,
    pinnedAt: nullableTimestamp(row.pinnedAt),
    updatedAt: timestamp(row.updatedAt),
    attempt: integer(row.attempt, 1, 5),
    leaseToken: matchingString(row.leaseToken, UUID_PATTERN),
    leaseExpiresAt: timestamp(row.leaseExpiresAt),
    sourceNoteCipher,
    sourceEnvelopeBytes: integer(row.sourceEnvelopeBytes, 1, SOURCE_ENVELOPE_BYTE_BUDGET),
    sourceKey,
    targetKey,
    embeddingModelId: row.embeddingModelId,
    embeddingDimensions: integer(row.embeddingDimensions, 1, 4_096),
    generationRevisionToken: integer(row.generationRevisionToken, 0, MAX_COUNTER),
    reservation: targetReservation
  });
}

function resultValue(result: IndexDatabaseQueryResult): unknown {
  if (result.rows.length !== 1) rejectContract();
  const row = exactRecord(result.rows[0], ["result"]);
  return row.result;
}

function parseClaimResult(
  value: unknown,
  parseRecord: ManagedKeyRecordParser
): ClaimNoteIndexJobsResult {
  const row = exactRecord(value, ["jobs", "sourceEnvelopeBytes", "sourceEnvelopeByteBudget"]);
  if (
    !Array.isArray(row.jobs) ||
    row.jobs.length > 50 ||
    row.sourceEnvelopeByteBudget !== SOURCE_ENVELOPE_BYTE_BUDGET
  ) {
    rejectContract();
  }
  const jobs = row.jobs.map((job) => claimedJob(job, parseRecord));
  const sourceEnvelopeBytes = integer(row.sourceEnvelopeBytes, 0, SOURCE_ENVELOPE_BYTE_BUDGET);
  if (jobs.reduce((sum, job) => sum + job.sourceEnvelopeBytes, 0) !== sourceEnvelopeBytes) {
    rejectContract();
  }
  const jobIds = new Set(jobs.map((job) => job.jobId));
  const reservations = new Set(jobs.map((job) => job.reservation.reservationId));
  if (jobIds.size !== jobs.length || reservations.size !== jobs.length) rejectContract();
  return Object.freeze({
    jobs: Object.freeze(jobs),
    sourceEnvelopeBytes,
    sourceEnvelopeByteBudget: SOURCE_ENVELOPE_BYTE_BUDGET
  });
}

function parseHeartbeatResult(value: unknown): HeartbeatNoteIndexJobResult {
  const row = exactRecord(value, ["jobId", "leaseExpiresAt", "disclosureAuthorized"]);
  if (row.disclosureAuthorized !== true) rejectContract();
  return Object.freeze({
    jobId: matchingString(row.jobId, JOB_ID_PATTERN),
    leaseExpiresAt: timestamp(row.leaseExpiresAt),
    disclosureAuthorized: true
  });
}

function parseCommitResult(value: unknown): CommitNoteRagIndexResult {
  if (!isRecord(value)) rejectContract();
  if (value.committed === false) {
    const row = exactRecord(value, ["jobId", "committed", "errorCode", "replayed"]);
    if (
      !oneOf(row.errorCode, ["stale_revision", "validation_failed"] as const) ||
      row.replayed !== false
    )
      rejectContract();
    return Object.freeze({
      jobId: matchingString(row.jobId, JOB_ID_PATTERN),
      committed: false,
      errorCode: row.errorCode,
      replayed: false
    });
  }
  if (value.committed !== true || typeof value.replayed !== "boolean") rejectContract();
  if (value.replayed) {
    const row = exactRecord(value, ["jobId", "indexId", "reservationId", "committed", "replayed"]);
    return Object.freeze({
      jobId: matchingString(row.jobId, JOB_ID_PATTERN),
      indexId: matchingString(row.indexId, INDEX_ID_PATTERN),
      reservationId: matchingString(row.reservationId, UUID_PATTERN),
      committed: true,
      replayed: true
    });
  }
  const row = exactRecord(value, [
    "jobId",
    "indexId",
    "reservationId",
    "generationRevisionToken",
    "committed",
    "replayed"
  ]);
  return Object.freeze({
    jobId: matchingString(row.jobId, JOB_ID_PATTERN),
    indexId: matchingString(row.indexId, INDEX_ID_PATTERN),
    reservationId: matchingString(row.reservationId, UUID_PATTERN),
    generationRevisionToken: integer(row.generationRevisionToken, 0, MAX_COUNTER),
    committed: true,
    replayed: false
  });
}

function parseFailResult(value: unknown): FailNoteIndexJobResult {
  const row = exactRecord(value, ["jobId", "state", "replayed"]);
  if (!oneOf(row.state, ["queued", "failed"] as const) || typeof row.replayed !== "boolean")
    rejectContract();
  return Object.freeze({
    jobId: matchingString(row.jobId, JOB_ID_PATTERN),
    state: row.state,
    replayed: row.replayed
  });
}

function parseRecoveryResult(value: unknown): RecoverStaleNoteIndexJobsResult {
  const row = exactRecord(value, ["recoveredCount", "failedCount"]);
  return Object.freeze({
    recoveredCount: integer(row.recoveredCount, 0, 1_000),
    failedCount: integer(row.failedCount, 0, 1_000)
  });
}

function parseCursor(value: unknown): RagIndexCursor {
  const row = exactRecord(value, ["generationId", "revisionToken", "afterIndexId"]);
  return Object.freeze({
    generationId: matchingString(row.generationId, GENERATION_ID_PATTERN),
    revisionToken: integer(row.revisionToken, 0, MAX_COUNTER),
    afterIndexId: matchingString(row.afterIndexId, INDEX_ID_PATTERN)
  });
}

function parseGeneration(value: unknown): ActiveRagGeneration {
  const row = exactRecord(value, [
    "generationId",
    "embeddingModelId",
    "embeddingDimensions",
    "envelopeSchemaVersion",
    "revisionToken"
  ]);
  if (
    typeof row.embeddingModelId !== "string" ||
    !MODEL_ID_PATTERN.test(row.embeddingModelId) ||
    row.envelopeSchemaVersion !== 1
  ) {
    rejectContract();
  }
  return Object.freeze({
    generationId: matchingString(row.generationId, GENERATION_ID_PATTERN),
    embeddingModelId: row.embeddingModelId,
    embeddingDimensions: integer(row.embeddingDimensions, 1, 4_096),
    envelopeSchemaVersion: 1,
    revisionToken: integer(row.revisionToken, 0, MAX_COUNTER)
  });
}

function parseCoverage(value: unknown): ActiveRagCoverage {
  const row = exactRecord(value, [
    "expectedNoteCount",
    "indexedNoteCount",
    "eligibleNoteCount",
    "coveredNoteCount",
    "repairCount",
    "repairLimitExceeded",
    "repairCandidates",
    "pendingJobCount",
    "verified",
    "complete"
  ]);
  if (
    !Array.isArray(row.repairCandidates) ||
    row.repairCandidates.length > 50 ||
    typeof row.repairLimitExceeded !== "boolean" ||
    typeof row.verified !== "boolean" ||
    typeof row.complete !== "boolean"
  ) {
    rejectContract();
  }
  const repairCandidates = row.repairCandidates.map((candidate) => {
    const candidateRow = exactRecord(candidate, ["noteId", "currentRevision", "updatedAt"]);
    return Object.freeze({
      noteId: matchingString(candidateRow.noteId, NOTE_ID_PATTERN),
      currentRevision: integer(candidateRow.currentRevision, 1, MAX_COUNTER),
      updatedAt: timestamp(candidateRow.updatedAt)
    });
  });
  const coverage = Object.freeze({
    expectedNoteCount: integer(row.expectedNoteCount, 0, MAX_COUNTER),
    indexedNoteCount: integer(row.indexedNoteCount, 0, MAX_COUNTER),
    eligibleNoteCount: integer(row.eligibleNoteCount, 0, MAX_COUNTER),
    coveredNoteCount: integer(row.coveredNoteCount, 0, MAX_COUNTER),
    repairCount: integer(row.repairCount, 0, 51),
    repairLimitExceeded: row.repairLimitExceeded,
    repairCandidates: Object.freeze(repairCandidates),
    pendingJobCount: integer(row.pendingJobCount, 0, MAX_COUNTER),
    verified: row.verified,
    complete: row.complete
  });
  if (
    coverage.indexedNoteCount > coverage.expectedNoteCount ||
    coverage.coveredNoteCount > coverage.eligibleNoteCount ||
    coverage.repairCandidates.length !== Math.min(coverage.repairCount, 50) ||
    coverage.repairLimitExceeded !== (coverage.repairCount === 51) ||
    (coverage.complete &&
      (!coverage.verified ||
        coverage.repairCount !== 0 ||
        coverage.pendingJobCount !== 0 ||
        coverage.expectedNoteCount !== coverage.eligibleNoteCount ||
        coverage.indexedNoteCount !== coverage.eligibleNoteCount ||
        coverage.coveredNoteCount !== coverage.eligibleNoteCount))
  ) {
    rejectContract();
  }
  return coverage;
}

function parseActiveItem(value: unknown, ownerId: string): ActiveRagIndexItem {
  const row = exactRecord(value, [
    "indexId",
    "noteId",
    "indexedRevision",
    "cipher",
    "encryptedByteLength"
  ]);
  const indexId = matchingString(row.indexId, INDEX_ID_PATTERN);
  const indexedRevision = integer(row.indexedRevision, 1, MAX_COUNTER);
  const cipher = encryptedCipher(row.cipher, {
    tenantId: ownerId,
    resourceId: indexId,
    recordVersion: indexedRevision,
    kind: "note_rag_index"
  });
  const encryptedByteLength = integer(
    row.encryptedByteLength,
    MIN_INDEX_CIPHERTEXT_BYTES,
    MAX_INDEX_CIPHERTEXT_BYTES
  );
  if (
    decodedBase64UrlBytes(cipher.envelope.payload.ciphertext, 16, MAX_INDEX_CIPHERTEXT_BYTES) !==
    encryptedByteLength
  ) {
    rejectContract();
  }
  return Object.freeze({
    indexId,
    noteId: matchingString(row.noteId, NOTE_ID_PATTERN),
    indexedRevision,
    cipher,
    encryptedByteLength
  });
}

function parseListResult(
  value: unknown,
  input: ListActiveNoteRagIndexInput,
  parseRecord: ManagedKeyRecordParser
): ListActiveNoteRagIndexResult {
  const row = exactRecord(value, ["ownerId", "generation", "coverage", "items", "keys", "page"]);
  if (
    row.ownerId !== input.ownerId ||
    !Array.isArray(row.items) ||
    !Array.isArray(row.keys) ||
    row.items.length > input.limit
  ) {
    rejectContract();
  }
  const generation = row.generation === null ? null : parseGeneration(row.generation);
  const coverage = parseCoverage(row.coverage);
  const items = row.items.map((item) => parseActiveItem(item, input.ownerId));
  const keys = row.keys.map((key) => normalizeManagedKey(key, parseRecord));
  const pageRow = exactRecord(row.page, [
    "limit",
    "ciphertextByteBudget",
    "returnedCount",
    "ciphertextBytes",
    "hasMore",
    "nextCursor"
  ]);
  if (
    pageRow.limit !== input.limit ||
    pageRow.ciphertextByteBudget !== input.ciphertextByteBudget ||
    typeof pageRow.hasMore !== "boolean"
  ) {
    rejectContract();
  }
  const nextCursor = pageRow.nextCursor === null ? null : parseCursor(pageRow.nextCursor);
  const page = Object.freeze({
    limit: input.limit,
    ciphertextByteBudget: input.ciphertextByteBudget,
    returnedCount: integer(pageRow.returnedCount, 0, input.limit),
    ciphertextBytes: integer(pageRow.ciphertextBytes, 0, input.ciphertextByteBudget),
    hasMore: pageRow.hasMore,
    nextCursor
  });
  const itemIds = new Set(items.map((item) => item.indexId));
  const keyIds = new Set(keys.map((key) => `${key.keyId}:${key.keyVersion}`));
  const referencedKeys = new Set(
    items.map((item) => `${item.cipher.keyId}:${item.cipher.keyVersion}`)
  );
  if (
    itemIds.size !== items.length ||
    keyIds.size !== keys.length ||
    page.returnedCount !== items.length ||
    page.ciphertextBytes !== items.reduce((sum, item) => sum + item.encryptedByteLength, 0) ||
    page.hasMore !== (page.nextCursor !== null) ||
    [...keys].some(
      (key) =>
        key.ownerId !== input.ownerId ||
        key.keyClass !== "ai_assisted" ||
        key.purpose !== "object_wrap" ||
        !oneOf(key.status, ["active", "retired"] as const)
    ) ||
    [...referencedKeys].some((key) => !keyIds.has(key)) ||
    [...keyIds].some((key) => !referencedKeys.has(key))
  ) {
    rejectContract();
  }
  const lastItem = items.at(-1);
  if (
    generation === null &&
    (items.length !== 0 ||
      keys.length !== 0 ||
      page.hasMore ||
      coverage.expectedNoteCount !== 0 ||
      coverage.indexedNoteCount !== 0)
  ) {
    rejectContract();
  }
  if (nextCursor !== null) {
    if (generation === null || lastItem === undefined) rejectContract();
    if (
      nextCursor.generationId !== generation.generationId ||
      nextCursor.revisionToken !== generation.revisionToken ||
      nextCursor.afterIndexId !== lastItem.indexId
    ) {
      rejectContract();
    }
  }
  return Object.freeze({
    ownerId: input.ownerId,
    generation,
    coverage,
    items: Object.freeze(items),
    keys: Object.freeze(keys),
    page
  });
}

function assertClaimInput(input: ClaimNoteIndexJobsInput): void {
  exactRecord(input, ["workerId", "limit", "leaseSeconds", "signal"]);
  matchingString(input.workerId, WORKER_ID_PATTERN);
  integer(input.limit, 1, 50);
  integer(input.leaseSeconds, 15, 900);
}

function assertHeartbeatInput(input: HeartbeatNoteIndexJobInput): void {
  exactRecord(input, ["jobId", "leaseToken", "leaseSeconds", "signal"]);
  matchingString(input.jobId, JOB_ID_PATTERN);
  matchingString(input.leaseToken, UUID_PATTERN);
  integer(input.leaseSeconds, 15, 900);
}

function assertCommitInput(input: CommitNoteRagIndexInput): ContentEnvelopeV1 {
  const row = exactRecord(input, [
    "jobId",
    "leaseToken",
    "indexId",
    "indexEnvelope",
    "indexKeyId",
    "indexKeyClass",
    "indexKeyPurpose",
    "indexKeyVersion",
    "reservationId",
    "encryptedByteLength",
    "signal"
  ]);
  matchingString(input.jobId, JOB_ID_PATTERN);
  matchingString(input.leaseToken, UUID_PATTERN);
  matchingString(input.indexId, INDEX_ID_PATTERN);
  matchingString(input.indexKeyId, IDENTIFIER_PATTERN);
  matchingString(input.reservationId, UUID_PATTERN);
  if (row.indexKeyClass !== "ai_assisted" || row.indexKeyPurpose !== "object_wrap")
    rejectContract();
  integer(input.indexKeyVersion, 1, 2_147_483_647);
  const encryptedByteLength = integer(
    input.encryptedByteLength,
    MIN_INDEX_CIPHERTEXT_BYTES,
    MAX_INDEX_CIPHERTEXT_BYTES
  );
  const envelope = contentEnvelope(input.indexEnvelope, {
    resourceId: input.indexId,
    kind: "note_rag_index",
    keyId: input.indexKeyId
  });
  if (
    envelope.context.recordVersion < 1 ||
    decodedBase64UrlBytes(
      envelope.payload.ciphertext,
      MIN_INDEX_CIPHERTEXT_BYTES,
      MAX_INDEX_CIPHERTEXT_BYTES
    ) !== encryptedByteLength
  ) {
    rejectContract();
  }
  return envelope;
}

function assertFailInput(input: FailNoteIndexJobInput): void {
  exactRecord(input, [
    "jobId",
    "leaseToken",
    "errorCode",
    "retryable",
    "retryDelaySeconds",
    "signal"
  ]);
  matchingString(input.jobId, JOB_ID_PATTERN);
  matchingString(input.leaseToken, UUID_PATTERN);
  if (!oneOf(input.errorCode, SAFE_ERROR_CODES) || typeof input.retryable !== "boolean")
    rejectContract();
  integer(input.retryDelaySeconds, 0, 86_400);
}

function assertListInput(input: ListActiveNoteRagIndexInput): RagIndexCursor | null {
  exactRecord(input, ["ownerId", "cursor", "limit", "ciphertextByteBudget", "signal"]);
  matchingString(input.ownerId, UUID_PATTERN);
  integer(input.limit, 1, 50);
  integer(input.ciphertextByteBudget, 262_160, SOURCE_ENVELOPE_BYTE_BUDGET);
  return input.cursor === null ? null : parseCursor(input.cursor);
}

async function query(
  executor: IndexDatabaseQueryExecutor,
  text: string,
  values: readonly unknown[],
  signal: AbortSignal
): Promise<IndexDatabaseQueryResult> {
  abortIfRequested(signal);
  const result = await executor.query(
    Object.freeze({ text, values: Object.freeze([...values]), signal })
  );
  abortIfRequested(signal);
  if (!isRecord(result) || !Array.isArray(result.rows)) rejectContract();
  return result;
}

export function createNoteIndexRepository(
  executor: IndexDatabaseQueryExecutor,
  parseRecord: ManagedKeyRecordParser = parseManagedKeyRecordV1
): NoteIndexRepository {
  async function preflight(signal: AbortSignal): Promise<void> {
    const result = await query(executor, IDENTITY_SQL, [], signal);
    if (result.rows.length !== 1) rejectContract();
    const row = exactRecord(result.rows[0], ["sessionUser", "currentUser"]);
    if (row.sessionUser !== EXPECTED_DATABASE_ROLE || row.currentUser !== EXPECTED_DATABASE_ROLE) {
      throw new IndexDatabaseContractError("identity_denied");
    }
  }

  async function verifiedResult(
    sql: string,
    values: readonly unknown[],
    signal: AbortSignal
  ): Promise<unknown> {
    await preflight(signal);
    return resultValue(await query(executor, sql, values, signal));
  }

  return Object.freeze({
    preflight,
    async recoverStale(limit, signal) {
      integer(limit, 1, 1_000);
      const result = parseRecoveryResult(
        await verifiedResult(RPC_SQL.recover_stale_note_index_jobs, [limit], signal)
      );
      if (result.recoveredCount + result.failedCount > limit) rejectContract();
      return result;
    },
    async claim(input) {
      assertClaimInput(input);
      const result = parseClaimResult(
        await verifiedResult(
          RPC_SQL.claim_note_index_jobs,
          [input.workerId, input.limit, input.leaseSeconds],
          input.signal
        ),
        parseRecord
      );
      if (result.jobs.length > input.limit) rejectContract();
      return result;
    },
    async heartbeat(input) {
      assertHeartbeatInput(input);
      const result = parseHeartbeatResult(
        await verifiedResult(
          RPC_SQL.heartbeat_note_index_job,
          [input.jobId, input.leaseToken, input.leaseSeconds],
          input.signal
        )
      );
      if (result.jobId !== input.jobId) rejectContract();
      return result;
    },
    async commit(input) {
      const envelope = assertCommitInput(input);
      const result = parseCommitResult(
        await verifiedResult(
          RPC_SQL.commit_note_rag_index,
          [
            input.jobId,
            input.leaseToken,
            input.indexId,
            envelope,
            input.indexKeyId,
            input.indexKeyClass,
            input.indexKeyPurpose,
            input.indexKeyVersion,
            input.encryptedByteLength
          ],
          input.signal
        )
      );
      if (
        result.jobId !== input.jobId ||
        (result.committed &&
          (result.indexId !== input.indexId || result.reservationId !== input.reservationId))
      ) {
        rejectContract();
      }
      return result;
    },
    async fail(input) {
      assertFailInput(input);
      const result = parseFailResult(
        await verifiedResult(
          RPC_SQL.fail_note_index_job,
          [
            input.jobId,
            input.leaseToken,
            input.errorCode,
            input.retryable,
            input.retryDelaySeconds
          ],
          input.signal
        )
      );
      if (result.jobId !== input.jobId) rejectContract();
      return result;
    },
    async listActive(input) {
      const cursor = assertListInput(input);
      return parseListResult(
        await verifiedResult(
          RPC_SQL.list_active_note_rag_index,
          [input.ownerId, cursor, input.limit, input.ciphertextByteBudget],
          input.signal
        ),
        input,
        parseRecord
      );
    }
  });
}
