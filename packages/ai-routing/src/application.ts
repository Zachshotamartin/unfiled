import {
  ListItemSchema,
  ListStructuredDataSchema,
  LogEntrySchema,
  LogStructuredDataSchema,
  ModelOperationSchema,
  NoteSchema,
  NoteSnapshotSchema,
  NoteTypeSchema,
  PrivacyModeSchema,
  ProjectChecklistItemSchema,
  ProjectStructuredDataSchema,
  UserOperationSchema,
  UtcInstantSchema,
  entityIdSchema,
  type EntityId,
  type EntityKind,
  type ModelOperation,
  type NoteSnapshot,
  type PrivacyMode,
  type UserOperation
} from "@unfiled/contracts";
import {
  DomainError,
  applyNoteOperations,
  createInitialNote,
  deepFreeze,
  defaultStructuredData,
  noteSnapshot,
  openStateForStructuredNote,
  reconcileListMarkdown,
  reconcileLogMarkdown,
  reconcileProjectChecklist,
  renderListMarkdown,
  renderLogMarkdown,
  revisionFromNote,
  type EntityIdFactory,
  type Note,
  type NoteMutation,
  type NoteRevision
} from "@unfiled/domain";
import { z } from "zod";

import type {
  MaterializedAppendOrganizationCommand,
  MaterializedCreateOrganizationCommand,
  MaterializedOrganizationOperation
} from "./materialization.js";
import { SourcePreservationError, assertPlanSourcePreserved } from "./preservation.js";

const MAX_CAPTURE_LENGTH = 10_000;
const MAX_NOTE_BODY_LENGTH = 200_000;
const MAX_STRUCTURED_PATCH_ITEMS = 50;
const COMPLETED_SECTION = /^completed$/iu;

const ResolvedRelationSchema = z.strictObject({
  type: z.literal("add_relation"),
  toNoteId: entityIdSchema("note"),
  linkType: z.enum(["reference", "related"])
});

const ListPatchItemSchema = ListItemSchema.pick({
  text: true,
  checked: true,
  section: true
})
  .partial({ checked: true, section: true })
  .superRefine((item, context) => {
    if (item.section !== undefined && item.section !== null && /[\r\n]/u.test(item.section)) {
      context.addIssue({ code: "custom", message: "List sections must be one line" });
    }
  });

const ListStructuredPatchSchema = z.strictObject({
  items: z.array(ListPatchItemSchema).min(1).max(MAX_STRUCTURED_PATCH_ITEMS)
});

const LogStructuredPatchSchema = z.strictObject({
  entries: z
    .array(z.strictObject({ fields: LogEntrySchema.shape.fields }))
    .min(1)
    .max(MAX_STRUCTURED_PATCH_ITEMS)
});

const ProjectPatchItemSchema = ProjectChecklistItemSchema.pick({
  text: true,
  checked: true
}).partial({ checked: true });

const ProjectStructuredPatchSchema = z.strictObject({
  checklistItems: z.array(ProjectPatchItemSchema).min(1).max(MAX_STRUCTURED_PATCH_ITEMS)
});

export const OrganizationApplicationErrorCode = Object.freeze({
  INVALID_COMMAND: "invalid_command",
  INVALID_ID_FACTORY: "invalid_id_factory",
  INVALID_NOTE_STATE: "invalid_note_state",
  INVALID_OPERATION: "invalid_operation",
  PRIVATE_NOTE_FORBIDDEN: "private_note_forbidden",
  SOURCE_PRESERVATION_FAILED: "source_preservation_failed"
} as const);

export type OrganizationApplicationErrorCodeValue =
  (typeof OrganizationApplicationErrorCode)[keyof typeof OrganizationApplicationErrorCode];

export class OrganizationApplicationError extends Error {
  public readonly code: OrganizationApplicationErrorCodeValue;

  public constructor(code: OrganizationApplicationErrorCodeValue) {
    super("The organization command could not be applied");
    this.name = "OrganizationApplicationError";
    this.code = code;
  }
}

type RoutedCommand = MaterializedAppendOrganizationCommand | MaterializedCreateOrganizationCommand;

export type ApplyMaterializedCreateOrganizationCommandInput = Readonly<{
  command: MaterializedCreateOrganizationCommand;
  captureText: string;
  currentNote?: never;
  idFactory: EntityIdFactory;
  occurredAt: string;
  ownerId: string;
  /**
   * Paragraphs the organizer places itself, such as a reference to a photo the owner
   * attached. They are applied after the model's operations and are deliberately excluded
   * from the operation cap and from source preservation: preservation exists to prove the
   * model kept the owner's words, and this text is not the model's.
   */
  attachmentParagraphs?: readonly string[] | undefined;
}>;

export type ApplyMaterializedAppendOrganizationCommandInput = Readonly<{
  command: MaterializedAppendOrganizationCommand;
  captureText: string;
  currentNote: Note;
  idFactory: EntityIdFactory;
  occurredAt: string;
  ownerId: string;
  /**
   * Paragraphs the organizer places itself, such as a reference to a photo the owner
   * attached. They are applied after the model's operations and are deliberately excluded
   * from the operation cap and from source preservation: preservation exists to prove the
   * model kept the owner's words, and this text is not the model's.
   */
  attachmentParagraphs?: readonly string[] | undefined;
}>;

export type ApplyMaterializedOrganizationCommandInput =
  ApplyMaterializedCreateOrganizationCommandInput | ApplyMaterializedAppendOrganizationCommandInput;

export type ApplyOwnerAuthorizedCreateOrganizationCommandInput =
  ApplyMaterializedCreateOrganizationCommandInput &
    Readonly<{
      sourcePrivacy: null;
      targetPrivacy: PrivacyMode;
    }>;

export type ApplyOwnerAuthorizedAppendOrganizationCommandInput =
  ApplyMaterializedAppendOrganizationCommandInput &
    Readonly<{
      sourcePrivacy: PrivacyMode;
      targetPrivacy: PrivacyMode;
    }>;

export type ApplyOwnerAuthorizedMaterializedOrganizationCommandInput =
  | ApplyOwnerAuthorizedCreateOrganizationCommandInput
  | ApplyOwnerAuthorizedAppendOrganizationCommandInput;

export type OrganizationNoteContentPayload = Readonly<{
  schemaVersion: 1;
  title: string;
  bodyMarkdown: string;
  structuredData: NoteSnapshot["structuredData"];
}>;

export type OrganizationNoteRevisionPayload = Readonly<{
  schemaVersion: 1;
  snapshot: NoteSnapshot;
}>;

export type OrganizationNoteMutationPayload =
  | Readonly<{
      schemaVersion: 1;
      action: "create";
      beforeRevision: 0;
      afterRevision: 1;
      operations: readonly [Readonly<{ type: "create_note" }>];
      inverse: Readonly<{ type: "soft_delete_created_note" }>;
      beforeSnapshot: null;
      afterSnapshot: NoteSnapshot;
    }>
  | Readonly<{
      schemaVersion: 1;
      action: "update";
      beforeRevision: number;
      afterRevision: number;
      operations: readonly UserOperation[];
      inverse: readonly UserOperation[];
      beforeSnapshot: NoteSnapshot;
      afterSnapshot: NoteSnapshot;
    }>;

type OrganizationApplicationBase = Readonly<{
  insertedItemIds: readonly (EntityId<"ent"> | EntityId<"itm">)[];
  mutationId: EntityId<"mut">;
  note: Note;
  noteContentPayload: OrganizationNoteContentPayload;
  noteMutationPayload: OrganizationNoteMutationPayload;
  noteRevisionPayload: OrganizationNoteRevisionPayload;
  revision: NoteRevision;
}>;

export type AppliedCreateOrganizationCommand = OrganizationApplicationBase &
  Readonly<{ kind: "create"; mutation: null }>;

export type AppliedAppendOrganizationCommand = OrganizationApplicationBase &
  Readonly<{ kind: "append"; mutation: NoteMutation }>;

export type AppliedOrganizationCommand =
  AppliedCreateOrganizationCommand | AppliedAppendOrganizationCommand;

type MutableSnapshot = { -readonly [Key in keyof NoteSnapshot]: NoteSnapshot[Key] };

function fail(code: OrganizationApplicationErrorCodeValue): never {
  throw new OrganizationApplicationError(code);
}

/**
 * The owner's own words for this capture. The empty string is the one way to say the owner
 * wrote none — a capture whose only content is an upload — and it is accepted only when the
 * organizer supplies the paragraphs that will stand in the note instead, so no path can
 * produce a note with nothing in it.
 */
function captureText(value: unknown, hasOrganizerPlacement: boolean): string {
  if (typeof value !== "string" || value.length > MAX_CAPTURE_LENGTH) {
    return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  }
  if (value.length === 0) {
    return hasOrganizerPlacement ? value : fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  }
  if (value.trim().length === 0) return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  return value;
}

function ownerId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    /\s/u.test(value)
  ) {
    return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  }
  return value;
}

function materializedOperations(
  values: readonly MaterializedOrganizationOperation[],
  hasOrganizerPlacement: boolean
): readonly MaterializedOrganizationOperation[] {
  // A model that wrote nothing is only acceptable when the organizer is placing the content
  // itself, which is the upload-only capture: the photo is the note.
  if (values.length > 5 || (values.length === 0 && !hasOrganizerPlacement)) {
    return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  }
  return Object.freeze(
    values.map((value) => {
      const relation = ResolvedRelationSchema.safeParse(value);
      if (relation.success) return Object.freeze(relation.data);
      const model = ModelOperationSchema.safeParse(value);
      if (!model.success || model.data.type === "add_relation") {
        return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
      }
      return Object.freeze(model.data);
    })
  );
}

function preservationOperations(
  operations: readonly MaterializedOrganizationOperation[]
): readonly ModelOperation[] {
  return operations.filter(
    (
      operation
    ): operation is Exclude<MaterializedOrganizationOperation, { type: "add_relation" }> =>
      operation.type !== "add_relation"
  );
}

function appendMarkdown(current: string, addition: string): string {
  if (addition.length === 0) return current;
  if (current.length === 0) return addition;
  const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  const result = `${current}${separator}${addition}`;
  if (result.length > MAX_NOTE_BODY_LENGTH) {
    return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
  }
  return result;
}

function cloneSnapshot(snapshot: NoteSnapshot): MutableSnapshot {
  return {
    ...snapshot,
    structuredData: structuredClone(snapshot.structuredData),
    tagIds: [...snapshot.tagIds],
    links: snapshot.links.map((link) => ({ ...link }))
  };
}

function structuralIds(snapshot: NoteSnapshot): readonly (EntityId<"ent"> | EntityId<"itm">)[] {
  switch (snapshot.type) {
    case "list":
      return ListStructuredDataSchema.parse(snapshot.structuredData).items.map(({ id }) => id);
    case "log":
      return LogStructuredDataSchema.parse(snapshot.structuredData).entries.map(({ id }) => id);
    case "project":
      return ProjectStructuredDataSchema.parse(snapshot.structuredData).checklistItems.map(
        ({ id }) => id
      );
    case "generic":
    case "principle":
      return [];
  }
}

function commandIdFactory(
  command: RoutedCommand,
  supplied: EntityIdFactory,
  currentSnapshot: NoteSnapshot
): EntityIdFactory {
  const occupied = new Set<string>(structuralIds(currentSnapshot));
  return ((kind: EntityKind) => {
    if (kind === "rev") return command.revisionId;
    if (kind === "mut") return command.mutationId;
    if (kind !== "itm" && kind !== "ent") {
      return fail(OrganizationApplicationErrorCode.INVALID_ID_FACTORY);
    }
    let generated: EntityId<typeof kind>;
    try {
      generated = entityIdSchema(kind).parse(supplied(kind));
    } catch {
      return fail(OrganizationApplicationErrorCode.INVALID_ID_FACTORY);
    }
    if (occupied.has(generated)) {
      return fail(OrganizationApplicationErrorCode.INVALID_ID_FACTORY);
    }
    occupied.add(generated);
    return generated;
  }) as EntityIdFactory;
}

function validatedSection(value: string | null): string | null {
  if (
    value !== null &&
    (value.length < 1 ||
      value.length > 100 ||
      value !== value.trim() ||
      /[\r\n]/u.test(value) ||
      COMPLETED_SECTION.test(value))
  ) {
    return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
  }
  return value;
}

function listFragment(
  items: readonly Readonly<{ checked: boolean; section: string | null; text: string }>[]
): string {
  const chunks: string[] = [];
  let priorSection: string | null | undefined;
  for (const item of items) {
    const section = validatedSection(item.section);
    if (section !== priorSection) {
      if (chunks.length > 0) chunks.push("");
      // The list parser reads a "Completed" heading as a return to no section. It lives only
      // in this appended fragment; the canonical body keeps items in place and never carries it.
      chunks.push(`## ${section ?? "Completed"}`, "");
      priorSection = section;
    }
    chunks.push(`- [${item.checked ? "x" : " "}] ${item.text}`);
  }
  return chunks.join("\n");
}

function replaceDraftBody(
  draft: MutableSnapshot,
  markdown: string,
  idFactory: EntityIdFactory
): void {
  if (markdown.length > MAX_NOTE_BODY_LENGTH) {
    return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
  }
  switch (draft.type) {
    case "list": {
      const structured = reconcileListMarkdown(
        ListStructuredDataSchema.parse(draft.structuredData),
        markdown,
        idFactory
      );
      draft.structuredData = structured;
      draft.bodyMarkdown = renderListMarkdown(structured);
      return;
    }
    case "log": {
      const structured = reconcileLogMarkdown(
        LogStructuredDataSchema.parse(draft.structuredData),
        markdown,
        idFactory
      );
      draft.structuredData = structured;
      draft.bodyMarkdown = renderLogMarkdown(structured);
      return;
    }
    case "project": {
      const structured = ProjectStructuredDataSchema.parse(draft.structuredData);
      draft.structuredData = ProjectStructuredDataSchema.parse({
        schemaVersion: 1,
        checklistItems: reconcileProjectChecklist(structured.checklistItems, markdown, idFactory)
      });
      draft.bodyMarkdown = markdown;
      return;
    }
    case "generic":
    case "principle":
      draft.bodyMarkdown = markdown;
  }
}

function appendListItems(
  draft: MutableSnapshot,
  values: readonly Readonly<{ checked: boolean; section: string | null; text: string }>[],
  idFactory: EntityIdFactory
): void {
  if (draft.type !== "list") return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
  replaceDraftBody(draft, appendMarkdown(draft.bodyMarkdown, listFragment(values)), idFactory);
}

function parsedLogFields(value: unknown): Readonly<Record<string, string | number | null>> {
  const result = LogEntrySchema.shape.fields.safeParse(value);
  if (!result.success || Object.keys(result.data).length < 1) {
    return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
  }
  return result.data;
}

function appendLogEntry(
  draft: MutableSnapshot,
  fields: Readonly<Record<string, string | number | null>>,
  occurredAt: string,
  idFactory: EntityIdFactory
): void {
  if (draft.type !== "log") return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
  const current = LogStructuredDataSchema.parse(draft.structuredData);
  const entry = LogEntrySchema.parse({ id: idFactory("ent"), occurredAt, fields });
  const structured = LogStructuredDataSchema.parse({
    schemaVersion: 1,
    entries: [...current.entries, entry]
  });
  draft.structuredData = structured;
  draft.bodyMarkdown = renderLogMarkdown(structured);
}

function applyStructuredPatch(
  draft: MutableSnapshot,
  patch: unknown,
  occurredAt: string,
  idFactory: EntityIdFactory
): void {
  switch (draft.type) {
    case "list": {
      const result = ListStructuredPatchSchema.safeParse(patch);
      if (!result.success) return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
      appendListItems(
        draft,
        result.data.items.map((item) => ({
          checked: item.checked ?? false,
          section: item.section ?? null,
          text: item.text
        })),
        idFactory
      );
      return;
    }
    case "log": {
      const result = LogStructuredPatchSchema.safeParse(patch);
      if (!result.success) return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
      for (const entry of result.data.entries) {
        appendLogEntry(draft, parsedLogFields(entry.fields), occurredAt, idFactory);
      }
      return;
    }
    case "project": {
      const result = ProjectStructuredPatchSchema.safeParse(patch);
      if (!result.success) return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
      const fragment = result.data.checklistItems
        .map((item) => `- [${item.checked === true ? "x" : " "}] ${item.text}`)
        .join("\n");
      replaceDraftBody(draft, appendMarkdown(draft.bodyMarkdown, fragment), idFactory);
      return;
    }
    case "generic":
    case "principle":
      return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
  }
}

function applyOperation(
  draft: MutableSnapshot,
  noteId: EntityId<"note">,
  operation: MaterializedOrganizationOperation,
  exactCaptureText: string,
  occurredAt: string,
  idFactory: EntityIdFactory
): void {
  switch (operation.type) {
    case "append_raw":
      // The capture is authoritative. Canonically equivalent model text never replaces its bytes.
      replaceDraftBody(draft, appendMarkdown(draft.bodyMarkdown, exactCaptureText), idFactory);
      return;
    case "append_paragraphs":
      replaceDraftBody(
        draft,
        appendMarkdown(draft.bodyMarkdown, operation.paragraphs.join("\n\n")),
        idFactory
      );
      return;
    case "append_list_items":
      appendListItems(
        draft,
        operation.items.map((text) => ({
          checked: false,
          section: validatedSection(operation.section),
          text
        })),
        idFactory
      );
      return;
    case "append_log_entry":
      appendLogEntry(draft, parsedLogFields(operation.entry), occurredAt, idFactory);
      return;
    case "update_structured_data":
      applyStructuredPatch(draft, operation.patch, occurredAt, idFactory);
      return;
    case "add_tags":
      draft.tagIds = [...new Set([...draft.tagIds, ...operation.tagIds])];
      return;
    case "add_relation": {
      if (operation.toNoteId === noteId) {
        return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
      }
      const identity = `${operation.toNoteId}:${operation.linkType}`;
      if (!draft.links.some((link) => `${link.toNoteId}:${link.linkType}` === identity)) {
        draft.links = [
          ...draft.links,
          { toNoteId: operation.toNoteId, linkType: operation.linkType }
        ];
      }
    }
  }
}

function restoreOperation(snapshot: NoteSnapshot): UserOperation {
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

/**
 * Whether a note of this type can hold a paragraph at all. A list or log body is a rendering
 * of its items, so a paragraph placed in one is either refused by the projection or silently
 * dropped; there is nowhere in such a note for a photo reference to live.
 */
export function noteTypeHoldsParagraphs(noteType: NoteSnapshot["type"]): boolean {
  return noteType !== "list" && noteType !== "log";
}

/**
 * The organizer's own paragraphs, applied through the same machinery as the model's so the
 * note body, its structured projection and its open state all stay consistent.
 */
function withOrganizerPlacement(
  operations: readonly MaterializedOrganizationOperation[],
  paragraphs: readonly string[] | undefined,
  noteType: NoteSnapshot["type"]
): readonly MaterializedOrganizationOperation[] {
  if (paragraphs === undefined || paragraphs.length === 0) return operations;
  if (paragraphs.some((paragraph) => paragraph.length === 0)) {
    return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  }
  if (!noteTypeHoldsParagraphs(noteType)) {
    return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
  }
  return Object.freeze([
    ...operations,
    Object.freeze({
      type: "append_paragraphs" as const,
      paragraphs: Object.freeze([...paragraphs])
    })
  ]) as readonly MaterializedOrganizationOperation[];
}
function buildDraft(
  command: RoutedCommand,
  operations: readonly MaterializedOrganizationOperation[],
  initial: NoteSnapshot,
  exactCaptureText: string,
  occurredAt: string,
  idFactory: EntityIdFactory,
  targetPrivacy: PrivacyMode
): NoteSnapshot {
  const draft = cloneSnapshot(initial);
  for (const operation of operations) {
    applyOperation(draft, command.noteId, operation, exactCaptureText, occurredAt, idFactory);
  }
  draft.privacy = targetPrivacy;
  draft.isOpen = openStateForStructuredNote(draft.type, draft.structuredData, draft.isOpen);
  return NoteSnapshotSchema.parse(draft);
}

function currentNote(
  value: unknown,
  command: MaterializedAppendOrganizationCommand,
  expectedOwnerId: string,
  expectedPrivacy: PrivacyMode,
  ownerAuthorized: boolean
): Note {
  if (typeof value !== "object" || value === null || !("userId" in value)) {
    return fail(OrganizationApplicationErrorCode.INVALID_NOTE_STATE);
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (!ownerAuthorized && record.privacy === "private_manual") {
    return fail(OrganizationApplicationErrorCode.PRIVATE_NOTE_FORBIDDEN);
  }
  const { userId: actualOwnerId, ...noteRecord } = record;
  const parsed = NoteSchema.safeParse(noteRecord);
  if (!parsed.success || actualOwnerId !== expectedOwnerId) {
    return fail(OrganizationApplicationErrorCode.INVALID_NOTE_STATE);
  }
  if (
    parsed.data.id !== command.noteId ||
    parsed.data.currentRevision !== command.expectedRevision ||
    parsed.data.currentRevision + 1 !== command.afterRevision ||
    parsed.data.type !== command.noteType ||
    parsed.data.privacy !== expectedPrivacy ||
    !parsed.data.isOpen ||
    parsed.data.archivedAt !== null ||
    parsed.data.deletedAt !== null
  ) {
    return fail(OrganizationApplicationErrorCode.INVALID_NOTE_STATE);
  }
  return deepFreeze({ ...parsed.data, userId: expectedOwnerId });
}

function emptyCreateSnapshot(
  command: MaterializedCreateOrganizationCommand,
  targetPrivacy: PrivacyMode
): NoteSnapshot {
  if (!NoteTypeSchema.safeParse(command.noteType).success) {
    return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  }
  return NoteSnapshotSchema.parse({
    spaceId: command.spaceId,
    type: command.noteType,
    title: command.title,
    bodyMarkdown: "",
    structuredData: defaultStructuredData(command.noteType),
    isOpen: true,
    pinnedAt: null,
    privacy: targetPrivacy,
    archivedAt: null,
    deletedAt: null,
    tagIds: [],
    links: []
  });
}

function payloads(
  note: Note,
  beforeSnapshot: NoteSnapshot | null,
  mutation: NoteMutation | null
): Readonly<{
  noteContentPayload: OrganizationNoteContentPayload;
  noteMutationPayload: OrganizationNoteMutationPayload;
  noteRevisionPayload: OrganizationNoteRevisionPayload;
}> {
  const afterSnapshot = noteSnapshot(note);
  const noteContentPayload: OrganizationNoteContentPayload = {
    schemaVersion: 1,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData
  };
  const noteRevisionPayload: OrganizationNoteRevisionPayload = {
    schemaVersion: 1,
    snapshot: afterSnapshot
  };
  const noteMutationPayload: OrganizationNoteMutationPayload =
    mutation === null
      ? {
          schemaVersion: 1,
          action: "create",
          beforeRevision: 0,
          afterRevision: 1,
          operations: [{ type: "create_note" }],
          inverse: { type: "soft_delete_created_note" },
          beforeSnapshot: null,
          afterSnapshot
        }
      : {
          schemaVersion: 1,
          action: "update",
          beforeRevision: mutation.beforeRevision,
          afterRevision: mutation.afterRevision,
          operations: mutation.operations,
          inverse: mutation.inverse,
          beforeSnapshot:
            beforeSnapshot ?? fail(OrganizationApplicationErrorCode.INVALID_NOTE_STATE),
          afterSnapshot
        };
  return deepFreeze({ noteContentPayload, noteMutationPayload, noteRevisionPayload });
}

function newlyInsertedIds(
  before: NoteSnapshot | null,
  after: NoteSnapshot
): readonly (EntityId<"ent"> | EntityId<"itm">)[] {
  const prior = new Set(before === null ? [] : structuralIds(before));
  return Object.freeze(structuralIds(after).filter((id) => !prior.has(id)));
}

function assertCommandBindings(command: RoutedCommand): void {
  try {
    entityIdSchema("note").parse(command.noteId);
    entityIdSchema("dec").parse(command.decisionId);
    entityIdSchema("rev").parse(command.revisionId);
    entityIdSchema("mut").parse(command.mutationId);
  } catch {
    fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  }
}

type ApplicationAuthority = Readonly<{
  ownerAuthorized: boolean;
  sourcePrivacy: PrivacyMode | null;
  targetPrivacy: PrivacyMode;
}>;

function applyWithAuthority(
  input: ApplyMaterializedOrganizationCommandInput,
  authority: ApplicationAuthority
): AppliedOrganizationCommand {
  try {
    const command = input.command;
    assertCommandBindings(command);
    if (
      !PrivacyModeSchema.safeParse(authority.targetPrivacy).success ||
      (authority.sourcePrivacy !== null &&
        !PrivacyModeSchema.safeParse(authority.sourcePrivacy).success) ||
      (command.kind === "create"
        ? authority.sourcePrivacy !== null
        : authority.sourcePrivacy === null)
    ) {
      return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
    }
    const hasOrganizerPlacement = (input.attachmentParagraphs?.length ?? 0) > 0;
    const exactCaptureText = captureText(input.captureText, hasOrganizerPlacement);
    const exactOwnerId = ownerId(input.ownerId);
    const parsedOccurredAt = UtcInstantSchema.safeParse(input.occurredAt);
    if (!parsedOccurredAt.success) {
      return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
    }
    const occurredAt = parsedOccurredAt.data;
    const operations = materializedOperations(command.operations, hasOrganizerPlacement);
    try {
      assertPlanSourcePreserved(exactCaptureText, {
        operations: preservationOperations(operations)
      });
    } catch (error: unknown) {
      if (error instanceof SourcePreservationError) {
        return fail(OrganizationApplicationErrorCode.SOURCE_PRESERVATION_FAILED);
      }
      throw error;
    }
    if (command.kind === "create") {
      const initial = emptyCreateSnapshot(command, authority.targetPrivacy);
      const idFactory = commandIdFactory(command, input.idFactory, initial);
      const draft = buildDraft(
        command,
        withOrganizerPlacement(operations, input.attachmentParagraphs, initial.type),
        initial,
        exactCaptureText,
        occurredAt,
        idFactory,
        authority.targetPrivacy
      );
      const created = createInitialNote({
        id: command.noteId,
        userId: exactOwnerId,
        title: draft.title,
        type: draft.type,
        privacy: authority.targetPrivacy,
        now: occurredAt,
        spaceId: draft.spaceId,
        bodyMarkdown: draft.bodyMarkdown,
        structuredData: draft.structuredData,
        tagIds: draft.tagIds,
        links: draft.links,
        idFactory
      });
      const revision = revisionFromNote(created.note, "organization", "organizer", idFactory);
      if (revision.id !== command.revisionId || revision.revision !== command.afterRevision) {
        return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
      }
      const outputPayloads = payloads(created.note, null, null);
      return deepFreeze({
        kind: "create" as const,
        mutation: null,
        mutationId: command.mutationId,
        note: created.note,
        revision,
        insertedItemIds: newlyInsertedIds(null, noteSnapshot(created.note)),
        ...outputPayloads
      });
    }

    const current = currentNote(
      input.currentNote,
      command,
      exactOwnerId,
      authority.sourcePrivacy ?? fail(OrganizationApplicationErrorCode.INVALID_COMMAND),
      authority.ownerAuthorized
    );
    const beforeSnapshot = noteSnapshot(current);
    const idFactory = commandIdFactory(command, input.idFactory, beforeSnapshot);
    const draft = buildDraft(
      command,
      withOrganizerPlacement(operations, input.attachmentParagraphs, beforeSnapshot.type),
      beforeSnapshot,
      exactCaptureText,
      occurredAt,
      idFactory,
      authority.targetPrivacy
    );
    const applied = applyNoteOperations(current, {
      expectedRevision: command.expectedRevision,
      operations: [restoreOperation(draft)],
      now: occurredAt,
      idFactory,
      source: "organization",
      actor: "organizer"
    });
    if (
      applied.note.privacy !== authority.targetPrivacy ||
      applied.note.currentRevision !== command.afterRevision ||
      applied.revision.id !== command.revisionId ||
      applied.mutation.id !== command.mutationId
    ) {
      return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
    }
    const outputPayloads = payloads(applied.note, beforeSnapshot, applied.mutation);
    return deepFreeze({
      kind: "append" as const,
      mutationId: command.mutationId,
      insertedItemIds: newlyInsertedIds(beforeSnapshot, noteSnapshot(applied.note)),
      ...applied,
      ...outputPayloads
    });
  } catch (error: unknown) {
    if (error instanceof OrganizationApplicationError) throw error;
    if (error instanceof DomainError || error instanceof z.ZodError) {
      return fail(OrganizationApplicationErrorCode.INVALID_OPERATION);
    }
    return fail(OrganizationApplicationErrorCode.INVALID_COMMAND);
  }
}

/**
 * Applies an AI-organizer command inside its fixed AI-assisted boundary.
 * Private notes remain impossible to pass through this entry point.
 */
export function applyMaterializedOrganizationCommand(
  input: ApplyMaterializedOrganizationCommandInput
): AppliedOrganizationCommand {
  return applyWithAuthority(input, {
    ownerAuthorized: false,
    sourcePrivacy: input.command.kind === "create" ? null : "ai_assisted",
    targetPrivacy: "ai_assisted"
  });
}

/**
 * Applies the same source-preserving materialized command after an authenticated
 * owner action has already authorized the exact source and target privacy classes.
 * This is intentionally separate from the organizer entry point so model-driven
 * routing cannot opt itself into private-manual access.
 */
export function applyOwnerAuthorizedMaterializedOrganizationCommand(
  input: ApplyOwnerAuthorizedMaterializedOrganizationCommandInput
): AppliedOrganizationCommand {
  return applyWithAuthority(input, {
    ownerAuthorized: true,
    sourcePrivacy: input.sourcePrivacy,
    targetPrivacy: input.targetPrivacy
  });
}

// The web's review resolution shapes a capture for a list or log note with the same
// extractor the organizer uses, without pulling the evaluation corpus into its bundle.
export { applyDeterministicExtractionOverride } from "./extraction.js";
