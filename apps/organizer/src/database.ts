import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import { parseManagedKeyRecord } from "@unfiled/key-management";

import type {
  AtomicOrganizerCommand,
  CandidateRevalidationManifest,
  ClaimedOrganizerJob,
  EncryptedCandidate,
  EncryptedProjection,
  OrganizerAppendPreparationResult,
  OrganizerCandidatePage,
  OrganizerCommitResult,
  OrganizerHeartbeatResult,
  OrganizerPreparation,
  OrganizerRepository
} from "./drain.js";
import { OrganizerUnavailableError } from "./errors.js";
const EXPECTED_ROLE = "unfiled_organizer_worker";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENTITY_SUFFIX = "[0-9A-HJKMNP-TV-Z]{26}";
const JOB = new RegExp(`^job_${ENTITY_SUFFIX}$`, "u");
const CAPTURE = new RegExp(`^cap_${ENTITY_SUFFIX}$`, "u");
const NOTE = new RegExp(`^note_${ENTITY_SUFFIX}$`, "u");
const DECISION = new RegExp(`^dec_${ENTITY_SUFFIX}$`, "u");
const MUTATION = new RegExp(`^mut_${ENTITY_SUFFIX}$`, "u");
const REVIEW = new RegExp(`^rvw_${ENTITY_SUFFIX}$`, "u");
const REVISION = new RegExp(`^rev_${ENTITY_SUFFIX}$`, "u");
const NOTE_TYPES = ["generic", "list", "log", "principle", "project"] as const;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SOURCE_BYTE_BUDGET = 8_388_608;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export const ORGANIZER_RPC_NAMES = Object.freeze([
  "claim_encrypted_organizer_jobs",
  "heartbeat_encrypted_organizer_job",
  "list_encrypted_organizer_candidates",
  "prepare_encrypted_organizer_create",
  "prepare_encrypted_organizer_append",
  "commit_encrypted_organizer_job",
  "fail_encrypted_organizer_job",
  "recover_stale_encrypted_organizer_jobs"
] as const);

export const ORGANIZER_IDENTITY_SQL =
  'select session_user::text as "sessionUser", current_user::text as "currentUser"';
export const ORGANIZER_RPC_SQL = Object.freeze({
  claim:
    "select public.claim_encrypted_organizer_jobs($1::text, $2::integer, $3::integer) as result",
  heartbeat:
    "select public.heartbeat_encrypted_organizer_job($1::text, $2::text, $3::integer, $4::jsonb) as result",
  candidates:
    "select public.list_encrypted_organizer_candidates($1::text, $2::text, $3::integer) as result",
  prepareCreate:
    "select public.prepare_encrypted_organizer_create($1::text, $2::text, $3::text, $4::text) as result",
  prepareAppend:
    "select public.prepare_encrypted_organizer_append($1::text, $2::text, $3::text, $4::bigint, $5::text) as result",
  commit: "select public.commit_encrypted_organizer_job($1::text, $2::text, $3::jsonb) as result",
  fail: "select public.fail_encrypted_organizer_job($1::text, $2::text, $3::text, $4::boolean) as result",
  recover: "select public.recover_stale_encrypted_organizer_jobs($1::integer) as result"
});

export type OrganizerDatabaseQuery = Readonly<{
  signal: AbortSignal;
  text: string;
  values: readonly unknown[];
}>;
export type OrganizerDatabaseExecutor = Readonly<{
  query(query: OrganizerDatabaseQuery): Promise<Readonly<{ rows: readonly unknown[] }>>;
}>;
export class OrganizerDatabaseContractError extends Error {
  public readonly code: "contract_violation" | "identity_denied";
  public constructor(code: "contract_violation" | "identity_denied") {
    super(
      code === "identity_denied"
        ? "Organizer database identity was denied"
        : "Organizer database contract was rejected"
    );
    this.name = "OrganizerDatabaseContractError";
    this.code = code;
  }
}

function reject(): never {
  throw new OrganizerDatabaseContractError("contract_violation");
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject();
  return value as Readonly<Record<string, unknown>>;
}
function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const row = record(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index]))
    reject();
  return row;
}
function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) reject();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) reject();
  return Number(value);
}
function isNoteId(value: string): value is `note_${string}` {
  return NOTE.test(value);
}
function oneResult(rows: readonly unknown[]): unknown {
  if (rows.length !== 1) reject();
  return exact(rows[0], ["result"]).result;
}
function jsonBounded(value: unknown, maximum = 2_000_000): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return reject();
  }
  if (new TextEncoder().encode(encoded).byteLength > maximum) reject();
  return value;
}

function decodedBytes(value: unknown): number {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1) reject();
  const bytes = Buffer.from(value, "base64url");
  const canonical = bytes.toString("base64url");
  const length = bytes.byteLength;
  bytes.fill(0);
  if (canonical !== value) reject();
  return length;
}

function captureControls(value: unknown): ClaimedOrganizerJob["controls"] {
  const controls = exact(value, ["expansionDisabled", "explicitDestinationNoteId"]);
  const explicitDestinationNoteId =
    controls.explicitDestinationNoteId === null
      ? null
      : (string(controls.explicitDestinationNoteId, NOTE) as `note_${string}`);
  if (typeof controls.expansionDisabled !== "boolean") reject();
  return Object.freeze({
    expansionDisabled: controls.expansionDisabled,
    explicitDestinationNoteId
  });
}

type ParsedProjection = EncryptedProjection &
  Readonly<{
    encryptedByteLength: number;
    serializedEnvelopeBytes: number;
  }>;

function projection(
  value: unknown,
  expected: Readonly<{
    ownerId: string;
    resourceId: string;
    recordVersion: number;
    kind: "capture" | "note_content";
  }>
): ParsedProjection {
  const row = exact(value, [
    "resourceId",
    "recordVersion",
    "envelope",
    "keyRecord",
    "encryptedByteLength"
  ]);
  if (row.resourceId !== expected.resourceId || row.recordVersion !== expected.recordVersion)
    reject();
  let envelope;
  let key;
  let serializedEnvelope: string;
  try {
    serializedEnvelope = serializeContentEnvelope(row.envelope);
    envelope = parseContentEnvelope(serializedEnvelope);
    key = parseManagedKeyRecord(row.keyRecord);
  } catch {
    return reject();
  }
  const encryptedByteLength = integer(row.encryptedByteLength, 16, 1_048_592);
  if (
    decodedBytes(envelope.payload.ciphertext) !== encryptedByteLength ||
    envelope.keyId !== key.keyId ||
    envelope.context.tenantId !== expected.ownerId ||
    envelope.context.resourceId !== expected.resourceId ||
    envelope.context.recordVersion !== expected.recordVersion ||
    envelope.context.kind !== expected.kind ||
    key.ownerId !== expected.ownerId ||
    key.keyClass !== "ai_assisted" ||
    key.purpose !== "object_wrap" ||
    (key.status !== "active" && key.status !== "retired")
  )
    reject();
  return Object.freeze({
    resourceId: expected.resourceId,
    recordVersion: expected.recordVersion,
    cipher: Object.freeze({
      envelope,
      keyId: key.keyId,
      keyClass: key.keyClass,
      keyPurpose: key.purpose,
      keyVersion: key.keyVersion
    }),
    key,
    encryptedByteLength,
    serializedEnvelopeBytes: new TextEncoder().encode(serializedEnvelope).byteLength
  });
}

function claimResult(value: unknown, limit: number): readonly ClaimedOrganizerJob[] {
  const root = exact(value, ["jobs", "sourceEnvelopeBytes", "sourceEnvelopeByteBudget"]);
  if (!Array.isArray(root.jobs) || root.jobs.length > limit) reject();
  const ids = new Set<string>();
  const jobs = root.jobs.map(
    (entry): ClaimedOrganizerJob & Readonly<{ source: ParsedProjection }> => {
      const row = exact(entry, [
        "attempt",
        "captureId",
        "controls",
        "jobId",
        "leaseExpiresAt",
        "leaseToken",
        "ownerId",
        "promptVersion",
        "replanCount",
        "schemaVersion",
        "source"
      ]);
      const jobId = string(row.jobId, JOB);
      const captureId = string(row.captureId, CAPTURE) as `cap_${string}`;
      const ownerId = string(row.ownerId, UUID);
      const attempt = integer(row.attempt, 1, 100);
      const replanCount = integer(row.replanCount, 0, 1) as 0 | 1;
      if (
        ids.has(jobId) ||
        typeof row.leaseExpiresAt !== "string" ||
        !TIMESTAMP.test(row.leaseExpiresAt) ||
        !Number.isFinite(Date.parse(row.leaseExpiresAt))
      )
        reject();
      ids.add(jobId);
      const promptVersion = string(row.promptVersion, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u);
      const schemaVersion = integer(row.schemaVersion, 1, 2_147_483_647);
      const controls = captureControls(row.controls);
      return Object.freeze({
        attempt,
        captureId,
        controls,
        jobId,
        leaseExpiresAt: row.leaseExpiresAt,
        leaseToken: string(row.leaseToken, UUID),
        ownerId,
        promptVersion,
        replanCount,
        schemaVersion,
        source: projection(row.source, {
          kind: "capture",
          ownerId,
          recordVersion: 1,
          resourceId: captureId
        })
      });
    }
  );
  const sourceEnvelopeBytes = integer(root.sourceEnvelopeBytes, 0, SOURCE_BYTE_BUDGET);
  const canonicalEnvelopeBytes = jobs.reduce(
    (sum, job) => sum + job.source.serializedEnvelopeBytes,
    0
  );
  if (
    root.sourceEnvelopeByteBudget !== SOURCE_BYTE_BUDGET ||
    sourceEnvelopeBytes < canonicalEnvelopeBytes
  )
    reject();
  return Object.freeze(jobs);
}

function candidateResult(
  value: unknown,
  input: Readonly<{ jobId: string; limit: number }>,
  ownerId: string
): OrganizerCandidatePage {
  const root = exact(value, [
    "jobId",
    "candidates",
    "controls",
    "returnedCount",
    "encryptedBytes",
    "encryptedByteBudget"
  ]);
  if (
    root.jobId !== input.jobId ||
    !Array.isArray(root.candidates) ||
    root.candidates.length > input.limit
  )
    reject();
  const ids = new Set<string>();
  const candidates = root.candidates.map(
    (entry): EncryptedCandidate & Readonly<{ source: ParsedProjection }> => {
      const row = exact(entry, [
        "aggregate",
        "candidateId",
        "metadata",
        "noteId",
        "revision",
        "type"
      ]);
      const candidateIdValue = string(row.candidateId, NOTE);
      const noteIdValue = typeof row.noteId === "string" ? row.noteId : "";
      const metadata = exact(row.metadata, ["isOpen", "spaceId", "updatedAt"]);
      if (
        !isNoteId(noteIdValue) ||
        !isNoteId(candidateIdValue) ||
        ids.has(candidateIdValue) ||
        !NOTE_TYPES.includes(row.type as never) ||
        typeof metadata.isOpen !== "boolean" ||
        (metadata.spaceId !== null &&
          (typeof metadata.spaceId !== "string" ||
            !/^spc_[0-9A-HJKMNP-TV-Z]{26}$/u.test(metadata.spaceId))) ||
        typeof metadata.updatedAt !== "string" ||
        !TIMESTAMP.test(metadata.updatedAt)
      )
        reject();
      ids.add(candidateIdValue);
      const revision = integer(row.revision, 1);
      return Object.freeze({
        candidateId: candidateIdValue,
        isOpen: metadata.isOpen,
        noteId: noteIdValue,
        noteType: row.type as EncryptedCandidate["noteType"],
        revision,
        source: projection(row.aggregate, {
          kind: "note_content",
          ownerId,
          recordVersion: revision,
          resourceId: noteIdValue
        })
      });
    }
  );
  const encryptedByteBudget = integer(root.encryptedByteBudget, 1, SOURCE_BYTE_BUDGET);
  const encryptedBytes = integer(root.encryptedBytes, 0, encryptedByteBudget);
  const canonicalEnvelopeBytes = candidates.reduce(
    (sum, candidate) => sum + candidate.source.serializedEnvelopeBytes,
    0
  );
  if (root.returnedCount !== candidates.length || encryptedBytes < canonicalEnvelopeBytes) reject();
  return Object.freeze({
    candidates: Object.freeze(candidates),
    controls: captureControls(root.controls)
  });
}

function preparation(
  value: unknown,
  expected: Readonly<{
    jobId: string;
    mode: "append" | "create";
    noteId: string;
    expectedRevision: number | null;
    ownerId: string;
  }>
): OrganizerPreparation {
  const row = exact(value, [
    "expectedRevision",
    "ids",
    "jobId",
    "keys",
    "mode",
    "noteId",
    "replanCount",
    "replayed",
    "reservations",
    "targetRevision"
  ]);
  if (
    row.jobId !== expected.jobId ||
    row.mode !== expected.mode ||
    row.noteId !== expected.noteId ||
    row.expectedRevision !== expected.expectedRevision
  )
    reject();
  const targetRevision = integer(row.targetRevision, 1);
  if (targetRevision !== (expected.expectedRevision ?? 0) + 1) reject();
  const ids = exact(row.ids, ["decisionId", "mutationId", "reviewItemId", "revisionId"]);
  const parsedIds = Object.freeze({
    decisionId: string(ids.decisionId, DECISION) as `dec_${string}`,
    mutationId: string(ids.mutationId, MUTATION) as `mut_${string}`,
    reviewItemId: string(ids.reviewItemId, REVIEW) as `rvw_${string}`,
    revisionId: string(ids.revisionId, REVISION) as `rev_${string}`
  });
  const reservations = exact(row.reservations, ["decision", "noteWrite", "receipt", "review"]);
  function reservation<const Count extends 1 | 4>(value_: unknown, count: Count) {
    const value = exact(value_, ["operationCount", "reservationId"]);
    if (value.operationCount !== count) reject();
    return Object.freeze({
      operationCount: count,
      reservationId: string(value.reservationId, UUID)
    });
  }
  const parsedReservations = Object.freeze({
    decision: reservation(reservations.decision, 1),
    noteWrite: reservation(reservations.noteWrite, 4),
    receipt: reservation(reservations.receipt, 1),
    review: reservation(reservations.review, 1)
  });
  const keys = exact(row.keys, ["contentMac", "objectWrap"]);
  let contentMac;
  let objectWrap;
  try {
    contentMac = parseManagedKeyRecord(keys.contentMac);
    objectWrap = parseManagedKeyRecord(keys.objectWrap);
  } catch {
    return reject();
  }
  if (
    contentMac.ownerId !== expected.ownerId ||
    contentMac.keyClass !== "ai_assisted" ||
    contentMac.purpose !== "content_mac" ||
    contentMac.status !== "active" ||
    objectWrap.ownerId !== expected.ownerId ||
    objectWrap.keyClass !== "ai_assisted" ||
    objectWrap.purpose !== "object_wrap" ||
    objectWrap.status !== "active"
  )
    reject();
  if (typeof row.replayed !== "boolean") reject();
  return Object.freeze({
    expectedRevision: expected.expectedRevision,
    ids: parsedIds,
    jobId: expected.jobId,
    keys: Object.freeze({ contentMac, objectWrap }),
    mode: expected.mode,
    noteId: expected.noteId as `note_${string}`,
    replanCount: integer(row.replanCount, 0, 1) as 0 | 1,
    replayed: row.replayed,
    reservations: parsedReservations,
    targetRevision
  });
}

function revalidationManifest(
  value: CandidateRevalidationManifest,
  expectedControls: ClaimedOrganizerJob["controls"],
  expectedCandidates: readonly EncryptedCandidate[]
): CandidateRevalidationManifest {
  const root = exact(value, ["candidates", "controls"]);
  const controls = exact(root.controls, ["expansionDisabled", "explicitDestinationNoteId"]);
  if (
    controls.expansionDisabled !== expectedControls.expansionDisabled ||
    controls.explicitDestinationNoteId !== expectedControls.explicitDestinationNoteId ||
    !Array.isArray(root.candidates) ||
    root.candidates.length > 8 ||
    root.candidates.length !== expectedCandidates.length
  )
    reject();
  const candidates = root.candidates.map((entry, index) => {
    const row = exact(entry, ["candidateId", "isOpen", "noteId", "revision"]);
    const expected = expectedCandidates[index];
    if (
      expected === undefined ||
      row.candidateId !== expected.candidateId ||
      row.isOpen !== expected.isOpen ||
      row.noteId !== expected.noteId ||
      row.revision !== expected.revision
    )
      reject();
    return Object.freeze({
      candidateId: expected.candidateId,
      isOpen: expected.isOpen,
      noteId: expected.noteId,
      revision: expected.revision
    });
  });
  return Object.freeze({ candidates: Object.freeze(candidates), controls: expectedControls });
}

function heartbeatResult(
  value: unknown,
  expected: Readonly<{ candidateCount: number; jobId: string }>
): OrganizerHeartbeatResult {
  const root = record(value);
  if (root.outcome === "authorized") {
    const row = exact(root, [
      "candidateCount",
      "currentRevision",
      "disclosureAuthorized",
      "jobId",
      "leaseExpiresAt",
      "outcome",
      "replanCount"
    ]);
    if (
      row.jobId !== expected.jobId ||
      row.disclosureAuthorized !== true ||
      row.candidateCount !== expected.candidateCount ||
      typeof row.leaseExpiresAt !== "string" ||
      !TIMESTAMP.test(row.leaseExpiresAt) ||
      !Number.isFinite(Date.parse(row.leaseExpiresAt))
    )
      reject();
    const currentRevision = row.currentRevision === null ? null : integer(row.currentRevision, 1);
    return Object.freeze({
      candidateCount: expected.candidateCount,
      currentRevision,
      disclosureAuthorized: true,
      jobId: expected.jobId,
      leaseExpiresAt: row.leaseExpiresAt,
      outcome: "authorized",
      replanCount: integer(row.replanCount, 0, 1) as 0 | 1
    });
  }
  const row = exact(root, [
    "conflictReason",
    "jobId",
    "noteId",
    "outcome",
    "replanCount",
    "replayed",
    "revision"
  ]);
  if (
    (row.outcome !== "replan" && row.outcome !== "review") ||
    row.jobId !== expected.jobId ||
    row.replanCount !== 1 ||
    typeof row.replayed !== "boolean"
  )
    reject();
  if (
    row.conflictReason !== "candidate_eligibility" &&
    row.conflictReason !== "consent_controls" &&
    row.conflictReason !== "revision"
  )
    reject();
  const noteId = row.noteId === null ? null : (string(row.noteId, NOTE) as `note_${string}`);
  const revision = row.revision === null ? null : integer(row.revision, 1);
  if (
    (revision !== null && noteId === null) ||
    (row.conflictReason === "revision" && (noteId === null || revision === null)) ||
    (row.conflictReason === "candidate_eligibility" && noteId === null)
  )
    reject();
  return Object.freeze({
    conflictReason: row.conflictReason,
    jobId: expected.jobId,
    noteId,
    outcome: row.outcome,
    replayed: row.replayed,
    revision,
    replanCount: 1
  });
}

function appendPreparationResult(
  value: unknown,
  expected: Readonly<{
    expectedRevision: number;
    jobId: string;
    noteId: `note_${string}`;
    ownerId: string;
  }>
): OrganizerAppendPreparationResult {
  const root = record(value);
  if (root.outcome === "replan") {
    const row = exact(root, [
      "conflictReason",
      "jobId",
      "noteId",
      "outcome",
      "replanCount",
      "replayed",
      "revision"
    ]);
    if (
      (row.conflictReason !== "candidate_eligibility" && row.conflictReason !== "revision") ||
      row.jobId !== expected.jobId ||
      row.noteId !== expected.noteId ||
      row.replanCount !== 1 ||
      typeof row.replayed !== "boolean"
    )
      reject();
    const revision = row.revision === null ? null : integer(row.revision, 1);
    if (
      (row.conflictReason === "revision" && revision === null) ||
      (row.conflictReason === "candidate_eligibility" && revision !== null)
    )
      reject();
    return Object.freeze({
      conflictReason: row.conflictReason,
      jobId: expected.jobId,
      noteId: expected.noteId,
      outcome: "replan",
      replayed: row.replayed,
      revision,
      replanCount: 1
    });
  }
  const row =
    root.outcome === "review"
      ? exact(root, ["conflictReason", "outcome", "preparation"])
      : exact(root, ["outcome", "preparation"]);
  if (row.outcome !== "prepared" && row.outcome !== "review") reject();
  if (
    row.outcome === "review" &&
    row.conflictReason !== "candidate_eligibility" &&
    row.conflictReason !== "revision"
  )
    reject();
  const mode = row.outcome === "review" ? "create" : "append";
  const noteId =
    mode === "create" ? `note_${expected.jobId.slice("job_".length)}` : expected.noteId;
  const expectedRevision = mode === "create" ? null : expected.expectedRevision;
  const parsed = preparation(row.preparation, {
    expectedRevision,
    jobId: expected.jobId,
    mode,
    noteId,
    ownerId: expected.ownerId
  });
  return row.outcome === "review"
    ? Object.freeze({
        conflictReason: row.conflictReason as "candidate_eligibility" | "revision",
        outcome: "review" as const,
        preparation: parsed
      })
    : Object.freeze({ outcome: "prepared" as const, preparation: parsed });
}

function normalizeDatabaseFailure(error: unknown): never {
  if (error instanceof OrganizerDatabaseContractError || error instanceof OrganizerUnavailableError)
    throw error;
  if (error instanceof DOMException && error.name === "AbortError")
    throw new OrganizerUnavailableError();
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as Readonly<{ code?: unknown }>).code
      : undefined;
  if (
    typeof code === "string" &&
    (code.startsWith("08") ||
      code === "40001" ||
      code === "40P01" ||
      code === "53300" ||
      code === "55P03" ||
      code === "57014" ||
      /^57P0[123]$/u.test(code))
  )
    throw new OrganizerUnavailableError();
  if (code === "22023" || code === "42501" || code === "P0001")
    throw new OrganizerDatabaseContractError("contract_violation");
  throw new OrganizerUnavailableError();
}

async function execute(
  executor: OrganizerDatabaseExecutor,
  text: string,
  values: readonly unknown[],
  signal: AbortSignal
): Promise<unknown> {
  const isAborted = (): boolean => signal.aborted;
  if (isAborted()) throw new DOMException("The operation was aborted", "AbortError");
  let result: Readonly<{ rows: readonly unknown[] }>;
  try {
    result = await executor.query(
      Object.freeze({ signal, text, values: Object.freeze([...values]) })
    );
  } catch (error: unknown) {
    return normalizeDatabaseFailure(error);
  }
  if (isAborted()) throw new DOMException("The operation was aborted", "AbortError");
  return oneResult(result.rows);
}

export function createOrganizerRepository(
  executor: OrganizerDatabaseExecutor
): OrganizerRepository {
  const jobs = new Map<
    string,
    Readonly<{ controls: ClaimedOrganizerJob["controls"]; ownerId: string }>
  >();
  const candidatePages = new Map<string, readonly EncryptedCandidate[]>();
  const forget = (jobId: string): void => {
    jobs.delete(jobId);
    candidatePages.delete(jobId);
  };
  return Object.freeze({
    release(jobId) {
      forget(string(jobId, JOB));
    },
    async preflight(signal) {
      let result: Readonly<{ rows: readonly unknown[] }>;
      try {
        result = await executor.query({ signal, text: ORGANIZER_IDENTITY_SQL, values: [] });
      } catch (error: unknown) {
        return normalizeDatabaseFailure(error);
      }
      if (result.rows.length !== 1) throw new OrganizerDatabaseContractError("identity_denied");
      const row = exact(result.rows[0], ["sessionUser", "currentUser"]);
      if (row.sessionUser !== EXPECTED_ROLE || row.currentUser !== EXPECTED_ROLE)
        throw new OrganizerDatabaseContractError("identity_denied");
    },
    async recoverStale(limit, signal) {
      integer(limit, 1, 100);
      const row = exact(await execute(executor, ORGANIZER_RPC_SQL.recover, [limit], signal), [
        "deadLetteredCount",
        "recoveredCount",
        "requeuedCount"
      ]);
      const deadLetteredCount = integer(row.deadLetteredCount, 0, limit);
      const recoveredCount = integer(row.recoveredCount, 0, limit);
      const requeuedCount = integer(row.requeuedCount, 0, limit);
      if (recoveredCount > limit || deadLetteredCount + requeuedCount !== recoveredCount) reject();
      return Object.freeze({ deadLetteredCount, recoveredCount, requeuedCount });
    },
    async claim(input) {
      string(input.workerId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u);
      integer(input.limit, 1, 4);
      integer(input.leaseSeconds, 60, 900);
      const claimedJobs = claimResult(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.claim,
          [input.workerId, input.limit, input.leaseSeconds],
          input.signal
        ),
        input.limit
      );
      for (const job of claimedJobs) {
        candidatePages.delete(job.jobId);
        jobs.set(job.jobId, Object.freeze({ controls: job.controls, ownerId: job.ownerId }));
      }
      return claimedJobs;
    },
    async heartbeat(input) {
      const context = jobs.get(input.jobId);
      const page = candidatePages.get(input.jobId);
      if (context === undefined || page === undefined) reject();
      const manifest = revalidationManifest(input.candidateManifest, context.controls, page);
      return heartbeatResult(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.heartbeat,
          [input.jobId, input.leaseToken, input.leaseSeconds, jsonBounded(manifest)],
          input.signal
        ),
        { candidateCount: page.length, jobId: input.jobId }
      );
    },
    async candidates(input) {
      integer(input.limit, 1, 8);
      const context = jobs.get(input.jobId);
      if (context === undefined) reject();
      const page = candidateResult(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.candidates,
          [input.jobId, input.leaseToken, input.limit],
          input.signal
        ),
        input,
        context.ownerId
      );
      jobs.set(input.jobId, Object.freeze({ controls: page.controls, ownerId: context.ownerId }));
      candidatePages.set(input.jobId, page.candidates);
      return page;
    },
    async prepareCreate(input) {
      const context = jobs.get(input.jobId);
      if (context === undefined) reject();
      return preparation(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.prepareCreate,
          [input.jobId, input.leaseToken, input.stableNoteId, input.reservationId],
          input.signal
        ),
        {
          expectedRevision: null,
          jobId: input.jobId,
          mode: "create",
          noteId: input.stableNoteId,
          ownerId: context.ownerId
        }
      );
    },
    async prepareAppend(input) {
      const context = jobs.get(input.jobId);
      if (context === undefined) reject();
      return appendPreparationResult(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.prepareAppend,
          [
            input.jobId,
            input.leaseToken,
            input.noteId,
            input.expectedRevision,
            input.reservationId
          ],
          input.signal
        ),
        {
          expectedRevision: input.expectedRevision,
          jobId: input.jobId,
          noteId: input.noteId,
          ownerId: context.ownerId
        }
      );
    },
    async commit(input) {
      if (!isAtomicOrganizerCommand(input.command)) reject();
      const raw = await execute(
        executor,
        ORGANIZER_RPC_SQL.commit,
        [input.jobId, input.leaseToken, jsonBounded(input.command)],
        input.signal
      );
      const root = record(raw);
      const conflictOutcome = root.outcome === "replan" || root.outcome === "review_required";
      const row = conflictOutcome
        ? exact(root, [
            "conflictReason",
            "jobId",
            "noteId",
            "outcome",
            "replanCount",
            "replayed",
            "revision"
          ])
        : exact(root, ["jobId", "noteId", "outcome", "replanCount", "replayed", "revision"]);
      const outcomes = ["appended", "created", "replan", "review", "review_required"] as const;
      if (
        row.jobId !== input.jobId ||
        !outcomes.includes(row.outcome as never) ||
        typeof row.replayed !== "boolean"
      )
        reject();
      const outcome = row.outcome as OrganizerCommitResult["outcome"];
      const noteId =
        row.noteId === null
          ? null
          : typeof row.noteId === "string" && isNoteId(row.noteId)
            ? row.noteId
            : reject();
      const revision = row.revision === null ? null : integer(row.revision, 1);
      const replanCount = integer(row.replanCount, 0, 1) as 0 | 1;
      if (outcome === "replan" || outcome === "review_required") {
        if (
          (row.conflictReason !== "candidate_eligibility" &&
            row.conflictReason !== "consent_controls" &&
            row.conflictReason !== "revision") ||
          replanCount !== 1
        )
          reject();
        if (
          (row.conflictReason === "revision" && (noteId === null || revision === null)) ||
          (row.conflictReason === "candidate_eligibility" && noteId === null)
        )
          reject();
        return Object.freeze({
          conflictReason: row.conflictReason,
          jobId: input.jobId,
          noteId,
          outcome,
          replayed: row.replayed,
          revision,
          replanCount: 1
        });
      }
      if (
        (outcome === "review" && (noteId !== null || revision !== null)) ||
        (outcome !== "review" && (noteId === null || revision === null))
      )
        reject();
      forget(input.jobId);
      return Object.freeze({
        jobId: input.jobId,
        noteId,
        outcome,
        replayed: row.replayed,
        revision,
        replanCount
      });
    },
    async fail(input) {
      const row = exact(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.fail,
          [input.jobId, input.leaseToken, input.errorCode, input.retryable],
          input.signal
        ),
        ["jobId", "replayed", "state"]
      );
      if (
        row.jobId !== input.jobId ||
        (row.state !== "awaiting_retry" && row.state !== "dead_letter" && row.state !== "failed") ||
        typeof row.replayed !== "boolean"
      )
        reject();
      forget(input.jobId);
      return Object.freeze({ state: row.state });
    }
  });
}

export function assertOrganizerSessionRows(rows: readonly unknown[]): void {
  if (rows.length !== 1) throw new OrganizerDatabaseContractError("identity_denied");
  const row = exact(rows[0], ["sessionUser", "currentUser"]);
  if (row.sessionUser !== EXPECTED_ROLE || row.currentUser !== EXPECTED_ROLE)
    throw new OrganizerDatabaseContractError("identity_denied");
}

export function isAtomicOrganizerCommand(value: unknown): value is AtomicOrganizerCommand {
  const row = record(value);
  const reviewReasons = [
    "explicit_destination_unavailable",
    "expansion_pending",
    "planner_ambiguity",
    "revision_conflict"
  ];
  return (
    Object.keys(row).sort().join(",") ===
      "decision,noteWrite,outcome,receipt,review,reviewReason" &&
    (row.outcome === "appended" || row.outcome === "created" || row.outcome === "review") &&
    (row.outcome === "review"
      ? reviewReasons.includes(row.reviewReason as never)
      : row.reviewReason === null) &&
    (() => {
      try {
        jsonBounded(value);
        return true;
      } catch {
        return false;
      }
    })()
  );
}
