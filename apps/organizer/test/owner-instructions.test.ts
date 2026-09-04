import { describe, expect, it } from "vitest";

import { prepareProviderDisclosure } from "../src/planner-disclosure.js";
import type { PlannerInput } from "../src/planner.js";
import { ORGANIZER_PROMPT_VERSION, ORGANIZER_ROUTING_PROMPT } from "../src/prompt.js";

const candidateId = "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const;
const noteId = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const;
const controls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: null
});

function plannerInput(capture: PlannerInput["capture"]): PlannerInput {
  return {
    capture,
    candidates: [
      {
        bodyMarkdown: "# Plumber\nCall about the kitchen tap.",
        candidateId,
        isOpen: true,
        noteId,
        noteType: "generic",
        revision: 2,
        structuredData: { schemaVersion: 1 },
        title: "Plumber"
      }
    ],
    captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    controls,
    promptVersion: ORGANIZER_PROMPT_VERSION,
    schemaVersion: 1,
    signal: new AbortController().signal
  };
}

// The owner's directions reach the planner as ownerInstructions, separate from the capture text,
// so the model can follow them without ever writing them into a note.
describe("owner instructions in the planner disclosure", () => {
  it("passes the owner's guidance beside the capture text", () => {
    const disclosure = prepareProviderDisclosure(
      plannerInput({
        controls,
        rawContent: "Ask about the tap",
        guidance: "file with the plumber note"
      }),
      null
    );
    const input = JSON.parse(disclosure.serialized) as {
      capture: { ownerInstructions: string | null; text: string };
    };
    expect(input.capture.text).toBe("Ask about the tap");
    expect(input.capture.ownerInstructions).toBe("file with the plumber note");
  });

  it("sends null when the owner gave no directions", () => {
    const disclosure = prepareProviderDisclosure(
      plannerInput({ controls, rawContent: "Ask about the tap" }),
      null
    );
    const input = JSON.parse(disclosure.serialized) as {
      capture: { ownerInstructions: string | null };
    };
    expect(input.capture.ownerInstructions).toBeNull();
  });

  it("tells the model that directions are not content", () => {
    expect(ORGANIZER_ROUTING_PROMPT).toContain("capture.ownerInstructions");
    expect(ORGANIZER_ROUTING_PROMPT).toContain("never write them into a note");
  });
});
