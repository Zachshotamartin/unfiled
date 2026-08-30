import { describe, expect, it } from "vitest";

import { DeterministicOrganizationModel, type OrganizationCandidate } from "../src/index.js";

describe("deterministic organization model", () => {
  it("returns the same plan for the same fixture input", async () => {
    const model = new DeterministicOrganizationModel();
    const input = {
      captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const,
      text: "shopping: milk and batteries",
      inferredKind: "list_items" as const,
      candidates: [
        {
          candidateId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as const,
          title: "Shopping",
          type: "list" as const,
          spacePath: "Shopping",
          isOpen: true,
          ageBucket: "today" as const,
          headings: ["Open items"],
          latestSnippet: "eggs"
        }
      ]
    };

    await expect(model.plan(input)).resolves.toEqual(await model.plan(input));
  });

  it("never sees private candidate content because candidates carry bounded metadata only", async () => {
    const model = new DeterministicOrganizationModel();
    const result = await model.plan({
      captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      text: "private thought",
      inferredKind: "freeform",
      candidates: []
    });

    expect(JSON.stringify(result)).not.toContain("bodyMarkdown");
    expect(result.decision).toBe("add_to_inbox");
  });

  it("routes ambiguous content with bounded destination alternatives to Review", async () => {
    const model = new DeterministicOrganizationModel();
    const candidates = [
      {
        candidateId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
        title: "Ideas",
        type: "generic" as const,
        spacePath: "Personal",
        isOpen: true,
        ageBucket: "week" as const,
        headings: [],
        latestSnippet: "A related thought"
      },
      {
        candidateId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
        title: "Principles",
        type: "principle" as const,
        spacePath: "Personal",
        isOpen: true,
        ageBucket: "older" as const,
        headings: [],
        latestSnippet: "Make commitments visible"
      },
      {
        candidateId: "note_01J6M9Q7G4BMKB33GSG3NJ6D20",
        title: "Archive",
        type: "generic" as const,
        spacePath: "Archive",
        isOpen: false,
        ageBucket: "older" as const,
        headings: [],
        latestSnippet: "Old material"
      }
    ] satisfies readonly OrganizationCandidate[];

    const result = await model.plan({
      captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      text: "Roosevelt method: commit first, then find the path",
      inferredKind: "principle",
      candidates
    });

    expect(result.decision).toBe("needs_review");
    expect(result.alternatives).toEqual(
      candidates.slice(0, 2).map(({ candidateId }) => candidateId)
    );
  });
});
