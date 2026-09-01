import { describe, expect, it } from "vitest";

import { proposedNoteIdForJob, unavailableProductionPlanner } from "../src/planner.js";

describe("app-specific planning wrappers", () => {
  it("derives a replay-stable note proposal for database authorization", () => {
    expect(proposedNoteIdForJob("job_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(
      "note_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    );
  });
  it.each(["job_bad", "ijob_01ARZ3NDEKTSV4RRFFQ69G5FAV", "job_01ARZ3NDEKTSV4RRFFQ69G5FAI"])(
    "rejects invalid durable job id %s",
    (jobId) => expect(() => proposedNoteIdForJob(jobId)).toThrow("not ready")
  );
  it("keeps the production model fail closed until Milestone D", async () => {
    await expect(
      unavailableProductionPlanner.plan({
        capture: {
          controls: { expansionDisabled: false, explicitDestinationNoteId: null },
          rawContent: "content"
        },
        candidates: [],
        captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        controls: { expansionDisabled: false, explicitDestinationNoteId: null },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("not ready");
  });
});
