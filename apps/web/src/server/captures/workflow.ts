import { ContentCryptoError, ContentCryptoErrorCode } from "@unfiled/content-crypto";

import type { CaptureContentProtector } from "./content-protection";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_SECONDS = 120;
const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
const MAX_HEARTBEAT_INTERVAL_MS = 30_000;
const WORKER_ID = "unfiled-deterministic-capture-v1";

export type ClaimedCaptureJob = Readonly<{
  jobId: string;
  captureId: string;
  userId: string;
  attempt: number;
  leaseToken: string;
  encryptedContent: unknown;
  source: string;
  privacy: string;
  explicitDestinationNoteId: string | null;
  expansionDisabled: boolean;
}>;

export type CaptureWorkflowStore = Readonly<{
  claim(
    workerId: string,
    limit: number,
    leaseSeconds: number
  ): Promise<readonly ClaimedCaptureJob[]>;
  heartbeat(jobId: string, leaseToken: string, leaseSeconds: number): Promise<void>;
  complete(jobId: string, leaseToken: string, status: "inbox"): Promise<void>;
  fail(
    jobId: string,
    leaseToken: string,
    errorCode: "invalid_capture" | "provider_unavailable",
    retryable: boolean
  ): Promise<void>;
  recover(limit: number): Promise<void>;
}>;

export type DeterministicCaptureOrganizer = Readonly<{
  organize(
    input: Readonly<{ content: string; job: ClaimedCaptureJob; signal: AbortSignal }>
  ): Promise<"inbox">;
}>;

export type CaptureDrainResult = Readonly<{
  claimed: number;
  completed: number;
  failed: number;
  retryScheduled: number;
}>;

export const deterministicCaptureOrganizer: DeterministicCaptureOrganizer = Object.freeze({
  organize({ content }) {
    // Reading the content here is intentional: a successful terminal transition
    // proves that the authenticated envelope was opened. Milestone C keeps the
    // result in Inbox and persists no derived plaintext or speculative routing.
    if (content.trim().length === 0) throw new TypeError("invalid capture");
    return Promise.resolve("inbox");
  }
});

function cryptoFailure(error: unknown): Readonly<{
  code: "invalid_capture" | "provider_unavailable";
  retryable: boolean;
}> {
  if (!(error instanceof ContentCryptoError)) {
    return { code: "provider_unavailable", retryable: true };
  }
  const cryptoError: ContentCryptoError = error;
  if (
    cryptoError.code === ContentCryptoErrorCode.KEY_NOT_FOUND ||
    cryptoError.code === ContentCryptoErrorCode.UNSUPPORTED_RUNTIME
  ) {
    return { code: "provider_unavailable", retryable: true };
  }
  return { code: "invalid_capture", retryable: false };
}

class LeaseHeartbeatLostError extends Error {
  constructor() {
    super("Capture job lease heartbeat failed");
    this.name = "LeaseHeartbeatLostError";
  }
}

type LeaseHeartbeat = Readonly<{
  assertActive(): void;
  signal: AbortSignal;
  stop(): Promise<void>;
}>;

function heartbeatIntervalMs(leaseSeconds: number): number {
  return Math.min(
    MAX_HEARTBEAT_INTERVAL_MS,
    Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor((leaseSeconds * 1_000) / 3))
  );
}

function startLeaseHeartbeat(
  store: CaptureWorkflowStore,
  job: ClaimedCaptureJob,
  leaseSeconds: number
): LeaseHeartbeat {
  const abortController = new AbortController();
  const intervalMs = heartbeatIntervalMs(leaseSeconds);
  let failure: LeaseHeartbeatLostError | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    if (stopped || failure !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || failure !== null) return;
      inFlight = store
        .heartbeat(job.jobId, job.leaseToken, leaseSeconds)
        .catch(() => {
          failure = new LeaseHeartbeatLostError();
          abortController.abort();
        })
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, intervalMs);
  };

  schedule();

  return {
    assertActive() {
      if (failure !== null) throw failure;
    },
    signal: abortController.signal,
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (inFlight !== null) await inFlight;
      if (failure !== null) throw failure;
    }
  };
}

export async function drainCaptureJobs(
  dependencies: Readonly<{
    organizer?: DeterministicCaptureOrganizer;
    protector: CaptureContentProtector;
    store: CaptureWorkflowStore;
    batchSize?: number;
    leaseSeconds?: number;
    workerId?: string;
  }>
): Promise<CaptureDrainResult> {
  const organizer = dependencies.organizer ?? deterministicCaptureOrganizer;
  const protector = dependencies.protector;
  const store = dependencies.store;
  const batchSize = dependencies.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseSeconds = dependencies.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const workerId = dependencies.workerId ?? WORKER_ID;

  // Resolve active encryption and fingerprint keys before any lease is claimed.
  // Missing or invalid key configuration therefore leaves queued jobs untouched.
  await protector.ready();
  await store.recover(batchSize * 5);
  const jobs = await store.claim(workerId, batchSize, leaseSeconds);
  let completed = 0;
  let failed = 0;
  let retryScheduled = 0;

  await Promise.all(
    jobs.map(async (job) => {
      const heartbeat = startLeaseHeartbeat(store, job, leaseSeconds);
      try {
        if (job.privacy !== "ai_assisted") {
          throw new ContentCryptoError(
            ContentCryptoErrorCode.INVALID_ENVELOPE,
            "Private content cannot enter the organization workflow"
          );
        }
        const content = await protector.openCapture(
          job.encryptedContent,
          job.userId,
          job.captureId
        );
        heartbeat.assertActive();
        const status = await organizer.organize({ content, job, signal: heartbeat.signal });
        await heartbeat.stop();
        await store.complete(job.jobId, job.leaseToken, status);
        completed += 1;
      } catch (error: unknown) {
        let transitionError = error;
        try {
          await heartbeat.stop();
        } catch (heartbeatError: unknown) {
          transitionError = heartbeatError;
        }
        if (transitionError instanceof LeaseHeartbeatLostError) {
          // Lease ownership can no longer be proven. Do not attempt any terminal
          // transition; stale-lease recovery will make the job runnable again.
          retryScheduled += 1;
          return;
        }
        const failure = cryptoFailure(transitionError);
        try {
          await store.fail(job.jobId, job.leaseToken, failure.code, failure.retryable);
          if (failure.retryable) retryScheduled += 1;
          else failed += 1;
        } catch {
          // The durable lease remains the source of truth. A failed transition
          // is recovered after lease expiry on a later invocation.
          retryScheduled += 1;
        }
      }
    })
  );

  return { claimed: jobs.length, completed, failed, retryScheduled };
}
