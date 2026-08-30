import { z } from "zod";

import { ArchiveFilterSchema, NoteTypeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

export const SearchNotesQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200),
  archive: ArchiveFilterSchema.default("exclude"),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export type SearchNotesQuery = z.input<typeof SearchNotesQuerySchema>;

export const SearchNoteResultSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  title: z.string().min(1).max(200),
  type: NoteTypeSchema,
  snippet: z.string().max(500),
  spacePath: z.array(z.string().min(1).max(60)).max(2),
  updatedAt: z.iso.datetime({ offset: true }),
  archivedAt: z.iso.datetime({ offset: true }).nullable()
});
export type SearchNoteResult = z.infer<typeof SearchNoteResultSchema>;

export const SearchNotesResponseSchema = z.strictObject({
  items: z.array(SearchNoteResultSchema),
  pageInfo: PageInfoSchema
});
export type SearchNotesResponse = z.infer<typeof SearchNotesResponseSchema>;
