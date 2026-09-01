import { OrganizationPlanSchema, type OrganizationPlan } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  applyDeterministicExtractionOverride,
  parseDeterministicExtraction,
  parseDeterministicListCapture,
  parseDeterministicLogCapture
} from "../src/index.js";

const DESTINATION = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const;

function listPlan(operations: OrganizationPlan["operations"]): OrganizationPlan {
  return OrganizationPlanSchema.parse({
    schemaVersion: 1,
    captureKind: "list_items",
    decision: "append_to_note",
    destination: { candidateId: DESTINATION, newNote: null },
    operations,
    generatedExpansion: null,
    alternatives: [],
    reasonCodes: ["explicit_shopping_intent", "type_match"]
  });
}

describe("deterministic extraction", () => {
  it("parses bounded prefixed, delimited, and bulleted lists", () => {
    expect(parseDeterministicListCapture("shopping: milk, eggs and oats")).toEqual([
      "milk",
      "eggs",
      "oats"
    ]);
    expect(parseDeterministicListCapture("- milk\n[ ] eggs\n3. oats")).toEqual([
      "milk",
      "eggs",
      "oats"
    ]);
    expect(parseDeterministicListCapture("please add one item")).toEqual(["one item"]);
    expect(parseDeterministicListCapture("add eggs to groceries")).toEqual(["eggs"]);
    expect(parseDeterministicListCapture("one undelimited sentence")).toBeNull();
    expect(parseDeterministicListCapture("shopping:")).toBeNull();
    expect(parseDeterministicListCapture("shopping: " + "x".repeat(501))).toBeNull();
  });

  it("recognizes bounded number-unit log syntax without interpreting values", () => {
    expect(parseDeterministicLogCapture("bench 135 x 8")).toEqual({ raw: "bench 135 x 8" });
    expect(parseDeterministicLogCapture("run 5 km")).toEqual({ raw: "run 5 km" });
    expect(parseDeterministicLogCapture("ordinary journal sentence")).toBeNull();
    expect(parseDeterministicLogCapture("")).toBeNull();
    expect(parseDeterministicLogCapture("1 kg " + "x".repeat(10_001))).toBeNull();
    expect(parseDeterministicExtraction("free text", "freeform")).toBeNull();
  });

  it("overrides a materially different model split and records the parser reason", () => {
    const overridden = applyDeterministicExtractionOverride({
      captureText: "shopping: milk and eggs",
      inferredKind: "list_items",
      plan: listPlan([
        { type: "append_list_items", section: "Open", items: ["milk and eggs"] },
        { type: "add_tags", tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"] }
      ])
    });

    expect(overridden.applied).toBe(true);
    expect(overridden.plan.operations).toEqual([
      { type: "append_list_items", section: "Open", items: ["milk", "eggs"] },
      { type: "add_tags", tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"] }
    ]);
    expect(overridden.plan.reasonCodes.at(-1)).toBe("parser_override");
  });

  it("is idempotent for matching output and does not alter deferred plans", () => {
    const plan = listPlan([{ type: "append_list_items", section: null, items: ["milk", "eggs"] }]);
    const matching = applyDeterministicExtractionOverride({
      captureText: "shopping: milk and eggs",
      inferredKind: "list_items",
      plan
    });
    expect(matching).toMatchObject({ applied: false, plan });

    const deferred = OrganizationPlanSchema.parse({
      ...plan,
      decision: "needs_review",
      destination: { candidateId: null, newNote: null },
      alternatives: [DESTINATION]
    });
    expect(
      applyDeterministicExtractionOverride({
        captureText: "shopping: milk and eggs",
        inferredKind: "list_items",
        plan: deferred
      })
    ).toMatchObject({ applied: false, plan: deferred });
  });

  it("caps model metadata operations and reason codes after an override", () => {
    const plan = OrganizationPlanSchema.parse({
      ...listPlan([{ type: "append_raw", content: "shopping: milk and eggs" }]),
      operations: [
        { type: "append_raw", content: "shopping: milk and eggs" },
        { type: "add_tags", tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"] },
        { type: "add_tags", tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1Y"] },
        { type: "add_tags", tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1Z"] },
        { type: "add_tags", tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D20"] }
      ],
      reasonCodes: [
        "explicit_shopping_intent",
        "open_daily_list",
        "semantic_match",
        "recent_destination",
        "type_match"
      ]
    });
    const result = applyDeterministicExtractionOverride({
      captureText: "shopping: milk and eggs",
      inferredKind: "list_items",
      plan
    });
    expect(result.plan.operations).toHaveLength(5);
    expect(result.plan.reasonCodes).toHaveLength(5);
    expect(result.plan.reasonCodes).toContain("parser_override");
  });
});
