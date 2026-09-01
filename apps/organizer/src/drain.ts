import {
  materializeAuthorizedOrganizationPlan,
  OrganizationMaterializationError,
  parseAuthorizedOrganizationPlan,
  type MaterializedOrganizationCommand,
  type OrganizerCandidateManifest,
  type StableOrganizationIds
} from "@unfiled/ai-routing";
import { createHash } from "node:crypto";

import type { OrganizerKeyAuthority } from "./key-management.js";
import {
  type DecryptedCandidate,
  type DecryptedCapture,
  type OrganizerCaptureControls,
  type OrganizerPlanner,
  proposedNoteIdForJob
} from "./planner.js";
import { OrganizerUnavailableError } from "./errors.js";

export type DrainTrigger = "manual" | "recovery" | "schedule";
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
  key: unknown;
}>;
export type ClaimedOrganizerJob = Readonly<{
  attempt: number;
  captureId: `cap_${string}`;
  controls: OrganizerCaptureControls;
  jobId: string;
  leaseExpiresAt: string;
  leaseToken: string;
  ownerId: string;
  promptVersion: string;
  replanCount: 0 | 1;
  schemaVersion: number;
  source: EncryptedProjection;
}>;
export type EncryptedCandidate = Readonly<{
  candidateId: `note_${string}`;
  isOpen: boolean;
  noteId: `note_${string}`;
  noteType: DecryptedCandidate["noteType"];
  revision: number;
  source: EncryptedProjection;
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
    noteWrite: Readonly<{ operationCount: 4; reservationId: string }>;
    receipt: Readonly<{ operationCount: 1; reservationId: string }>;
    review: Readonly<{ operationCount: 1; reservationId: string }>;
  }>;
  targetRevision: number;
}>;
export type AtomicOrganizerCommand = Readonly<{
  decision: unknown;
  noteWrite: unknown;
  outcome: "appended" | "created" | "review";
  receipt: unknown;
  review: unknown;
  reviewReason: OrganizerReviewReason | null;
}>;
export type OrganizerReviewReason =
  | "explicit_destination_unavailable"
  | "expansion_pending"
  | "planner_ambiguity"
  | "revision_conflict";
export type OrganizerConflictReason = "candidate_eligibility" | "consent_controls" | "revision";
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
      authority: OrganizerKeyAuthority;
      capture: DecryptedCapture;
      controls: OrganizerCaptureControls;
      job: ClaimedOrganizerJob;
      plan: MaterializedOrganizationCommand;
      preparation: OrganizerPreparation;
      reviewReason: OrganizerReviewReason | null;
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
    generatedBlockId: null,
    mutationId: `mut_${suffix}`,
    reviewItemId: `rvw_${suffix}`,
    revisionId: `rev_${suffix}`
  });
}

function preparedStableIds(
  preparation: OrganizerPreparation,
  decision: "add_to_inbox" | "append_to_note" | "create_note" | "needs_review"
): StableOrganizationIds {
  const routed = decision === "append_to_note" || decision === "create_note";
  return Object.freeze({
    createdNoteId: decision === "create_note" ? preparation.noteId : null,
    decisionId: preparation.ids.decisionId,
    generatedBlockId: null,
    mutationId: routed ? preparation.ids.mutationId : null,
    reviewItemId: decision === "needs_review" ? preparation.ids.reviewItemId : null,
    revisionId: routed ? preparation.ids.revisionId : null
  });
}

function safeFailure(error: unknown): Readonly<{ errorCode: string; retryable: boolean }> {
  if (error instanceof OrganizerUnavailableError)
    return { errorCode: "provider_unavailable", retryable: true };
  return { errorCode: "validation_failed", retryable: false };
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
  preparation: OrganizerPreparation
): Readonly<{ plan: MaterializedOrganizationCommand; stableIds: StableOrganizationIds }> {
  const authorized = parseAuthorizedOrganizationPlan({
    manifest,
    unknownPlan: {
      alternatives: [],
      captureKind: "freeform",
      decision: "needs_review",
      destination: { candidateId: null, newNote: null },
      generatedExpansion: null,
      operations: [],
      reasonCodes: ["ambiguous_intent"],
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
  return plan.kind === "review" && plan.disposition === "needs_review" ? "planner_ambiguity" : null;
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
  if (
    command.outcome !== expectedOutcome ||
    command.reviewReason !== reviewReason ||
    (plan.kind === "review") !== (command.noteWrite === null) ||
    (plan.kind === "review") !== (reviewReason !== null)
  )
    throw new OrganizerUnavailableError();
}

export function createOrganizerDrain(
  options: Readonly<{
    candidateLimit?: number;
    claimLimit: number;
    concurrency: number;
    leaseSeconds: number;
    planner: OrganizerPlanner;
    recoveryLimit: number;
    repository: OrganizerRepository;
    cipher: OrganizerCipher;
    workerId: string;
  }>
): OrganizerDrainPort {
  async function processJob(
    job: ClaimedOrganizerJob,
    authority: OrganizerKeyAuthority,
    signal: AbortSignal
  ): Promise<"completed" | "failed" | "retry"> {
    try {
      const capture = await options.cipher.openCapture({ authority, job, signal });
      if (
        capture.controls.expansionDisabled !== job.controls.expansionDisabled ||
        capture.controls.explicitDestinationNoteId !== job.controls.explicitDestinationNoteId
      )
        throw new OrganizerUnavailableError();
      let replanCount: 0 | 1 = job.replanCount;
      let writeGeneration = 0;
      let plannerCalls = 0;
      let pendingReviewReason: OrganizerReviewReason | null = null;

      async function commitReview(
        manifest: OrganizerCandidateManifest,
        revalidationManifest: CandidateRevalidationManifest,
        controls: OrganizerCaptureControls,
        reviewReason: OrganizerReviewReason,
        suppliedPreparation?: OrganizerPreparation
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
        const review = forcedReview(manifest, preparation);
        const command = await options.cipher.sealCommand({
          authority,
          capture: Object.freeze({ controls, rawContent: capture.rawContent }),
          controls,
          job,
          plan: review.plan,
          preparation,
          reviewReason,
          signal,
          stableIds: review.stableIds
        });
        assertCommandBinding(command, review.plan, reviewReason);
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
        const page = await options.repository.candidates({
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          limit: options.candidateLimit ?? 8,
          signal
        });
        const encryptedCandidates = page.candidates;
        const controls = page.controls;
        const currentCapture = Object.freeze({ controls, rawContent: capture.rawContent });
        const routableEncryptedCandidates = encryptedCandidates.filter(({ isOpen }) => isOpen);
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
          candidates: candidates.map(({ candidateId, isOpen, noteId, noteType, revision }) => ({
            candidateId,
            isOpen,
            noteId,
            noteType,
            revision
          })),
          controls,
          authorizedSpaceIds: [],
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
        if (pendingReviewReason !== null) {
          const result = await commitReview(
            manifest,
            revalidationManifest,
            controls,
            pendingReviewReason
          );
          if (result === "retry") continue;
          return result;
        }
        if (plannerCalls >= (job.replanCount === 0 ? 2 : 1)) {
          pendingReviewReason = "revision_conflict";
          continue;
        }
        plannerCalls += 1;
        let unknownPlan: unknown;
        try {
          unknownPlan = await options.planner.plan({
            capture: currentCapture,
            candidates,
            captureId: job.captureId,
            controls,
            signal
          });
        } catch {
          throw new OrganizerUnavailableError();
        }
        let authorized: ReturnType<typeof parseAuthorizedOrganizationPlan>;
        try {
          authorized = parseAuthorizedOrganizationPlan({ manifest, unknownPlan });
        } catch (error: unknown) {
          if (!(error instanceof OrganizationMaterializationError)) throw error;
          pendingReviewReason = "planner_ambiguity";
          continue;
        }
        if (authorized.plan.generatedExpansion !== null) {
          pendingReviewReason = "expansion_pending";
          continue;
        }
        if (authorized.plan.decision === "add_to_inbox") {
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
              pendingReviewReason,
              preparationResult.preparation
            );
            if (result === "retry") continue;
            return result;
          }
        }
        const preparation =
          "outcome" in preparationResult ? preparationResult.preparation : preparationResult;
        const stableIds = preparedStableIds(preparation, authorized.plan.decision);
        let plan: MaterializedOrganizationCommand;
        try {
          plan = materializeAuthorizedOrganizationPlan({ ...authorized, stableIds });
        } catch (error: unknown) {
          if (!(error instanceof OrganizationMaterializationError)) throw error;
          pendingReviewReason = "planner_ambiguity";
          const result = await commitReview(
            manifest,
            revalidationManifest,
            controls,
            pendingReviewReason,
            preparation
          );
          if (result === "retry") continue;
          return result;
        }
        const reviewReason = reviewReasonForPlan(plan);
        const command = await options.cipher.sealCommand({
          authority,
          capture: currentCapture,
          controls,
          job,
          plan,
          preparation,
          reviewReason,
          signal,
          stableIds
        });
        const expectedOutcome =
          plan.kind === "append" ? "appended" : plan.kind === "create" ? "created" : "review";
        assertCommandBinding(command, plan, reviewReason);
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
          writeGeneration += 1;
          replanCount = 1;
          continue;
        }
        const committed = await options.repository.commit({
          command,
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          signal
        });
        if (committed.jobId !== job.jobId) throw new OrganizerUnavailableError();
        if (committed.outcome === expectedOutcome) return "completed";
        if (committed.outcome === "review_required") {
          pendingReviewReason = reviewReasonForConflict(committed.conflictReason, controls);
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
      try {
        const result = await options.repository.fail({
          errorCode: failure.errorCode,
          jobId: job.jobId,
          leaseToken: job.leaseToken,
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
