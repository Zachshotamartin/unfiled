import { describe, expect, it } from "vitest";

import { ReviewPayloadSchema } from "../src/index.js";
import { IDS } from "./harness.js";

const reviewPlan = Object.freeze({
  schemaVersion: 1 as const,
  captureKind: "freeform" as const,
  decision: "needs_review" as const,
  destination: { candidateId: null, newNote: null },
  operations: [{ type: "append_raw" as const, content: "Write this down" }],
  generatedExpansion: null,
  alternatives: [],
  reasonCodes: ["ambiguous_intent" as const]
});

describe("Review payload v2", () => {
  it("preserves a typed routing proposal while continuing to read v1", () => {
    expect(
      ReviewPayloadSchema.parse({
        schemaVersion: 2,
        proposal: { type: "route_capture", plan: reviewPlan },
        state: "open",
        resolution: null
      })
    ).toEqual({
      schemaVersion: 2,
      proposal: { type: "route_capture", plan: reviewPlan },
      state: "open",
      resolution: null
    });
    expect(
      ReviewPayloadSchema.parse({
        schemaVersion: 1,
        choices: [{ noteId: IDS.note }],
        state: "open",
        resolution: null
      })
    ).toMatchObject({ schemaVersion: 1, state: "open" });
  });

  it.each([
    {
      name: "open with a resolution",
      value: {
        schemaVersion: 2,
        proposal: { type: "conflict", reason: "revision" },
        state: "open",
        resolution: { type: "keep_inbox" }
      }
    },
    {
      name: "resolved without a resolution",
      value: {
        schemaVersion: 2,
        proposal: { type: "conflict", reason: "revision" },
        state: "resolved",
        resolution: null
      }
    },
    {
      name: "resolved using dismiss",
      value: {
        schemaVersion: 2,
        proposal: { type: "conflict", reason: "revision" },
        state: "resolved",
        resolution: { type: "dismiss" }
      }
    },
    {
      name: "dismissed without dismiss",
      value: {
        schemaVersion: 2,
        proposal: { type: "generated_block", blockId: IDS.block },
        state: "dismissed",
        resolution: { type: "reject_expansion" }
      }
    }
  ])("rejects $name", ({ value }) => {
    expect(ReviewPayloadSchema.safeParse(value).success).toBe(false);
  });

  it("rejects untyped or over-specified v2 proposal data", () => {
    expect(
      ReviewPayloadSchema.safeParse({
        schemaVersion: 2,
        proposal: { type: "conflict", reason: "revision", choices: [] },
        state: "open",
        resolution: null
      }).success
    ).toBe(false);
  });
});
