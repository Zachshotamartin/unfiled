import { RAG_GENERATION_VERIFICATION_NOTE_CAPACITY } from "@unfiled/contracts";

import { ServiceRpcError, ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";

import {
  IndexVerifierGenerationInvalidError,
  IndexVerifierInvocationError,
  type IndexVerifierClient
} from "./index-verifier-client";
import type { IndexWorkerClient } from "./index-worker-client";
import { drainIndexWorkerUntilIdle } from "./index-worker-drain";
import {
  RagMaintenanceAction,
  RagMaintenancePhase,
  type BuildingRagGeneration,
  type EnsuredRagGeneration,
  type RagGenerationLifecycleStore,
  type RagGenerationTarget,
  type RagMaintenanceCandidate,
  type RagMaintenanceCursor,
  type RagMaintenancePhaseValue,
  type RagMaintenancePage,
  type RagSeedCursor,
  type SeededRagGeneration
} from "./rag-generation-lifecycle-store";

const GENERATION_ID_PATTERN = /^igen_[0-9A-HJKMNP-TV-Z]{26}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_CANDIDATE_PAGE_LIMIT = 100;
const MAX_CANDIDATE_PAGES = 8;
const MAX_SEED_PAGE_LIMIT = 100;
const MAX_SEED_PAGES_PER_GENERATION = 100;
const MAX_DRAIN_WAVES = 8;

export const defaultRagGenerationMaintenanceBounds = Object.freeze({
  candidatePageLimit: 10,
  maxCandidatePages: 2,
  maxDrainWaves: 4,
  maxSeedPagesPerGeneration: 8,
  seedPageLimit: 100
});

export type RagGenerationMaintenanceBounds = Readonly<{
  candidatePageLimit: number;
  maxCandidatePages: number;
  maxDrainWaves: number;
  maxSeedPagesPerGeneration: number;
  seedPageLimit: number;
}>;

export type RagGenerationMaintenanceResult = Readonly<{
  activatedGenerations: number;
  capacityDeferrals: number;
  capacityGenerationsFailed: number;
  candidatePages: number;
  candidatesDeferred: number;
  candidatesSeen: number;
  createdGenerations: number;
  drainClaimed: number;
  drainCompleted: number;
  drainFailed: number;
  drainRetryScheduled: number;
  drainWaves: number;
  invalidGenerationsFailed: number;
  readinessGenerationsFailed: number;
  replacedGenerations: number;
  resumedGenerations: number;
  seedCandidateRetryFailures: number;
  seedCandidatePagesTruncated: number;
  seedEnqueued: number;
  seedExamined: number;
  seedGenerationsBlocked: number;
  seedGenerationsComplete: number;
  seedGenerationsTruncated: number;
  seedPages: number;
  verificationCandidatePagesTruncated: number;
  verificationCandidateRetryFailures: number;
  verificationDeferred: number;
  verificationPages: number;
  verifiedGenerations: number;
}>;

export type RagGenerationMaintenanceDependencies = Readonly<{
  bounds?: Partial<RagGenerationMaintenanceBounds>;
  createBatchId?: () => string;
  createGenerationId?: () => string;
  createPageRequestId?: () => string;
  lifecycle: RagGenerationLifecycleStore;
  signal: AbortSignal;
  target: RagGenerationTarget;
  verifier: IndexVerifierClient;
  worker: IndexWorkerClient;
}>;

export class RagGenerationMaintenanceError extends Error {
  public constructor() {
    super("Encrypted index generation maintenance could not complete.");
    this.name = "RagGenerationMaintenanceError";
  }
}

type MutableMaintenanceResult = {
  -readonly [Key in keyof RagGenerationMaintenanceResult]: RagGenerationMaintenanceResult[Key];
};

type SeedGenerationResult = Readonly<{
  blocked: boolean;
  complete: boolean;
  overCapacity: boolean;
  pages: number;
  revisionToken: string;
}>;

function failClosed(): never {
  throw new RagGenerationMaintenanceError();
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) failClosed();
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) failClosed();
  return value;
}

function resolveBounds(
  values: Partial<RagGenerationMaintenanceBounds> | undefined
): RagGenerationMaintenanceBounds {
  return Object.freeze({
    candidatePageLimit: boundedInteger(
      values?.candidatePageLimit ?? defaultRagGenerationMaintenanceBounds.candidatePageLimit,
      1,
      MAX_CANDIDATE_PAGE_LIMIT
    ),
    maxCandidatePages: boundedInteger(
      values?.maxCandidatePages ?? defaultRagGenerationMaintenanceBounds.maxCandidatePages,
      1,
      MAX_CANDIDATE_PAGES
    ),
    maxDrainWaves: boundedInteger(
      values?.maxDrainWaves ?? defaultRagGenerationMaintenanceBounds.maxDrainWaves,
      1,
      MAX_DRAIN_WAVES
    ),
    maxSeedPagesPerGeneration: boundedInteger(
      values?.maxSeedPagesPerGeneration ??
        defaultRagGenerationMaintenanceBounds.maxSeedPagesPerGeneration,
      1,
      MAX_SEED_PAGES_PER_GENERATION
    ),
    seedPageLimit: boundedInteger(
      values?.seedPageLimit ?? defaultRagGenerationMaintenanceBounds.seedPageLimit,
      1,
      MAX_SEED_PAGE_LIMIT
    )
  });
}

function emptyResult(): MutableMaintenanceResult {
  return {
    activatedGenerations: 0,
    capacityDeferrals: 0,
    capacityGenerationsFailed: 0,
    candidatePages: 0,
    candidatesDeferred: 0,
    candidatesSeen: 0,
    createdGenerations: 0,
    drainClaimed: 0,
    drainCompleted: 0,
    drainFailed: 0,
    drainRetryScheduled: 0,
    drainWaves: 0,
    invalidGenerationsFailed: 0,
    readinessGenerationsFailed: 0,
    replacedGenerations: 0,
    resumedGenerations: 0,
    seedCandidateRetryFailures: 0,
    seedCandidatePagesTruncated: 0,
    seedEnqueued: 0,
    seedExamined: 0,
    seedGenerationsBlocked: 0,
    seedGenerationsComplete: 0,
    seedGenerationsTruncated: 0,
    seedPages: 0,
    verificationCandidatePagesTruncated: 0,
    verificationCandidateRetryFailures: 0,
    verificationDeferred: 0,
    verificationPages: 0,
    verifiedGenerations: 0
  };
}

function retryableAmbiguity(error: unknown): boolean {
  return (
    (error instanceof ServiceRpcError && error.code === ServiceRpcErrorCode.PROVIDER_UNAVAILABLE) ||
    error instanceof IndexVerifierInvocationError
  );
}

async function replayOnce<Result>(
  signal: AbortSignal,
  operation: () => Promise<Result>
): Promise<Result> {
  assertNotAborted(signal);
  try {
    return await operation();
  } catch (error: unknown) {
    if (signal.aborted || !retryableAmbiguity(error)) throw error;
    assertNotAborted(signal);
    return operation();
  }
}

function sameTarget(left: RagGenerationTarget, right: RagGenerationTarget): boolean {
  return (
    left.embeddingModelId === right.embeddingModelId &&
    left.embeddingDimensions === right.embeddingDimensions
  );
}

function readyForIndexing(candidate: RagMaintenanceCandidate): boolean {
  return candidate.rolloutState !== "expanded" && candidate.aiObjectWrapKeyReady;
}

function nextRevision(value: string, previous: string): boolean {
  return BigInt(value) === BigInt(previous) + 1n;
}

function validBuildingTarget(
  generation: BuildingRagGeneration | EnsuredRagGeneration,
  target: RagGenerationTarget
): boolean {
  return (
    generation.embeddingModelId === target.embeddingModelId &&
    generation.embeddingDimensions === target.embeddingDimensions &&
    generation.expectedNoteCount >= generation.indexedNoteCount
  );
}

function exceedsVerificationCapacity(candidate: RagMaintenanceCandidate): boolean {
  return (
    candidate.eligibleNoteCount > RAG_GENERATION_VERIFICATION_NOTE_CAPACITY ||
    (candidate.buildingGeneration?.expectedNoteCount ?? 0) >
      RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
  );
}

async function failBuildingGeneration(
  dependencies: Pick<RagGenerationMaintenanceDependencies, "lifecycle" | "signal">,
  ownerId: string,
  generation: Readonly<{ generationId: string; revisionToken: string }>
): Promise<void> {
  const failed = await replayOnce(dependencies.signal, () =>
    dependencies.lifecycle.failGeneration({
      ownerId,
      generationId: generation.generationId,
      expectedRevisionToken: generation.revisionToken,
      failureCode: "validation_failed"
    })
  );
  if (
    failed.generationId !== generation.generationId ||
    failed.failureCode !== "validation_failed" ||
    !nextRevision(failed.revisionToken, generation.revisionToken)
  ) {
    failClosed();
  }
}

async function visitCandidatePages(
  dependencies: Pick<RagGenerationMaintenanceDependencies, "lifecycle" | "signal" | "target">,
  bounds: RagGenerationMaintenanceBounds,
  phase: RagMaintenancePhaseValue,
  createPageRequestId: () => string,
  visit: (candidate: RagMaintenanceCandidate) => Promise<void>,
  onCandidateRetryFailure: () => void,
  onPage: () => void
): Promise<boolean> {
  let cursor: RagMaintenanceCursor | null = null;
  let lastOwnerId: string | null = null;
  for (let pageNumber = 0; pageNumber < bounds.maxCandidatePages; pageNumber += 1) {
    assertNotAborted(dependencies.signal);
    const requestedCursor: RagMaintenanceCursor | null = cursor;
    const pageRequestId = createPageRequestId();
    if (!UUID_PATTERN.test(pageRequestId)) failClosed();
    const request: Parameters<RagGenerationLifecycleStore["listMaintenanceCandidates"]>[0] =
      Object.freeze({
        embeddingModelId: dependencies.target.embeddingModelId,
        embeddingDimensions: dependencies.target.embeddingDimensions,
        phase,
        pageRequestId,
        cursor: requestedCursor,
        limit: bounds.candidatePageLimit
      });
    const page: RagMaintenancePage = await replayOnce<RagMaintenancePage>(dependencies.signal, () =>
      dependencies.lifecycle.listMaintenanceCandidates(request)
    );
    onPage();
    if (
      !sameTarget(page.target, dependencies.target) ||
      (requestedCursor !== null &&
        BigInt(page.page.checkpointRevision) !== BigInt(requestedCursor.checkpointRevision) + 1n)
    ) {
      failClosed();
    }
    for (const candidate of page.candidates) {
      if (lastOwnerId !== null && candidate.ownerId <= lastOwnerId) failClosed();
      lastOwnerId = candidate.ownerId;
      try {
        await visit(candidate);
      } catch (error: unknown) {
        if (dependencies.signal.aborted || !retryableAmbiguity(error)) throw error;
        onCandidateRetryFailure();
      }
    }
    if (!page.page.hasMore) return false;
    const nextCursor = page.page.nextCursor;
    if (nextCursor === null) failClosed();
    if (
      page.candidates.length === 0 ||
      nextCursor.embeddingModelId !== dependencies.target.embeddingModelId ||
      nextCursor.embeddingDimensions !== dependencies.target.embeddingDimensions ||
      nextCursor.phase !== phase ||
      nextCursor.checkpointRevision !== page.page.checkpointRevision ||
      nextCursor.afterOwnerId !== lastOwnerId ||
      (requestedCursor !== null && nextCursor.afterOwnerId <= requestedCursor.afterOwnerId)
    ) {
      failClosed();
    }
    cursor = nextCursor;
  }
  return cursor !== null;
}

async function ensureNewGeneration(
  dependencies: RagGenerationMaintenanceDependencies,
  candidate: RagMaintenanceCandidate,
  createGenerationId: () => string
): Promise<EnsuredRagGeneration> {
  const generationId = createGenerationId();
  if (!GENERATION_ID_PATTERN.test(generationId)) failClosed();
  const ensured = await replayOnce(dependencies.signal, () =>
    dependencies.lifecycle.ensureGeneration({
      ownerId: candidate.ownerId,
      generationId,
      embeddingModelId: dependencies.target.embeddingModelId,
      embeddingDimensions: dependencies.target.embeddingDimensions
    })
  );
  if (
    ensured.generationId !== generationId ||
    ensured.state !== "building" ||
    !validBuildingTarget(ensured, dependencies.target)
  ) {
    failClosed();
  }
  return ensured;
}

async function prepareGeneration(
  dependencies: RagGenerationMaintenanceDependencies,
  candidate: RagMaintenanceCandidate,
  createGenerationId: () => string,
  result: MutableMaintenanceResult
): Promise<BuildingRagGeneration | EnsuredRagGeneration> {
  if (candidate.action === RagMaintenanceAction.RESUME_BUILD) {
    if (
      candidate.buildingGeneration === null ||
      !validBuildingTarget(candidate.buildingGeneration, dependencies.target)
    ) {
      return failClosed();
    }
    result.resumedGenerations += 1;
    return candidate.buildingGeneration;
  }

  if (candidate.action === RagMaintenanceAction.REPLACE_BUILD) {
    const existing = candidate.buildingGeneration;
    if (existing === null) return failClosed();
    await failBuildingGeneration(dependencies, candidate.ownerId, existing);
    const ensured = await ensureNewGeneration(dependencies, candidate, createGenerationId);
    result.replacedGenerations += 1;
    return ensured;
  }

  if (candidate.buildingGeneration !== null) {
    return failClosed();
  }
  const ensured = await ensureNewGeneration(dependencies, candidate, createGenerationId);
  result.createdGenerations += 1;
  return ensured;
}

function validateSeedResponse(
  seeded: SeededRagGeneration,
  generationId: string,
  batchId: string,
  previousRevisionToken: string
): void {
  if (
    seeded.generationId !== generationId ||
    seeded.batchId !== batchId ||
    (seeded.revisionToken !== previousRevisionToken &&
      !nextRevision(seeded.revisionToken, previousRevisionToken)) ||
    (seeded.blocked &&
      (seeded.failureCode !== "validation_failed" ||
        seeded.revisionToken !== previousRevisionToken ||
        seeded.examinedCount !== 0 ||
        seeded.enqueuedCount !== 0 ||
        seeded.hasMore ||
        seeded.complete ||
        seeded.nextCursor !== null)) ||
    (!seeded.blocked && (seeded.failureCode !== null || seeded.complete === seeded.hasMore)) ||
    (seeded.nextCursor !== null &&
      (seeded.nextCursor.generationId !== generationId ||
        seeded.nextCursor.revisionToken !== seeded.revisionToken))
  ) {
    failClosed();
  }
}

async function seedGeneration(
  dependencies: RagGenerationMaintenanceDependencies,
  bounds: RagGenerationMaintenanceBounds,
  candidate: RagMaintenanceCandidate,
  generation: BuildingRagGeneration | EnsuredRagGeneration,
  createBatchId: () => string,
  result: MutableMaintenanceResult
): Promise<SeedGenerationResult> {
  let cursor: RagSeedCursor | null = null;
  let revisionToken = generation.revisionToken;
  for (let page = 0; page < bounds.maxSeedPagesPerGeneration; page += 1) {
    assertNotAborted(dependencies.signal);
    const batchId = createBatchId();
    if (!UUID_PATTERN.test(batchId)) failClosed();
    const request: Parameters<RagGenerationLifecycleStore["seedGeneration"]>[0] = Object.freeze({
      ownerId: candidate.ownerId,
      generationId: generation.generationId,
      expectedRevisionToken: revisionToken,
      batchId,
      cursor,
      limit: bounds.seedPageLimit
    });
    const seeded: SeededRagGeneration = await replayOnce<SeededRagGeneration>(
      dependencies.signal,
      () => dependencies.lifecycle.seedGeneration(request)
    );
    validateSeedResponse(seeded, generation.generationId, batchId, revisionToken);
    result.seedPages += 1;
    result.seedExamined += seeded.examinedCount;
    result.seedEnqueued += seeded.enqueuedCount;
    revisionToken = seeded.revisionToken;
    cursor = seeded.nextCursor;
    if (seeded.blocked) {
      return Object.freeze({
        blocked: true,
        complete: false,
        overCapacity: false,
        pages: page + 1,
        revisionToken
      });
    }
    if (seeded.eligibleNoteCount > RAG_GENERATION_VERIFICATION_NOTE_CAPACITY) {
      return Object.freeze({
        blocked: false,
        complete: false,
        overCapacity: true,
        pages: page + 1,
        revisionToken
      });
    }
    if (seeded.complete) {
      return Object.freeze({
        blocked: false,
        complete: true,
        overCapacity: false,
        pages: page + 1,
        revisionToken
      });
    }
    if (cursor === null) failClosed();
  }
  return Object.freeze({
    blocked: false,
    complete: false,
    overCapacity: false,
    pages: bounds.maxSeedPagesPerGeneration,
    revisionToken
  });
}

async function seedCandidate(
  dependencies: RagGenerationMaintenanceDependencies,
  bounds: RagGenerationMaintenanceBounds,
  candidate: RagMaintenanceCandidate,
  createGenerationId: () => string,
  createBatchId: () => string,
  result: MutableMaintenanceResult
): Promise<void> {
  result.candidatesSeen += 1;
  if (exceedsVerificationCapacity(candidate)) {
    result.capacityDeferrals += 1;
    result.candidatesDeferred += 1;
    if (candidate.buildingGeneration !== null) {
      await failBuildingGeneration(dependencies, candidate.ownerId, candidate.buildingGeneration);
      result.capacityGenerationsFailed += 1;
    }
    return;
  }
  if (!readyForIndexing(candidate)) {
    result.candidatesDeferred += 1;
    if (candidate.buildingGeneration !== null) {
      await failBuildingGeneration(dependencies, candidate.ownerId, candidate.buildingGeneration);
      result.readinessGenerationsFailed += 1;
    }
    return;
  }
  const generation = await prepareGeneration(dependencies, candidate, createGenerationId, result);
  if (generation.expectedNoteCount > RAG_GENERATION_VERIFICATION_NOTE_CAPACITY) {
    await failBuildingGeneration(dependencies, candidate.ownerId, generation);
    result.capacityDeferrals += 1;
    result.capacityGenerationsFailed += 1;
    result.candidatesDeferred += 1;
    return;
  }
  const seeded = await seedGeneration(
    dependencies,
    bounds,
    candidate,
    generation,
    createBatchId,
    result
  );
  if (seeded.blocked || seeded.overCapacity) {
    await failBuildingGeneration(dependencies, candidate.ownerId, {
      generationId: generation.generationId,
      revisionToken: seeded.revisionToken
    });
    if (seeded.blocked) result.seedGenerationsBlocked += 1;
    else {
      result.capacityDeferrals += 1;
      result.capacityGenerationsFailed += 1;
    }
    result.candidatesDeferred += 1;
    return;
  }
  if (seeded.complete) result.seedGenerationsComplete += 1;
  else result.seedGenerationsTruncated += 1;
}

async function verifyCandidate(
  dependencies: RagGenerationMaintenanceDependencies,
  candidate: RagMaintenanceCandidate,
  result: MutableMaintenanceResult
): Promise<void> {
  if (exceedsVerificationCapacity(candidate)) {
    result.capacityDeferrals += 1;
    result.verificationDeferred += 1;
    if (candidate.buildingGeneration !== null) {
      await failBuildingGeneration(dependencies, candidate.ownerId, candidate.buildingGeneration);
      result.capacityGenerationsFailed += 1;
    }
    return;
  }
  if (!readyForIndexing(candidate)) {
    result.verificationDeferred += 1;
    if (candidate.buildingGeneration !== null) {
      await failBuildingGeneration(dependencies, candidate.ownerId, candidate.buildingGeneration);
      result.readinessGenerationsFailed += 1;
    }
    return;
  }
  const generation = candidate.buildingGeneration;
  if (
    generation === null ||
    !validBuildingTarget(generation, dependencies.target) ||
    generation.indexedNoteCount !== generation.expectedNoteCount
  ) {
    result.verificationDeferred += 1;
    return;
  }
  let verified: Awaited<ReturnType<IndexVerifierClient["verify"]>>;
  try {
    verified = await replayOnce(dependencies.signal, () =>
      dependencies.verifier.verify(
        {
          ownerId: candidate.ownerId,
          generationId: generation.generationId,
          revisionToken: generation.revisionToken
        },
        dependencies.signal
      )
    );
  } catch (error: unknown) {
    if (!(error instanceof IndexVerifierGenerationInvalidError)) throw error;
    await failBuildingGeneration(dependencies, candidate.ownerId, generation);
    result.invalidGenerationsFailed += 1;
    result.verificationDeferred += 1;
    return;
  }
  if (
    verified.generationId !== generation.generationId ||
    verified.revisionToken !== generation.revisionToken ||
    verified.verifiedNoteCount !== generation.expectedNoteCount
  ) {
    failClosed();
  }
  result.verifiedGenerations += 1;
  const activated = await replayOnce(dependencies.signal, () =>
    dependencies.lifecycle.activateGeneration({
      ownerId: candidate.ownerId,
      generationId: verified.generationId,
      expectedRevisionToken: verified.revisionToken
    })
  );
  if (
    activated.generationId !== verified.generationId ||
    !nextRevision(activated.revisionToken, verified.revisionToken)
  ) {
    failClosed();
  }
  result.activatedGenerations += 1;
}

export async function runRagGenerationMaintenance(
  dependencies: RagGenerationMaintenanceDependencies
): Promise<RagGenerationMaintenanceResult> {
  const bounds = resolveBounds(dependencies.bounds);
  const createGenerationId = dependencies.createGenerationId ?? createRagGenerationId;
  const createBatchId = dependencies.createBatchId ?? (() => crypto.randomUUID());
  const createPageRequestId = dependencies.createPageRequestId ?? (() => crypto.randomUUID());
  const result = emptyResult();
  const seedPagesTruncated = await visitCandidatePages(
    dependencies,
    bounds,
    RagMaintenancePhase.SEED,
    createPageRequestId,
    (candidate) =>
      seedCandidate(dependencies, bounds, candidate, createGenerationId, createBatchId, result),
    () => {
      result.seedCandidateRetryFailures += 1;
    },
    () => {
      result.candidatePages += 1;
    }
  );
  if (seedPagesTruncated) result.seedCandidatePagesTruncated += 1;

  if (result.seedGenerationsComplete + result.seedGenerationsTruncated > 0) {
    assertNotAborted(dependencies.signal);
    const drained = await drainIndexWorkerUntilIdle({
      client: dependencies.worker,
      maxWaves: bounds.maxDrainWaves,
      signal: dependencies.signal,
      trigger: "schedule"
    });
    result.drainWaves = drained.waves;
    result.drainClaimed = drained.claimed;
    result.drainCompleted = drained.completed;
    result.drainFailed = drained.failed;
    result.drainRetryScheduled = drained.retryScheduled;
  }

  const verificationPagesTruncated = await visitCandidatePages(
    dependencies,
    bounds,
    RagMaintenancePhase.VERIFY,
    createPageRequestId,
    (candidate) => verifyCandidate(dependencies, candidate, result),
    () => {
      result.verificationCandidateRetryFailures += 1;
    },
    () => {
      result.verificationPages += 1;
    }
  );
  if (verificationPagesTruncated) result.verificationCandidatePagesTruncated += 1;
  assertNotAborted(dependencies.signal);
  return Object.freeze({ ...result });
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createRagGenerationId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 281_474_976_710_655) failClosed();
  let timestamp = BigInt(now);
  let encodedTime = "";
  for (let index = 0; index < 10; index += 1) {
    encodedTime = `${CROCKFORD_BASE32.charAt(Number(timestamp % 32n))}${encodedTime}`;
    timestamp /= 32n;
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let encodedRandom = "";
  for (const value of random) encodedRandom += CROCKFORD_BASE32.charAt(value & 31);
  random.fill(0);
  return `igen_${encodedTime}${encodedRandom}`;
}
