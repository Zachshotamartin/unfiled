import type { NoteBacklinkDto, NoteSourceDto } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { NoteBacklinksList, NoteContextSections, NoteSourcesList } from "./note-context-sections";

const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";

const source: NoteSourceDto = {
  captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  mutationId: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  relation: "routed",
  rawContent: "bench 135 x 8",
  source: "ios_lock_screen_widget",
  clientCreatedAt: "2026-09-01T20:00:00.000Z",
  insertedItemIds: ["ent_01J6M9Q7G4BMKB33GSG3NJ6D1X", "ent_01J6M9Q7G4BMKB33GSG3NJ6D1Y"],
  createdAt: "2026-09-01T20:00:01.000Z"
};

const backlink: NoteBacklinkDto = {
  linkId: "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  fromNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  fromTitle: "September training plan",
  linkType: "related",
  createdAt: "2026-09-01T21:00:00.000Z"
};

const common = {
  error: null,
  hasMore: false,
  loading: false,
  loadingMore: false,
  offline: false,
  onLoadMore: vi.fn(),
  onRetry: vi.fn(),
  pageError: null
} as const;

describe("NoteContextSections", () => {
  it("keeps decrypted context unmounted until its disclosure is opened", () => {
    const html = renderToStaticMarkup(<NoteContextSections noteId={NOTE_ID} />);

    expect(html).toContain("Backlinks");
    expect(html).toContain("Sources");
    expect(html).not.toContain("Loading source captures");
    expect(html).not.toContain("Loading backlinks");
  });

  it("renders exact source text, provenance, inserted count, and removed state", () => {
    const html = renderToStaticMarkup(
      <NoteSourcesList
        {...common}
        items={[
          source,
          {
            ...source,
            captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
            mutationId: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
            rawContent: "original statement",
            relation: "source_removed",
            source: "web"
          }
        ]}
      />
    );

    expect(html).toContain('aria-label="Source captures"');
    expect(html).toContain("bench 135 x 8");
    expect(html).toContain("Lock Screen");
    expect(html).toContain("2 inserted items");
    expect(html).toContain("Removed from note");
  });

  it("renders backlinks as note navigation with relationship context", () => {
    const html = renderToStaticMarkup(<NoteBacklinksList {...common} items={[backlink]} />);

    expect(html).toContain(`href="/app/notes/${backlink.fromNoteId}"`);
    expect(html).toContain("September training plan");
    expect(html).toContain("Related note");
    expect(html).toContain('aria-label="Backlinks"');
  });

  it("provides loading, empty, offline, retry, and next-page failure states", () => {
    const loading = renderToStaticMarkup(<NoteSourcesList {...common} items={[]} loading />);
    const empty = renderToStaticMarkup(<NoteBacklinksList {...common} items={[]} />);
    const failure = renderToStaticMarkup(
      <NoteSourcesList {...common} error="Reconnect to inspect sources." items={[]} offline />
    );
    const pageFailure = renderToStaticMarkup(
      <NoteBacklinksList
        {...common}
        hasMore
        items={[backlink]}
        pageError="The next page could not be loaded."
      />
    );

    expect(loading).toContain('aria-busy="true"');
    expect(empty).toContain("No notes link back to this one yet.");
    expect(failure).toContain("You’re offline.");
    expect(failure).toContain("Try again");
    expect(pageFailure).toContain("Load more");
    expect(pageFailure).toContain('role="alert"');
    expect(pageFailure).toContain("The next page could not be loaded.");
  });
});
