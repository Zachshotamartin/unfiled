import {
  manualNoteFixtures,
  type MutationResult,
  type NoteCreateRequest,
  type NoteUpdateRequest
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/index.js";

const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const TO_NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const SPACE_ID = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const TAG_ID = "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_ID = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const IDEMPOTENCY_KEY = "manual-write-01J6M9Q7";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function mutationResponse(): MutationResult {
  return manualNoteFixtures.mutationResult;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("Milestone B API client", () => {
  it("requests, verifies, and refreshes normalized OTP credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ accepted: true, retryAfterSeconds: 60 }, 202))
      .mockResolvedValueOnce(jsonResponse(manualNoteFixtures.authSession))
      .mockResolvedValueOnce(jsonResponse(manualNoteFixtures.authSession));
    const client = createApiClient({
      baseUrl: "https://example.test/",
      getAccessToken: () => Promise.resolve(null),
      fetch: fetcher
    });

    await expect(client.requestOtp({ email: " PERSON@Example.com " })).resolves.toEqual({
      accepted: true,
      retryAfterSeconds: 60
    });
    await expect(
      client.verifyOtp({ email: "PERSON@example.com", code: "123456" })
    ).resolves.toEqual(manualNoteFixtures.authSession);
    await expect(client.refreshAuth({ refreshToken: "restart-safe-token" })).resolves.toEqual(
      manualNoteFixtures.authSession
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example.test/api/v1/auth/otp");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetcher.mock.calls[2]?.[0]).toBe("https://example.test/api/v1/auth/refresh");
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(await new Response(fetcher.mock.calls[0]?.[1]?.body).json()).toEqual({
      email: "person@example.com"
    });
  });

  it("uses the implemented auth session, verify, and sign-out routes", async () => {
    const user = manualNoteFixtures.authSession.user;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ user }))
      .mockResolvedValueOnce(jsonResponse(manualNoteFixtures.authSession))
      .mockResolvedValueOnce(jsonResponse({ signedOut: true }));
    const client = createApiClient({
      baseUrl: "https://example.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });

    await expect(client.getAuthSession()).resolves.toEqual({ user });
    await expect(
      client.verifyAuth({ email: "PERSON@example.com", code: "123456" })
    ).resolves.toEqual(manualNoteFixtures.authSession);
    await expect(client.signOut()).resolves.toEqual({ signedOut: true });
    expect(
      fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method ?? "GET"])
    ).toEqual([
      ["https://example.test/api/v1/auth/session", "GET"],
      ["https://example.test/api/v1/auth/verify", "PUT"],
      ["https://example.test/api/v1/auth/sign-out", "POST"]
    ]);
  });

  it("reads note detail, paginated library, revisions, spaces, tags, and search", async () => {
    const pageInfo = { hasMore: false, nextCursor: null };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [manualNoteFixtures.summary], pageInfo }))
      .mockResolvedValueOnce(jsonResponse({ note: manualNoteFixtures.note }))
      .mockResolvedValueOnce(jsonResponse({ items: [manualNoteFixtures.revision], pageInfo }))
      .mockResolvedValueOnce(jsonResponse({ items: [manualNoteFixtures.space], pageInfo }))
      .mockResolvedValueOnce(jsonResponse({ space: manualNoteFixtures.space }))
      .mockResolvedValueOnce(jsonResponse({ items: [manualNoteFixtures.tag], pageInfo }))
      .mockResolvedValueOnce(jsonResponse({ items: [manualNoteFixtures.searchResult], pageInfo }));
    const client = createApiClient({
      baseUrl: "https://example.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });

    await client.listNotes({ archive: "only", limit: 10, cursor: "next page" });
    await client.getNote(NOTE_ID);
    await client.listNoteRevisions(NOTE_ID, { limit: 20 });
    await client.listSpaces({ limit: 30 });
    await client.getSpace(SPACE_ID);
    await client.listTags({ limit: 30 });
    await client.searchNotes({ q: " milk ", archive: "include", limit: 5 });

    const urls = fetcher.mock.calls.map(([url]) => requestUrl(url));
    expect(urls).toEqual([
      "https://example.test/api/v1/notes?archive=only&deleted=exclude&limit=10&cursor=next+page",
      `https://example.test/api/v1/notes/${NOTE_ID}`,
      `https://example.test/api/v1/notes/${NOTE_ID}/revisions?limit=20`,
      "https://example.test/api/v1/spaces?limit=30",
      `https://example.test/api/v1/spaces/${SPACE_ID}`,
      "https://example.test/api/v1/tags?limit=30",
      "https://example.test/api/v1/search?q=milk&archive=include&limit=5"
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
    }
  });

  it("sends caller-owned idempotency keys on every manual-note write", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(mutationResponse())));
    const client = createApiClient({
      baseUrl: "https://example.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });
    const createRequest: NoteCreateRequest = {
      idempotencyKey: IDEMPOTENCY_KEY,
      title: "Shopping",
      type: "list",
      privacy: "ai_assisted",
      bodyMarkdown: ""
    };
    const updateRequest: NoteUpdateRequest = {
      idempotencyKey: IDEMPOTENCY_KEY,
      expectedRevision: 1,
      spaceId: SPACE_ID,
      title: "Groceries"
    };

    await client.createNote(createRequest);
    await client.updateNote(NOTE_ID, updateRequest);
    await client.moveNote(NOTE_ID, {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      spaceId: SPACE_ID
    });
    await client.archiveNote(NOTE_ID, {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY
    });
    await client.softDeleteNote(NOTE_ID, {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY
    });
    await client.restoreDeletedNote(NOTE_ID, {
      expectedRevision: 2,
      idempotencyKey: IDEMPOTENCY_KEY
    });
    await client.applyNoteOperations(NOTE_ID, {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      operations: [
        {
          type: "toggle_item_checked",
          itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
          checked: true
        }
      ]
    });
    await client.restoreNoteRevision(NOTE_ID, {
      expectedRevision: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
      revisionId: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X"
    });
    await client.undoMutation(MUTATION_ID, {
      expectedRevision: 2,
      idempotencyKey: IDEMPOTENCY_KEY
    });

    expect(fetcher).toHaveBeenCalledTimes(9);
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
      expect(headers.get("authorization")).toBe("Bearer access-token");
      expect(JSON.stringify(init?.body)).not.toContain("userId");
    }
    expect(fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method])).toEqual([
      ["https://example.test/api/v1/notes", "POST"],
      [`https://example.test/api/v1/notes/${NOTE_ID}`, "PATCH"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/move`, "POST"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/archive`, "POST"],
      [`https://example.test/api/v1/notes/${NOTE_ID}`, "DELETE"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/restore-deleted`, "POST"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/operations`, "POST"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/restore`, "POST"],
      [`https://example.test/api/v1/mutations/${MUTATION_ID}/undo`, "POST"]
    ]);
  });

  it("writes spaces and tags through typed responses and stable keys", async () => {
    const pageInfo = { hasMore: false, nextCursor: null };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ space: manualNoteFixtures.space, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ space: manualNoteFixtures.space, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ space: manualNoteFixtures.space, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ tag: manualNoteFixtures.tag, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ tag: manualNoteFixtures.tag, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ deletedId: TAG_ID, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ items: [manualNoteFixtures.tag], pageInfo }));
    const client = createApiClient({
      baseUrl: "https://example.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });

    await client.createSpace({ idempotencyKey: IDEMPOTENCY_KEY, name: "Work", parentId: null });
    await client.updateSpace(SPACE_ID, {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      name: "Projects"
    });
    await client.archiveSpace(SPACE_ID, {
      archived: true,
      expectedRevision: 2,
      idempotencyKey: IDEMPOTENCY_KEY
    });
    await client.createTag({ idempotencyKey: IDEMPOTENCY_KEY, name: "fitness" });
    await client.updateTag(TAG_ID, {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      name: "training"
    });
    await client.deleteTag(TAG_ID, { expectedRevision: 1, idempotencyKey: IDEMPOTENCY_KEY });
    await client.listTags({ limit: 30 });

    for (const [, init] of fetcher.mock.calls.slice(0, 6)) {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
    }
    expect(fetcher.mock.calls[4]?.[1]?.method).toBe("PATCH");
  });

  it("reads and mutates note links and tag associations with stable keys", async () => {
    const link = {
      id: "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      fromNoteId: NOTE_ID,
      toNoteId: TO_NOTE_ID,
      linkType: "related" as const,
      targetTitle: "HTTP link target"
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [link] }))
      .mockImplementation(() => Promise.resolve(jsonResponse(mutationResponse())));
    const client = createApiClient({
      baseUrl: "https://example.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });
    const linkWrite = {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      linkType: link.linkType,
      toNoteId: TO_NOTE_ID
    } as const;

    await expect(client.listNoteLinks(NOTE_ID)).resolves.toEqual({ items: [link] });
    await client.createNoteLink(NOTE_ID, linkWrite);
    await client.deleteNoteLink(NOTE_ID, link.id, linkWrite);
    await client.linkNoteTag(NOTE_ID, {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      tagId: TAG_ID
    });
    await client.unlinkNoteTag(NOTE_ID, TAG_ID, {
      expectedRevision: 1,
      idempotencyKey: IDEMPOTENCY_KEY
    });

    expect(
      fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method ?? "GET"])
    ).toEqual([
      [`https://example.test/api/v1/notes/${NOTE_ID}/links`, "GET"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/links`, "POST"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/links/${link.id}`, "DELETE"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/tags`, "POST"],
      [`https://example.test/api/v1/notes/${NOTE_ID}/tags/${TAG_ID}`, "DELETE"]
    ]);
    for (const [, init] of fetcher.mock.calls.slice(1)) {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
    }
  });

  it("lists Review with the open-state default and pagination", async () => {
    const item = {
      id: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      captureId: null,
      noteId: NOTE_ID,
      type: "structure_conflict",
      choices: [],
      state: "open",
      resolution: null,
      createdAt: "2026-08-30T18:30:00.000Z",
      resolvedAt: null
    };
    const response = { items: [item], pageInfo: { hasMore: false, nextCursor: null } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(response));
    const client = createApiClient({
      baseUrl: "https://example.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });

    await expect(client.listReviewItems()).resolves.toEqual(response);
    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(
      "https://example.test/api/v1/review-items?state=open&limit=30"
    );
  });

  it("validates inputs before fetch and decodes stable API errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { code: "stale_revision", message: "This note changed.", requestId: "req-1" },
          409
        )
      );
    const client = createApiClient({
      baseUrl: "https://example.test",
      getAccessToken: () => Promise.resolve("access-token"),
      fetch: fetcher
    });

    await expect(
      client.updateNote(NOTE_ID, {
        expectedRevision: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        title: "Changed"
      })
    ).rejects.toMatchObject({ status: 409, error: { code: "stale_revision" } });
    expect(() => client.getNote("note_bad")).toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
