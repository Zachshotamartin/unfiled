import {
  MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES,
  MAX_ACTIVE_ROUTING_RULES,
  MAX_RETAINED_ROUTING_RULES,
  normalizeRoutingRuleCondition
} from "@unfiled/contracts";
import type {
  RoutingRuleDestination,
  RoutingRuleDestinationStatus,
  RoutingRuleMatchSnapshot,
  RoutingRuleProposalState,
  RoutingRuleSource,
  RoutingRuleType
} from "@unfiled/contracts";

export {
  MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES,
  MAX_ACTIVE_ROUTING_RULES,
  MAX_RETAINED_ROUTING_RULES,
  normalizeRoutingRuleCondition
};

export const ROUTING_RULE_MATCH_REASON_CODE = "routing_rule_match" as const;

export type RoutingRuleMatchCandidate = Readonly<{
  id: `rule_${string}`;
  revision: number;
  enabled: boolean;
  ruleType: RoutingRuleType;
  normalizedCondition: string;
  aliases: readonly string[];
  destination: RoutingRuleDestination;
  destinationStatus: RoutingRuleDestinationStatus;
  priority: number;
  source: RoutingRuleSource;
  proposalState: RoutingRuleProposalState;
}>;

export type RoutingRuleMatcherInput = Readonly<{
  captureText: string;
  rules: readonly RoutingRuleMatchCandidate[];
  activeDecryptedBytes: number;
}>;

export type RoutingRuleMatcherResult = Readonly<{
  snapshot: RoutingRuleMatchSnapshot;
  reasonCode: typeof ROUTING_RULE_MATCH_REASON_CODE;
}>;

export type RoutingRuleCapacityErrorCode =
  | "active_decrypted_bytes_limit_exceeded"
  | "active_rule_limit_exceeded"
  | "retained_rule_limit_exceeded";

export class RoutingRuleCapacityError extends Error {
  public constructor(
    public readonly code: RoutingRuleCapacityErrorCode,
    public readonly limit: number,
    public readonly actual: number
  ) {
    super(code);
    this.name = "RoutingRuleCapacityError";
  }
}

const WORD_CODE_POINT = /^[\p{L}\p{N}\p{M}\p{Pc}'’]$/u;

export function normalizeRoutingRuleText(value: string): string {
  return normalizeRoutingRuleCondition(value);
}

function isWordCodePoint(value: string | undefined): boolean {
  return value !== undefined && WORD_CODE_POINT.test(value);
}

function codePointBefore(value: string, index: number): string | undefined {
  return Array.from(value.slice(0, index)).at(-1);
}

function codePointAfter(value: string, index: number): string | undefined {
  return Array.from(value.slice(index))[0];
}

function containsWholePhrase(value: string, phrase: string): boolean {
  if (phrase.length === 0) return false;

  let offset = 0;
  while (offset <= value.length - phrase.length) {
    const index = value.indexOf(phrase, offset);
    if (index === -1) return false;

    const before = codePointBefore(value, index);
    const after = codePointAfter(value, index + phrase.length);
    if (!isWordCodePoint(before) && !isWordCodePoint(after)) return true;

    offset = index + 1;
  }
  return false;
}

function isOwnerConfirmedRule(rule: RoutingRuleMatchCandidate): boolean {
  if (!rule.enabled || rule.destinationStatus !== "active") return false;
  if (rule.source === "explicit") return rule.proposalState === null;
  return rule.proposalState === "accepted";
}

function matchesPrefix(capture: string, condition: string): boolean {
  return capture.startsWith(`${condition}:`) || capture.startsWith(`${condition} `);
}

function matchesPhrase(capture: string, condition: string): boolean {
  const firstEightyCodePoints = Array.from(capture).slice(0, 80).join("");
  return containsWholePhrase(firstEightyCodePoints, condition);
}

function matchesAlias(capture: string, condition: string, aliases: readonly string[]): boolean {
  const phrases = new Set([
    condition,
    ...aliases.map((alias) => normalizeRoutingRuleText(alias)).filter((alias) => alias.length > 0)
  ]);
  return [...phrases].some((phrase) => containsWholePhrase(capture, phrase));
}

function matchesDestinationMention(capture: string, condition: string): boolean {
  return (
    capture === `to ${condition}` ||
    capture === `in ${condition}` ||
    capture.endsWith(` to ${condition}`) ||
    capture.endsWith(` in ${condition}`)
  );
}

function matchesRule(capture: string, rule: RoutingRuleMatchCandidate): boolean {
  const condition = normalizeRoutingRuleText(rule.normalizedCondition);
  if (condition.length === 0) return false;

  switch (rule.ruleType) {
    case "prefix":
      return matchesPrefix(capture, condition);
    case "phrase":
      return matchesPhrase(capture, condition);
    case "alias":
      return matchesAlias(capture, condition, rule.aliases);
    case "destination_mention":
      return matchesDestinationMention(capture, condition);
  }
}

function compareRules(left: RoutingRuleMatchCandidate, right: RoutingRuleMatchCandidate): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function snapshotFor(rule: RoutingRuleMatchCandidate): RoutingRuleMatchSnapshot {
  const common = {
    ruleId: rule.id,
    ruleRevision: rule.revision,
    priority: rule.priority,
    matched: true as const
  };
  return rule.destination.type === "note"
    ? {
        ...common,
        destinationKind: "note",
        destinationId: rule.destination.noteId
      }
    : {
        ...common,
        destinationKind: "space",
        destinationId: rule.destination.spaceId
      };
}

function assertInputCapacity(input: RoutingRuleMatcherInput): void {
  if (input.rules.length > MAX_RETAINED_ROUTING_RULES) {
    throw new RoutingRuleCapacityError(
      "retained_rule_limit_exceeded",
      MAX_RETAINED_ROUTING_RULES,
      input.rules.length
    );
  }
  if (
    !Number.isSafeInteger(input.activeDecryptedBytes) ||
    input.activeDecryptedBytes < 0 ||
    input.activeDecryptedBytes > MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES
  ) {
    throw new RoutingRuleCapacityError(
      "active_decrypted_bytes_limit_exceeded",
      MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES,
      input.activeDecryptedBytes
    );
  }
}

function assertActiveRuleCapacity(activeRuleCount: number): void {
  if (activeRuleCount > MAX_ACTIVE_ROUTING_RULES) {
    throw new RoutingRuleCapacityError(
      "active_rule_limit_exceeded",
      MAX_ACTIVE_ROUTING_RULES,
      activeRuleCount
    );
  }
}

export function matchRoutingRule(input: RoutingRuleMatcherInput): RoutingRuleMatcherResult | null {
  assertInputCapacity(input);
  const activeRules = input.rules.filter(isOwnerConfirmedRule);
  assertActiveRuleCapacity(activeRules.length);

  const capture = normalizeRoutingRuleText(input.captureText);
  const matchedRule = [...activeRules]
    .sort(compareRules)
    .find((rule) => matchesRule(capture, rule));
  if (matchedRule === undefined) return null;

  return Object.freeze({
    snapshot: Object.freeze(snapshotFor(matchedRule)),
    reasonCode: ROUTING_RULE_MATCH_REASON_CODE
  });
}
