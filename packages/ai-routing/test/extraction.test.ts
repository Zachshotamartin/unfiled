import { OrganizationPlanSchema, type OrganizationPlan } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  applyDeterministicExtractionOverride,
  parseDeterministicExtraction,
  parseListLabel,
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

  it("reads the name the owner gave a list, and only that", () => {
    expect(parseListLabel("todo list, buy milk, call mom, fix the bike")).toEqual({
      title: "Todo list",
      remainder: "buy milk, call mom, fix the bike"
    });
    expect(parseListLabel("groceries: milk, eggs")).toEqual({
      title: "Groceries",
      remainder: "milk, eggs"
    });
    expect(parseListLabel("Weekend plans: hike, brunch")).toEqual({
      title: "Weekend plans",
      remainder: "hike, brunch"
    });
    expect(parseListLabel("Packing list\npassport\ncharger")).toEqual({
      title: "Packing list",
      remainder: "passport\ncharger"
    });
    expect(parseListLabel("to do, water the plants")).toEqual({
      title: "To do",
      remainder: "water the plants"
    });
    // A plain list has no name: its first item is an item.
    expect(parseListLabel("milk, eggs, bread")).toBeNull();
    expect(parseListLabel("Milk\neggs\nbread")).toBeNull();
    expect(parseListLabel("guest count, venue, catering")).toBeNull();
    // A URL, a time, a sentence, or an empty side is not a label.
    expect(parseListLabel("http://example.com, read later")).toBeNull();
    expect(parseListLabel("meet at 10:30, bring the deck")).toBeNull();
    expect(parseListLabel("Remember to add eggs to groceries.")).toBeNull();
    expect(parseListLabel("todo list:")).toBeNull();
    expect(parseListLabel(": milk, eggs")).toBeNull();
    expect(parseListLabel("a label that runs on for far too many words: x, y")).toBeNull();
    // One sentence behind a colon is a sentence, and a generic word names nothing.
    expect(
      parseListLabel("project update: shipped offline capture. next step is sync tests")
    ).toBeNull();
    expect(parseListLabel("note: milk, eggs")).toBeNull();
    expect(parseListLabel("list: milk, eggs")).toBeNull();
    expect(parseListLabel("Meeting notes: discussed pricing, agreed on Tuesday")).toEqual({
      title: "Meeting notes",
      remainder: "discussed pricing, agreed on Tuesday"
    });
  });

  it("keeps the name out of the items", () => {
    expect(parseDeterministicListCapture("todo list, buy milk, call mom, fix the bike")).toEqual([
      "buy milk",
      "call mom",
      "fix the bike"
    ]);
    expect(parseDeterministicListCapture("Packing list\npassport\ncharger")).toEqual([
      "passport",
      "charger"
    ]);
    expect(parseDeterministicListCapture("todo list, water the plants")).toEqual([
      "water the plants"
    ]);
    expect(parseDeterministicListCapture("milk, eggs, bread")).toEqual(["milk", "eggs", "bread"]);
  });

  it("titles a new list note with the name the owner gave it", () => {
    const captureText = "todo list, buy milk, call mom";
    const modelPlan = OrganizationPlanSchema.parse({
      schemaVersion: 1,
      alternatives: [],
      captureKind: "list_items",
      decision: "create_note",
      destination: {
        candidateId: null,
        newNote: {
          noteType: "list",
          spaceCandidateId: null,
          title: "todo list, buy milk, call mom"
        }
      },
      generatedExpansion: null,
      operations: [{ type: "append_list_items", section: null, items: ["buy milk", "call mom"] }],
      reasonCodes: ["no_candidate_fit"]
    });
    const overridden = applyDeterministicExtractionOverride({
      captureText,
      inferredKind: "list_items",
      plan: modelPlan
    });
    expect(overridden.applied).toBe(true);
    expect(overridden.extraction).toMatchObject({ kind: "list_items", title: "Todo list" });
    expect(overridden.plan.destination.newNote?.title).toBe("Todo list");
    expect(overridden.plan.operations).toEqual([
      { type: "append_list_items", section: null, items: ["buy milk", "call mom"] }
    ]);
    expect(overridden.plan.reasonCodes).toContain("parser_override");

    // The title is the model's when it already is the name, and when the plan appends.
    const named = applyDeterministicExtractionOverride({
      captureText,
      inferredKind: "list_items",
      plan: OrganizationPlanSchema.parse({
        ...modelPlan,
        destination: {
          ...modelPlan.destination,
          newNote: { ...modelPlan.destination.newNote, title: "Todo list" }
        }
      })
    });
    expect(named.applied).toBe(false);
    const appended = applyDeterministicExtractionOverride({
      captureText,
      inferredKind: "list_items",
      plan: OrganizationPlanSchema.parse({
        ...modelPlan,
        decision: "append_to_note",
        destination: { candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV", newNote: null }
      })
    });
    expect(appended.applied).toBe(false);
    expect(appended.plan.destination.newNote).toBeNull();
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
