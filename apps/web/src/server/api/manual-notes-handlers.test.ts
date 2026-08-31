import {
  ListReviewItemsResponseSchema,
  MutationResultSchema,
  NoteDetailResponseSchema,
  NoteListResponseSchema,
  SpaceMutationResultSchema,
  TagMutationResultSchema
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequest } from "@/server/auth/session";
import { InMemoryManualNotesRepository } from "@/server/product/in-memory-repository";

import { createManualNotesHandlers } from "./manual-notes-handlers";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOTE_ID = "note_00000000000000000000000001";

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
