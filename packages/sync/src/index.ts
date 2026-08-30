import {
  ApiErrorCodeSchema,
  type ApiErrorCodeValue,
  type CaptureCreateRequest
} from "@unfiled/contracts";

export type OutboxState = "pending" | "syncing" | "retry_wait" | "synced" | "permanent_failure";

export type OutboxEntry = Readonly<{
  capture: CaptureCreateRequest;
  state: OutboxState;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastErrorCode: ApiErrorCodeValue | null;
  serverAcknowledgedAt: string | null;
}>;

export function createOutboxEntry(capture: CaptureCreateRequest): OutboxEntry {
  return Object.freeze({
    capture,
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    serverAcknowledgedAt: null
  });
}

export function beginSync(entry: OutboxEntry): OutboxEntry {
  if (entry.state === "synced" || entry.state === "permanent_failure") return entry;
  return Object.freeze({ ...entry, state: "syncing", attemptCount: entry.attemptCount + 1 });
}

export function acknowledgeSync(entry: OutboxEntry, acknowledgedAt: string): OutboxEntry {
  if (entry.state === "synced") return entry;
  return Object.freeze({
    ...entry,
    state: "synced",
    nextAttemptAt: null,
    lastErrorCode: null,
    serverAcknowledgedAt: acknowledgedAt
  });
}

export function retryDelayMilliseconds(attemptCount: number): number {
  const boundedAttempt = Math.max(1, Math.min(attemptCount, 8));
  return Math.min(1_000 * 2 ** (boundedAttempt - 1), 120_000);
}

export function scheduleRetry(
  entry: OutboxEntry,
  nowEpochMilliseconds: number,
  errorCode: ApiErrorCodeValue,
  maximumAttempts = 5
): OutboxEntry {
  const safeErrorCode = ApiErrorCodeSchema.parse(errorCode);
  if (entry.attemptCount >= maximumAttempts) {
    return Object.freeze({
      ...entry,
      state: "permanent_failure",
      nextAttemptAt: null,
      lastErrorCode: safeErrorCode
    });
  }
  const nextAttemptAt = new Date(
    nowEpochMilliseconds + retryDelayMilliseconds(entry.attemptCount)
  ).toISOString();
  return Object.freeze({
    ...entry,
    state: "retry_wait",
    nextAttemptAt,
    lastErrorCode: safeErrorCode
  });
}

export function reconcileEntries(entries: readonly OutboxEntry[]): readonly OutboxEntry[] {
  const byCaptureId = new Map<string, OutboxEntry>();
  for (const entry of entries) {
    const existing = byCaptureId.get(entry.capture.clientCaptureId);
    if (!existing || existing.attemptCount <= entry.attemptCount) {
      byCaptureId.set(entry.capture.clientCaptureId, entry);
    }
  }
  return Object.freeze([...byCaptureId.values()]);
}
