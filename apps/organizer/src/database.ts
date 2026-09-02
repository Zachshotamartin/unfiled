import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import { parseManagedKeyRecord } from "@unfiled/key-management";
import type { PrivateRagGenerationSnapshot, PrivateRagPageReadResult } from "@unfiled/search";

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
  OrganizerRagRecord,
  OrganizerRagSelection,
  OrganizerRepository
} from "./drain.js";
import { OrganizerProviderError, OrganizerUnavailableError } from "./errors.js";
import type { LeaseBoundOrganizerProviderRoute } from "./provider-credential.js";
const EXPECTED_ROLE = "unfiled_organizer_worker";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENTITY_SUFFIX = "[0-9A-HJKMNP-TV-Z]{26}";
const JOB = new RegExp(`^job_${ENTITY_SUFFIX}$`, "u");
const CAPTURE = new RegExp(`^cap_${ENTITY_SUFFIX}$`, "u");
const NOTE = new RegExp(`^note_${ENTITY_SUFFIX}$`, "u");
const RULE = new RegExp(`^rule_${ENTITY_SUFFIX}$`, "u");
const INDEX = new RegExp(`^irw_${ENTITY_SUFFIX}$`, "u");
const GENERATION = new RegExp(`^igen_${ENTITY_SUFFIX}$`, "u");
const SPACE = new RegExp(`^spc_${ENTITY_SUFFIX}$`, "u");
const TAG = new RegExp(`^tag_${ENTITY_SUFFIX}$`, "u");
const DECISION = new RegExp(`^dec_${ENTITY_SUFFIX}$`, "u");
const BLOCK = new RegExp(`^blk_${ENTITY_SUFFIX}$`, "u");
const MUTATION = new RegExp(`^mut_${ENTITY_SUFFIX}$`, "u");
const REVIEW = new RegExp(`^rvw_${ENTITY_SUFFIX}$`, "u");
const REVISION = new RegExp(`^rev_${ENTITY_SUFFIX}$`, "u");
const NOTE_TYPES = ["generic", "list", "log", "principle", "project"] as const;
const TIMESTAMP =
  /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MODEL_ID = /^[\x21-\x7e]{1,200}$/u;
const ROUTING_MODEL_ID = /^[\x21-\x7e]{1,120}$/u;
const SOURCE_BYTE_BUDGET = 8_388_608;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const HEX_MAC = /^[0-9a-f]{64}$/u;

export const ORGANIZER_RPC_NAMES = Object.freeze([
  "claim_encrypted_organizer_jobs",
  "heartbeat_encrypted_organizer_job",
  "list_encrypted_organizer_candidates",
  "prepare_encrypted_organizer_create",
  "prepare_encrypted_organizer_append",
  "commit_encrypted_organizer_job",
  "fail_encrypted_organizer_job",
  "recover_stale_encrypted_organizer_jobs",
  "list_encrypted_organizer_rag_page",
  "select_encrypted_organizer_candidates",
  "get_lease_bound_organizer_provider_credential"
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
  ragPage:
    "select public.list_encrypted_organizer_rag_page($1::text, $2::text, $3::jsonb, $4::integer, $5::integer) as result",
  selectCandidates:
    "select public.select_encrypted_organizer_candidates($1::text, $2::text, $3::jsonb) as result",
  prepareCreate:
    "select public.prepare_encrypted_organizer_create($1::text, $2::text, $3::text, $4::text) as result",
  prepareAppend:
    "select public.prepare_encrypted_organizer_append($1::text, $2::text, $3::text, $4::bigint, $5::text) as result",
  commit: "select public.commit_encrypted_organizer_job($1::text, $2::text, $3::jsonb) as result",
  fail: "select public.fail_encrypted_organizer_job($1::text, $2::text, $3::text, $4::boolean, $5::text, $6::bigint) as result",
  providerRoute:
    "select public.get_lease_bound_organizer_provider_credential($1::text, $2::text) as result",
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
function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40) reject();
  const match = TIMESTAMP.exec(value);
  if (match === null) reject();
  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
    fraction,
    zone,
    sign,
    zoneHourValue,
    zoneMinuteValue
  ] = match;
  if (
    yearValue === undefined ||
    monthValue === undefined ||
    dayValue === undefined ||
    hourValue === undefined ||
    minuteValue === undefined ||
    secondValue === undefined ||
    zone === undefined
  )
    reject();

  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  )
    reject();

  let offsetMinutes = 0;
  if (zone !== "Z") {
    if (sign === undefined || zoneHourValue === undefined || zoneMinuteValue === undefined)
      reject();
    offsetMinutes =
      (Number(zoneHourValue) * 60 + Number(zoneMinuteValue)) * (sign === "+" ? 1 : -1);
  }
  const micros =
    BigInt(local.valueOf() - offsetMinutes * 60_000) * 1_000n +
    BigInt((fraction ?? "").padEnd(6, "0"));
  const wholeSeconds = micros >= 0n ? micros / 1_000_000n : (micros - 999_999n) / 1_000_000n;
  const fractionalMicros = micros - wholeSeconds * 1_000_000n;
  const milliseconds = wholeSeconds * 1_000n;
  if (
    milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    milliseconds < BigInt(Number.MIN_SAFE_INTEGER)
  )
    reject();
  const instant = new Date(Number(milliseconds));
  if (!Number.isFinite(instant.valueOf())) reject();
  const iso = instant.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(iso)) reject();
  const microsDigits = fractionalMicros.toString().padStart(6, "0");
  const canonicalFraction = `${microsDigits.slice(0, 3)}${microsDigits.slice(3).replace(/0+$/u, "")}`;
  return `${iso.slice(0, 19)}.${canonicalFraction}Z`;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !DATE.test(value)) reject();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) reject();
  return value;
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

function routingRuleMatch(value: unknown): ClaimedOrganizerJob["controls"]["ruleMatch"] {
  if (value === null) return null;
  const match = exact(value, [
    "destinationId",
    "destinationKind",
    "matched",
    "priority",
    "ruleId",
    "ruleRevision"
  ]);
  if (match.matched !== true) reject();
  const common = {
    matched: true as const,
    priority: integer(match.priority, 0, 10_000),
    ruleId: string(match.ruleId, RULE) as `rule_${string}`,
    ruleRevision: integer(match.ruleRevision, 1)
  };
  if (match.destinationKind === "note") {
    return Object.freeze({
      ...common,
      destinationId: string(match.destinationId, NOTE) as `note_${string}`,
      destinationKind: "note" as const
    });
  }
  if (match.destinationKind === "space") {
    return Object.freeze({
      ...common,
      destinationId: string(match.destinationId, SPACE) as `spc_${string}`,
      destinationKind: "space" as const
    });
  }
  return reject();
}

function captureControls(value: unknown): ClaimedOrganizerJob["controls"] {
  const controls = exact(value, ["expansionDisabled", "explicitDestinationNoteId", "ruleMatch"]);
  const explicitDestinationNoteId =
    controls.explicitDestinationNoteId === null
      ? null
      : (string(controls.explicitDestinationNoteId, NOTE) as `note_${string}`);
  if (typeof controls.expansionDisabled !== "boolean") reject();
  return Object.freeze({
    expansionDisabled: controls.expansionDisabled,
    explicitDestinationNoteId,
    ruleMatch: routingRuleMatch(controls.ruleMatch)
  });
}

function sameCaptureControls(
  left: ClaimedOrganizerJob["controls"],
  right: ClaimedOrganizerJob["controls"]
): boolean {
  const leftRule = left.ruleMatch;
  const rightRule = right.ruleMatch;
  return (
    left.expansionDisabled === right.expansionDisabled &&
    left.explicitDestinationNoteId === right.explicitDestinationNoteId &&
    (leftRule === null || rightRule === null
      ? leftRule === rightRule
      : leftRule.ruleId === rightRule.ruleId &&
        leftRule.ruleRevision === rightRule.ruleRevision &&
        leftRule.destinationKind === rightRule.destinationKind &&
        leftRule.destinationId === rightRule.destinationId &&
        leftRule.priority === rightRule.priority)
  );
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
    kind: "capture" | "note_content" | "note_rag_index";
  }>
): ParsedProjection {
  const row = exact(
    value,
    expected.kind === "capture"
      ? [
          "resourceId",
          "recordVersion",
          "envelope",
          "keyRecord",
          "contentMac",
          "contentMacKeyRecord",
          "encryptedByteLength"
        ]
      : ["resourceId", "recordVersion", "envelope", "keyRecord", "encryptedByteLength"]
  );
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
  const base = {
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
  };
  if (expected.kind !== "capture") return Object.freeze(base);

  const contentMac = exact(row.contentMac, [
    "mac",
    "keyId",
    "keyClass",
    "keyPurpose",
    "keyVersion"
  ]);
  let contentMacKey;
  try {
    contentMacKey = parseManagedKeyRecord(row.contentMacKeyRecord);
  } catch {
    return reject();
  }
  if (
    typeof contentMac.mac !== "string" ||
    !HEX_MAC.test(contentMac.mac) ||
    contentMac.keyId !== contentMacKey.keyId ||
    contentMac.keyClass !== "ai_assisted" ||
    contentMac.keyPurpose !== "content_mac" ||
    contentMac.keyVersion !== contentMacKey.keyVersion ||
    contentMacKey.ownerId !== expected.ownerId ||
    contentMacKey.keyClass !== "ai_assisted" ||
    contentMacKey.purpose !== "content_mac" ||
    (contentMacKey.status !== "active" && contentMacKey.status !== "retired")
  )
    reject();
  return Object.freeze({
    ...base,
    contentMac: Object.freeze({
      value: contentMac.mac,
      keyId: contentMacKey.keyId,
      keyClass: "ai_assisted" as const,
      keyPurpose: "content_mac" as const,
      keyVersion: contentMacKey.keyVersion
    }),
    contentMacKey
  });
}

function claimResult(value: unknown, limit: number): readonly ClaimedOrganizerJob[] {
  const root = exact(value, ["jobs", "sourceEnvelopeBytes", "sourceEnvelopeByteBudget"]);
  if (!Array.isArray(root.jobs) || root.jobs.length > limit) reject();
  const ids = new Set<string>();
  const jobs = root.jobs.map(
    (entry): ClaimedOrganizerJob & Readonly<{ source: ParsedProjection }> => {
      const row = exact(entry, [
        "accountCaptureOrdinal",
        "attempt",
        "captureId",
        "clientTimezone",
        "controls",
        "jobId",
        "leaseExpiresAt",
        "leaseToken",
        "modelId",
        "occurredAt",
        "ownerId",
        "promptVersion",
        "replanCount",
        "routingEffort",
        "routingMode",
        "schemaVersion",
        "source",
        "expansionStyle",
        "commandProjection"
      ]);
      const jobId = string(row.jobId, JOB);
      const captureId = string(row.captureId, CAPTURE) as `cap_${string}`;
      const ownerId = string(row.ownerId, UUID);
      const attempt = integer(row.attempt, 1, 100);
      const replanCount = integer(row.replanCount, 0, 1) as 0 | 1;
      if (ids.has(jobId)) reject();
      ids.add(jobId);
      const promptVersion = string(row.promptVersion, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u);
      const modelId = string(row.modelId, ROUTING_MODEL_ID);
      const schemaVersion = integer(row.schemaVersion, 1, 2_147_483_647);
      if (
        typeof row.clientTimezone !== "string" ||
        !/^[A-Za-z_+-][A-Za-z0-9_+./:-]{0,99}$/u.test(row.clientTimezone) ||
        (row.routingMode !== "cautious" &&
          row.routingMode !== "balanced" &&
          row.routingMode !== "automatic") ||
        (row.routingEffort !== "economical" &&
          row.routingEffort !== "standard" &&
          row.routingEffort !== "thorough") ||
        (row.expansionStyle !== "off" &&
          row.expansionStyle !== "brief" &&
          row.expansionStyle !== "detailed")
      )
        reject();
      if (row.commandProjection !== "legacy" && row.commandProjection !== "encrypted_only")
        reject();
      const controls = captureControls(row.controls);
      return Object.freeze({
        accountCaptureOrdinal: integer(row.accountCaptureOrdinal, 1),
        attempt,
        captureId,
        clientTimezone: row.clientTimezone,
        controls,
        jobId,
        leaseExpiresAt: timestamp(row.leaseExpiresAt),
        leaseToken: string(row.leaseToken, UUID),
        modelId,
        occurredAt: timestamp(row.occurredAt),
        ownerId,
        promptVersion,
        replanCount,
        routingEffort: row.routingEffort,
        routingMode: row.routingMode,
        schemaVersion,
        source: projection(row.source, {
          kind: "capture",
          ownerId,
          recordVersion: 1,
          resourceId: captureId
        }),
        expansionStyle: row.expansionStyle,
        commandProjection: row.commandProjection
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

function providerRoute(value: unknown): LeaseBoundOrganizerProviderRoute {
  const row = exact(value, [
    "credential",
    "credentialRevision",
    "expansionStyle",
    "provider",
    "routingEffort",
    "source"
  ]);
  if (
    row.provider !== "openai" ||
    (row.source !== "app_default" && row.source !== "byok") ||
    (row.routingEffort !== "economical" &&
      row.routingEffort !== "standard" &&
      row.routingEffort !== "thorough") ||
    (row.expansionStyle !== "off" &&
      row.expansionStyle !== "brief" &&
      row.expansionStyle !== "detailed")
  )
    reject();
  const credentialRevision =
    row.credentialRevision === null ? null : integer(row.credentialRevision, 1);
  if (row.source === "app_default") {
    if (row.credential !== null || credentialRevision !== null) reject();
  } else if (
    typeof row.credential !== "string" ||
    row.credential.length < 20 ||
    row.credential.length > 500 ||
    row.credential.trim() !== row.credential ||
    credentialRevision === null
  ) {
    reject();
  } else {
    for (let index = 0; index < row.credential.length; index += 1) {
      const codeUnit = row.credential.charCodeAt(index);
      if (codeUnit <= 0x20 || codeUnit === 0x7f) reject();
    }
  }
  return Object.freeze({
    credential: row.credential,
    credentialRevision,
    expansionStyle: row.expansionStyle,
    provider: "openai",
    routingEffort: row.routingEffort,
    source: row.source
  });
}

function candidateEntries(
  value: unknown,
  input: Readonly<{ limit: number; ownerId: string }>
): readonly EncryptedCandidate[] {
  if (!Array.isArray(value) || value.length > input.limit) reject();
  const ids = new Set<string>();
  return Object.freeze(
    value.map((entry): EncryptedCandidate & Readonly<{ source: ParsedProjection }> => {
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
      const metadata = exact(row.metadata, [
        "archivedAt",
        "dailyDate",
        "deletedAt",
        "isOpen",
        "links",
        "pinnedAt",
        "spaceId",
        "tagIds",
        "updatedAt"
      ]);
      if (
        !isNoteId(noteIdValue) ||
        !isNoteId(candidateIdValue) ||
        candidateIdValue !== noteIdValue ||
        ids.has(candidateIdValue) ||
        !NOTE_TYPES.includes(row.type as never) ||
        typeof metadata.isOpen !== "boolean" ||
        (metadata.spaceId !== null &&
          (typeof metadata.spaceId !== "string" || !SPACE.test(metadata.spaceId))) ||
        metadata.archivedAt !== null ||
        metadata.deletedAt !== null ||
        !Array.isArray(metadata.tagIds) ||
        metadata.tagIds.length > 100 ||
        !Array.isArray(metadata.links) ||
        metadata.links.length > 100
      )
        reject();
      ids.add(candidateIdValue);
      const tagIds = metadata.tagIds.map((tagId) => string(tagId, TAG) as `tag_${string}`);
      if (new Set(tagIds).size !== tagIds.length) reject();
      const linkIdentities = new Set<string>();
      const links = metadata.links.map((link) => {
        const parsed = exact(link, ["linkType", "toNoteId"]);
        const toNoteId = string(parsed.toNoteId, NOTE) as `note_${string}`;
        if (
          toNoteId === noteIdValue ||
          (parsed.linkType !== "reference" && parsed.linkType !== "related")
        )
          reject();
        const identity = `${toNoteId}:${parsed.linkType}`;
        if (linkIdentities.has(identity)) reject();
        linkIdentities.add(identity);
        return Object.freeze({ linkType: parsed.linkType, toNoteId });
      });
      const revision = integer(row.revision, 1);
      return Object.freeze({
        archivedAt: null,
        candidateId: candidateIdValue,
        dailyDate: nullableDate(metadata.dailyDate),
        deletedAt: null,
        isOpen: metadata.isOpen,
        links: Object.freeze(links),
        noteId: noteIdValue,
        noteType: row.type as EncryptedCandidate["noteType"],
        pinnedAt: nullableTimestamp(metadata.pinnedAt),
        revision,
        spaceId: metadata.spaceId as `spc_${string}` | null,
        source: projection(row.aggregate, {
          kind: "note_content",
          ownerId: input.ownerId,
          recordVersion: revision,
          resourceId: noteIdValue
        }),
        tagIds: Object.freeze(tagIds),
        updatedAt: timestamp(metadata.updatedAt)
      });
    })
  );
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
  if (root.jobId !== input.jobId) reject();
  const candidates = candidateEntries(root.candidates, { limit: input.limit, ownerId });
  const encryptedByteBudget = integer(root.encryptedByteBudget, 1, SOURCE_BYTE_BUDGET);
  const encryptedBytes = integer(root.encryptedBytes, 0, encryptedByteBudget);
  const canonicalEnvelopeBytes = candidates.reduce(
    (sum, candidate) => sum + (candidate.source as ParsedProjection).serializedEnvelopeBytes,
    0
  );
  if (root.returnedCount !== candidates.length || encryptedBytes < canonicalEnvelopeBytes) reject();
  return Object.freeze({
    candidates,
    controls: captureControls(root.controls)
  });
}

function selectedCandidateResult(
  value: unknown,
  input: Readonly<{
    jobId: string;
    ownerId: string;
    selection: OrganizerRagSelection;
  }>
): OrganizerCandidatePage & Readonly<{ snapshot: PrivateRagGenerationSnapshot }> {
  const root = exact(value, [
    "candidates",
    "controls",
    "encryptedByteBudget",
    "encryptedBytes",
    "generationId",
    "jobId",
    "returnedCount",
    "revisionToken"
  ]);
  const snapshot = input.selection.snapshot;
  if (
    root.jobId !== input.jobId ||
    root.generationId !== snapshot.generationId ||
    String(integer(root.revisionToken, 0)) !== snapshot.revisionToken
  )
    reject();
  const candidates = candidateEntries(root.candidates, {
    limit: input.selection.candidates.length,
    ownerId: input.ownerId
  });
  const encryptedByteBudget = integer(root.encryptedByteBudget, 1, SOURCE_BYTE_BUDGET);
  const encryptedBytes = integer(root.encryptedBytes, 0, encryptedByteBudget);
  const canonicalEnvelopeBytes = candidates.reduce(
    (sum, candidate) => sum + (candidate.source as ParsedProjection).serializedEnvelopeBytes,
    0
  );
  if (
    root.returnedCount !== candidates.length ||
    candidates.length !== input.selection.candidates.length ||
    encryptedBytes < canonicalEnvelopeBytes ||
    candidates.some((candidate, index) => {
      const selected = input.selection.candidates[index];
      return (
        candidate.noteId !== selected?.noteId || candidate.revision !== selected.indexedRevision
      );
    })
  )
    reject();
  return Object.freeze({
    candidates,
    controls: captureControls(root.controls),
    snapshot
  });
}

type RagCursor = Readonly<{
  afterIndexId: string;
  generationId: string;
  revisionToken: number;
}>;

function ragCursor(value: string | null): RagCursor | null {
  if (value === null) return null;
  if (new TextEncoder().encode(value).byteLength > 4_096) reject();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return reject();
  }
  const row = exact(parsed, ["afterIndexId", "generationId", "revisionToken"]);
  return Object.freeze({
    afterIndexId: string(row.afterIndexId, INDEX),
    generationId: string(row.generationId, GENERATION),
    revisionToken: integer(row.revisionToken, 0)
  });
}

function ragSnapshot(
  value: unknown,
  coverage: Readonly<Record<string, unknown>>
): PrivateRagGenerationSnapshot {
  const row = exact(value, [
    "embeddingDimensions",
    "embeddingModelId",
    "envelopeSchemaVersion",
    "generationId",
    "revisionToken"
  ]);
  if (
    typeof row.embeddingModelId !== "string" ||
    !MODEL_ID.test(row.embeddingModelId) ||
    row.envelopeSchemaVersion !== 1
  )
    reject();
  return Object.freeze({
    generationId: string(row.generationId, GENERATION),
    modelId: row.embeddingModelId,
    dimensions: integer(row.embeddingDimensions, 1, 4_096),
    revisionToken: String(integer(row.revisionToken, 0)),
    expectedNoteCount: integer(coverage.expectedNoteCount, 0),
    indexedNoteCount: integer(coverage.indexedNoteCount, 0)
  });
}

function ragPageResult(
  value: unknown,
  input: Readonly<{
    cursor: string | null;
    jobId: string;
    limit: number;
    maxBytes: number;
    ownerId: string;
  }>
): PrivateRagPageReadResult<OrganizerRagRecord> {
  const wrapper = exact(value, ["jobId", "result"]);
  if (wrapper.jobId !== input.jobId) reject();
  const root = exact(wrapper.result, [
    "coverage",
    "generation",
    "items",
    "keys",
    "ownerId",
    "page"
  ]);
  if (
    root.ownerId !== input.ownerId ||
    !Array.isArray(root.items) ||
    root.items.length > input.limit ||
    !Array.isArray(root.keys)
  )
    reject();
  const coverageRow = exact(root.coverage, [
    "complete",
    "coveredNoteCount",
    "eligibleNoteCount",
    "expectedNoteCount",
    "indexedNoteCount",
    "pendingJobCount",
    "repairCandidates",
    "repairCount",
    "repairLimitExceeded",
    "verified"
  ]);
  if (
    !Array.isArray(coverageRow.repairCandidates) ||
    coverageRow.repairCandidates.length > 50 ||
    typeof coverageRow.repairLimitExceeded !== "boolean" ||
    typeof coverageRow.verified !== "boolean" ||
    typeof coverageRow.complete !== "boolean"
  )
    reject();
  const repairCount = integer(coverageRow.repairCount, 0, 51);
  const repairCandidates = coverageRow.repairCandidates.map((candidate) => {
    const row = exact(candidate, ["currentRevision", "noteId", "updatedAt"]);
    timestamp(row.updatedAt);
    return Object.freeze({
      currentRevision: integer(row.currentRevision, 1),
      noteId: string(row.noteId, NOTE)
    });
  });
  const expectedNoteCount = integer(coverageRow.expectedNoteCount, 0);
  const indexedNoteCount = integer(coverageRow.indexedNoteCount, 0);
  const eligibleNoteCount = integer(coverageRow.eligibleNoteCount, 0);
  const coveredNoteCount = integer(coverageRow.coveredNoteCount, 0);
  const pendingJobCount = integer(coverageRow.pendingJobCount, 0);
  if (
    indexedNoteCount > expectedNoteCount ||
    coveredNoteCount > eligibleNoteCount ||
    repairCandidates.length !== Math.min(repairCount, 50) ||
    coverageRow.repairLimitExceeded !== (repairCount === 51) ||
    (coverageRow.complete &&
      (!coverageRow.verified ||
        repairCount !== 0 ||
        pendingJobCount !== 0 ||
        expectedNoteCount !== eligibleNoteCount ||
        indexedNoteCount !== eligibleNoteCount ||
        coveredNoteCount !== eligibleNoteCount))
  )
    reject();
  if (root.generation === null) {
    if (
      root.items.length !== 0 ||
      root.keys.length !== 0 ||
      expectedNoteCount !== 0 ||
      indexedNoteCount !== 0
    )
      reject();
    return Object.freeze({ status: "no_active_generation" as const });
  }
  const snapshot = ragSnapshot(root.generation, coverageRow);
  const keyById = new Map<string, ReturnType<typeof parseManagedKeyRecord>>();
  for (const unknownKey of root.keys) {
    let key;
    try {
      key = parseManagedKeyRecord(unknownKey);
    } catch {
      return reject();
    }
    const identity = `${key.keyId}:${key.keyVersion}`;
    if (
      keyById.has(identity) ||
      key.ownerId !== input.ownerId ||
      key.keyClass !== "ai_assisted" ||
      key.purpose !== "object_wrap" ||
      (key.status !== "active" && key.status !== "retired")
    )
      reject();
    keyById.set(identity, key);
  }
  const itemIds = new Set<string>();
  const referencedKeys = new Set<string>();
  const items = root.items.map((unknownItem) => {
    const row = exact(unknownItem, [
      "cipher",
      "encryptedByteLength",
      "indexId",
      "indexedRevision",
      "noteId"
    ]);
    const indexId = string(row.indexId, INDEX);
    const noteId = string(row.noteId, NOTE);
    const indexedRevision = integer(row.indexedRevision, 1);
    const cipher = exact(row.cipher, ["envelope", "keyClass", "keyId", "keyPurpose", "keyVersion"]);
    if (
      itemIds.has(indexId) ||
      cipher.keyClass !== "ai_assisted" ||
      cipher.keyPurpose !== "object_wrap" ||
      typeof cipher.keyId !== "string"
    )
      reject();
    const keyIdentity = `${cipher.keyId}:${integer(cipher.keyVersion, 1, 2_147_483_647)}`;
    const key = keyById.get(keyIdentity);
    if (key === undefined) reject();
    itemIds.add(indexId);
    referencedKeys.add(keyIdentity);
    const encryptedByteLength = integer(row.encryptedByteLength, 16, 262_160);
    const record = projection(
      {
        encryptedByteLength,
        envelope: cipher.envelope,
        keyRecord: key,
        recordVersion: indexedRevision,
        resourceId: indexId
      },
      {
        kind: "note_rag_index",
        ownerId: input.ownerId,
        recordVersion: indexedRevision,
        resourceId: indexId
      }
    );
    return Object.freeze({
      ciphertextBytes: encryptedByteLength,
      indexId,
      indexedRevision,
      noteId,
      record
    });
  });
  if (referencedKeys.size !== keyById.size) reject();
  const pageRow = exact(root.page, [
    "ciphertextByteBudget",
    "ciphertextBytes",
    "hasMore",
    "limit",
    "nextCursor",
    "returnedCount"
  ]);
  if (
    pageRow.limit !== input.limit ||
    pageRow.ciphertextByteBudget !== input.maxBytes ||
    pageRow.returnedCount !== items.length ||
    pageRow.ciphertextBytes !== items.reduce((sum, item) => sum + item.ciphertextBytes, 0) ||
    typeof pageRow.hasMore !== "boolean"
  )
    reject();
  const next = pageRow.nextCursor === null ? null : ragCursor(JSON.stringify(pageRow.nextCursor));
  if (pageRow.hasMore !== (next !== null)) reject();
  const last = items.at(-1);
  if (
    next !== null &&
    (last === undefined ||
      next.generationId !== snapshot.generationId ||
      String(next.revisionToken) !== snapshot.revisionToken ||
      next.afterIndexId !== last.indexId)
  )
    reject();
  const supplied = ragCursor(input.cursor);
  if (
    supplied !== null &&
    (supplied.generationId !== snapshot.generationId ||
      String(supplied.revisionToken) !== snapshot.revisionToken)
  )
    reject();
  const missingOrStaleCount = repairCount;
  return Object.freeze({
    status: "page" as const,
    page: Object.freeze({
      coverage: Object.freeze({
        missingOrStaleCount,
        repairCandidates: Object.freeze(repairCandidates),
        repairOverflow: coverageRow.repairLimitExceeded,
        status: coverageRow.complete ? ("complete" as const) : ("incomplete" as const)
      }),
      items: Object.freeze(items),
      nextCursor: next === null ? null : JSON.stringify(next),
      snapshot
    })
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
  const ids = exact(row.ids, [
    "decisionId",
    "generatedBlockId",
    "mutationId",
    "reviewItemId",
    "revisionId"
  ]);
  const parsedIds = Object.freeze({
    decisionId: string(ids.decisionId, DECISION) as `dec_${string}`,
    generatedBlockId: string(ids.generatedBlockId, BLOCK) as `blk_${string}`,
    mutationId: string(ids.mutationId, MUTATION) as `mut_${string}`,
    reviewItemId: string(ids.reviewItemId, REVIEW) as `rvw_${string}`,
    revisionId: string(ids.revisionId, REVISION) as `rev_${string}`
  });
  const reservations = exact(row.reservations, [
    "decision",
    "generatedBlock",
    "noteWrite",
    "receipt",
    "review"
  ]);
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
    generatedBlock: reservation(reservations.generatedBlock, 1),
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
  const controls = captureControls(root.controls);
  if (
    !sameCaptureControls(controls, expectedControls) ||
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
      row.candidateCount !== expected.candidateCount
    )
      reject();
    const currentRevision = row.currentRevision === null ? null : integer(row.currentRevision, 1);
    return Object.freeze({
      candidateCount: expected.candidateCount,
      currentRevision,
      disclosureAuthorized: true,
      jobId: expected.jobId,
      leaseExpiresAt: timestamp(row.leaseExpiresAt),
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
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? (error as Readonly<{ message?: unknown }>).message
      : undefined;
  if (code === "P0001" && message === "provider_key_invalid")
    throw new OrganizerProviderError("provider_key_invalid", false);
  if (code === "P0001" && message === "provider_unavailable")
    throw new OrganizerProviderError("provider_unavailable", true);
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
    async providerRoute(input) {
      const context = jobs.get(input.jobId);
      if (context === undefined) reject();
      return providerRoute(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.providerRoute,
          [input.jobId, input.leaseToken],
          input.signal
        )
      );
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
    async ragPage(input) {
      integer(input.limit, 1, 50);
      integer(input.maxBytes, 262_160, SOURCE_BYTE_BUDGET);
      const context = jobs.get(input.jobId);
      if (context === undefined) reject();
      const cursor = ragCursor(input.cursor);
      return ragPageResult(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.ragPage,
          [input.jobId, input.leaseToken, cursor, input.limit, input.maxBytes],
          input.signal
        ),
        {
          cursor: input.cursor,
          jobId: input.jobId,
          limit: input.limit,
          maxBytes: input.maxBytes,
          ownerId: context.ownerId
        }
      );
    },
    async selectCandidates(input) {
      const context = jobs.get(input.jobId);
      if (context === undefined) reject();
      const selection = exact(input.selection, ["candidates", "snapshot"]);
      const snapshot = exact(selection.snapshot, [
        "dimensions",
        "expectedNoteCount",
        "generationId",
        "indexedNoteCount",
        "modelId",
        "revisionToken"
      ]);
      string(snapshot.generationId, GENERATION);
      if (typeof snapshot.modelId !== "string" || !MODEL_ID.test(snapshot.modelId)) reject();
      integer(snapshot.dimensions, 1, 4_096);
      integer(snapshot.expectedNoteCount, 0);
      integer(snapshot.indexedNoteCount, 0);
      if (
        typeof snapshot.revisionToken !== "string" ||
        !/^(?:0|[1-9][0-9]{0,15})$/u.test(snapshot.revisionToken)
      )
        reject();
      const revisionToken = Number(snapshot.revisionToken);
      integer(revisionToken, 0);
      if (
        !Array.isArray(selection.candidates) ||
        selection.candidates.length < 1 ||
        selection.candidates.length > 8
      )
        reject();
      const seen = new Set<string>();
      const candidates = selection.candidates.map((entry) => {
        const row = exact(entry, ["indexedRevision", "noteId"]);
        const noteId = string(row.noteId, NOTE) as `note_${string}`;
        if (seen.has(noteId)) reject();
        seen.add(noteId);
        return Object.freeze({
          indexedRevision: integer(row.indexedRevision, 1),
          noteId
        });
      });
      const normalizedSelection: OrganizerRagSelection = Object.freeze({
        candidates: Object.freeze(candidates),
        snapshot: Object.freeze({
          dimensions: Number(snapshot.dimensions),
          expectedNoteCount: Number(snapshot.expectedNoteCount),
          generationId: String(snapshot.generationId),
          indexedNoteCount: Number(snapshot.indexedNoteCount),
          modelId: snapshot.modelId,
          revisionToken: snapshot.revisionToken
        })
      });
      const page = selectedCandidateResult(
        await execute(
          executor,
          ORGANIZER_RPC_SQL.selectCandidates,
          [
            input.jobId,
            input.leaseToken,
            jsonBounded({
              candidates,
              generationId: snapshot.generationId,
              revisionToken
            })
          ],
          input.signal
        ),
        { jobId: input.jobId, ownerId: context.ownerId, selection: normalizedSelection }
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
          [
            input.jobId,
            input.leaseToken,
            input.errorCode,
            input.retryable,
            input.providerSource,
            input.providerCredentialRevision
          ],
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
    "duplicate_suggestion",
    "explicit_destination_unavailable",
    "expansion_pending",
    "planner_ambiguity",
    "revision_conflict"
  ];
  return (
    Object.keys(row).sort().join(",") ===
      "decision,generatedBlock,noteWrite,outcome,receipt,review,reviewReason" &&
    (row.outcome === "appended" || row.outcome === "created" || row.outcome === "review") &&
    (row.outcome === "review"
      ? reviewReasons.includes(row.reviewReason as never) &&
        row.generatedBlock === null &&
        row.noteWrite === null &&
        row.review !== null
      : row.reviewReason === "expansion_pending"
        ? row.generatedBlock !== null && row.noteWrite !== null && row.review !== null
        : row.reviewReason === null &&
          row.generatedBlock === null &&
          row.noteWrite !== null &&
          row.review === null) &&
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
