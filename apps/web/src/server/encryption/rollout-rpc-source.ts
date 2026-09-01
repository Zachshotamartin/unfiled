import type { RepositoryContext } from "@/server/product/repository";
import {
  encryptionRolloutStates,
  type EncryptionRolloutState,
  type EncryptionRolloutStateSource
} from "@/server/product/rollout-aware-repository";

import type { ServiceRpcClient } from "./service-rpc-client";
import { ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const SURFACES = Object.freeze([
  "capture",
  "capture_receipt",
  "generated_block",
  "idempotency_response",
  "note_content",
  "note_mutation",
  "note_revision",
  "organization_decision",
  "organization_mutation_attempt",
  "review_item",
  "routing_rule",
  "space_display",
  "tag_display"
] as const);

type EncryptionSurface = (typeof SURFACES)[number];

export type ContentEncryptionReadiness = Readonly<{
  readyForEncryptedRead: boolean;
  requiredObjectCount: number;
  exactVerifiedObjectCount: number;
  missingObjectCount: number;
  missingBySurface: Readonly<Partial<Record<EncryptionSurface, number>>>;
  activeKeySlots: number;
  taxonomyEpochReady: boolean;
  backfillComplete: boolean;
}>;

export type ContentEncryptionRollout = Readonly<{
  found: boolean;
  state: EncryptionRolloutState;
  writeMode: "encrypted" | "legacy";
  readMode: "encrypted" | "legacy";
  backfill: Readonly<{
    cursor: string | null;
    complete: boolean;
    encryptedObjectCount: number;
    verifiedObjectCount: number;
  }> | null;
  plaintextScrub: Readonly<{
    scrubId: string;
    version: 1;
    startedAt: string;
    cursor: string | null;
    completedAt: string | null;
    scrubbedRowCount: number;
    deletedChunkCount: number;
    deletedIdempotencyCount: number;
    attestationDigest: string | null;
    lastRequestDigest: string | null;
    lastResultDigest: string | null;
  }> | null;
  readiness: ContentEncryptionReadiness;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function digestOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value));
}

function failClosed(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function rolloutState(value: unknown): EncryptionRolloutState {
  if (
    typeof value !== "string" ||
    !(encryptionRolloutStates as readonly string[]).includes(value)
  ) {
    return failClosed();
  }
  return value as EncryptionRolloutState;
}

function parseMissingBySurface(
  value: unknown,
  expectedMissing: number
): Readonly<Partial<Record<EncryptionSurface, number>>> {
  if (!isRecord(value)) return failClosed();
  let total = 0;
  const parsed: Partial<Record<EncryptionSurface, number>> = {};
  for (const [surface, count] of Object.entries(value)) {
    if (!(SURFACES as readonly string[]).includes(surface) || !isCount(count) || count === 0) {
      return failClosed();
    }
    parsed[surface as EncryptionSurface] = count;
    total += count;
    if (!Number.isSafeInteger(total)) return failClosed();
  }
  if (total !== expectedMissing) return failClosed();
  return Object.freeze(parsed);
}

function parseReadiness(value: unknown): ContentEncryptionReadiness {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "readyForEncryptedRead",
      "requiredObjectCount",
      "exactVerifiedObjectCount",
      "missingObjectCount",
      "missingBySurface",
      "activeKeySlots",
      "taxonomyEpochReady",
      "backfillComplete"
    ]) ||
    typeof value.readyForEncryptedRead !== "boolean" ||
    !isCount(value.requiredObjectCount) ||
    !isCount(value.exactVerifiedObjectCount) ||
    !isCount(value.missingObjectCount) ||
    !isCount(value.activeKeySlots) ||
    value.activeKeySlots > 4 ||
    typeof value.taxonomyEpochReady !== "boolean" ||
    typeof value.backfillComplete !== "boolean" ||
    value.exactVerifiedObjectCount + value.missingObjectCount !== value.requiredObjectCount
  ) {
    return failClosed();
  }
  const missingBySurface = parseMissingBySurface(value.missingBySurface, value.missingObjectCount);
  const necessaryReadyConditions =
    value.missingObjectCount === 0 &&
    value.activeKeySlots === 4 &&
    value.taxonomyEpochReady &&
    (value.backfillComplete || value.requiredObjectCount === 0);
  if (value.readyForEncryptedRead && !necessaryReadyConditions) return failClosed();
  return Object.freeze({
    readyForEncryptedRead: value.readyForEncryptedRead,
    requiredObjectCount: value.requiredObjectCount,
    exactVerifiedObjectCount: value.exactVerifiedObjectCount,
    missingObjectCount: value.missingObjectCount,
    missingBySurface,
    activeKeySlots: value.activeKeySlots,
    taxonomyEpochReady: value.taxonomyEpochReady,
    backfillComplete: value.backfillComplete
  });
}

function expectedModes(state: EncryptionRolloutState): Readonly<{
  writeMode: "encrypted" | "legacy";
  readMode: "encrypted" | "legacy";
}> {
  return {
    writeMode: state === "expanded" ? "legacy" : "encrypted",
    readMode: state === "expanded" || state === "dual_write" ? "legacy" : "encrypted"
  };
}

function parsePlaintextScrub(
  value: unknown,
  state: EncryptionRolloutState
): ContentEncryptionRollout["plaintextScrub"] {
  if (value === null) {
    if (state === "encrypted_only" || state === "contracted") return failClosed();
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "scrubId",
      "version",
      "startedAt",
      "cursor",
      "completedAt",
      "scrubbedRowCount",
      "deletedChunkCount",
      "deletedIdempotencyCount",
      "attestationDigest",
      "lastRequestDigest",
      "lastResultDigest"
    ]) ||
    typeof value.scrubId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.scrubId
    ) ||
    value.version !== 1 ||
    !validTimestamp(value.startedAt) ||
    (value.cursor !== null &&
      (typeof value.cursor !== "string" || value.cursor.length < 1 || value.cursor.length > 500)) ||
    (value.completedAt !== null && !validTimestamp(value.completedAt)) ||
    !isCount(value.scrubbedRowCount) ||
    !isCount(value.deletedChunkCount) ||
    !isCount(value.deletedIdempotencyCount) ||
    !digestOrNull(value.attestationDigest) ||
    !digestOrNull(value.lastRequestDigest) ||
    !digestOrNull(value.lastResultDigest) ||
    (value.lastRequestDigest === null) !== (value.lastResultDigest === null) ||
    (value.completedAt === null) !== (value.attestationDigest === null) ||
    state === "expanded" ||
    state === "dual_write" ||
    ((state === "encrypted_only" || state === "contracted") && value.completedAt === null)
  ) {
    return failClosed();
  }
  return Object.freeze({
    scrubId: value.scrubId,
    version: 1,
    startedAt: value.startedAt,
    cursor: value.cursor,
    completedAt: value.completedAt,
    scrubbedRowCount: value.scrubbedRowCount,
    deletedChunkCount: value.deletedChunkCount,
    deletedIdempotencyCount: value.deletedIdempotencyCount,
    attestationDigest: value.attestationDigest,
    lastRequestDigest: value.lastRequestDigest,
    lastResultDigest: value.lastResultDigest
  });
}

export function parseContentEncryptionRollout(value: unknown): ContentEncryptionRollout {
  if (!isRecord(value) || typeof value.found !== "boolean") return failClosed();
  const priorKeys = value.found
    ? ["found", "state", "writeMode", "readMode", "backfill", "readiness"]
    : ["found", "state", "writeMode", "readMode", "readiness"];
  const scrubKeys = value.found
    ? [...priorKeys, "plaintextScrub"]
    : [...priorKeys, "backfill", "plaintextScrub"];
  const hasScrubProjection = hasExactKeys(value, scrubKeys);
  if (!hasScrubProjection && !hasExactKeys(value, priorKeys)) return failClosed();
  const state = rolloutState(value.state);
  const modes = expectedModes(state);
  if (value.writeMode !== modes.writeMode || value.readMode !== modes.readMode) {
    return failClosed();
  }
  const readiness = parseReadiness(value.readiness);
  if (!value.found) {
    if (
      state !== "expanded" ||
      (hasScrubProjection && (value.backfill !== null || value.plaintextScrub !== null))
    ) {
      return failClosed();
    }
    return Object.freeze({
      found: false,
      state,
      ...modes,
      backfill: null,
      plaintextScrub: null,
      readiness
    });
  }
  if (
    !isRecord(value.backfill) ||
    !hasExactKeys(value.backfill, [
      "cursor",
      "complete",
      "encryptedObjectCount",
      "verifiedObjectCount"
    ]) ||
    (value.backfill.cursor !== null &&
      (typeof value.backfill.cursor !== "string" || value.backfill.cursor.length > 500)) ||
    typeof value.backfill.complete !== "boolean" ||
    !isCount(value.backfill.encryptedObjectCount) ||
    !isCount(value.backfill.verifiedObjectCount) ||
    value.backfill.verifiedObjectCount > value.backfill.encryptedObjectCount ||
    value.backfill.complete !== readiness.backfillComplete
  ) {
    return failClosed();
  }
  const plaintextScrub = hasScrubProjection
    ? parsePlaintextScrub(value.plaintextScrub, state)
    : null;
  if (!hasScrubProjection && (state === "encrypted_only" || state === "contracted")) {
    return failClosed();
  }
  return Object.freeze({
    found: true,
    state,
    ...modes,
    backfill: Object.freeze({
      cursor: value.backfill.cursor,
      complete: value.backfill.complete,
      encryptedObjectCount: value.backfill.encryptedObjectCount,
      verifiedObjectCount: value.backfill.verifiedObjectCount
    }),
    plaintextScrub,
    readiness
  });
}

export class ContentEncryptionRolloutRpcSource implements EncryptionRolloutStateSource {
  public constructor(private readonly client: ServiceRpcClient) {}

  public async rolloutForOwner(ownerId: string): Promise<ContentEncryptionRollout> {
    return parseContentEncryptionRollout(
      await this.client.rpc("get_content_encryption_rollout", { p_owner_id: ownerId })
    );
  }

  public async stateForOwner(context: RepositoryContext): Promise<EncryptionRolloutState> {
    return (await this.rolloutForOwner(context.userId)).state;
  }
}

export const rolloutRpcFunctions = Object.freeze(["get_content_encryption_rollout"] as const);
