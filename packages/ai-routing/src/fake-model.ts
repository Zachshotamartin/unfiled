import { OrganizationPlanSchema, type OrganizationPlan } from "@unfiled/contracts";

import type { OrganizationCandidate, OrganizationModel, OrganizationModelInput } from "./model.js";

function normalizedItems(text: string): string[] {
  const withoutPrefix = text.replace(/^shopping(?:\s+list)?\s*:\s*/iu, "");
  return withoutPrefix
    .split(/\s*(?:,|\band\b|\n)\s*/iu)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickCandidate(
  input: OrganizationModelInput,
  type: OrganizationCandidate["type"]
): OrganizationCandidate | undefined {
  return input.candidates.find((candidate) => candidate.type === type && candidate.isOpen);
}

export class DeterministicOrganizationModel implements OrganizationModel {
  public plan(input: OrganizationModelInput): Promise<OrganizationPlan> {
    if (input.inferredKind === "list_items") {
      const candidate = pickCandidate(input, "list");
      const items = normalizedItems(input.text);
      if (candidate && items.length > 0) {
        return Promise.resolve(
          OrganizationPlanSchema.parse({
            schemaVersion: 1,
            captureKind: "list_items",
            decision: "append_to_note",
            destination: { candidateId: candidate.candidateId, newNote: null },
            operations: [{ type: "append_list_items", section: "Open items", items }],
            generatedExpansion: null,
            alternatives: [],
            reasonCodes: ["explicit_shopping_intent", "type_match"]
          })
        );
      }
    }

    if (input.candidates.length === 0) {
      return Promise.resolve(
        OrganizationPlanSchema.parse({
          schemaVersion: 1,
          captureKind: input.inferredKind,
          decision: "add_to_inbox",
          destination: { candidateId: null, newNote: null },
          operations: [{ type: "append_raw", content: input.text }],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["no_candidate_fit"]
        })
      );
    }

    const alternatives = input.candidates.slice(0, 2).map(({ candidateId }) => candidateId);
    return Promise.resolve(
      OrganizationPlanSchema.parse({
        schemaVersion: 1,
        captureKind: input.inferredKind,
        decision: "needs_review",
        destination: { candidateId: null, newNote: null },
        operations: [{ type: "append_raw", content: input.text }],
        generatedExpansion: null,
        alternatives,
        reasonCodes: ["ambiguous_intent"]
      })
    );
  }
}
