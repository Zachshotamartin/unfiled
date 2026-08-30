import {
  ApiErrorCode,
  ListStructuredDataSchema,
  LogStructuredDataSchema,
  ProjectStructuredDataSchema,
  type EntityId,
  type InteractiveOperationsRequest,
  type MutationResult,
  type MutationUndoRequest,
  type NoteCreateRequest,
  type NoteDto,
  type NoteType,
  type NoteUpdateRequest
} from "@unfiled/contracts";

import { canonicalJson } from "./canonical.js";
import { renderLogMarkdown } from "./structured/log.js";

type ExpectedStructure =
  | Readonly<{ kind: "plain" }>
  | Readonly<{
      items: readonly Readonly<{
        checked: boolean;
        ordinal: number;
        section: string | null;
        text: string;
      }>[];
      kind: "list";
    }>
  | Readonly<{
      entries: readonly Readonly<{ fields: Readonly<Record<string, string | number | null>> }>[];
      kind: "log";
    }>
  | Readonly<{
      items: readonly Readonly<{
        checked: boolean;
        lineIndex: number;
        ordinal: number;
        text: string;
      }>[];
      kind: "project";
    }>;

export type ManualNoteCreationFixture = Readonly<{
  expected: Readonly<{
    bodyMarkdown: string | null;
    isOpen: boolean;
    structure: ExpectedStructure;
  }>;
  name: string;
  request: NoteCreateRequest;
}>;

export const manualNoteCreationFixtures = [
  {
    name: "generic",
    request: {
      idempotencyKey: "parity-create-generic",
      title: "Inbox thought",
      type: "generic",
      privacy: "private_manual",
      bodyMarkdown: "A loose thought with #tags and [[links]].",
      spaceId: null,
      tagIds: [],
      links: []
    },
    expected: {
      bodyMarkdown: "A loose thought with #tags and [[links]].",
      isOpen: true,
      structure: { kind: "plain" }
    }
  },
  {
    name: "principle",
    request: {
      idempotencyKey: "parity-create-principle",
      title: "Roosevelt method",
      type: "principle",
      privacy: "ai_assisted",
      bodyMarkdown: "Commit first, then learn what the promise requires.",
      spaceId: null,
      tagIds: [],
      links: []
    },
    expected: {
      bodyMarkdown: "Commit first, then learn what the promise requires.",
      isOpen: true,
      structure: { kind: "plain" }
    }
  },
  {
    name: "list",
    request: {
      idempotencyKey: "parity-create-list",
      title: "Shopping",
      type: "list",
      privacy: "ai_assisted",
      bodyMarkdown: "  ### Market  \n\n* milk\n+ [X] eggs",
      spaceId: null,
      tagIds: [],
      links: []
    },
    expected: {
      bodyMarkdown: "## Market\n\n- [ ] milk\n\n## Completed\n\n## Market\n\n- [x] eggs",
      isOpen: true,
      structure: {
        kind: "list",
        items: [
          { text: "milk", checked: false, ordinal: 0, section: "Market" },
          { text: "eggs", checked: true, ordinal: 1, section: "Market" }
        ]
      }
    }
  },
  {
    name: "log",
    request: {
      idempotencyKey: "parity-create-log",
      title: "Workout",
      type: "log",
      privacy: "ai_assisted",
      bodyMarkdown: "5 km",
      spaceId: null,
      tagIds: [],
      links: []
    },
    expected: {
      bodyMarkdown: null,
      isOpen: true,
      structure: { kind: "log", entries: [{ fields: { text: "5 km" } }] }
    }
  },
  {
    name: "project",
    request: {
      idempotencyKey: "parity-create-project",
      title: "Launch",
      type: "project",
      privacy: "ai_assisted",
      bodyMarkdown: "# Launch\n\nContext stays.\n  * [ ] Ship homepage  ",
      spaceId: null,
      tagIds: [],
      links: []
    },
    expected: {
      bodyMarkdown: "# Launch\n\nContext stays.\n  * [ ] Ship homepage  ",
      isOpen: true,
      structure: {
        kind: "project",
        items: [{ text: "Ship homepage", checked: false, ordinal: 0, lineIndex: 3 }]
      }
    }
  }
] as const satisfies readonly ManualNoteCreationFixture[];

export const structuredMarkdownParityFixtures = {
  list: {
    replacement: "## Market\n\n- renamed milk\n- [x] eggs",
    canonical: "## Market\n\n- [ ] renamed milk\n\n## Completed\n\n## Market\n\n- [x] eggs",
    conflicts: ["- milk\nplain prose", "- duplicate\n- DUPLICATE"]
  },
  log: {
    conflicts: ["plain prose", "- reps: 8", "## 2026-08-30T18:30:00.000Z\n- reps: 8\n- reps: 9"]
  },
  project: {
    replacement: "# Launch\n\nContext stays.\n  * [ ] Ship polished homepage",
    canonical: "# Launch\n\nContext stays.\n  * [ ] Ship polished homepage"
  }
} as const;

export const manualNoteTransitionFixture = {
  atomicPatch: {
    expectedRevision: 1,
    idempotencyKey: "parity-atomic-patch",
    title: "Filed thought",
    bodyMarkdown: "Saved atomically with its destination.",
    privacy: "private_manual" as const
  },
  laterPatch: {
    expectedRevision: 2,
    idempotencyKey: "parity-later-patch",
    title: "Later title"
  },
  stalePatch: {
    expectedRevision: 3,
    idempotencyKey: "parity-stale-patch",
    title: "Must not win"
  },
  undo: { expectedRevision: 3, idempotencyKey: "parity-undo-latest" }
} as const;

export interface ManualNoteParityDriver {
  readonly spaceId: EntityId<"spc">;
  applyInteractive(
    noteId: EntityId<"note">,
    input: InteractiveOperationsRequest
  ): Promise<MutationResult>;
  create(input: NoteCreateRequest): Promise<MutationResult>;
  errorCode(error: unknown): string | undefined;
  get(noteId: EntityId<"note">): Promise<NoteDto>;
  patch(noteId: EntityId<"note">, input: NoteUpdateRequest): Promise<MutationResult>;
  undo(mutationId: EntityId<"mut">, input: MutationUndoRequest): Promise<MutationResult>;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Manual-note parity failed: ${message}`);
}

function same(actual: unknown, expected: unknown, message: string): void {
  invariant(canonicalJson(actual) === canonicalJson(expected), message);
}

function required<T>(value: T | undefined, message: string): T {
  invariant(value !== undefined, message);
  return value;
}

function assertCreation(fixture: ManualNoteCreationFixture, result: MutationResult): void {
  const { note } = result;
  invariant(!result.replayed, `${fixture.name} create was unexpectedly replayed`);
  invariant(result.undo.eligible, `${fixture.name} create did not offer its soft-delete inverse`);
  invariant(note.type === fixture.request.type, `${fixture.name} type changed`);
  invariant(note.title === fixture.request.title.trim(), `${fixture.name} title changed`);
  invariant(note.currentRevision === 1, `${fixture.name} did not start at revision 1`);
  invariant(note.isOpen === fixture.expected.isOpen, `${fixture.name} open state changed`);
  if (fixture.expected.bodyMarkdown !== null) {
    invariant(
      note.bodyMarkdown === fixture.expected.bodyMarkdown,
      `${fixture.name} Markdown bytes differ`
    );
  }

  const expected = fixture.expected.structure;
  switch (expected.kind) {
    case "plain":
      same(note.structuredData, { schemaVersion: 1 }, `${fixture.name} plain structure differs`);
      break;
    case "list": {
      const data = ListStructuredDataSchema.parse(note.structuredData);
      same(
        data.items.map(({ checked, ordinal, section, text }) => ({
          checked,
          ordinal,
          section,
          text
        })),
        expected.items,
        "list creation structure differs"
      );
      break;
    }
    case "log": {
      const data = LogStructuredDataSchema.parse(note.structuredData);
      same(
        data.entries.map(({ fields }) => ({ fields })),
        expected.entries,
        "log creation structure differs"
      );
      invariant(note.bodyMarkdown === renderLogMarkdown(data), "log creation is not canonical");
      break;
    }
    case "project": {
      const data = ProjectStructuredDataSchema.parse(note.structuredData);
      same(
        data.checklistItems.map(({ checked, lineIndex, ordinal, text }) => ({
          checked,
          lineIndex,
          ordinal,
          text
        })),
        expected.items,
        "project creation structure differs"
      );
      break;
    }
  }
}

async function expectFailure(
  driver: ManualNoteParityDriver,
  code: string,
  operation: () => Promise<unknown>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    invariant(
      driver.errorCode(error) === code,
      `expected ${code}, received ${driver.errorCode(error)}`
    );
    return;
  }
  throw new Error(`Manual-note parity failed: expected ${code}, but the write succeeded`);
}

async function reconcileList(
  driver: ManualNoteParityDriver,
  created: MutationResult
): Promise<void> {
  const before = ListStructuredDataSchema.parse(created.note.structuredData);
  const replaced = await driver.patch(created.note.id, {
    expectedRevision: 1,
    idempotencyKey: "parity-list-reconcile",
    bodyMarkdown: structuredMarkdownParityFixtures.list.replacement
  });
  const after = ListStructuredDataSchema.parse(replaced.note.structuredData);
  same(
    after.items.map(({ id }) => id),
    before.items.map(({ id }) => id),
    "list item IDs did not survive text/checkbox reconciliation"
  );
  invariant(
    replaced.note.bodyMarkdown === structuredMarkdownParityFixtures.list.canonical,
    "list canonical projection differs"
  );
  const first = required(after.items[0], "list fixture lost its first item");
  const second = required(after.items[1], "list fixture lost its second item");
  const closed = await driver.applyInteractive(replaced.note.id, {
    expectedRevision: 2,
    idempotencyKey: "parity-list-close",
    operations: [{ type: "toggle_item_checked", itemId: first.id, checked: true }]
  });
  invariant(!closed.note.isOpen, "fully checked list stayed open");
  const reopened = await driver.applyInteractive(replaced.note.id, {
    expectedRevision: 3,
    idempotencyKey: "parity-list-reopen",
    operations: [{ type: "toggle_item_checked", itemId: second.id, checked: false }]
  });
  invariant(reopened.note.isOpen, "reopened list stayed closed");
}

async function reconcileProject(
  driver: ManualNoteParityDriver,
  created: MutationResult
): Promise<void> {
  const before = ProjectStructuredDataSchema.parse(created.note.structuredData);
  const replaced = await driver.patch(created.note.id, {
    expectedRevision: 1,
    idempotencyKey: "parity-project-reconcile",
    bodyMarkdown: structuredMarkdownParityFixtures.project.replacement
  });
  const after = ProjectStructuredDataSchema.parse(replaced.note.structuredData);
  invariant(after.checklistItems[0]?.id === before.checklistItems[0]?.id, "project ID changed");
  invariant(
    replaced.note.bodyMarkdown === structuredMarkdownParityFixtures.project.canonical,
    "project Markdown bytes changed"
  );
  const item = required(after.checklistItems[0], "project fixture lost its checklist item");
  const closed = await driver.applyInteractive(replaced.note.id, {
    expectedRevision: 2,
    idempotencyKey: "parity-project-close",
    operations: [{ type: "toggle_item_checked", itemId: item.id, checked: true }]
  });
  invariant(!closed.note.isOpen, "fully checked project stayed open");
  const reopened = await driver.applyInteractive(replaced.note.id, {
    expectedRevision: 3,
    idempotencyKey: "parity-project-reopen",
    operations: [{ type: "toggle_item_checked", itemId: item.id, checked: false }]
  });
  invariant(reopened.note.isOpen, "reopened project stayed closed");
}

async function reconcileLog(
  driver: ManualNoteParityDriver,
  created: MutationResult
): Promise<void> {
  const before = LogStructuredDataSchema.parse(created.note.structuredData);
  const entry = required(before.entries[0], "log fixture lost its initial entry");
  const replacement = [
    `## ${entry.occurredAt}`,
    "",
    "- text: 10 km",
    "- distance: 10",
    "",
    `## ${entry.occurredAt}`,
    "",
    "- text: cooldown"
  ].join("\n");
  const replaced = await driver.patch(created.note.id, {
    expectedRevision: 1,
    idempotencyKey: "parity-log-reconcile",
    bodyMarkdown: replacement
  });
  const after = LogStructuredDataSchema.parse(replaced.note.structuredData);
  invariant(after.entries.length === 2, "same-time log entries were collapsed");
  invariant(after.entries[0]?.id === entry.id, "first same-time log entry lost its ID");
  invariant(
    replaced.note.bodyMarkdown === renderLogMarkdown(after),
    "log projection is not canonical"
  );
  const roundTrip = await driver.patch(replaced.note.id, {
    expectedRevision: 2,
    idempotencyKey: "parity-log-round-trip",
    bodyMarkdown: replaced.note.bodyMarkdown
  });
  const roundTripData = LogStructuredDataSchema.parse(roundTrip.note.structuredData);
  same(
    roundTripData.entries.map(({ id }) => id),
    after.entries.map(({ id }) => id),
    "same-time log IDs changed on canonical round-trip"
  );
}

async function runLifecycle(
  driver: ManualNoteParityDriver,
  created: MutationResult
): Promise<void> {
  const atomicRequest: NoteUpdateRequest = {
    ...manualNoteTransitionFixture.atomicPatch,
    spaceId: driver.spaceId
  };
  const atomic = await driver.patch(created.note.id, atomicRequest);
  invariant(atomic.note.currentRevision === 2, "atomic PATCH did not produce revision 2");
  invariant(atomic.note.spaceId === driver.spaceId, "atomic PATCH lost its space move");
  invariant(atomic.note.title === atomicRequest.title, "atomic PATCH lost its title");
  invariant(atomic.note.bodyMarkdown === atomicRequest.bodyMarkdown, "atomic PATCH lost its body");

  const later = await driver.patch(created.note.id, manualNoteTransitionFixture.laterPatch);
  invariant(later.note.currentRevision === 3, "intervening PATCH did not produce revision 3");
  const replay = await driver.patch(created.note.id, atomicRequest);
  invariant(replay.replayed, "old idempotency key was not reported as replayed");
  invariant(
    replay.note.currentRevision === 2,
    "old-key replay did not return the original receipt"
  );
  invariant(replay.note.title === atomicRequest.title, "old-key replay returned current state");
  const current = await driver.get(created.note.id);
  invariant(current.currentRevision === 3, "old-key replay mutated current state");
  invariant(
    current.title === manualNoteTransitionFixture.laterPatch.title,
    "old-key replay rewound state"
  );

  const undone = await driver.undo(later.mutationId, manualNoteTransitionFixture.undo);
  invariant(undone.note.currentRevision === 4, "undo did not append a new revision");
  invariant(
    undone.note.title === atomicRequest.title,
    "undo did not restore the full snapshot title"
  );
  invariant(
    undone.note.bodyMarkdown === atomicRequest.bodyMarkdown,
    "undo did not restore the body"
  );
  invariant(undone.note.spaceId === driver.spaceId, "undo did not restore the destination space");
  invariant(undone.note.privacy === atomicRequest.privacy, "undo did not restore privacy");

  await expectFailure(driver, ApiErrorCode.STALE_REVISION, () =>
    driver.patch(created.note.id, manualNoteTransitionFixture.stalePatch)
  );
  const afterStale = await driver.get(created.note.id);
  invariant(afterStale.currentRevision === 4, "stale write changed the revision");
  invariant(afterStale.title === atomicRequest.title, "stale write changed saved state");
}

async function runCreationUndo(
  driver: ManualNoteParityDriver,
  created: MutationResult
): Promise<void> {
  const deleted = await driver.undo(created.mutationId, {
    expectedRevision: 1,
    idempotencyKey: "parity-undo-create"
  });
  invariant(deleted.note.currentRevision === 2, "creation undo did not append revision 2");
  invariant(deleted.note.deletedAt !== null, "creation undo did not soft-delete the note");
  invariant(deleted.revision.source === "undo", "creation undo lost source attribution");

  const restored = await driver.undo(deleted.mutationId, {
    expectedRevision: 2,
    idempotencyKey: "parity-undo-create-undo"
  });
  invariant(restored.note.currentRevision === 3, "undo-of-creation-undo did not append revision 3");
  invariant(restored.note.deletedAt === null, "undo-of-creation-undo did not restore the note");
  invariant(restored.revision.source === "undo", "undo-of-undo lost source attribution");
}

export async function runManualNoteRepositoryParity(driver: ManualNoteParityDriver): Promise<void> {
  const created: Partial<Record<NoteType, MutationResult>> = {};
  for (const fixture of manualNoteCreationFixtures) {
    const result = await driver.create(fixture.request);
    assertCreation(fixture, result);
    created[fixture.request.type] = result;
  }
  await reconcileList(driver, required(created.list, "list fixture was not created"));
  await reconcileLog(driver, required(created.log, "log fixture was not created"));
  await reconcileProject(driver, required(created.project, "project fixture was not created"));
  await runCreationUndo(driver, required(created.principle, "principle fixture was not created"));
  await runLifecycle(driver, required(created.generic, "generic fixture was not created"));
}
