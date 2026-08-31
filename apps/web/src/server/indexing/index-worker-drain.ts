import type { IndexDrainResult, IndexDrainTrigger, IndexWorkerClient } from "./index-worker-client";

export type IndexDrainRunResult = IndexDrainResult & Readonly<{ waves: number }>;

export async function drainIndexWorkerUntilIdle(
  input: Readonly<{
    client: IndexWorkerClient;
    maxWaves: number;
    signal: AbortSignal;
    trigger: IndexDrainTrigger;
  }>
): Promise<IndexDrainRunResult> {
  if (!Number.isSafeInteger(input.maxWaves) || input.maxWaves < 1 || input.maxWaves > 8) {
    throw new TypeError("Invalid index drain bound.");
  }
  let waves = 0;
  let claimed = 0;
  let completed = 0;
  let failed = 0;
  let retryScheduled = 0;
  while (waves < input.maxWaves) {
    if (input.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const result = await input.client.drain(input.trigger, input.signal);
    waves += 1;
    claimed += result.claimed;
    completed += result.completed;
    failed += result.failed;
    retryScheduled += result.retryScheduled;
    if (result.claimed === 0) break;
  }
  return Object.freeze({ waves, claimed, completed, failed, retryScheduled });
}
