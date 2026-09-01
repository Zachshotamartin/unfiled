import {
  encryptionRolloutStates,
  type EncryptionRolloutState
} from "@/server/product/rollout-aware-repository";
import type { ServiceRpcClient } from "@/server/encryption/service-rpc-client";

const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION_ID_PATTERN = /^igen_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NOTE_ID_PATTERN = /^note_[0-9A-HJKMNP-TV-Z]{26}$/u;
const REVISION_TOKEN_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const UUID_PATTERN = OWNER_ID_PATTERN;
const MAX_INT64 = 9_223_372_036_854_775_807n;

export const RagMaintenanceAction = Object.freeze({
  CREATE_BUILD: "create_build",
  REPLACE_BUILD: "replace_build",
  RESUME_BUILD: "resume_build"
} as const);

export type RagMaintenanceActionValue =
  (typeof RagMaintenanceAction)[keyof typeof RagMaintenanceAction];

export type RagGenerationTarget = Readonly<{
  embeddingModelId: string;
  embeddingDimensions: number;
  envelopeSchemaVersion: 1;
}>;

export const RagMaintenancePhase = Object.freeze({
  SEED: "seed",
  VERIFY: "verify"
} as const);

export type RagMaintenancePhaseValue =
  (typeof RagMaintenancePhase)[keyof typeof RagMaintenancePhase];

export type RagMaintenanceTarget = RagGenerationTarget &
  Readonly<{
    phase: RagMaintenancePhaseValue;
  }>;

export type ActiveRagGeneration = Readonly<{
  generationId: string;
  embeddingModelId: string;
  embeddingDimensions: number;
  revisionToken: string;
}>;

export type BuildingRagGeneration = ActiveRagGeneration &
  Readonly<{
    expectedNoteCount: number;
    indexedNoteCount: number;
  }>;

export type RagMaintenanceCandidate = Readonly<{
  ownerId: string;
  rolloutState: EncryptionRolloutState;
  eligibleNoteCount: number;
  aiObjectWrapKeyReady: boolean;
  action: RagMaintenanceActionValue;
  activeGeneration: ActiveRagGeneration | null;
  buildingGeneration: BuildingRagGeneration | null;
}>;

export type RagMaintenanceCursor = Readonly<{
  embeddingModelId: string;
  embeddingDimensions: number;
  phase: RagMaintenancePhaseValue;
  checkpointRevision: string;
  afterOwnerId: string;
}>;

export type RagMaintenancePage = Readonly<{
  target: RagMaintenanceTarget;
  candidates: readonly RagMaintenanceCandidate[];
  page: Readonly<{
    requestId: string;
    checkpointRevision: string;
    limit: number;
    returnedCount: number;
    hasMore: boolean;
    nextCursor: RagMaintenanceCursor | null;
    replayed: boolean;
  }>;
}>;

export type EnsuredRagGeneration = Readonly<{
  generationId: string;
  state: "active" | "building";
  embeddingModelId: string;
  embeddingDimensions: number;
  envelopeSchemaVersion: 1;
  expectedNoteCount: number;
  indexedNoteCount: number;
  revisionToken: string;
  replayed: boolean;
}>;

export type RagSeedCursor = Readonly<{
  generationId: string;
  revisionToken: string;
  afterNoteId: string;
}>;

export type SeededRagGeneration = Readonly<{
  batchId: string;
  generationId: string;
  revisionToken: string;
  eligibleNoteCount: number;
  examinedCount: number;
  enqueuedCount: number;
  hasMore: boolean;
  complete: boolean;
  nextCursor: RagSeedCursor | null;
  blocked: boolean;
  failureCode: "validation_failed" | null;
  replayed: boolean;
}>;

export type FailedRagGeneration = Readonly<{
  generationId: string;
  state: "failed";
  revisionToken: string;
  failureCode: "validation_failed" | "provider_unavailable";
  replayed: boolean;
}>;

export type ActivatedRagGeneration = Readonly<{
  generationId: string;
  revisionToken: string;
  coverageVerified: true;
  replayed: boolean;
}>;

export type RagGenerationLifecycleStore = Readonly<{
  listMaintenanceCandidates(
    input: Readonly<{
      embeddingModelId: string;
      embeddingDimensions: number;
      phase: RagMaintenancePhaseValue;
      pageRequestId: string;
      cursor: RagMaintenanceCursor | null;
      limit: number;
    }>
  ): Promise<RagMaintenancePage>;
  ensureGeneration(
    input: Readonly<{
      ownerId: string;
      generationId: string;
      embeddingModelId: string;
      embeddingDimensions: number;
    }>
  ): Promise<EnsuredRagGeneration>;
  seedGeneration(
    input: Readonly<{
      ownerId: string;
      generationId: string;
      expectedRevisionToken: string;
      batchId: string;
      cursor: RagSeedCursor | null;
      limit: number;
    }>
  ): Promise<SeededRagGeneration>;
  failGeneration(
    input: Readonly<{
      ownerId: string;
      generationId: string;
      expectedRevisionToken: string;
      failureCode: "validation_failed" | "provider_unavailable";
    }>
  ): Promise<FailedRagGeneration>;
  activateGeneration(
    input: Readonly<{
      ownerId: string;
      generationId: string;
      expectedRevisionToken: string;
    }>
  ): Promise<ActivatedRagGeneration>;
}>;

export class RagGenerationLifecycleContractError extends Error {
  public constructor() {
    super("The encrypted index lifecycle service returned an invalid response.");
    this.name = "RagGenerationLifecycleContractError";
  }
}

function failClosed(): never {
  throw new RagGenerationLifecycleContractError();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return failClosed();
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || !actual.every((key, index) => key === wanted[index])) {
    failClosed();
  }
}

function count(value: unknown, maximum = 2_147_483_647): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return failClosed();
  }
  return value;
}

function revisionToken(value: unknown): string {
  if (typeof value !== "string" || !REVISION_TOKEN_PATTERN.test(value)) return failClosed();
  try {
    if (BigInt(value) > MAX_INT64) return failClosed();
  } catch {
    return failClosed();
  }
  return value;
}

function modelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    hasAsciiControlCharacter(value)
  ) {
    return failClosed();
  }
  return value;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function dimensions(value: unknown): number {
  const parsed = count(value, 4_096);
  if (parsed < 1) return failClosed();
  return parsed;
}

function activeGeneration(value: unknown): ActiveRagGeneration | null {
  if (value === null) return null;
  const parsed = record(value);
  exactKeys(parsed, ["generationId", "embeddingModelId", "embeddingDimensions", "revisionToken"]);
  if (typeof parsed.generationId !== "string" || !GENERATION_ID_PATTERN.test(parsed.generationId)) {
    return failClosed();
  }
  return Object.freeze({
    generationId: parsed.generationId,
    embeddingModelId: modelId(parsed.embeddingModelId),
    embeddingDimensions: dimensions(parsed.embeddingDimensions),
    revisionToken: revisionToken(parsed.revisionToken)
  });
}

function buildingGeneration(value: unknown): BuildingRagGeneration | null {
  if (value === null) return null;
  const parsed = record(value);
  exactKeys(parsed, [
    "generationId",
    "embeddingModelId",
    "embeddingDimensions",
    "expectedNoteCount",
    "indexedNoteCount",
    "revisionToken"
  ]);
  if (typeof parsed.generationId !== "string" || !GENERATION_ID_PATTERN.test(parsed.generationId)) {
    return failClosed();
  }
  const expectedNoteCount = count(parsed.expectedNoteCount);
  const indexedNoteCount = count(parsed.indexedNoteCount);
  if (indexedNoteCount > expectedNoteCount) return failClosed();
  return Object.freeze({
    generationId: parsed.generationId,
    embeddingModelId: modelId(parsed.embeddingModelId),
    embeddingDimensions: dimensions(parsed.embeddingDimensions),
    expectedNoteCount,
    indexedNoteCount,
    revisionToken: revisionToken(parsed.revisionToken)
  });
}

function maintenanceCursor(value: unknown): RagMaintenanceCursor | null {
  if (value === null) return null;
  const parsed = record(value);
  exactKeys(parsed, [
    "embeddingModelId",
    "embeddingDimensions",
    "phase",
    "checkpointRevision",
    "afterOwnerId"
  ]);
  if (
    typeof parsed.phase !== "string" ||
    !Object.values(RagMaintenancePhase).includes(parsed.phase as RagMaintenancePhaseValue) ||
    typeof parsed.afterOwnerId !== "string" ||
    !OWNER_ID_PATTERN.test(parsed.afterOwnerId)
  ) {
    return failClosed();
  }
  return Object.freeze({
    embeddingModelId: modelId(parsed.embeddingModelId),
    embeddingDimensions: dimensions(parsed.embeddingDimensions),
    phase: parsed.phase as RagMaintenancePhaseValue,
    checkpointRevision: revisionToken(parsed.checkpointRevision),
    afterOwnerId: parsed.afterOwnerId
  });
}

function parseMaintenancePage(
  value: unknown,
  expected: Parameters<RagGenerationLifecycleStore["listMaintenanceCandidates"]>[0]
): RagMaintenancePage {
  const parsed = record(value);
  exactKeys(parsed, ["target", "candidates", "page"]);
  const targetValue = record(parsed.target);
  exactKeys(targetValue, [
    "embeddingModelId",
    "embeddingDimensions",
    "envelopeSchemaVersion",
    "phase"
  ]);
  if (
    targetValue.envelopeSchemaVersion !== 1 ||
    typeof targetValue.phase !== "string" ||
    !Object.values(RagMaintenancePhase).includes(targetValue.phase as RagMaintenancePhaseValue)
  ) {
    return failClosed();
  }
  const target = Object.freeze({
    embeddingModelId: modelId(targetValue.embeddingModelId),
    embeddingDimensions: dimensions(targetValue.embeddingDimensions),
    envelopeSchemaVersion: 1 as const,
    phase: targetValue.phase as RagMaintenancePhaseValue
  });
  if (
    target.embeddingModelId !== expected.embeddingModelId ||
    target.embeddingDimensions !== expected.embeddingDimensions ||
    target.phase !== expected.phase
  ) {
    return failClosed();
  }
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length > 100) return failClosed();
  const candidates = Object.freeze(
    parsed.candidates.map((candidateValue): RagMaintenanceCandidate => {
      const candidate = record(candidateValue);
      exactKeys(candidate, [
        "ownerId",
        "rolloutState",
        "eligibleNoteCount",
        "aiObjectWrapKeyReady",
        "action",
        "activeGeneration",
        "buildingGeneration"
      ]);
      if (
        typeof candidate.ownerId !== "string" ||
        !OWNER_ID_PATTERN.test(candidate.ownerId) ||
        typeof candidate.rolloutState !== "string" ||
        !(encryptionRolloutStates as readonly string[]).includes(candidate.rolloutState) ||
        typeof candidate.aiObjectWrapKeyReady !== "boolean" ||
        typeof candidate.action !== "string" ||
        !Object.values(RagMaintenanceAction).includes(candidate.action as RagMaintenanceActionValue)
      ) {
        return failClosed();
      }
      const active = activeGeneration(candidate.activeGeneration);
      const building = buildingGeneration(candidate.buildingGeneration);
      if (
        (candidate.action === RagMaintenanceAction.CREATE_BUILD && building !== null) ||
        ((candidate.action === RagMaintenanceAction.RESUME_BUILD ||
          candidate.action === RagMaintenanceAction.REPLACE_BUILD) &&
          building === null) ||
        (candidate.action === RagMaintenanceAction.RESUME_BUILD &&
          building !== null &&
          (building.embeddingModelId !== target.embeddingModelId ||
            building.embeddingDimensions !== target.embeddingDimensions)) ||
        (candidate.action === RagMaintenanceAction.REPLACE_BUILD &&
          building !== null &&
          building.embeddingModelId === target.embeddingModelId &&
          building.embeddingDimensions === target.embeddingDimensions)
      ) {
        return failClosed();
      }
      return Object.freeze({
        ownerId: candidate.ownerId,
        rolloutState: candidate.rolloutState as EncryptionRolloutState,
        eligibleNoteCount: count(candidate.eligibleNoteCount),
        aiObjectWrapKeyReady: candidate.aiObjectWrapKeyReady,
        action: candidate.action as RagMaintenanceActionValue,
        activeGeneration: active,
        buildingGeneration: building
      });
    })
  );
  const pageValue = record(parsed.page);
  exactKeys(pageValue, [
    "requestId",
    "checkpointRevision",
    "limit",
    "returnedCount",
    "hasMore",
    "nextCursor",
    "replayed"
  ]);
  if (
    typeof pageValue.requestId !== "string" ||
    !UUID_PATTERN.test(pageValue.requestId) ||
    pageValue.requestId !== expected.pageRequestId ||
    typeof pageValue.replayed !== "boolean"
  ) {
    return failClosed();
  }
  const checkpointRevision = revisionToken(pageValue.checkpointRevision);
  const limit = count(pageValue.limit, 100);
  const returnedCount = count(pageValue.returnedCount, 100);
  if (
    limit < 1 ||
    limit !== expected.limit ||
    returnedCount !== candidates.length ||
    returnedCount > limit ||
    typeof pageValue.hasMore !== "boolean"
  ) {
    return failClosed();
  }
  const nextCursor = maintenanceCursor(pageValue.nextCursor);
  if (
    (expected.cursor !== null &&
      BigInt(checkpointRevision) !== BigInt(expected.cursor.checkpointRevision) + 1n) ||
    pageValue.hasMore !== (nextCursor !== null) ||
    (nextCursor !== null &&
      (nextCursor.embeddingModelId !== target.embeddingModelId ||
        nextCursor.embeddingDimensions !== target.embeddingDimensions ||
        nextCursor.phase !== target.phase ||
        nextCursor.checkpointRevision !== checkpointRevision ||
        nextCursor.afterOwnerId !== candidates.at(-1)?.ownerId)) ||
    candidates.some(
      (candidate, index) => index > 0 && candidate.ownerId <= (candidates[index - 1]?.ownerId ?? "")
    )
  ) {
    return failClosed();
  }
  return Object.freeze({
    target,
    candidates,
    page: Object.freeze({
      requestId: pageValue.requestId,
      checkpointRevision,
      limit,
      returnedCount,
      hasMore: pageValue.hasMore,
      nextCursor,
      replayed: pageValue.replayed
    })
  });
}

function parseEnsure(value: unknown): EnsuredRagGeneration {
  const parsed = record(value);
  exactKeys(parsed, [
    "generationId",
    "state",
    "embeddingModelId",
    "embeddingDimensions",
    "envelopeSchemaVersion",
    "expectedNoteCount",
    "indexedNoteCount",
    "revisionToken",
    "replayed"
  ]);
  if (
    typeof parsed.generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(parsed.generationId) ||
    (parsed.state !== "active" && parsed.state !== "building") ||
    parsed.envelopeSchemaVersion !== 1 ||
    typeof parsed.replayed !== "boolean"
  ) {
    return failClosed();
  }
  const expectedNoteCount = count(parsed.expectedNoteCount);
  const indexedNoteCount = count(parsed.indexedNoteCount);
  if (indexedNoteCount > expectedNoteCount) return failClosed();
  return Object.freeze({
    generationId: parsed.generationId,
    state: parsed.state,
    embeddingModelId: modelId(parsed.embeddingModelId),
    embeddingDimensions: dimensions(parsed.embeddingDimensions),
    envelopeSchemaVersion: 1,
    expectedNoteCount,
    indexedNoteCount,
    revisionToken: revisionToken(parsed.revisionToken),
    replayed: parsed.replayed
  });
}

function seedCursor(value: unknown): RagSeedCursor | null {
  if (value === null) return null;
  const parsed = record(value);
  exactKeys(parsed, ["generationId", "revisionToken", "afterNoteId"]);
  if (
    typeof parsed.generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(parsed.generationId) ||
    typeof parsed.afterNoteId !== "string" ||
    !NOTE_ID_PATTERN.test(parsed.afterNoteId)
  ) {
    return failClosed();
  }
  return Object.freeze({
    generationId: parsed.generationId,
    revisionToken: revisionToken(parsed.revisionToken),
    afterNoteId: parsed.afterNoteId
  });
}

function parseSeed(value: unknown): SeededRagGeneration {
  const parsed = record(value);
  exactKeys(parsed, [
    "batchId",
    "generationId",
    "revisionToken",
    "eligibleNoteCount",
    "examinedCount",
    "enqueuedCount",
    "hasMore",
    "complete",
    "nextCursor",
    "blocked",
    "failureCode",
    "replayed"
  ]);
  if (
    typeof parsed.batchId !== "string" ||
    !UUID_PATTERN.test(parsed.batchId) ||
    typeof parsed.generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(parsed.generationId) ||
    typeof parsed.hasMore !== "boolean" ||
    typeof parsed.complete !== "boolean" ||
    typeof parsed.blocked !== "boolean" ||
    (parsed.failureCode !== null && parsed.failureCode !== "validation_failed") ||
    typeof parsed.replayed !== "boolean"
  ) {
    return failClosed();
  }
  const parsedRevisionToken = revisionToken(parsed.revisionToken);
  const nextCursor = seedCursor(parsed.nextCursor);
  const examinedCount = count(parsed.examinedCount, 100);
  const enqueuedCount = count(parsed.enqueuedCount, 100);
  if (
    enqueuedCount > examinedCount ||
    (parsed.blocked &&
      (parsed.failureCode !== "validation_failed" ||
        parsed.hasMore ||
        parsed.complete ||
        nextCursor !== null ||
        examinedCount !== 0 ||
        enqueuedCount !== 0)) ||
    (!parsed.blocked &&
      (parsed.failureCode !== null ||
        parsed.hasMore !== (nextCursor !== null) ||
        parsed.complete !== !parsed.hasMore)) ||
    (nextCursor !== null &&
      (nextCursor.generationId !== parsed.generationId ||
        nextCursor.revisionToken !== parsedRevisionToken))
  ) {
    return failClosed();
  }
  return Object.freeze({
    batchId: parsed.batchId,
    generationId: parsed.generationId,
    revisionToken: parsedRevisionToken,
    eligibleNoteCount: count(parsed.eligibleNoteCount),
    examinedCount,
    enqueuedCount,
    hasMore: parsed.hasMore,
    complete: parsed.complete,
    nextCursor,
    blocked: parsed.blocked,
    failureCode: parsed.failureCode,
    replayed: parsed.replayed
  });
}

function parseFailure(value: unknown): FailedRagGeneration {
  const parsed = record(value);
  exactKeys(parsed, ["generationId", "state", "revisionToken", "failureCode", "replayed"]);
  if (
    typeof parsed.generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(parsed.generationId) ||
    parsed.state !== "failed" ||
    (parsed.failureCode !== "validation_failed" && parsed.failureCode !== "provider_unavailable") ||
    typeof parsed.replayed !== "boolean"
  ) {
    return failClosed();
  }
  return Object.freeze({
    generationId: parsed.generationId,
    state: "failed",
    revisionToken: revisionToken(parsed.revisionToken),
    failureCode: parsed.failureCode,
    replayed: parsed.replayed
  });
}

function parseActivation(value: unknown): ActivatedRagGeneration {
  const parsed = record(value);
  exactKeys(parsed, ["generationId", "revisionToken", "coverageVerified", "replayed"]);
  if (
    typeof parsed.generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(parsed.generationId) ||
    parsed.coverageVerified !== true ||
    typeof parsed.replayed !== "boolean"
  ) {
    return failClosed();
  }
  return Object.freeze({
    generationId: parsed.generationId,
    revisionToken: revisionToken(parsed.revisionToken),
    coverageVerified: true,
    replayed: parsed.replayed
  });
}

export class RagGenerationLifecycleRpcStore implements RagGenerationLifecycleStore {
  public constructor(private readonly client: ServiceRpcClient) {}

  public async listMaintenanceCandidates(
    input: Parameters<RagGenerationLifecycleStore["listMaintenanceCandidates"]>[0]
  ): Promise<RagMaintenancePage> {
    if (
      !UUID_PATTERN.test(input.pageRequestId) ||
      !Object.values(RagMaintenancePhase).includes(input.phase) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.cursor !== null &&
        (input.cursor.embeddingModelId !== input.embeddingModelId ||
          input.cursor.embeddingDimensions !== input.embeddingDimensions ||
          input.cursor.phase !== input.phase))
    ) {
      return failClosed();
    }
    return parseMaintenancePage(
      await this.client.rpc("list_rag_index_maintenance_candidates", {
        p_embedding_model_id: input.embeddingModelId,
        p_embedding_dimensions: input.embeddingDimensions,
        p_phase: input.phase,
        p_page_request_id: input.pageRequestId,
        p_cursor: input.cursor,
        p_limit: input.limit
      }),
      input
    );
  }

  public async ensureGeneration(
    input: Parameters<RagGenerationLifecycleStore["ensureGeneration"]>[0]
  ): Promise<EnsuredRagGeneration> {
    return parseEnsure(
      await this.client.rpc("ensure_rag_index_generation", {
        p_owner_id: input.ownerId,
        p_generation_id: input.generationId,
        p_embedding_model_id: input.embeddingModelId,
        p_embedding_dimensions: input.embeddingDimensions
      })
    );
  }

  public async seedGeneration(
    input: Parameters<RagGenerationLifecycleStore["seedGeneration"]>[0]
  ): Promise<SeededRagGeneration> {
    return parseSeed(
      await this.client.rpc("seed_rag_index_generation", {
        p_owner_id: input.ownerId,
        p_generation_id: input.generationId,
        p_expected_revision_token: input.expectedRevisionToken,
        p_batch_id: input.batchId,
        p_cursor: input.cursor,
        p_limit: input.limit
      })
    );
  }

  public async failGeneration(
    input: Parameters<RagGenerationLifecycleStore["failGeneration"]>[0]
  ): Promise<FailedRagGeneration> {
    return parseFailure(
      await this.client.rpc("fail_rag_index_generation", {
        p_owner_id: input.ownerId,
        p_generation_id: input.generationId,
        p_expected_revision_token: input.expectedRevisionToken,
        p_failure_code: input.failureCode
      })
    );
  }

  public async activateGeneration(
    input: Parameters<RagGenerationLifecycleStore["activateGeneration"]>[0]
  ): Promise<ActivatedRagGeneration> {
    return parseActivation(
      await this.client.rpc("activate_rag_index_generation", {
        p_owner_id: input.ownerId,
        p_generation_id: input.generationId,
        p_expected_revision_token: input.expectedRevisionToken
      })
    );
  }
}

export const ragGenerationLifecycleRpcFunctions = Object.freeze([
  "list_rag_index_maintenance_candidates",
  "ensure_rag_index_generation",
  "seed_rag_index_generation",
  "fail_rag_index_generation",
  "activate_rag_index_generation"
] as const);
