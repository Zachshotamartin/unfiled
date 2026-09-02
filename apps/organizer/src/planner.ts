import {
  inspectPlanSourcePreservation,
  parseDeterministicListCapture,
  parseDeterministicLogCapture
} from "@unfiled/ai-routing";
import {
  OrganizationPlanSchema,
  type ModelOperation,
  type OrganizationPlan,
  type RoutingRuleMatchSnapshot
} from "@unfiled/contracts";

import { OrganizerUnavailableError } from "./errors.js";
import { organizerLocalDate } from "./local-date.js";
import { ORGANIZER_PROMPT_VERSION, ORGANIZER_SCHEMA_VERSION } from "./prompt.js";
import type {
  OrganizerExpansionStyle,
  OrganizerProviderCredentialAccess
} from "./provider-credential.js";

const JOB_ID_PATTERN = /^job_([0-9A-HJKMNP-TV-Z]{26})$/u;
const CAPTURE_ID_PATTERN = /^cap_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NOTE_ID_PATTERN = /^note_[0-9A-HJKMNP-TV-Z]{26}$/u;
const SPACE_ID_PATTERN = /^spc_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NOTE_TYPES = new Set(["generic", "list", "log", "principle", "project"]);
const PRINCIPLE_LABEL =
  /(?:^|\b)(?:principle|method|maxim|mindset|rule of thumb|belief|lesson)\s*:/iu;
const PRINCIPLE_CONCEPT =
  /\b(?:attention|availability|boundary|choice|commitment|commitments|consistency|curiosity|discipline|friction|honest|integrity|kindness|motivation|progress|rest|simplicity|systems|tradeoff|uncertainty)\b/iu;
const PERSONAL_EVENT =
  /\b(?:i|i'm|i've|me|my|we|we're|our|today|tonight|yesterday|tomorrow|meeting|appointment)\b/iu;
const LOG_ROUTING_PREFIX =
  /^\s*(?:(?:please\s+)?(?:add|append|put|save|record|log)\s+|(?:shopping|grocery|groceries|workout)(?:\s+list)?\s*:\s*)/iu;
const ROUTING_DESTINATION_TAIL =
  /\s+(?:to|in|into)\s+(?:my\s+|the\s+)?[\p{L}\p{N}][\p{L}\p{N} '\u2019-]{0,59}[.!?]?\s*$/iu;

export type OrganizerCaptureControls = Readonly<{
  expansionDisabled: boolean;
  explicitDestinationNoteId: `note_${string}` | null;
  ruleMatch: RoutingRuleMatchSnapshot | null;
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
  expansionStyle?: OrganizerExpansionStyle;
  promptVersion: string;
  providerCredential?: OrganizerProviderCredentialAccess;
  routingEffort?: "economical" | "standard" | "thorough";
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

export type RoutingRuleDestinationCandidate = Readonly<{
  archivedAt: string | null;
  candidateId: `note_${string}`;
  dailyDate: string | null;
  deletedAt: string | null;
  isOpen: boolean;
  noteId: `note_${string}`;
  noteType: DecryptedCandidate["noteType"];
  spaceId: `spc_${string}` | null;
}>;

export function sameRoutingRuleMatch(
  left: RoutingRuleMatchSnapshot | null,
  right: RoutingRuleMatchSnapshot | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.ruleId === right.ruleId &&
    left.ruleRevision === right.ruleRevision &&
    left.destinationKind === right.destinationKind &&
    left.destinationId === right.destinationId &&
    left.priority === right.priority
  );
}

export function sameOrganizerCaptureControls(
  left: OrganizerCaptureControls,
  right: OrganizerCaptureControls
): boolean {
  return (
    left.expansionDisabled === right.expansionDisabled &&
    left.explicitDestinationNoteId === right.explicitDestinationNoteId &&
    sameRoutingRuleMatch(left.ruleMatch, right.ruleMatch)
  );
}

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

export function expectedOrganizerNoteType(
  kind: OrganizerCaptureKind
): DecryptedCandidate["noteType"] {
  if (kind === "list_items") return "list";
  if (kind === "log_entry") return "log";
  if (kind === "principle") return "principle";
  if (kind === "project_update") return "project";
  return "generic";
}

export function deterministicOrganizerOperation(
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

function routingRuleOperationCompatible(
  operation: ModelOperation,
  noteType: DecryptedCandidate["noteType"]
): boolean {
  if (operation.type === "append_list_items") return noteType === "list";
  if (operation.type === "append_log_entry") return noteType === "log";
  return (
    operation.type === "append_raw" &&
    (noteType === "generic" || noteType === "principle" || noteType === "project")
  );
}

function routingRuleSpaceTitle(captureText: string): string {
  const normalized = captureText.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const titleCodePoints: string[] = [];
  let codeUnitLength = 0;
  for (const codePoint of normalized) {
    if (codeUnitLength + codePoint.length > 60) break;
    titleCodePoints.push(codePoint);
    codeUnitLength += codePoint.length;
  }
  return titleCodePoints.join("").trim();
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
    !sameOrganizerCaptureControls(input.capture.controls, input.controls) ||
    (input.controls.explicitDestinationNoteId === null && input.controls.ruleMatch !== null) ||
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
  if (candidate.noteType !== expectedOrganizerNoteType(captureKind)) return null;
  const operation = deterministicOrganizerOperation(input.capture.rawContent, captureKind);
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

/**
 * Builds the complete rule-match plan without consulting a model or decrypted
 * destination title. The candidate page is an authorization-bound DB result:
 * a note rule must yield its one target, while a space rule yields either the
 * one compatible daily note or no note at all.
 */
export function buildDeterministicRoutingRulePlan(
  input: Readonly<{
    candidates: readonly RoutingRuleDestinationCandidate[];
    captureText: string;
    clientTimezone: string;
    controls: OrganizerCaptureControls;
    occurredAt: string;
  }>
): OrganizationPlan | null {
  const ruleMatch = input.controls.ruleMatch;
  if (
    input.controls.explicitDestinationNoteId !== null ||
    ruleMatch === null ||
    typeof input.captureText !== "string" ||
    Array.from(input.captureText).length < 1 ||
    Array.from(input.captureText).length > 10_000 ||
    input.candidates.length > 8
  ) {
    return null;
  }

  const candidateIds = new Set<string>();
  const noteIds = new Set<string>();
  if (
    input.candidates.some((candidate) => {
      const duplicate = candidateIds.has(candidate.candidateId) || noteIds.has(candidate.noteId);
      candidateIds.add(candidate.candidateId);
      noteIds.add(candidate.noteId);
      return (
        duplicate ||
        !NOTE_ID_PATTERN.test(candidate.candidateId) ||
        !NOTE_ID_PATTERN.test(candidate.noteId) ||
        (candidate.spaceId !== null && !SPACE_ID_PATTERN.test(candidate.spaceId)) ||
        !NOTE_TYPES.has(candidate.noteType)
      );
    })
  ) {
    return null;
  }

  const captureKind = inferOrganizerCaptureKind(input.captureText);
  const noteType = expectedOrganizerNoteType(captureKind);
  const operation = deterministicOrganizerOperation(input.captureText, captureKind);
  if (operation === null) return null;

  let decision: "append_to_note" | "create_note";
  let destination: OrganizationPlan["destination"];
  if (ruleMatch.destinationKind === "note") {
    const candidate = input.candidates[0];
    if (
      input.candidates.length !== 1 ||
      candidate?.noteId !== ruleMatch.destinationId ||
      !routingRuleOperationCompatible(operation, candidate.noteType) ||
      !candidate.isOpen ||
      candidate.archivedAt !== null ||
      candidate.deletedAt !== null
    ) {
      return null;
    }
    decision = "append_to_note";
    destination = Object.freeze({ candidateId: candidate.candidateId, newNote: null });
  } else {
    const localDate = organizerLocalDate(input.occurredAt, input.clientTimezone);
    if (localDate === null) return null;
    const structuredDailyRoute = captureKind === "list_items" || captureKind === "log_entry";
    if (!structuredDailyRoute) {
      const title = routingRuleSpaceTitle(input.captureText);
      if (title.length === 0) return null;
      decision = "create_note";
      destination = Object.freeze({
        candidateId: null,
        newNote: Object.freeze({
          noteType,
          spaceCandidateId: ruleMatch.destinationId,
          title
        })
      });
    } else {
      if (
        input.candidates.some(
          (candidate) =>
            candidate.spaceId !== ruleMatch.destinationId ||
            candidate.dailyDate !== localDate ||
            (candidate.noteType !== "list" && candidate.noteType !== "log") ||
            !candidate.isOpen ||
            candidate.archivedAt !== null ||
            candidate.deletedAt !== null
        )
      ) {
        return null;
      }
      const compatibleCandidates = input.candidates.filter(
        (candidate) => candidate.noteType === noteType
      );
      if (compatibleCandidates.length === 0) {
        decision = "create_note";
        destination = Object.freeze({
          candidateId: null,
          newNote: Object.freeze({
            noteType,
            spaceCandidateId: ruleMatch.destinationId,
            title: `${noteType === "list" ? "Daily list" : "Daily log"} / ${localDate}`
          })
        });
      } else {
        const candidate = compatibleCandidates[0];
        if (compatibleCandidates.length !== 1 || candidate === undefined) {
          return null;
        }
        decision = "append_to_note";
        destination = Object.freeze({ candidateId: candidate.candidateId, newNote: null });
      }
    }
  }

  const parsed = OrganizationPlanSchema.safeParse({
    alternatives: [],
    captureKind,
    decision,
    destination,
    generatedExpansion: null,
    operations: [operation],
    reasonCodes: ["routing_rule_match"],
    schemaVersion: 1
  });
  if (!parsed.success || !inspectPlanSourcePreservation(input.captureText, parsed.data).preserved) {
    return null;
  }
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
