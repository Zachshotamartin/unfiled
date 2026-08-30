import {
  ApiErrorCode,
  NoteStructuredDataSchema,
  ReviewItemDtoSchema,
  type EntityId,
  type NoteStructuredData,
  type ReviewItemDto
} from "@unfiled/contracts";

import type {
  NoteLinkRecord,
  NoteRecord,
  RevisionRecord,
  SpaceRecord,
  TagRecord
} from "@/lib/product/types";
import { HttpError } from "@/server/api/errors";

export function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The data service returned an invalid response."
    );
  }
  return value as Record<string, unknown>;
}

export function field(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey = camelKey
): unknown {
  return camelKey in record ? record[camelKey] : record[snakeKey];
}

export function stringValue(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey = camelKey
): string {
  const value = field(record, camelKey, snakeKey);
  if (typeof value !== "string") {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The data service response was incomplete."
    );
  }
  return value;
}

export function nullableString(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey = camelKey
): string | null {
  const value = field(record, camelKey, snakeKey);
  return value === null || value === undefined ? null : stringValue(record, camelKey, snakeKey);
}

function structuredData(value: unknown): NoteStructuredData {
  const parsed = NoteStructuredDataSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The data service returned invalid note structure."
    );
  }
  return parsed.data;
}

export function mapTag(value: unknown): TagRecord {
  const row = asObject(value);
  return {
    id: stringValue(row, "id") as EntityId<"tag">,
    name: stringValue(row, "name"),
    currentRevision: Number(field(row, "currentRevision", "current_revision")),
    createdAt: stringValue(row, "createdAt", "created_at")
  };
}

export function mapLink(value: unknown): NoteLinkRecord {
  const row = asObject(value);
  const directTitle = field(row, "targetTitle", "target_title");
  const target = field(row, "target");
  const joinedTitle =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? field(target as Record<string, unknown>, "title")
      : undefined;
  return {
    id: stringValue(row, "id") as EntityId<"lnk">,
    fromNoteId: stringValue(row, "fromNoteId", "from_note_id") as EntityId<"note">,
    toNoteId: stringValue(row, "toNoteId", "to_note_id") as EntityId<"note">,
    linkType: field(row, "linkType", "link_type") === "related" ? "related" : "reference",
    targetTitle:
      typeof directTitle === "string"
        ? directTitle
        : typeof joinedTitle === "string"
          ? joinedTitle
          : "Unavailable note"
  };
}

export function mapSpace(value: unknown): SpaceRecord {
  const row = asObject(value);
  const name = stringValue(row, "name");
  return {
    id: stringValue(row, "id") as EntityId<"spc">,
    name,
    parentId: nullableString(row, "parentId", "parent_id") as EntityId<"spc"> | null,
    path: typeof row.path === "string" ? row.path : name,
    slug: stringValue(row, "slug"),
    sortKey: stringValue(row, "sortKey", "sort_key"),
    currentRevision: Number(field(row, "currentRevision", "current_revision")),
    archivedAt: nullableString(row, "archivedAt", "archived_at"),
    createdAt: stringValue(row, "createdAt", "created_at"),
    updatedAt: stringValue(row, "updatedAt", "updated_at")
  };
}

export function mapNote(value: unknown): NoteRecord {
  const row = asObject(value);
  const type = row.type;
  if (!(["generic", "list", "log", "principle", "project"] as const).includes(type as never)) {
    throw new HttpError(503, ApiErrorCode.PROVIDER_UNAVAILABLE, "The note type was invalid.");
  }
  const privacy = row.privacy === "private_manual" ? "private_manual" : "ai_assisted";
  const structured = field(row, "structuredData", "structured_data");
  return {
    id: stringValue(row, "id") as EntityId<"note">,
    spaceId: nullableString(row, "spaceId", "space_id") as EntityId<"spc"> | null,
    spacePath: nullableString(row, "spacePath", "space_path"),
    type: type as NoteRecord["type"],
    title: stringValue(row, "title"),
    bodyMarkdown: stringValue(row, "bodyMarkdown", "body_markdown"),
    structuredData: structuredData(structured),
    currentRevision: Number(field(row, "currentRevision", "current_revision")),
    isOpen: field(row, "isOpen", "is_open") !== false,
    pinnedAt: nullableString(row, "pinnedAt", "pinned_at"),
    privacy,
    archivedAt: nullableString(row, "archivedAt", "archived_at"),
    deletedAt: nullableString(row, "deletedAt", "deleted_at"),
    createdAt: stringValue(row, "createdAt", "created_at"),
    updatedAt: stringValue(row, "updatedAt", "updated_at"),
    tagIds: Array.isArray(field(row, "tagIds", "tag_ids"))
      ? (field(row, "tagIds", "tag_ids") as unknown[]).filter(
          (id): id is EntityId<"tag"> => typeof id === "string"
        )
      : Array.isArray(row.tags)
        ? row.tags.map(mapTag).map((tag) => tag.id)
        : [],
    tags: Array.isArray(row.tags) ? row.tags.map(mapTag) : [],
    links: Array.isArray(row.links) ? row.links.map(mapLink) : []
  };
}

export function mapStoredMutationNote(value: unknown): NoteRecord {
  const row = asObject(value);
  const rawLinks = field(row, "links");
  const note = mapNote({ ...row, links: [] });
  const links = Array.isArray(rawLinks)
    ? rawLinks.map((candidate, index): NoteLinkRecord => {
        const relation = asObject(candidate);
        return {
          id: `lnk_${String(index + 1).padStart(26, "0")}`,
          fromNoteId: note.id,
          toNoteId: stringValue(relation, "toNoteId", "to_note_id") as EntityId<"note">,
          linkType:
            field(relation, "linkType", "link_type") === "related" ? "related" : "reference",
          targetTitle: "Linked note"
        };
      })
    : [];
  return { ...note, links };
}

export function mapRevision(value: unknown): RevisionRecord {
  const row = asObject(value);
  const source = row.source;
  if (
    !(["manual", "organization", "undo", "import", "interactive"] as const).includes(
      source as never
    )
  ) {
    throw new HttpError(503, ApiErrorCode.PROVIDER_UNAVAILABLE, "The revision source was invalid.");
  }
  return {
    id: stringValue(row, "id") as EntityId<"rev">,
    noteId: stringValue(row, "noteId", "note_id") as EntityId<"note">,
    revision: Number(row.revision),
    source: source as RevisionRecord["source"],
    actor: typeof row.actor === "string" ? row.actor : "user",
    spaceId: nullableString(row, "spaceId", "space_id") as EntityId<"spc"> | null,
    type: row.type as RevisionRecord["type"],
    title: stringValue(row, "title"),
    bodyMarkdown: stringValue(row, "bodyMarkdown", "body_markdown"),
    structuredData: structuredData(field(row, "structuredData", "structured_data")),
    isOpen: field(row, "isOpen", "is_open") !== false,
    pinnedAt: nullableString(row, "pinnedAt", "pinned_at"),
    privacy: row.privacy === "private_manual" ? "private_manual" : "ai_assisted",
    archivedAt: nullableString(row, "archivedAt", "archived_at"),
    deletedAt: nullableString(row, "deletedAt", "deleted_at"),
    tagIds: Array.isArray(field(row, "tagIds", "tag_ids"))
      ? (field(row, "tagIds", "tag_ids") as unknown[]).filter(
          (id): id is EntityId<"tag"> => typeof id === "string"
        )
      : [],
    links: Array.isArray(field(row, "links"))
      ? (field(row, "links") as unknown[]).map((link) => {
          const value = asObject(link);
          return {
            toNoteId: stringValue(value, "toNoteId", "to_note_id") as EntityId<"note">,
            linkType: field(value, "linkType", "link_type") === "related" ? "related" : "reference"
          };
        })
      : [],
    contentHash: stringValue(row, "contentHash", "content_hash"),
    createdAt: stringValue(row, "createdAt", "created_at")
  };
}

export function mapReviewItem(value: unknown): ReviewItemDto {
  const row = asObject(value);
  const parsed = ReviewItemDtoSchema.safeParse({
    id: field(row, "id"),
    captureId: field(row, "captureId", "capture_id") ?? null,
    noteId: field(row, "noteId", "note_id") ?? null,
    type: field(row, "type"),
    choices: field(row, "choices"),
    state: field(row, "state"),
    resolution: field(row, "resolution") ?? null,
    createdAt: field(row, "createdAt", "created_at"),
    resolvedAt: field(row, "resolvedAt", "resolved_at") ?? null
  });
  if (!parsed.success) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The data service returned an invalid review item."
    );
  }
  return parsed.data;
}
