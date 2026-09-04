import { ApiClientError } from "@unfiled/api-client";
import type { DecisionCorrectionResponse } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CORRECTION_REPLAY_DELAY_MS,
  MAX_CORRECTION_REPLAY_WAIT_MS,
  attemptToReplay,
  correctionAttempt,
  correctionReplayDelayMs,
  retainAfterFailure,
  submitCorrection
} from "./correct-decision";

const DECISION = "dec_01ARZ3NDEKTSV4RRFFQ69G5FA2" as const;
const SOURCE = "note_01ARZ3NDEKTSV4RRFFQ69G5FA1" as const;
const TARGET = "note_01ARZ3NDEKTSV4RRFFQ69G5FA3" as const;

const applied: DecisionCorrectionResponse = {
  outcome: "applied",
  decisionId: DECISION,
  source: { noteId: SOURCE, currentRevision: 3, mutationId: "mut_01ARZ3NDEKTSV4RRFFQ69G5FA4" },
  destination: {
    type: "existing_note",
    noteId: TARGET,
    currentRevision: 2,
    mutationId: "mut_01ARZ3NDEKTSV4RRFFQ69G5FA5"
  },
  replayed: true
};

const unavailable = (retryAfterSeconds?: number) =>
  new ApiClientError(503, {
    code: "provider_unavailable",
    message: "provider_unavailable",
    requestId: "req_test",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  });

const stale = () =>
  new ApiClientError(409, { code: "stale_revision", message: "stale", requestId: "req_test" });

const attempt = () =>
  correctionAttempt(
    DECISION,
    { noteId: SOURCE, expectedRevision: 3 },
    { type: "existing_note", noteId: TARGET, expectedRevision: 1 }
  );

describe("a correction attempt", () => {
  it("carries one key for the exact body it will send every time", () => {
    const first = attempt();

    expect(first.request.idempotencyKey).toMatch(/^web_[0-9a-f-]{36}$/u);
    expect(first.decisionId).toBe(DECISION);
    expect(Object.isFrozen(first)).toBe(true);
    // Two attempts are two moves; the same attempt is one move asked about twice.
    expect(attempt().request.idempotencyKey).not.toBe(first.request.idempotencyKey);
  });

  it("refuses a destination that is the source", () => {
    expect(() =>
      correctionAttempt(
        DECISION,
        { noteId: SOURCE, expectedRevision: 3 },
        { type: "existing_note", noteId: SOURCE, expectedRevision: 3 }
      )
    ).toThrow();
  });
});

describe("submitting a correction", () => {
  it("replays the same key after the observation wait runs out, and reads the stored answer", async () => {
    const correctDecision = vi
      .fn<(decisionId: string, input: unknown) => Promise<DecisionCorrectionResponse>>()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(applied);
    const wait = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const first = attempt();

    await expect(submitCorrection({ correctDecision }, first, wait)).resolves.toBe(applied);

    expect(correctDecision).toHaveBeenCalledTimes(2);
    expect(correctDecision).toHaveBeenNthCalledWith(1, DECISION, first.request);
    expect(correctDecision).toHaveBeenNthCalledWith(2, DECISION, first.request);
    expect(wait).toHaveBeenCalledWith(CORRECTION_REPLAY_DELAY_MS);
  });

  it("does not replay a definitive refusal, which only a fresh request could answer", async () => {
    const failure = stale();
    const correctDecision = vi
      .fn<(decisionId: string, input: unknown) => Promise<DecisionCorrectionResponse>>()
      .mockRejectedValue(failure);
    const wait = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(submitCorrection({ correctDecision }, attempt(), wait)).rejects.toBe(failure);

    expect(correctDecision).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("surfaces a second ambiguous answer instead of looping", async () => {
    const failure = unavailable();
    const correctDecision = vi
      .fn<(decisionId: string, input: unknown) => Promise<DecisionCorrectionResponse>>()
      .mockRejectedValue(failure);

    await expect(
      submitCorrection({ correctDecision }, attempt(), () => Promise.resolve())
    ).rejects.toBe(failure);

    expect(correctDecision).toHaveBeenCalledTimes(2);
  });

  it("honors the server's retry-after up to the longest a form will wait", () => {
    expect(correctionReplayDelayMs(unavailable())).toBe(CORRECTION_REPLAY_DELAY_MS);
    expect(correctionReplayDelayMs(unavailable(2))).toBe(2_000);
    expect(correctionReplayDelayMs(unavailable(30))).toBe(MAX_CORRECTION_REPLAY_WAIT_MS);
    expect(correctionReplayDelayMs(new TypeError("fetch failed"))).toBe(CORRECTION_REPLAY_DELAY_MS);
  });
});

describe("what a manual retry sends", () => {
  it("keeps the attempt after an ambiguous failure while the owner asks for the same move", () => {
    const first = attempt();
    const retained = retainAfterFailure(first, "move:target", unavailable());

    expect(retained).toEqual({ attempt: first, intent: "move:target" });
    expect(attemptToReplay(retained, "move:target")).toBe(first);
  });

  it("drops it once the owner asks for a different move", () => {
    const retained = retainAfterFailure(attempt(), "move:target", unavailable());

    expect(attemptToReplay(retained, "move:other")).toBeNull();
  });

  it("keeps nothing after a definitive failure, which needs fresh revisions and a fresh key", () => {
    expect(retainAfterFailure(attempt(), "move:target", stale())).toBeNull();
    expect(attemptToReplay(null, "move:target")).toBeNull();
  });
});
