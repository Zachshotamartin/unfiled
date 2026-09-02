import type { NoteBacklinksResponse, NoteSourcesResponse } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequest } from "@/server/auth/session";
import { HttpError } from "@/server/api/errors";
import type { NoteContextRepository } from "@/server/note-context/repository";

import { createNoteContextHandlers } from "./note-context-handlers";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const SOURCES: NoteSourcesResponse = {
  items: [],
  pageInfo: { hasMore: false, nextCursor: null }
};
const BACKLINKS: NoteBacklinksResponse = {
  items: [],
  pageInfo: { hasMore: false, nextCursor: null }
};

function authenticated(): Promise<AuthenticatedRequest> {
  return Promise.resolve({
    accessToken: "owner-access-token",
    cookies: ["refreshed=true; HttpOnly"],
    user: { id: OWNER, email: "owner@example.test" }
  });
}

function repository(): {
  listSources: ReturnType<typeof vi.fn<NoteContextRepository["listSources"]>>;
  listBacklinks: ReturnType<typeof vi.fn<NoteContextRepository["listBacklinks"]>>;
} {
  return {
    listSources: vi.fn(() => Promise.resolve(SOURCES)),
    listBacklinks: vi.fn(() => Promise.resolve(BACKLINKS))
  };
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

describe("note-context handlers", () => {
  it("authenticates before listing owner sources and forwards strict pagination", async () => {
    const ownerRepository = repository();
    const handlers = createNoteContextHandlers({
      authenticate: authenticated,
      repository: ownerRepository
    });
    const response = await handlers.listSources(
      new Request(`https://unfiled.test/api/v1/notes/${NOTE}/sources?limit=2&cursor=next`),
      { noteId: NOTE }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SOURCES);
    expect(ownerRepository.listSources).toHaveBeenCalledWith(
      { accessToken: "owner-access-token", userId: OWNER },
      NOTE,
      { limit: 2, cursor: "next" }
    );
    expect(response.headers.get("set-cookie")).toContain("refreshed=true");
    expectPrivate(response);
  });

  it("rejects unknown, duplicate, invalid, and malformed-ID inputs before repository access", async () => {
    const ownerRepository = repository();
    const handlers = createNoteContextHandlers({
      authenticate: authenticated,
      repository: ownerRepository
    });
    const cases = [
      [`sources?unknown=1`, NOTE, "sources"],
      [`sources?limit=2&limit=3`, NOTE, "sources"],
      [`backlinks?limit=101`, NOTE, "backlinks"],
      [`sources`, "note_bad", "sources"]
    ] as const;

    for (const [path, id, surface] of cases) {
      const request = new Request(`https://unfiled.test/api/v1/notes/${id}/${path}`);
      const response =
        surface === "sources"
          ? await handlers.listSources(request, { noteId: id })
          : await handlers.listBacklinks(request, { noteId: id });
      expect(response.status).toBe(400);
      expectPrivate(response);
    }
    expect(ownerRepository.listSources).not.toHaveBeenCalled();
    expect(ownerRepository.listBacklinks).not.toHaveBeenCalled();
  });

  it("never reaches the owner repository when authentication fails", async () => {
    const ownerRepository = repository();
    const handlers = createNoteContextHandlers({
      authenticate: () =>
        Promise.reject(new HttpError(401, "unauthorized", "Sign in to continue.")),
      repository: ownerRepository
    });
    const response = await handlers.listBacklinks(
      new Request(`https://unfiled.test/api/v1/notes/${NOTE}/backlinks`),
      { noteId: NOTE }
    );

    expect(response.status).toBe(401);
    expect(ownerRepository.listBacklinks).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it("keeps stale/deleted and provider errors private and content-free", async () => {
    const ownerRepository = repository();
    ownerRepository.listSources.mockRejectedValueOnce(
      new HttpError(409, "stale_revision", "This note changed somewhere else.")
    );
    ownerRepository.listBacklinks.mockRejectedValueOnce(
      new HttpError(404, "not_found", "That item was not found.")
    );
    const handlers = createNoteContextHandlers({
      authenticate: authenticated,
      repository: ownerRepository
    });
    const stale = await handlers.listSources(
      new Request(`https://unfiled.test/api/v1/notes/${NOTE}/sources`),
      { noteId: NOTE }
    );
    const deleted = await handlers.listBacklinks(
      new Request(`https://unfiled.test/api/v1/notes/${NOTE}/backlinks`),
      { noteId: NOTE }
    );

    expect(stale.status).toBe(409);
    expect(deleted.status).toBe(404);
    expect(JSON.stringify(await stale.json())).not.toContain("rawContent");
    expect(JSON.stringify(await deleted.json())).not.toContain("fromTitle");
    expectPrivate(stale);
    expectPrivate(deleted);
  });
});
