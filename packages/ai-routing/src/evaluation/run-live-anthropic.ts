import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANTHROPIC_ROUTING_EVALUATION_PRICING_METADATA,
  createAnthropicEvaluationInstrumentation,
  anthropicEvaluationPricingForModel,
  requireExplicitLiveAnthropicEvaluationKey,
  summarizeAnthropicEvaluationTelemetry,
  type AnthropicEvaluationAttempt
} from "./live-anthropic-telemetry.js";
import {
  PRODUCTION_PIPELINE_CASES,
  PRODUCTION_PIPELINE_VERSIONS,
  evaluateProductionPipelineCase,
  projectProductionPipelineOrganizerPlannerInput,
  type ProductionPipelineModelAdapter
} from "./production-pipeline.js";

const LIVE_SAMPLES_PER_CASE = 3 as const;
const EVALUATION_KEY_ENV = "UNFILED_ROUTING_EVAL_ANTHROPIC_API_KEY";
const EVALUATION_MODEL_ENV = "UNFILED_ROUTING_EVAL_ANTHROPIC_MODEL";
const DEFAULT_EVALUATION_MODEL = "claude-sonnet-5";
const REPORT_PATH_ENV = "UNFILED_ROUTING_EVAL_REPORT_PATH";

type OrganizerPlanner = Readonly<{
  plan(input: unknown): Promise<unknown>;
}>;

type OrganizerPlannerFactory = (
  options: Readonly<{ apiKey: string; fetchImplementation: typeof fetch; modelId: string }>
) => OrganizerPlanner;

type DeterministicFirstOrganizerPlannerFactory = (fallback: OrganizerPlanner) => OrganizerPlanner;

type OrganizerRoutingProfile = Readonly<{
  models: readonly string[];
  promptVersion: string;
  registryVersion: string;
  schemaVersion: number;
}>;

type LiveSample = Readonly<{
  attempts: readonly AnthropicEvaluationAttempt[];
  band: "auto" | "inbox" | "review";
  caseId: string;
  decision: "add_to_inbox" | "append_to_note" | "create_note" | "needs_review";
  errors: readonly string[];
  passed: boolean;
  planValid: boolean;
  sample: 1 | 2 | 3;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plannerFactory(value: unknown): OrganizerPlannerFactory {
  if (typeof value !== "function") throw new Error("organizer_planner_factory_unavailable");
  return value as OrganizerPlannerFactory;
}

function deterministicFirstPlannerFactory(
  value: unknown
): DeterministicFirstOrganizerPlannerFactory {
  if (typeof value !== "function") {
    throw new Error("organizer_deterministic_planner_factory_unavailable");
  }
  return value as DeterministicFirstOrganizerPlannerFactory;
}

function routingProfile(value: unknown): OrganizerRoutingProfile {
  if (
    !isRecord(value) ||
    !Array.isArray(value.models) ||
    !value.models.every((model) => typeof model === "string") ||
    typeof value.promptVersion !== "string" ||
    typeof value.registryVersion !== "string" ||
    typeof value.schemaVersion !== "number" ||
    !Number.isSafeInteger(value.schemaVersion)
  ) {
    throw new Error("organizer_routing_profile_unavailable");
  }
  return Object.freeze({
    models: Object.freeze([...(value.models as readonly string[])]),
    promptVersion: value.promptVersion,
    registryVersion: value.registryVersion,
    schemaVersion: value.schemaVersion
  });
}

async function organizerPlannerModule(): Promise<
  Readonly<{
    createDeterministicFirstPlanner: DeterministicFirstOrganizerPlannerFactory;
    createPlanner: OrganizerPlannerFactory;
    profile: OrganizerRoutingProfile;
  }>
> {
  const modulePath = fileURLToPath(
    new URL("../../../../apps/organizer/src/anthropic-planner.ts", import.meta.url)
  );
  const deterministicModulePath = fileURLToPath(
    new URL("../../../../apps/organizer/src/planner.ts", import.meta.url)
  );
  const imported: unknown = await import(modulePath);
  const deterministicImported: unknown = await import(deterministicModulePath);
  if (!isRecord(imported) || !isRecord(deterministicImported)) {
    throw new Error("organizer_planner_module_unavailable");
  }
  return Object.freeze({
    createDeterministicFirstPlanner: deterministicFirstPlannerFactory(
      deterministicImported.createDeterministicFirstOrganizerPlanner
    ),
    createPlanner: plannerFactory(imported.createAnthropicOrganizerPlanner),
    profile: routingProfile(imported.ANTHROPIC_ROUTING_PROFILE)
  });
}

/** The evaluated model must be one exact registry-v2 Claude model with pinned pricing. */
function evaluationModel(profile: OrganizerRoutingProfile): string {
  const configured = process.env[EVALUATION_MODEL_ENV];
  const model =
    configured === undefined || configured.length === 0 ? DEFAULT_EVALUATION_MODEL : configured;
  if (!profile.models.includes(model)) throw new Error("live_evaluation_model_not_in_registry");
  if (anthropicEvaluationPricingForModel(model) === null) {
    throw new Error("live_evaluation_model_has_no_pinned_pricing");
  }
  return model;
}

function outputPath(): string | null {
  const configured = process.env[REPORT_PATH_ENV];
  if (configured === undefined || configured.length === 0) return null;
  const path = resolve(configured);
  if (extname(path).toLowerCase() !== ".json") throw new Error("live_report_path_must_be_json");
  return path;
}

async function persistReport(path: string | null, report: unknown): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (path === null) {
    process.stdout.write(serialized);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ evidenceKind: "live Claude stochastic evaluation", reportPath: path })}\n`
  );
}

try {
  const apiKey = requireExplicitLiveAnthropicEvaluationKey(process.env[EVALUATION_KEY_ENV]);
  const { createDeterministicFirstPlanner, createPlanner, profile } =
    await organizerPlannerModule();
  const model = evaluationModel(profile);
  const telemetry = createAnthropicEvaluationInstrumentation({
    candidateAlgorithmVersion: PRODUCTION_PIPELINE_VERSIONS.candidateAlgorithm,
    candidateFixtureVersion: PRODUCTION_PIPELINE_VERSIONS.candidateFixtures,
    promptVersion: profile.promptVersion,
    schemaVersion: profile.schemaVersion
  });
  const providerPlanner = createPlanner({
    apiKey,
    fetchImplementation: telemetry.fetchImplementation,
    modelId: model
  });
  const planner = createDeterministicFirstPlanner(providerPlanner);
  const adapter: ProductionPipelineModelAdapter = Object.freeze({
    id: `organizer-deterministic-first+anthropic:${model}`,
    plan(input) {
      return planner.plan(
        projectProductionPipelineOrganizerPlannerInput(input, {
          promptVersion: profile.promptVersion,
          schemaVersion: profile.schemaVersion,
          signal: AbortSignal.timeout(25_000)
        })
      );
    }
  });
  const liveCases = PRODUCTION_PIPELINE_CASES.filter(({ liveEligible }) => liveEligible);
  const samples: LiveSample[] = [];
  for (const testCase of liveCases) {
    for (let sample = 1; sample <= LIVE_SAMPLES_PER_CASE; sample += 1) {
      telemetry.drain();
      const evaluation = await evaluateProductionPipelineCase(testCase, adapter);
      const attempts = telemetry.drain();
      samples.push(
        Object.freeze({
          attempts,
          band: evaluation.policy.band,
          caseId: testCase.id,
          decision: evaluation.decision,
          errors: evaluation.errors,
          passed:
            evaluation.passed &&
            attempts.length > 0 &&
            attempts.every(
              ({ pricingModelMatched, requestCompleted }) => pricingModelMatched && requestCompleted
            ),
          planValid: evaluation.planValid,
          sample: sample as 1 | 2 | 3
        })
      );
    }
  }
  const attempts = samples.flatMap((sample) => sample.attempts);
  const telemetrySummary = summarizeAnthropicEvaluationTelemetry(attempts);
  const failedSamples = samples.filter(({ passed }) => !passed);
  const failedCases = [...new Set(failedSamples.map(({ caseId }) => caseId))].sort();
  const report = Object.freeze({
    evidenceKind: "live Claude stochastic evaluation" as const,
    executed: true as const,
    inputScope: "synthetic frozen fixtures only" as const,
    generatedAt: new Date().toISOString(),
    passed: failedSamples.length === 0,
    pricing: Object.freeze({
      ...anthropicEvaluationPricingForModel(model),
      ...ANTHROPIC_ROUTING_EVALUATION_PRICING_METADATA
    }),
    provider: "Anthropic",
    samples: Object.freeze(samples),
    samplesPerCase: LIVE_SAMPLES_PER_CASE,
    summary: Object.freeze({
      cases: liveCases.length,
      failedCases: Object.freeze(failedCases),
      failedSamples: failedSamples.length,
      samples: samples.length,
      telemetry: telemetrySummary
    }),
    versions: Object.freeze({
      candidateAlgorithm: PRODUCTION_PIPELINE_VERSIONS.candidateAlgorithm,
      candidateFixtures: PRODUCTION_PIPELINE_VERSIONS.candidateFixtures,
      model,
      prompt: profile.promptVersion,
      registry: profile.registryVersion,
      schema: profile.schemaVersion
    }),
    worstOf: Object.freeze({
      everyCasePassedAllThreeSamples: failedCases.length === 0,
      maximumAttemptLatencyMs: telemetrySummary.latencyMs.max,
      wrongOrFailedSamples: failedSamples.length
    })
  });
  await persistReport(outputPath(), report);
  process.exitCode = report.passed ? 0 : 1;
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({
      evidenceKind: "live Claude stochastic evaluation",
      error: error instanceof Error ? error.message : "live_evaluation_failed",
      executed: false,
      passed: false,
      requiredKeyEnvironmentVariable: EVALUATION_KEY_ENV,
      optionalModelEnvironmentVariable: EVALUATION_MODEL_ENV,
      samplesPerCase: LIVE_SAMPLES_PER_CASE
    })}\n`
  );
  process.exitCode = 1;
}
