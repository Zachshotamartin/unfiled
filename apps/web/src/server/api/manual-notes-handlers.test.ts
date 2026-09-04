import {
  ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  ListReviewItemsResponseSchema,
  MutationResultSchema,
  NoteDetailResponseSchema,
  NoteListResponseSchema,
  SearchNotesResponseSchema,
  SpaceMutationResultSchema,
  TagMutationResultSchema,
  USER_HYBRID_SEARCH_RANKING_VERSION,
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  type EncryptedUserSearchMaterial,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequest } from "@/server/auth/session";
import { InMemoryManualNotesRepository } from "@/server/product/in-memory-repository";

import { createManualNotesHandlers } from "./manual-notes-handlers";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOTE_ID = "note_00000000000000000000000001";
const PRIVATE_SEARCH_CURSOR_KEY = Buffer.alloc(32, 7).toString("base64url");

function authenticated(userId = USER_ID): Promise<AuthenticatedRequest> {
  return Promise.resolve({
    accessToken: "test-access-token",
    cookies: [],
    user: { id: userId, email: "person@example.com" }
  });
}

function request(path: string, method = "GET", body?: Record<string, unknown>): Request {
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined;
  return new Request(`https://unfiled.test${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function semanticResult(
  generationRevisionToken: string,
  items: EncryptedUserSearchResult["items"] = []
): EncryptedUserSearchResult {
  return {
    searchId: "00000000-0000-4000-8000-000000000007",
    generationId: "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    generationAttestationDigest: "a".repeat(64),
    generationRevisionToken,
    rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
    items: [...items],
    scannedNoteCount: items.length
  };
}

describe("manual note route handlers", () => {
  it("lists only the authenticated user's notes through the contract shape", async () => {
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      repository: new InMemoryManualNotesRepository()
    });
    const response = await handlers.listNotes(request("/api/v1/notes?limit=30"));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(NoteListResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { items: unknown[] }).items).toHaveLength(2);
  });

  it("advances an opaque note cursor without repeating the first page", async () => {
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      repository: new InMemoryManualNotesRepository()
    });
    const first = await handlers.listNotes(request("/api/v1/notes?limit=1"));
    const firstBody = (await first.json()) as {
      items: { id: string }[];
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    const second = await handlers.listNotes(
      request(`/api/v1/notes?limit=1&cursor=${firstBody.pageInfo.nextCursor ?? ""}`)
    );
    const secondBody = (await second.json()) as {
      items: { id: string }[];
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };

    expect(firstBody.pageInfo.hasMore).toBe(true);
    expect(firstBody.pageInfo.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(second.status).toBe(200);
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);
    expect(secondBody.pageInfo.hasMore).toBe(false);
  });

  it("creates and idempotently replays a note with the same caller-owned key", async () => {
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      repository: new InMemoryManualNotesRepository(false)
    });
    const body = {
      idempotencyKey: "create-note-01J6M9Q7",
      title: "Training log",
      type: "log",
      privacy: "private_manual",
      bodyMarkdown: "5 km"
    };
    const first = await handlers.createNote(request("/api/v1/notes", "POST", body));
    const replay = await handlers.createNote(request("/api/v1/notes", "POST", body));
    const firstBody: unknown = await first.json();
    const replayBody: unknown = await replay.json();
    const mismatched = await handlers.createNote(
      request("/api/v1/notes", "POST", { ...body, title: "Different note" })
    );
    const mismatchBody = (await mismatched.json()) as { code: string };

    expect(first.status).toBe(201);
    expect(MutationResultSchema.safeParse(firstBody).success).toBe(true);
    expect(MutationResultSchema.safeParse(replayBody).success).toBe(true);
    expect((replayBody as { replayed: boolean }).replayed).toBe(true);
    expect((firstBody as { undo: { eligible: boolean } }).undo.eligible).toBe(true);
    expect((replayBody as { note: { id: string } }).note.id).toBe(
      (firstBody as { note: { id: string } }).note.id
    );
    expect(mismatched.status).toBe(409);
    expect(mismatchBody.code).toBe("invalid_idempotency_key");
  });

  it("wakes indexing only after a durable note mutation and passes no user content", async () => {
    const scheduleIndexDrain = vi.fn();
    const repository = new InMemoryManualNotesRepository(false);
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      repository,
      scheduleIndexDrain
    });
    const created = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "index-wakeup-create",
        title: "Private scheduler canary",
        type: "generic"
      })
    );
    expect(created.status).toBe(201);
    expect(scheduleIndexDrain).toHaveBeenCalledOnce();
    expect(scheduleIndexDrain).toHaveBeenCalledWith();

    const invalid = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "index-wakeup-invalid",
        title: "",
        type: "generic"
      })
    );
    expect(invalid.status).toBe(400);
    expect(scheduleIndexDrain).toHaveBeenCalledTimes(1);

    const stale = await handlers.updateNote(
      request(`/api/v1/notes/${NOTE_ID}`, "PATCH", {
        expectedRevision: 99,
        idempotencyKey: "index-wakeup-stale",
        title: "Must not schedule"
      }),
      { noteId: NOTE_ID }
    );
    expect(stale.status).toBe(404);
    expect(scheduleIndexDrain).toHaveBeenCalledTimes(1);
  });

  it("does not turn a completed note mutation into an error when prompt scheduling fails", async () => {
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      repository: new InMemoryManualNotesRepository(false),
      scheduleIndexDrain: () => {
        throw new Error("request lifecycle unavailable");
      }
    });
    const response = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "index-wakeup-failure",
        title: "Durable first",
        type: "generic"
      })
    );
    expect(response.status).toBe(201);
  });

  it("undoes creation by soft deleting at revision two and can undo that inverse", async () => {
    const repository = new InMemoryManualNotesRepository(false);
    const handlers = createManualNotesHandlers({ authenticate: () => authenticated(), repository });
    const created = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "create-undo-note",
        title: "Temporary thought",
        type: "generic"
      })
    );
    const createdBody = (await created.json()) as {
      mutationId: string;
      note: { id: string };
    };
    const deleted = await handlers.undoMutation(
      request(`/api/v1/mutations/${createdBody.mutationId}/undo`, "POST", {
        expectedRevision: 1,
        idempotencyKey: "undo-create-note"
      }),
      { mutationId: createdBody.mutationId }
    );
    const deletedBody = (await deleted.json()) as {
      mutationId: string;
      note: { currentRevision: number; deletedAt: string | null };
      revision: { source: string };
    };
    const restored = await handlers.undoMutation(
      request(`/api/v1/mutations/${deletedBody.mutationId}/undo`, "POST", {
        expectedRevision: 2,
        idempotencyKey: "undo-create-inverse"
      }),
      { mutationId: deletedBody.mutationId }
    );
    const restoredBody = (await restored.json()) as {
      note: { currentRevision: number; deletedAt: string | null };
    };

    expect(deletedBody.note.currentRevision).toBe(2);
    expect(deletedBody.note.deletedAt).not.toBeNull();
    expect(deletedBody.revision.source).toBe("undo");
    expect(restoredBody.note).toMatchObject({ currentRevision: 3, deletedAt: null });
  });

  it("creates a note with its initial tags and links in the first immutable revision", async () => {
    const repository = new InMemoryManualNotesRepository(false);
    const handlers = createManualNotesHandlers({ authenticate: () => authenticated(), repository });
    const tagResponse = await handlers.createTag(
      request("/api/v1/tags", "POST", {
        idempotencyKey: "create-tag-relations",
        name: "training"
      })
    );
    const tagBody = (await tagResponse.json()) as { tag: { id: string } };
    const targetResponse = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "create-target-note",
        title: "Reference note",
        type: "generic"
      })
    );
    const targetBody = (await targetResponse.json()) as { note: { id: string } };
    const created = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "create-related-note",
        title: "Workout plan",
        type: "project",
        bodyMarkdown: "- [ ] Run",
        tagIds: [tagBody.tag.id],
        links: [{ toNoteId: targetBody.note.id, linkType: "related" }]
      })
    );
    const createdBody = (await created.json()) as {
      note: { links: unknown[]; tagIds: string[] };
      revision: { links: unknown[]; tagIds: string[] };
    };

    expect(created.status).toBe(201);
    expect(createdBody.note.tagIds).toEqual([tagBody.tag.id]);
    expect(createdBody.note.links).toEqual([{ toNoteId: targetBody.note.id, linkType: "related" }]);
    expect(createdBody.revision.tagIds).toEqual(createdBody.note.tagIds);
    expect(createdBody.revision.links).toEqual(createdBody.note.links);
  });

  it("preserves replay truth for spaces and tags and rejects key reuse with a new payload", async () => {
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      repository: new InMemoryManualNotesRepository(false)
    });
    const spaceRequest = {
      idempotencyKey: "space-idempotency-01",
      name: "Health",
      parentId: null,
      sortKey: "r000042"
    };
    const firstSpace = await handlers.createSpace(request("/api/v1/spaces", "POST", spaceRequest));
    const replayedSpace = await handlers.createSpace(
      request("/api/v1/spaces", "POST", spaceRequest)
    );
    const changedSpace = await handlers.createSpace(
      request("/api/v1/spaces", "POST", { ...spaceRequest, name: "Work" })
    );
    const replayedSpaceBody: unknown = await replayedSpace.json();

    expect(SpaceMutationResultSchema.safeParse(await firstSpace.json()).success).toBe(true);
    expect(SpaceMutationResultSchema.safeParse(replayedSpaceBody).success).toBe(true);
    expect((replayedSpaceBody as { replayed: boolean }).replayed).toBe(true);
    expect(changedSpace.status).toBe(409);

    const tagRequest = { idempotencyKey: "tag-idempotency-01", name: "health" };
    const firstTag = await handlers.createTag(request("/api/v1/tags", "POST", tagRequest));
    const replayedTag = await handlers.createTag(request("/api/v1/tags", "POST", tagRequest));
    const changedTag = await handlers.createTag(
      request("/api/v1/tags", "POST", { ...tagRequest, name: "work" })
    );
    const replayedTagBody: unknown = await replayedTag.json();

    expect(TagMutationResultSchema.safeParse(await firstTag.json()).success).toBe(true);
    expect(TagMutationResultSchema.safeParse(replayedTagBody).success).toBe(true);
    expect((replayedTagBody as { replayed: boolean }).replayed).toBe(true);
    expect(changedTag.status).toBe(409);
  });

  it("applies a PATCH space move atomically and rejects a stale space rename", async () => {
    const repository = new InMemoryManualNotesRepository(false);
    const handlers = createManualNotesHandlers({ authenticate: () => authenticated(), repository });
    const createdSpace = await handlers.createSpace(
      request("/api/v1/spaces", "POST", {
        idempotencyKey: "create-space-for-patch",
        name: "Training",
        parentId: null
      })
    );
    const spaceBody = (await createdSpace.json()) as {
      space: { currentRevision: number; id: string };
    };
    const createdNote = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "create-note-for-patch",
        title: "Intervals",
        type: "generic"
      })
    );
    const noteBody = (await createdNote.json()) as {
      note: { currentRevision: number; id: string };
    };
    const moved = await handlers.updateNote(
      request(`/api/v1/notes/${noteBody.note.id}`, "PATCH", {
        expectedRevision: noteBody.note.currentRevision,
        idempotencyKey: "patch-note-space",
        spaceId: spaceBody.space.id
      }),
      { noteId: noteBody.note.id }
    );
    const movedBody = (await moved.json()) as { note: { spaceId: string } };
    expect(movedBody.note.spaceId).toBe(spaceBody.space.id);

    const renamed = await handlers.updateSpace(
      request(`/api/v1/spaces/${spaceBody.space.id}`, "PATCH", {
        expectedRevision: spaceBody.space.currentRevision,
        idempotencyKey: "rename-space-once",
        name: "Training log"
      }),
      { spaceId: spaceBody.space.id }
    );
    expect(renamed.status).toBe(200);
    const stale = await handlers.updateSpace(
      request(`/api/v1/spaces/${spaceBody.space.id}`, "PATCH", {
        expectedRevision: spaceBody.space.currentRevision,
        idempotencyKey: "rename-space-stale",
        name: "Should not win"
      }),
      { spaceId: spaceBody.space.id }
    );
    expect(stale.status).toBe(409);
  });

  it("rejects stale writes without changing the saved note", async () => {
    const repository = new InMemoryManualNotesRepository();
    const handlers = createManualNotesHandlers({ authenticate: () => authenticated(), repository });
    const response = await handlers.updateNote(
      request(`/api/v1/notes/${NOTE_ID}`, "PATCH", {
        expectedRevision: 99,
        idempotencyKey: "stale-write-01J6M9Q7",
        title: "Should not win"
      }),
      { noteId: NOTE_ID }
    );
    const error = (await response.json()) as { code: string };
    const detail = await handlers.getNote(request(`/api/v1/notes/${NOTE_ID}`), { noteId: NOTE_ID });
    const detailBody: unknown = await detail.json();

    expect(response.status).toBe(409);
    expect(error.code).toBe("stale_revision");
    expect(NoteDetailResponseSchema.safeParse(detailBody).success).toBe(true);
    expect((detailBody as { note: { title: string } }).note.title).toBe("Shopping");
  });

  it("returns the photos a note places so a client renders them without parsing the body", async () => {
    const repository = new InMemoryManualNotesRepository(false);
    const handlers = createManualNotesHandlers({ authenticate: () => authenticated(), repository });
    const photo = "att_00000000000000000000000001";
    const created = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "attachment-note-create",
        title: "Kitchen receipt",
        type: "generic",
        bodyMarkdown: `Lunch\n\n![Photo](unfiled-attachment:${photo})`
      })
    );
    const createdBody = (await created.json()) as { note: { id: string } };
    const detail = await handlers.getNote(request(`/api/v1/notes/${createdBody.note.id}`), {
      noteId: createdBody.note.id
    });
    const detailBody: unknown = await detail.json();

    expect(created.status).toBe(201);
    expect(MutationResultSchema.safeParse(createdBody).success).toBe(true);
    expect(NoteDetailResponseSchema.safeParse(detailBody).success).toBe(true);
    expect((detailBody as { note: { attachments: unknown } }).note.attachments).toEqual([
      { id: photo, kind: "image" }
    ]);
  });

  it("keeps an ambiguous structured edit unchanged and exposes its durable review item", async () => {
    const repository = new InMemoryManualNotesRepository(false);
    const handlers = createManualNotesHandlers({ authenticate: () => authenticated(), repository });
    const created = await handlers.createNote(
      request("/api/v1/notes", "POST", {
        idempotencyKey: "review-list-create",
        title: "Review list",
        type: "list",
        bodyMarkdown: "- [ ] milk"
      })
    );
    const createdBody = (await created.json()) as {
      note: { bodyMarkdown: string; currentRevision: number; id: string };
    };
    const conflictRequest = {
      expectedRevision: 1,
      idempotencyKey: "review-list-conflict",
      bodyMarkdown: "- milk\nplain prose"
    };
    const conflict = await handlers.updateNote(
      request(`/api/v1/notes/${createdBody.note.id}`, "PATCH", conflictRequest),
      { noteId: createdBody.note.id }
    );
    const retriedConflict = await handlers.updateNote(
      request(`/api/v1/notes/${createdBody.note.id}`, "PATCH", conflictRequest),
      { noteId: createdBody.note.id }
    );
    const saved = await handlers.getNote(request(`/api/v1/notes/${createdBody.note.id}`), {
      noteId: createdBody.note.id
    });
    const savedBody = (await saved.json()) as {
      note: { bodyMarkdown: string; currentRevision: number };
    };
    const review = await handlers.listReviewItems(
      request("/api/v1/review-items?state=open&limit=30")
    );
    const reviewBody: unknown = await review.json();
    const invalidReview = await handlers.listReviewItems(
      request("/api/v1/review-items?state=private-canary")
    );

    expect(conflict.status).toBe(409);
    expect(retriedConflict.status).toBe(409);
    expect((await conflict.json()) as { code: string }).toMatchObject({
      code: "structure_conflict"
    });
    expect(savedBody.note).toMatchObject({
      bodyMarkdown: createdBody.note.bodyMarkdown,
      currentRevision: 1
    });
    expect(ListReviewItemsResponseSchema.safeParse(reviewBody).success).toBe(true);
    expect(review.headers.get("cache-control")).toBe("private, no-store");
    expect(review.headers.get("pragma")).toBe("no-cache");
    expect(invalidReview.status).toBe(400);
    expect(invalidReview.headers.get("cache-control")).toBe("private, no-store");
    expect(invalidReview.headers.get("pragma")).toBe("no-cache");
    expect(await invalidReview.text()).not.toContain("private-canary");
    const reviewItems = (
      reviewBody as {
        items: { noteId: string; type: string }[];
      }
    ).items;
    expect(reviewItems).toContainEqual(
      expect.objectContaining({ noteId: createdBody.note.id, type: "structure_conflict" })
    );
    expect(
      reviewItems.filter(
        (item) => item.noteId === createdBody.note.id && item.type === "structure_conflict"
      )
    ).toHaveLength(1);
  });

  it("accepts private POST search bodies and gives the current request to repository factories", async () => {
    let factoryRequest: Request | undefined;
    const repository = new InMemoryManualNotesRepository();
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository: (currentRequest) => {
        factoryRequest = currentRequest;
        return repository;
      }
    });
    const incoming = request("/api/v1/search", "POST", {
      query: " milk ",
      archive: "exclude",
      limit: 30
    });
    const response = await handlers.search(incoming);
    const body: unknown = await response.json();

    expect(factoryRequest).toBe(incoming);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(SearchNotesResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { items: { title: string }[] }).items).toEqual([
      expect.objectContaining({ title: "Shopping" })
    ]);
  });

  it("dispatches semantics only for explicitly admitted ai_assisted privacy", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const current = await repository.getNote(context, NOTE_ID);
    const untrustedSemanticReference = {
      noteId: current.id,
      indexedRevision: current.currentRevision,
      score: 0.9,
      title: "UNTRUSTED SEMANTIC TITLE",
      snippet: "UNTRUSTED SEMANTIC SNIPPET"
    };
    const semanticQuery = vi
      .fn()
      .mockResolvedValue(semanticResult("generation-7", [untrustedSemanticReference]));
    const semanticSearch = vi.fn(() => ({ search: semanticQuery }));
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository,
      semanticSearch
    });

    const nonSemanticResponses = await Promise.all([
      handlers.search(request("/api/v1/search", "POST", { query: "milk" })),
      handlers.search(
        request("/api/v1/search", "POST", {
          query: "milk",
          privacy: "private_manual"
        })
      ),
      handlers.search(
        request("/api/v1/search", "POST", {
          query: "milk",
          privacy: "mixed"
        })
      )
    ]);

    expect(nonSemanticResponses.map(({ status }) => status)).toEqual([200, 200, 400]);
    expect(semanticSearch).not.toHaveBeenCalled();
    expect(semanticQuery).not.toHaveBeenCalled();

    const aiResponse = await handlers.search(
      request("/api/v1/search", "POST", {
        query: " MILK ",
        archive: "exclude",
        privacy: "ai_assisted",
        type: "list",
        spaceId: "spc_00000000000000000000000001",
        updatedFrom: "2026-08-01T00:00:00.000Z",
        updatedTo: "2026-09-01T00:00:00.000Z",
        limit: 5
      })
    );
    const aiBody = (await aiResponse.json()) as { items: { title: string }[] };

    expect(aiResponse.status).toBe(200);
    expect(aiBody.items).toEqual([expect.objectContaining({ title: "Shopping" })]);
    expect(JSON.stringify(aiBody)).not.toContain("UNTRUSTED");
    expect(semanticSearch).toHaveBeenCalledExactlyOnceWith(
      { accessToken: "test-access-token", userId: USER_ID },
      expect.any(AbortSignal)
    );
    expect(semanticQuery).toHaveBeenCalledExactlyOnceWith(
      {
        requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
        hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
        query: "milk",
        filters: {
          archive: "exclude",
          privacy: "ai_assisted",
          type: "list",
          space: { id: "spc_00000000000000000000000001", mode: "exact" },
          tagIds: [],
          updatedFrom: "2026-08-01T00:00:00.000Z",
          updatedTo: "2026-09-01T00:00:00.000Z"
        },
        pageLimit: 5,
        maxResults: 8,
        continuation: null
      },
      expect.any(AbortSignal)
    );
  });

  it("returns a fresh lexical-only page when semantic search fails", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const initial = await repository.getNote(context, NOTE_ID);
    const fresh = await repository.getNote(context, "note_00000000000000000000000003");
    const search = vi
      .spyOn(repository, "search")
      .mockResolvedValueOnce({
        query: "commit",
        results: [{ note: initial, score: 0.8, snippet: "initial snapshot" }]
      })
      .mockResolvedValueOnce({
        query: "commit",
        results: [{ note: fresh, score: 0.9, snippet: "fresh snapshot" }]
      });
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository,
      semanticSearch: () => ({
        search: vi.fn().mockRejectedValue(new Error("semantic provider canary"))
      })
    });

    const response = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "commit",
        privacy: "ai_assisted"
      })
    );
    const serialized = await response.text();

    expect(response.status).toBe(200);
    expect(serialized).toContain("fresh snapshot");
    expect(serialized).not.toContain("initial snapshot");
    expect(serialized).not.toContain("semantic provider canary");
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("keeps an ai-assisted fallback cursor on one lexical-only chain through its terminal page", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const firstNote = await repository.getNote(context, NOTE_ID);
    const secondNote = await repository.getNote(context, "note_00000000000000000000000003");
    const thirdNote = (
      await repository.createNote(
        context,
        {
          bodyMarkdown: "Third fallback body",
          links: [],
          privacy: "ai_assisted",
          spaceId: null,
          tagIds: [],
          title: "Third fallback",
          type: "generic"
        },
        "fallback-page-three"
      )
    ).note;
    const search = vi.spyOn(repository, "search").mockImplementation((_context, query) =>
      Promise.resolve({
        query,
        results: [
          { note: firstNote, score: 0.9, snippet: "first" },
          { note: secondNote, score: 0.8, snippet: "second" },
          { note: thirdNote, score: 0.7, snippet: "third" }
        ]
      })
    );
    const semanticQuery = vi.fn().mockRejectedValue(new Error("semantic provider canary"));
    const semanticSearch = vi.fn(() => ({ search: semanticQuery }));
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository,
      semanticSearch
    });
    const collected: string[] = [];
    const pageInfo: { hasMore: boolean; nextCursor: string | null }[] = [];
    let cursor: string | null = null;

    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const response = await handlers.search(
        request("/api/v1/search", "POST", {
          query: "fallback",
          privacy: "ai_assisted",
          limit: 1,
          ...(cursor === null ? {} : { cursor })
        })
      );
      const body = (await response.json()) as {
        items: { noteId: string }[];
        pageInfo: { hasMore: boolean; nextCursor: string | null };
      };
      expect(response.status).toBe(200);
      collected.push(...body.items.map(({ noteId }) => noteId));
      pageInfo.push(body.pageInfo);
      cursor = body.pageInfo.nextCursor;
    }

    expect(collected).toEqual([firstNote.id, secondNote.id, thirdNote.id]);
    expect(new Set(collected).size).toBe(3);
    expect(pageInfo.map(({ hasMore }) => hasMore)).toEqual([true, true, false]);
    expect(pageInfo.at(-1)?.nextCursor).toBeNull();
    expect(semanticSearch).toHaveBeenCalledOnce();
    expect(semanticQuery).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledTimes(4);
  });

  it("keeps lexical matches after result 100 reachable through the signed cursor", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const template = await repository.getNote(context, NOTE_ID);
    const results = Array.from({ length: 102 }, (_, index) => {
      const ordinal = index + 1;
      const noteId: typeof template.id = `note_${String(ordinal).padStart(26, "0")}`;
      return {
        note: {
          ...template,
          id: noteId,
          title: `Reachable result ${ordinal}`
        },
        score: 0.8,
        snippet: `reachable ${ordinal}`
      };
    });
    const search = vi.spyOn(repository, "search").mockImplementation((_context, query) =>
      Promise.resolve({
        query,
        results
      })
    );
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository
    });

    const first = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "reachable",
        privacy: "private_manual",
        limit: 100
      })
    );
    const firstBody = (await first.json()) as {
      items: { noteId: string }[];
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    if (firstBody.pageInfo.nextCursor === null) throw new Error("expected a search cursor");
    const second = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "reachable",
        privacy: "private_manual",
        limit: 100,
        cursor: firstBody.pageInfo.nextCursor
      })
    );
    const secondBody = (await second.json()) as {
      items: { noteId: string }[];
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };

    expect(first.status).toBe(200);
    expect(firstBody.items).toHaveLength(100);
    expect(firstBody.pageInfo.hasMore).toBe(true);
    expect(second.status).toBe(200);
    expect(secondBody.items.map(({ noteId }) => noteId)).toEqual(
      results.slice(100).map(({ note }) => note.id)
    );
    expect(secondBody.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(1, context, "reachable", {
      archived: "exclude",
      limit: 1_000,
      offset: 0,
      privacy: "private_manual"
    });
  });

  it("binds opaque randomized cursors to the normalized private query and archive filter", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const note = await repository.getNote(context, NOTE_ID);
    const secondNote = await repository.getNote(context, "note_00000000000000000000000003");
    const search = vi.spyOn(repository, "search").mockImplementation((_context, query) =>
      Promise.resolve({
        query,
        results: [
          { note, score: 0.8, snippet: "" },
          { note: secondNote, score: 0.8, snippet: "" }
        ]
      })
    );
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository
    });

    const first = await handlers.search(
      request("/api/v1/search", "POST", {
        query: " PRIVATE   ALPHA ",
        archive: "exclude",
        privacy: "private_manual",
        type: "generic",
        limit: 1
      })
    );
    const repeated = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "private alpha",
        archive: "exclude",
        privacy: "private_manual",
        type: "generic",
        limit: 1
      })
    );
    const firstBody = (await first.json()) as {
      items: { noteId: string }[];
      pageInfo: { nextCursor: string | null };
    };
    const repeatedBody = (await repeated.json()) as {
      pageInfo: { nextCursor: string | null };
    };
    const cursor = firstBody.pageInfo.nextCursor;
    if (cursor === null) throw new Error("expected a private search cursor");

    const continuation = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "private alpha",
        archive: "exclude",
        privacy: "private_manual",
        type: "generic",
        cursor,
        limit: 1
      })
    );
    const continuationBody = (await continuation.json()) as {
      items: { noteId: string }[];
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    const crossQuery = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "private beta",
        archive: "exclude",
        privacy: "private_manual",
        type: "generic",
        cursor,
        limit: 1
      })
    );
    const crossArchive = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "private alpha",
        archive: "include",
        privacy: "private_manual",
        type: "generic",
        cursor,
        limit: 1
      })
    );
    const tamperedCursor = `${cursor.startsWith("A") ? "B" : "A"}${cursor.slice(1)}`;
    const tampered = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "private alpha",
        archive: "exclude",
        privacy: "private_manual",
        type: "generic",
        cursor: tamperedCursor,
        limit: 1
      })
    );
    const otherOwnerHandlers = createManualNotesHandlers({
      authenticate: () => authenticated("00000000-0000-4000-8000-000000000002"),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository
    });
    const crossOwner = await otherOwnerHandlers.search(
      request("/api/v1/search", "POST", {
        query: "private alpha",
        archive: "exclude",
        privacy: "private_manual",
        type: "generic",
        cursor,
        limit: 1
      })
    );

    expect(first.status).toBe(200);
    expect(continuation.status).toBe(200);
    expect(firstBody.items.map(({ noteId }) => noteId)).toEqual([note.id]);
    expect(continuationBody.items.map(({ noteId }) => noteId)).toEqual([secondNote.id]);
    expect(continuationBody.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/u);
    expect(Buffer.from(cursor, "base64url").toString("utf8")).not.toContain("private alpha");
    expect(repeatedBody.pageInfo.nextCursor).not.toBe(cursor);
    expect(crossQuery.status).toBe(400);
    expect(crossArchive.status).toBe(400);
    expect(tampered.status).toBe(400);
    expect(crossOwner.status).toBe(400);
    expect(await crossQuery.text()).not.toContain("private beta");
    expect(await crossArchive.text()).not.toContain("private alpha");
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls[0]?.[1]).toBe("private alpha");
    expect(search.mock.calls[2]?.[2]).toEqual({
      archived: "exclude",
      limit: 1_000,
      offset: 0,
      privacy: "private_manual",
      type: "generic"
    });
  });

  it("binds every normalized search filter into the signed cursor", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const firstNote = await repository.getNote(context, NOTE_ID);
    const secondNote = await repository.getNote(context, "note_00000000000000000000000003");
    const search = vi.spyOn(repository, "search").mockImplementation((_context, query) =>
      Promise.resolve({
        query,
        results: [
          { note: firstNote, score: 0.8, snippet: "first" },
          { note: secondNote, score: 0.7, snippet: "second" }
        ]
      })
    );
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository
    });
    const filters = {
      query: "private alpha",
      archive: "exclude",
      privacy: "private_manual",
      type: "generic",
      spaceId: "spc_00000000000000000000000001",
      tagIds: ["tag_00000000000000000000000002", "tag_00000000000000000000000001"],
      updatedFrom: "2026-08-01T00:00:00.000Z",
      updatedTo: "2026-09-01T00:00:00.000Z",
      limit: 1
    };
    const first = await handlers.search(request("/api/v1/search", "POST", filters));
    const firstBody = (await first.json()) as { pageInfo: { nextCursor: string | null } };
    const cursor = firstBody.pageInfo.nextCursor;
    if (cursor === null) throw new Error("expected a private search cursor");

    const variants: Record<string, unknown>[] = [
      { ...filters, archive: "include", cursor },
      { ...filters, privacy: undefined, cursor },
      { ...filters, type: "principle", cursor },
      { ...filters, spaceId: null, cursor },
      {
        ...filters,
        tagIds: ["tag_00000000000000000000000003"],
        cursor
      },
      { ...filters, updatedFrom: "2026-08-02T00:00:00.000Z", cursor },
      { ...filters, updatedTo: "2026-08-31T00:00:00.000Z", cursor },
      { ...filters, limit: 2, cursor }
    ];
    const responses = [];
    for (const variant of variants) {
      responses.push(await handlers.search(request("/api/v1/search", "POST", variant)));
    }

    expect(first.status).toBe(200);
    expect(responses.map(({ status }) => status)).toEqual(variants.map(() => 400));
    expect(search).toHaveBeenCalledOnce();
  });

  it("verifies a semantic cursor before dispatch and returns a nonrepeating reordered page two", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const firstNote = await repository.getNote(context, NOTE_ID);
    const secondNote = await repository.getNote(context, "note_00000000000000000000000003");
    const search = vi
      .spyOn(repository, "search")
      .mockResolvedValueOnce({
        query: "private alpha",
        results: [
          { note: secondNote, score: 0.7, snippet: "second" },
          { note: firstNote, score: 0.8, snippet: "first" }
        ]
      })
      .mockResolvedValueOnce({
        query: "private alpha",
        results: [
          { note: firstNote, score: 0.8, snippet: "first" },
          { note: secondNote, score: 0.7, snippet: "second" }
        ]
      });
    const semanticQuery = vi
      .fn<(material: EncryptedUserSearchMaterial) => Promise<EncryptedUserSearchResult>>()
      .mockResolvedValue(
        semanticResult("private-generation-token-7", [
          {
            noteId: firstNote.id,
            indexedRevision: firstNote.currentRevision,
            score: 0.9
          },
          {
            noteId: secondNote.id,
            indexedRevision: secondNote.currentRevision,
            score: 0.85
          }
        ])
      );
    const semanticSearch = vi.fn(() => ({ search: semanticQuery }));
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository,
      semanticSearch
    });
    const body = {
      query: "private alpha",
      privacy: "ai_assisted",
      limit: 1
    };
    const first = await handlers.search(request("/api/v1/search", "POST", body));
    const firstBody = (await first.json()) as {
      items: { noteId: string }[];
      pageInfo: { nextCursor: string | null };
    };
    const cursor = firstBody.pageInfo.nextCursor;
    if (cursor === null) throw new Error("expected a semantic search cursor");
    const decodedCursor = Buffer.from(cursor, "base64url").toString("utf8");
    const tamperedCursor = `${cursor.startsWith("A") ? "B" : "A"}${cursor.slice(1)}`;
    const tampered = await handlers.search(
      request("/api/v1/search", "POST", { ...body, cursor: tamperedCursor })
    );
    const second = await handlers.search(request("/api/v1/search", "POST", { ...body, cursor }));
    const secondBody = (await second.json()) as {
      items: { noteId: string }[];
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };

    expect(first.status).toBe(200);
    expect(tampered.status).toBe(400);
    expect(second.status).toBe(200);
    expect(firstBody.items.map(({ noteId }) => noteId)).toEqual([firstNote.id]);
    expect(secondBody.items.map(({ noteId }) => noteId)).toEqual([secondNote.id]);
    expect(secondBody.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    expect(decodedCursor).not.toContain("private alpha");
    expect(decodedCursor).not.toContain("private-generation-token-7");
    expect(decodedCursor).not.toContain("igen_01ARZ3NDEKTSV4RRFFQ69G5FAA");
    expect(decodedCursor).not.toContain("a".repeat(64));
    expect(semanticSearch).toHaveBeenCalledTimes(2);
    expect(semanticQuery).toHaveBeenCalledTimes(2);
    expect(semanticQuery.mock.calls[0]?.[0]).toMatchObject({
      continuation: null,
      maxResults: 8,
      pageLimit: 1
    });
    const secondMaterial = semanticQuery.mock.calls[1]?.[0];
    expect(secondMaterial).toMatchObject({ maxResults: 8, pageLimit: 1 });
    expect(secondMaterial?.continuation?.boundary).toEqual({
      indexedRevision: secondNote.currentRevision,
      noteId: secondNote.id,
      score: 0.85
    });
    expect(secondMaterial?.continuation?.generationBindingDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(secondMaterial?.continuation?.resultDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("resets a valid cursor to a fresh lexical first page when its hybrid boundary is stale", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const firstNote = await repository.getNote(context, NOTE_ID);
    const secondNote = await repository.getNote(context, "note_00000000000000000000000003");
    const changedBoundary = { ...firstNote, currentRevision: 2 };
    const search = vi
      .spyOn(repository, "search")
      .mockResolvedValueOnce({
        query: "private alpha",
        results: [
          { note: firstNote, score: 0.8, snippet: "first" },
          { note: secondNote, score: 0.7, snippet: "second" }
        ]
      })
      .mockResolvedValueOnce({
        query: "private alpha",
        results: [
          { note: changedBoundary, score: 0.8, snippet: "changed" },
          { note: secondNote, score: 0.7, snippet: "second" }
        ]
      })
      .mockResolvedValueOnce({
        query: "private alpha",
        results: [{ note: secondNote, score: 0.7, snippet: "fresh lexical" }]
      });
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository
    });
    const body = {
      query: "private alpha",
      privacy: "private_manual",
      limit: 1
    };
    const first = await handlers.search(request("/api/v1/search", "POST", body));
    const firstBody = (await first.json()) as { pageInfo: { nextCursor: string | null } };
    const cursor = firstBody.pageInfo.nextCursor;
    if (cursor === null) throw new Error("expected a private search cursor");

    const stale = await handlers.search(request("/api/v1/search", "POST", { ...body, cursor }));
    const staleBody = (await stale.json()) as { items: { noteId: string; snippet: string }[] };

    expect(stale.status).toBe(200);
    expect(staleBody.items).toEqual([
      expect.objectContaining({ noteId: secondNote.id, snippet: "fresh lexical" })
    ]);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("rejects a semantic continuation after attestation rollover without exposing tokens", async () => {
    const repository = new InMemoryManualNotesRepository();
    const context = { accessToken: "test-access-token", userId: USER_ID };
    const firstNote = await repository.getNote(context, NOTE_ID);
    const secondNote = await repository.getNote(context, "note_00000000000000000000000003");
    vi.spyOn(repository, "search").mockImplementation((_context, query) =>
      Promise.resolve({
        query,
        results: [
          { note: firstNote, score: 0.8, snippet: "first" },
          { note: secondNote, score: 0.7, snippet: "second" }
        ]
      })
    );
    const semanticQuery = vi
      .fn()
      .mockResolvedValueOnce(semanticResult("private-generation-token-7"))
      .mockResolvedValueOnce({
        ...semanticResult("private-generation-token-7"),
        generationAttestationDigest: "b".repeat(64)
      });
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => PRIVATE_SEARCH_CURSOR_KEY,
      repository,
      semanticSearch: () => ({ search: semanticQuery })
    });
    const first = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "private alpha",
        privacy: "ai_assisted",
        limit: 1
      })
    );
    const firstBody = (await first.json()) as { pageInfo: { nextCursor: string | null } };
    const cursor = firstBody.pageInfo.nextCursor;
    if (cursor === null) throw new Error("expected a semantic search cursor");

    const stale = await handlers.search(
      request("/api/v1/search", "POST", {
        query: "private alpha",
        privacy: "ai_assisted",
        limit: 1,
        cursor
      })
    );
    const serialized = await stale.text();

    expect(stale.status).toBe(200);
    expect(JSON.parse(serialized)).toMatchObject({
      items: [{ noteId: firstNote.id }]
    });
    expect(serialized).not.toContain("private-generation-token-7");
    expect(serialized).not.toContain("b".repeat(64));
    expect(semanticQuery).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-base64url-key-material"],
    ["wrong length", Buffer.alloc(31, 7).toString("base64url")],
    ["noncanonical", `${PRIVATE_SEARCH_CURSOR_KEY.slice(0, -1)}d`]
  ])("fails private search closed for a %s cursor key", async (_name, cursorKey) => {
    const repository = new InMemoryManualNotesRepository();
    const search = vi.spyOn(repository, "search");
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      getPrivateSearchCursorKey: () => cursorKey,
      repository
    });

    const response = await handlers.search(
      request("/api/v1/search", "POST", { query: "private key canary" })
    );
    const serialized = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(serialized).not.toContain("private key canary");
    expect(serialized).not.toContain(cursorKey ?? "private key canary");
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects query-string, unknown-field, malformed, and oversized searches without echoing input", async () => {
    const canary = "private-search-canary-keep-out-of-errors";
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated(),
      repository: new InMemoryManualNotesRepository()
    });
    const requests = [
      request(`/api/v1/search?q=${encodeURIComponent(canary)}`, "POST", { query: "milk" }),
      request("/api/v1/search", "POST", { query: canary, unexpected: true }),
      new Request("https://unfiled.test/api/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      }),
      new Request("https://unfiled.test/api/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: canary.repeat(200) })
      })
    ];

    for (const [index, privateRequest] of requests.entries()) {
      const response = await handlers.search(privateRequest);
      const serialized = await response.text();
      expect(response.status).toBe(index === requests.length - 1 ? 413 : 400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(serialized).not.toContain(canary);
    }
  });

  it("does not reveal another user's note", async () => {
    const handlers = createManualNotesHandlers({
      authenticate: () => authenticated("00000000-0000-4000-8000-000000000002"),
      repository: new InMemoryManualNotesRepository()
    });
    const response = await handlers.getNote(request(`/api/v1/notes/${NOTE_ID}`), {
      noteId: NOTE_ID
    });
    expect(response.status).toBe(404);
  });
});
