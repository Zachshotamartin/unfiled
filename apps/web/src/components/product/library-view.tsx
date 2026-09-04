"use client";

import { useEffect, useState } from "react";

import { NoteLibrary } from "./note-library";
import { usePrivateSearchNavigation } from "./private-search-navigation";
import { SearchResults } from "./search-view";
import { SpacesView } from "./spaces-view";
import { UnfiledGlyph } from "./unfiled-glyph";

/** How long the field waits after the last keystroke before it asks for results. */
const SEARCH_SETTLE_MS = 250;

export const MAX_SEARCH_QUERY_LENGTH = 200;

/**
 * The Library (ADR-0019, decision 6): one search field whose results replace the list beneath it
 * as the owner types, spaces as a grid of cards when any exist, then notes grouped by day.
 * Search is no longer a destination, so this field is the only one.
 */
export function LibraryView() {
  const privateNavigation = usePrivateSearchNavigation();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);

  useEffect(() => {
    const pending = privateNavigation.pending;
    if (pending === null) return;
    setInput(pending.query);
    privateNavigation.consume(pending.sequence);
  }, [privateNavigation]);

  useEffect(() => {
    const settled = input.trim();
    if (settled === query) return;
    const timer = window.setTimeout(() => setQuery(settled), SEARCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [input, query]);

  const searching = query.length > 0;

  return (
    <div>
      <form role="search" className="search-form" onSubmit={(event) => event.preventDefault()}>
        <div className="library-search">
          <UnfiledGlyph glyph="search" size={19} weight={1.8} />
          <label htmlFor="library-search" className="sr-only">
            Search your notes
          </label>
          <input
            id="library-search"
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Search your notes"
            maxLength={MAX_SEARCH_QUERY_LENGTH}
          />
          {input.length === 0 ? null : (
            <button
              type="button"
              className="header-icon-button"
              aria-label="Leave search"
              onClick={() => setInput("")}
            >
              <UnfiledGlyph glyph="close" size={16} weight={1.9} />
            </button>
          )}
        </div>
        {searching ? (
          <label className="search-archive-toggle">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            <span>Include archive</span>
          </label>
        ) : null}
      </form>
      {searching ? (
        <section aria-label="Search results" className="mt-6">
          <SearchResults key={query} query={query} includeArchived={includeArchived} />
        </section>
      ) : (
        <>
          <section aria-label="Spaces" className="mt-8">
            <SpacesView />
          </section>
          <section aria-label="Notes" className="mt-8">
            <NoteLibrary
              grouped
              emptyTitle="Nothing filed yet."
              emptyBody="Write something in the Inbox. Organized thoughts land here."
            />
          </section>
        </>
      )}
    </div>
  );
}
