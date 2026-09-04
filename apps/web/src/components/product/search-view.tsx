"use client";

import type { SearchNoteResult, SearchNotesRequest, SearchNotesResponse } from "@unfiled/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ProductApiError } from "@/lib/product/client";
import { requestSearchPage } from "@/lib/product/search-client";

import { EmptyState, ResourceError, ResourceSkeleton } from "./resource-states";
import { UnfiledGlyph } from "./unfiled-glyph";

function resultKey(result: SearchNoteResult): string {
  return result.noteId;
}

/**
 * What the Library asks for. The request carries no privacy scope: the split the picker offered
 * does not exist in the product, and retrieval runs `unfiled-local-hash-v1`, a deterministic
 * lexical feature hash computed in process that never contacts a provider.
 */
export function searchRequestFor(
  query: string,
  includeArchived: boolean,
  cursor?: string
): SearchNotesRequest {
  return {
    query,
    archive: includeArchived ? "include" : "exclude",
    limit: 50,
    ...(cursor === undefined ? {} : { cursor })
  };
}

/**
 * One search over the library (ADR-0021's context: "there should not be a picker for all notes
 * or ai assisted notes. there is no separation there"). The request carries no privacy scope, so
 * retrieval runs the deployed `unfiled-local-hash-v1` path: a deterministic lexical feature hash
 * computed in process, which never sends the query to a provider.
 */
function usePrivateSearch(query: string, includeArchived: boolean) {
  const operation = useRef(0);
  const [data, setData] = useState<SearchNotesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const run = useCallback(
    async (cursor: string | undefined, append: boolean, signal: AbortSignal): Promise<void> => {
      const currentOperation = ++operation.current;
      if (append) {
        setLoadingMore(true);
        setPageError(null);
      } else {
        setLoading(true);
        setError(null);
        setOffline(false);
        setPageError(null);
      }
      try {
        const page = await requestSearchPage(
          searchRequestFor(query, includeArchived, cursor),
          signal
        );
        if (signal.aborted || currentOperation !== operation.current) return;
        setData((previous) => {
          if (!append || previous === null) return page;
          const seen = new Set(previous.items.map(resultKey));
          return {
            items: [...previous.items, ...page.items.filter((item) => !seen.has(resultKey(item)))],
            pageInfo: page.pageInfo
          };
        });
        setError(null);
        setOffline(false);
        setPageError(null);
      } catch (reason) {
        if (signal.aborted || currentOperation !== operation.current) return;
        const apiError = reason instanceof ProductApiError ? reason : null;
        const message = apiError?.message ?? "Could not search your notes.";
        if (append) setPageError(message);
        else {
          setData(null);
          setError(message);
          setOffline(apiError?.body.code === "offline");
        }
      } finally {
        if (!signal.aborted && currentOperation === operation.current) {
          if (append) setLoadingMore(false);
          else setLoading(false);
        }
      }
    },
    [includeArchived, query]
  );

  useEffect(() => {
    const controller = new AbortController();
    void run(undefined, false, controller.signal);
    return () => {
      controller.abort();
      operation.current += 1;
    };
  }, [run]);

  const refresh = useCallback(async (): Promise<void> => {
    await run(undefined, false, new AbortController().signal);
  }, [run]);
  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = data?.pageInfo.nextCursor;
    if (cursor === null || cursor === undefined || loadingMore) return;
    await run(cursor, true, new AbortController().signal);
  }, [data?.pageInfo.nextCursor, loadingMore, run]);

  return { data, error, loadMore, loading, loadingMore, offline, pageError, refresh };
}

/**
 * The results that replace the Library's list while the owner is searching. The Library owns the
 * field and the query; this owns only what the query found.
 */
export function SearchResults({
  includeArchived,
  query
}: Readonly<{ includeArchived: boolean; query: string }>) {
  const resource = usePrivateSearch(query, includeArchived);
  if (resource.loading && resource.data === null) return <ResourceSkeleton rows={3} />;
  if (resource.error !== null && resource.data === null)
    return (
      <ResourceError
        message={resource.error}
        offline={resource.offline}
        retry={() => void resource.refresh()}
      />
    );
  if (resource.data?.items.length === 0)
    return (
      <EmptyState
        title="No matching notes."
        body="Try a phrase from the body, a title, or a shorter word."
      />
    );
  return (
    <div>
      <div className="border-t border-outline">
        {resource.data?.items.map((result) => (
          <Link key={result.noteId} href={`/app/notes/${result.noteId}`} className="note-row group">
            <div className="flex items-center justify-between gap-4">
              <span className="eyebrow">{result.type}</span>
              <span className="flex flex-wrap justify-end gap-x-3 text-[11px] text-muted-content">
                <span>{result.spacePath.join(" / ")}</span>
                <time dateTime={result.updatedAt}>
                  {new Date(result.updatedAt).toLocaleDateString()}
                </time>
              </span>
            </div>
            <div className="mt-3 flex gap-5">
              <div className="min-w-0 flex-1">
                <h2 className="note-row-title">{result.title}</h2>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-content">
                  {result.snippet || "Match found in this note."}
                </p>
              </div>
              <span className="mt-1 text-muted-content group-hover:text-action">
                <UnfiledGlyph glyph="arrow" size={18} weight={1.9} />
              </span>
            </div>
          </Link>
        ))}
      </div>
      {resource.data?.pageInfo.hasMore ? (
        <div className="pagination-row">
          <button
            type="button"
            className="button-secondary"
            disabled={resource.loadingMore}
            onClick={() => void resource.loadMore()}
          >
            {resource.loadingMore ? "Loading…" : "Load more results"}
          </button>
        </div>
      ) : null}
      <p className="min-h-6 py-2 text-xs text-critical" role="alert">
        {resource.pageError}
      </p>
    </div>
  );
}
