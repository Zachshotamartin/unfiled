import { OrganizationPlanSchema } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDeterministicFirstOrganizerPlanner,
  inferOrganizerCaptureKind,
  proposedNoteIdForJob,
  resolveDeterministicDestination,
  unavailableProductionPlanner
} from "../src/planner.js";

describe("app-specific planning wrappers", () => {
  it("derives a replay-stable note proposal for database authorization", () => {
    expect(proposedNoteIdForJob("job_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(
      "note_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    );
  });
  it.each(["job_bad", "ijob_01ARZ3NDEKTSV4RRFFQ69G5FAV", "job_01ARZ3NDEKTSV4RRFFQ69G5FAI"])(
    "rejects invalid durable job id %s",
    (jobId) => expect(() => proposedNoteIdForJob(jobId)).toThrow("not ready")
  );
  it("keeps the production model fail closed until Milestone D", async () => {
    await expect(
      unavailableProductionPlanner.plan({
        capture: {
          controls: { expansionDisabled: false, explicitDestinationNoteId: null },
          rawContent: "content"
        },
        candidates: [],
        captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        controls: { expansionDisabled: false, explicitDestinationNoteId: null },
        promptVersion: "routing-v1",
        schemaVersion: 1,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("not ready");
  });

  it.each([
    ["Roosevelt method: tell people you can do it, then figure out how", "principle"],
    ["Simplicity compounds", "principle"],
    ["Rest is part of progress", "principle"],
    ["I had a meeting today about product simplicity", "freeform"],
    ["Project update: shipped the onboarding flow", "project_update"],
    ["135 lb x 8", "log_entry"]
  ] as const)("infers %s as %s", (capture, expected) => {
    expect(inferOrganizerCaptureKind(capture)).toBe(expected);
  });

  it("resolves an exact normalized destination phrase", () => {
    expect(
      resolveDeterministicDestination({
        candidates: [
          {
            candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB",
            isOpen: true,
            noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA",
            title: "  GROCERIES  "
          }
        ],
        capture: {
          controls: { expansionDisabled: false, explicitDestinationNoteId: null },
          rawContent: "Remember to add eggs to groceries."
        }
      })
    ).toEqual({
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      source: "exact_title_phrase"
    });
  });

  it("rejects ambiguous duplicate titles and ineligible title matches", () => {
    const capture = {
      controls: { expansionDisabled: false, explicitDestinationNoteId: null },
      rawContent: "add eggs to groceries"
    } as const;
    const groceries = {
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const,
      isOpen: true,
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const,
      title: "Groceries"
    };
    expect(
      resolveDeterministicDestination({
        candidates: [
          groceries,
          {
            ...groceries,
            candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAD",
            noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC",
            title: " groceries "
          }
        ],
        capture
      })
    ).toBeNull();
    expect(
      resolveDeterministicDestination({
        candidates: [{ ...groceries, isOpen: false }],
        capture
      })
    ).toBeNull();
  });

  it("gives an eligible explicit target precedence over a title phrase", () => {
    expect(
      resolveDeterministicDestination({
        candidates: [
          {
            candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB",
            isOpen: true,
            noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA",
            title: "Groceries"
          },
          {
            candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAD",
            isOpen: true,
            noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC",
            title: "Work"
          }
        ],
        capture: {
          controls: {
            expansionDisabled: false,
            explicitDestinationNoteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC"
          },
          rawContent: "add eggs to groceries"
        }
      })
    ).toEqual({
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAD",
      source: "explicit_control"
    });
  });

  it("short-circuits the provider with a schema-valid, source-preserving list plan", async () => {
    const controls = { expansionDisabled: false, explicitDestinationNoteId: null } as const;
    const provider = { plan: vi.fn().mockRejectedValue(new Error("provider must not run")) };
    const result = await createDeterministicFirstOrganizerPlanner(provider).plan({
      capture: { controls, rawContent: "add eggs to groceries" },
      candidates: [
        {
          bodyMarkdown: "# Groceries",
          candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB",
          isOpen: true,
          noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA",
          noteType: "list",
          revision: 2,
          structuredData: { items: [], schemaVersion: 1 },
          title: "Groceries"
        }
      ],
      captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      controls,
      promptVersion: "routing-v1",
      schemaVersion: 1,
      signal: new AbortController().signal
    });

    expect(provider.plan).not.toHaveBeenCalled();
    expect(OrganizationPlanSchema.parse(result)).toMatchObject({
      captureKind: "list_items",
      decision: "append_to_note",
      destination: { candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB", newNote: null },
      operations: [{ items: ["eggs"], section: null, type: "append_list_items" }],
      reasonCodes: ["explicit_destination", "type_match"]
    });
  });

  it("preserves exact raw bytes and falls through on a destination type mismatch", async () => {
    const controls = { expansionDisabled: false, explicitDestinationNoteId: null } as const;
    const capture = { controls, rawContent: "Keep this exact thought to Journal" } as const;
    const journal = {
      bodyMarkdown: "# Journal",
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const,
      isOpen: true,
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const,
      noteType: "generic" as const,
      revision: 2,
      structuredData: { schemaVersion: 1 },
      title: "Journal"
    };
    const provider = { plan: vi.fn().mockResolvedValue({ provider: true }) };
    const planner = createDeterministicFirstOrganizerPlanner(provider);
    const input = {
      capture,
      candidates: [journal],
      captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV" as const,
      controls,
      promptVersion: "routing-v1",
      schemaVersion: 1,
      signal: new AbortController().signal
    };

    await expect(planner.plan(input)).resolves.toMatchObject({
      operations: [{ content: capture.rawContent, type: "append_raw" }]
    });
    expect(provider.plan).not.toHaveBeenCalled();

    await expect(
      planner.plan({
        ...input,
        capture: { controls, rawContent: "add eggs to Journal" }
      })
    ).resolves.toEqual({ provider: true });
    expect(provider.plan).toHaveBeenCalledOnce();
  });
});
