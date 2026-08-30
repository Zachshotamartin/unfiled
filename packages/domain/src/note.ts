import {
  ApiErrorCode,
  ListStructuredDataSchema,
  LogStructuredDataSchema,
  NoteLinkValueSchema,
  NoteSchema,
  ProjectStructuredDataSchema,
  UtcInstantSchema,
  entityIdSchema,
  type EntityId,
  type NoteDto,
  type NoteLinkValue,
  type NoteRevisionDto,
  type NoteSnapshot,
  type NoteStructuredData,
  type NoteType,
  type PrivacyMode,
  type RevisionSource
} from "@unfiled/contracts";

import { contentHash, deepFreeze } from "./canonical.js";
import { DomainError } from "./errors.js";
import { systemEntityIdFactory, type EntityIdFactory } from "./id-factory.js";
import {
  defaultStructuredData,
  openStateForStructuredNote,
  structuredDataForType
} from "./structured/defaults.js";
import { reconcileListMarkdown, renderListMarkdown } from "./structured/list.js";
import { renderLogMarkdown } from "./structured/log.js";
import { reconcileProjectChecklist } from "./structured/project.js";

export type Note = Readonly<NoteDto & { userId: string }>;
export type NoteRevision = NoteRevisionDto;

export type CreateInitialNoteInput = Readonly<{
  id: EntityId<"note">;
  userId: string;
  title: string;
  type: NoteType;
  privacy: PrivacyMode;
  now: string;
  spaceId?: EntityId<"spc"> | null;
  bodyMarkdown?: string;
  structuredData?: unknown;
  tagIds?: readonly EntityId<"tag">[];
  links?: readonly NoteLinkValue[];
  idFactory?: EntityIdFactory;
}>;

function validatedTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 200) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Note title must be 1-200 characters");
  }
  return title;
}

function validatedBody(value: string): string {
  if (value.length > 200_000) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Note body exceeds 200,000 characters");
  }
  return value;
}

function validatedLinks(
  noteId: EntityId<"note">,
  values: readonly NoteLinkValue[]
): NoteLinkValue[] {
  const links = values.map((link) => NoteLinkValueSchema.parse(link));
  if (links.some(({ toNoteId }) => toNoteId === noteId)) {
    throw new DomainError(ApiErrorCode.STRUCTURE_CONFLICT, "A note cannot link to itself");
  }
  const identities = links.map(({ toNoteId, linkType }) => `${toNoteId}:${linkType}`);
  if (new Set(identities).size !== identities.length) {
    throw new DomainError(ApiErrorCode.STRUCTURE_CONFLICT, "Duplicate note link");
  }
  return links;
}

function projectMarkdownFromStructure(data: ReturnType<typeof ProjectStructuredDataSchema.parse>) {
  return [...data.checklistItems]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .map((item) => `- [${item.checked ? "x" : " "}] ${item.text}`)
    .join("\n");
}

function initializeContent(
  type: NoteType,
  bodyInput: string,
  structuredInput: unknown,
  now: string,
  idFactory: EntityIdFactory
): { bodyMarkdown: string; structuredData: NoteStructuredData } {
  const suppliedStructure = structuredInput !== undefined;
  let structuredData = suppliedStructure
    ? structuredDataForType(type, structuredInput)
    : defaultStructuredData(type);
  const bodyMarkdown = validatedBody(bodyInput);

  switch (type) {
    case "list": {
      let list = ListStructuredDataSchema.parse(structuredData);
      if (bodyMarkdown.trim().length > 0) {
        list = reconcileListMarkdown(list, bodyMarkdown, idFactory);
      }
      return { bodyMarkdown: renderListMarkdown(list), structuredData: list };
    }
    case "log": {
      let log = LogStructuredDataSchema.parse(structuredData);
      if (!suppliedStructure && bodyMarkdown.trim().length > 0) {
        log = LogStructuredDataSchema.parse({
          schemaVersion: 1,
          entries: [{ id: idFactory("ent"), occurredAt: now, fields: { text: bodyMarkdown } }]
        });
      }
      const projection = renderLogMarkdown(log);
      if (suppliedStructure && bodyMarkdown.trim().length > 0 && bodyMarkdown !== projection) {
        throw new DomainError(
          ApiErrorCode.STRUCTURE_CONFLICT,
          "Log Markdown does not match its structured entries"
        );
      }
      return { bodyMarkdown: projection, structuredData: log };
    }
    case "project": {
      const project = ProjectStructuredDataSchema.parse(structuredData);
      const markdown = bodyMarkdown || projectMarkdownFromStructure(project);
      structuredData = ProjectStructuredDataSchema.parse({
        schemaVersion: 1,
        checklistItems: reconcileProjectChecklist(project.checklistItems, markdown, idFactory)
      });
      return { bodyMarkdown: markdown, structuredData };
    }
    case "generic":
    case "principle":
      return { bodyMarkdown, structuredData };
  }
}

export function noteSnapshot(note: Note): NoteSnapshot {
  return deepFreeze({
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: [...note.tagIds],
    links: note.links.map((link) => ({ ...link }))
  });
}

export function revisionFromNote(
  note: Note,
  source: RevisionSource,
  actor: string,
  idFactory: EntityIdFactory = systemEntityIdFactory
): NoteRevision {
  const snapshot = noteSnapshot(note);
  return deepFreeze({
    ...snapshot,
    id: idFactory("rev"),
    noteId: note.id,
    revision: note.currentRevision,
    source,
    contentHash: contentHash(snapshot),
    actor,
    createdAt: note.updatedAt
  });
}

export function createInitialNote(input: CreateInitialNoteInput): {
  note: Note;
  revision: NoteRevision;
} {
  const now = UtcInstantSchema.parse(input.now);
  const idFactory = input.idFactory ?? systemEntityIdFactory;
  const content = initializeContent(
    input.type,
    input.bodyMarkdown ?? "",
    input.structuredData,
    now,
    idFactory
  );
  const tagIds = [...new Set(input.tagIds ?? [])].map((id) => entityIdSchema("tag").parse(id));
  const links = validatedLinks(input.id, input.links ?? []);
  const dto = NoteSchema.parse({
    id: input.id,
    spaceId: input.spaceId ?? null,
    type: input.type,
    title: validatedTitle(input.title),
    ...content,
    currentRevision: 1,
    isOpen: openStateForStructuredNote(input.type, content.structuredData, true),
    pinnedAt: null,
    privacy: input.privacy,
    archivedAt: null,
    deletedAt: null,
    tagIds,
    links,
    createdAt: now,
    updatedAt: now
  });
  const note = deepFreeze({ ...dto, userId: input.userId });
  return { note, revision: revisionFromNote(note, "manual", "user:create", idFactory) };
}

export function updateNoteTitle(
  note: Note,
  input: Readonly<{
    expectedRevision: number;
    title: string;
    now: string;
    idFactory?: EntityIdFactory;
  }>
): { note: Note; revision: NoteRevision } {
  if (note.currentRevision !== input.expectedRevision) {
    throw new DomainError(
      ApiErrorCode.STALE_REVISION,
      `Expected revision ${input.expectedRevision}, found ${note.currentRevision}`
    );
  }
  const updated = deepFreeze({
    ...note,
    title: validatedTitle(input.title),
    currentRevision: note.currentRevision + 1,
    updatedAt: UtcInstantSchema.parse(input.now)
  });
  return {
    note: updated,
    revision: revisionFromNote(updated, "manual", "user:title", input.idFactory)
  };
}
