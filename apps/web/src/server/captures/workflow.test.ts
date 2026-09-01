import { readFile } from "node:fs/promises";

import { ContentCryptoError, ContentCryptoErrorCode } from "@unfiled/content-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CaptureContentProtector } from "./content-protection";
import {
  drainCaptureJobs,
  type CaptureWorkflowStore,
  type ClaimedCaptureJob,
  type DeterministicCaptureOrganizer
} from "./workflow";

const job: ClaimedCaptureJob = {
  jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  userId: "00000000-0000-4000-8000-000000000001",
  attempt: 1,
  leaseToken: "00000000-0000-4000-8000-000000000010",
  encryptedContent: { envelope: {}, fingerprint: "0".repeat(64), length: 7 },
  source: "web",
  privacy: "ai_assisted",
  explicitDestinationNoteId: null,
  expansionDisabled: false
};

function protector(
  open: () => Promise<string>,
  ready: () => Promise<void> = () => Promise.resolve()
): CaptureContentProtector {
  return {
    openCapture: vi.fn(open),
    protectCapture: vi.fn(),
    ready: vi.fn(ready)
  };
}

function store(
  jobs: readonly ClaimedCaptureJob[] = [job],
  overrides: Partial<CaptureWorkflowStore> = {}
): CaptureWorkflowStore {
  return {
    claim: overrides.claim ?? vi.fn().mockResolvedValue(jobs),
    heartbeat: overrides.heartbeat ?? vi.fn().mockResolvedValue(undefined),
    complete: overrides.complete ?? vi.fn().mockResolvedValue(undefined),
    fail: overrides.fail ?? vi.fn().mockResolvedValue(undefined),
    recover: overrides.recover ?? vi.fn().mockResolvedValue(undefined)
  };
}

describe("durable capture workflow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preflights keys, recovers expired leases, claims, decrypts, and completes Inbox", async () => {
    const events: string[] = [];
    const contentProtector = protector(
      () => {
        events.push("open");
        return Promise.resolve("buy milk");
      },
      () => {
        events.push("ready");
        return Promise.resolve();
      }
    );
    const workflowStore = store([job], {
      recover: vi.fn(() => {
        events.push("recover");
        return Promise.resolve();
      }),
      claim: vi.fn(() => {
        events.push("claim");
        return Promise.resolve([job]);
      })
    });
    const organizer: DeterministicCaptureOrganizer = {
      organize: vi.fn(({ content }: { content: string }) => {
        events.push(`organize:${content.length}`);
        return Promise.resolve("inbox" as const);
      })
    };

    const result = await drainCaptureJobs({
      protector: contentProtector,
      store: workflowStore,
      organizer,
      batchSize: 4,
      leaseSeconds: 90,
      workerId: "test-worker"
    });

    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(events).toEqual(["ready", "recover", "claim", "open", "organize:8"]);
    expect(workflowStore.recover).toHaveBeenCalledWith(20);
    expect(workflowStore.claim).toHaveBeenCalledWith("test-worker", 4, 90);
    expect(workflowStore.complete).toHaveBeenCalledWith(job.jobId, job.leaseToken, "inbox");
    expect(workflowStore.heartbeat).not.toHaveBeenCalled();
    expect(workflowStore.fail).not.toHaveBeenCalled();
  });

  it("renews a long-running organizer lease and stops heartbeats before completion", async () => {
    vi.useFakeTimers();
    let finishOrganization: ((status: "inbox") => void) | undefined;
    const workflowStore = store();
    const organizer: DeterministicCaptureOrganizer = {
      organize: vi.fn(
        () =>
          new Promise<"inbox">((resolve) => {
            finishOrganization = resolve;
          })
      )
    };

    const draining = drainCaptureJobs({
      protector: protector(() => Promise.resolve("buy milk")),
      store: workflowStore,
      organizer,
      leaseSeconds: 15
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(workflowStore.heartbeat).toHaveBeenCalledTimes(1);
    expect(workflowStore.heartbeat).toHaveBeenCalledWith(job.jobId, job.leaseToken, 15);

    finishOrganization?.("inbox");
    await expect(draining).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      retryScheduled: 0
    });
    expect(workflowStore.complete).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(workflowStore.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("aborts organization and leaves terminal recovery to the lease after heartbeat failure", async () => {
    vi.useFakeTimers();
    const workflowStore = store([job], {
      heartbeat: vi.fn().mockRejectedValue(new Error("database unavailable"))
    });
    let organizerSignal: AbortSignal | undefined;
    const organizer: DeterministicCaptureOrganizer = {
      organize: vi.fn(
        ({ signal }: Readonly<{ signal: AbortSignal }>) =>
          new Promise<"inbox">((_resolve, reject) => {
            organizerSignal = signal;
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              {
                once: true
              }
            );
          })
      )
    };

    const draining = drainCaptureJobs({
      protector: protector(() => Promise.resolve("buy milk")),
      store: workflowStore,
      organizer,
      leaseSeconds: 15
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(draining).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 0,
      retryScheduled: 1
    });
    expect(organizerSignal?.aborted).toBe(true);
    expect(workflowStore.complete).not.toHaveBeenCalled();
    expect(workflowStore.fail).not.toHaveBeenCalled();
  });

  it("leaves the durable queue untouched when key preflight fails", async () => {
    const contentProtector = protector(
      () => Promise.resolve("unused"),
      () => Promise.reject(new Error("key provider unavailable"))
    );
    const workflowStore = store();

    await expect(
      drainCaptureJobs({ protector: contentProtector, store: workflowStore })
    ).rejects.toThrow();
    expect(workflowStore.recover).not.toHaveBeenCalled();
    expect(workflowStore.claim).not.toHaveBeenCalled();
  });

  it("terminally fails authenticated-envelope corruption without leaking the reason", async () => {
    const contentProtector = protector(() =>
      Promise.reject(
        new ContentCryptoError(
          ContentCryptoErrorCode.AUTHENTICATION_FAILED,
          "do not expose this detail"
        )
      )
    );
    const workflowStore = store();

    const result = await drainCaptureJobs({ protector: contentProtector, store: workflowStore });

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1, retryScheduled: 0 });
    expect(workflowStore.fail).toHaveBeenCalledWith(
      job.jobId,
      job.leaseToken,
      "invalid_capture",
      false
    );
  });

  it("never decrypts a private-manual capture even if storage returns a malformed claim", async () => {
    const contentProtector = protector(() => Promise.resolve("must remain unopened"));
    const workflowStore = store([{ ...job, privacy: "private_manual" }]);

    const result = await drainCaptureJobs({ protector: contentProtector, store: workflowStore });

    expect(result.failed).toBe(1);
    expect(contentProtector.openCapture).not.toHaveBeenCalled();
    expect(workflowStore.fail).toHaveBeenCalledWith(
      job.jobId,
      job.leaseToken,
      "invalid_capture",
      false
    );
  });

  it("schedules bounded database retry when an old wrapping key or provider is unavailable", async () => {
    for (const error of [
      new ContentCryptoError(ContentCryptoErrorCode.KEY_NOT_FOUND, "missing"),
      new Error("organizer outage")
    ]) {
      const contentProtector = protector(() => Promise.reject(error));
      const workflowStore = store();

      const result = await drainCaptureJobs({ protector: contentProtector, store: workflowStore });

      expect(result.retryScheduled).toBe(1);
      expect(workflowStore.fail).toHaveBeenCalledWith(
        job.jobId,
        job.leaseToken,
        "provider_unavailable",
        true
      );
    }
  });

  it("relies on lease recovery when the failure transition cannot reach storage", async () => {
    const contentProtector = protector(() => Promise.reject(new Error("outage")));
    const workflowStore = store([job], {
      fail: vi.fn().mockRejectedValue(new Error("database unavailable"))
    });

    const result = await drainCaptureJobs({ protector: contentProtector, store: workflowStore });

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 0, retryScheduled: 1 });
  });

  it("keeps contracted workflow entry points free of legacy capture-job RPCs", async () => {
    const sources = await Promise.all(
      ["workflow.ts", "workflow-handler.ts", "workflow-scheduler.ts"].map((fileName) =>
        readFile(new URL(fileName, import.meta.url), "utf8")
      )
    );
    const combinedSource = sources.join("\n");
    const legacyRpcNames = [
      ["claim", "capture", "jobs"].join("_"),
      ["heartbeat", "capture", "job"].join("_"),
      ["complete", "capture", "job"].join("_"),
      ["fail", "capture", "job"].join("_"),
      ["recover", "stale", "capture", "jobs"].join("_")
    ];

    for (const rpcName of legacyRpcNames) expect(combinedSource).not.toContain(rpcName);
    expect(sources[1]).not.toContain(["drain", "Capture", "Jobs"].join(""));
    expect(sources[2]).not.toContain(["drain", "Capture", "Jobs"].join(""));
    expect(sources[1]).not.toContain(["index", "worker", "scheduler"].join("-"));
    expect(sources[2]).not.toContain(["index", "worker", "scheduler"].join("-"));
  });
});
