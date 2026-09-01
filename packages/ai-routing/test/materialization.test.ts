import { describe, expect, it } from "vitest";

import {
  OrganizationMaterializationError,
  OrganizationMaterializationErrorCode,
  parseAuthorizedOrganizationPlan,
  type OrganizationMaterializationErrorCodeValue,
  validateAndMaterializeOrganizationPlan
} from "../src/index.js";

const IDS = Object.freeze({
  block: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  candidate: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  candidateNote: "note_01J6M9Q7G4BMKB33GSG3NJ6D20",
  relationCandidate: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
  relationNote: "note_01J6M9Q7G4BMKB33GSG3NJ6D21",
  createdNote: "note_01J6M9Q7G4BMKB33GSG3NJ6D22",
  decision: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  mutation: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  review: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  revision: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  space: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  tag: "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"
} as const);

const manifest = Object.freeze({
  schemaVersion: 1 as const,
  candidates: [
    {
      candidateId: IDS.candidate,
      isOpen: true,
      noteId: IDS.candidateNote,
      revision: 7,
      noteType: "list" as const
    },
    {
      candidateId: IDS.relationCandidate,
      isOpen: true,
      noteId: IDS.relationNote,
      revision: 3,
      noteType: "generic" as const
    }
  ],
  controls: {
    expansionDisabled: false,
    explicitDestinationNoteId: null
  },
  authorizedSpaceIds: [IDS.space],
  authorizedTagIds: [IDS.tag]
});

const appendPlan = Object.freeze({
  schemaVersion: 1 as const,
  captureKind: "list_items" as const,
  decision: "append_to_note" as const,
  destination: { candidateId: IDS.candidate, newNote: null },
  operations: [
    { type: "append_list_items" as const, section: "Open items", items: ["milk", "eggs"] },
    { type: "add_tags" as const, tagIds: [IDS.tag] },
    {
      type: "add_relation" as const,
      toCandidateId: IDS.relationCandidate,
      linkType: "related" as const
    }
  ],
  generatedExpansion: null,
  alternatives: [],
  reasonCodes: ["explicit_shopping_intent" as const, "type_match" as const]
});

function stableIds(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    decisionId: IDS.decision,
    createdNoteId: null,
    revisionId: IDS.revision,
    mutationId: IDS.mutation,
    reviewItemId: null,
    generatedBlockId: null,
    ...overrides
  };
}

function expectCode(
  callback: () => unknown,
  code: OrganizationMaterializationErrorCodeValue
): void {
  expect(callback).toThrow(
    expect.objectContaining<Partial<OrganizationMaterializationError>>({
      name: "OrganizationMaterializationError",
      code
    })
  );
}

describe("authorized organization plan materialization", () => {
  it("binds append destinations and relations to the authoritative manifest", () => {
    const command = validateAndMaterializeOrganizationPlan({
      unknownPlan: appendPlan,
      manifest,
      stableIds: stableIds()
    });

    expect(command).toMatchObject({
      kind: "append",
      decisionId: IDS.decision,
      candidateId: IDS.candidate,
      noteId: IDS.candidateNote,
      expectedRevision: 7,
      afterRevision: 8,
      noteType: "list",
      revisionId: IDS.revision,
      mutationId: IDS.mutation
    });
    if (command.kind !== "append") throw new Error("fixture did not append");
    expect(command.operations[2]).toEqual({
      type: "add_relation",
      toNoteId: IDS.relationNote,
      linkType: "related"
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.operations)).toBe(true);
    expect(command).toEqual(
      validateAndMaterializeOrganizationPlan({
        unknownPlan: appendPlan,
        manifest,
        stableIds: stableIds()
      })
    );
  });

  it("materializes create using only prepared stable IDs and authorized resources", () => {
    const command = validateAndMaterializeOrganizationPlan({
      unknownPlan: {
        schemaVersion: 1,
        captureKind: "principle",
        decision: "create_note",
        destination: {
          candidateId: null,
          newNote: {
            title: "Roosevelt method",
            noteType: "principle",
            spaceCandidateId: IDS.space
          }
        },
        operations: [{ type: "append_raw", content: "Commit first, then find the path." }],
        generatedExpansion: {
          kind: "label",
          text: "Commitment device"
        },
        alternatives: [],
        reasonCodes: ["no_candidate_fit"]
      },
      manifest,
      stableIds: stableIds({
        createdNoteId: IDS.createdNote,
        generatedBlockId: IDS.block
      })
    });

    expect(command).toMatchObject({
      kind: "create",
      noteId: IDS.createdNote,
      expectedRevision: 0,
      afterRevision: 1,
      title: "Roosevelt method",
      noteType: "principle",
      spaceId: IDS.space,
      generatedBlock: {
        blockId: IDS.block,
        kind: "label",
        text: "Commitment device"
      }
    });
  });

  it("materializes Review alternatives through the manifest and keeps Inbox content-effect free", () => {
    const review = validateAndMaterializeOrganizationPlan({
      unknownPlan: {
        ...appendPlan,
        decision: "needs_review",
        destination: { candidateId: null, newNote: null },
        operations: [{ type: "append_raw", content: "ambiguous" }],
        alternatives: [IDS.candidate, IDS.relationCandidate],
        reasonCodes: ["ambiguous_intent"]
      },
      manifest,
      stableIds: stableIds({ revisionId: null, mutationId: null, reviewItemId: IDS.review })
    });
    expect(review).toMatchObject({
      kind: "review",
      disposition: "needs_review",
      reviewItemId: IDS.review,
      alternatives: [
        { candidateId: IDS.candidate, noteId: IDS.candidateNote, revision: 7 },
        { candidateId: IDS.relationCandidate, noteId: IDS.relationNote, revision: 3 }
      ]
    });

    const inbox = validateAndMaterializeOrganizationPlan({
      unknownPlan: {
        ...appendPlan,
        decision: "add_to_inbox",
        destination: { candidateId: null, newNote: null },
        operations: [{ type: "append_raw", content: "unfiled" }],
        alternatives: [],
        reasonCodes: ["no_candidate_fit"]
      },
      manifest,
      stableIds: stableIds({ revisionId: null, mutationId: null })
    });
    expect(inbox).toMatchObject({
      kind: "review",
      disposition: "add_to_inbox",
      reviewItemId: null,
      alternatives: []
    });
  });

  it("rejects unknown fields before authorization without exposing source data", () => {
    const sourceCanary = "do-not-reflect-this-capture";
    let thrown: unknown;
    try {
      parseAuthorizedOrganizationPlan({
        unknownPlan: { ...appendPlan, sourceCanary },
        manifest
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: OrganizationMaterializationErrorCode.INVALID_PLAN });
    expect(String(thrown)).not.toContain(sourceCanary);
  });

  it("rejects non-JSON values, accessors, cycles, and forged prototypes before schema parsing", () => {
    let getterCalls = 0;
    const accessorPlan = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorPlan, "schemaVersion", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      }
    });
    const cyclic: Record<string, unknown> = { ...appendPlan };
    cyclic.loop = cyclic;
    let arrayGetterCalls = 0;
    const accessorOperations: unknown[] = [];
    Object.defineProperty(accessorOperations, 0, {
      enumerable: true,
      get() {
        arrayGetterCalls += 1;
        return { type: "append_raw", content: "unsafe" };
      }
    });

    for (const unknownPlan of [
      { ...appendPlan, operations: [{ type: "append_log_entry", entry: { weight: Number.NaN } }] },
      accessorPlan,
      { ...appendPlan, operations: accessorOperations },
      cyclic,
      Object.assign(Object.create({ inherited: true }) as object, appendPlan)
    ]) {
      expectCode(
        () => parseAuthorizedOrganizationPlan({ unknownPlan, manifest }),
        OrganizationMaterializationErrorCode.INVALID_PLAN
      );
    }
    expect(getterCalls).toBe(0);
    expect(arrayGetterCalls).toBe(0);
  });

  it("rejects invented destinations, alternatives, relations, spaces, and tags", () => {
    const inventedNote = "note_01J6M9Q7G4BMKB33GSG3NJ6D23";
    const inventedSpace = "spc_01J6M9Q7G4BMKB33GSG3NJ6D23";
    const inventedTag = "tag_01J6M9Q7G4BMKB33GSG3NJ6D23";
    const cases = [
      { ...appendPlan, destination: { candidateId: inventedNote, newNote: null } },
      { ...appendPlan, alternatives: [inventedNote] },
      {
        ...appendPlan,
        operations: [
          { type: "append_list_items", section: null, items: ["milk"] },
          { type: "add_relation", toCandidateId: inventedNote, linkType: "related" }
        ]
      },
      {
        ...appendPlan,
        decision: "create_note",
        destination: {
          candidateId: null,
          newNote: { title: "New", noteType: "generic", spaceCandidateId: inventedSpace }
        },
        operations: [{ type: "append_raw", content: "text" }]
      },
      {
        ...appendPlan,
        operations: [
          { type: "append_list_items", section: null, items: ["milk"] },
          { type: "add_tags", tagIds: [inventedTag] }
        ]
      }
    ];
    for (const plan of cases) {
      expectCode(
        () =>
          validateAndMaterializeOrganizationPlan({
            unknownPlan: plan,
            manifest,
            stableIds: stableIds({ createdNoteId: IDS.createdNote })
          }),
        OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE
      );
    }
  });

  it("rejects incompatible or non-content routed operations", () => {
    expectCode(
      () =>
        validateAndMaterializeOrganizationPlan({
          unknownPlan: {
            ...appendPlan,
            operations: [{ type: "append_log_entry", entry: { load: 135 } }]
          },
          manifest,
          stableIds: stableIds()
        }),
      OrganizationMaterializationErrorCode.INCOMPATIBLE_OPERATION
    );
    expectCode(
      () =>
        validateAndMaterializeOrganizationPlan({
          unknownPlan: {
            ...appendPlan,
            operations: [{ type: "add_tags", tagIds: [IDS.tag] }]
          },
          manifest,
          stableIds: stableIds()
        }),
      OrganizationMaterializationErrorCode.INVALID_DECISION
    );
  });

  it("binds open state and user routing controls before stable IDs are allocated", () => {
    expectCode(
      () =>
        parseAuthorizedOrganizationPlan({
          unknownPlan: appendPlan,
          manifest: {
            ...manifest,
            candidates: manifest.candidates.map((candidate) =>
              candidate.candidateId === IDS.candidate ? { ...candidate, isOpen: false } : candidate
            )
          }
        }),
      OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE
    );

    expectCode(
      () =>
        parseAuthorizedOrganizationPlan({
          unknownPlan: appendPlan,
          manifest: {
            ...manifest,
            controls: {
              expansionDisabled: false,
              explicitDestinationNoteId: IDS.relationNote
            }
          }
        }),
      OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE
    );

    expectCode(
      () =>
        parseAuthorizedOrganizationPlan({
          unknownPlan: {
            ...appendPlan,
            generatedExpansion: { kind: "label", text: "Do not generate this" }
          },
          manifest: {
            ...manifest,
            controls: { expansionDisabled: true, explicitDestinationNoteId: null }
          }
        }),
      OrganizationMaterializationErrorCode.INCOMPATIBLE_OPERATION
    );

    expect(
      parseAuthorizedOrganizationPlan({
        unknownPlan: {
          ...appendPlan,
          decision: "needs_review",
          destination: { candidateId: null, newNote: null },
          alternatives: [IDS.candidate],
          reasonCodes: ["ambiguous_intent"]
        },
        manifest: {
          ...manifest,
          controls: {
            expansionDisabled: true,
            explicitDestinationNoteId: IDS.candidateNote
          }
        }
      }).plan.decision
    ).toBe("needs_review");
  });

  it("rejects duplicate manifest capabilities and unused, missing, or malformed stable IDs", () => {
    expectCode(
      () =>
        validateAndMaterializeOrganizationPlan({
          unknownPlan: appendPlan,
          manifest: { ...manifest, authorizedTagIds: [IDS.tag, IDS.tag] },
          stableIds: stableIds()
        }),
      OrganizationMaterializationErrorCode.INVALID_MANIFEST
    );
    for (const ids of [
      stableIds({ revisionId: null }),
      stableIds({ reviewItemId: IDS.review }),
      { ...stableIds(), extra: true }
    ]) {
      expect(() =>
        validateAndMaterializeOrganizationPlan({
          unknownPlan: appendPlan,
          manifest,
          stableIds: ids
        })
      ).toThrow(OrganizationMaterializationError);
    }

    expectCode(
      () =>
        validateAndMaterializeOrganizationPlan({
          unknownPlan: {
            ...appendPlan,
            decision: "create_note",
            destination: {
              candidateId: null,
              newNote: { title: "Collision", noteType: "list", spaceCandidateId: null }
            }
          },
          manifest,
          stableIds: stableIds({ createdNoteId: IDS.candidateNote })
        }),
      OrganizationMaterializationErrorCode.INVALID_STABLE_ID_BINDING
    );
  });

  it("rejects contradictory decisions and duplicate alternatives or reason codes", () => {
    for (const unknownPlan of [
      { ...appendPlan, destination: { candidateId: null, newNote: null } },
      { ...appendPlan, alternatives: [IDS.relationCandidate, IDS.relationCandidate] },
      { ...appendPlan, reasonCodes: ["type_match", "type_match"] },
      {
        ...appendPlan,
        decision: "add_to_inbox",
        destination: { candidateId: null, newNote: null },
        alternatives: [IDS.candidate]
      }
    ]) {
      expectCode(
        () =>
          validateAndMaterializeOrganizationPlan({
            unknownPlan,
            manifest,
            stableIds: stableIds({ revisionId: null, mutationId: null })
          }),
        OrganizationMaterializationErrorCode.INVALID_DECISION
      );
    }
  });
});
