import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const routes = new URL("../../app/app/", import.meta.url);

function segments(): readonly string[] {
  return readdirSync(routes, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("the Desk's routes", () => {
  it("has no destination for Review, Search, Notes or Spaces", () => {
    // ADR-0019, decision 6: two destinations and one action. Review decisions wait in the
    // Inbox, search is the Library's own field, and a space is reached from the Library grid.
    expect(segments()).toEqual([
      "archive",
      "captures",
      "library",
      "notes",
      "review",
      "settings",
      "spaces"
    ]);
    for (const removed of ["notes", "review", "spaces"]) {
      expect(
        readdirSync(new URL(`${removed}/`, routes)).filter((entry) => entry === "page.tsx"),
        `${removed} must not be a destination of its own`
      ).toEqual([]);
    }
  });

  it("opens on the Inbox and names it that", () => {
    const page = readFileSync(new URL("page.tsx", routes), "utf8");

    expect(page).toContain('title: "Inbox"');
    // The composer and the review decisions the Inbox now carries.
    expect(page).toContain("<InboxView />");
  });

  it("gives a review item and a space each their own pushed page", () => {
    expect(readdirSync(new URL("review/[reviewItemId]/", routes))).toContain("page.tsx");
    expect(readdirSync(new URL("spaces/[spaceId]/", routes))).toContain("page.tsx");
  });

  it("puts the search field and the spaces grid in the Library", () => {
    const page = readFileSync(new URL("library/page.tsx", routes), "utf8");

    expect(page).toContain('title: "Library"');
    expect(page).toContain("<LibraryView />");
  });
});
