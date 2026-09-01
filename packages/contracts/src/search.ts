import { z } from "zod";

import { ArchiveFilterSchema, NoteTypeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

/**
 * Maximum note count that the isolated verifier can prove in one bounded run.
 *
 * This is a cross-service admission contract: web defers larger generations
 * before creation and the verifier independently rejects them. The admitted
 * limit is deliberately below the 1,023-row physical worst-case
 * space from 33 pages when the fixed 8 MiB ciphertext budget fits 31
 * database-maximum rows per page. This preserves the accepted 1,000-note
 * retrieval gate without letting typical smaller rows raise the admitted count.
 */
export const RAG_GENERATION_VERIFICATION_NOTE_CAPACITY = 1_000 as const;

/**
 * Maximum distinct owner-bound object-wrap key records the verifier may open
 * in one generation. Normal generations use one active key; a higher count is
 * treated as a deterministic rebuild condition so KMS work stays bounded.
 */
export const RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS = 4 as const;

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
