import { after } from "next/server";

import { runIndexDrainWakeup } from "@/server/indexing/index-worker-scheduler";

import { environmentOrganizerClient, type OrganizerClient } from "./organizer-client";
import { drainCaptureJobs, type CaptureDrainResult } from "./workflow";

export type CaptureWorkflowSchedulerDependencies = Readonly<{
  client?: OrganizerClient;
  defer?: (task: () => Promise<void>) => void;
  environment?: Readonly<Record<string, string | undefined>>;
  localDrain?: () => Promise<CaptureDrainResult>;
}>;

function isProductionRuntime(environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.VERCEL === "1" && environment.VERCEL_ENV === "production";
}

export async function runOrganizerDrainWakeup(
  dependencies: Pick<
    CaptureWorkflowSchedulerDependencies,
    "client" | "environment" | "localDrain"
  > = {}
): Promise<void> {
  try {
    const environment = dependencies.environment ?? process.env;
    const productionRuntime = isProductionRuntime(environment);
    const result = productionRuntime
      ? await (dependencies.client ?? environmentOrganizerClient).drain(
          "schedule",
          AbortSignal.timeout(55_000)
        )
      : await (dependencies.localDrain ?? (() => drainCaptureJobs()))();
    if (!productionRuntime && result.completed > 0) await runIndexDrainWakeup();
  } catch {
    // The encrypted capture and index queues plus their authenticated recovery
    // crons are authoritative. Production does not chain two 55-second drains
    // inside one 60-second Vercel lifecycle.
  }
}

export function scheduleCaptureDrain(
  dependencies: CaptureWorkflowSchedulerDependencies = {}
): void {
  const defer = dependencies.defer ?? after;
  try {
    defer(() =>
      runOrganizerDrainWakeup({
        ...(dependencies.client === undefined ? {} : { client: dependencies.client }),
        ...(dependencies.environment === undefined
          ? {}
          : { environment: dependencies.environment }),
        ...(dependencies.localDrain === undefined ? {} : { localDrain: dependencies.localDrain })
      })
    );
  } catch {
    // A runtime without Next's request lifecycle still keeps the durable job.
  }
}
