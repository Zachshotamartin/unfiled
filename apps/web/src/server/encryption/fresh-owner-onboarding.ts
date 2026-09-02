import type { RepositoryContext } from "@/server/product/repository";
import type {
  EncryptionRolloutState,
  EncryptionRolloutStateSource
} from "@/server/product/rollout-aware-repository";

import { withOwnerEncryptedAggregateRuntime } from "./encrypted-aggregate-runtime";
import { rolloutRpcFunctions, type ContentEncryptionRollout } from "./rollout-rpc-source";
import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";
import { createInteractiveWebKeyRuntime, type WebKeyRuntimeEnvironment } from "./web-key-runtime";

/**
 * Every owner starts in the `expanded` rollout state, which routes reads and
 * writes to the legacy environment-key adapter. Managed deployments deliberately
 * configure no legacy content key, so a brand-new owner could never write until
 * an operator drove the official rollout. This source performs that exact
 * sequence automatically, but only for owners the database reports as having
 * nothing to backfill or scrub: keys, `expanded → dual_write`, an empty
 * backfill, `dual_write → encrypted_read`, an empty plaintext scrub, and
 * `encrypted_read → encrypted_only`. Owners with legacy objects are never
 * touched; the database keeps enforcing every precondition.
 */
export const freshOwnerOnboardingRpcFunctions = Object.freeze([
  ...rolloutRpcFunctions,
  "advance_content_encryption_rollout",
  "complete_content_encryption_backfill",
  "prepare_content_plaintext_scrub",
  "scrub_content_plaintext_batch",
  "complete_content_plaintext_scrub"
] as const);

const ONBOARDABLE_STATES: ReadonlySet<EncryptionRolloutState> = new Set([
  "expanded",
  "dual_write",
  "encrypted_read"
]);
const DEFAULT_MAXIMUM_ATTEMPTS = 6;
const SCRUB_BATCH_LIMIT = 25;
const MAXIMUM_SCRUB_BATCHES = 8;

export type RolloutReader = Readonly<{
  rolloutForOwner(ownerId: string): Promise<ContentEncryptionRollout>;
}>;

export type FreshOwnerOnboardingOptions = Readonly<{
  /** Authoritative rollout reader; re-read after every transition. */
  rollout: RolloutReader;
  /** Service client allowlisted with exactly `freshOwnerOnboardingRpcFunctions`. */
  client: ServiceRpcClient;
  /** Registers and activates the owner's managed content keys before dual-write. */
  ensureOwnerKeys: (ownerId: string) => Promise<void>;
  /** False keeps the source a pure pass-through (legacy content keys configured). */
  enabled: boolean;
  createScrubId?: () => string;
  createBatchReference?: () => string;
  maximumAttempts?: number;
}>;

/** True when no legacy content key is configured, so `expanded` owners could never write. */
export function freshOwnerOnboardingEnabled(environment: WebKeyRuntimeEnvironment): boolean {
  const legacyKey = environment.UNFILED_CONTENT_KEK;
  return legacyKey === undefined || legacyKey.trim().length === 0;
}

/** True when the database reports nothing legacy to encrypt or scrub for this owner. */
export function isFreshOwnerRollout(rollout: ContentEncryptionRollout): boolean {
  return (
    ONBOARDABLE_STATES.has(rollout.state) &&
    rollout.readiness.requiredObjectCount === 0 &&
    rollout.readiness.missingObjectCount === 0
  );
}

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cursorOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  return unavailable();
}

function retryable(error: unknown): boolean {
  return (
    error instanceof ServiceRpcError && error.code === ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
  );
}

export class FreshOwnerOnboardingRolloutSource implements EncryptionRolloutStateSource {
  public constructor(private readonly options: FreshOwnerOnboardingOptions) {}

  public async stateForOwner(context: RepositoryContext): Promise<EncryptionRolloutState> {
    const rollout = await this.options.rollout.rolloutForOwner(context.userId);
    if (!this.options.enabled || !isFreshOwnerRollout(rollout)) return rollout.state;
    return this.onboard(context.userId, rollout);
  }

  private async onboard(
    ownerId: string,
    initial: ContentEncryptionRollout
  ): Promise<EncryptionRolloutState> {
    let current = initial;
    const attempts = this.options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.step(ownerId, current);
      } catch (error: unknown) {
        // A concurrent request may have advanced the same owner; the re-read below
        // resumes from the authoritative state instead of trusting a stale view.
        if (!retryable(error)) throw error;
      }
      current = await this.options.rollout.rolloutForOwner(ownerId);
      if (!isFreshOwnerRollout(current)) return current.state;
    }
    return unavailable();
  }

  private async step(ownerId: string, rollout: ContentEncryptionRollout): Promise<void> {
    if (rollout.state === "expanded") {
      await this.options.ensureOwnerKeys(ownerId);
      await this.advance(ownerId, "expanded", "dual_write");
      return;
    }
    if (rollout.state === "dual_write") {
      await this.completeBackfill(ownerId, rollout.backfill?.cursor ?? null);
      await this.advance(ownerId, "dual_write", "encrypted_read");
      return;
    }
    await this.completeScrub(ownerId, rollout);
    await this.advance(ownerId, "encrypted_read", "encrypted_only");
  }

  private async advance(
    ownerId: string,
    expected: EncryptionRolloutState,
    next: EncryptionRolloutState
  ): Promise<void> {
    const value = await this.options.client.rpc("advance_content_encryption_rollout", {
      p_owner_id: ownerId,
      p_expected_state: expected,
      p_next_state: next
    });
    if (!isRecord(value) || value.state !== next) unavailable();
  }

  private async completeBackfill(ownerId: string, cursor: string | null): Promise<void> {
    const reference = this.options.createBatchReference?.() ?? `fresh-owner-${crypto.randomUUID()}`;
    const value = await this.options.client.rpc("complete_content_encryption_backfill", {
      p_owner_id: ownerId,
      p_batch_reference: reference,
      p_expected_cursor: cursor
    });
    if (!isRecord(value) || value.complete !== true) unavailable();
  }

  private async completeScrub(ownerId: string, rollout: ContentEncryptionRollout): Promise<void> {
    if (rollout.plaintextScrub?.completedAt != null) return;
    let scrubId: string;
    let cursor: string | null;
    if (rollout.plaintextScrub === null) {
      scrubId = this.options.createScrubId?.() ?? crypto.randomUUID();
      await this.options.client.rpc("prepare_content_plaintext_scrub", {
        p_owner_id: ownerId,
        p_scrub_id: scrubId,
        p_expected_state: "encrypted_read"
      });
      cursor = null;
    } else {
      scrubId = rollout.plaintextScrub.scrubId;
      cursor = rollout.plaintextScrub.cursor;
    }
    for (let batch = 0; batch < MAXIMUM_SCRUB_BATCHES; batch += 1) {
      const value = await this.options.client.rpc("scrub_content_plaintext_batch", {
        p_owner_id: ownerId,
        p_scrub_id: scrubId,
        p_expected_cursor: cursor,
        p_limit: SCRUB_BATCH_LIMIT
      });
      if (!isRecord(value) || typeof value.complete !== "boolean") unavailable();
      cursor = cursorOrNull(value.cursor);
      if (value.complete) break;
      if (batch === MAXIMUM_SCRUB_BATCHES - 1) unavailable();
    }
    await this.options.client.rpc("complete_content_plaintext_scrub", {
      p_owner_id: ownerId,
      p_scrub_id: scrubId,
      p_expected_cursor: cursor
    });
  }
}

export type ManagedOwnerKeyBootstrapOptions = Readonly<{
  /** Service client allowlisted with `encryptedAggregateRuntimeRpcFunctions`. */
  client: ServiceRpcClient;
  environment?: WebKeyRuntimeEnvironment;
  signal?: AbortSignal;
}>;

/** Registers and activates the owner's managed content keys through the interactive runtime. */
export function createManagedOwnerKeyBootstrap(
  options: ManagedOwnerKeyBootstrapOptions
): (ownerId: string) => Promise<void> {
  return async (ownerId) => {
    const runtime = await createInteractiveWebKeyRuntime(
      options.environment === undefined ? {} : { environment: options.environment }
    );
    await withOwnerEncryptedAggregateRuntime(
      runtime,
      options.client,
      ownerId,
      { signal: options.signal ?? new AbortController().signal },
      () => Promise.resolve()
    );
  };
}
