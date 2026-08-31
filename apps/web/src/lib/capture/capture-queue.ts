import { ApiClientError } from "@unfiled/api-client";
import type {
  ApiErrorCodeValue,
  CaptureCreateRequest,
  CaptureCreateResponse,
  CaptureProcessingState,
  CaptureSummary,
  EntityId
} from "@unfiled/contracts";

import type {
  CaptureLocalStore,
  CaptureOutboxItem,
  CaptureOutboxState,
  CaptureOutboxStatus,
  CaptureOutboxUpdate,
  DurableCaptureRequest
} from "./capture-store";

export const CAPTURE_POLL_INTERVAL_MS = 4_000;
export const MAX_AUTOMATIC_CAPTURE_ATTEMPTS = 5;
export const MAX_CAPTURE_FLUSH_BATCH = 25;
const MAX_RETRY_DELAY_MS = 300_000;

export type CaptureFailurePlan = Readonly<{
  attempts: number;
  errorCode: ApiErrorCodeValue;
  nextAttemptAt: number | null;
  state: "retrying" | "permanent";
}>;

export type CaptureQueueStore = Pick<CaptureLocalStore, "listOutbox" | "updateOutbox">;

export type CaptureTransport = Readonly<{
  createCapture(input: DurableCaptureRequest): Promise<CaptureCreateResponse>;
}>;

export type CaptureActivityStatus = CaptureProcessingState | Exclude<CaptureOutboxState, "synced">;

export type CaptureActivityItem = Readonly<{
  clientCreatedAt: string;
  errorCode: ApiErrorCodeValue | null;
  id: EntityId<"cap">;
  local: boolean;
  preview: string | null;
  receiptAvailable: boolean;
  serverAvailable: boolean;
  status: CaptureActivityStatus;
}>;

export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** exponent);
}

export function isRetryableCaptureFailure(reason: unknown): boolean {
  if (!(reason instanceof ApiClientError)) return true;
  if (reason.status === 408 || reason.status === 429 || reason.status >= 500) return true;
  return ["offline", "provider_unavailable", "rate_limited"].includes(reason.error.code);
}

function isOfflineCaptureFailure(reason: unknown): boolean {
  return !(reason instanceof ApiClientError) || reason.error.code === "offline";
}

function safeErrorCode(reason: unknown): ApiErrorCodeValue {
  return reason instanceof ApiClientError ? reason.error.code : "offline";
}

export function captureFailurePlan(
  reason: unknown,
  attempts: number,
  now: number
): CaptureFailurePlan {
  const retryable =
    isRetryableCaptureFailure(reason) &&
    (isOfflineCaptureFailure(reason) || attempts < MAX_AUTOMATIC_CAPTURE_ATTEMPTS);
  const retryAfterMs =
    reason instanceof ApiClientError && reason.error.retryAfterSeconds !== undefined
      ? Math.min(MAX_RETRY_DELAY_MS, reason.error.retryAfterSeconds * 1_000)
      : retryDelayMs(attempts);
  return {
    attempts,
    errorCode: safeErrorCode(reason),
    nextAttemptAt: retryable ? now + retryAfterMs : null,
    state: retryable ? "retrying" : "permanent"
  };
}

function isReady(item: CaptureOutboxItem, now: number): boolean {
  return (
    (item.state === "waiting" || item.state === "retrying") &&
    item.nextAttemptAt !== null &&
    item.nextAttemptAt <= now
  );
}

export async function flushCaptureOutbox(
  store: CaptureQueueStore,
  profileId: string,
  transport: CaptureTransport,
  now: number
): Promise<Readonly<{ attempted: number; failed: number; synced: number }>> {
  // Stable clientCaptureId values make overlapping cross-tab sends safe at the server boundary.
  const ready = (await store.listOutbox(profileId))
    .filter((item) => isReady(item, now))
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, MAX_CAPTURE_FLUSH_BATCH);
  let failed = 0;
  let synced = 0;
  for (const item of ready) {
    const captureId = item.request.clientCaptureId;
    await store.updateOutbox(profileId, captureId, {
      attempts: item.attempts,
      errorCode: null,
      nextAttemptAt: null,
      state: "sending",
      updatedAt: now
    });
    try {
      await transport.createCapture(item.request);
      synced += 1;
      await store.updateOutbox(profileId, captureId, {
        attempts: item.attempts,
        errorCode: null,
        nextAttemptAt: null,
        state: "synced",
        updatedAt: now
      });
    } catch (reason) {
      failed += 1;
      const plan = captureFailurePlan(reason, item.attempts + 1, now);
      const update: CaptureOutboxUpdate = { ...plan, updatedAt: now };
      await store.updateOutbox(profileId, captureId, update);
    }
  }
  return { attempted: ready.length, failed, synced };
}

export async function submitDurably(
  store: Pick<CaptureLocalStore, "enqueueCapture">,
  profileId: string,
  request: CaptureCreateRequest,
  now: number,
  acknowledge: (item: CaptureOutboxItem) => void,
  scheduleFlush: () => void
): Promise<CaptureOutboxItem> {
  const item = await store.enqueueCapture(profileId, request, now);
  acknowledge(item);
  scheduleFlush();
  return item;
}

export function mergeCaptureActivity(
  localItems: readonly CaptureOutboxStatus[],
  remoteItems: readonly CaptureSummary[],
  hiddenCaptureIds: ReadonlySet<string> = new Set()
): readonly CaptureActivityItem[] {
  const visibleRemoteItems = remoteItems.filter((item) => !hiddenCaptureIds.has(item.id));
  const remoteIds = new Set(visibleRemoteItems.map((item) => item.id));
  const remote = visibleRemoteItems.map((item): CaptureActivityItem => ({
    clientCreatedAt: item.clientCreatedAt,
    errorCode: item.lastErrorCode,
    id: item.id,
    local: false,
    preview: item.rawContentPreview,
    receiptAvailable: item.receiptAvailable,
    serverAvailable: true,
    status: item.status
  }));
  const local = localItems.flatMap((item): CaptureActivityItem[] => {
    if (remoteIds.has(item.clientCaptureId) || hiddenCaptureIds.has(item.clientCaptureId))
      return [];
    return [
      {
        clientCreatedAt: new Date(item.createdAt).toISOString(),
        errorCode: item.errorCode,
        id: item.clientCaptureId,
        local: true,
        preview: null,
        receiptAvailable: false,
        serverAvailable: item.state === "synced",
        status: item.state === "synced" ? "queued" : item.state
      }
    ];
  });
  return [...remote, ...local].sort(
    (left, right) => Date.parse(right.clientCreatedAt) - Date.parse(left.clientCreatedAt)
  );
}
