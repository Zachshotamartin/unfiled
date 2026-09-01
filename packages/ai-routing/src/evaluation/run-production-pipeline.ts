import { fileURLToPath } from "node:url";

import {
  deterministicProductionPipelineModel,
  evaluateProductionRoutingPipeline,
  productionPipelineEvaluationExitCode,
  projectProductionPipelineOrganizerPlannerInput,
  type ProductionPipelineModelAdapter
} from "./production-pipeline.js";

type OrganizerPlanner = Readonly<{ plan(input: unknown): Promise<unknown> }>;
type DeterministicFirstFactory = (fallback: OrganizerPlanner) => OrganizerPlanner;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function organizerDeterministicFirstAdapter(): Promise<ProductionPipelineModelAdapter> {
  const plannerPath = fileURLToPath(
    new URL("../../../../apps/organizer/src/planner.ts", import.meta.url)
  );
  const promptPath = fileURLToPath(
    new URL("../../../../apps/organizer/src/prompt.ts", import.meta.url)
  );
  const plannerModule: unknown = await import(plannerPath);
  const promptModule: unknown = await import(promptPath);
  if (
    !isRecord(plannerModule) ||
    !isRecord(promptModule) ||
    typeof plannerModule.createDeterministicFirstOrganizerPlanner !== "function" ||
    typeof promptModule.ORGANIZER_PROMPT_VERSION !== "string" ||
    typeof promptModule.ORGANIZER_SCHEMA_VERSION !== "number"
  ) {
    throw new Error("organizer_deterministic_planner_seam_unavailable");
  }
  const createDeterministicFirst =
    plannerModule.createDeterministicFirstOrganizerPlanner as DeterministicFirstFactory;
  const promptVersion = promptModule.ORGANIZER_PROMPT_VERSION;
  const schemaVersion = promptModule.ORGANIZER_SCHEMA_VERSION;
  return Object.freeze({
    id: `organizer-deterministic-first+${deterministicProductionPipelineModel.id}`,
    plan(input) {
      const planner = createDeterministicFirst({
        plan() {
          return deterministicProductionPipelineModel.plan(input);
        }
      });
      return planner.plan(
        projectProductionPipelineOrganizerPlannerInput(input, {
          promptVersion,
          schemaVersion,
          signal: AbortSignal.timeout(25_000)
        })
      );
    }
  });
}

try {
  const report = await evaluateProductionRoutingPipeline({
    modelAdapter: await organizerDeterministicFirstAdapter()
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = productionPipelineEvaluationExitCode(report);
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({
      evidenceKind: "production-component-seam deterministic evaluation",
      error: error instanceof Error ? error.message : "Production component-seam evaluation failed",
      liveProviderEvidence: false,
      passed: false
    })}\n`
  );
  process.exitCode = 1;
}
