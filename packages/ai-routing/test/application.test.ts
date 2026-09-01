import {
  ListStructuredDataSchema,
  LogStructuredDataSchema,
  ProjectStructuredDataSchema,
  entityIdSchema,
  type EntityId,
  type EntityKind,
  type ModelOperation,
  type NoteLinkValue,
  type NoteType
} from "@unfiled/contracts";
import { createInitialNote, type EntityIdFactory, type Note } from "@unfiled/domain";
import { describe, expect, it } from "vitest";

import {
  OrganizationApplicationErrorCode,
  applyMaterializedOrganizationCommand,
  validateAndMaterializeOrganizationPlan,
  type MaterializedAppendOrganizationCommand,
  type MaterializedCreateOrganizationCommand,
  type OrganizationApplicationError,
  type OrganizationApplicationErrorCodeValue
} from "../src/index.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-09-01T12:02:03.000Z";
const OCCURRED_AT = "2026-09-01T12:03:04.000Z";

const IDS = Object.freeze({
  candidate: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  candidateNote: "note_01J6M9Q7G4BMKB33GSG3NJ6D20",
  relationCandidate: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
  relationNote: "note_01J6M9Q7G4BMKB33GSG3NJ6D21",
  createdNote: "note_01J6M9Q7G4BMKB33GSG3NJ6D22",
  decision: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  mutation: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  revision: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  fixtureRevision: "rev_01J6M9Q7G4BMKB33GSG3NJ6D2A",
  space: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  tag: "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  secondTag: "tag_01J6M9Q7G4BMKB33GSG3NJ6D22",
  existingItem: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  itemOne: "itm_01J6M9Q7G4BMKB33GSG3NJ6D23",
  itemTwo: "itm_01J6M9Q7G4BMKB33GSG3NJ6D24",
  itemThree: "itm_01J6M9Q7G4BMKB33GSG3NJ6D25",
  existingEntry: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  entryOne: "ent_01J6M9Q7G4BMKB33GSG3NJ6D23",
  entryTwo: "ent_01J6M9Q7G4BMKB33GSG3NJ6D24"
} as const);

type StructuralIdSequences = Readonly<{
  ent?: readonly EntityId<"ent">[];
  itm?: readonly EntityId<"itm">[];
}>;

function deterministicFactory(sequences: StructuralIdSequences = {}): EntityIdFactory {
  const offsets = new Map<EntityKind, number>();
  return <K extends EntityKind>(kind: K): EntityId<K> => {
    if (kind === "rev") return IDS.fixtureRevision as EntityId<K>;
    const values = kind === "itm" ? sequences.itm : kind === "ent" ? sequences.ent : undefined;
    const offset = offsets.get(kind) ?? 0;
    const value = values?.[offset];
    if (value === undefined) throw new Error(`No deterministic ${kind} fixture at ${offset}`);
    offsets.set(kind, offset + 1);
    return entityIdSchema(kind).parse(value);
  };
}

type NoteFixtureOptions = Readonly<{
  bodyMarkdown?: string;
  links?: readonly NoteLinkValue[];
  privacy?: "ai_assisted" | "private_manual";
  structuredData?: unknown;
  tagIds?: readonly EntityId<"tag">[];
}>;

function currentNote(type: NoteType, options: NoteFixtureOptions = {}): Note {
  const titles: Readonly<Record<NoteType, string>> = {
    generic: "Notes",
    list: "Shopping",
    log: "Workout",
    principle: "Principles",
    project: "Launch"
  };
  return createInitialNote({
    id: IDS.candidateNote,
    userId: OWNER_ID,
    title: titles[type],
    type,
    privacy: options.privacy ?? "ai_assisted",
    now: CREATED_AT,
    spaceId: IDS.space,
    ...(options.bodyMarkdown === undefined ? {} : { bodyMarkdown: options.bodyMarkdown }),
    ...(options.structuredData === undefined ? {} : { structuredData: options.structuredData }),
    ...(options.tagIds === undefined ? {} : { tagIds: options.tagIds }),
    ...(options.links === undefined ? {} : { links: options.links }),
    idFactory: deterministicFactory()
  }).note;
}

function candidateManifest(note?: Note) {
  return {
    schemaVersion: 1 as const,
    candidates: [
      ...(note === undefined
        ? []
        : [
            {
              candidateId: IDS.candidate,
              isOpen: true,
              noteId: note.id,
              revision: note.currentRevision,
              noteType: note.type
            }
          ]),
      {
        candidateId: IDS.relationCandidate,
        isOpen: true,
        noteId: IDS.relationNote,
        revision: 3,
        noteType: "generic" as const
      }
    ],
    controls: { expansionDisabled: false, explicitDestinationNoteId: null },
    authorizedSpaceIds: [IDS.space],
    authorizedTagIds: [IDS.tag, IDS.secondTag]
  };
}

function stableIds(createdNoteId: EntityId<"note"> | null = null) {
  return {
    decisionId: IDS.decision,
    createdNoteId,
    revisionId: IDS.revision,
    mutationId: IDS.mutation,
    reviewItemId: null,
    generatedBlockId: null
  };
}

function appendCommand(
  note: Note,
  operations: readonly ModelOperation[],
  captureKind: "freeform" | "list_items" | "log_entry" | "principle" | "project_update" = "freeform"
): MaterializedAppendOrganizationCommand {
  const command = validateAndMaterializeOrganizationPlan({
    unknownPlan: {
      schemaVersion: 1,
      captureKind,
      decision: "append_to_note",
      destination: { candidateId: IDS.candidate, newNote: null },
      operations,
      generatedExpansion: null,
      alternatives: [],
      reasonCodes: ["type_match"]
    },
    manifest: candidateManifest(note),
    stableIds: stableIds()
  });
  if (command.kind !== "append") throw new Error("Fixture did not materialize append");
  return command;
}

function createCommand(
  noteType: NoteType,
  operations: readonly ModelOperation[],
  title = "New note",
  captureKind: "freeform" | "list_items" | "log_entry" | "principle" | "project_update" = "freeform"
): MaterializedCreateOrganizationCommand {
  const command = validateAndMaterializeOrganizationPlan({
    unknownPlan: {
      schemaVersion: 1,
      captureKind,
      decision: "create_note",
      destination: {
        candidateId: null,
        newNote: { title, noteType, spaceCandidateId: IDS.space }
      },
      operations,
      generatedExpansion: null,
      alternatives: [],
      reasonCodes: ["no_candidate_fit"]
    },
    manifest: candidateManifest(),
    stableIds: stableIds(IDS.createdNote)
  });
  if (command.kind !== "create") throw new Error("Fixture did not materialize create");
  return command;
}

function expectCode(callback: () => unknown, code: OrganizationApplicationErrorCodeValue): void {
  expect(callback).toThrow(
    expect.objectContaining<Partial<OrganizationApplicationError>>({
      name: "OrganizationApplicationError",
      code
    })
  );
}

describe("deterministic organization application", () => {
  it("creates an authoritative AI-assisted note and preserves append_raw bytes exactly", () => {
    const capture = "  Keep\nthis exact source.  ";
    const command = createCommand(
      "principle",
      [{ type: "append_raw", content: capture }],
      "Roosevelt method",
      "principle"
    );

    const result = applyMaterializedOrganizationCommand({
      command,
      ownerId: OWNER_ID,
      captureText: capture,
      occurredAt: OCCURRED_AT,
      idFactory: deterministicFactory()
    });

    expect(result).toMatchObject({
      kind: "create",
      mutation: null,
      mutationId: IDS.mutation,
      insertedItemIds: [],
      note: {
        id: IDS.createdNote,
        userId: OWNER_ID,
        title: "Roosevelt method",
        bodyMarkdown: capture,
        privacy: "ai_assisted",
        currentRevision: 1,
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT
      },
      revision: {
        id: IDS.revision,
        noteId: IDS.createdNote,
        revision: 1,
        source: "organization",
        actor: "organizer",
        createdAt: OCCURRED_AT
      }
    });
    expect(result.noteContentPayload).toEqual({
      schemaVersion: 1,
      title: "Roosevelt method",
      bodyMarkdown: capture,
      structuredData: { schemaVersion: 1 }
    });
    expect(result.noteRevisionPayload).toEqual({
      schemaVersion: 1,
      snapshot: result.noteMutationPayload.afterSnapshot
    });
    expect(result.noteMutationPayload).toMatchObject({
      schemaVersion: 1,
      action: "create",
      beforeRevision: 0,
      afterRevision: 1,
      operations: [{ type: "create_note" }],
      inverse: { type: "soft_delete_created_note" },
      beforeSnapshot: null
    });
    expect(result.noteMutationPayload.afterSnapshot).toMatchObject({
      bodyMarkdown: capture,
      privacy: "ai_assisted"
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.noteMutationPayload.afterSnapshot)).toBe(true);
  });

  it("applies append_paragraphs through one undoable authoritative revision", () => {
    const before = currentNote("generic", { bodyMarkdown: "Existing source." });
    const capture = "First thought\n\nsecond thought";
    const command = appendCommand(before, [
      { type: "append_paragraphs", paragraphs: ["First thought", "second thought"] }
    ]);

    const result = applyMaterializedOrganizationCommand({
      command,
      ownerId: OWNER_ID,
      currentNote: before,
      captureText: capture,
      occurredAt: OCCURRED_AT,
      idFactory: deterministicFactory()
    });

    if (result.kind !== "append") throw new Error("Fixture did not apply append");
    expect(result.note.bodyMarkdown).toBe("Existing source.\n\nFirst thought\n\nsecond thought");
    expect(result.note.currentRevision).toBe(2);
    expect(result.note.updatedAt).toBe(OCCURRED_AT);
    expect(result.revision).toMatchObject({
      id: IDS.revision,
      source: "organization",
      actor: "organizer",
      revision: 2
    });
    expect(result.mutation).toMatchObject({
      id: IDS.mutation,
      noteId: before.id,
      beforeRevision: 1,
      afterRevision: 2,
      createdAt: OCCURRED_AT,
      undoneAt: null
    });
    expect(result.noteMutationPayload).toMatchObject({
      action: "update",
      beforeRevision: 1,
      afterRevision: 2,
      beforeSnapshot: { bodyMarkdown: "Existing source." },
      afterSnapshot: { bodyMarkdown: result.note.bodyMarkdown }
    });
    expect(result.noteMutationPayload.operations).toEqual([
      expect.objectContaining({ type: "restore_snapshot", bodyMarkdown: result.note.bodyMarkdown })
    ]);
    expect(result.noteMutationPayload.inverse).toEqual([
      expect.objectContaining({ type: "restore_snapshot", bodyMarkdown: "Existing source." })
    ]);
    expect(before.bodyMarkdown).toBe("Existing source.");
  });

  it("appends list items, tags, and a relation with retry-stable item IDs", () => {
    const before = currentNote("list", {
      structuredData: {
        schemaVersion: 1,
        items: [
          {
            id: IDS.existingItem,
            text: "milk",
            checked: false,
            ordinal: 0,
            section: null
          }
        ]
      },
      tagIds: [IDS.tag]
    });
    const command = appendCommand(
      before,
      [
        {
          type: "append_list_items",
          section: "Open items",
          items: ["eggs", "oats"]
        },
        { type: "add_tags", tagIds: [IDS.tag, IDS.secondTag] },
        {
          type: "add_relation",
          toCandidateId: IDS.relationCandidate,
          linkType: "related"
        }
      ],
      "list_items"
    );
    const apply = () =>
      applyMaterializedOrganizationCommand({
        command,
        ownerId: OWNER_ID,
        currentNote: before,
        captureText: "shopping: eggs and oats",
        occurredAt: OCCURRED_AT,
        idFactory: deterministicFactory({ itm: [IDS.itemOne, IDS.itemTwo] })
      });

    const first = apply();
    const retry = apply();
    expect(first).toEqual(retry);
    expect(first.note.bodyMarkdown).toBe("- [ ] milk\n\n## Open items\n\n- [ ] eggs\n- [ ] oats");
    expect(ListStructuredDataSchema.parse(first.note.structuredData).items).toEqual([
      {
        id: IDS.existingItem,
        text: "milk",
        checked: false,
        ordinal: 0,
        section: null
      },
      {
        id: IDS.itemOne,
        text: "eggs",
        checked: false,
        ordinal: 1,
        section: "Open items"
      },
      {
        id: IDS.itemTwo,
        text: "oats",
        checked: false,
        ordinal: 2,
        section: "Open items"
      }
    ]);
    expect(first.insertedItemIds).toEqual([IDS.itemOne, IDS.itemTwo]);
    expect(first.note.tagIds).toEqual([IDS.tag, IDS.secondTag]);
    expect(first.note.links).toEqual([{ toNoteId: IDS.relationNote, linkType: "related" }]);
  });

  it("creates a structured list without regenerating its stable item IDs", () => {
    const command = createCommand(
      "list",
      [{ type: "append_list_items", section: null, items: ["milk", "eggs"] }],
      "Shopping",
      "list_items"
    );

    const result = applyMaterializedOrganizationCommand({
      command,
      ownerId: OWNER_ID,
      captureText: "shopping: milk and eggs",
      occurredAt: OCCURRED_AT,
      idFactory: deterministicFactory({ itm: [IDS.itemOne, IDS.itemTwo] })
    });

    expect(result.note.bodyMarkdown).toBe("- [ ] milk\n- [ ] eggs");
    expect(ListStructuredDataSchema.parse(result.note.structuredData).items).toMatchObject([
      { id: IDS.itemOne, text: "milk" },
      { id: IDS.itemTwo, text: "eggs" }
    ]);
    expect(result.insertedItemIds).toEqual([IDS.itemOne, IDS.itemTwo]);
  });

  it("appends a log entry at the injected occurrence time with a retry-stable entry ID", () => {
    const before = currentNote("log", {
      structuredData: { schemaVersion: 1, entries: [] }
    });
    const command = appendCommand(
      before,
      [
        {
          type: "append_log_entry",
          entry: { exercise: "bench", load: 135, connector: "x", reps: 8 }
        }
      ],
      "log_entry"
    );

    const result = applyMaterializedOrganizationCommand({
      command,
      ownerId: OWNER_ID,
      currentNote: before,
      captureText: "bench 135 x 8",
      occurredAt: OCCURRED_AT,
      idFactory: deterministicFactory({ ent: [IDS.entryOne] })
    });

    const structured = LogStructuredDataSchema.parse(result.note.structuredData);
    expect(structured.entries).toEqual([
      {
        id: IDS.entryOne,
        occurredAt: OCCURRED_AT,
        fields: { exercise: "bench", load: 135, connector: "x", reps: 8 }
      }
    ]);
    expect(result.note.bodyMarkdown).toBe(
      `## ${OCCURRED_AT}\n\n- connector: x\n- exercise: bench\n- load: 135\n- reps: 8`
    );
    expect(result.insertedItemIds).toEqual([IDS.entryOne]);
  });

  it("applies additive list update_structured_data without accepting model IDs", () => {
    const before = currentNote("list", {
      structuredData: { schemaVersion: 1, items: [] }
    });
    const command = appendCommand(
      before,
      [
        {
          type: "update_structured_data",
          patch: { items: [{ text: "oats" }] }
        }
      ],
      "list_items"
    );

    const result = applyMaterializedOrganizationCommand({
      command,
      ownerId: OWNER_ID,
      currentNote: before,
      captureText: "oats",
      occurredAt: OCCURRED_AT,
      idFactory: deterministicFactory({ itm: [IDS.itemOne] })
    });

    expect(ListStructuredDataSchema.parse(result.note.structuredData).items).toEqual([
      {
        id: IDS.itemOne,
        text: "oats",
        checked: false,
        ordinal: 0,
        section: null
      }
    ]);
    expect(result.insertedItemIds).toEqual([IDS.itemOne]);
  });

  it("applies additive log update_structured_data using occurredAt for every new entry", () => {
    const before = currentNote("log", {
      structuredData: {
        schemaVersion: 1,
        entries: [
          {
            id: IDS.existingEntry,
            occurredAt: CREATED_AT,
            fields: { activity: "walk" }
          }
        ]
      }
    });
    const command = appendCommand(
      before,
      [
        {
          type: "update_structured_data",
          patch: {
            entries: [
              { fields: { activity: "run", distance: 5, unit: "km" } },
              { fields: { activity: "walk" } }
            ]
          }
        }
      ],
      "log_entry"
    );

    const result = applyMaterializedOrganizationCommand({
      command,
      ownerId: OWNER_ID,
      currentNote: before,
      captureText: "run 5 km walk",
      occurredAt: OCCURRED_AT,
      idFactory: deterministicFactory({ ent: [IDS.entryOne, IDS.entryTwo] })
    });

    expect(LogStructuredDataSchema.parse(result.note.structuredData).entries).toEqual([
      {
        id: IDS.existingEntry,
        occurredAt: CREATED_AT,
        fields: { activity: "walk" }
      },
      {
        id: IDS.entryOne,
        occurredAt: OCCURRED_AT,
        fields: { activity: "run", distance: 5, unit: "km" }
      },
      {
        id: IDS.entryTwo,
        occurredAt: OCCURRED_AT,
        fields: { activity: "walk" }
      }
    ]);
    expect(result.insertedItemIds).toEqual([IDS.entryOne, IDS.entryTwo]);
  });

  it("applies additive project update_structured_data while retaining prose", () => {
    const before = currentNote("project", {
      bodyMarkdown: "# Launch\n\nContext stays exact.",
      structuredData: { schemaVersion: 1, checklistItems: [] }
    });
    const command = appendCommand(
      before,
      [
        {
          type: "update_structured_data",
          patch: { checklistItems: [{ text: "ship beta" }] }
        }
      ],
      "project_update"
    );

    const result = applyMaterializedOrganizationCommand({
      command,
      ownerId: OWNER_ID,
      currentNote: before,
      captureText: "ship beta",
      occurredAt: OCCURRED_AT,
      idFactory: deterministicFactory({ itm: [IDS.itemOne] })
    });

    expect(result.note.bodyMarkdown).toBe("# Launch\n\nContext stays exact.\n\n- [ ] ship beta");
    expect(ProjectStructuredDataSchema.parse(result.note.structuredData).checklistItems).toEqual([
      {
        id: IDS.itemOne,
        text: "ship beta",
        checked: false,
        ordinal: 0,
        lineIndex: 4
      }
    ]);
    expect(result.insertedItemIds).toEqual([IDS.itemOne]);
  });

  it("deduplicates metadata operations without creating structural IDs", () => {
    const before = currentNote("generic", {
      bodyMarkdown: "Existing",
      tagIds: [IDS.tag],
      links: [{ toNoteId: IDS.relationNote, linkType: "related" }]
    });
    const command = appendCommand(before, [
      { type: "append_raw", content: "source" },
      { type: "add_tags", tagIds: [IDS.tag] },
      {
        type: "add_relation",
        toCandidateId: IDS.relationCandidate,
        linkType: "related"
      }
    ]);

    const result = applyMaterializedOrganizationCommand({
      command,
      ownerId: OWNER_ID,
      currentNote: before,
      captureText: "source",
      occurredAt: OCCURRED_AT,
      idFactory: deterministicFactory()
    });

    expect(result.note.tagIds).toEqual([IDS.tag]);
    expect(result.note.links).toEqual([{ toNoteId: IDS.relationNote, linkType: "related" }]);
    expect(result.insertedItemIds).toEqual([]);
  });

  it("fails closed when append_raw is not valid for a structured canonical projection", () => {
    const before = currentNote("list", {
      structuredData: {
        schemaVersion: 1,
        items: [
          {
            id: IDS.existingItem,
            text: "milk",
            checked: false,
            ordinal: 0,
            section: null
          }
        ]
      }
    });
    const command = appendCommand(before, [{ type: "append_raw", content: "not list syntax" }]);

    expectCode(
      () =>
        applyMaterializedOrganizationCommand({
          command,
          ownerId: OWNER_ID,
          currentNote: before,
          captureText: "not list syntax",
          occurredAt: OCCURRED_AT,
          idFactory: deterministicFactory()
        }),
      OrganizationApplicationErrorCode.INVALID_OPERATION
    );
    expect(before.bodyMarkdown).toBe("- [ ] milk");
  });

  it("makes private_manual impossible on append and never reflects source in its error", () => {
    const assisted = currentNote("generic", { bodyMarkdown: "Existing" });
    const privateNote: Note = Object.freeze({ ...assisted, privacy: "private_manual" });
    const command = appendCommand(assisted, [{ type: "append_raw", content: "canary" }]);
    let thrown: unknown;

    try {
      applyMaterializedOrganizationCommand({
        command,
        ownerId: OWNER_ID,
        currentNote: privateNote,
        captureText: "canary",
        occurredAt: OCCURRED_AT,
        idFactory: deterministicFactory()
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: OrganizationApplicationErrorCode.PRIVATE_NOTE_FORBIDDEN
    });
    expect(String(thrown)).not.toContain("canary");
  });

  it("rejects stale, cross-owner, mismatched, closed, archived, and deleted notes", () => {
    const before = currentNote("generic", { bodyMarkdown: "Existing" });
    const command = appendCommand(before, [{ type: "append_raw", content: "source" }]);
    const invalidNotes: readonly Note[] = [
      Object.freeze({ ...before, userId: OTHER_OWNER_ID }),
      Object.freeze({ ...before, id: IDS.relationNote }),
      Object.freeze({ ...before, currentRevision: before.currentRevision + 1 }),
      Object.freeze({
        ...before,
        type: "principle",
        structuredData: { schemaVersion: 1 as const }
      }),
      Object.freeze({ ...before, isOpen: false }),
      Object.freeze({ ...before, archivedAt: OCCURRED_AT }),
      Object.freeze({ ...before, deletedAt: OCCURRED_AT })
    ];

    for (const invalidNote of invalidNotes) {
      expectCode(
        () =>
          applyMaterializedOrganizationCommand({
            command,
            ownerId: OWNER_ID,
            currentNote: invalidNote,
            captureText: "source",
            occurredAt: OCCURRED_AT,
            idFactory: deterministicFactory()
          }),
        OrganizationApplicationErrorCode.INVALID_NOTE_STATE
      );
    }
  });

  it("rechecks source preservation at application time with content-free errors", () => {
    const before = currentNote("generic");
    const command = appendCommand(before, [{ type: "append_raw", content: "model replacement" }]);
    const sourceCanary = "private-source-canary";
    let thrown: unknown;

    try {
      applyMaterializedOrganizationCommand({
        command,
        ownerId: OWNER_ID,
        currentNote: before,
        captureText: sourceCanary,
        occurredAt: OCCURRED_AT,
        idFactory: deterministicFactory()
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: OrganizationApplicationErrorCode.SOURCE_PRESERVATION_FAILED
    });
    expect(String(thrown)).not.toContain(sourceCanary);
    expect(String(thrown)).not.toContain("model replacement");
  });

  it("rejects destructive, unknown, and model-ID structured patches", () => {
    const before = currentNote("list", {
      structuredData: { schemaVersion: 1, items: [] }
    });
    const cases: readonly Readonly<{ capture: string; patch: Record<string, unknown> }>[] = [
      { capture: "oats", patch: { delete: "oats" } },
      { capture: "oats oats", patch: { items: [{ text: "oats", remove: "oats" }] } },
      {
        capture: `oats ${IDS.itemOne}`,
        patch: { items: [{ text: "oats", id: IDS.itemOne }] }
      }
    ];

    for (const testCase of cases) {
      const command = appendCommand(
        before,
        [{ type: "update_structured_data", patch: testCase.patch }],
        "list_items"
      );
      expectCode(
        () =>
          applyMaterializedOrganizationCommand({
            command,
            ownerId: OWNER_ID,
            currentNote: before,
            captureText: testCase.capture,
            occurredAt: OCCURRED_AT,
            idFactory: deterministicFactory({ itm: [IDS.itemOne] })
          }),
        OrganizationApplicationErrorCode.INVALID_OPERATION
      );
    }
  });

  it("rejects wrong-kind, duplicate, and existing structural IDs from the injected factory", () => {
    const before = currentNote("list", {
      structuredData: {
        schemaVersion: 1,
        items: [
          {
            id: IDS.existingItem,
            text: "milk",
            checked: false,
            ordinal: 0,
            section: null
          }
        ]
      }
    });
    const command = appendCommand(
      before,
      [{ type: "append_list_items", section: null, items: ["eggs", "oats"] }],
      "list_items"
    );
    const wrongKind = deterministicFactory({
      itm: [IDS.entryOne as unknown as EntityId<"itm">, IDS.itemTwo]
    });
    const duplicate = deterministicFactory({ itm: [IDS.itemOne, IDS.itemOne] });
    const collision = deterministicFactory({ itm: [IDS.existingItem, IDS.itemTwo] });

    for (const idFactory of [wrongKind, duplicate, collision]) {
      expectCode(
        () =>
          applyMaterializedOrganizationCommand({
            command,
            ownerId: OWNER_ID,
            currentNote: before,
            captureText: "shopping: eggs and oats",
            occurredAt: OCCURRED_AT,
            idFactory
          }),
        OrganizationApplicationErrorCode.INVALID_ID_FACTORY
      );
    }
  });

  it("validates capture, owner, timestamp, and output size without leaking input", () => {
    const before = currentNote("generic");
    const command = appendCommand(before, [{ type: "append_raw", content: "source" }]);
    const invalidInputs = [
      { captureText: "   ", ownerId: OWNER_ID, occurredAt: OCCURRED_AT },
      { captureText: "source", ownerId: "owner with spaces", occurredAt: OCCURRED_AT },
      { captureText: "source", ownerId: OWNER_ID, occurredAt: "not-a-timestamp" }
    ] as const;

    for (const invalid of invalidInputs) {
      expectCode(
        () =>
          applyMaterializedOrganizationCommand({
            command,
            currentNote: before,
            idFactory: deterministicFactory(),
            ...invalid
          }),
        OrganizationApplicationErrorCode.INVALID_COMMAND
      );
    }

    const full = currentNote("generic", { bodyMarkdown: "x".repeat(200_000) });
    const fullCommand = appendCommand(full, [{ type: "append_raw", content: "source" }]);
    expectCode(
      () =>
        applyMaterializedOrganizationCommand({
          command: fullCommand,
          ownerId: OWNER_ID,
          currentNote: full,
          captureText: "source",
          occurredAt: OCCURRED_AT,
          idFactory: deterministicFactory()
        }),
      OrganizationApplicationErrorCode.INVALID_OPERATION
    );
  });
});
