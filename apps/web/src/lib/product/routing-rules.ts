import { normalizeRoutingRuleCondition, prepareRoutingRuleCondition } from "@unfiled/contracts";
import type {
  EntityId,
  NoteSummary,
  RoutingRuleCreateRequest,
  RoutingRuleDeleteRequest,
  RoutingRuleDestination,
  RoutingRuleDto,
  RoutingRuleType,
  RoutingRuleUpdateRequest
} from "@unfiled/contracts";
import { matchRoutingRule } from "@unfiled/ai-routing/routing-rules";

import type { RoutingRuleDraft, RoutingRuleDraftErrors } from "./types";

export type RoutingRuleMutationAttempt = Readonly<{
  fingerprint: string;
  idempotencyKey: string;
}>;

export const ROUTING_RULE_PREVIEW_MAX_CODE_POINTS = 500;

export function isRoutableRoutingRuleNote(note: NoteSummary): boolean {
  return (
    note.privacy === "ai_assisted" &&
    note.isOpen &&
    note.archivedAt === null &&
    note.deletedAt === null
  );
}

export const ROUTING_RULE_TYPE_COPY = Object.freeze({
  prefix: Object.freeze({
    label: "Starts with",
    helper: "Matches text that begins with this phrase, followed by a space or colon."
  }),
  phrase: Object.freeze({
    label: "Contains phrase",
    helper: "Matches this phrase within the first 80 characters of a jot."
  }),
  alias: Object.freeze({
    label: "Contains word",
    helper: "Matches this word as a complete word, not as part of another word."
  }),
  destination_mention: Object.freeze({
    label: "Names destination",
    helper: "Matches an exact “to” or “in” destination mention at the end of a jot."
  })
} satisfies Readonly<Record<RoutingRuleType, Readonly<{ helper: string; label: string }>>>);

export function emptyRoutingRuleDraft(): RoutingRuleDraft {
  return Object.freeze({
    condition: "",
    destinationId: "",
    destinationKind: "note",
    enabled: true,
    priority: "100",
    ruleType: "prefix"
  });
}

function destinationParts(destination: RoutingRuleDestination): Readonly<{
  destinationId: string;
  destinationKind: "note" | "space";
}> {
  return destination.type === "note"
    ? Object.freeze({ destinationId: destination.noteId, destinationKind: "note" as const })
    : Object.freeze({ destinationId: destination.spaceId, destinationKind: "space" as const });
}

export function routingRuleDraftFor(rule: RoutingRuleDto): RoutingRuleDraft {
  const destination = destinationParts(rule.destination);
  return Object.freeze({
    condition: rule.condition,
    destinationId: rule.destinationStatus === "active" ? destination.destinationId : "",
    destinationKind: destination.destinationKind,
    enabled: rule.enabled,
    priority: String(rule.priority),
    ruleType: rule.ruleType
  });
}

export function routingRuleDraftErrors(draft: RoutingRuleDraft): RoutingRuleDraftErrors {
  const condition = normalizeRoutingRuleCondition(draft.condition);
  const priority = Number(draft.priority);
  return Object.freeze({
    ...(condition.length === 0
      ? { condition: "Enter the text this rule should recognize." }
      : condition.length > 500
        ? { condition: "Keep the matching text to 500 characters or fewer." }
        : {}),
    ...(draft.destinationId.length === 0
      ? { destinationId: "Choose an active note or space." }
      : {}),
    ...(!/^\d+$/u.test(draft.priority) || !Number.isInteger(priority) || priority > 10_000
      ? { priority: "Use a whole number from 0 to 10,000." }
      : {})
  });
}

export function routingRuleDestinationForDraft(
  draft: RoutingRuleDraft
): RoutingRuleDestination | null {
  if (draft.destinationId.length === 0) return null;
  return draft.destinationKind === "note"
    ? Object.freeze({
        type: "note" as const,
        noteId: draft.destinationId as EntityId<"note">
      })
    : Object.freeze({
        type: "space" as const,
        spaceId: draft.destinationId as EntityId<"spc">
      });
}

type RoutingRuleCreateFields = Omit<RoutingRuleCreateRequest, "idempotencyKey">;

export function routingRuleCreateFields(draft: RoutingRuleDraft): RoutingRuleCreateFields | null {
  if (Object.keys(routingRuleDraftErrors(draft)).length > 0) return null;
  const destination = routingRuleDestinationForDraft(draft);
  if (destination === null) return null;
  return Object.freeze({
    condition: prepareRoutingRuleCondition(draft.condition),
    destination,
    enabled: draft.enabled,
    priority: Number(draft.priority),
    ruleType: draft.ruleType
  });
}

type RoutingRuleUpdateFields = Omit<
  RoutingRuleUpdateRequest,
  "expectedRevision" | "idempotencyKey"
>;

export function routingRuleUpdateFields(
  rule: RoutingRuleDto,
  draft: RoutingRuleDraft
): RoutingRuleUpdateFields | null {
  if (Object.keys(routingRuleDraftErrors(draft)).length > 0) return null;
  const destination = routingRuleDestinationForDraft(draft);
  if (destination === null) return null;

  const condition = prepareRoutingRuleCondition(draft.condition);
  const priority = Number(draft.priority);
  const fields: RoutingRuleUpdateFields = {
    ...(rule.enabled === draft.enabled ? {} : { enabled: draft.enabled }),
    ...(rule.ruleType === draft.ruleType ? {} : { ruleType: draft.ruleType }),
    ...(rule.condition === condition ? {} : { condition }),
    ...(JSON.stringify(rule.destination) === JSON.stringify(destination) ? {} : { destination }),
    ...(rule.priority === priority ? {} : { priority })
  };
  return Object.keys(fields).length === 0 ? null : Object.freeze(fields);
}

export function routingRuleAcceptRequest(
  rule: RoutingRuleDto,
  idempotencyKey: string
): RoutingRuleUpdateRequest {
  return Object.freeze({
    enabled: true,
    expectedRevision: rule.revision,
    idempotencyKey
  });
}

export function routingRuleToggleRequest(
  rule: RoutingRuleDto,
  idempotencyKey: string
): RoutingRuleUpdateRequest {
  return Object.freeze({
    enabled: !rule.enabled,
    expectedRevision: rule.revision,
    idempotencyKey
  });
}

export function routingRuleRemovalRequest(
  rule: RoutingRuleDto,
  idempotencyKey: string
): RoutingRuleDeleteRequest {
  return Object.freeze({
    expectedRevision: rule.revision,
    idempotencyKey
  });
}

function canonicalAttemptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAttemptValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalAttemptValue(child)])
  );
}

export function routingRuleIdempotencyKeyForAttempt(
  attempts: Map<string, RoutingRuleMutationAttempt>,
  operation: string,
  normalizedRequestPayload: unknown,
  createKey: () => string
): string {
  const fingerprint = JSON.stringify(canonicalAttemptValue(normalizedRequestPayload));
  const existing = attempts.get(operation);
  if (existing?.fingerprint === fingerprint) return existing.idempotencyKey;
  const idempotencyKey = createKey();
  attempts.set(operation, Object.freeze({ fingerprint, idempotencyKey }));
  return idempotencyKey;
}

export function sortRoutingRules(items: readonly RoutingRuleDto[]): RoutingRuleDto[] {
  return [...items].sort((left, right) => {
    const leftOffered = left.proposalState === "offered" ? 0 : 1;
    const rightOffered = right.proposalState === "offered" ? 0 : 1;
    return (
      leftOffered - rightOffered ||
      right.priority - left.priority ||
      left.id.localeCompare(right.id)
    );
  });
}

export function upsertRoutingRuleWithoutRevisionRegression(
  items: readonly RoutingRuleDto[],
  incoming: RoutingRuleDto
): RoutingRuleDto[] {
  const current = items.find(({ id }) => id === incoming.id);
  const retained =
    current !== undefined && current.revision >= incoming.revision ? current : incoming;
  return sortRoutingRules([...items.filter(({ id }) => id !== incoming.id), retained]);
}

export function reconcileAuthoritativeRoutingRules(
  current: readonly RoutingRuleDto[],
  authoritative: readonly RoutingRuleDto[]
): RoutingRuleDto[] {
  const currentById = new Map(current.map((rule) => [rule.id, rule]));
  return sortRoutingRules(
    authoritative.map((rule) => {
      const local = currentById.get(rule.id);
      return local !== undefined && local.revision > rule.revision ? local : rule;
    })
  );
}

export function routingRuleStateLabel(rule: RoutingRuleDto): string {
  if (rule.proposalState === "offered") return "Suggested";
  if (rule.destinationStatus !== "active") return "Blocked";
  return rule.enabled ? "Active" : "Paused";
}

export function routingRuleSourceLabel(rule: RoutingRuleDto): "Explicit" | "Learned" {
  return rule.source === "explicit" ? "Explicit" : "Learned";
}

export function routingRuleLastFiredLabel(
  rule: RoutingRuleDto,
  formatDate: (value: Date) => string = (value) =>
    value.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    })
): string {
  if (rule.lastFiredAt === null) return "Never fired";
  const firedAt = new Date(rule.lastFiredAt);
  return Number.isNaN(firedAt.getTime()) ? "Never fired" : `Last fired ${formatDate(firedAt)}`;
}

export function boundedRoutingRulePreviewText(value: string): string {
  return Array.from(value).slice(0, ROUTING_RULE_PREVIEW_MAX_CODE_POINTS).join("");
}

function routingRuleDecryptedBytes(rules: readonly RoutingRuleDto[]): number {
  const encoder = new TextEncoder();
  return rules.reduce(
    (total, rule) =>
      total +
      encoder.encode(rule.normalizedCondition).byteLength +
      rule.aliases.reduce((aliasTotal, alias) => aliasTotal + encoder.encode(alias).byteLength, 0),
    0
  );
}

export function previewRoutingRuleMatch(
  captureText: string,
  rules: readonly RoutingRuleDto[]
): RoutingRuleDto | null {
  const result = matchRoutingRule({
    activeDecryptedBytes: routingRuleDecryptedBytes(rules),
    captureText: boundedRoutingRulePreviewText(captureText),
    rules
  });
  if (result === null) return null;
  return rules.find((rule) => rule.id === result.snapshot.ruleId) ?? null;
}
