import type { EntityId, NoteDto, NoteRevisionDto, NoteType, PrivacyMode } from "@unfiled/contracts";

export type SessionUser = Readonly<{
  email: string;
  id: string;
}>;

export type SpaceRecord = Readonly<{
  archivedAt: string | null;
  createdAt: string;
  currentRevision: number;
  id: EntityId<"spc">;
  name: string;
  parentId: EntityId<"spc"> | null;
  path: string;
  slug: string;
  sortKey: string;
  updatedAt: string;
}>;

export type TagRecord = Readonly<{
  createdAt: string;
  currentRevision: number;
  id: EntityId<"tag">;
  name: string;
}>;

export type SpaceMutationRecord = Readonly<{
  replayed: boolean;
  space: SpaceRecord;
}>;

export type TagMutationRecord = Readonly<{
  replayed: boolean;
  tag: TagRecord;
}>;

export type TagDeleteMutationRecord = Readonly<{
  deletedId: EntityId<"tag">;
  replayed: boolean;
}>;

export type NoteLinkRecord = Readonly<{
  fromNoteId: EntityId<"note">;
  id: EntityId<"lnk">;
  linkType: "reference" | "related";
  targetTitle: string;
  toNoteId: EntityId<"note">;
}>;

export type NoteRecord = Readonly<
  Omit<NoteDto, "links"> & {
    links: readonly NoteLinkRecord[];
    spacePath: string | null;
    tags: readonly TagRecord[];
  }
>;

export type RevisionRecord = NoteRevisionDto;

export type MutationReceipt = Readonly<{
  afterRevision: number;
  beforeRevision: number;
  id: EntityId<"mut">;
  replayed: boolean;
  undoAvailable: boolean;
}>;

export type NoteMutationResult = Readonly<{
  mutation: MutationReceipt;
  note: NoteRecord;
  revision: RevisionRecord;
}>;

export type NoteListFilters = Readonly<{
  archived?: "exclude" | "include" | "only";
  deleted?: "exclude" | "only";
  limit?: number;
  offset?: number;
  spaceId?: EntityId<"spc"> | null;
  type?: NoteType;
}>;

export type NoteListResponse = Readonly<{
  notes: readonly NoteRecord[];
}>;

export type SearchResult = Readonly<{
  note: NoteRecord;
  snippet: string;
}>;

export type SearchResponse = Readonly<{
  query: string;
  results: readonly SearchResult[];
}>;

export type CreateNoteInput = Readonly<{
  bodyMarkdown: string;
  links: readonly Readonly<{
    linkType: "reference" | "related";
    toNoteId: EntityId<"note">;
  }>[];
  privacy: PrivacyMode;
  spaceId: EntityId<"spc"> | null;
  tagIds: readonly EntityId<"tag">[];
  title: string;
  type: NoteType;
}>;

export type UpdateNoteInput = Readonly<{
  bodyMarkdown?: string;
  expectedRevision: number;
  links?: readonly Readonly<{
    linkType: "reference" | "related";
    toNoteId: EntityId<"note">;
  }>[];
  privacy?: PrivacyMode;
  spaceId?: EntityId<"spc"> | null;
  tagIds?: readonly EntityId<"tag">[];
  title?: string;
}>;

export type ChecklistItem = Readonly<{
  checked: boolean;
  id: EntityId<"itm">;
  text: string;
}>;

export function checklistItems(note: NoteRecord): readonly ChecklistItem[] {
  const key = note.type === "project" ? "checklistItems" : "items";
  const value = (note.structuredData as unknown as Readonly<Record<string, unknown>>)[key];
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      !record.id.startsWith("itm_") ||
      typeof record.text !== "string" ||
      typeof record.checked !== "boolean"
    ) {
      return [];
    }
    return [{ id: record.id as EntityId<"itm">, text: record.text, checked: record.checked }];
  });
}
