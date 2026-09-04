import type { Space } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SPACES_QUERY, SpaceCard, isArchivedSpace, orderSpaces } from "./spaces-view";
import { siblingsOf } from "./space-view";

function space(overrides: Partial<Space> = {}): Space {
  return {
    archivedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    currentRevision: 3,
    id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FA1",
    name: "Life",
    parentId: null,
    slug: "life",
    sortKey: "r000001",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides
  };
}

describe("Spaces in the Library", () => {
  it("asks the server for archived spaces too, so archiving is not a one-way door", () => {
    // `listSpaces` defaults `includeArchived` to false. Without this the archived space is gone
    // from Spaces, from the routing-rule destination picker, and from the note inspector, and
    // nothing in the web could ever send `archived: false` to bring it back.
    expect(SPACES_QUERY).toContain("includeArchived=true");
  });

  it("separates the archived spaces from the ones still in use", () => {
    const kept = space();
    const gone = space({
      archivedAt: "2026-09-02T10:00:00.000Z",
      id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FA2",
      name: "Old"
    });

    expect(isArchivedSpace(kept)).toBe(false);
    expect(isArchivedSpace(gone)).toBe(true);
  });

  it("orders roots first with each child under its parent", () => {
    const parent = space({
      id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FA1",
      name: "Life",
      sortKey: "r000001"
    });
    const other = space({ id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FA3", name: "Work", sortKey: "r000002" });
    const child = space({
      id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FA2",
      name: "Health",
      parentId: parent.id,
      sortKey: "r000001"
    });

    expect(orderSpaces([other, child, parent]).map((entry) => entry.name)).toEqual([
      "Life",
      "Health",
      "Work"
    ]);
  });

  it("reorders a space only among the siblings that share its parent", () => {
    const parent = space({ id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FA1", sortKey: "r000001" });
    const child = space({
      id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FA2",
      name: "Health",
      parentId: parent.id,
      sortKey: "r000001"
    });
    const archivedChild = space({
      archivedAt: "2026-09-02T10:00:00.000Z",
      id: "spc_01ARZ3NDEKTSV4RRFFQ69G5FA4",
      name: "Retired",
      parentId: parent.id,
      sortKey: "r000002"
    });

    expect(siblingsOf([parent, child, archivedChild], child).map((entry) => entry.name)).toEqual([
      "Health"
    ]);
  });

  it("pushes a space's own page from its card", () => {
    const html = renderToStaticMarkup(<SpaceCard parentName={null} space={space()} />);

    expect(html).toContain('href="/app/spaces/spc_01ARZ3NDEKTSV4RRFFQ69G5FA1"');
    expect(html).toContain("Life");
  });
});
