import { after } from "next/server";

import { drainCaptureJobs } from "./workflow";

export function scheduleCaptureDrain(): void {
  try {
    after(async () => {
      try {
        await drainCaptureJobs();
      } catch {
        // The durable queued job and lease recovery cron are authoritative.
        // Prompt processing is deliberately best-effort and content-free.
      }
    });
  } catch {
    // A runtime without Next's request lifecycle still keeps the durable job.
  }
}
