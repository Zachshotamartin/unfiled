import {
  inspectPlanSourcePreservation,
  parseDeterministicListCapture,
  parseDeterministicLogCapture
} from "@unfiled/ai-routing";
import {
  OrganizationPlanSchema,
  type ModelOperation,
  type OrganizationPlan
} from "@unfiled/contracts";

import { OrganizerUnavailableError } from "./errors.js";
import { ORGANIZER_PROMPT_VERSION, ORGANIZER_SCHEMA_VERSION } from "./prompt.js";

const JOB_ID_PATTERN = /^job_([0-9A-HJKMNP-TV-Z]{26})$/u;
const CAPTURE_ID_PATTERN = /^cap_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NOTE_ID_PATTERN = /^note_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NOTE_TYPES = new Set(["generic", "list", "log", "principle", "project"]);
const PRINCIPLE_LABEL =
  /(?:^|\b)(?:principle|method|maxim|mindset|rule of thumb|belief|lesson)\s*:/iu;
const PRINCIPLE_CONCEPT =
  /\b(?:attention|availability|boundary|choice|commitment|commitments|consistency|curiosity|discipline|friction|honest|integrity|kindness|motivation|progress|rest|simplicity|systems|tradeoff|uncertainty)\b/iu;
const PERSONAL_EVENT =
  /\b(?:i|i'm|i've|me|my|we|we're|our|today|tonight|yesterday|tomorrow|meeting|appointment)\b/iu;
const LOG_ROUTING_PREFIX = /^\s*(?:(?:please\s+)?(?:log|record)\s+)/iu;
const ROUTING_DESTINATION_TAIL =
  /\s+(?:to|in|into)\s+(?:my\s+|the\s+)?[\p{L}\p{N}][\p{L}\p{N} '\u2019-]{0,59}[.!?]?\s*$/iu;

export type OrganizerCaptureControls = Readonly<{
  expansionDisabled: boolean;
  explicitDestinationNoteId: `note_${string}` | null;
}>;
export type DecryptedCapture = Readonly<{
  controls: OrganizerCaptureControls;
  rawContent: string;
}>;
export type DecryptedCandidate = Readonly<{
  bodyMarkdown: string;
  candidateId: `note_${string}`;
  isOpen: boolean;
  noteId: `note_${string}`;
  noteType: "generic" | "list" | "log" | "principle" | "project";
  revision: number;
  structuredData: unknown;
  title: string;
}>;
export type PlannerInput = Readonly<{
  capture: DecryptedCapture;
  candidates: readonly DecryptedCandidate[];
  captureId: `cap_${string}`;
  controls: OrganizerCaptureControls;
  promptVersion: string;
  schemaVersion: number;
  signal: AbortSignal;
}>;
export type OrganizerPlanner = Readonly<{ plan(input: PlannerInput): Promise<unknown> }>;

export type DeterministicDestinationCandidate = Readonly<{
  candidateId: `note_${string}`;
  isOpen: boolean;
  noteId: `note_${string}`;
  title: string;
}>;
export type DeterministicDestinationMatch = Readonly<{
  candidateId: `note_${string}`;
  source: "exact_title_phrase" | "explicit_control";
}>;

export type OrganizerCaptureKind =
  "freeform" | "list_items" | "log_entry" | "principle" | "project_update";

export function inferOrganizerCaptureKind(text: string): OrganizerCaptureKind {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (PRINCIPLE_LABEL.test(normalized)) return "principle";
  if (parseDeterministicListCapture(text) !== null) return "list_items";
  if (parseDeterministicLogCapture(text) !== null) return "log_entry";
  if (/\b(?:blocked|milestone|next step|project update|shipped)\b/iu.test(text))
    return "project_update";
  const characterLength = Array.from(normalized).length;
  if (
    characterLength >= 10 &&
    characterLength <= 280 &&
    PRINCIPLE_CONCEPT.test(normalized) &&
    !PERSONAL_EVENT.test(normalized)
  )
    return "principle";
  return "freeform";
}

function normalizedDestinationTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'`\u2018\u2019\u201c\u201d]+|["'`\u2018\u2019\u201c\u201d.!?]+$/gu, "")
    .trim();
}

/**
 * Resolves only user-directed destinations that do not need an editable rule.
 * Explicit note controls win. Otherwise the final `to`/`into` phrase must be
 * an exact normalized title with exactly one open candidate.
 */
export function resolveDeterministicDestination(
  input: Readonly<{
    candidates: readonly DeterministicDestinationCandidate[];
    capture: DecryptedCapture;
  }>
): DeterministicDestinationMatch | null {
  const eligible = input.candidates.filter(({ isOpen }) => isOpen);
  const explicitNoteId = input.capture.controls.explicitDestinationNoteId;
  if (explicitNoteId !== null) {
    const matches = eligible.filter(({ noteId }) => noteId === explicitNoteId);
    return matches.length === 1 && matches[0] !== undefined
      ? Object.freeze({ candidateId: matches[0].candidateId, source: "explicit_control" })
      : null;
  }

  const normalizedCapture = input.capture.rawContent.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const destinationMarkers = [...normalizedCapture.matchAll(/\b(?:into|to)\b/giu)];
  const finalMarker = destinationMarkers.at(-1);
  if (finalMarker?.index === undefined) return null;
  const phrase = normalizedDestinationTitle(
    normalizedCapture.slice(finalMarker.index + finalMarker[0].length)
  );
  if (phrase.length === 0) return null;

  const matches = eligible.filter(({ title }) => normalizedDestinationTitle(title) === phrase);
  return matches.length === 1 && matches[0] !== undefined
    ? Object.freeze({ candidateId: matches[0].candidateId, source: "exact_title_phrase" })
    : null;
}

function expectedNoteType(kind: OrganizerCaptureKind): DecryptedCandidate["noteType"] {
  if (kind === "list_items") return "list";
  if (kind === "log_entry") return "log";
  if (kind === "principle") return "principle";
  if (kind === "project_update") return "project";
  return "generic";
}

function deterministicOperation(
  captureText: string,
  kind: OrganizerCaptureKind
): ModelOperation | null {
  if (kind === "list_items") {
    const items = parseDeterministicListCapture(captureText);
    return items === null
      ? null
      : Object.freeze({ items, section: null, type: "append_list_items" as const });
  }
  if (kind === "log_entry") {
    const content = captureText
      .normalize("NFKC")
      .replace(LOG_ROUTING_PREFIX, "")
      .replace(ROUTING_DESTINATION_TAIL, "")
      .trim();
    return parseDeterministicLogCapture(content) === null
      ? null
      : Object.freeze({ entry: Object.freeze({ raw: content }), type: "append_log_entry" });
  }
  return captureText.length > 0 && captureText.length <= 10_000
    ? Object.freeze({ content: captureText, type: "append_raw" })
    : null;
}

/** Builds an append plan only when destination, type, and source are deterministic. */
export function buildDeterministicDestinationPlan(input: PlannerInput): OrganizationPlan | null {
  const candidateIds = new Set<string>();
  const noteIds = new Set<string>();
  if (
    input.promptVersion !== ORGANIZER_PROMPT_VERSION ||
    input.schemaVersion !== ORGANIZER_SCHEMA_VERSION ||
    input.signal.aborted ||
    !CAPTURE_ID_PATTERN.test(input.captureId) ||
    typeof input.capture.rawContent !== "string" ||
    Array.from(input.capture.rawContent).length < 1 ||
    Array.from(input.capture.rawContent).length > 10_000 ||
    input.candidates.length > 8 ||
    input.capture.controls.expansionDisabled !== input.controls.expansionDisabled ||
    input.capture.controls.explicitDestinationNoteId !== input.controls.explicitDestinationNoteId ||
    (input.controls.explicitDestinationNoteId !== null &&
      !NOTE_ID_PATTERN.test(input.controls.explicitDestinationNoteId)) ||
    input.candidates.some((candidate) => {
      const duplicate = candidateIds.has(candidate.candidateId) || noteIds.has(candidate.noteId);
      candidateIds.add(candidate.candidateId);
      noteIds.add(candidate.noteId);
      return (
        duplicate ||
        !NOTE_ID_PATTERN.test(candidate.candidateId) ||
        !NOTE_ID_PATTERN.test(candidate.noteId) ||
        !candidate.isOpen ||
        !NOTE_TYPES.has(candidate.noteType) ||
        !Number.isSafeInteger(candidate.revision) ||
        candidate.revision < 1 ||
        typeof candidate.title !== "string" ||
        Array.from(candidate.title.trim()).length < 1 ||
        Array.from(candidate.title).length > 200 ||
        typeof candidate.bodyMarkdown !== "string" ||
        Array.from(candidate.bodyMarkdown).length > 200_000
      );
    })
  ) {
    return null;
  }
  const destination = resolveDeterministicDestination({
    candidates: input.candidates,
    capture: input.capture
  });
  if (destination === null) return null;
  const matchingCandidates = input.candidates.filter(
    ({ candidateId }) => candidateId === destination.candidateId
  );
  const candidate = matchingCandidates[0];
  if (matchingCandidates.length !== 1 || candidate?.isOpen !== true) return null;
  const captureKind = inferOrganizerCaptureKind(input.capture.rawContent);
  if (candidate.noteType !== expectedNoteType(captureKind)) return null;
  const operation = deterministicOperation(input.capture.rawContent, captureKind);
  if (operation === null) return null;
  const parsed = OrganizationPlanSchema.safeParse({
    alternatives: [],
    captureKind,
    decision: "append_to_note",
    destination: { candidateId: candidate.candidateId, newNote: null },
    generatedExpansion: null,
    operations: [operation],
    reasonCodes: ["explicit_destination", "type_match"],
    schemaVersion: 1
  });
  if (
    !parsed.success ||
    !inspectPlanSourcePreservation(input.capture.rawContent, parsed.data).preserved
  )
    return null;
  return parsed.data;
}

export function createDeterministicFirstOrganizerPlanner(
  fallback: OrganizerPlanner
): OrganizerPlanner {
  return Object.freeze({
    plan(input) {
      const deterministic = buildDeterministicDestinationPlan(input);
      return deterministic === null ? fallback.plan(input) : Promise.resolve(deterministic);
    }
  });
}

/** The database validates and binds this replay-stable create proposal. */
export function proposedNoteIdForJob(jobId: string): `note_${string}` {
  const suffix = JOB_ID_PATTERN.exec(jobId)?.[1];
  if (suffix === undefined) throw new OrganizerUnavailableError();
  return `note_${suffix}`;
}

export const unavailableProductionPlanner: OrganizerPlanner = Object.freeze({
  plan() {
    return Promise.reject(new OrganizerUnavailableError());
  }
});
