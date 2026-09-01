import { z } from "zod";

import { CaptureSourceSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

export const NoteContextListQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export type NoteContextListQuery = z.infer<typeof NoteContextListQuerySchema>;

export const NoteSourcesQuerySchema = NoteContextListQuerySchema;
export type NoteSourcesQuery = NoteContextListQuery;

export const NoteSourceDtoSchema = z.strictObject({
  captureId: entityIdSchema("cap"),
  mutationId: entityIdSchema("mut"),
  relation: z.enum(["routed", "source_removed"]),
  rawContent: z.string().min(1).max(10_000),
  source: CaptureSourceSchema,
  clientCreatedAt: z.iso.datetime({ offset: true }),
  insertedItemIds: z.array(z.union([entityIdSchema("itm"), entityIdSchema("ent")])).max(500),
  createdAt: z.iso.datetime({ offset: true })
});
export type NoteSourceDto = z.infer<typeof NoteSourceDtoSchema>;

export const NoteSourcesResponseSchema = z.strictObject({
  items: z.array(NoteSourceDtoSchema),
  pageInfo: PageInfoSchema
});
export type NoteSourcesResponse = z.infer<typeof NoteSourcesResponseSchema>;

export const NoteBacklinksQuerySchema = NoteContextListQuerySchema;
export type NoteBacklinksQuery = NoteContextListQuery;

export const NoteBacklinkDtoSchema = z.strictObject({
  linkId: entityIdSchema("lnk"),
  fromNoteId: entityIdSchema("note"),
  fromTitle: z.string().min(1).max(200),
  linkType: z.enum(["reference", "related"]),
  createdAt: z.iso.datetime({ offset: true })
});
export type NoteBacklinkDto = z.infer<typeof NoteBacklinkDtoSchema>;

export const NoteBacklinksResponseSchema = z.strictObject({
  items: z.array(NoteBacklinkDtoSchema),
  pageInfo: PageInfoSchema
});
export type NoteBacklinksResponse = z.infer<typeof NoteBacklinksResponseSchema>;
