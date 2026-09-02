import { parseContentEnvelope, serializeContentEnvelope } from "@unfiled/content-crypto";
import {
  EncryptedUserSearchFilterManifestSchema,
  RAG_GENERATION_VERIFICATION_NOTE_CAPACITY,
  type EncryptedUserSearchFilterManifest
} from "@unfiled/contracts";
import {
  parseManagedKeyRecordV1,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser
} from "@unfiled/key-management";
import type { PrivateRagGenerationSnapshot, PrivateRagPageReadResult } from "@unfiled/search";

import { SEARCH_EMBEDDING_DIMENSIONS, SEARCH_EMBEDDING_MODEL_ID } from "./config.js";

const EXPECTED_ROLE = "unfiled_search_worker";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEASE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ENTITY_SUFFIX = "[0-9A-HJKMNP-TV-Z]{26}";
const NOTE = new RegExp(`^note_${ENTITY_SUFFIX}$`, "u");
const INDEX = new RegExp(`^irw_${ENTITY_SUFFIX}$`, "u");
const GENERATION = new RegExp(`^igen_${ENTITY_SUFFIX}$`, "u");
const SPACE = new RegExp(`^spc_${ENTITY_SUFFIX}$`, "u");
const TAG = new RegExp(`^tag_${ENTITY_SUFFIX}$`, "u");
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NOTE_TYPES = new Set(["generic", "list", "log", "principle", "project"]);
const MAX_CURSOR_BYTES = 4_096;

export const SEARCH_RPC_NAMES = Object.freeze([
  "claim_encrypted_user_search",
  "list_encrypted_user_search_rag_page",
  "verify_encrypted_user_search_snapshot",
  "complete_encrypted_user_search",
  "fail_encrypted_user_search"
] as const);

export const SEARCH_IDENTITY_SQL =
  'select session_user::text as "sessionUser", current_user::text as "currentUser"';
export const SEARCH_RPC_SQL = Object.freeze({
  claim: "select public.claim_encrypted_user_search($1::uuid, $2::text, $3::text) as result",
  page: "select public.list_encrypted_user_search_rag_page($1::uuid, $2::text, $3::text, $4::jsonb, $5::jsonb, $6::integer, $7::integer) as result",
  verify:
    "select public.verify_encrypted_user_search_snapshot($1::uuid, $2::text, $3::text, $4::jsonb, $5::jsonb) as result",
  complete: "select public.complete_encrypted_user_search($1::uuid, $2::text, $3::text) as result",
  fail: "select public.fail_encrypted_user_search($1::uuid, $2::text, $3::text, $4::public.safe_error_code) as result"
});

export type SearchDatabaseQuery = Readonly<{
  signal: AbortSignal;
  text: string;
  values: readonly unknown[];
}>;
export type SearchDatabaseExecutor = Readonly<{
  query(query: SearchDatabaseQuery): Promise<Readonly<{ rows: readonly unknown[] }>>;
}>;

export class SearchDatabaseContractError extends Error {
  public readonly code: "contract_violation" | "identity_denied";

  public constructor(code: "contract_violation" | "identity_denied") {
    super(
      code === "identity_denied"
        ? "Search database identity was denied"
        : "Search database contract was rejected"
    );
    this.name = "SearchDatabaseContractError";
    this.code = code;
  }
}

export type SearchGenerationBinding = Readonly<{
  generationId: string;
  revisionToken: string;
  attestationDigest: string;
  embeddingModelId: string;
  embeddingDimensions: number;
  envelopeSchemaVersion: 1;
}>;

export type ClaimedEncryptedUserSearch = Readonly<{
  searchId: string;
  ownerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  requestDigest: string;
  filterDigest: string;
  generation: SearchGenerationBinding;
}>;

export type SearchRagMetadata = Readonly<{
  type: "generic" | "list" | "log" | "principle" | "project";
  spaceId: string | null;
  updatedAt: string;
  pinnedAt: string | null;
  archivedAt: string | null;
  tagIds: readonly string[];
}>;

export type SearchRagRecord = Readonly<{
  resourceId: string;
  recordVersion: number;
  cipher: Readonly<{
    envelope: ReturnType<typeof parseContentEnvelope>;
    keyClass: "ai_assisted";
    keyId: string;
    keyPurpose: "object_wrap";
    keyVersion: number;
  }>;
  key: ManagedKeyRecord;
  encryptedByteLength: number;
  metadata: SearchRagMetadata;
}>;

export type SearchCandidateBinding = Readonly<{
  indexId: string;
  noteId: string;
  indexedRevision: number;
}>;

export type SearchFailureCode = "provider_unavailable" | "rate_limited" | "validation_failed";

export type EncryptedUserSearchRepository = Readonly<{
  claim(
    input: Readonly<{
      searchId: string;
      claimSecret: string;
      requestDigest: string;
      signal: AbortSignal;
    }>
  ): Promise<ClaimedEncryptedUserSearch>;
  page(
    input: Readonly<{
      claim: ClaimedEncryptedUserSearch;
      filterManifest: EncryptedUserSearchFilterManifest;
      cursor: string | null;
      limit: number;
      maxBytes: number;
      signal: AbortSignal;
    }>
  ): Promise<PrivateRagPageReadResult<SearchRagRecord>>;
  verify(
    input: Readonly<{
      claim: ClaimedEncryptedUserSearch;
      filterManifest: EncryptedUserSearchFilterManifest;
      candidates: readonly SearchCandidateBinding[];
      signal: AbortSignal;
    }>
  ): Promise<Readonly<{ candidateDigest: string; verifiedCandidateCount: number }>>;
  complete(
    input: Readonly<{
      claim: ClaimedEncryptedUserSearch;
      candidateDigest: string;
      signal: AbortSignal;
    }>
  ): Promise<void>;
  fail(
    input: Readonly<{
      claim: ClaimedEncryptedUserSearch;
      failureCode: SearchFailureCode;
      signal: AbortSignal;
    }>
  ): Promise<void>;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;

function reject(): never {
  throw new SearchDatabaseContractError("contract_violation");
}

function record(value: unknown): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return reject();
  return value as UnknownRecord;
}

function exact(value: unknown, keys: readonly string[]): UnknownRecord {
  const row = record(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return reject();
  }
  return row;
}

function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return reject();
  return value;
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return reject();
  }
  return Number(value);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    return reject();
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function oneResult(rows: readonly unknown[]): unknown {
  if (rows.length !== 1) return reject();
  return exact(rows[0], ["result"]).result;
}

function decodedBytes(value: unknown): number {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1)
    return reject();
  const bytes = Buffer.from(value, "base64url");
  const canonical = bytes.toString("base64url");
  const length = bytes.byteLength;
  bytes.fill(0);
  if (canonical !== value) return reject();
  return length;
}

type SearchEmbeddingProfile = Readonly<{ dimensions: number; modelId: string }>;

const DEFAULT_SEARCH_EMBEDDING_PROFILE: SearchEmbeddingProfile = Object.freeze({
  dimensions: SEARCH_EMBEDDING_DIMENSIONS,
  modelId: SEARCH_EMBEDDING_MODEL_ID
});

function generation(
  value: unknown,
  expectedProfile: SearchEmbeddingProfile
): SearchGenerationBinding {
  const row = exact(value, [
    "embeddingDimensions",
    "embeddingModelId",
    "envelopeSchemaVersion",
    "generationId",
    "attestationDigest",
    "revisionToken"
  ]);
  if (
    row.embeddingModelId !== expectedProfile.modelId ||
    row.embeddingDimensions !== expectedProfile.dimensions ||
    row.envelopeSchemaVersion !== 1
  ) {
    return reject();
  }
  return Object.freeze({
    generationId: string(row.generationId, GENERATION),
    revisionToken: String(integer(row.revisionToken, 0)),
    attestationDigest: string(row.attestationDigest, DIGEST),
    embeddingModelId: expectedProfile.modelId,
    embeddingDimensions: expectedProfile.dimensions,
    envelopeSchemaVersion: 1
  });
}

function sameGeneration(left: SearchGenerationBinding, right: SearchGenerationBinding): boolean {
  return (
    left.generationId === right.generationId &&
    left.revisionToken === right.revisionToken &&
    left.attestationDigest === right.attestationDigest
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function claimed(
  value: unknown,
  expected: Readonly<{ searchId: string; requestDigest: string }>,
  expectedProfile: SearchEmbeddingProfile
): ClaimedEncryptedUserSearch {
  const row = exact(value, [
    "filterDigest",
    "generation",
    "leaseExpiresAt",
    "leaseToken",
    "ownerId",
    "requestDigest",
    "searchId"
  ]);
  const searchId = string(row.searchId, UUID).toLowerCase();
  const requestDigest = string(row.requestDigest, DIGEST);
  if (searchId !== expected.searchId || requestDigest !== expected.requestDigest) return reject();
  return Object.freeze({
    searchId,
    ownerId: string(row.ownerId, UUID).toLowerCase(),
    leaseToken: string(row.leaseToken, LEASE_TOKEN),
    leaseExpiresAt: timestamp(row.leaseExpiresAt),
    requestDigest,
    filterDigest: string(row.filterDigest, DIGEST),
    generation: generation(row.generation, expectedProfile)
  });
}

type SearchCursor = Readonly<{
  searchId: string;
  requestDigest: string;
  generationId: string;
  generationRevisionToken: number;
  afterIndexId: string;
}>;

function searchCursor(value: unknown, expected: ClaimedEncryptedUserSearch): SearchCursor {
  const row = exact(value, [
    "afterIndexId",
    "generationId",
    "generationRevisionToken",
    "requestDigest",
    "searchId"
  ]);
  const parsed = Object.freeze({
    searchId: string(row.searchId, UUID).toLowerCase(),
    requestDigest: string(row.requestDigest, DIGEST),
    generationId: string(row.generationId, GENERATION),
    generationRevisionToken: integer(row.generationRevisionToken, 0),
    afterIndexId: string(row.afterIndexId, INDEX)
  });
  if (
    parsed.searchId !== expected.searchId ||
    parsed.requestDigest !== expected.requestDigest ||
    parsed.generationId !== expected.generation.generationId ||
    String(parsed.generationRevisionToken) !== expected.generation.revisionToken
  ) {
    return reject();
  }
  return parsed;
}

function decodeCursor(
  value: string | null,
  expected: ClaimedEncryptedUserSearch
): SearchCursor | null {
  if (value === null) return null;
  if (new TextEncoder().encode(value).byteLength > MAX_CURSOR_BYTES) return reject();
  try {
    return searchCursor(JSON.parse(value) as unknown, expected);
  } catch (error: unknown) {
    if (error instanceof SearchDatabaseContractError) throw error;
    return reject();
  }
}

function encodeCursor(value: unknown, expected: ClaimedEncryptedUserSearch): string | null {
  if (value === null) return null;
  const parsed = searchCursor(value, expected);
  return JSON.stringify({
    searchId: parsed.searchId,
    requestDigest: parsed.requestDigest,
    generationId: parsed.generationId,
    generationRevisionToken: parsed.generationRevisionToken,
    afterIndexId: parsed.afterIndexId
  });
}

function metadata(value: unknown): SearchRagMetadata {
  const row = exact(value, ["archivedAt", "pinnedAt", "spaceId", "tagIds", "type", "updatedAt"]);
  if (typeof row.type !== "string" || !NOTE_TYPES.has(row.type) || !Array.isArray(row.tagIds)) {
    return reject();
  }
  const tagIds = row.tagIds.map((tagId) => string(tagId, TAG));
  if (
    new Set(tagIds).size !== tagIds.length ||
    tagIds.some((tagId, index) => index > 0 && (tagIds[index - 1] ?? "") >= tagId)
  ) {
    return reject();
  }
  return Object.freeze({
    type: row.type as SearchRagMetadata["type"],
    spaceId: row.spaceId === null ? null : string(row.spaceId, SPACE),
    updatedAt: timestamp(row.updatedAt),
    pinnedAt: nullableTimestamp(row.pinnedAt),
    archivedAt: nullableTimestamp(row.archivedAt),
    tagIds: Object.freeze(tagIds)
  });
}

function metadataMatchesFilter(
  value: SearchRagMetadata,
  filters: EncryptedUserSearchFilterManifest
): boolean {
  const archived = value.archivedAt !== null;
  return !(
    (filters.archive === "exclude" && archived) ||
    (filters.archive === "only" && !archived) ||
    (filters.type !== null && value.type !== filters.type) ||
    (filters.space.mode === "root" && value.spaceId !== null) ||
    (filters.space.mode === "exact" && value.spaceId !== filters.space.id) ||
    (filters.updatedFrom !== null &&
      Date.parse(value.updatedAt) < Date.parse(filters.updatedFrom)) ||
    (filters.updatedTo !== null && Date.parse(value.updatedAt) >= Date.parse(filters.updatedTo)) ||
    filters.tagIds.some((tagId) => !value.tagIds.includes(tagId))
  );
}

function ragRecord(
  value: unknown,
  keyByIdentity: ReadonlyMap<string, ManagedKeyRecord>,
  ownerId: string
): Readonly<{
  indexId: string;
  noteId: string;
  indexedRevision: number;
  ciphertextBytes: number;
  record: SearchRagRecord;
  keyIdentity: string;
}> {
  const row = exact(value, [
    "cipher",
    "encryptedByteLength",
    "indexId",
    "indexedRevision",
    "metadata",
    "noteId"
  ]);
  const indexId = string(row.indexId, INDEX);
  const noteId = string(row.noteId, NOTE);
  const indexedRevision = integer(row.indexedRevision, 1, 1_000_000_000);
  const cipher = exact(row.cipher, ["envelope", "keyClass", "keyId", "keyPurpose", "keyVersion"]);
  if (
    cipher.keyClass !== "ai_assisted" ||
    cipher.keyPurpose !== "object_wrap" ||
    typeof cipher.keyId !== "string"
  ) {
    return reject();
  }
  const keyVersion = integer(cipher.keyVersion, 1, 2_147_483_647);
  const keyIdentity = `${cipher.keyId}:${keyVersion}`;
  const key = keyByIdentity.get(keyIdentity);
  if (key === undefined) return reject();
  const encryptedByteLength = integer(row.encryptedByteLength, 16, 262_160);
  let envelope: ReturnType<typeof parseContentEnvelope>;
  try {
    envelope = parseContentEnvelope(serializeContentEnvelope(cipher.envelope));
  } catch {
    return reject();
  }
  if (
    envelope.keyId !== key.keyId ||
    envelope.context.tenantId !== ownerId ||
    envelope.context.resourceId !== indexId ||
    envelope.context.recordVersion !== indexedRevision ||
    envelope.context.kind !== "note_rag_index" ||
    decodedBytes(envelope.payload.ciphertext) !== encryptedByteLength
  ) {
    return reject();
  }
  return Object.freeze({
    ciphertextBytes: encryptedByteLength,
    indexId,
    indexedRevision,
    keyIdentity,
    noteId,
    record: Object.freeze({
      resourceId: indexId,
      recordVersion: indexedRevision,
      cipher: Object.freeze({
        envelope,
        keyClass: "ai_assisted" as const,
        keyId: key.keyId,
        keyPurpose: "object_wrap" as const,
        keyVersion
      }),
      key,
      encryptedByteLength,
      metadata: metadata(row.metadata)
    })
  });
}

function pageResult(
  value: unknown,
  input: Readonly<{
    claim: ClaimedEncryptedUserSearch;
    cursor: string | null;
    filterManifest: EncryptedUserSearchFilterManifest;
    limit: number;
    maxBytes: number;
  }>,
  parseRecord: ManagedKeyRecordParser,
  expectedProfile: SearchEmbeddingProfile
): PrivateRagPageReadResult<SearchRagRecord> {
  const root = exact(value, [
    "coverage",
    "generation",
    "items",
    "keys",
    "ownerId",
    "page",
    "searchId"
  ]);
  if (
    root.searchId !== input.claim.searchId ||
    root.ownerId !== input.claim.ownerId ||
    !Array.isArray(root.items) ||
    root.items.length > input.limit ||
    !Array.isArray(root.keys)
  ) {
    return reject();
  }
  const generationRow = exact(root.generation, [
    "attestationDigest",
    "embeddingDimensions",
    "embeddingModelId",
    "envelopeSchemaVersion",
    "expectedNoteCount",
    "generationId",
    "indexedNoteCount",
    "revisionToken"
  ]);
  const generationBinding = generation(
    {
      attestationDigest: generationRow.attestationDigest,
      embeddingDimensions: generationRow.embeddingDimensions,
      embeddingModelId: generationRow.embeddingModelId,
      envelopeSchemaVersion: generationRow.envelopeSchemaVersion,
      generationId: generationRow.generationId,
      revisionToken: generationRow.revisionToken
    },
    expectedProfile
  );
  if (!sameGeneration(generationBinding, input.claim.generation)) return reject();
  const expectedNoteCount = integer(
    generationRow.expectedNoteCount,
    0,
    RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
  );
  const indexedNoteCount = integer(
    generationRow.indexedNoteCount,
    0,
    RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
  );
  if (indexedNoteCount > expectedNoteCount) return reject();
  const snapshot: PrivateRagGenerationSnapshot = Object.freeze({
    generationId: generationBinding.generationId,
    modelId: generationBinding.embeddingModelId,
    dimensions: generationBinding.embeddingDimensions,
    revisionToken: generationBinding.revisionToken,
    expectedNoteCount,
    indexedNoteCount
  });

  const coverageRow = exact(root.coverage, [
    "missingOrStaleCount",
    "repairCandidates",
    "repairOverflow",
    "status"
  ]);
  if (
    (coverageRow.status !== "complete" && coverageRow.status !== "incomplete") ||
    typeof coverageRow.repairOverflow !== "boolean" ||
    !Array.isArray(coverageRow.repairCandidates)
  ) {
    return reject();
  }
  const missingOrStaleCount = integer(
    coverageRow.missingOrStaleCount,
    0,
    RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
  );
  const repairNoteIds = new Set<string>();
  let previousRepairNoteId: string | undefined;
  const repairCandidates = coverageRow.repairCandidates.map((entry) => {
    const row = exact(entry, ["currentRevision", "noteId"]);
    const noteId = string(row.noteId, NOTE);
    if (
      repairNoteIds.has(noteId) ||
      (previousRepairNoteId !== undefined && noteId <= previousRepairNoteId)
    ) {
      return reject();
    }
    repairNoteIds.add(noteId);
    previousRepairNoteId = noteId;
    return Object.freeze({
      currentRevision: integer(row.currentRevision, 1, 1_000_000_000),
      noteId
    });
  });
  if (
    repairCandidates.length > 50 ||
    missingOrStaleCount !== expectedNoteCount - indexedNoteCount ||
    (coverageRow.status === "complete" &&
      (missingOrStaleCount !== 0 || repairCandidates.length !== 0 || coverageRow.repairOverflow)) ||
    (coverageRow.status === "incomplete" &&
      (missingOrStaleCount === 0 ||
        coverageRow.repairOverflow !== missingOrStaleCount > 50 ||
        repairCandidates.length !== Math.min(missingOrStaleCount, 50)))
  ) {
    return reject();
  }

  const keyByIdentity = new Map<string, ManagedKeyRecord>();
  for (const unknownKey of root.keys) {
    let key: ManagedKeyRecord;
    try {
      key = parseRecord(unknownKey);
    } catch {
      return reject();
    }
    const identity = `${key.keyId}:${key.keyVersion}`;
    if (
      keyByIdentity.has(identity) ||
      key.ownerId !== input.claim.ownerId ||
      key.keyClass !== "ai_assisted" ||
      key.purpose !== "object_wrap" ||
      (key.status !== "active" && key.status !== "retired")
    ) {
      return reject();
    }
    keyByIdentity.set(identity, key);
  }

  const seenIndexes = new Set<string>();
  const seenNotes = new Set<string>();
  const referencedKeys = new Set<string>();
  let previousIndexId: string | undefined;
  const items = root.items.map((entry) => {
    const parsed = ragRecord(entry, keyByIdentity, input.claim.ownerId);
    if (
      seenIndexes.has(parsed.indexId) ||
      seenNotes.has(parsed.noteId) ||
      (previousIndexId !== undefined && parsed.indexId <= previousIndexId) ||
      !metadataMatchesFilter(parsed.record.metadata, input.filterManifest)
    ) {
      return reject();
    }
    previousIndexId = parsed.indexId;
    seenIndexes.add(parsed.indexId);
    seenNotes.add(parsed.noteId);
    referencedKeys.add(parsed.keyIdentity);
    return Object.freeze({
      indexId: parsed.indexId,
      noteId: parsed.noteId,
      indexedRevision: parsed.indexedRevision,
      ciphertextBytes: parsed.ciphertextBytes,
      record: parsed.record
    });
  });
  if (referencedKeys.size !== keyByIdentity.size) return reject();

  const pageRow = exact(root.page, [
    "ciphertextByteBudget",
    "ciphertextBytes",
    "hasMore",
    "limit",
    "nextCursor",
    "returnedCount"
  ]);
  const nextCursor = encodeCursor(pageRow.nextCursor, input.claim);
  if (
    pageRow.limit !== input.limit ||
    pageRow.ciphertextByteBudget !== input.maxBytes ||
    pageRow.returnedCount !== items.length ||
    pageRow.ciphertextBytes !== items.reduce((total, item) => total + item.ciphertextBytes, 0) ||
    typeof pageRow.hasMore !== "boolean" ||
    pageRow.hasMore !== (nextCursor !== null)
  ) {
    return reject();
  }
  const previous = decodeCursor(input.cursor, input.claim);
  if (previous !== null && items.some((item) => item.indexId <= previous.afterIndexId))
    return reject();
  const last = items.at(-1);
  if (nextCursor !== null) {
    const parsedNext = decodeCursor(nextCursor, input.claim);
    if (last === undefined || parsedNext?.afterIndexId !== last.indexId) return reject();
  }
  return Object.freeze({
    status: "page" as const,
    page: Object.freeze({
      snapshot,
      coverage: Object.freeze({
        status: coverageRow.status,
        missingOrStaleCount,
        repairCandidates: Object.freeze(repairCandidates),
        repairOverflow: coverageRow.repairOverflow
      }),
      items: Object.freeze(items),
      nextCursor
    })
  });
}

async function execute(
  executor: SearchDatabaseExecutor,
  text: string,
  values: readonly unknown[],
  signal: AbortSignal
): Promise<unknown> {
  if (isAborted(signal)) throw new DOMException("The operation was aborted", "AbortError");
  const result = await executor.query({ signal, text, values });
  if (isAborted(signal)) throw new DOMException("The operation was aborted", "AbortError");
  return oneResult(result.rows);
}

export function createEncryptedUserSearchRepository(
  executor: SearchDatabaseExecutor,
  parseRecord: ManagedKeyRecordParser = parseManagedKeyRecordV1,
  expectedProfile: SearchEmbeddingProfile = DEFAULT_SEARCH_EMBEDDING_PROFILE
): EncryptedUserSearchRepository {
  if (
    !Number.isSafeInteger(expectedProfile.dimensions) ||
    expectedProfile.dimensions < 1 ||
    expectedProfile.dimensions > 4_096 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(expectedProfile.modelId)
  ) {
    return reject();
  }
  return Object.freeze({
    async claim(input) {
      const searchId = string(input.searchId.toLowerCase(), UUID);
      const requestDigest = string(input.requestDigest, DIGEST);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(input.claimSecret)) return reject();
      return claimed(
        await execute(
          executor,
          SEARCH_RPC_SQL.claim,
          [searchId, input.claimSecret, requestDigest],
          input.signal
        ),
        { searchId, requestDigest },
        expectedProfile
      );
    },
    async page(input) {
      const parsedFilters = EncryptedUserSearchFilterManifestSchema.safeParse(input.filterManifest);
      if (
        !parsedFilters.success ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 262_160 ||
        input.maxBytes > 8_388_608
      ) {
        return reject();
      }
      const cursor = decodeCursor(input.cursor, input.claim);
      const value = await execute(
        executor,
        SEARCH_RPC_SQL.page,
        [
          input.claim.searchId,
          input.claim.leaseToken,
          input.claim.requestDigest,
          parsedFilters.data,
          cursor,
          input.limit,
          input.maxBytes
        ],
        input.signal
      );
      return pageResult(
        value,
        {
          claim: input.claim,
          cursor: input.cursor,
          filterManifest: parsedFilters.data,
          limit: input.limit,
          maxBytes: input.maxBytes
        },
        parseRecord,
        expectedProfile
      );
    },
    async verify(input) {
      const parsedFilters = EncryptedUserSearchFilterManifestSchema.safeParse(input.filterManifest);
      if (!parsedFilters.success || input.candidates.length > 100) return reject();
      const indexes = new Set<string>();
      const notes = new Set<string>();
      const candidates = input.candidates.map((candidate) => {
        const indexId = string(candidate.indexId, INDEX);
        const noteId = string(candidate.noteId, NOTE);
        const indexedRevision = integer(candidate.indexedRevision, 1, 1_000_000_000);
        if (indexes.has(indexId) || notes.has(noteId)) return reject();
        indexes.add(indexId);
        notes.add(noteId);
        return Object.freeze({ indexId, noteId, indexedRevision });
      });
      const row = exact(
        await execute(
          executor,
          SEARCH_RPC_SQL.verify,
          [
            input.claim.searchId,
            input.claim.leaseToken,
            input.claim.requestDigest,
            parsedFilters.data,
            JSON.stringify(candidates)
          ],
          input.signal
        ),
        [
          "candidateDigest",
          "generationRevisionToken",
          "searchId",
          "snapshotVerified",
          "verifiedCandidateCount"
        ]
      );
      const candidateDigest = string(row.candidateDigest, DIGEST);
      const verifiedCandidateCount = integer(row.verifiedCandidateCount, 0, 100);
      if (
        row.searchId !== input.claim.searchId ||
        row.snapshotVerified !== true ||
        String(integer(row.generationRevisionToken, 0)) !== input.claim.generation.revisionToken ||
        verifiedCandidateCount !== candidates.length
      ) {
        return reject();
      }
      return Object.freeze({ candidateDigest, verifiedCandidateCount });
    },
    async complete(input) {
      const row = exact(
        await execute(
          executor,
          SEARCH_RPC_SQL.complete,
          [input.claim.searchId, input.claim.leaseToken, input.claim.requestDigest],
          input.signal
        ),
        ["candidateDigest", "completedAt", "searchId", "state"]
      );
      if (
        row.searchId !== input.claim.searchId ||
        row.state !== "completed" ||
        row.candidateDigest !== input.candidateDigest
      ) {
        return reject();
      }
      timestamp(row.completedAt);
    },
    async fail(input) {
      const row = exact(
        await execute(
          executor,
          SEARCH_RPC_SQL.fail,
          [
            input.claim.searchId,
            input.claim.leaseToken,
            input.claim.requestDigest,
            input.failureCode
          ],
          input.signal
        ),
        ["failedAt", "failureCode", "searchId", "state"]
      );
      if (
        row.searchId !== input.claim.searchId ||
        row.state !== "failed" ||
        row.failureCode !== input.failureCode
      ) {
        return reject();
      }
      timestamp(row.failedAt);
    }
  });
}

export function assertSearchSessionRows(rows: readonly unknown[]): void {
  if (rows.length !== 1) throw new SearchDatabaseContractError("identity_denied");
  const row = exact(rows[0], ["currentUser", "sessionUser"]);
  if (row.sessionUser !== EXPECTED_ROLE || row.currentUser !== EXPECTED_ROLE) {
    throw new SearchDatabaseContractError("identity_denied");
  }
}
