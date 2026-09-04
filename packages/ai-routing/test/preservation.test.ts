import type { ModelOperation } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  SourcePreservationError,
  assertPlanSourcePreserved,
  inspectSourcePreservation
} from "../src/index.js";

describe("source preservation", () => {
  it("accepts one byte-exact raw copy and reports no source text", () => {
    const capture = "  Keep\nmy exact words  ";
    const result = inspectSourcePreservation(capture, [{ type: "append_raw", content: capture }]);

    expect(result).toEqual({
      preserved: true,
      method: "append_raw",
      captureTokenCount: 4,
      operationTokenCount: 4,
      matchedCaptureTokenCount: 4,
      novelOperationTokenCount: 0,
      coverage: 1
    });
    expect(JSON.stringify(result)).not.toContain("Keep");
  });

  it("accepts deterministic list and structured log extraction without routing scaffold", () => {
    expect(
      inspectSourcePreservation("shopping: milk and eggs", [
        { type: "append_list_items", section: "Open items", items: ["milk", "eggs"] }
      ])
    ).toMatchObject({ preserved: true, method: "ordered_extraction", coverage: 1 });
    expect(
      inspectSourcePreservation("add eggs to groceries", [
        { type: "append_list_items", section: null, items: ["eggs"] }
      ])
    ).toMatchObject({ preserved: true, coverage: 1 });
    expect(
      inspectSourcePreservation("bench 135 x 8", [
        {
          type: "append_log_entry",
          entry: { exercise: "bench", load: 135, connector: "x", reps: 8 }
        }
      ])
    ).toMatchObject({ preserved: true, novelOperationTokenCount: 0 });
  });

  it("rejects rewrites, reordering, invented values, duplicated body content, and omissions", () => {
    const cases: readonly Readonly<{ capture: string; operations: readonly ModelOperation[] }>[] = [
      {
        capture: "bench 135 x 8",
        operations: [{ type: "append_log_entry", entry: { exercise: "bench", load: 155, reps: 8 } }]
      },
      {
        capture: "keep this source",
        operations: [
          { type: "append_raw", content: "keep this source" },
          { type: "append_paragraphs", paragraphs: ["invented claim"] }
        ]
      },
      {
        capture: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        operations: [
          {
            type: "append_paragraphs",
            paragraphs: ["alpha beta gamma delta epsilon zeta eta theta"]
          }
        ]
      },
      {
        capture: "alpha beta gamma",
        operations: [{ type: "append_paragraphs", paragraphs: ["gamma beta alpha"] }]
      },
      {
        capture: "Keep My punctuation!",
        operations: [{ type: "append_raw", content: "keep my punctuation" }]
      },
      {
        capture: "add",
        operations: [{ type: "add_tags", tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"] }]
      }
    ];

    for (const testCase of cases) {
      expect(inspectSourcePreservation(testCase.capture, testCase.operations).preserved).toBe(
        false
      );
      expect(() =>
        assertPlanSourcePreserved(testCase.capture, { operations: testCase.operations })
      ).toThrow(SourcePreservationError);
    }
  });

  it("requires complete ordered preservation rather than a ninety-percent overlap", () => {
    const result = inspectSourcePreservation(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa",
      [
        {
          type: "append_paragraphs",
          paragraphs: ["alpha beta gamma delta epsilon zeta eta theta iota"]
        }
      ]
    );
    expect(result).toMatchObject({ preserved: false, method: "none", coverage: 0.9 });
  });

  it("holds a capture with no owner words to writing nothing at all", () => {
    // A capture whose only content is an upload has no source to keep. Requiring the usual
    // content operation forced the client's "Photo" placeholder into the note; allowing any
    // operation would let the model supply words the owner never wrote.
    expect(inspectSourcePreservation("", [])).toEqual({
      preserved: true,
      method: "no_source",
      captureTokenCount: 0,
      operationTokenCount: 0,
      matchedCaptureTokenCount: 0,
      novelOperationTokenCount: 0,
      coverage: 1
    });
    expect(
      inspectSourcePreservation("", [{ type: "append_raw", content: "A tidy caption." }])
    ).toMatchObject({ preserved: false, method: "none", novelOperationTokenCount: 3, coverage: 0 });
    expect(() => assertPlanSourcePreserved("", { operations: [] })).not.toThrow();
    expect(() =>
      assertPlanSourcePreserved("", {
        operations: [{ type: "append_paragraphs", paragraphs: ["Invented."] }]
      })
    ).toThrow(SourcePreservationError);
  });

  it("accepts byte-exact paragraph splitting only when the separators are preserved", () => {
    expect(
      inspectSourcePreservation("First thought\n\nSecond thought", [
        { type: "append_paragraphs", paragraphs: ["First thought", "Second thought"] }
      ])
    ).toMatchObject({ preserved: true, method: "append_paragraphs", coverage: 1 });
    expect(
      inspectSourcePreservation("First thought\nSecond thought", [
        { type: "append_paragraphs", paragraphs: ["First thought", "Second thought"] }
      ]).preserved
    ).toBe(false);
  });
});
