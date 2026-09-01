import { after } from "next/server";

import { environmentOrganizerClient, type OrganizerClient } from "./organizer-client";

export type CaptureWorkflowSchedulerDependencies = Readonly<{
  client?: OrganizerClient;
  defer?: (task: () => Promise<void>) => void;
}>;

export async function runOrganizerDrainWakeup(
  dependencies: Pick<CaptureWorkflowSchedulerDependencies, "client"> = {}
): Promise<void> {
  try {
    await (dependencies.client ?? environmentOrganizerClient).drain(
      "schedule",
      AbortSignal.timeout(55_000)
    );
  } catch {
    // The encrypted organizer and index queues plus their authenticated
    // recovery crons are authoritative and run independently.
  }
}

export function scheduleCaptureDrain(
  dependencies: CaptureWorkflowSchedulerDependencies = {}
): void {
  const defer = dependencies.defer ?? after;
  try {
    defer(() =>
      runOrganizerDrainWakeup({
        ...(dependencies.client === undefined ? {} : { client: dependencies.client })
      })
    );
  } catch {
    // A runtime without Next's request lifecycle still keeps the durable job.
  }
}
