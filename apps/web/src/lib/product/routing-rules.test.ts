import type { NoteSummary, RoutingRuleDto } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  boundedRoutingRulePreviewText,
  emptyRoutingRuleDraft,
  isRoutableRoutingRuleNote,
  previewRoutingRuleMatch,
  reconcileAuthoritativeRoutingRules,
  ROUTING_RULE_PREVIEW_MAX_CODE_POINTS,
  routingRuleAcceptRequest,
  routingRuleCreateFields,
  routingRuleDraftErrors,
  routingRuleDraftFor,
  routingRuleIdempotencyKeyForAttempt,
  routingRuleLastFiredLabel,
  routingRuleRemovalRequest,
  routingRuleSourceLabel,
  routingRuleStateLabel,
  routingRuleToggleRequest,
  routingRuleUpdateFields,
  sortRoutingRules,
  upsertRoutingRuleWithoutRevisionRegression,
  type RoutingRuleMutationAttempt
} from "./routing-rules";

const explicitRule: RoutingRuleDto = {
  id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  revision: 3,
  enabled: true,
  ruleType: "prefix",
  condition: "gym",
  normalizedCondition: "gym",
  aliases: [],
  destination: { type: "space", spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X" },
  destinationStatus: "active",
  priority: 200,
  source: "explicit",
  proposalState: null,
  lastFiredAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z"
};

describe("routing-rule product helpers", () => {
  it("offers only open AI-assisted active notes as routing destinations", () => {
    const note: NoteSummary = {
      archivedAt: null,
      currentRevision: 1,
      deletedAt: null,
      id: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      isOpen: true,
      pinnedAt: null,
      privacy: "ai_assisted",
      spaceId: null,
      title: "Principles",
      type: "principle",
      updatedAt: "2026-09-01T12:00:00.000Z"
    };

    expect(isRoutableRoutingRuleNote(note)).toBe(true);
    expect(isRoutableRoutingRuleNote({ ...note, isOpen: false })).toBe(false);
    expect(isRoutableRoutingRuleNote({ ...note, privacy: "private_manual" })).toBe(false);
    expect(isRoutableRoutingRuleNote({ ...note, archivedAt: "2026-09-01T12:00:00.000Z" })).toBe(
      false
    );
    expect(isRoutableRoutingRuleNote({ ...note, deletedAt: "2026-09-01T12:00:00.000Z" })).toBe(
      false
    );
  });

  it("validates the condition, active destination, and bounded whole-number priority", () => {
    expect(
      routingRuleDraftErrors({
        ...emptyRoutingRuleDraft(),
        condition: " ",
        destinationId: "",
        priority: "10.5"
      })
    ).toEqual({
      condition: "Enter the text this rule should recognize.",
      destinationId: "Choose an active note or space.",
      priority: "Use a whole number from 0 to 10,000."
    });
  });

  it("builds canonical create fields and trims the condition", () => {
    expect(
      routingRuleCreateFields({
        ...emptyRoutingRuleDraft(),
        condition: "  workout:  ",
        destinationId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X"
      })
    ).toEqual({
      condition: "workout:",
      destination: { type: "note", noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" },
      enabled: true,
      priority: 100,
      ruleType: "prefix"
    });
    expect(
      routingRuleCreateFields({
        ...emptyRoutingRuleDraft(),
        condition: "\u0085workout:\u0085",
        destinationId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X"
      })
    ).toMatchObject({ condition: "workout:" });
    expect(
      routingRuleCreateFields({
        ...emptyRoutingRuleDraft(),
        condition: "! \u0085 ?",
        destinationId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X"
      })
    ).toBeNull();
    expect(
      routingRuleCreateFields({
        ...emptyRoutingRuleDraft(),
        condition: "㍿".repeat(126),
        destinationId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X"
      })
    ).toBeNull();
  });

  it("emits only changed fields with the server revision supplied separately", () => {
    const draft = { ...routingRuleDraftFor(explicitRule), enabled: false, priority: "250" };
    expect(routingRuleUpdateFields(explicitRule, draft)).toEqual({
      enabled: false,
      priority: 250
    });
    expect(routingRuleUpdateFields(explicitRule, routingRuleDraftFor(explicitRule))).toBeNull();
  });

  it("requires a replacement before an invalid destination can be saved", () => {
    const blocked = { ...explicitRule, destinationStatus: "deleted" as const };
    const draft = routingRuleDraftFor(blocked);
    expect(draft.destinationId).toBe("");
    expect(routingRuleDraftErrors(draft).destinationId).toBe("Choose an active note or space.");
    expect(routingRuleStateLabel(blocked)).toBe("Blocked");
  });

  it("binds accept, toggle, and removal mutations to the visible revision and key", () => {
    expect(routingRuleAcceptRequest(explicitRule, "accept-key")).toEqual({
      enabled: true,
      expectedRevision: 3,
      idempotencyKey: "accept-key"
    });
    expect(routingRuleToggleRequest(explicitRule, "toggle-key")).toEqual({
      enabled: false,
      expectedRevision: 3,
      idempotencyKey: "toggle-key"
    });
    expect(routingRuleRemovalRequest(explicitRule, "delete-key")).toEqual({
      expectedRevision: 3,
      idempotencyKey: "delete-key"
    });
  });

  it("rotates the cached idempotency key when a draft changes after an ambiguous failure", () => {
    const attempts = new Map<string, RoutingRuleMutationAttempt>();
    const createdKeys = ["web_key_1", "web_key_2", "web_key_3", "web_key_4"];
    const createKey = () => createdKeys.shift() ?? "unexpected";
    const initial = routingRuleCreateFields({
      ...emptyRoutingRuleDraft(),
      condition: "  gym:  ",
      destinationId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X"
    });
    if (initial === null) throw new Error("Expected a valid initial routing-rule draft");

    const firstKey = routingRuleIdempotencyKeyForAttempt(attempts, "create", initial, createKey);
    // An ambiguous failure intentionally leaves the attempt cached. An exact retry reuses it.
    expect(routingRuleIdempotencyKeyForAttempt(attempts, "create", { ...initial }, createKey)).toBe(
      firstKey
    );

    const conditionEdited = routingRuleCreateFields({
      ...emptyRoutingRuleDraft(),
      condition: "workout:",
      destinationId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X"
    });
    expect(conditionEdited).not.toBeNull();
    const conditionKey = routingRuleIdempotencyKeyForAttempt(
      attempts,
      "create",
      conditionEdited,
      createKey
    );
    expect(conditionKey).toBe("web_key_2");

    const destinationEdited = routingRuleCreateFields({
      ...emptyRoutingRuleDraft(),
      condition: "workout:",
      destinationId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      destinationKind: "space"
    });
    expect(destinationEdited).not.toBeNull();
    const destinationKey = routingRuleIdempotencyKeyForAttempt(
      attempts,
      "create",
      destinationEdited,
      createKey
    );
    expect(destinationKey).toBe("web_key_3");

    const priorityEdited = routingRuleCreateFields({
      ...emptyRoutingRuleDraft(),
      condition: "workout:",
      destinationId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      destinationKind: "space",
      priority: "250"
    });
    expect(priorityEdited).not.toBeNull();
    const priorityKey = routingRuleIdempotencyKeyForAttempt(
      attempts,
      "create",
      priorityEdited,
      createKey
    );
    expect(priorityKey).toBe("web_key_4");
    expect(new Set([firstKey, conditionKey, destinationKey, priorityKey]).size).toBe(4);
  });

  it("sorts offers first, then applies priority and stable ID ordering", () => {
    const low: RoutingRuleDto = {
      ...explicitRule,
      id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      priority: 10
    };
    const offered: RoutingRuleDto = {
      ...explicitRule,
      id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
      enabled: false,
      priority: 1,
      source: "correction_suggested" as const,
      proposalState: "offered" as const
    };
    expect(sortRoutingRules([low, explicitRule, offered]).map((rule) => rule.id)).toEqual([
      offered.id,
      explicitRule.id,
      low.id
    ]);
  });

  it("never regresses a rule revision while reconciling mutation or snapshot results", () => {
    const newer = { ...explicitRule, revision: 5, priority: 500 };
    const historical = { ...explicitRule, revision: 4, priority: 10 };
    expect(upsertRoutingRuleWithoutRevisionRegression([newer], historical)).toEqual([newer]);
    expect(reconcileAuthoritativeRoutingRules([newer], [historical])).toEqual([newer]);
    expect(reconcileAuthoritativeRoutingRules([newer], [])).toEqual([]);
  });

  it("accepts equal-revision operational fields from an authoritative snapshot", () => {
    const authoritative = {
      ...explicitRule,
      destinationStatus: "archived" as const,
      lastFiredAt: "2026-09-01T12:30:00.000Z"
    };

    expect(reconcileAuthoritativeRoutingRules([explicitRule], [authoritative])).toEqual([
      authoritative
    ]);
  });

  it("previews a matching active owner-confirmed rule and returns null for no match", () => {
    expect(previewRoutingRuleMatch("gym: squats", [explicitRule])?.id).toBe(explicitRule.id);
    expect(previewRoutingRuleMatch("shopping list", [explicitRule])).toBeNull();
  });

  it("excludes offered, disabled, and invalid-destination rules from preview", () => {
    const offered: RoutingRuleDto = {
      ...explicitRule,
      enabled: false,
      priority: 900,
      source: "correction_suggested",
      proposalState: "offered"
    };
    const disabled: RoutingRuleDto = {
      ...explicitRule,
      id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      enabled: false,
      priority: 800
    };
    const blocked: RoutingRuleDto = {
      ...explicitRule,
      id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
      destinationStatus: "archived",
      priority: 700
    };

    expect(previewRoutingRuleMatch("gym: squats", [offered, disabled, blocked])).toBeNull();
  });

  it("uses priority followed by ascending rule ID as the preview tie-break", () => {
    const laterID: RoutingRuleDto = {
      ...explicitRule,
      id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      priority: 300
    };
    const earlierID: RoutingRuleDto = {
      ...explicitRule,
      id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1W",
      priority: 300
    };
    const lowerPriority: RoutingRuleDto = {
      ...explicitRule,
      id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1V",
      priority: 299
    };

    expect(previewRoutingRuleMatch("gym: squats", [laterID, lowerPriority, earlierID])?.id).toBe(
      earlierID.id
    );
  });

  it("labels every source and formats last-fired metadata", () => {
    const learned: RoutingRuleDto = {
      ...explicitRule,
      source: "correction_suggested",
      proposalState: "accepted"
    };
    const fired: RoutingRuleDto = {
      ...learned,
      lastFiredAt: "2026-09-01T12:00:00.000Z"
    };

    expect(routingRuleSourceLabel(explicitRule)).toBe("Explicit");
    expect(routingRuleSourceLabel(learned)).toBe("Learned");
    expect(routingRuleLastFiredLabel(explicitRule)).toBe("Never fired");
    expect(routingRuleLastFiredLabel(fired, () => "Sep 1, 2026 at 12:00 PM")).toBe(
      "Last fired Sep 1, 2026 at 12:00 PM"
    );
  });

  it("bounds preview text by Unicode code points", () => {
    const oversized = "📝".repeat(ROUTING_RULE_PREVIEW_MAX_CODE_POINTS + 2);
    expect(Array.from(boundedRoutingRulePreviewText(oversized))).toHaveLength(
      ROUTING_RULE_PREVIEW_MAX_CODE_POINTS
    );
  });
});
