import { after } from "next/server";

import { environmentIndexWorkerClient, type IndexWorkerClient } from "./index-worker-client";
import { drainIndexWorkerUntilIdle } from "./index-worker-drain";

export type IndexWorkerSchedulerDependencies = Readonly<{
  client?: IndexWorkerClient;
  defer?: (task: () => Promise<void>) => void;
}>;

export async function runIndexDrainWakeup(
  dependencies: Pick<IndexWorkerSchedulerDependencies, "client"> = {}
): Promise<void> {
  const client = dependencies.client ?? environmentIndexWorkerClient;
  try {
    await drainIndexWorkerUntilIdle({
      client,
      maxWaves: 2,
      signal: AbortSignal.timeout(55_000),
      trigger: "schedule"
    });
  } catch {
    // The encrypted database queue and authenticated recovery cron are
    // authoritative. Prompt wake-up is deliberately best-effort and its
    // failure carries no note content, owner ID, or destination metadata.
  }
}

export function scheduleIndexDrain(dependencies: IndexWorkerSchedulerDependencies = {}): void {
  const defer = dependencies.defer ?? after;
  try {
    defer(() =>
      runIndexDrainWakeup(dependencies.client === undefined ? {} : { client: dependencies.client })
    );
  } catch {
    // Non-Vercel runtimes keep the durable queue; the recovery route owns retry.
  }
}
