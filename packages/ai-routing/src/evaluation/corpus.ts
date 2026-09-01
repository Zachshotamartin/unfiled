import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CaptureKindSchema,
  NoteTypeSchema,
  OrganizationDecisionSchema,
  entityIdSchema
} from "@unfiled/contracts";
import { z } from "zod";

import { OrganizerCandidateManifestSchema } from "../materialization.js";
import {
  CreateRoutingSignalsSchema,
  RoutingBehaviorModeSchema,
  RoutingFailureSchema,
  RoutingSignalFeaturesSchema
} from "../policy.js";

const MAX_CORPUS_FILE_BYTES = 2_000_000;

export const RoutingEvaluationCategorySchema = z.enum([
  "empty_sparse_library",
  "same_day_list_continuation",
  "cross_day_list",
  "workout_shorthand",
  "journal_freeform",
  "principles",
  "project_updates",
  "task_shopping_ambiguity",
  "duplicate_near_duplicate",
  "adversarial_injection",
  "invalid_hostile_output",
  "stale_revision",
  "private_note_exclusion",
  "encrypted_index_race",
  "cross_tenant_retrieval",
  "multilingual"
]);
export type RoutingEvaluationCategory = z.infer<typeof RoutingEvaluationCategorySchema>;

export const ROUTING_CATEGORY_MINIMUMS = Object.freeze({
  empty_sparse_library: 10,
  same_day_list_continuation: 15,
  cross_day_list: 10,
  workout_shorthand: 20,
  journal_freeform: 15,
  principles: 10,
  project_updates: 10,
  task_shopping_ambiguity: 15,
  duplicate_near_duplicate: 10,
  adversarial_injection: 15,
  invalid_hostile_output: 10,
  stale_revision: 5,
  private_note_exclusion: 5,
  encrypted_index_race: 10,
  cross_tenant_retrieval: 5,
  multilingual: 10
} satisfies Readonly<Record<RoutingEvaluationCategory, number>>);

export const ROUTING_CORPUS_MINIMUM_CASES = Object.values(ROUTING_CATEGORY_MINIMUMS).reduce(
  (sum, count) => sum + count,
  0
);

const RoutingMockOutputSchema = z.strictObject({
  decision: OrganizationDecisionSchema,
  destinationCandidateId: entityIdSchema("note").nullable(),
  newNote: z
    .strictObject({
      title: z.string().min(1).max(60),
      noteType: NoteTypeSchema,
      spaceCandidateId: entityIdSchema("spc").nullable()
    })
    .nullable(),
  fault: z.enum(["invalid_destination", "invalid_schema", "rewritten_source"]).nullable()
});

const RoutingEvaluationExpectationSchema = z.strictObject({
  candidateMustInclude: z.array(entityIdSchema("note")).max(8),
  allowedDecisions: z.array(OrganizationDecisionSchema).min(1).max(4),
  forbiddenDestinations: z.array(entityIdSchema("note")).max(8),
  requiredPreservation: z.boolean(),
  autoApplyAllowed: z.boolean(),
  expectedKind: CaptureKindSchema,
  expectedDestination: entityIdSchema("note").nullable(),
  expectedAction: z.enum(["append", "create", "defer"]),
  expectedBand: z.enum(["auto", "review", "inbox"]),
  expectedInvalidPlan: z.boolean(),
  injectionCase: z.boolean()
});

const RoutingPolicyProfileSchema = z.strictObject({
  mode: RoutingBehaviorModeSchema,
  destinationNoteType: NoteTypeSchema.nullable(),
  accountCaptureOrdinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  retrievalAutoEligible: z.boolean(),
  deterministicRuleMatch: z.boolean(),
  duplicateNoteSuspected: z.boolean(),
  simulatedFailure: RoutingFailureSchema.nullable(),
  features: RoutingSignalFeaturesSchema,
  createSignals: CreateRoutingSignalsSchema.nullable()
});

const RoutingEvaluationProfileSchema = z.strictObject({
  manifest: OrganizerCandidateManifestSchema,
  mockOutput: RoutingMockOutputSchema,
  policy: RoutingPolicyProfileSchema,
  expect: RoutingEvaluationExpectationSchema
});

const StoredRoutingProfileSchema = z.strictObject({
  manifest: z.string().min(1).max(80),
  mockOutput: z.string().min(1).max(80),
  policy: z.string().min(1).max(80),
  expect: z.string().min(1).max(80)
});

const StoredRoutingCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/u),
  category: RoutingEvaluationCategorySchema,
  profile: z.string().regex(/^[a-z0-9][a-z0-9_]{2,79}$/u),
  capture: z.string().min(1).max(10_000),
  timezone: z.string().min(1).max(100)
});

const StoredRoutingCorpusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  corpusVersion: z.string().regex(/^routing\.v\d+\.\d+\.\d+$/u),
  unsupportedCategories: z.array(RoutingEvaluationCategorySchema).max(16),
  manifests: z.record(z.string(), OrganizerCandidateManifestSchema),
  mockOutputs: z.record(z.string(), RoutingMockOutputSchema),
  policies: z.record(z.string(), RoutingPolicyProfileSchema),
  expectations: z.record(z.string(), RoutingEvaluationExpectationSchema),
  profiles: z.record(z.string(), StoredRoutingProfileSchema),
  cases: z.array(StoredRoutingCaseSchema).min(1)
});

type RoutingEvaluationProfile = z.infer<typeof RoutingEvaluationProfileSchema>;

export type RoutingEvaluationCase = z.infer<typeof StoredRoutingCaseSchema> &
  Readonly<{ definition: RoutingEvaluationProfile }>;

export type RoutingEvaluationCorpus = Readonly<{
  schemaVersion: 1;
  corpusVersion: string;
  unsupportedCategories: readonly RoutingEvaluationCategory[];
  cases: readonly RoutingEvaluationCase[];
}>;

function defaultCorpusDirectory(): string {
  return fileURLToPath(new URL("../../../test-fixtures/routing-cases/", import.meta.url));
}

function freezeCase(
  storedCase: z.infer<typeof StoredRoutingCaseSchema>,
  definition: RoutingEvaluationProfile
): RoutingEvaluationCase {
  return Object.freeze({ ...storedCase, definition: Object.freeze(definition) });
}

function assertCorpusCoverage(corpus: RoutingEvaluationCorpus): void {
  if (corpus.cases.length < ROUTING_CORPUS_MINIMUM_CASES) {
    throw new Error(
      `Routing corpus has ${corpus.cases.length} cases; ${ROUTING_CORPUS_MINIMUM_CASES} required`
    );
  }
  const ids = new Set<string>();
  const counts = new Map<RoutingEvaluationCategory, number>();
  for (const testCase of corpus.cases) {
    if (ids.has(testCase.id)) throw new Error(`Duplicate routing case ID: ${testCase.id}`);
    ids.add(testCase.id);
    counts.set(testCase.category, (counts.get(testCase.category) ?? 0) + 1);
  }
  for (const [category, minimum] of Object.entries(ROUTING_CATEGORY_MINIMUMS) as [
    RoutingEvaluationCategory,
    number
  ][]) {
    const actual = counts.get(category) ?? 0;
    if (actual < minimum) {
      throw new Error(`Routing category ${category} has ${actual} cases; ${minimum} required`);
    }
  }
  if (new Set(corpus.unsupportedCategories).size !== corpus.unsupportedCategories.length) {
    throw new Error("Routing corpus unsupported categories must be unique");
  }
  for (const category of corpus.unsupportedCategories) {
    if (
      corpus.cases.some(
        (testCase) => testCase.category === category && testCase.definition.expect.autoApplyAllowed
      )
    ) {
      throw new Error(`Unsupported routing category ${category} cannot allow auto-apply`);
    }
  }
}

export async function loadRoutingEvaluationCorpus(
  directory = defaultCorpusDirectory()
): Promise<RoutingEvaluationCorpus> {
  const fileNames = (await readdir(directory))
    .filter((fileName) => fileName.endsWith(".yaml"))
    .sort();
  if (fileNames.length === 0) throw new Error("Routing corpus has no YAML files");

  const cases: RoutingEvaluationCase[] = [];
  let corpusVersion: string | null = null;
  let unsupportedCategories: readonly RoutingEvaluationCategory[] | null = null;
  for (const fileName of fileNames) {
    const source = await readFile(resolve(directory, fileName), "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_CORPUS_FILE_BYTES) {
      throw new Error(`Routing corpus file is too large: ${fileName}`);
    }
    let unknownDocument: unknown;
    try {
      unknownDocument = JSON.parse(source) as unknown;
    } catch {
      throw new Error(`Routing corpus file is not JSON-compatible YAML: ${fileName}`);
    }
    const document = StoredRoutingCorpusSchema.parse(unknownDocument);
    if (corpusVersion !== null && document.corpusVersion !== corpusVersion) {
      throw new Error("Routing corpus files have inconsistent versions");
    }
    if (
      unsupportedCategories !== null &&
      JSON.stringify(document.unsupportedCategories) !== JSON.stringify(unsupportedCategories)
    ) {
      throw new Error("Routing corpus files have inconsistent unsupported categories");
    }
    corpusVersion = document.corpusVersion;
    unsupportedCategories = document.unsupportedCategories;
    for (const storedCase of document.cases) {
      const storedProfile = document.profiles[storedCase.profile];
      if (storedProfile === undefined) {
        throw new Error(`Routing case ${storedCase.id} references an unknown profile`);
      }
      const manifest = document.manifests[storedProfile.manifest];
      const mockOutput = document.mockOutputs[storedProfile.mockOutput];
      const policy = document.policies[storedProfile.policy];
      const expect = document.expectations[storedProfile.expect];
      const resolved = RoutingEvaluationProfileSchema.safeParse({
        manifest,
        mockOutput,
        policy,
        expect
      });
      if (!resolved.success) {
        throw new Error(`Routing case ${storedCase.id} profile cannot be resolved`);
      }
      const definition = resolved.data;
      cases.push(freezeCase(storedCase, definition));
    }
  }

  if (corpusVersion === null) throw new Error("Routing corpus version is missing");
  if (unsupportedCategories === null) {
    throw new Error("Routing corpus unsupported-category declaration is missing");
  }
  const corpus = Object.freeze({
    schemaVersion: 1 as const,
    corpusVersion,
    unsupportedCategories: Object.freeze([...unsupportedCategories]),
    cases: Object.freeze(cases)
  });
  assertCorpusCoverage(corpus);
  return corpus;
}
