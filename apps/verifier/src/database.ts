import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  assertCanonicalEncryptedKeyMaterial,
  parseManagedKeyRecordV1,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser
} from "@unfiled/key-management";

import { GenerationVerificationError } from "./errors.js";

const EXPECTED_DATABASE_ROLE = "unfiled_rag_verifier";
const MIN_INDEX_CIPHERTEXT_BYTES = 16;
const MAX_INDEX_CIPHERTEXT_BYTES = 262_160;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENTITY_SUFFIX_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
const NOTE_ID_PATTERN = new RegExp(`^note_${ENTITY_SUFFIX_PATTERN}$`, "u");
const GENERATION_ID_PATTERN = new RegExp(`^igen_${ENTITY_SUFFIX_PATTERN}$`, "u");
const INDEX_ID_PATTERN = new RegExp(`^irw_${ENTITY_SUFFIX_PATTERN}$`, "u");
const MODEL_ID_PATTERN = /^[\x21-\x7e]{1,200}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_BIGINT_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;
const ENVELOPE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_ENVELOPE_IDENTIFIER_LENGTH = 128;
const GCM_NONCE_BYTES = 12;
const WRAPPED_DATA_KEY_CIPHERTEXT_BYTES = 48;

export const VERIFIER_RPC_NAMES = Object.freeze([
  "list_building_note_rag_index",
  "verify_rag_index_generation"
] as const);

export type RevisionToken = string;

export type GenerationTarget = Readonly<{
  generationId: string;
  ownerId: string;
  revisionToken: RevisionToken;
}>;

export type BuildingGeneration = Readonly<{
  embeddingDimensions: number;
  embeddingModelId: string;
  envelopeSchemaVersion: 1;
  expectedNoteCount: number;
  generationId: string;
  indexedNoteCount: number;
  revisionToken: RevisionToken;
  state: "building";
}>;

export type BuildingGenerationCursor = Readonly<{
  afterIndexId: string;
  generationId: string;
  revisionToken: RevisionToken;
}>;

export type GenerationVerificationAttestation = Readonly<{
  attestationDigest: string;
  domain: "unfiled.rag-generation-verification.v1";
}>;

export type BuildingIndexItem = Readonly<{
  cipher: Readonly<{
    envelope: ContentEnvelopeV1;
    keyClass: "ai_assisted";
    keyId: string;
    keyPurpose: "object_wrap";
    keyVersion: number;
  }>;
  encryptedByteLength: number;
  indexId: string;
  indexedRevision: number;
  keyRecord: ManagedKeyRecord;
  noteId: string;
}>;

export type BuildingGenerationPage = Readonly<{
  generation: BuildingGeneration;
  items: readonly BuildingIndexItem[];
  ownerId: string;
  page: Readonly<{
    ciphertextByteBudget: number;
    ciphertextBytes: number;
    hasMore: boolean;
    limit: number;
    nextCursor: BuildingGenerationCursor | null;
    returnedCount: number;
  }>;
  verification: GenerationVerificationAttestation | null;
}>;

export type VerifiedGeneration = Readonly<{
  attestationDigest: string;
  attestationDomain: "unfiled.rag-generation-attestation.v1";
  embeddingDimensions: number;
  embeddingModelId: string;
  envelopeSchemaVersion: 1;
  generationId: string;
  revisionToken: RevisionToken;
  verified: true;
  verifiedNoteCount: number;
}>;

export type VerifierDatabaseQuery = Readonly<{
  signal: AbortSignal;
  text: string;
  values: readonly unknown[];
}>;

export type VerifierDatabaseQueryResult = Readonly<{ rows: readonly unknown[] }>;

export type VerifierDatabaseQueryExecutor = Readonly<{
  query(query: VerifierDatabaseQuery): Promise<VerifierDatabaseQueryResult>;
  releaseSession?(signal: AbortSignal): void;
}>;

declare const VERIFIED_DATABASE_IDENTITY: unique symbol;

export type VerifierDatabaseIdentityProof = Readonly<{
  [VERIFIED_DATABASE_IDENTITY]: true;
}>;

export class VerifierDatabaseContractError extends Error {
  readonly code: "contract_violation" | "identity_denied";

  constructor(code: "contract_violation" | "identity_denied") {
    super(
      code === "identity_denied"
        ? "Verifier database identity was denied"
        : "Verifier database contract was rejected"
    );
    this.name = "VerifierDatabaseContractError";
    this.code = code;
  }
}

export type ReadBuildingPageInput = GenerationTarget &
  Readonly<{
    ciphertextByteBudget: number;
    cursor: BuildingGenerationCursor | null;
    limit: number;
    signal: AbortSignal;
  }>;

export type AttestGenerationInput = GenerationTarget &
  Readonly<{
    signal: AbortSignal;
    verification: GenerationVerificationAttestation;
  }>;

export type GenerationVerificationRepository = Readonly<{
  attest(
    input: AttestGenerationInput,
    identityProof?: VerifierDatabaseIdentityProof
  ): Promise<VerifiedGeneration>;
  preflight(signal: AbortSignal): Promise<VerifierDatabaseIdentityProof>;
  release(identityProof: VerifierDatabaseIdentityProof): void;
  readBuildingPage(
    input: ReadBuildingPageInput,
    identityProof?: VerifierDatabaseIdentityProof
  ): Promise<BuildingGenerationPage>;
}>;

const IDENTITY_SQL =
  'select session_user::text as "sessionUser", current_user::text as "currentUser"';
const LIST_SQL =
  "select public.list_building_note_rag_index($1::uuid, $2::text, $3::bigint, $4::jsonb, $5::integer, $6::integer) as result";
const VERIFY_SQL =
  "select public.verify_rag_index_generation($1::uuid, $2::text, $3::bigint, $4::jsonb) as result";

function rejectContract(): never {
  throw new VerifierDatabaseContractError("contract_violation");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInvalidGenerationAttestation(error: unknown): boolean {
  return (
    isRecord(error) && error.code === "P0001" && error.message === "invalid_generation_attestation"
  );
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

function matchingString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) rejectContract();
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    rejectContract();
  }
  return Number(value);
}

export function parseRevisionToken(value: unknown): RevisionToken {
  if (typeof value !== "string" || !CANONICAL_BIGINT_PATTERN.test(value)) rejectContract();
  if (BigInt(value) > MAX_SIGNED_BIGINT) rejectContract();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !TIMESTAMP_PATTERN.test(value)) {
    rejectContract();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) rejectContract();
  return new Date(parsed).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function decodedCanonicalBase64UrlBytes(
  value: unknown,
  minimumBytes = 0,
  maximumBytes = MAX_INDEX_CIPHERTEXT_BYTES
): number {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((maximumBytes * 4) / 3) ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    rejectContract();
  }
  const remainder = value.length % 4;
  const finalSextet = BASE64URL_ALPHABET.indexOf(value.at(-1) ?? "");
  if (
    finalSextet < 0 ||
    (remainder === 2 && (finalSextet & 0x0f) !== 0) ||
    (remainder === 3 && (finalSextet & 0x03) !== 0)
  ) {
    rejectContract();
  }
  const byteLength = Math.floor((value.length * 6) / 8);
  if (byteLength < minimumBytes || byteLength > maximumBytes) rejectContract();
  return byteLength;
}

function envelopeIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_ENVELOPE_IDENTIFIER_LENGTH ||
    !ENVELOPE_IDENTIFIER_PATTERN.test(value)
  ) {
    rejectContract();
  }
  return value;
}

function encryptedPart(
  value: unknown,
  ciphertextBounds: Readonly<{ maximum: number; minimum: number }>
): ContentEnvelopeV1["payload"] {
  const row = exactRecord(value, ["nonce", "ciphertext"]);
  decodedCanonicalBase64UrlBytes(row.nonce, GCM_NONCE_BYTES, GCM_NONCE_BYTES);
  decodedCanonicalBase64UrlBytes(
    row.ciphertext,
    ciphertextBounds.minimum,
    ciphertextBounds.maximum
  );
  return Object.freeze({ nonce: String(row.nonce), ciphertext: String(row.ciphertext) });
}

function contentEnvelope(
  value: unknown,
  expected: Readonly<{
    indexId: string;
    indexedRevision: number;
    keyId: string;
    ownerId: string;
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
  const parsed: ContentEnvelopeV1 = Object.freeze({
    version: row.version === 1 ? 1 : rejectContract(),
    suite: row.suite === "A256GCM" ? "A256GCM" : rejectContract(),
    keyId: envelopeIdentifier(row.keyId),
    context: Object.freeze({
      tenantId: envelopeIdentifier(context.tenantId),
      resourceId: envelopeIdentifier(context.resourceId),
      recordVersion: integer(context.recordVersion, 1, MAX_COUNTER),
      kind: context.kind === "note_rag_index" ? "note_rag_index" : rejectContract()
    }),
    wrappedDataKey: encryptedPart(row.wrappedDataKey, {
      minimum: WRAPPED_DATA_KEY_CIPHERTEXT_BYTES,
      maximum: WRAPPED_DATA_KEY_CIPHERTEXT_BYTES
    }),
    payload: encryptedPart(row.payload, {
      minimum: MIN_INDEX_CIPHERTEXT_BYTES,
      maximum: MAX_INDEX_CIPHERTEXT_BYTES
    })
  });
  if (
    parsed.keyId !== expected.keyId ||
    parsed.context.tenantId !== expected.ownerId ||
    parsed.context.resourceId !== expected.indexId ||
    parsed.context.recordVersion !== expected.indexedRevision ||
    parsed.context.kind !== "note_rag_index"
  ) {
    rejectContract();
  }
  return parsed;
}

function normalizeManagedKey(
  value: unknown,
  parseRecord: ManagedKeyRecordParser
): ManagedKeyRecord {
  if (!isRecord(value)) rejectContract();
  try {
    assertCanonicalEncryptedKeyMaterial(value.encryptedKeyMaterial);
  } catch {
    throw new GenerationVerificationError();
  }
  try {
    if (!isRecord(value.rotation)) rejectContract();
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

function parseGeneration(value: unknown, target: GenerationTarget): BuildingGeneration {
  const row = exactRecord(value, [
    "generationId",
    "state",
    "embeddingModelId",
    "embeddingDimensions",
    "envelopeSchemaVersion",
    "expectedNoteCount",
    "indexedNoteCount",
    "revisionToken"
  ]);
  if (
    row.state !== "building" ||
    row.envelopeSchemaVersion !== 1 ||
    typeof row.embeddingModelId !== "string" ||
    !MODEL_ID_PATTERN.test(row.embeddingModelId)
  ) {
    rejectContract();
  }
  const generation: BuildingGeneration = Object.freeze({
    generationId: matchingString(row.generationId, GENERATION_ID_PATTERN),
    state: "building",
    embeddingModelId: row.embeddingModelId,
    embeddingDimensions: integer(row.embeddingDimensions, 1, 4_096),
    envelopeSchemaVersion: 1,
    expectedNoteCount: integer(row.expectedNoteCount, 0, 2_147_483_647),
    indexedNoteCount: integer(row.indexedNoteCount, 0, 2_147_483_647),
    revisionToken: parseRevisionToken(row.revisionToken)
  });
  if (
    generation.generationId !== target.generationId ||
    generation.revisionToken !== target.revisionToken ||
    generation.indexedNoteCount > generation.expectedNoteCount
  ) {
    rejectContract();
  }
  return generation;
}

function parseCursor(value: unknown): BuildingGenerationCursor {
  const row = exactRecord(value, ["generationId", "revisionToken", "afterIndexId"]);
  return Object.freeze({
    generationId: matchingString(row.generationId, GENERATION_ID_PATTERN),
    revisionToken: parseRevisionToken(row.revisionToken),
    afterIndexId: matchingString(row.afterIndexId, INDEX_ID_PATTERN)
  });
}

function parseAttestation(value: unknown): GenerationVerificationAttestation {
  const row = exactRecord(value, ["domain", "attestationDigest"]);
  if (
    row.domain !== "unfiled.rag-generation-verification.v1" ||
    typeof row.attestationDigest !== "string" ||
    !DIGEST_PATTERN.test(row.attestationDigest)
  ) {
    rejectContract();
  }
  return Object.freeze({
    domain: "unfiled.rag-generation-verification.v1",
    attestationDigest: row.attestationDigest
  });
}

function parseItem(value: unknown, ownerId: string): Omit<BuildingIndexItem, "keyRecord"> {
  const row = exactRecord(value, [
    "indexId",
    "noteId",
    "indexedRevision",
    "cipher",
    "encryptedByteLength"
  ]);
  const indexId = matchingString(row.indexId, INDEX_ID_PATTERN);
  const indexedRevision = integer(row.indexedRevision, 1, MAX_COUNTER);
  const cipherRow = exactRecord(row.cipher, [
    "envelope",
    "keyId",
    "keyClass",
    "keyPurpose",
    "keyVersion"
  ]);
  if (
    typeof cipherRow.keyId !== "string" ||
    cipherRow.keyClass !== "ai_assisted" ||
    cipherRow.keyPurpose !== "object_wrap"
  ) {
    rejectContract();
  }
  const keyVersion = integer(cipherRow.keyVersion, 1, 2_147_483_647);
  const envelope = contentEnvelope(cipherRow.envelope, {
    indexId,
    indexedRevision,
    keyId: cipherRow.keyId,
    ownerId
  });
  const encryptedByteLength = integer(
    row.encryptedByteLength,
    MIN_INDEX_CIPHERTEXT_BYTES,
    MAX_INDEX_CIPHERTEXT_BYTES
  );
  if (decodedCanonicalBase64UrlBytes(envelope.payload.ciphertext) !== encryptedByteLength) {
    rejectContract();
  }
  return Object.freeze({
    cipher: Object.freeze({
      envelope,
      keyClass: "ai_assisted",
      keyId: cipherRow.keyId,
      keyPurpose: "object_wrap",
      keyVersion
    }),
    encryptedByteLength,
    indexId,
    indexedRevision,
    noteId: matchingString(row.noteId, NOTE_ID_PATTERN)
  });
}

function keyIdentity(value: Readonly<{ keyId: string; keyVersion: number }>): string {
  return `${value.keyId}:${value.keyVersion}`;
}

function parseListResult(
  value: unknown,
  input: ReadBuildingPageInput,
  parseRecord: ManagedKeyRecordParser
): BuildingGenerationPage {
  const row = exactRecord(value, [
    "ownerId",
    "generation",
    "items",
    "keys",
    "page",
    "verification"
  ]);
  if (
    row.ownerId !== input.ownerId ||
    !Array.isArray(row.items) ||
    !Array.isArray(row.keys) ||
    row.items.length > input.limit
  ) {
    rejectContract();
  }
  const generation = parseGeneration(row.generation, input);
  const parsedItems = row.items.map((item) => parseItem(item, input.ownerId));
  const keys = row.keys.map((key) => normalizeManagedKey(key, parseRecord));
  const keyMap = new Map<string, ManagedKeyRecord>();
  for (const key of keys) {
    const identity = keyIdentity(key);
    if (
      keyMap.has(identity) ||
      key.ownerId !== input.ownerId ||
      key.keyClass !== "ai_assisted" ||
      key.purpose !== "object_wrap" ||
      (key.status !== "active" && key.status !== "retired")
    ) {
      rejectContract();
    }
    keyMap.set(identity, key);
  }
  const items: BuildingIndexItem[] = parsedItems.map((item) => {
    const keyRecord = keyMap.get(keyIdentity(item.cipher));
    if (keyRecord === undefined) rejectContract();
    return Object.freeze({ ...item, keyRecord });
  });
  const referencedKeys = new Set(items.map((item) => keyIdentity(item.cipher)));
  if ([...keyMap.keys()].some((identity) => !referencedKeys.has(identity))) rejectContract();
  const itemIds = items.map((item) => item.indexId);
  const inputCursor = input.cursor;
  if (
    new Set(itemIds).size !== itemIds.length ||
    itemIds.some((id, index) => index > 0 && id <= (itemIds[index - 1] ?? "")) ||
    (inputCursor !== null && itemIds.some((id) => id <= inputCursor.afterIndexId))
  ) {
    rejectContract();
  }
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
  if (
    page.returnedCount !== items.length ||
    page.ciphertextBytes !== items.reduce((sum, item) => sum + item.encryptedByteLength, 0) ||
    page.hasMore !== (nextCursor !== null) ||
    (page.hasMore && items.length === 0)
  ) {
    rejectContract();
  }
  const lastItem = items.at(-1);
  if (nextCursor !== null) {
    if (
      lastItem === undefined ||
      nextCursor.generationId !== generation.generationId ||
      nextCursor.revisionToken !== generation.revisionToken ||
      nextCursor.afterIndexId !== lastItem.indexId
    ) {
      rejectContract();
    }
  }
  const verification = row.verification === null ? null : parseAttestation(row.verification);
  if ((page.hasMore && verification !== null) || (!page.hasMore && verification === null)) {
    rejectContract();
  }
  return Object.freeze({
    generation,
    items: Object.freeze(items),
    ownerId: input.ownerId,
    page,
    verification
  });
}

function parseVerifyResult(value: unknown): VerifiedGeneration {
  const row = exactRecord(value, [
    "generationId",
    "revisionToken",
    "verifiedNoteCount",
    "attestationDomain",
    "attestationDigest",
    "embeddingModelId",
    "embeddingDimensions",
    "envelopeSchemaVersion",
    "verified"
  ]);
  if (
    row.verified !== true ||
    row.attestationDomain !== "unfiled.rag-generation-attestation.v1" ||
    typeof row.attestationDigest !== "string" ||
    !DIGEST_PATTERN.test(row.attestationDigest) ||
    typeof row.embeddingModelId !== "string" ||
    !MODEL_ID_PATTERN.test(row.embeddingModelId) ||
    row.envelopeSchemaVersion !== 1
  ) {
    rejectContract();
  }
  return Object.freeze({
    generationId: matchingString(row.generationId, GENERATION_ID_PATTERN),
    revisionToken: parseRevisionToken(row.revisionToken),
    verifiedNoteCount: integer(row.verifiedNoteCount, 0, 2_147_483_647),
    attestationDomain: "unfiled.rag-generation-attestation.v1",
    attestationDigest: row.attestationDigest,
    embeddingModelId: row.embeddingModelId,
    embeddingDimensions: integer(row.embeddingDimensions, 1, 4_096),
    envelopeSchemaVersion: 1,
    verified: true
  });
}

function assertTarget(target: GenerationTarget): void {
  matchingString(target.ownerId, UUID_PATTERN);
  matchingString(target.generationId, GENERATION_ID_PATTERN);
  parseRevisionToken(target.revisionToken);
}

function assertReadInput(input: ReadBuildingPageInput): BuildingGenerationCursor | null {
  exactRecord(input, [
    "ownerId",
    "generationId",
    "revisionToken",
    "cursor",
    "limit",
    "ciphertextByteBudget",
    "signal"
  ]);
  assertTarget(input);
  integer(input.limit, 1, 50);
  integer(input.ciphertextByteBudget, 262_160, 8_388_608);
  const cursor = input.cursor === null ? null : parseCursor(input.cursor);
  if (
    cursor !== null &&
    (cursor.generationId !== input.generationId || cursor.revisionToken !== input.revisionToken)
  ) {
    rejectContract();
  }
  return cursor;
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

async function query(
  executor: VerifierDatabaseQueryExecutor,
  text: string,
  values: readonly unknown[],
  signal: AbortSignal
): Promise<VerifierDatabaseQueryResult> {
  abortIfRequested(signal);
  const result = await executor.query(
    Object.freeze({ signal, text, values: Object.freeze([...values]) })
  );
  abortIfRequested(signal);
  if (!isRecord(result) || !Array.isArray(result.rows)) rejectContract();
  return result;
}

function resultValue(result: VerifierDatabaseQueryResult): unknown {
  if (result.rows.length !== 1) rejectContract();
  return exactRecord(result.rows[0], ["result"]).result;
}

export function createGenerationVerificationRepository(
  executor: VerifierDatabaseQueryExecutor,
  parseRecord: ManagedKeyRecordParser = parseManagedKeyRecordV1
): GenerationVerificationRepository {
  const verifiedProofs = new WeakMap<object, AbortSignal>();

  function release(proof: VerifierDatabaseIdentityProof): void {
    const signal = verifiedProofs.get(proof);
    if (signal === undefined) rejectContract();
    verifiedProofs.delete(proof);
    executor.releaseSession?.(signal);
  }

  async function preflight(signal: AbortSignal): Promise<VerifierDatabaseIdentityProof> {
    try {
      const result = await query(executor, IDENTITY_SQL, [], signal);
      if (result.rows.length !== 1) rejectContract();
      const row = exactRecord(result.rows[0], ["sessionUser", "currentUser"]);
      if (
        row.sessionUser !== EXPECTED_DATABASE_ROLE ||
        row.currentUser !== EXPECTED_DATABASE_ROLE
      ) {
        throw new VerifierDatabaseContractError("identity_denied");
      }
      const proof = Object.freeze({}) as VerifierDatabaseIdentityProof;
      verifiedProofs.set(proof, signal);
      return proof;
    } catch (error: unknown) {
      executor.releaseSession?.(signal);
      throw error;
    }
  }

  async function verifiedResult(
    sql: string,
    values: readonly unknown[],
    signal: AbortSignal,
    proof: VerifierDatabaseIdentityProof | undefined
  ): Promise<unknown> {
    const activeProof = proof ?? (await preflight(signal));
    const ownsProof = proof === undefined;
    if (verifiedProofs.get(activeProof) !== signal) rejectContract();
    try {
      return resultValue(await query(executor, sql, values, signal));
    } finally {
      if (ownsProof) release(activeProof);
    }
  }

  return Object.freeze({
    preflight,
    release,
    async readBuildingPage(input, proof): Promise<BuildingGenerationPage> {
      const cursor = assertReadInput(input);
      return parseListResult(
        await verifiedResult(
          LIST_SQL,
          [
            input.ownerId,
            input.generationId,
            input.revisionToken,
            cursor,
            input.limit,
            input.ciphertextByteBudget
          ],
          input.signal,
          proof
        ),
        input,
        parseRecord
      );
    },
    async attest(input, proof): Promise<VerifiedGeneration> {
      exactRecord(input, ["ownerId", "generationId", "revisionToken", "verification", "signal"]);
      assertTarget(input);
      const verification = parseAttestation(input.verification);
      let value: unknown;
      try {
        value = await verifiedResult(
          VERIFY_SQL,
          [input.ownerId, input.generationId, input.revisionToken, verification],
          input.signal,
          proof
        );
      } catch (error: unknown) {
        abortIfRequested(input.signal);
        if (isInvalidGenerationAttestation(error)) {
          throw new GenerationVerificationError();
        }
        try {
          value = await verifiedResult(
            VERIFY_SQL,
            [input.ownerId, input.generationId, input.revisionToken, verification],
            input.signal,
            proof
          );
        } catch (replayError: unknown) {
          if (isInvalidGenerationAttestation(replayError)) {
            throw new GenerationVerificationError();
          }
          throw error;
        }
      }
      const result = parseVerifyResult(value);
      if (
        result.generationId !== input.generationId ||
        result.revisionToken !== input.revisionToken ||
        result.attestationDigest !== verification.attestationDigest
      ) {
        rejectContract();
      }
      return result;
    }
  });
}
