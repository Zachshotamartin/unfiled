import {
  ApiErrorCode,
  createEntityId,
  type EntityId,
  type NoteType,
  type PrivacyMode
} from "@unfiled/contracts";

import { contentHash, deepFreeze } from "./canonical.js";
import { DomainError } from "./errors.js";

export type Note = Readonly<{
  id: EntityId<"note">;
  userId: string;
  spaceId: EntityId<"spc"> | null;
  type: NoteType;
  title: string;
  bodyMarkdown: string;
  structuredData: Readonly<Record<string, unknown>>;
  currentRevision: number;
  privacy: PrivacyMode;
  isOpen: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type NoteRevision = Readonly<{
  id: EntityId<"rev">;
  noteId: EntityId<"note">;
  revision: number;
  source: "manual" | "organization" | "undo" | "import" | "interactive";
  title: string;
  bodyMarkdown: string;
  structuredData: Readonly<Record<string, unknown>>;
  contentHash: string;
  actor: string;
  createdAt: string;
}>;

type CreateInitialNoteInput = Readonly<{
  id: EntityId<"note">;
  userId: string;
  title: string;
  type: NoteType;
  privacy: PrivacyMode;
  now: string;
  spaceId?: EntityId<"spc"> | null;
  bodyMarkdown?: string;
  structuredData?: Readonly<Record<string, unknown>>;
}>;

function snapshot(note: Note, source: NoteRevision["source"], actor: string): NoteRevision {
  return deepFreeze({
    id: createEntityId("rev"),
    noteId: note.id,
    revision: note.currentRevision,
    source,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData,
    contentHash: contentHash({
      title: note.title,
      bodyMarkdown: note.bodyMarkdown,
      structuredData: note.structuredData
    }),
    actor,
    createdAt: note.updatedAt
  });
}

export function createInitialNote(input: CreateInitialNoteInput): {
  note: Note;
  revision: NoteRevision;
} {
  const title = input.title.trim();
  if (title.length === 0 || title.length > 200) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Note title must be 1-200 characters");
  }

  const note = deepFreeze({
    id: input.id,
    userId: input.userId,
    spaceId: input.spaceId ?? null,
    type: input.type,
    title,
    bodyMarkdown: input.bodyMarkdown ?? "",
    structuredData: input.structuredData ?? {},
    currentRevision: 1,
    privacy: input.privacy,
    isOpen: true,
    createdAt: input.now,
    updatedAt: input.now
  });

  return { note, revision: snapshot(note, "manual", "user:create") };
}

export function updateNoteTitle(
  note: Note,
  input: Readonly<{ expectedRevision: number; title: string; now: string }>
): { note: Note; revision: NoteRevision } {
  if (note.currentRevision !== input.expectedRevision) {
    throw new DomainError(
      ApiErrorCode.STALE_REVISION,
      `Expected revision ${input.expectedRevision}, found ${note.currentRevision}`
    );
  }

  const title = input.title.trim();
  if (title.length === 0 || title.length > 200) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Note title must be 1-200 characters");
  }

  const updated = deepFreeze({
    ...note,
    title,
    currentRevision: note.currentRevision + 1,
    updatedAt: input.now
  });

  return { note: updated, revision: snapshot(updated, "manual", "user:title") };
}
