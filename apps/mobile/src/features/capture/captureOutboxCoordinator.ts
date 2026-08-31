import { ApiClientError } from "@unfiled/api-client";
import type {
  ApiErrorCodeValue,
  CaptureCreateRequest,
  CaptureCreateResponse
} from "@unfiled/contracts";
import { retryDelayMilliseconds } from "@unfiled/sync";

import type { CaptureOutboxRecord } from "./captureOutboxTypes";

const MAXIMUM_ATTEMPTS = 5;
const MAXIMUM_BATCH_SIZE = 25;
const MAXIMUM_RETRY_DELAY_MS = 120_000;

type FailureDisposition = "retry" | "permanent" | "wait_for_sign_in";

export interface CaptureSyncFailure {
  attemptLimit: number | null;
  code: ApiErrorCodeValue;
  disposition: FailureDisposition;
  retryAfterMilliseconds: number | null;
}

export interface CaptureOutboxStore {
  claimNext(profileId: string, now: string): Promise<CaptureOutboxRecord | null>;
  markPermanentFailure(
    profileId: string,
    captureId: string,
    code: ApiErrorCodeValue
  ): Promise<void>;
  markRetry(
    profileId: string,
    captureId: string,
    code: ApiErrorCodeValue,
    nextAttemptAt: string
  ): Promise<void>;
  markSynced(
    profileId: string,
    captureId: string,
    response: CaptureCreateResponse,
    acknowledgedAt?: string
  ): Promise<void>;
  markWaitingForSignIn(profileId: string, captureId: string): Promise<void>;
  recover(profileId: string): Promise<void>;
}

export interface DrainCaptureOutboxOptions {
  maximumBatchSize?: number;
  now?: () => number;
  profileId: string;
  send: (capture: CaptureCreateRequest) => Promise<CaptureCreateResponse>;
  store: CaptureOutboxStore;
}

export interface CaptureDrainSummary {
  attempted: number;
  failedPermanently: number;
  scheduledForRetry: number;
  synced: number;
  waitingForSignIn: boolean;
}

export function classifyCaptureSyncFailure(error: unknown): CaptureSyncFailure {
  if (error instanceof ApiClientError) {
    if (error.status === 401) {
      return {
        attemptLimit: null,
        code: "unauthorized",
        disposition: "wait_for_sign_in",
        retryAfterMilliseconds: null
      };
    }
    if (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      return {
        attemptLimit: MAXIMUM_ATTEMPTS,
        code: error.error.code,
        disposition: "retry",
        retryAfterMilliseconds:
          error.error.retryAfterSeconds === undefined
            ? null
            : Math.min(error.error.retryAfterSeconds * 1000, MAXIMUM_RETRY_DELAY_MS)
      };
    }
    return {
      attemptLimit: 0,
      code: error.error.code,
      disposition: "permanent",
      retryAfterMilliseconds: null
    };
  }
  return {
    attemptLimit: null,
    code: "offline",
    disposition: "retry",
    retryAfterMilliseconds: null
  };
}

function nextAttemptAt(
  attemptCount: number,
  nowEpochMilliseconds: number,
  requestedDelay: number | null
): string {
  const delay = Math.min(
    Math.max(retryDelayMilliseconds(attemptCount), requestedDelay ?? 0),
    MAXIMUM_RETRY_DELAY_MS
  );
  return new Date(nowEpochMilliseconds + delay).toISOString();
}

export async function drainCaptureOutbox({
  maximumBatchSize = MAXIMUM_BATCH_SIZE,
  now = Date.now,
  profileId,
  send,
  store
}: DrainCaptureOutboxOptions): Promise<CaptureDrainSummary> {
  const summary: CaptureDrainSummary = {
    attempted: 0,
    failedPermanently: 0,
    scheduledForRetry: 0,
    synced: 0,
    waitingForSignIn: false
  };
  await store.recover(profileId);

  while (summary.attempted < maximumBatchSize) {
    const entry = await store.claimNext(profileId, new Date(now()).toISOString());
    if (entry === null) break;
    summary.attempted += 1;
    try {
      const response = await send(entry.capture);
      await store.markSynced(
        profileId,
        entry.capture.clientCaptureId,
        response,
        new Date(now()).toISOString()
      );
      summary.synced += 1;
    } catch (error) {
      const failure = classifyCaptureSyncFailure(error);
      if (failure.disposition === "wait_for_sign_in") {
        await store.markWaitingForSignIn(profileId, entry.capture.clientCaptureId);
        summary.waitingForSignIn = true;
        break;
      }
      if (
        failure.disposition === "permanent" ||
        (failure.attemptLimit !== null && entry.attemptCount >= failure.attemptLimit)
      ) {
        await store.markPermanentFailure(profileId, entry.capture.clientCaptureId, failure.code);
        summary.failedPermanently += 1;
        continue;
      }
      await store.markRetry(
        profileId,
        entry.capture.clientCaptureId,
        failure.code,
        nextAttemptAt(entry.attemptCount, now(), failure.retryAfterMilliseconds)
      );
      summary.scheduledForRetry += 1;
    }
  }
  return summary;
}
