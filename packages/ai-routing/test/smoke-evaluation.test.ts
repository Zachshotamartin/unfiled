import { describe, expect, it } from "vitest";

import { smokeEvaluationExitCode } from "../src/evaluation/smoke.js";

describe("routing smoke evaluation gate", () => {
  it("returns a failing process code when any case fails", () => {
    expect(smokeEvaluationExitCode({ corpusVersion: "test", cases: 1, passed: false })).toBe(1);
    expect(smokeEvaluationExitCode({ corpusVersion: "test", cases: 1, passed: true })).toBe(0);
  });
});
