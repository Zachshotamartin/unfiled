import type {
  EntityId,
  NoteBacklinksQuery,
  NoteBacklinksResponse,
  NoteSourcesQuery,
  NoteSourcesResponse
} from "@unfiled/contracts";

import type { RepositoryContext } from "@/server/product/repository";

export interface NoteContextRepository {
  listBacklinks(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    query: NoteBacklinksQuery
  ): Promise<NoteBacklinksResponse>;
  listSources(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    query: NoteSourcesQuery
  ): Promise<NoteSourcesResponse>;
}
