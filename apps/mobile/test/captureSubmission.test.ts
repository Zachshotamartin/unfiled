import { describe, expect, it, vi } from "vitest";

import { submitCapture } from "../src/features/capture/captureSubmission";

describe("durable capture submission boundary", () => {
  it("reports a commit failure, preserves the caller's text, and skips side effects", async () => {
    const sideEffect = vi.fn<() => Promise<void>>();
    const failure = new Error("disk full");
    const result = await submitCapture({
      persist: () => Promise.reject(failure),
      sideEffects: [sideEffect]
    });

    expect(result).toEqual({ error: failure, status: "commit_failed" });
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("acknowledges a durable save even when every best-effort side effect fails", async () => {
    const result = await submitCapture({
      persist: () => Promise.resolve({ id: "cap_01" }),
      sideEffects: [
        () => Promise.reject(new Error("App Group unavailable")),
        () => Promise.reject(new Error("Haptics unavailable"))
      ]
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("Expected a saved result");
    expect(result.value).toEqual({ id: "cap_01" });
    const effects = await result.effects;
    expect(effects.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  });

  it("starts post-commit work without delaying the saved result", async () => {
    let finishEffect: (() => void) | undefined;
    const effect = new Promise<void>((resolve) => {
      finishEffect = resolve;
    });
    const result = await submitCapture({
      persist: () => Promise.resolve("saved-locally"),
      sideEffects: [() => effect]
    });

    expect(result.status).toBe("saved");
    finishEffect?.();
    if (result.status === "saved") await result.effects;
  });
});
