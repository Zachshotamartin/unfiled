import type { NoteRecord, NoteSearchOptions } from "@/lib/product/types";

/** Shared filter semantics for every owner-authorized lexical adapter. */
export function noteMatchesSearchOptions(note: NoteRecord, options: NoteSearchOptions): boolean {
  if (
    options.archived !== "include" &&
    (options.archived === "only" ? note.archivedAt === null : note.archivedAt !== null)
  ) {
    return false;
  }
  if (options.type !== undefined && note.type !== options.type) return false;
  if (options.spaceId !== undefined && note.spaceId !== options.spaceId) return false;
  if (options.privacy !== undefined && note.privacy !== options.privacy) return false;
  if (
    options.tagIds !== undefined &&
    !options.tagIds.every((tagId) => note.tagIds.includes(tagId))
  ) {
    return false;
  }
  const updatedAt = Date.parse(note.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  if (options.updatedFrom !== undefined && updatedAt < Date.parse(options.updatedFrom))
    return false;
  if (options.updatedTo !== undefined && updatedAt >= Date.parse(options.updatedTo)) return false;
  return true;
}
