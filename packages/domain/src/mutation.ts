import {
  ApiErrorCode,
  ListStructuredDataSchema,
  LogStructuredDataSchema,
  NoteLinkValueSchema,
  ProjectStructuredDataSchema,
  UserOperationSchema,
  UtcInstantSchema,
  entityIdSchema,
  type EntityId,
  type ListStructuredData,
  type LogStructuredData,
  type NoteLinkValue,
  type NoteSnapshot,
  type ProjectStructuredData,
  type RevisionSource,
  type UserOperation
} from "@unfiled/contracts";

import { deepFreeze } from "./canonical.js";
import { DomainError } from "./errors.js";
import { systemEntityIdFactory, type EntityIdFactory } from "./id-factory.js";
import { noteSnapshot, revisionFromNote, type Note, type NoteRevision } from "./note.js";
import { reconcileListMarkdown, renderListMarkdown } from "./structured/list.js";
import { reconcileLogMarkdown, renderLogMarkdown } from "./structured/log.js";
import { openStateForStructuredNote } from "./structured/defaults.js";
import { reconcileProjectChecklist, updateProjectChecklistLine } from "./structured/project.js";

export type NoteMutation = Readonly<{
  id: EntityId<"mut">;
  noteId: EntityId<"note">;
  beforeRevision: number;
  afterRevision: number;
  operations: readonly UserOperation[];
  inverse: readonly UserOperation[];
  beforeSnapshot: NoteSnapshot;
  afterSnapshot: NoteSnapshot;
  createdAt: string;
  undoneAt: string | null;
}>;

export type NoteMutationResult = Readonly<{
  note: Note;
  revision: NoteRevision;
  mutation: NoteMutation;
}>;

type MutableNote = { -readonly [Key in keyof Note]: Note[Key] };

function stale(expectedRevision: number, actualRevision: number): never {
  throw new DomainError(
    ApiErrorCode.STALE_REVISION,
    `Expected revision ${expectedRevision}, found ${actualRevision}`
  );
}

function structureConflict(message: string): never {
  throw new DomainError(ApiErrorCode.STRUCTURE_CONFLICT, message);
}

function snapshotOperation(snapshot: NoteSnapshot): UserOperation {
  return UserOperationSchema.parse({
    type: "restore_snapshot",
    spaceId: snapshot.spaceId,
    noteType: snapshot.type,
    title: snapshot.title,
    bodyMarkdown: snapshot.bodyMarkdown,
    structuredData: snapshot.structuredData,
    privacy: snapshot.privacy,
    isOpen: snapshot.isOpen,
    pinnedAt: snapshot.pinnedAt,
    archivedAt: snapshot.archivedAt,
    deletedAt: snapshot.deletedAt,
    tagIds: snapshot.tagIds,
    links: snapshot.links
  });
}

function listData(note: MutableNote): ListStructuredData {
  const parsed = ListStructuredDataSchema.safeParse(note.structuredData);
  if (!parsed.success) structureConflict("List note structure is invalid");
  return parsed.data;
}

function logData(note: MutableNote): LogStructuredData {
  const parsed = LogStructuredDataSchema.safeParse(note.structuredData);
  if (!parsed.success) structureConflict("Log note structure is invalid");
  return parsed.data;
}

function projectData(note: MutableNote): ProjectStructuredData {
  const parsed = ProjectStructuredDataSchema.safeParse(note.structuredData);
  if (!parsed.success) structureConflict("Project checklist structure is invalid");
  return parsed.data;
}

function applyBodyReplacement(
  note: MutableNote,
  markdown: string,
  idFactory: EntityIdFactory
): void {
  if (markdown.length > 200_000) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Note body exceeds 200,000 characters");
  }
  switch (note.type) {
    case "list": {
      const data = reconcileListMarkdown(listData(note), markdown, idFactory);
      note.structuredData = data;
      note.bodyMarkdown = renderListMarkdown(data);
      break;
    }
    case "log": {
      const data = reconcileLogMarkdown(logData(note), markdown, idFactory);
      note.structuredData = data;
      note.bodyMarkdown = renderLogMarkdown(data);
      break;
    }
    case "project": {
      const data = projectData(note);
      note.structuredData = ProjectStructuredDataSchema.parse({
        schemaVersion: 1,
        checklistItems: reconcileProjectChecklist(data.checklistItems, markdown, idFactory)
      });
      note.bodyMarkdown = markdown;
      break;
    }
    case "generic":
    case "principle":
      note.bodyMarkdown = markdown;
      break;
  }
}

function toggleItem(note: MutableNote, itemId: EntityId<"itm">, checked: boolean): void {
  if (note.type === "list") {
    const data = listData(note);
    if (!data.items.some(({ id }) => id === itemId)) structureConflict("List item was not found");
    note.structuredData = ListStructuredDataSchema.parse({
      ...data,
      items: data.items.map((item) => (item.id === itemId ? { ...item, checked } : item))
    });
    note.bodyMarkdown = renderListMarkdown(ListStructuredDataSchema.parse(note.structuredData));
    return;
  }
  if (note.type === "project") {
    const data = projectData(note);
    const item = data.checklistItems.find(({ id }) => id === itemId);
    if (!item) structureConflict("Project checklist item was not found");
    note.bodyMarkdown = updateProjectChecklistLine(note.bodyMarkdown, item, { checked });
    note.structuredData = ProjectStructuredDataSchema.parse({
      ...data,
      checklistItems: data.checklistItems.map((candidate) =>
        candidate.id === itemId ? { ...candidate, checked } : candidate
      )
    });
    return;
  }
  structureConflict("Only list and project notes contain checklist items");
}

function editItem(note: MutableNote, itemId: EntityId<"itm">, text: string): void {
  if (note.type === "list") {
    const data = listData(note);
    if (!data.items.some(({ id }) => id === itemId)) structureConflict("List item was not found");
    note.structuredData = ListStructuredDataSchema.parse({
      ...data,
      items: data.items.map((item) => (item.id === itemId ? { ...item, text } : item))
    });
    note.bodyMarkdown = renderListMarkdown(ListStructuredDataSchema.parse(note.structuredData));
    return;
  }
  if (note.type === "project") {
    const data = projectData(note);
    const item = data.checklistItems.find(({ id }) => id === itemId);
    if (!item) structureConflict("Project checklist item was not found");
    note.bodyMarkdown = updateProjectChecklistLine(note.bodyMarkdown, item, { text });
    note.structuredData = ProjectStructuredDataSchema.parse({
      ...data,
      checklistItems: data.checklistItems.map((candidate) =>
        candidate.id === itemId ? { ...candidate, text } : candidate
      )
    });
    return;
  }
  structureConflict("Only list and project notes contain editable items");
}

function removeItem(note: MutableNote, itemId: EntityId<"itm">, idFactory: EntityIdFactory): void {
  if (note.type === "list") {
    const data = listData(note);
    if (!data.items.some(({ id }) => id === itemId)) structureConflict("List item was not found");
    note.structuredData = ListStructuredDataSchema.parse({
      ...data,
      items: data.items
        .filter(({ id }) => id !== itemId)
        .map((item, ordinal) => ({ ...item, ordinal }))
    });
    note.bodyMarkdown = renderListMarkdown(ListStructuredDataSchema.parse(note.structuredData));
    return;
  }
  if (note.type === "project") {
    const data = projectData(note);
    const item = data.checklistItems.find(({ id }) => id === itemId);
    if (!item) structureConflict("Project checklist item was not found");
    note.bodyMarkdown = updateProjectChecklistLine(note.bodyMarkdown, item, { remove: true });
    note.structuredData = ProjectStructuredDataSchema.parse({
      schemaVersion: 1,
      checklistItems: reconcileProjectChecklist(
        data.checklistItems.filter(({ id }) => id !== itemId),
        note.bodyMarkdown,
        idFactory
      )
    });
    return;
  }
  structureConflict("Only list and project notes contain removable items");
}

function updateLogField(
  note: MutableNote,
  entryId: EntityId<"ent">,
  fieldPath: readonly string[],
  value: string | number | null
): void {
  if (note.type !== "log") structureConflict("Log fields can only update log notes");
  const field = fieldPath[0];
  if (fieldPath.length !== 1 || field === undefined) {
    structureConflict("Milestone B log fields are flat values");
  }
  const data = logData(note);
  if (!data.entries.some(({ id }) => id === entryId)) structureConflict("Log entry was not found");
  note.structuredData = LogStructuredDataSchema.parse({
    ...data,
    entries: data.entries.map((entry) =>
      entry.id === entryId ? { ...entry, fields: { ...entry.fields, [field]: value } } : entry
    )
  });
  note.bodyMarkdown = renderLogMarkdown(LogStructuredDataSchema.parse(note.structuredData));
}

function restoreSnapshot(
  note: MutableNote,
  operation: Extract<UserOperation, { type: "restore_snapshot" }>
): void {
  Object.assign(note, {
    spaceId: operation.spaceId,
    type: operation.noteType,
    title: operation.title,
    bodyMarkdown: operation.bodyMarkdown,
    structuredData: operation.structuredData,
    privacy: operation.privacy,
    isOpen: operation.isOpen,
    pinnedAt: operation.pinnedAt,
    archivedAt: operation.archivedAt,
    deletedAt: operation.deletedAt,
    tagIds: [...operation.tagIds],
    links: operation.links.map((link) => ({ ...link }))
  });
}

function applyOperation(
  note: MutableNote,
  operation: UserOperation,
  idFactory: EntityIdFactory
): void {
  switch (operation.type) {
    case "set_title":
      note.title = operation.title;
      break;
    case "replace_body_markdown":
      applyBodyReplacement(note, operation.bodyMarkdown, idFactory);
      break;
    case "set_privacy":
      note.privacy = operation.privacy;
      break;
    case "move_to_space":
      note.spaceId = operation.spaceId;
      break;
    case "set_archived":
      note.archivedAt = operation.archivedAt;
      break;
    case "set_deleted":
      note.deletedAt = operation.deletedAt;
      break;
    case "set_tags":
      note.tagIds = [...new Set(operation.tagIds)].map((id) => entityIdSchema("tag").parse(id));
      break;
    case "set_note_links": {
      const links = operation.links.map((link) => NoteLinkValueSchema.parse(link));
      if (links.some(({ toNoteId }) => toNoteId === note.id)) {
        structureConflict("A note cannot link to itself");
      }
      const identities = links.map(({ toNoteId, linkType }) => `${toNoteId}:${linkType}`);
      if (new Set(identities).size !== identities.length) structureConflict("Duplicate note link");
      note.links = links;
      break;
    }
    case "toggle_item_checked":
      toggleItem(note, operation.itemId, operation.checked);
      break;
    case "update_log_field":
      updateLogField(note, operation.entryId, operation.fieldPath, operation.value);
      break;
    case "edit_item_text":
      editItem(note, operation.itemId, operation.text);
      break;
    case "remove_item":
      removeItem(note, operation.itemId, idFactory);
      break;
    case "restore_snapshot":
      restoreSnapshot(note, operation);
      break;
  }
}

function defaultSource(operations: readonly UserOperation[]): RevisionSource {
  return operations.every(({ type }) =>
    ["toggle_item_checked", "update_log_field", "edit_item_text", "remove_item"].includes(type)
  )
    ? "interactive"
    : "manual";
}

export function applyNoteOperations(
  note: Note,
  input: Readonly<{
    expectedRevision: number;
    operations: readonly UserOperation[];
    now: string;
    idFactory?: EntityIdFactory;
    source?: RevisionSource;
    actor?: string;
  }>
): NoteMutationResult {
  if (note.currentRevision !== input.expectedRevision) {
    stale(input.expectedRevision, note.currentRevision);
  }
  const now = UtcInstantSchema.parse(input.now);
  const operations = input.operations.map((operation) => {
    const parsed = UserOperationSchema.safeParse(operation);
    if (!parsed.success) {
      throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "User operation is invalid");
    }
    return parsed.data;
  });
  if (operations.length === 0 || operations.length > 20) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "A mutation requires 1-20 operations");
  }
  const idFactory = input.idFactory ?? systemEntityIdFactory;
  const beforeSnapshot = noteSnapshot(note);
  const working: MutableNote = {
    ...note,
    structuredData: structuredClone(note.structuredData),
    tagIds: [...note.tagIds],
    links: note.links.map((link: NoteLinkValue) => ({ ...link }))
  };
  for (const operation of operations) applyOperation(working, operation, idFactory);
  working.isOpen = openStateForStructuredNote(working.type, working.structuredData, working.isOpen);

  const updated = deepFreeze({
    ...working,
    currentRevision: note.currentRevision + 1,
    updatedAt: now
  });
  const source = input.source ?? defaultSource(operations);
  const revision = revisionFromNote(updated, source, input.actor ?? `user:${source}`, idFactory);
  const afterSnapshot = noteSnapshot(updated);
  const mutation = deepFreeze({
    id: idFactory("mut"),
    noteId: note.id,
    beforeRevision: note.currentRevision,
    afterRevision: updated.currentRevision,
    operations,
    inverse: [snapshotOperation(beforeSnapshot)],
    beforeSnapshot,
    afterSnapshot,
    createdAt: now,
    undoneAt: null
  });
  return deepFreeze({ note: updated, revision, mutation });
}

type RevisionedTransition = Readonly<{
  expectedRevision: number;
  now: string;
  idFactory?: EntityIdFactory;
}>;

export function patchNote(
  note: Note,
  input: RevisionedTransition &
    Readonly<{
      title?: string;
      bodyMarkdown?: string;
      privacy?: Note["privacy"];
      spaceId?: EntityId<"spc"> | null;
      tagIds?: readonly EntityId<"tag">[];
      links?: readonly NoteLinkValue[];
    }>
): NoteMutationResult {
  const operations: UserOperation[] = [];
  if (input.title !== undefined) operations.push({ type: "set_title", title: input.title });
  if (input.bodyMarkdown !== undefined) {
    operations.push({ type: "replace_body_markdown", bodyMarkdown: input.bodyMarkdown });
  }
  if (input.privacy !== undefined) operations.push({ type: "set_privacy", privacy: input.privacy });
  if (input.spaceId !== undefined) {
    operations.push({ type: "move_to_space", spaceId: input.spaceId });
  }
  if (input.tagIds !== undefined) operations.push({ type: "set_tags", tagIds: [...input.tagIds] });
  if (input.links !== undefined) {
    operations.push({ type: "set_note_links", links: input.links.map((link) => ({ ...link })) });
  }
  return applyNoteOperations(note, { ...input, operations });
}

export function moveNote(
  note: Note,
  input: RevisionedTransition & Readonly<{ spaceId: EntityId<"spc"> | null }>
): NoteMutationResult {
  return applyNoteOperations(note, {
    ...input,
    operations: [{ type: "move_to_space", spaceId: input.spaceId }]
  });
}

export function archiveNote(
  note: Note,
  input: RevisionedTransition & Readonly<{ archived: boolean }>
): NoteMutationResult {
  return applyNoteOperations(note, {
    ...input,
    operations: [{ type: "set_archived", archivedAt: input.archived ? input.now : null }]
  });
}

export function softDeleteNote(note: Note, input: RevisionedTransition): NoteMutationResult {
  return applyNoteOperations(note, {
    ...input,
    operations: [{ type: "set_deleted", deletedAt: input.now }]
  });
}

export function restoreDeletedNote(note: Note, input: RevisionedTransition): NoteMutationResult {
  return applyNoteOperations(note, {
    ...input,
    operations: [{ type: "set_deleted", deletedAt: null }]
  });
}

export function restoreNoteRevision(
  note: Note,
  target: NoteRevision,
  input: RevisionedTransition
): NoteMutationResult {
  if (target.noteId !== note.id) structureConflict("Revision belongs to a different note");
  return applyNoteOperations(note, {
    ...input,
    actor: "user:restore",
    source: "manual",
    operations: [snapshotOperation(target)]
  });
}

export function undoNoteMutation(
  note: Note,
  mutation: NoteMutation,
  input: RevisionedTransition
): NoteMutationResult {
  if (
    mutation.noteId !== note.id ||
    mutation.afterRevision !== note.currentRevision ||
    input.expectedRevision !== note.currentRevision
  ) {
    stale(input.expectedRevision, note.currentRevision);
  }
  return applyNoteOperations(note, {
    ...input,
    source: "undo",
    actor: "user:undo",
    operations: [snapshotOperation(mutation.beforeSnapshot)]
  });
}
