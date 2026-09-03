import { withAttachmentReferences } from "./attachment-references.js";
import {
  applyDeterministicExtractionOverride,
  bandRoutingDecision,
  materializeAuthorizedOrganizationPlan,
  OrganizationMaterializationError,
  parseAuthorizedOrganizationPlan,
  type MaterializedOrganizationCommand,
  type OrganizerCandidateManifest,
  type RoutingBehaviorMode,
  type RoutingPolicyResult,
  type RoutingSignalFeatures,
  type StableOrganizationIds
} from "@unfiled/ai-routing";
import type { PrivateRagGenerationSnapshot, PrivateRagPageReadResult } from "@unfiled/search";
import type { OrganizationPlan } from "@unfiled/contracts";
import { createHash } from "node:crypto";

import type { OrganizerKeyAuthority } from "./key-management.js";
import type {
  OrganizerModelId,
  OrganizerModelSelection,
  OrganizerProvider
} from "./model-registry.js";
import {
  createOrganizerProviderCredentialAccess,
  sameOrganizerProviderRouteBinding,
  type LeaseBoundOrganizerProviderRoute,
  type OrganizerAppDefaultApiKeys,
  type OrganizerExpansionStyle,
  type OrganizerProviderCredentialAccess,
  type OrganizerProviderRouteBinding,
  type OrganizerProviderSource,
  type OrganizerRoutingEffort
} from "./provider-credential.js";
import {
  type DecryptedCandidate,
  type DecryptedAttachment,
  type DecryptedCapture,
  type OrganizerCaptureControls,
  type OrganizerPlanner,
  buildDeterministicRoutingRulePlan,
  inferOrganizerCaptureKind,
  proposedNoteIdForJob,
  sameOrganizerCaptureControls
} from "./planner.js";
import {
  OrganizerPlannerReviewError,
  OrganizerProviderError,
  OrganizerUnavailableError
} from "./errors.js";
import { errorOrigin } from "./logging.js";

export type DrainTrigger = "manual" | "recovery" | "schedule";

/** What the drain reports for a failed job: safe code, retry decision, error class, throw site. */
export type OrganizerJobFailure = Readonly<{
  errorCode: string;
  retryable: boolean;
  errorName: string;
  origin?: string;
  providerStatus?: number;
  providerErrorType?: string;
  providerErrorCode?: string;
  providerErrorParam?: string;
  providerSchemaError?: string;
}>;
export type OrganizerDrainResult = Readonly<{
  claimed: number;
  completed: number;
  failed: number;
  retryScheduled: number;
}>;
export type EncryptedProjection = Readonly<{
  resourceId: string;
  recordVersion: number;
  cipher: unknown;
  contentMac?: unknown;
  contentMacKey?: unknown;
  key: unknown;
}>;
export type ClaimedOrganizerJob = Readonly<{
  accountCaptureOrdinal: number;
  adapterRegistryVersion: OrganizerProviderRouteBinding["adapterRegistryVersion"];
  attempt: number;
  captureId: `cap_${string}`;
  clientTimezone: string;
  controls: OrganizerCaptureControls;
  jobId: string;
  leaseExpiresAt: string;
  leaseToken: string;
  modelId: OrganizerModelId;
  modelSelection: OrganizerModelSelection;
  selectedProvider: OrganizerProvider;
  settingsRevision: number;
  occurredAt: string;
  ownerId: string;
  promptVersion: string;
  replanCount: 0 | 1;
  routingEffort: OrganizerRoutingEffort;
  routingMode: RoutingBehaviorMode;
  schemaVersion: number;
  source: EncryptedProjection;
  expansionStyle: OrganizerExpansionStyle;
  commandProjection: "encrypted_only" | "legacy";
}>;
export type EncryptedAttachment = Readonly<{
  attachmentId: `att_${string}`;
  kind: "image" | "audio";
  mediaType: "image/jpeg" | "audio/mp4";
  byteLength: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  source: EncryptedProjection;
}>;
export type EncryptedCandidate = Readonly<{
  archivedAt: string | null;
  candidateId: `note_${string}`;
  dailyDate: string | null;
  deletedAt: string | null;
  isOpen: boolean;
  links: readonly Readonly<{
    linkType: "reference" | "related";
    toNoteId: `note_${string}`;
  }>[];
  noteId: `note_${string}`;
  noteType: DecryptedCandidate["noteType"];
  pinnedAt: string | null;
  revision: number;
  spaceId: `spc_${string}` | null;
  source: EncryptedProjection;
  tagIds: readonly `tag_${string}`[];
  updatedAt: string;
}>;
export type OrganizerRagRecord = EncryptedProjection;
export type OrganizerRagSelection = Readonly<{
  candidates: readonly Readonly<{
    indexedRevision: number;
    noteId: `note_${string}`;
  }>[];
  snapshot: PrivateRagGenerationSnapshot;
}>;
export type CandidateRevalidationBinding = Readonly<{
  candidateId: `note_${string}`;
  isOpen: boolean;
  noteId: `note_${string}`;
  revision: number;
}>;
export type CandidateRevalidationManifest = Readonly<{
  candidates: readonly CandidateRevalidationBinding[];
  controls: OrganizerCaptureControls;
}>;
export type OrganizerPreparation = Readonly<{
  expectedRevision: number | null;
  ids: Readonly<{
    decisionId: `dec_${string}`;
    generatedBlockId: `blk_${string}`;
    mutationId: `mut_${string}`;
    reviewItemId: `rvw_${string}`;
    revisionId: `rev_${string}`;
  }>;
  jobId: string;
  keys: Readonly<{ contentMac: unknown; objectWrap: unknown }>;
  mode: "append" | "create";
  noteId: `note_${string}`;
  replanCount: 0 | 1;
  replayed: boolean;
  reservations: Readonly<{
    decision: Readonly<{ operationCount: 1; reservationId: string }>;
    generatedBlock: Readonly<{ operationCount: 1; reservationId: string }>;
    noteWrite: Readonly<{ operationCount: 4; reservationId: string }>;
    receipt: Readonly<{ operationCount: 1; reservationId: string }>;
    review: Readonly<{ operationCount: 1; reservationId: string }>;
  }>;
  targetRevision: number;
}>;
export type AtomicOrganizerCommand = Readonly<{
  decision: unknown;
  generatedBlock: unknown;
  noteWrite: unknown;
  outcome: "appended" | "created" | "review";
  receipt: unknown;
  review: unknown;
  reviewReason: OrganizerReviewReason | null;
}>;
export type OrganizerReviewReason =
  | "duplicate_suggestion"
  | "explicit_destination_unavailable"
  | "expansion_pending"
  | "planner_ambiguity"
  | "revision_conflict";
export type OrganizerConflictReason = "candidate_eligibility" | "consent_controls" | "revision";
export type OrganizerRoutingPolicyContext = Readonly<{
  accountCaptureOrdinal: number;
  candidateFeatures?: readonly Readonly<{
    candidateId: `note_${string}`;
    features: RoutingSignalFeatures;
  }>[];
  deterministicRuleMatch: boolean;
  features: RoutingSignalFeatures;
  mode: RoutingBehaviorMode;
  retrievalAutoEligible: boolean;
}>;
export type OrganizerCommitResult =
  | Readonly<{
      jobId: string;
      noteId: string | null;
      outcome: "appended" | "created" | "review";
      replayed: boolean;
      revision: number | null;
      replanCount: 0 | 1;
    }>
  | Readonly<{
      conflictReason: OrganizerConflictReason;
      jobId: string;
      noteId: string | null;
      outcome: "replan" | "review_required";
      replayed: boolean;
      revision: number | null;
      replanCount: 1;
    }>;
export type OrganizerHeartbeatResult =
  | Readonly<{
      candidateCount: number;
      currentRevision: number | null;
      disclosureAuthorized: true;
      jobId: string;
      leaseExpiresAt: string;
      outcome: "authorized";
      replanCount: 0 | 1;
    }>
  | Readonly<{
      conflictReason: OrganizerConflictReason;
      jobId: string;
      noteId: `note_${string}` | null;
      outcome: "replan" | "review";
      replayed: boolean;
      revision: number | null;
      replanCount: 1;
    }>;
export type OrganizerAppendPreparationResult =
  | Readonly<{ outcome: "prepared"; preparation: OrganizerPreparation }>
  | Readonly<{
      conflictReason: Exclude<OrganizerConflictReason, "consent_controls">;
      outcome: "review";
      preparation: OrganizerPreparation;
    }>
  | Readonly<{
      conflictReason: Exclude<OrganizerConflictReason, "consent_controls">;
      jobId: string;
      noteId: `note_${string}`;
      outcome: "replan";
      replayed: boolean;
      revision: number | null;
      replanCount: 1;
    }>;
export type OrganizerCandidatePage = Readonly<{
  candidates: readonly EncryptedCandidate[];
  controls: OrganizerCaptureControls;
}>;
export type OrganizerDisclosedCandidate = Readonly<{
  decrypted: DecryptedCandidate;
  encrypted: EncryptedCandidate;
}>;
export type OrganizerCandidateRetrievalPort = Readonly<{
  retrieve(
    input: Readonly<{
      authority: OrganizerKeyAuthority;
      capture: DecryptedCapture;
      job: ClaimedOrganizerJob;
      providerCredential?: OrganizerProviderCredentialAccess;
      signal: AbortSignal;
    }>
  ): Promise<
    OrganizerCandidatePage &
      Readonly<{
        ragGenerationId?: string | null;
        routingPolicyContext: OrganizerRoutingPolicyContext;
      }>
  >;
}>;
export type OrganizerRepository = Readonly<{
  release(jobId: string): void;
  preflight(signal: AbortSignal): Promise<void>;
  recoverStale(
    limit: number,
    signal: AbortSignal
  ): Promise<
    Readonly<{ deadLetteredCount: number; recoveredCount: number; requeuedCount: number }>
  >;
  claim(
    input: Readonly<{ leaseSeconds: number; limit: number; signal: AbortSignal; workerId: string }>
  ): Promise<readonly ClaimedOrganizerJob[]>;
  providerRoute(
    input: Readonly<{ jobId: string; leaseToken: string; signal: AbortSignal }>
  ): Promise<LeaseBoundOrganizerProviderRoute>;
  heartbeat(
    input: Readonly<{
      candidateManifest: CandidateRevalidationManifest;
      jobId: string;
      leaseSeconds: number;
      leaseToken: string;
      signal: AbortSignal;
    }>
  ): Promise<OrganizerHeartbeatResult>;
  candidates(
    input: Readonly<{ jobId: string; leaseToken: string; limit: number; signal: AbortSignal }>
  ): Promise<OrganizerCandidatePage>;
  attachments(
    input: Readonly<{ jobId: string; leaseToken: string; signal: AbortSignal }>
  ): Promise<readonly EncryptedAttachment[]>;
  ragPage(
    input: Readonly<{
      cursor: string | null;
      jobId: string;
      leaseToken: string;
      limit: number;
      maxBytes: number;
      signal: AbortSignal;
    }>
  ): Promise<PrivateRagPageReadResult<OrganizerRagRecord>>;
  selectCandidates(
    input: Readonly<{
      jobId: string;
      leaseToken: string;
      selection: OrganizerRagSelection;
      signal: AbortSignal;
    }>
  ): Promise<OrganizerCandidatePage & Readonly<{ snapshot: PrivateRagGenerationSnapshot }>>;
  prepareCreate(
    input: Readonly<{
      jobId: string;
      leaseToken: string;
      reservationId: string;
      signal: AbortSignal;
      stableNoteId: `note_${string}`;
    }>
  ): Promise<OrganizerPreparation>;
  prepareAppend(
    input: Readonly<{
      expectedRevision: number;
      jobId: string;
      leaseToken: string;
      noteId: `note_${string}`;
      reservationId: string;
      signal: AbortSignal;
    }>
  ): Promise<OrganizerAppendPreparationResult>;
  commit(
    input: Readonly<{
      command: AtomicOrganizerCommand;
      jobId: string;
      leaseToken: string;
      signal: AbortSignal;
    }>
  ): Promise<OrganizerCommitResult>;
  fail(
    input: Readonly<{
      errorCode: string;
      jobId: string;
      leaseToken: string;
      providerCredentialRevision: number | null;
      providerSource: OrganizerProviderSource | null;
      retryable: boolean;
      signal: AbortSignal;
    }>
  ): Promise<Readonly<{ state: "awaiting_retry" | "dead_letter" | "failed" }>>;
}>;
export type OrganizerCipher = Readonly<{
  openCapture(
    input: Readonly<{
      authority: OrganizerKeyAuthority;
      job: ClaimedOrganizerJob;
      signal: AbortSignal;
    }>
  ): Promise<DecryptedCapture>;
  openCaptureAttachments(
    input: Readonly<{
      authority: OrganizerKeyAuthority;
      attachments: readonly EncryptedAttachment[];
      job: ClaimedOrganizerJob;
      signal: AbortSignal;
    }>
  ): Promise<readonly DecryptedAttachment[]>;
  openCandidate(
    input: Readonly<{
      authority: OrganizerKeyAuthority;
      candidate: EncryptedCandidate;
      ownerId: string;
      signal: AbortSignal;
    }>
  ): Promise<DecryptedCandidate>;
  sealCommand(
    input: Readonly<{
      activeReplanCount: 0 | 1;
      authority: OrganizerKeyAuthority;
      candidates: readonly OrganizerDisclosedCandidate[];
      capture: DecryptedCapture;
      controls: OrganizerCaptureControls;
      destination: Readonly<{
        decrypted: DecryptedCandidate;
        encrypted: EncryptedCandidate;
      }> | null;
      job: ClaimedOrganizerJob;
      plan: MaterializedOrganizationCommand;
      preparation: OrganizerPreparation;
      ragGenerationId: string | null;
      reviewReason: OrganizerReviewReason | null;
      routingDecision: RoutingPolicyResult | null;
      signal: AbortSignal;
      stableIds: StableOrganizationIds;
    }>
  ): Promise<AtomicOrganizerCommand>;
}>;
export type OrganizerDrainPort = Readonly<{
  drain(
    input: Readonly<{
      authority: OrganizerKeyAuthority;
      requestId: string;
      signal: AbortSignal;
      trigger: DrainTrigger;
    }>
  ): Promise<OrganizerDrainResult>;
}>;

export const unconfiguredDrainPort: OrganizerDrainPort = Object.freeze({
  drain() {
    return Promise.reject(new OrganizerUnavailableError());
  }
});

export const unavailableOrganizerCipher: OrganizerCipher = Object.freeze({
  openCapture() {
    return Promise.reject(new OrganizerUnavailableError());
  },
  openCaptureAttachments() {
    return Promise.reject(new OrganizerUnavailableError());
  },
  openCandidate() {
    return Promise.reject(new OrganizerUnavailableError());
  },
  sealCommand() {
    return Promise.reject(new OrganizerUnavailableError());
  }
});

function reservationId(
  stableIds: StableOrganizationIds,
  attempt: number,
  writeGeneration: number
): string {
  const digest = createHash("sha256")
    .update(
      `unfiled.organizer.reservation.v1:${stableIds.decisionId}:${attempt}:${writeGeneration}`,
      "utf8"
    )
    .digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  digest.fill(0);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function provisionalIds(jobId: string): StableOrganizationIds {
  const noteId = proposedNoteIdForJob(jobId);
  const suffix = noteId.slice("note_".length);
  return Object.freeze({
    createdNoteId: noteId,
    decisionId: `dec_${suffix}`,
    generatedBlockId: `blk_${suffix}`,
    mutationId: `mut_${suffix}`,
    reviewItemId: `rvw_${suffix}`,
    revisionId: `rev_${suffix}`
  });
}

function preparedStableIds(
  preparation: OrganizerPreparation,
  decision: "add_to_inbox" | "append_to_note" | "create_note" | "needs_review",
  generatedExpansion = false
): StableOrganizationIds {
  const routed = decision === "append_to_note" || decision === "create_note";
  return Object.freeze({
    createdNoteId: decision === "create_note" ? preparation.noteId : null,
    decisionId: preparation.ids.decisionId,
    generatedBlockId: routed && generatedExpansion ? preparation.ids.generatedBlockId : null,
    mutationId: routed ? preparation.ids.mutationId : null,
    reviewItemId:
      decision === "needs_review" || (routed && generatedExpansion)
        ? preparation.ids.reviewItemId
        : null,
    revisionId: routed ? preparation.ids.revisionId : null
  });
}

function safeFailure(error: unknown): Readonly<{ errorCode: string; retryable: boolean }> {
  if (error instanceof OrganizerProviderError)
    return { errorCode: error.safeCode, retryable: error.retryable };
  if (error instanceof OrganizerUnavailableError)
    return { errorCode: "provider_unavailable", retryable: true };
  if (error instanceof Error && error.name === "AbortError")
    return { errorCode: "provider_unavailable", retryable: true };
  return { errorCode: "validation_failed", retryable: false };
}

function signalActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

const FAIL_CLOSED_ROUTING_CONTEXT: OrganizerRoutingPolicyContext = Object.freeze({
  accountCaptureOrdinal: 1,
  deterministicRuleMatch: false,
  features: Object.freeze({
    destinationRecency: 0,
    duplicateTitleSuspicion: 0,
    explicitDestinationMention: 0,
    margin: 0,
    openSameDayTypeMatch: 0,
    priorAccepted: 0,
    reasonCodeConsistency: 0,
    ruleOrAliasNearMatch: 0,
    semanticSimilarity: 0,
    typeCompatibility: 0
  }),
  mode: "balanced",
  retrievalAutoEligible: false
});

function routingPolicyForPlan(
  plan: ReturnType<typeof parseAuthorizedOrganizationPlan>["plan"],
  manifest: OrganizerCandidateManifest,
  captureText: string,
  inferredKind: ReturnType<typeof inferOrganizerCaptureKind>,
  context: OrganizerRoutingPolicyContext,
  deterministicRuleMatch = false
): RoutingPolicyResult {
  const candidate =
    plan.destination.candidateId === null
      ? undefined
      : manifest.candidates.find(({ candidateId }) => candidateId === plan.destination.candidateId);
  const destinationNoteType = candidate?.noteType ?? plan.destination.newNote?.noteType ?? null;
  const contextualFeatures =
    (plan.destination.candidateId === null
      ? undefined
      : context.candidateFeatures?.find(
          ({ candidateId }) => candidateId === plan.destination.candidateId
        )?.features) ?? context.features;
  const features = deterministicRuleMatch
    ? Object.freeze({
        ...contextualFeatures,
        explicitDestinationMention: 1,
        margin: 1,
        reasonCodeConsistency: 1,
        ruleOrAliasNearMatch: 1,
        typeCompatibility: 1
      })
    : contextualFeatures;
  const decision = bandRoutingDecision({
    accountCaptureOrdinal: context.accountCaptureOrdinal,
    captureKind: inferredKind,
    captureLength: Array.from(captureText).length,
    createSignals:
      plan.decision === "create_note"
        ? deterministicRuleMatch
          ? { noCandidateFitStrength: 1, titleValidity: 1 }
          : {
              noCandidateFitStrength:
                manifest.candidates.length === 0 && plan.reasonCodes.includes("no_candidate_fit")
                  ? 1
                  : 0,
              titleValidity: plan.destination.newNote === null ? 0 : 1
            }
        : null,
    destinationNoteType,
    deterministicRuleMatch: deterministicRuleMatch || context.deterministicRuleMatch,
    duplicateNoteSuspected: plan.reasonCodes.includes("duplicate_suspected"),
    failure: null,
    features,
    mode: context.mode,
    planDecision: plan.decision,
    retrievalAutoEligible: context.retrievalAutoEligible
  });
  return decision;
}

function candidateManifest(
  controls: OrganizerCaptureControls,
  candidates: readonly EncryptedCandidate[]
): CandidateRevalidationManifest {
  return Object.freeze({
    candidates: Object.freeze(
      candidates.map(({ candidateId, isOpen, noteId, revision }) =>
        Object.freeze({ candidateId, isOpen, noteId, revision })
      )
    ),
    controls
  });
}

function assertDecryptedCandidateBinding(
  encrypted: EncryptedCandidate,
  decrypted: DecryptedCandidate
): void {
  if (
    encrypted.candidateId !== decrypted.candidateId ||
    encrypted.noteId !== decrypted.noteId ||
    encrypted.noteType !== decrypted.noteType ||
    encrypted.revision !== decrypted.revision ||
    encrypted.isOpen !== decrypted.isOpen
  ) {
    throw new OrganizerUnavailableError();
  }
}

function forcedReview(
  manifest: OrganizerCandidateManifest,
  preparation: OrganizerPreparation,
  captureKind: ReturnType<typeof inferOrganizerCaptureKind>,
  sourcePlan: OrganizationPlan | null
): Readonly<{ plan: MaterializedOrganizationCommand; stableIds: StableOrganizationIds }> {
  const authorizedCandidates = new Set(manifest.candidates.map(({ candidateId }) => candidateId));
  const alternatives = Array.from(
    new Set([
      ...(sourcePlan?.destination.candidateId === null ||
      sourcePlan?.destination.candidateId === undefined
        ? []
        : [sourcePlan.destination.candidateId]),
      ...(sourcePlan?.alternatives ?? [])
    ])
  )
    .filter((candidateId) => authorizedCandidates.has(candidateId))
    .slice(0, 2);
  const reasonCodes = Array.from(
    new Set([
      "ambiguous_intent" as const,
      ...(manifest.controls.explicitDestinationNoteId === null &&
      manifest.controls.ruleMatch !== null
        ? (["routing_rule_match"] as const)
        : []),
      ...(sourcePlan?.reasonCodes ?? [])
    ])
  ).slice(0, 5);
  const authorized = parseAuthorizedOrganizationPlan({
    manifest,
    unknownPlan: {
      alternatives,
      captureKind,
      decision: "needs_review",
      destination: { candidateId: null, newNote: null },
      generatedExpansion: null,
      operations: [],
      reasonCodes,
      schemaVersion: 1
    }
  });
  const stableIds = preparedStableIds(preparation, "needs_review");
  return Object.freeze({
    plan: materializeAuthorizedOrganizationPlan({ ...authorized, stableIds }),
    stableIds
  });
}

function reviewReasonForPlan(plan: MaterializedOrganizationCommand): OrganizerReviewReason | null {
  if (plan.kind === "review" && plan.disposition === "needs_review") return "planner_ambiguity";
  if (plan.kind !== "review" && plan.generatedBlock !== null) return "expansion_pending";
  return null;
}

function reviewReasonForConflict(
  conflictReason: OrganizerConflictReason,
  controls: OrganizerCaptureControls
): OrganizerReviewReason {
  if (conflictReason === "revision") return "revision_conflict";
  if (conflictReason === "candidate_eligibility" && controls.explicitDestinationNoteId !== null) {
    return "explicit_destination_unavailable";
  }
  return "planner_ambiguity";
}

function assertCommandBinding(
  command: AtomicOrganizerCommand,
  plan: MaterializedOrganizationCommand,
  reviewReason: OrganizerReviewReason | null
): void {
  const expectedOutcome =
    plan.kind === "append" ? "appended" : plan.kind === "create" ? "created" : "review";
  const generatedExpansion = plan.kind !== "review" && plan.generatedBlock !== null;
  if (
    command.outcome !== expectedOutcome ||
    command.reviewReason !== reviewReason ||
    (plan.kind === "review") !== (command.noteWrite === null) ||
    (plan.kind === "review" || generatedExpansion) !== (command.review !== null) ||
    generatedExpansion !== (command.generatedBlock !== null) ||
    (plan.kind === "review" || generatedExpansion) !== (reviewReason !== null)
  )
    throw new OrganizerUnavailableError();
}

export function createOrganizerDrain(
  options: Readonly<{
    /** Present in managed runtimes (possibly empty); absent disables provider credential access. */
    appDefaultProviderApiKeys?: OrganizerAppDefaultApiKeys;
    candidateLimit?: number;
    claimLimit: number;
    concurrency: number;
    leaseSeconds: number;
    /** Receives one content-free record per failed job. */
    onJobFailure?: (failure: OrganizerJobFailure) => void;
    planner: OrganizerPlanner;
    recoveryLimit: number;
    repository: OrganizerRepository;
    retrieval?: OrganizerCandidateRetrievalPort;
    routingPolicyContext?: OrganizerRoutingPolicyContext;
    cipher: OrganizerCipher;
    workerId: string;
  }>
): OrganizerDrainPort {
  async function processJob(
    job: ClaimedOrganizerJob,
    authority: OrganizerKeyAuthority,
    signal: AbortSignal
  ): Promise<"completed" | "failed" | "retry"> {
    const jobBinding: OrganizerProviderRouteBinding = Object.freeze({
      adapterRegistryVersion: job.adapterRegistryVersion,
      expansionStyle: job.expansionStyle,
      modelId: job.modelId,
      modelSelection: job.modelSelection,
      provider: job.selectedProvider,
      routingEffort: job.routingEffort,
      settingsRevision: job.settingsRevision
    });
    const appDefaultApiKeys = options.appDefaultProviderApiKeys;
    const providerCredential =
      appDefaultApiKeys === undefined
        ? undefined
        : createOrganizerProviderCredentialAccess({
            appDefaultApiKeys,
            async resolve() {
              const route = await options.repository.providerRoute({
                jobId: job.jobId,
                leaseToken: job.leaseToken,
                signal
              });
              // The live route must match the immutable claim snapshot exactly.
              if (!sameOrganizerProviderRouteBinding(route, jobBinding))
                throw new OrganizerUnavailableError();
              return route;
            }
          });
    try {
      const openedCapture = await options.cipher.openCapture({ authority, job, signal });
      if (!sameOrganizerCaptureControls(openedCapture.controls, job.controls))
        throw new OrganizerUnavailableError();
      const encryptedAttachments = await options.repository.attachments({
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        signal
      });
      const capture: DecryptedCapture = Object.freeze({
        ...openedCapture,
        attachments:
          encryptedAttachments.length === 0
            ? []
            : await options.cipher.openCaptureAttachments({
                authority,
                attachments: encryptedAttachments,
                job,
                signal
              })
      });
      let replanCount: 0 | 1 = job.replanCount;
      let writeGeneration = 0;
      let plannerCalls = 0;
      let pendingReviewReason: OrganizerReviewReason | null = null;
      let pendingReviewPlan: OrganizationPlan | null = null;
      let pendingRoutingDecision: RoutingPolicyResult | null = null;

      async function commitReview(
        manifest: OrganizerCandidateManifest,
        revalidationManifest: CandidateRevalidationManifest,
        controls: OrganizerCaptureControls,
        candidates: readonly OrganizerDisclosedCandidate[],
        ragGenerationId: string | null,
        reviewReason: OrganizerReviewReason,
        suppliedPreparation?: OrganizerPreparation,
        sourcePlan: OrganizationPlan | null = pendingReviewPlan,
        routingDecision: RoutingPolicyResult | null = pendingRoutingDecision
      ): Promise<"completed" | "retry"> {
        const provisional = provisionalIds(job.jobId);
        const preparation =
          suppliedPreparation ??
          (await options.repository.prepareCreate({
            jobId: job.jobId,
            leaseToken: job.leaseToken,
            reservationId: reservationId(provisional, job.attempt, writeGeneration),
            signal,
            stableNoteId: proposedNoteIdForJob(job.jobId)
          }));
        const review = forcedReview(
          manifest,
          preparation,
          inferOrganizerCaptureKind(capture.rawContent),
          sourcePlan
        );
        const command = await options.cipher.sealCommand({
          activeReplanCount: replanCount,
          authority,
          candidates,
          capture: Object.freeze({
            controls,
            rawContent: capture.rawContent,
            guidance: capture.guidance ?? null
          }),
          controls,
          destination: null,
          job,
          plan: review.plan,
          preparation,
          ragGenerationId,
          reviewReason,
          routingDecision,
          signal,
          stableIds: review.stableIds
        });
        assertCommandBinding(command, review.plan, reviewReason);
        signalActive(signal);
        const publication = await options.repository.heartbeat({
          candidateManifest: revalidationManifest,
          jobId: job.jobId,
          leaseSeconds: options.leaseSeconds,
          leaseToken: job.leaseToken,
          signal
        });
        if (publication.outcome !== "authorized") {
          writeGeneration += 1;
          replanCount = 1;
          pendingReviewReason = reviewReasonForConflict(publication.conflictReason, controls);
          return "retry";
        }
        signalActive(signal);
        const committed = await options.repository.commit({
          command,
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          signal
        });
        if (committed.jobId !== job.jobId) throw new OrganizerUnavailableError();
        if (committed.outcome === "review") return "completed";
        if (committed.outcome === "replan" || committed.outcome === "review_required") {
          writeGeneration += 1;
          replanCount = 1;
          pendingReviewReason = reviewReasonForConflict(committed.conflictReason, controls);
          return "retry";
        }
        throw new OrganizerUnavailableError();
      }

      for (;;) {
        let page: OrganizerCandidatePage;
        let ragGenerationId: string | null = null;
        let routingPolicyContext: OrganizerRoutingPolicyContext;
        if (options.retrieval === undefined) {
          page = await options.repository.candidates({
            jobId: job.jobId,
            leaseToken: job.leaseToken,
            limit: Math.min(
              options.candidateLimit ?? 8,
              job.routingEffort === "economical" ? 6 : 8
            ),
            signal
          });
          routingPolicyContext = options.routingPolicyContext ?? FAIL_CLOSED_ROUTING_CONTEXT;
        } else {
          const retrieved = await options.retrieval.retrieve({
            authority,
            capture,
            job,
            ...(providerCredential === undefined ? {} : { providerCredential }),
            signal
          });
          page = retrieved;
          ragGenerationId = retrieved.ragGenerationId ?? null;
          routingPolicyContext = retrieved.routingPolicyContext;
        }
        const encryptedCandidates = page.candidates;
        const controls = page.controls;
        const currentCapture = Object.freeze({
          controls,
          rawContent: capture.rawContent,
          guidance: capture.guidance ?? null,
          attachments: capture.attachments ?? []
        });
        const isRoutingRulePath =
          controls.explicitDestinationNoteId === null && controls.ruleMatch !== null;
        const deterministicRoutingRulePlan = isRoutingRulePath
          ? buildDeterministicRoutingRulePlan({
              candidates: encryptedCandidates,
              captureText: capture.rawContent,
              clientTimezone: job.clientTimezone,
              controls,
              occurredAt: job.occurredAt
            })
          : null;
        const ruleDestinationCandidateId =
          deterministicRoutingRulePlan?.decision === "append_to_note"
            ? deterministicRoutingRulePlan.destination.candidateId
            : null;
        const routableEncryptedCandidates = encryptedCandidates.filter(
          ({ candidateId, isOpen }) =>
            isOpen &&
            (!isRoutingRulePath ||
              (ruleDestinationCandidateId !== null && candidateId === ruleDestinationCandidateId))
        );
        const candidates = await Promise.all(
          routableEncryptedCandidates.map((candidate) =>
            options.cipher.openCandidate({ authority, candidate, ownerId: job.ownerId, signal })
          )
        );
        for (let index = 0; index < routableEncryptedCandidates.length; index += 1) {
          const encrypted = routableEncryptedCandidates[index];
          const decrypted = candidates[index];
          if (encrypted === undefined || decrypted === undefined)
            throw new OrganizerUnavailableError();
          assertDecryptedCandidateBinding(encrypted, decrypted);
        }
        const disclosedCandidates = Object.freeze(
          candidates.map((decrypted, index) => {
            const encrypted = routableEncryptedCandidates[index];
            if (encrypted === undefined) throw new OrganizerUnavailableError();
            return Object.freeze({ decrypted, encrypted });
          })
        );
        const revalidationManifest = candidateManifest(controls, encryptedCandidates);
        // This renewal is the external-disclosure authorization linearization point.
        const disclosure = await options.repository.heartbeat({
          candidateManifest: revalidationManifest,
          jobId: job.jobId,
          leaseSeconds: options.leaseSeconds,
          leaseToken: job.leaseToken,
          signal
        });
        const manifest: OrganizerCandidateManifest = {
          schemaVersion: 1,
          candidates: disclosedCandidates.map(
            ({
              decrypted: { candidateId, isOpen, noteId, noteType, revision },
              encrypted: { spaceId }
            }) => ({
              candidateId,
              isOpen,
              noteId,
              noteType,
              revision,
              spaceId
            })
          ),
          controls,
          authorizedSpaceIds:
            isRoutingRulePath && controls.ruleMatch.destinationKind === "space"
              ? [controls.ruleMatch.destinationId]
              : [],
          authorizedTagIds: []
        };
        if (disclosure.outcome !== "authorized") {
          if (disclosure.outcome === "replan" && replanCount === 0) {
            writeGeneration += 1;
            replanCount = 1;
            continue;
          }
          pendingReviewReason = reviewReasonForConflict(disclosure.conflictReason, controls);
          writeGeneration += 1;
          replanCount = 1;
          continue;
        }
        const explicitDestination = controls.explicitDestinationNoteId;
        if (
          explicitDestination !== null &&
          !manifest.candidates.some(({ noteId }) => noteId === explicitDestination)
        )
          pendingReviewReason = "explicit_destination_unavailable";
        if (isRoutingRulePath && deterministicRoutingRulePlan === null)
          pendingReviewReason = "planner_ambiguity";
        if (pendingReviewReason !== null) {
          const result = await commitReview(
            manifest,
            revalidationManifest,
            controls,
            disclosedCandidates,
            ragGenerationId,
            pendingReviewReason
          );
          if (result === "retry") continue;
          return result;
        }
        let unknownPlan: unknown;
        if (isRoutingRulePath) {
          if (deterministicRoutingRulePlan === null) {
            pendingReviewReason = "planner_ambiguity";
            continue;
          }
          unknownPlan = deterministicRoutingRulePlan;
        } else {
          if (plannerCalls >= (job.replanCount === 0 ? 2 : 1)) {
            pendingReviewReason = "revision_conflict";
            continue;
          }
          plannerCalls += 1;
          signalActive(signal);
          try {
            unknownPlan = await options.planner.plan({
              capture: currentCapture,
              candidates,
              captureId: job.captureId,
              controls,
              expansionStyle: job.expansionStyle,
              promptVersion: job.promptVersion,
              ...(providerCredential === undefined ? {} : { providerCredential }),
              routingEffort: job.routingEffort,
              schemaVersion: job.schemaVersion,
              signal
            });
            signalActive(signal);
          } catch (error: unknown) {
            if (error instanceof OrganizerPlannerReviewError) {
              pendingReviewReason = "planner_ambiguity";
              continue;
            }
            if (error instanceof OrganizerProviderError) throw error;
            throw new OrganizerUnavailableError();
          }
        }
        let authorized: ReturnType<typeof parseAuthorizedOrganizationPlan>;
        try {
          const initiallyAuthorized = parseAuthorizedOrganizationPlan({ manifest, unknownPlan });
          const inferredKind = inferOrganizerCaptureKind(currentCapture.rawContent);
          if (initiallyAuthorized.plan.captureKind !== inferredKind) {
            pendingReviewReason = "planner_ambiguity";
            continue;
          }
          const overridden = isRoutingRulePath
            ? Object.freeze({ plan: initiallyAuthorized.plan })
            : applyDeterministicExtractionOverride({
                captureText: currentCapture.rawContent,
                inferredKind,
                plan: initiallyAuthorized.plan
              });
          authorized = parseAuthorizedOrganizationPlan({
            captureText: currentCapture.rawContent,
            manifest,
            unknownPlan: overridden.plan
          });
        } catch (error: unknown) {
          if (!(error instanceof OrganizationMaterializationError)) throw error;
          pendingReviewReason = "planner_ambiguity";
          continue;
        }
        const routingDecision = routingPolicyForPlan(
          authorized.plan,
          manifest,
          currentCapture.rawContent,
          inferOrganizerCaptureKind(currentCapture.rawContent),
          routingPolicyContext,
          isRoutingRulePath
        );
        if (authorized.plan.reasonCodes.includes("duplicate_suspected")) {
          pendingReviewPlan = authorized.plan;
          pendingRoutingDecision = routingDecision;
          const duplicateCandidates = new Set([
            ...(authorized.plan.destination.candidateId === null
              ? []
              : [authorized.plan.destination.candidateId]),
            ...authorized.plan.alternatives
          ]);
          pendingReviewReason =
            duplicateCandidates.size >= 2 ? "duplicate_suggestion" : "planner_ambiguity";
          continue;
        }
        if (authorized.plan.decision === "add_to_inbox") {
          pendingReviewPlan = authorized.plan;
          pendingRoutingDecision = routingDecision;
          pendingReviewReason = "planner_ambiguity";
          continue;
        }
        if (!routingDecision.autoApply) {
          pendingReviewPlan = authorized.plan;
          pendingRoutingDecision = routingDecision;
          pendingReviewReason = "planner_ambiguity";
          continue;
        }
        const provisional = provisionalIds(job.jobId);
        const id = reservationId(provisional, job.attempt, writeGeneration);
        const destinationCandidate =
          authorized.plan.destination.candidateId === null
            ? undefined
            : manifest.candidates.find(
                ({ candidateId }) => candidateId === authorized.plan.destination.candidateId
              );
        const preparationResult =
          authorized.plan.decision === "append_to_note"
            ? destinationCandidate === undefined
              ? await Promise.reject(new OrganizerUnavailableError())
              : await options.repository.prepareAppend({
                  expectedRevision: destinationCandidate.revision,
                  jobId: job.jobId,
                  leaseToken: job.leaseToken,
                  noteId: destinationCandidate.noteId,
                  reservationId: id,
                  signal
                })
            : await options.repository.prepareCreate({
                jobId: job.jobId,
                leaseToken: job.leaseToken,
                reservationId: id,
                signal,
                stableNoteId: proposedNoteIdForJob(job.jobId)
              });
        if ("outcome" in preparationResult) {
          if (preparationResult.outcome === "replan") {
            writeGeneration += 1;
            replanCount = 1;
            continue;
          }
          if (preparationResult.outcome === "review") {
            pendingReviewReason = reviewReasonForConflict(
              preparationResult.conflictReason,
              controls
            );
            const result = await commitReview(
              manifest,
              revalidationManifest,
              controls,
              disclosedCandidates,
              ragGenerationId,
              pendingReviewReason,
              preparationResult.preparation,
              authorized.plan,
              routingDecision
            );
            if (result === "retry") continue;
            return result;
          }
        }
        const preparation =
          "outcome" in preparationResult ? preparationResult.preparation : preparationResult;
        const stableIds = preparedStableIds(
          preparation,
          authorized.plan.decision,
          authorized.plan.generatedExpansion !== null
        );
        let plan: MaterializedOrganizationCommand;
        try {
          plan = withAttachmentReferences(
            materializeAuthorizedOrganizationPlan({
              ...authorized,
              captureText: currentCapture.rawContent,
              stableIds
            }),
            currentCapture.attachments
          );
        } catch (error: unknown) {
          if (!(error instanceof OrganizationMaterializationError)) throw error;
          pendingReviewReason = "planner_ambiguity";
          const result = await commitReview(
            manifest,
            revalidationManifest,
            controls,
            disclosedCandidates,
            ragGenerationId,
            pendingReviewReason,
            preparation,
            authorized.plan,
            routingDecision
          );
          if (result === "retry") continue;
          return result;
        }
        const reviewReason = reviewReasonForPlan(plan);
        const disclosedDestination =
          destinationCandidate === undefined
            ? undefined
            : disclosedCandidates.find(
                ({ decrypted }) => decrypted.candidateId === destinationCandidate.candidateId
              );
        if (plan.kind === "append" && disclosedDestination === undefined) {
          throw new OrganizerUnavailableError();
        }
        const command = await options.cipher.sealCommand({
          activeReplanCount: replanCount,
          authority,
          candidates: disclosedCandidates,
          capture: currentCapture,
          controls,
          destination: disclosedDestination ?? null,
          job,
          plan,
          preparation,
          ragGenerationId,
          reviewReason,
          routingDecision,
          signal,
          stableIds
        });
        const expectedOutcome =
          plan.kind === "append" ? "appended" : plan.kind === "create" ? "created" : "review";
        assertCommandBinding(command, plan, reviewReason);
        signalActive(signal);
        // Revalidate immediately before publishing any encrypted effect.
        const publication = await options.repository.heartbeat({
          candidateManifest: revalidationManifest,
          jobId: job.jobId,
          leaseSeconds: options.leaseSeconds,
          leaseToken: job.leaseToken,
          signal
        });
        if (publication.outcome !== "authorized") {
          if (publication.outcome === "replan" && replanCount === 0) {
            writeGeneration += 1;
            replanCount = 1;
            continue;
          }
          pendingReviewReason = reviewReasonForConflict(publication.conflictReason, controls);
          pendingReviewPlan = plan.validatedPlan;
          pendingRoutingDecision = routingDecision;
          writeGeneration += 1;
          replanCount = 1;
          continue;
        }
        signalActive(signal);
        const committed = await options.repository.commit({
          command,
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          signal
        });
        if (committed.jobId !== job.jobId) throw new OrganizerUnavailableError();
        if (committed.outcome === expectedOutcome) return "completed";
        if (committed.outcome === "review_required") {
          replanCount = committed.replanCount;
          pendingReviewReason = reviewReasonForConflict(committed.conflictReason, controls);
          pendingReviewPlan = plan.validatedPlan;
          pendingRoutingDecision = routingDecision;
          writeGeneration += 1;
          continue;
        }
        if (committed.outcome !== "replan") throw new OrganizerUnavailableError();
        if (replanCount === 0) {
          writeGeneration += 1;
          replanCount = 1;
          continue;
        }
        throw new OrganizerUnavailableError();
      }
    } catch (error: unknown) {
      const failure = safeFailure(error);
      const origin = errorOrigin(error);
      const providerStatus =
        error instanceof OrganizerProviderError && error.status !== null ? error.status : undefined;
      const identity = error instanceof OrganizerProviderError ? error.identity : null;
      options.onJobFailure?.({
        errorCode: failure.errorCode,
        retryable: failure.retryable,
        errorName: error instanceof Error ? error.name : typeof error,
        ...(origin === undefined ? {} : { origin }),
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(identity?.type === undefined ? {} : { providerErrorType: identity.type }),
        ...(identity?.code === undefined ? {} : { providerErrorCode: identity.code }),
        ...(identity?.param === undefined ? {} : { providerErrorParam: identity.param }),
        ...(identity?.schemaError === undefined
          ? {}
          : { providerSchemaError: identity.schemaError })
      });
      const providerSelection = providerCredential?.lastSelection() ?? null;
      try {
        const result = await options.repository.fail({
          errorCode: failure.errorCode,
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          providerCredentialRevision: providerSelection?.credentialRevision ?? null,
          providerSource: providerSelection?.source ?? null,
          retryable: failure.retryable,
          signal
        });
        return result.state === "awaiting_retry" ? "retry" : "failed";
      } catch {
        return "failed";
      }
    } finally {
      options.repository.release(job.jobId);
    }
  }

  return Object.freeze({
    async drain(input): Promise<OrganizerDrainResult> {
      await options.repository.preflight(input.signal);
      if (input.trigger === "recovery")
        await options.repository.recoverStale(options.recoveryLimit, input.signal);
      const jobs = await options.repository.claim({
        leaseSeconds: options.leaseSeconds,
        limit: options.claimLimit,
        signal: input.signal,
        workerId: options.workerId
      });
      let cursor = 0;
      const outcomes: ("completed" | "failed" | "retry")[] = [];
      async function consume(): Promise<void> {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const job = jobs[index];
          if (job === undefined) return;
          outcomes.push(await processJob(job, input.authority, input.signal));
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(options.concurrency, jobs.length) }, () => consume())
      );
      return Object.freeze({
        claimed: jobs.length,
        completed: outcomes.filter((value) => value === "completed").length,
        failed: outcomes.filter((value) => value === "failed").length,
        retryScheduled: outcomes.filter((value) => value === "retry").length
      });
    }
  });
}

export function isOrganizerDrainResult(value: unknown): value is OrganizerDrainResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "claimed,completed,failed,retryScheduled") return false;
  const counts = [row.claimed, row.completed, row.failed, row.retryScheduled];
  return (
    counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0) &&
    Number(row.completed) + Number(row.failed) + Number(row.retryScheduled) <= Number(row.claimed)
  );
}
