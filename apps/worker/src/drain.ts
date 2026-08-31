import type { AiAssistedKeyAuthority } from "./key-management-adapter";
import { WorkerUnavailableError } from "./errors";

export type DrainTrigger = "manual" | "recovery" | "schedule";

export type DrainResult = Readonly<{
  claimed: number;
  completed: number;
  failed: number;
  retryScheduled: number;
}>;

export type WorkerDrainPort = Readonly<{
  drain(
    input: Readonly<{
      authority: AiAssistedKeyAuthority;
      requestId: string;
      signal: AbortSignal;
      trigger: DrainTrigger;
    }>
  ): Promise<DrainResult>;
}>;

export function isDrainResult(value: unknown): value is DrainResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.join(",") !== "claimed,completed,failed,retryScheduled") return false;
  const counts = [row.claimed, row.completed, row.failed, row.retryScheduled];
  if (!counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) return false;
  return (
    Number(row.completed) + Number(row.failed) + Number(row.retryScheduled) <= Number(row.claimed)
  );
}

/**
 * No workflow is silently enabled before its content-free repository and
 * managed-key adapter are wired. Health remains available; drain fails closed.
 */
export const unconfiguredDrainPort: WorkerDrainPort = Object.freeze({
  drain() {
    return Promise.reject(new WorkerUnavailableError());
  }
});
