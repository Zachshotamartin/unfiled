import { describe, expect, it } from "vitest";

import {
  PRODUCTION_PIPELINE_CASES,
  PRODUCTION_PIPELINE_VERSIONS,
  evaluateProductionPipelineCase,
  evaluateProductionRoutingPipeline,
  inferProductionPipelineCaptureKind,
  productionPipelineEvaluationExitCode,
  productionPipelineFixtureEmbedding,
  projectProductionPipelineOrganizerPlannerInput,
  resolveProductionPipelineDeterministicDestination,
  type ProductionPipelineCase,
  type ProductionPipelineLibraryNote,
  type ProductionPipelineModelInput
} from "../src/index.js";

function requiredCase(id: string): ProductionPipelineCase {
  const testCase = PRODUCTION_PIPELINE_CASES.find((candidate) => candidate.id === id);
  if (testCase === undefined) throw new Error(`Missing production component-seam case: ${id}`);
  return testCase;
}

describe("production-component-seam deterministic routing evaluation", () => {
  it("exercises the named component seams without claiming database lifecycle coverage", async () => {
    const report = await evaluateProductionRoutingPipeline();

    expect(report).toMatchObject({
      cases: 18,
      evidenceKind: "production-component-seam deterministic evaluation",
      liveProviderEvidence: false,
      modelAdapter: "deterministic-semantic-fixture.v2",
      passed: true,
      versions: PRODUCTION_PIPELINE_VERSIONS
    });
    expect(report.scope.exercised).toContain("private-rag ranking and snapshot verification");
    expect(report.scope.excluded).toContain(
      "repository select-candidate and commit generation revalidation"
    );
    expect(productionPipelineEvaluationExitCode(report)).toBe(0);
    expect(report.results.every(({ errors }) => errors.length === 0)).toBe(true);

    const list = report.results.find(({ id }) => id === "pipeline-list-auto");
    expect(list).toMatchObject({
      applied: true,
      materializedKind: "append",
      planValid: true,
      ragGenerationId: "generation-production-component-seam-v2",
      retrievalPath: "verified_index",
      retrievalStatus: "complete"
    });
    expect(list?.candidateIds[0]).toBe("note_00000000000000000000000001");
    expect(list?.preservation).toMatchObject({ preserved: true });

    const incomplete = report.results.find(
      ({ id }) => id === "pipeline-incomplete-index-downgrades"
    );
    expect(incomplete).toMatchObject({
      applied: false,
      policy: { score: 0 },
      ragGenerationId: null,
      retrievalPath: "bounded_current_fallback",
      retrievalReason: "coverage_incomplete",
      retrievalStatus: "incomplete"
    });
    expect(incomplete?.policy.autoApply).toBe(false);
    expect(incomplete?.policy.reasons).toContain("retrieval_degraded");

    const explicit = report.results.find(({ id }) => id === "pipeline-explicit-destination");
    expect(explicit).toMatchObject({
      applied: true,
      ragGenerationId: null,
      retrievalPath: "bounded_current_fallback",
      retrievalReason: "explicit_control",
      retrievalStatus: "not_attempted"
    });

    const exactTitle = report.results.find(({ id }) => id === "pipeline-exact-title-destination");
    expect(exactTitle).toMatchObject({
      applied: true,
      destinationNoteId: "note_00000000000000000000000005",
      ragGenerationId: "generation-production-component-seam-v2",
      retrievalPath: "verified_index"
    });

    const generationChanged = report.results.find(
      ({ id }) => id === "pipeline-generation-change-fallback"
    );
    expect(generationChanged).toMatchObject({
      applied: false,
      ragGenerationId: null,
      retrievalPath: "bounded_current_fallback",
      retrievalReason: "generation_changed"
    });

    const reboundControls = report.results.find(
      ({ id }) => id === "pipeline-fallback-current-controls"
    );
    expect(reboundControls).toMatchObject({
      applied: true,
      destinationNoteId: "note_00000000000000000000000005",
      retrievalPath: "bounded_current_fallback",
      retrievalReason: "coverage_incomplete"
    });

    for (const id of ["pipeline-unauthorized-model-output", "pipeline-rewritten-source-output"]) {
      const hostile = report.results.find((result) => result.id === id);
      expect(hostile).toMatchObject({
        applied: false,
        decision: "add_to_inbox",
        planValid: false
      });
      expect(hostile?.policy).toMatchObject({ autoApply: false, failClosed: true });
    }
    expect(
      report.results.find(({ id }) => id === "pipeline-rewritten-source-output")?.preservation
    ).toMatchObject({ preserved: false });
  });

  it("never exposes case expectations or fixture controls to model or live-planner inputs", async () => {
    const seen: ProductionPipelineModelInput[] = [];
    const listCase = requiredCase("pipeline-list-auto");
    const report = await evaluateProductionRoutingPipeline({
      cases: [listCase],
      modelAdapter: {
        id: "input-contract-probe",
        plan(input) {
          seen.push(input);
          const destination = input.candidates[0];
          if (destination === undefined) throw new Error("Missing routed candidate");
          return Promise.resolve({
            alternatives: [],
            captureKind: input.inferredKind,
            decision: "append_to_note",
            destination: {
              candidateId: destination.candidateId,
              newNote: null
            },
            generatedExpansion: null,
            operations: [{ content: input.captureText, type: "append_raw" }],
            reasonCodes: ["type_match"],
            schemaVersion: 1
          });
        }
      }
    });

    expect(report.passed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("expected");
    expect(seen[0]).not.toHaveProperty("mockOutput");
    expect(seen[0]).not.toHaveProperty("policy");
    expect(seen[0]).not.toHaveProperty("fixtureScenario");
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "attachments",
      "candidates",
      "captureId",
      "captureText",
      "controls",
      "inferredKind",
      "retrievalComplete"
    ]);

    const observed = seen[0];
    if (observed === undefined) throw new Error("Missing observed model input");
    const plannerInput = projectProductionPipelineOrganizerPlannerInput(observed, {
      promptVersion: "routing-v1",
      schemaVersion: 1,
      signal: AbortSignal.abort()
    });
    expect(Object.keys(plannerInput).sort()).toEqual([
      "candidates",
      "capture",
      "captureId",
      "controls",
      "promptVersion",
      "schemaVersion",
      "signal"
    ]);
    expect(Object.keys(plannerInput.candidates[0] ?? {}).sort()).toEqual([
      "bodyMarkdown",
      "candidateId",
      "isOpen",
      "noteId",
      "noteType",
      "revision",
      "structuredData",
      "title"
    ]);
    expect(plannerInput.controls).toEqual({
      expansionDisabled: true,
      explicitDestinationNoteId: null,
      ruleMatch: null
    });
    expect(plannerInput.capture.controls).toBe(plannerInput.controls);
    const serializedPlannerInput = JSON.stringify(plannerInput);
    for (const forbidden of [
      "expected",
      "fixtureScenario",
      "latestSnippet",
      "retrievalComplete",
      "retrievalScore",
      "retrievalState"
    ]) {
      expect(serializedPlannerInput).not.toContain(forbidden);
    }
  });

  it("uses bounded current candidates and current controls when verified retrieval degrades", async () => {
    const base = requiredCase("pipeline-incomplete-index-downgrades");
    const template = base.input.library[0];
    if (template === undefined) throw new Error("Missing fallback library template");
    const library: ProductionPipelineLibraryNote[] = Array.from({ length: 12 }, (_, index) => ({
      ...template,
      isOpen: index !== 0,
      noteId: `note_${String(index + 20).padStart(26, "0")}`,
      title: `Current project ${index + 1}`
    }));
    const seen: ProductionPipelineModelInput[] = [];
    await evaluateProductionPipelineCase(
      {
        ...base,
        input: {
          ...base.input,
          currentControls: {
            expansionDisabled: false,
            explicitDestinationNoteId: null
          },
          library
        }
      },
      {
        id: "bounded-fallback-probe",
        plan(input) {
          seen.push(input);
          return Promise.resolve({
            alternatives: [],
            captureKind: input.inferredKind,
            decision: "needs_review",
            destination: { candidateId: null, newNote: null },
            generatedExpansion: null,
            operations: [],
            reasonCodes: ["ambiguous_intent"],
            schemaVersion: 1
          });
        }
      }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.candidates).toHaveLength(7);
    expect(seen[0]?.controls).toEqual({
      expansionDisabled: false,
      explicitDestinationNoteId: null
    });
    expect(seen[0]?.retrievalComplete).toBe(false);
  });

  it("derives same-day evidence from occurred-at time and client timezone", async () => {
    const sameDayCase = requiredCase("pipeline-list-auto");
    const sameDay = await evaluateProductionPipelineCase(sameDayCase);
    const priorLocalDay = await evaluateProductionPipelineCase({
      ...sameDayCase,
      input: {
        ...sameDayCase.input,
        job: {
          ...sameDayCase.input.job,
          occurredAt: "2026-09-01T01:00:00.000Z"
        }
      },
      expected: {
        ...sameDayCase.expected,
        allowedBands: ["review"],
        applied: false
      }
    });

    expect(sameDay.policy.band).toBe("auto");
    expect(priorLocalDay.policy.band).toBe("review");
    expect(sameDay.policy.score - priorLocalDay.policy.score).toBeCloseTo(0.2, 4);
  });

  it("does not treat an exact title found only through degraded fallback as retrieval evidence", async () => {
    const exactTitle = requiredCase("pipeline-exact-title-destination");
    const degraded = await evaluateProductionPipelineCase({
      ...exactTitle,
      input: { ...exactTitle.input, retrievalState: "coverage_incomplete" },
      expected: {
        ...exactTitle.expected,
        allowedBands: ["inbox"],
        applied: false
      }
    });

    expect(degraded).toMatchObject({
      applied: false,
      destinationNoteId: "note_00000000000000000000000005",
      retrievalPath: "bounded_current_fallback"
    });
    expect(degraded.policy.reasons).toContain("retrieval_degraded");
  });

  it("rejects a model capture kind that differs from deterministic organizer inference", async () => {
    const listCase = requiredCase("pipeline-list-auto");
    const mismatched = await evaluateProductionPipelineCase(
      {
        ...listCase,
        expected: {
          ...listCase.expected,
          allowedBands: ["inbox"],
          allowedDecisions: ["add_to_inbox"],
          applied: false,
          destinationNoteId: null,
          planValid: false
        }
      },
      {
        id: "wrong-capture-kind",
        plan(input) {
          const destination = input.candidates[0];
          if (destination === undefined) throw new Error("Missing list candidate");
          return Promise.resolve({
            alternatives: [],
            captureKind: "freeform",
            decision: "append_to_note",
            destination: { candidateId: destination.candidateId, newNote: null },
            generatedExpansion: null,
            operations: [{ content: input.captureText, type: "append_raw" }],
            reasonCodes: ["type_match"],
            schemaVersion: 1
          });
        }
      }
    );

    expect(mismatched).toMatchObject({
      applied: false,
      decision: "add_to_inbox",
      planValid: false,
      policy: { autoApply: false, failClosed: true }
    });
  });

  it("uses deterministic capture inference and fixture embeddings without expected outputs", () => {
    expect(inferProductionPipelineCaptureKind("shopping: milk and eggs")).toBe("list_items");
    expect(inferProductionPipelineCaptureKind("bench 135 x 8")).toBe("log_entry");
    expect(inferProductionPipelineCaptureKind("method: protect attention")).toBe("principle");
    expect(inferProductionPipelineCaptureKind("Protect attention through consistency")).toBe(
      "principle"
    );
    expect(inferProductionPipelineCaptureKind("project update: shipped capture")).toBe(
      "project_update"
    );
    expect(inferProductionPipelineCaptureKind("A quiet thought.")).toBe("freeform");

    const reflection = "note_00000000000000000000000005" as const;
    expect(
      resolveProductionPipelineDeterministicDestination({
        candidates: [
          { candidateId: reflection, isOpen: true, noteId: reflection, title: "Daily Reflection" }
        ],
        captureText: "Put this into ‘Daily Reflection.’",
        controls: { expansionDisabled: true, explicitDestinationNoteId: null }
      })
    ).toBe(reflection);
    expect(
      resolveProductionPipelineDeterministicDestination({
        candidates: [
          { candidateId: reflection, isOpen: true, noteId: reflection, title: "Daily Reflection" },
          {
            candidateId: "note_00000000000000000000000006",
            isOpen: true,
            noteId: "note_00000000000000000000000006",
            title: "Daily Reflection"
          }
        ],
        captureText: "Put this into Daily Reflection",
        controls: { expansionDisabled: true, explicitDestinationNoteId: null }
      })
    ).toBeNull();

    const first = productionPipelineFixtureEmbedding("shopping oats");
    const replay = productionPipelineFixtureEmbedding("shopping oats");
    const other = productionPipelineFixtureEmbedding("bench press");
    expect([...first]).toEqual([...replay]);
    expect([...first]).not.toEqual([...other]);
    first.fill(0);
    replay.fill(0);
    other.fill(0);
  });
});
