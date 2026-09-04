import { OrganizationPlanSchema } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildDeterministicRoutingRulePlan,
  createDeterministicFirstOrganizerPlanner,
  inferOrganizerCaptureKind,
  proposedNoteIdForJob,
  namedDestinationPhrases,
  resolveDeterministicDestination,
  unavailableProductionPlanner,
  type OrganizerPlanner
} from "../src/planner.js";
import { ORGANIZER_PROMPT_VERSION } from "../src/prompt.js";

/** A planner double for a capture that carries no photos: nothing may ask it to read one. */
function unusedDescribe(): OrganizerPlanner["describe"] {
  return vi.fn().mockRejectedValue(new Error("this capture has no photos to describe"));
}

const RULE_ID = "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE" as const;
const RULE_NOTE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const;
const RULE_CANDIDATE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const;
const RULE_SPACE_ID = "spc_01ARZ3NDEKTSV4RRFFQ69G5FAF" as const;

const noteRuleControls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: Object.freeze({
    destinationId: RULE_NOTE_ID,
    destinationKind: "note" as const,
    matched: true as const,
    priority: 500,
    ruleId: RULE_ID,
    ruleRevision: 3
  })
});

const spaceRuleControls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: Object.freeze({
    destinationId: RULE_SPACE_ID,
    destinationKind: "space" as const,
    matched: true as const,
    priority: 500,
    ruleId: RULE_ID,
    ruleRevision: 3
  })
});

const ruleCandidate = Object.freeze({
  archivedAt: null,
  candidateId: RULE_CANDIDATE_ID,
  dailyDate: null,
  deletedAt: null,
  isOpen: true,
  noteId: RULE_NOTE_ID,
  noteType: "generic" as const,
  spaceId: null
});

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
          controls: {
            expansionDisabled: false,
            explicitDestinationNoteId: null,
            ruleMatch: null
          },
          rawContent: "content"
        },
        candidates: [],
        captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        controls: {
          expansionDisabled: false,
          explicitDestinationNoteId: null,
          ruleMatch: null
        },
        promptVersion: ORGANIZER_PROMPT_VERSION,
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
          controls: {
            expansionDisabled: false,
            explicitDestinationNoteId: null,
            ruleMatch: null
          },
          rawContent: "Remember to add eggs to groceries."
        }
      })
    ).toEqual({
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      source: "exact_title_phrase"
    });
  });

  it("reads the destination from the owner's directions before the capture's words", () => {
    const controls = { expansionDisabled: false, explicitDestinationNoteId: null, ruleMatch: null };
    const workout = {
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const,
      isOpen: true,
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const,
      title: "Workout log"
    };
    const groceries = {
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAD" as const,
      isOpen: true,
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC" as const,
      title: "Groceries"
    };
    // Directions phrase the note freely: a possessive, an article, "the note called".
    for (const guidance of [
      "put this in my workout log",
      "add to Workout Log",
      "file under the note called workout log",
      "this belongs in the workout log note"
    ]) {
      expect(
        resolveDeterministicDestination({
          candidates: [workout, groceries],
          capture: {
            controls,
            rawContent: "Bench 4x8 at 185, incline 3x10 at 70, dips to failure",
            guidance
          }
        }),
        guidance
      ).toEqual({ candidateId: workout.candidateId, source: "exact_title_phrase" });
    }
    // Directions outrank a destination the capture's own words name.
    expect(
      resolveDeterministicDestination({
        candidates: [workout, groceries],
        capture: {
          controls,
          rawContent: "add eggs to groceries",
          guidance: "put this in my workout log"
        }
      })
    ).toEqual({ candidateId: workout.candidateId, source: "exact_title_phrase" });
    // Directions that name no note leave the capture's own words to speak.
    expect(
      resolveDeterministicDestination({
        candidates: [workout, groceries],
        capture: { controls, rawContent: "add eggs to groceries", guidance: "keep it short" }
      })
    ).toEqual({ candidateId: groceries.candidateId, source: "exact_title_phrase" });
    // A name is exact: "workout" alone is not the Workout log.
    expect(
      resolveDeterministicDestination({
        candidates: [workout, groceries],
        capture: { controls, rawContent: "Bench 4x8", guidance: "put this in workout" }
      })
    ).toBeNull();
    expect(
      namedDestinationPhrases({
        rawContent: "add eggs to groceries",
        guidance: "put this in my workout log"
      })
    ).toEqual(["my workout log", "workout log", "groceries"]);
  });

  it("reads past the owner's possessive to the note's title", () => {
    const todo = {
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const,
      isOpen: true,
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const,
      title: "Todo list"
    };
    const controls = { expansionDisabled: false, explicitDestinationNoteId: null, ruleMatch: null };
    expect(
      resolveDeterministicDestination({
        candidates: [todo],
        capture: { controls, rawContent: "add call the dentist to my todo list" }
      })
    ).toEqual({ candidateId: todo.candidateId, source: "exact_title_phrase" });
    // A title that carries the possessive itself still matches its own phrase.
    expect(
      resolveDeterministicDestination({
        candidates: [{ ...todo, title: "My list" }],
        capture: { controls, rawContent: "put this in my list" }
      })
    ).toBeNull();
    expect(
      resolveDeterministicDestination({
        candidates: [{ ...todo, title: "My list" }],
        capture: { controls, rawContent: "add this to my list" }
      })
    ).toEqual({ candidateId: todo.candidateId, source: "exact_title_phrase" });
    // Both "My list" and "List" open is ambiguous, as it always was.
    expect(
      resolveDeterministicDestination({
        candidates: [
          { ...todo, title: "My list" },
          {
            ...todo,
            candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAD",
            noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC",
            title: "List"
          }
        ],
        capture: { controls, rawContent: "add this to my list" }
      })
    ).toBeNull();
  });

  it("rejects ambiguous duplicate titles and ineligible title matches", () => {
    const capture = {
      controls: {
        expansionDisabled: false,
        explicitDestinationNoteId: null,
        ruleMatch: null
      },
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
            explicitDestinationNoteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC",
            ruleMatch: null
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
    const controls = {
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      ruleMatch: null
    } as const;
    const provider = {
      describe: unusedDescribe(),
      plan: vi.fn().mockRejectedValue(new Error("provider must not run"))
    };
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
      promptVersion: ORGANIZER_PROMPT_VERSION,
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
    const controls = {
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      ruleMatch: null
    } as const;
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
    const provider = {
      describe: unusedDescribe(),
      plan: vi.fn().mockResolvedValue({ provider: true })
    };
    const planner = createDeterministicFirstOrganizerPlanner(provider);
    const input = {
      capture,
      candidates: [journal],
      captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV" as const,
      controls,
      promptVersion: ORGANIZER_PROMPT_VERSION,
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

  it("builds a content-free matched-note append with fixed rule provenance", () => {
    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [ruleCandidate],
        captureText: "Keep this exact thought",
        clientTimezone: "America/Los_Angeles",
        controls: noteRuleControls,
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toMatchObject({
      captureKind: "freeform",
      decision: "append_to_note",
      destination: { candidateId: RULE_CANDIDATE_ID, newNote: null },
      generatedExpansion: null,
      operations: [{ content: "Keep this exact thought", type: "append_raw" }],
      reasonCodes: ["routing_rule_match"]
    });
  });

  it("routes the Roosevelt method to an eligible Principles note without a model call", () => {
    const captureText =
      "Roosevelt method: telling people that you can do it and then later figuring out how";
    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [{ ...ruleCandidate, noteType: "principle" }],
        captureText,
        clientTimezone: "America/Los_Angeles",
        controls: noteRuleControls,
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toMatchObject({
      captureKind: "principle",
      decision: "append_to_note",
      destination: { candidateId: RULE_CANDIDATE_ID, newNote: null },
      operations: [{ content: captureText, type: "append_raw" }],
      reasonCodes: ["routing_rule_match"]
    });
  });

  it("allows raw rule appends only to generic, principle, and project notes", () => {
    const input = {
      candidates: [ruleCandidate],
      captureText: "Keep this exact thought",
      clientTimezone: "UTC",
      controls: noteRuleControls,
      occurredAt: "2026-09-01T01:30:00.000Z"
    } as const;

    for (const noteType of ["generic", "principle", "project"] as const) {
      expect(
        buildDeterministicRoutingRulePlan({
          ...input,
          candidates: [{ ...ruleCandidate, noteType }]
        })
      ).not.toBeNull();
    }
    for (const noteType of ["list", "log"] as const) {
      expect(
        buildDeterministicRoutingRulePlan({
          ...input,
          candidates: [{ ...ruleCandidate, noteType }]
        })
      ).toBeNull();
    }
  });

  it("creates exact daily titles in an authorized matched space with no candidate", () => {
    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [],
        captureText: "add milk and eggs",
        clientTimezone: "America/Los_Angeles",
        controls: spaceRuleControls,
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toMatchObject({
      captureKind: "list_items",
      decision: "create_note",
      destination: {
        candidateId: null,
        newNote: {
          noteType: "list",
          spaceCandidateId: RULE_SPACE_ID,
          title: "Daily list / 2026-08-31"
        }
      },
      reasonCodes: ["routing_rule_match"]
    });
  });

  it.each([
    ["Keep this thought exactly", "generic"],
    ["Principle: reduce friction before adding motivation", "principle"],
    ["Project update: shipped the safer routing contract", "project"]
  ] as const)("creates a %s capture as a %s note in its matched space", (captureText, noteType) => {
    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [],
        captureText,
        clientTimezone: "America/Los_Angeles",
        controls: spaceRuleControls,
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toMatchObject({
      captureKind:
        noteType === "generic" ? "freeform" : noteType === "project" ? "project_update" : noteType,
      decision: "create_note",
      destination: {
        candidateId: null,
        newNote: {
          noteType,
          spaceCandidateId: RULE_SPACE_ID,
          title: captureText
        }
      },
      operations: [{ content: captureText, type: "append_raw" }],
      reasonCodes: ["routing_rule_match"]
    });
  });

  it("appends to the one compatible same-day note in a matched space", () => {
    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [
          {
            ...ruleCandidate,
            dailyDate: "2026-08-31",
            noteType: "log",
            spaceId: RULE_SPACE_ID
          }
        ],
        captureText: "workout: 135 lb x 8",
        clientTimezone: "America/Los_Angeles",
        controls: spaceRuleControls,
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toMatchObject({
      captureKind: "log_entry",
      decision: "append_to_note",
      operations: [{ entry: { raw: "135 lb x 8" }, type: "append_log_entry" }],
      reasonCodes: ["routing_rule_match"]
    });
  });

  it("routes daily lists and logs independently inside the same matched space", () => {
    const dailyList = {
      ...ruleCandidate,
      dailyDate: "2026-08-31",
      noteType: "list" as const,
      spaceId: RULE_SPACE_ID
    };
    const dailyLog = {
      ...ruleCandidate,
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAD" as const,
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC" as const,
      dailyDate: "2026-08-31",
      noteType: "log" as const,
      spaceId: RULE_SPACE_ID
    };

    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [dailyList, dailyLog],
        captureText: "add milk and eggs",
        clientTimezone: "America/Los_Angeles",
        controls: spaceRuleControls,
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toMatchObject({
      captureKind: "list_items",
      decision: "append_to_note",
      destination: { candidateId: dailyList.candidateId }
    });
    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [dailyList, dailyLog],
        captureText: "workout: 135 lb x 8",
        clientTimezone: "America/Los_Angeles",
        controls: spaceRuleControls,
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toMatchObject({
      captureKind: "log_entry",
      decision: "append_to_note",
      destination: { candidateId: dailyLog.candidateId }
    });
    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [dailyLog],
        captureText: "add milk and eggs",
        clientTimezone: "America/Los_Angeles",
        controls: spaceRuleControls,
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toMatchObject({ captureKind: "list_items", decision: "create_note" });
  });

  it("defers ambiguous, ineligible, incompatible, and invalid-date space routes", () => {
    const dailyList = {
      ...ruleCandidate,
      dailyDate: "2026-08-31",
      noteType: "list" as const,
      spaceId: RULE_SPACE_ID
    };
    const base = {
      candidates: [dailyList],
      captureText: "add milk and eggs",
      clientTimezone: "America/Los_Angeles",
      controls: spaceRuleControls,
      occurredAt: "2026-09-01T01:30:00.000Z"
    } as const;
    const second = {
      ...dailyList,
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAD" as const,
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC" as const
    };

    for (const input of [
      { ...base, candidates: [{ ...dailyList, isOpen: false }] },
      { ...base, candidates: [{ ...dailyList, archivedAt: "2026-08-31T20:00:00.000Z" }] },
      { ...base, candidates: [{ ...dailyList, dailyDate: "2026-08-30" }] },
      { ...base, candidates: [dailyList, second] },
      { ...base, clientTimezone: "Mars/Olympus" },
      { ...base, occurredAt: "not-an-instant" }
    ]) {
      expect(buildDeterministicRoutingRulePlan(input)).toBeNull();
    }
  });

  it("leaves an explicit destination in control when a stale rule snapshot is also present", () => {
    expect(
      buildDeterministicRoutingRulePlan({
        candidates: [ruleCandidate],
        captureText: "Keep this exact thought",
        clientTimezone: "UTC",
        controls: {
          ...noteRuleControls,
          explicitDestinationNoteId: RULE_NOTE_ID
        },
        occurredAt: "2026-09-01T01:30:00.000Z"
      })
    ).toBeNull();
  });
});
