import { randomUUID } from "node:crypto";

import { OrganizerPlannerReviewError, OrganizerProviderError } from "./errors.js";
import {
  inferOrganizerCaptureKind,
  sameOrganizerCaptureControls,
  type DeterministicDestinationMatch,
  type PlannerInput
} from "./planner.js";
import { ORGANIZER_PROMPT_VERSION, ORGANIZER_SCHEMA_VERSION } from "./prompt.js";
import { isRecord } from "./provider-transport.js";

/**
 * Provider-neutral disclosure projection. Both provider planners send exactly
 * this bounded JSON document as the user turn: the capture plus at most eight
 * open candidates reduced to ephemeral aliases, bounded titles/types, at most
 * three bounded headings, and one bounded latest snippet. Candidate bodies,
 * capture/job/owner IDs, and database note IDs never leave the process.
 */
const CAPTURE_ID = /^cap_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NOTE_ID = /^note_[0-9A-HJKMNP-TV-Z]{26}$/u;
const EPHEMERAL_CANDIDATE_ID = /^candidate_[0-9a-f]{32}$/u;
const NOTE_TYPES = new Set(["generic", "list", "log", "principle", "project"]);
const MAX_CAPTURE_CHARACTERS = 10_000;
const MAX_CANDIDATES = 8;
const MAX_CANDIDATE_BODY_CHARACTERS = 200_000;
const MAX_TITLE_CHARACTERS = 200;
const MAX_HEADING_CHARACTERS = 200;
const MAX_SNIPPET_CHARACTERS = 200;
const MAX_USER_INPUT_BYTES = 64 * 1_024;
const MAX_BRIEF_EXPANSION_CHARACTERS = 200;

export const ORGANIZER_DISCLOSURE_CONTRACT = "unfiled.routing.input.v1" as const;

export type EphemeralCandidateId = `candidate_${string}`;
export type OrganizerExpansionPreference = "off" | "brief" | "detailed";

type ProviderCandidate = Readonly<{
  candidateId: EphemeralCandidateId;
  headings: readonly string[];
  isOpen: true;
  latestSnippet: string;
  noteType: "generic" | "list" | "log" | "principle" | "project";
  title: string;
}>;

type ProviderInput = Readonly<{
  candidates: readonly ProviderCandidate[];
  capture: Readonly<{ inferredKind: string; ownerInstructions: string | null; text: string }>;
  contract: typeof ORGANIZER_DISCLOSURE_CONTRACT;
  controls: Readonly<{
    expansionDisabled: boolean;
    expansionStyle: OrganizerExpansionPreference;
    explicitDestinationCandidateId: EphemeralCandidateId | null;
  }>;
}>;

export type PreparedProviderDisclosure = Readonly<{
  deterministicEphemeralCandidateId: EphemeralCandidateId | null;
  ephemeralToInternalCandidateId: ReadonlyMap<EphemeralCandidateId, string>;
  expansionStyle: OrganizerExpansionPreference;
  internalToEphemeralCandidateId: ReadonlyMap<string, EphemeralCandidateId>;
  serialized: string;
}>;

function characterLength(value: string): number {
  return Array.from(value).length;
}

function truncateCharacters(value: string, maximum: number, fromEnd = false): string {
  const characters = Array.from(value);
  return (fromEnd ? characters.slice(-maximum) : characters.slice(0, maximum)).join("");
}

function normalizeExcerpt(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function candidateHeadings(bodyMarkdown: string): readonly string[] {
  const headings: string[] = [];
  for (const line of bodyMarkdown.split(/\r?\n/u)) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    const heading = match?.[1] === undefined ? "" : normalizeExcerpt(match[1]);
    if (heading.length > 0) headings.push(truncateCharacters(heading, MAX_HEADING_CHARACTERS));
    if (headings.length === 3) break;
  }
  return Object.freeze(headings);
}

function candidateSnippet(bodyMarkdown: string): string {
  return truncateCharacters(normalizeExcerpt(bodyMarkdown), MAX_SNIPPET_CHARACTERS, true);
}

export function disclosureBoundsFailure(): never {
  throw new OrganizerPlannerReviewError("input_bounds");
}

export function effectiveExpansionStyle(input: PlannerInput): OrganizerExpansionPreference {
  if (input.controls.expansionDisabled) return "off";
  const expansionStyle = input.expansionStyle ?? "brief";
  if (expansionStyle === "off") disclosureBoundsFailure();
  return expansionStyle;
}

function createEphemeralCandidateId(seen: ReadonlySet<string>): EphemeralCandidateId {
  for (;;) {
    const candidateId: EphemeralCandidateId = `candidate_${randomUUID().replaceAll("-", "")}`;
    if (!seen.has(candidateId)) return candidateId;
  }
}

export function assertDurableProfile(input: PlannerInput): void {
  if (
    input.promptVersion !== ORGANIZER_PROMPT_VERSION ||
    input.schemaVersion !== ORGANIZER_SCHEMA_VERSION
  ) {
    throw new OrganizerProviderError("validation_failed", false);
  }
}

export function prepareProviderDisclosure(
  input: PlannerInput,
  deterministicDestination: DeterministicDestinationMatch | null
): PreparedProviderDisclosure {
  assertDurableProfile(input);
  if (input.signal.aborted) throw new OrganizerProviderError("provider_unavailable", true);
  if (
    !CAPTURE_ID.test(input.captureId) ||
    typeof input.capture.rawContent !== "string" ||
    characterLength(input.capture.rawContent) < 1 ||
    characterLength(input.capture.rawContent) > MAX_CAPTURE_CHARACTERS ||
    input.candidates.length > MAX_CANDIDATES ||
    !sameOrganizerCaptureControls(input.capture.controls, input.controls) ||
    (input.controls.explicitDestinationNoteId === null && input.controls.ruleMatch !== null)
  ) {
    disclosureBoundsFailure();
  }

  const seenCandidateIds = new Set<string>();
  const seenNoteIds = new Set<string>();
  const seenEphemeralCandidateIds = new Set<string>();
  const ephemeralToInternalCandidateId = new Map<EphemeralCandidateId, string>();
  const internalToEphemeralCandidateId = new Map<string, EphemeralCandidateId>();
  const candidates: ProviderCandidate[] = [];
  for (const candidate of input.candidates) {
    if (
      !NOTE_ID.test(candidate.candidateId) ||
      !NOTE_ID.test(candidate.noteId) ||
      seenCandidateIds.has(candidate.candidateId) ||
      seenNoteIds.has(candidate.noteId) ||
      !candidate.isOpen ||
      !NOTE_TYPES.has(candidate.noteType) ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 1 ||
      typeof candidate.title !== "string" ||
      characterLength(candidate.title.trim()) < 1 ||
      characterLength(candidate.title) > MAX_TITLE_CHARACTERS ||
      typeof candidate.bodyMarkdown !== "string" ||
      characterLength(candidate.bodyMarkdown) > MAX_CANDIDATE_BODY_CHARACTERS
    ) {
      disclosureBoundsFailure();
    }
    seenCandidateIds.add(candidate.candidateId);
    seenNoteIds.add(candidate.noteId);
    const ephemeralCandidateId = createEphemeralCandidateId(seenEphemeralCandidateIds);
    seenEphemeralCandidateIds.add(ephemeralCandidateId);
    ephemeralToInternalCandidateId.set(ephemeralCandidateId, candidate.candidateId);
    internalToEphemeralCandidateId.set(candidate.candidateId, ephemeralCandidateId);
    candidates.push(
      Object.freeze({
        candidateId: ephemeralCandidateId,
        headings: candidateHeadings(candidate.bodyMarkdown),
        isOpen: true,
        latestSnippet: candidateSnippet(candidate.bodyMarkdown),
        noteType: candidate.noteType,
        title: candidate.title
      })
    );
  }

  const explicitNoteId = input.controls.explicitDestinationNoteId;
  if (explicitNoteId !== null && !NOTE_ID.test(explicitNoteId)) disclosureBoundsFailure();
  if (explicitNoteId !== null && deterministicDestination?.source !== "explicit_control")
    disclosureBoundsFailure();

  const deterministicEphemeralCandidateId =
    deterministicDestination === null
      ? null
      : (internalToEphemeralCandidateId.get(deterministicDestination.candidateId) ?? null);
  if (deterministicDestination !== null && deterministicEphemeralCandidateId === null)
    disclosureBoundsFailure();
  const expansionStyle = effectiveExpansionStyle(input);

  const providerInput: ProviderInput = Object.freeze({
    candidates: Object.freeze(candidates),
    capture: Object.freeze({
      inferredKind: inferOrganizerCaptureKind(input.capture.rawContent),
      ownerInstructions: input.capture.guidance ?? null,
      text: input.capture.rawContent
    }),
    contract: ORGANIZER_DISCLOSURE_CONTRACT,
    controls: Object.freeze({
      expansionDisabled: input.controls.expansionDisabled,
      expansionStyle,
      explicitDestinationCandidateId: deterministicEphemeralCandidateId
    })
  });
  const serialized = JSON.stringify(providerInput);
  if (new TextEncoder().encode(serialized).byteLength > MAX_USER_INPUT_BYTES)
    disclosureBoundsFailure();
  return Object.freeze({
    deterministicEphemeralCandidateId,
    ephemeralToInternalCandidateId,
    expansionStyle,
    internalToEphemeralCandidateId,
    serialized
  });
}

function enforceDeterministicDestination(
  plan: unknown,
  destinationCandidateId: EphemeralCandidateId | null
): unknown {
  if (destinationCandidateId === null || !isRecord(plan) || plan.decision !== "append_to_note")
    return plan;
  return Object.freeze({
    ...plan,
    destination: Object.freeze({ candidateId: destinationCandidateId, newNote: null })
  });
}

function enforceExpansionPreference(
  plan: unknown,
  expansionStyle: OrganizerExpansionPreference
): unknown {
  if (!isRecord(plan) || plan.generatedExpansion === null) return plan;
  if (expansionStyle === "off") return Object.freeze({ ...plan, generatedExpansion: null });
  if (
    expansionStyle === "brief" &&
    isRecord(plan.generatedExpansion) &&
    typeof plan.generatedExpansion.text === "string" &&
    characterLength(plan.generatedExpansion.text) > MAX_BRIEF_EXPANSION_CHARACTERS
  ) {
    return Object.freeze({ ...plan, generatedExpansion: null });
  }
  return plan;
}

function translateCandidateId(
  value: unknown,
  ephemeralToInternalCandidateId: ReadonlyMap<EphemeralCandidateId, string>
): string {
  if (typeof value !== "string" || !EPHEMERAL_CANDIDATE_ID.test(value))
    throw new OrganizerPlannerReviewError("invalid_output");
  const internalCandidateId = ephemeralToInternalCandidateId.get(value as EphemeralCandidateId);
  if (internalCandidateId === undefined) throw new OrganizerPlannerReviewError("invalid_output");
  return internalCandidateId;
}

function translateProviderCandidateIds(
  plan: unknown,
  ephemeralToInternalCandidateId: ReadonlyMap<EphemeralCandidateId, string>
): unknown {
  if (!isRecord(plan)) throw new OrganizerPlannerReviewError("invalid_output");

  let destination = plan.destination;
  if (isRecord(destination) && destination.candidateId !== null) {
    destination = Object.freeze({
      ...destination,
      candidateId: translateCandidateId(destination.candidateId, ephemeralToInternalCandidateId)
    });
  }

  let alternatives = plan.alternatives;
  if (Array.isArray(alternatives)) {
    alternatives = Object.freeze(
      alternatives.map((candidateId) =>
        translateCandidateId(candidateId, ephemeralToInternalCandidateId)
      )
    );
  }

  let operations = plan.operations;
  if (Array.isArray(operations)) {
    const providerOperations: readonly unknown[] = operations;
    operations = Object.freeze(
      providerOperations.map((operation) => {
        if (!isRecord(operation) || operation.type !== "add_relation") return operation;
        return Object.freeze({
          ...operation,
          toCandidateId: translateCandidateId(
            operation.toCandidateId,
            ephemeralToInternalCandidateId
          )
        });
      })
    );
  }

  return Object.freeze({ ...plan, alternatives, destination, operations });
}

/** Applies the shared post-response policy and maps aliases back to internal candidate IDs. */
export function finalizeProviderPlan(
  plan: unknown,
  disclosure: PreparedProviderDisclosure
): unknown {
  return translateProviderCandidateIds(
    enforceExpansionPreference(
      enforceDeterministicDestination(plan, disclosure.deterministicEphemeralCandidateId),
      disclosure.expansionStyle
    ),
    disclosure.ephemeralToInternalCandidateId
  );
}
