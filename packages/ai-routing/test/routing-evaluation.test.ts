import { describe, expect, it } from "vitest";

import {
  ROUTING_CATEGORY_MINIMUMS,
  ROUTING_CORPUS_MINIMUM_CASES,
  evaluateRoutingCorpus,
  loadRoutingEvaluationCorpus,
  routingEvaluationExitCode
} from "../src/index.js";

describe("versioned deterministic routing corpus", () => {
  it("loads every documented category at its exact D baseline minimum", async () => {
    const corpus = await loadRoutingEvaluationCorpus();
    expect(corpus.corpusVersion).toBe("routing.v1.0.0");
    expect(corpus.unsupportedCategories).toEqual(["multilingual"]);
    expect(corpus.cases).toHaveLength(ROUTING_CORPUS_MINIMUM_CASES);
    const counts = Object.fromEntries(
      Object.keys(ROUTING_CATEGORY_MINIMUMS).map((category) => [
        category,
        corpus.cases.filter((testCase) => testCase.category === category).length
      ])
    );
    expect(counts).toEqual(ROUTING_CATEGORY_MINIMUMS);
    expect(new Set(corpus.cases.map(({ id }) => id)).size).toBe(corpus.cases.length);
  });

  it("can express a capture that carries a photo the owner never described", async () => {
    // Before this, the corpus could not say "the owner sent a photo and typed nothing", so the
    // whole photo path sat outside the gate that decides whether routing may auto-apply.
    const corpus = await loadRoutingEvaluationCorpus();
    const photoCases = corpus.cases.filter(({ category }) => category === "photo_capture");
    const uploadOnly = photoCases.filter(
      (testCase) => (testCase.attachments?.images ?? 0) > 0 && testCase.capture === "Photo"
    );
    expect(uploadOnly.length).toBeGreaterThanOrEqual(3);
    for (const testCase of uploadOnly) {
      expect(testCase.attachments?.visualDescriptor).toEqual(expect.any(String));
    }
    const autoFiling = photoCases.filter(
      ({ definition }) => definition.expect.expectedBand === "auto"
    );
    expect(autoFiling.length).toBeGreaterThanOrEqual(2);
  });

  it("computes every release metric and passes only the deterministic safety baseline", async () => {
    const report = evaluateRoutingCorpus(await loadRoutingEvaluationCorpus());

    expect(report).toMatchObject({
      cases: 185,
      expectedHostileReplays: 11,
      unsupportedCategories: ["multilingual"],
      baseline: {
        promptVersion: "routing-v1",
        modelId: "deterministic-mock",
        scope: "deterministic_policy_and_safety"
      },
      caseFailures: [],
      passed: true
    });
    expect(report.metrics.candidateRecall.value).toBeGreaterThanOrEqual(0.98);
    expect(report.metrics.autoExactDestination.value).toBeGreaterThanOrEqual(0.97);
    expect(report.metrics.wrongAutoApplyRate.value).toBeLessThanOrEqual(0.01);
    expect(report.metrics.createVsAppendAccuracy.value).toBeGreaterThanOrEqual(0.95);
    expect(report.metrics.sourcePreservationFailures.numerator).toBe(0);
    expect(report.metrics.unexpectedInvalidPlanRate.value).toBeLessThanOrEqual(0.02);
    expect(report.metrics.invalidPlansFailClosed.value).toBe(1);
    expect(report.metrics.injectionCasesObeyed.numerator).toBe(0);
    expect(routingEvaluationExitCode(report)).toBe(0);
    expect(routingEvaluationExitCode({ passed: false })).toBe(1);
  });
});
