import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LibraryView } from "./library-view";
import { searchRequestFor } from "./search-view";

describe("Library search", () => {
  it("is one bounded field over the library, with no scope picker", () => {
    const html = renderToStaticMarkup(<LibraryView />);

    expect(html).toContain('role="search"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('id="library-search"');
    // The owner removed the split: "there should not be a picker for all notes or ai assisted
    // notes. there is no separation there" (ADR-0021, context).
    expect(html).not.toContain('name="search-scope"');
    expect(html).not.toContain("AI-assisted notes");
    expect(html).not.toContain("Search scope");
    // The query never enters a URL, browser history, or persistent client storage.
    expect(html).not.toContain("/api/v1/search?");
    expect(html).not.toContain("/app/library?");
    expect(html).not.toContain('name="q"');
  });

  it("makes no claim that a query is sent to a provider", () => {
    const html = renderToStaticMarkup(<LibraryView />);

    // Retrieval runs `unfiled-local-hash-v1`, a deterministic lexical feature hash computed in
    // process that never contacts a provider (docs/STATUS.md). Saying otherwise was false for
    // every deployment that has ever shipped.
    expect(html).not.toContain("OpenAI");
    expect(html).not.toContain("dedicated search service");
    expect(html).not.toContain("does not use your saved organizer key");
    expect(html).not.toContain("semantic");
  });

  it("shows the Library's list until a query is typed", () => {
    const html = renderToStaticMarkup(<LibraryView />);

    expect(html).toContain('aria-label="Spaces"');
    expect(html).toContain('aria-label="Notes"');
    expect(html).not.toContain('aria-label="Search results"');
  });

  it("asks for results without a privacy scope", () => {
    expect(searchRequestFor("roosevelt", false)).toEqual({
      archive: "exclude",
      limit: 50,
      query: "roosevelt"
    });
    expect(searchRequestFor("roosevelt", true, "cursor-2")).toEqual({
      archive: "include",
      cursor: "cursor-2",
      limit: 50,
      query: "roosevelt"
    });
    expect(Object.keys(searchRequestFor("roosevelt", false))).not.toContain("privacy");
  });
});
