import {
  EncryptedUserSearchFilterManifestSchema,
  type EncryptedUserSearchFilterManifest
} from "@unfiled/contracts";

import {
  createServiceRpcClient,
  type ServiceRpcClient,
  type ServiceRpcClientOptions
} from "@/server/encryption/service-rpc-client";

import { encryptedUserSearchFailure, EncryptedUserSearchError } from "./errors";

const BEGIN_RESPONSE_MAX_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GENERATION_ID_PATTERN = /^igen_[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_SAFE_REVISION_TOKEN = BigInt(Number.MAX_SAFE_INTEGER);

export const encryptedUserSearchCapabilityRpcFunctions = Object.freeze([
  "begin_encrypted_user_search"
] as const);

export type EncryptedUserSearchGenerationBinding = Readonly<{
  generationId: string;
  revisionToken: string;
  attestationDigest: string;
  embeddingModelId: string;
  embeddingDimensions: number;
  envelopeSchemaVersion: 1;
}>;

export type BegunEncryptedUserSearch = Readonly<{
  searchId: string;
  claimExpiresAt: string;
  requestDigest: string;
  filterDigest: string;
  generation: EncryptedUserSearchGenerationBinding;
}>;

export type BeginEncryptedUserSearchInput = Readonly<{
  ownerId: string;
  requestDigest: string;
  filterManifest: EncryptedUserSearchFilterManifest;
  claimSecretDigest: string;
}>;

export type EncryptedUserSearchCapabilityRpcAdapter = Readonly<{
  begin(input: BeginEncryptedUserSearchInput): Promise<BegunEncryptedUserSearch>;
}>;

type CapabilityClientOptions = Pick<ServiceRpcClientOptions, "environment" | "fetch" | "signal">;
type UnknownRecord = Readonly<Record<string, unknown>>;

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return encryptedUserSearchFailure();
  }
  const record = value as UnknownRecord;
  const actualKeys = Object.keys(record).sort();
  const wantedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== wantedKeys.length ||
    actualKeys.some((key, index) => key !== wantedKeys[index])
  ) {
    return encryptedUserSearchFailure();
  }
  return record;
}

function generationBinding(value: unknown): EncryptedUserSearchGenerationBinding {
  const record = exactRecord(value, [
    "generationId",
    "revisionToken",
    "attestationDigest",
    "embeddingModelId",
    "embeddingDimensions",
    "envelopeSchemaVersion"
  ]);
  if (
    typeof record.generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(record.generationId) ||
    typeof record.revisionToken !== "number" ||
    !Number.isSafeInteger(record.revisionToken) ||
    record.revisionToken < 0 ||
    BigInt(record.revisionToken) > MAX_SAFE_REVISION_TOKEN ||
    typeof record.attestationDigest !== "string" ||
    !DIGEST_PATTERN.test(record.attestationDigest) ||
    typeof record.embeddingModelId !== "string" ||
    record.embeddingModelId.length < 1 ||
    record.embeddingModelId.length > 200 ||
    record.embeddingModelId.trim() !== record.embeddingModelId ||
    hasAsciiControlCharacter(record.embeddingModelId) ||
    typeof record.embeddingDimensions !== "number" ||
    !Number.isSafeInteger(record.embeddingDimensions) ||
    record.embeddingDimensions < 1 ||
    record.embeddingDimensions > 4_096 ||
    record.envelopeSchemaVersion !== 1
  ) {
    return encryptedUserSearchFailure();
  }
  return Object.freeze({
    generationId: record.generationId,
    revisionToken: String(record.revisionToken),
    attestationDigest: record.attestationDigest,
    embeddingModelId: record.embeddingModelId,
    embeddingDimensions: record.embeddingDimensions,
    envelopeSchemaVersion: 1
  });
}

function begunSearch(value: unknown, expectedRequestDigest: string): BegunEncryptedUserSearch {
  const record = exactRecord(value, [
    "searchId",
    "claimExpiresAt",
    "requestDigest",
    "filterDigest",
    "generation"
  ]);
  if (
    typeof record.searchId !== "string" ||
    !UUID_PATTERN.test(record.searchId) ||
    typeof record.claimExpiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.claimExpiresAt) ||
    !Number.isFinite(Date.parse(record.claimExpiresAt)) ||
    record.requestDigest !== expectedRequestDigest ||
    typeof record.filterDigest !== "string" ||
    !DIGEST_PATTERN.test(record.filterDigest)
  ) {
    return encryptedUserSearchFailure();
  }
  return Object.freeze({
    searchId: record.searchId.toLowerCase(),
    claimExpiresAt: record.claimExpiresAt,
    requestDigest: expectedRequestDigest,
    filterDigest: record.filterDigest,
    generation: generationBinding(record.generation)
  });
}

/** Creates the exact one-RPC service-role capability used to mint search tickets. */
export function createEncryptedUserSearchCapabilityRpcClient(
  options: CapabilityClientOptions = {}
): ServiceRpcClient {
  return createServiceRpcClient({
    ...options,
    allowedFunctions: encryptedUserSearchCapabilityRpcFunctions,
    maximumResponseBytes: BEGIN_RESPONSE_MAX_BYTES
  });
}

export function createEncryptedUserSearchCapabilityRpcAdapter(
  client: ServiceRpcClient
): EncryptedUserSearchCapabilityRpcAdapter {
  return Object.freeze({
    async begin(input): Promise<BegunEncryptedUserSearch> {
      const candidate: unknown = input;
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return encryptedUserSearchFailure();
      }
      const record = candidate as UnknownRecord;
      const actualKeys = Object.keys(record).sort();
      const expectedKeys = ["claimSecretDigest", "filterManifest", "ownerId", "requestDigest"];
      if (
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index]) ||
        typeof record.ownerId !== "string" ||
        typeof record.requestDigest !== "string" ||
        typeof record.claimSecretDigest !== "string"
      ) {
        return encryptedUserSearchFailure();
      }
      const ownerId = record.ownerId.toLowerCase();
      const parsedFilters = EncryptedUserSearchFilterManifestSchema.safeParse(
        record.filterManifest
      );
      if (
        !UUID_PATTERN.test(ownerId) ||
        !DIGEST_PATTERN.test(record.requestDigest) ||
        !DIGEST_PATTERN.test(record.claimSecretDigest) ||
        !parsedFilters.success
      ) {
        return encryptedUserSearchFailure();
      }
      try {
        return begunSearch(
          await client.rpc("begin_encrypted_user_search", {
            p_owner_id: ownerId,
            p_request_digest: record.requestDigest,
            p_filter_manifest: parsedFilters.data,
            p_claim_secret_digest: record.claimSecretDigest
          }),
          record.requestDigest
        );
      } catch (error: unknown) {
        if (error instanceof EncryptedUserSearchError) throw error;
        return encryptedUserSearchFailure();
      }
    }
  });
}
