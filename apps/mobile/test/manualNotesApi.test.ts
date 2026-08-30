import { describe, expect, it, vi } from "vitest";
import { manualNoteFixtures, type EntityId } from "@unfiled/contracts";

import {
  createMobileNotesApi,
  noteTypeLabel,
  relativeUpdatedAt,
  type MobileNotesError
} from "../src/features/notes/mobileNotesApi";

const pageInfo = { hasMore: false, nextCursor: null };

describe("mobile manual notes API", () => {
  it("authenticates reads and decodes note lists", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ items: [], pageInfo }), { status: 200 }))
      );
    const api = createMobileNotesApi("https://api.unfiled.test/", "access-token", fetcher);
    await expect(api.listNotes()).resolves.toEqual([]);
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://api.unfiled.test/api/v1/notes?archive=exclude&deleted=exclude&limit=30"
    );
    expect(new Headers(call?.[1]?.headers).get("Authorization")).toBe("Bearer access-token");
  });

  it("requests a fresh access token for every operation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ items: [], pageInfo }), { status: 200 }))
      );
    const getAccessToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("first-token")
      .mockResolvedValueOnce("refreshed-token");
    const api = createMobileNotesApi("https://api.unfiled.test", getAccessToken, fetcher);

    await api.listNotes();
    await api.listNotes();

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer first-token"
    );
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer refreshed-token"
    );
  });

  it("mirrors caller-owned idempotency keys on writes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(manualNoteFixtures.mutationResult), { status: 200 })
        )
      );
    const api = createMobileNotesApi("https://api.unfiled.test", "access-token", fetcher);
    await api.createNote({
      bodyMarkdown: "Body",
      idempotencyKey: "key_01J00000000000000000000000",
      links: [],
      privacy: "ai_assisted",
      spaceId: null,
      tagIds: [],
      title: "Title",
      type: "generic"
    });
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.unfiled.test/api/v1/notes");
    expect(typeof call?.[1]?.body).toBe("string");
    expect(call?.[1]?.body).toContain("key_01J00000000000000000000000");
    expect(new Headers(call?.[1]?.headers).get("Idempotency-Key")).toBe(
      "key_01J00000000000000000000000"
    );
    expect(call?.[1]?.method).toBe("POST");
  });

  it("surfaces stale revision details without overwriting", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "stale_revision",
          details: { latestRevision: 8 },
          message: "The note changed.",
          requestId: "request-test"
        }),
        { status: 409 }
      )
    );
    const api = createMobileNotesApi("https://api.unfiled.test", "access-token", fetcher);
    await expect(
      api.archiveNote("note_01J00000000000000000000000", 7, "retry-key")
    ).rejects.toMatchObject({
      code: "stale_revision",
      latestRevision: 8,
      status: 409
    } satisfies Partial<MobileNotesError>);
  });

  it("preserves create-time tags and links and sends a typed move", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(manualNoteFixtures.mutationResult), { status: 200 })
        )
      );
    const api = createMobileNotesApi("https://api.unfiled.test", "access-token", fetcher);
    const linkedNoteId = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as EntityId<"note">;
    await api.createNote({
      bodyMarkdown: "Body",
      idempotencyKey: "key_01J00000000000000000000000",
      links: [{ linkType: "related", toNoteId: linkedNoteId }],
      privacy: "ai_assisted",
      spaceId: manualNoteFixtures.space.id,
      tagIds: [manualNoteFixtures.tag.id],
      title: "Title",
      type: "generic"
    });
    await api.moveNote(manualNoteFixtures.note.id, null, 1, "key_01J00000000000000000000001");

    const createBody = fetcher.mock.calls[0]?.[1]?.body;
    const moveBody = fetcher.mock.calls[1]?.[1]?.body;
    expect(typeof createBody).toBe("string");
    expect(typeof moveBody).toBe("string");
    if (typeof createBody !== "string" || typeof moveBody !== "string") {
      throw new Error("Expected serialized JSON request bodies");
    }
    expect(JSON.parse(createBody)).toMatchObject({
      links: [{ linkType: "related", toNoteId: linkedNoteId }],
      tagIds: [manualNoteFixtures.tag.id]
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `https://api.unfiled.test/api/v1/notes/${manualNoteFixtures.note.id}/move`
    );
    expect(JSON.parse(moveBody)).toMatchObject({ spaceId: null });
  });

  it("requests the recoverable-deletion collection explicitly", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ items: [], pageInfo }), { status: 200 }));
    const api = createMobileNotesApi("https://api.unfiled.test", "access-token", fetcher);
    await api.listNotes({ deleted: true });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.unfiled.test/api/v1/notes?archive=exclude&deleted=only&limit=30"
    );
  });

  it("loads the owner-scoped open Review queue", async () => {
    const review = {
      id: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      captureId: null,
      noteId: manualNoteFixtures.note.id,
      type: "structure_conflict",
      choices: [],
      state: "open",
      resolution: null,
      createdAt: "2026-08-30T18:30:00.000Z",
      resolvedAt: null
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [review], pageInfo }), { status: 200 })
      );
    const api = createMobileNotesApi("https://api.unfiled.test", "access-token", fetcher);

    await expect(api.listReviewItems()).resolves.toEqual([review]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.unfiled.test/api/v1/review-items?state=open&limit=30"
    );
  });

  it("follows every advertised cursor without duplicating the first page", async () => {
    const summary = {
      id: manualNoteFixtures.note.id,
      spaceId: manualNoteFixtures.note.spaceId,
      type: manualNoteFixtures.note.type,
      title: manualNoteFixtures.note.title,
      currentRevision: manualNoteFixtures.note.currentRevision,
      isOpen: manualNoteFixtures.note.isOpen,
      pinnedAt: manualNoteFixtures.note.pinnedAt,
      privacy: manualNoteFixtures.note.privacy,
      archivedAt: manualNoteFixtures.note.archivedAt,
      deletedAt: manualNoteFixtures.note.deletedAt,
      updatedAt: manualNoteFixtures.note.updatedAt
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [summary],
            pageInfo: { hasMore: true, nextCursor: "next-page" }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ ...summary, id: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" }],
            pageInfo
          }),
          { status: 200 }
        )
      );
    const api = createMobileNotesApi("https://api.unfiled.test", "access-token", fetcher);

    await expect(api.listNotes()).resolves.toHaveLength(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://api.unfiled.test/api/v1/notes?archive=exclude&deleted=exclude&limit=30&cursor=next-page"
    );
  });

  it("sends only changed note fields so unchanged structured bodies are not reparsed", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(manualNoteFixtures.mutationResult), { status: 200 })
      );
    const api = createMobileNotesApi("https://api.unfiled.test", "access-token", fetcher);
    await api.updateNote(manualNoteFixtures.note.id, {
      expectedRevision: 1,
      idempotencyKey: "key_01J00000000000000000000002",
      spaceId: null
    });
    const requestBody = fetcher.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string") throw new Error("Expected a serialized JSON body");
    expect(JSON.parse(requestBody)).toEqual({
      expectedRevision: 1,
      idempotencyKey: "key_01J00000000000000000000002",
      spaceId: null
    });
  });

  it("formats note types and relative times deterministically", () => {
    expect(noteTypeLabel("principle")).toBe("Principle");
    expect(
      relativeUpdatedAt("2026-08-30T10:00:00.000Z", Date.parse("2026-08-30T12:30:00.000Z"))
    ).toBe("2h");
  });
});
