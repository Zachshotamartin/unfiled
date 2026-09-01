import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN = /^(?:0[1-9]|1[0-4]):[a-z_]+:[A-Za-z0-9._:-]{1,220}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CURSOR_LENGTH = 260;
const MAX_BATCH_LIMIT = 250;

export const plaintextScrubRpcFunctions = Object.freeze([
  "prepare_content_plaintext_scrub",
  "scrub_content_plaintext_batch",
  "complete_content_plaintext_scrub"
] as const);

export type PlaintextScrubCursor = string;

export type PreparePlaintextScrubResult = Readonly<{
  scrubId: string;
  cursor: PlaintextScrubCursor | null;
  complete: boolean;
  replayed: boolean;
}>;

export type PlaintextScrubBatchResult = Readonly<{
  scrubId: string;
  expectedCursor: PlaintextScrubCursor | null;
  cursor: PlaintextScrubCursor | null;
  processedCount: number;
  deletedChunkCount: number;
  deletedIdempotencyCount: number;
  complete: boolean;
  replayed: boolean;
}>;

export type CompletePlaintextScrubResult = Readonly<{
  scrubId: string;
  complete: true;
  attestationDigest: string;
  replayed: boolean;
}>;

export type PlaintextScrubRpcStore = Readonly<{
  prepare(
    input: Readonly<{ ownerId: string; scrubId: string }>
  ): Promise<PreparePlaintextScrubResult>;
  scrubBatch(
    input: Readonly<{
      ownerId: string;
      scrubId: string;
      expectedCursor: PlaintextScrubCursor | null;
      limit?: number;
    }>
  ): Promise<PlaintextScrubBatchResult>;
  complete(
    input: Readonly<{
      ownerId: string;
      scrubId: string;
      expectedCursor: PlaintextScrubCursor | null;
    }>
  ): Promise<CompletePlaintextScrubResult>;
}>;

type Failure = () => never;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function invalidProjection(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function exactRecord(value: unknown, keys: readonly string[], failure: Failure) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return failure();
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return failure();
  }
  return record;
}

function uuid(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failure();
  return value.toLowerCase();
}

function cursor(value: unknown, failure: Failure): PlaintextScrubCursor | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > MAX_CURSOR_LENGTH ||
    !CURSOR_PATTERN.test(value)
  ) {
    return failure();
  }
  return value;
}

function count(value: unknown, maximum: number, failure: Failure): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return failure();
  }
  return value as number;
}

function boolean(value: unknown, failure: Failure): boolean {
  if (typeof value !== "boolean") return failure();
  return value;
}

function prepareResult(value: unknown, scrubId: string): PreparePlaintextScrubResult {
  const record = exactRecord(
    value,
    ["scrubId", "cursor", "complete", "replayed"],
    invalidProjection
  );
  if (uuid(record.scrubId, invalidProjection) !== scrubId) return invalidProjection();
  return Object.freeze({
    scrubId,
    cursor: cursor(record.cursor, invalidProjection),
    complete: boolean(record.complete, invalidProjection),
    replayed: boolean(record.replayed, invalidProjection)
  });
}

function batchResult(
  value: unknown,
  input: Readonly<{
    scrubId: string;
    expectedCursor: PlaintextScrubCursor | null;
    limit: number;
  }>
): PlaintextScrubBatchResult {
  const record = exactRecord(
    value,
    [
      "scrubId",
      "expectedCursor",
      "cursor",
      "processedCount",
      "deletedChunkCount",
      "deletedIdempotencyCount",
      "complete",
      "replayed"
    ],
    invalidProjection
  );
  if (
    uuid(record.scrubId, invalidProjection) !== input.scrubId ||
    cursor(record.expectedCursor, invalidProjection) !== input.expectedCursor
  ) {
    return invalidProjection();
  }
  const processedCount = count(record.processedCount, input.limit, invalidProjection);
  const deletedChunkCount = count(record.deletedChunkCount, processedCount, invalidProjection);
  const deletedIdempotencyCount = count(
    record.deletedIdempotencyCount,
    processedCount,
    invalidProjection
  );
  if (deletedChunkCount + deletedIdempotencyCount > processedCount) return invalidProjection();
  const nextCursor = cursor(record.cursor, invalidProjection);
  const complete = boolean(record.complete, invalidProjection);
  if (
    (processedCount === 0 && nextCursor !== input.expectedCursor) ||
    (processedCount === 0 && !complete) ||
    (processedCount > 0 && (nextCursor === null || nextCursor === input.expectedCursor))
  ) {
    return invalidProjection();
  }
  return Object.freeze({
    scrubId: input.scrubId,
    expectedCursor: input.expectedCursor,
    cursor: nextCursor,
    processedCount,
    deletedChunkCount,
    deletedIdempotencyCount,
    complete,
    replayed: boolean(record.replayed, invalidProjection)
  });
}

function completeResult(value: unknown, scrubId: string): CompletePlaintextScrubResult {
  const record = exactRecord(
    value,
    ["scrubId", "complete", "attestationDigest", "replayed"],
    invalidProjection
  );
  if (
    uuid(record.scrubId, invalidProjection) !== scrubId ||
    record.complete !== true ||
    typeof record.attestationDigest !== "string" ||
    !DIGEST_PATTERN.test(record.attestationDigest) ||
    typeof record.replayed !== "boolean"
  ) {
    return invalidProjection();
  }
  return Object.freeze({
    scrubId,
    complete: true,
    attestationDigest: record.attestationDigest,
    replayed: record.replayed
  });
}

export function createPlaintextScrubRpcStore(client: ServiceRpcClient): PlaintextScrubRpcStore {
  return Object.freeze({
    async prepare(input) {
      const ownerId = uuid(input.ownerId, invalidInput);
      const scrubId = uuid(input.scrubId, invalidInput);
      return prepareResult(
        await client.rpc("prepare_content_plaintext_scrub", {
          p_owner_id: ownerId,
          p_scrub_id: scrubId,
          p_expected_state: "encrypted_read"
        }),
        scrubId
      );
    },

    async scrubBatch(input) {
      const ownerId = uuid(input.ownerId, invalidInput);
      const scrubId = uuid(input.scrubId, invalidInput);
      const expectedCursor = cursor(input.expectedCursor, invalidInput);
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) invalidInput();
      return batchResult(
        await client.rpc("scrub_content_plaintext_batch", {
          p_owner_id: ownerId,
          p_scrub_id: scrubId,
          p_expected_cursor: expectedCursor,
          p_limit: limit
        }),
        { scrubId, expectedCursor, limit }
      );
    },

    async complete(input) {
      const ownerId = uuid(input.ownerId, invalidInput);
      const scrubId = uuid(input.scrubId, invalidInput);
      const expectedCursor = cursor(input.expectedCursor, invalidInput);
      return completeResult(
        await client.rpc("complete_content_plaintext_scrub", {
          p_owner_id: ownerId,
          p_scrub_id: scrubId,
          p_expected_cursor: expectedCursor
        }),
        scrubId
      );
    }
  });
}
