import {
  DecisionCorrectionRequestSchema,
  type CorrectionDestination,
  type DecisionCorrectionRequest,
  type DecisionCorrectionResponse,
  type EntityId
} from "@unfiled/contracts";

import { isAmbiguousProductMutationFailure, productRetryAfterSeconds } from "./browser-api";
import { createIdempotencyKey } from "./client";

/** The one call a correction needs, so the flow can be exercised without a browser. */
export type CorrectionApi = Readonly<{
  correctDecision: (
    decisionId: string,
    input: DecisionCorrectionRequest
  ) => Promise<DecisionCorrectionResponse>;
}>;

/**
 * One correction as the API must see it every time it is sent: the decision, the exact body,
 * and the idempotency key minted for that body. ADR-0011 acknowledges a correction only after
 * its rule observation lands; when that wait runs out the API answers 503 provider_unavailable
 * with the move already durable, and only a replay of this same key opens the stored answer
 * instead of asking for a second move.
 */
export type CorrectionAttempt = Readonly<{
  decisionId: EntityId<"dec">;
  request: DecisionCorrectionRequest;
}>;

/** An attempt kept for a manual retry, bound to the form values that produced it. */
export type RetainedCorrection = Readonly<{ attempt: CorrectionAttempt; intent: string }>;

export function correctionAttempt(
  decisionId: EntityId<"dec">,
  source: DecisionCorrectionRequest["source"],
  destination: CorrectionDestination,
  idempotencyKey: string = createIdempotencyKey()
): CorrectionAttempt {
  return Object.freeze({
    decisionId,
    request: DecisionCorrectionRequestSchema.parse({ idempotencyKey, source, destination })
  });
}

/** The pause before a replay when the server names none: its observation keeps running after
 * it answers, so a replay a moment later finds the work done. */
export const CORRECTION_REPLAY_DELAY_MS = 1_500;
/** The longest a form will wait on the server's own retry-after before replaying. */
export const MAX_CORRECTION_REPLAY_WAIT_MS = 5_000;

export function correctionReplayDelayMs(reason: unknown): number {
  const retryAfter = productRetryAfterSeconds(reason);
  if (retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return CORRECTION_REPLAY_DELAY_MS;
  }
  return Math.min(retryAfter * 1000, MAX_CORRECTION_REPLAY_WAIT_MS);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends the attempt and, after an ambiguous outcome (a lost response, or the observation wait
 * running out), sends the identical attempt once more after a pause. Definitive failures
 * (stale_revision, validation, forbidden) surface unchanged: a replay would only repeat them,
 * and a fresh key would be a second move.
 */
export async function submitCorrection(
  api: CorrectionApi,
  attempt: CorrectionAttempt,
  wait: (ms: number) => Promise<void> = pause
): Promise<DecisionCorrectionResponse> {
  try {
    return await api.correctDecision(attempt.decisionId, attempt.request);
  } catch (reason) {
    if (!isAmbiguousProductMutationFailure(reason)) throw reason;
    await wait(correctionReplayDelayMs(reason));
    return api.correctDecision(attempt.decisionId, attempt.request);
  }
}

/**
 * What a manual retry should send. The phone keeps its correction attempts keyed by intent so
 * a second tap replays the first request; here the intent is the form's own values, so an
 * attempt is kept only while the owner is still asking for the same move.
 */
export function attemptToReplay(
  retained: RetainedCorrection | null,
  intent: string
): CorrectionAttempt | null {
  return retained !== null && retained.intent === intent ? retained.attempt : null;
}

/** Keeps the attempt after an ambiguous failure; a definitive one needs fresh revisions and a
 * fresh key, so nothing is kept. */
export function retainAfterFailure(
  attempt: CorrectionAttempt,
  intent: string,
  reason: unknown
): RetainedCorrection | null {
  return isAmbiguousProductMutationFailure(reason) ? Object.freeze({ attempt, intent }) : null;
}
