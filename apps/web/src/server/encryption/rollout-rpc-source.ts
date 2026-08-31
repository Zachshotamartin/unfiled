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

export function parseContentEncryptionRollout(value: unknown): ContentEncryptionRollout {
  if (!isRecord(value) || typeof value.found !== "boolean") return failClosed();
  const keys = value.found
    ? ["found", "state", "writeMode", "readMode", "backfill", "readiness"]
    : ["found", "state", "writeMode", "readMode", "readiness"];
  if (!hasExactKeys(value, keys)) return failClosed();
  const state = rolloutState(value.state);
  const modes = expectedModes(state);
  if (value.writeMode !== modes.writeMode || value.readMode !== modes.readMode) {
    return failClosed();
  }
  const readiness = parseReadiness(value.readiness);
  if (!value.found) {
    if (state !== "expanded") return failClosed();
    return Object.freeze({ found: false, state, ...modes, backfill: null, readiness });
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
