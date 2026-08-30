"use client";

import { ArrowRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { SearchNoteResult } from "@unfiled/contracts";
import Link from "next/link";
import { type SyntheticEvent, useState } from "react";

import { usePagedResource } from "@/lib/product/use-paged-resource";

import { EmptyState, ResourceError, ResourceSkeleton } from "./resource-states";

function resultKey(result: SearchNoteResult): string {
  return result.noteId;
}

function Results({
  includeArchived,
  query
}: Readonly<{ includeArchived: boolean; query: string }>) {
  const resource = usePagedResource<SearchNoteResult>(
    `/api/v1/search?q=${encodeURIComponent(query)}&archive=${includeArchived ? "include" : "exclude"}&limit=50`,
    resultKey
  );
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
              <span className="flex flex-wrap justify-end gap-x-3 font-mono text-[11px] text-disabled-content">
                <span>{result.spacePath.join(" / ") || "Unfiled"}</span>
                <time dateTime={result.updatedAt}>
                  {new Date(result.updatedAt).toLocaleDateString()}
                </time>
              </span>
            </div>
            <div className="mt-3 flex gap-5">
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-medium tracking-[-0.025em]">{result.title}</h2>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-content">
                  {result.snippet || "Match found in this note."}
                </p>
              </div>
              <ArrowRightIcon
                size={18}
                className="mt-1 text-disabled-content group-hover:text-action"
              />
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

export function SearchView() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    setQuery(input.trim());
  }
  return (
    <div>
      <form onSubmit={submit} role="search" className="search-form">
        <MagnifyingGlassIcon size={21} className="text-muted-content" aria-hidden="true" />
        <label htmlFor="library-search" className="sr-only">
          Search your notes
        </label>
        <input
          id="library-search"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search titles and note text"
          maxLength={200}
          autoFocus
        />
        <label className="search-archive-toggle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />{" "}
          <span>Include archive</span>
        </label>
        <button type="submit" className="button-primary" disabled={input.trim().length === 0}>
          Search
        </button>
      </form>
      <section aria-label="Search results" className="mt-10">
        {query.length === 0 ? (
          <EmptyState
            title="Find a line you remember."
            body="Search looks across note titles and Markdown. Archived notes stay out unless you include them."
          />
        ) : (
          <Results query={query} includeArchived={includeArchived} />
        )}
      </section>
    </div>
  );
}
