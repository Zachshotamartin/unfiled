import { describe, expect, it } from "vitest";

import { archiveSpace, createSpace, updateSpace } from "../src/index.js";

const NOW = "2026-08-30T18:30:00.000Z";

describe("space aggregate", () => {
  it("creates immutable normalized root and one-level child spaces", () => {
    const root = createSpace({
      id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      userId: "00000000-0000-4000-8000-000000000001",
      name: " Work Projects ",
      now: NOW
    });
    const child = createSpace({
      id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      userId: root.userId,
      name: "Launch",
      parentId: root.id,
      parent: root,
      now: NOW
    });
    expect(root).toMatchObject({ name: "Work Projects", slug: "work-projects", parentId: null });
    expect(child.parentId).toBe(root.id);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("rejects deeper nesting and cross-user parents", () => {
    const root = createSpace({
      id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      userId: "00000000-0000-4000-8000-000000000001",
      name: "Root",
      now: NOW
    });
    const child = createSpace({
      id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      userId: root.userId,
      name: "Child",
      parentId: root.id,
      parent: root,
      now: NOW
    });
    expect(() =>
      createSpace({
        id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
        userId: root.userId,
        name: "Too deep",
        parentId: child.id,
        parent: child,
        now: NOW
      })
    ).toThrow(/validation_failed/u);
    expect(() =>
      createSpace({
        id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
        userId: "00000000-0000-4000-8000-000000000002",
        name: "Wrong owner",
        parentId: root.id,
        parent: root,
        now: NOW
      })
    ).toThrow(/forbidden/u);
    expect(() =>
      createSpace({
        id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Z",
        userId: root.userId,
        name: "Missing parent",
        parentId: root.id,
        now: NOW
      })
    ).toThrow(/validation_failed/u);
  });

  it("updates and archives without mutating the original", () => {
    const original = createSpace({
      id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      userId: "00000000-0000-4000-8000-000000000001",
      name: "Work",
      now: NOW
    });
    const renamed = updateSpace(original, {
      expectedRevision: original.currentRevision,
      name: "Projects",
      now: NOW
    });
    const archived = archiveSpace(renamed, {
      archived: true,
      expectedRevision: renamed.currentRevision,
      now: NOW
    });
    expect(archived).toMatchObject({
      archivedAt: NOW,
      currentRevision: 3,
      name: "Projects",
      slug: "projects"
    });
    expect(original).toMatchObject({ name: "Work", archivedAt: null, currentRevision: 1 });
    expect(
      archiveSpace(archived, {
        archived: false,
        expectedRevision: archived.currentRevision,
        now: NOW
      }).archivedAt
    ).toBeNull();
    expect(() => updateSpace(archived, { expectedRevision: 1, name: "Stale", now: NOW })).toThrow(
      /stale_revision/u
    );
  });

  it("normalizes Unicode slugs and rejects names without URL-safe characters", () => {
    const accented = createSpace({
      id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      userId: "00000000-0000-4000-8000-000000000001",
      name: "  Café   Plans  ",
      sortKey: "b0",
      now: NOW
    });
    expect(accented).toMatchObject({ name: "Café Plans", slug: "cafe-plans", sortKey: "b0" });
    expect(
      updateSpace(accented, {
        expectedRevision: accented.currentRevision,
        sortKey: "c0",
        now: NOW
      }).sortKey
    ).toBe("c0");
    expect(() =>
      createSpace({
        id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
        userId: accented.userId,
        name: "  ",
        now: NOW
      })
    ).toThrow(/validation_failed/u);
    expect(() =>
      createSpace({
        id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
        userId: accented.userId,
        name: "✨",
        now: NOW
      })
    ).toThrow(/validation_failed/u);
  });
});
