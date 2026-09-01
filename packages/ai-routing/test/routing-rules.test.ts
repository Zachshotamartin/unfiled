import { describe, expect, it } from "vitest";

import {
  MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES,
  MAX_ACTIVE_ROUTING_RULES,
  MAX_RETAINED_ROUTING_RULES,
  ROUTING_RULE_MATCH_REASON_CODE,
  RoutingRuleCapacityError,
  matchRoutingRule,
  normalizeRoutingRuleText
} from "../src/index.js";
import type { RoutingRuleMatchCandidate } from "../src/index.js";

const RULE_A = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const RULE_B = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y";

const baseRule = {
  id: RULE_A,
  revision: 3,
  enabled: true,
  ruleType: "phrase",
  normalizedCondition: "groceries",
  aliases: [],
  destination: { type: "note", noteId: NOTE_A },
  destinationStatus: "active",
  priority: 100,
  source: "explicit",
  proposalState: null
} as const satisfies RoutingRuleMatchCandidate;

function rule(overrides: Partial<RoutingRuleMatchCandidate> = {}): RoutingRuleMatchCandidate {
  return { ...baseRule, ...overrides };
}

function match(
  captureText: string,
  rules: readonly RoutingRuleMatchCandidate[],
  activeDecryptedBytes = 1_024
) {
  return matchRoutingRule({ captureText, rules, activeDecryptedBytes });
}

describe("private routing-rule matcher", () => {
  it("normalizes NFKC, case, whitespace, and trailing Unicode punctuation", () => {
    expect(normalizeRoutingRuleText("  ＷＯＲＫＯＵＴ\t\nLog！！！  ")).toBe("workout log");
    expect(normalizeRoutingRuleText("Groceries…?!")).toBe("groceries");
  });

  it("matches prefixes only with a colon or space delimiter", () => {
    const prefix = rule({ ruleType: "prefix", normalizedCondition: "workout" });
    expect(match("ＷＯＲＫＯＵＴ： squats", [prefix])?.snapshot.ruleId).toBe(RULE_A);
    expect(match("Workout plan", [prefix])?.snapshot.ruleId).toBe(RULE_A);
    expect(match("workouts: squats", [prefix])).toBeNull();
    expect(match("workout", [prefix])).toBeNull();
  });

  it("matches whole phrases only when the complete phrase is within 80 Unicode code points", () => {
    const phrase = rule({ ruleType: "phrase", normalizedCondition: "groceries" });
    expect(match(`${"😀".repeat(69)} groceries today`, [phrase])?.snapshot.ruleId).toBe(RULE_A);
    expect(match(`${"😀".repeat(79)} groceries today`, [phrase])).toBeNull();
    expect(match("meg groceriesx later", [phrase])).toBeNull();
    expect(match("meg groceries later", [phrase])?.snapshot.ruleId).toBe(RULE_A);
  });

  it("matches normalized alias phrases on word boundaries without partial words", () => {
    const alias = rule({
      ruleType: "alias",
      normalizedCondition: "roosevelt method",
      aliases: ["  Morning　Ritual! "]
    });
    expect(match("Use my morning ritual tomorrow", [alias])?.snapshot.ruleId).toBe(RULE_A);
    expect(match("Review the Roosevelt Method", [alias])?.snapshot.ruleId).toBe(RULE_A);
    expect(match("The premorning ritualized draft", [alias])).toBeNull();
    expect(match("Roosevelt methodology", [alias])).toBeNull();
  });

  it("matches destination mentions only as exact to/in tails", () => {
    const mention = rule({
      ruleType: "destination_mention",
      normalizedCondition: "groceries"
    });
    expect(match("add eggs to groceries!!!", [mention])?.snapshot.ruleId).toBe(RULE_A);
    expect(match("put milk in groceries", [mention])?.snapshot.ruleId).toBe(RULE_A);
    expect(match("to groceries", [mention])?.snapshot.ruleId).toBe(RULE_A);
    expect(match("add eggs into groceries", [mention])).toBeNull();
    expect(match("add eggs to my groceries", [mention])).toBeNull();
    expect(match("add eggs to groceries tomorrow", [mention])).toBeNull();
  });

  it("evaluates only active owner-confirmed explicit or accepted learned rules", () => {
    const rules = [
      rule({ priority: 1_000, destinationStatus: "archived" }),
      rule({ priority: 900, enabled: false }),
      rule({
        priority: 800,
        source: "correction_suggested",
        proposalState: "offered"
      }),
      rule({
        priority: 700,
        source: "correction_suggested",
        proposalState: null
      }),
      rule({
        id: RULE_B,
        priority: 600,
        source: "correction_suggested",
        proposalState: "accepted",
        destination: { type: "note", noteId: NOTE_B }
      }),
      rule({ priority: 500 })
    ];

    expect(match("buy groceries today", rules)?.snapshot).toMatchObject({
      ruleId: RULE_B,
      destinationKind: "note",
      destinationId: NOTE_B
    });
    expect(
      match("buy groceries today", [
        rule({
          source: "correction_suggested",
          proposalState: "accepted",
          enabled: false
        })
      ])
    ).toBeNull();
  });

  it("uses descending priority and ascending rule ID as a stable first-match order", () => {
    const lowerId = rule({
      id: RULE_A,
      priority: 500,
      destination: { type: "note", noteId: NOTE_A }
    });
    const higherId = rule({
      id: RULE_B,
      priority: 500,
      destination: { type: "note", noteId: NOTE_B }
    });
    expect(match("groceries today", [higherId, lowerId])?.snapshot.ruleId).toBe(RULE_A);

    const higherPriority = rule({
      id: RULE_B,
      priority: 501,
      destination: { type: "note", noteId: NOTE_B }
    });
    expect(match("groceries today", [lowerId, higherPriority])?.snapshot.ruleId).toBe(RULE_B);
  });

  it("returns the exact content-free snapshot and one fixed reason code", () => {
    const result = match("groceries today", [
      rule({
        revision: 9,
        priority: 888,
        destination: {
          type: "space",
          spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X"
        }
      })
    ]);
    expect(result).toEqual({
      snapshot: {
        ruleId: RULE_A,
        ruleRevision: 9,
        destinationKind: "space",
        destinationId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        priority: 888,
        matched: true
      },
      reasonCode: "routing_rule_match"
    });
    expect(result?.reasonCode).toBe(ROUTING_RULE_MATCH_REASON_CODE);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.snapshot)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("groceries");
  });

  it("does not mutate the caller's rule order", () => {
    const rules = [rule({ id: RULE_B, priority: 1 }), rule({ id: RULE_A, priority: 2 })];
    const originalIds = rules.map(({ id }) => id);
    match("groceries today", rules);
    expect(rules.map(({ id }) => id)).toEqual(originalIds);
  });

  it("fails closed instead of truncating retained, active, or decrypted-byte overflows", () => {
    const inactive = rule({ enabled: false });
    expect(() =>
      match(
        "no match",
        Array.from({ length: MAX_RETAINED_ROUTING_RULES + 1 }, () => inactive)
      )
    ).toThrow(
      expect.objectContaining({
        name: "RoutingRuleCapacityError",
        code: "retained_rule_limit_exceeded"
      })
    );
    expect(() =>
      match(
        "no match",
        Array.from({ length: MAX_ACTIVE_ROUTING_RULES + 1 }, () => baseRule)
      )
    ).toThrow(
      expect.objectContaining({
        name: "RoutingRuleCapacityError",
        code: "active_rule_limit_exceeded"
      })
    );
    expect(() =>
      match("groceries", [baseRule], MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES + 1)
    ).toThrow(
      expect.objectContaining({
        name: "RoutingRuleCapacityError",
        code: "active_decrypted_bytes_limit_exceeded"
      })
    );
    expect(() => match("groceries", [baseRule], -1)).toThrow(RoutingRuleCapacityError);
  });

  it("accepts every exact capacity boundary", () => {
    const inactiveRules = Array.from(
      { length: MAX_RETAINED_ROUTING_RULES - MAX_ACTIVE_ROUTING_RULES },
      () => rule({ enabled: false })
    );
    const activeRules = Array.from({ length: MAX_ACTIVE_ROUTING_RULES }, () => baseRule);
    expect(
      match(
        "nothing matches",
        [...inactiveRules, ...activeRules],
        MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES
      )
    ).toBeNull();
  });
});
