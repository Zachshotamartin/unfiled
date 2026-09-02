import type { EntityId } from "@unfiled/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SupabaseHttpManualNotesRepository } from "./supabase-http-repository";
import { mapReviewItem } from "./supabase-http-mappers";

const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"note">;
const TARGET_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as EntityId<"note">;
const OTHER_TARGET_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Z" as EntityId<"note">;
const LINK_ID = "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"lnk">;
const TAG_ID = "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"tag">;
const NOW = "2026-08-30T18:00:00.000Z";
const context = {
  accessToken: "access-token",
  userId: "00000000-0000-4000-8000-000000000001"
};

function storedMutation(revision: number, bodyMarkdown: string, replayed = false) {
  const note = {
    id: NOTE_ID,
    spaceId: null,
    type: "generic",
    title: "Replay invariant",
    bodyMarkdown,
    structuredData: { schemaVersion: 1 },
    currentRevision: revision,
    isOpen: true,
    pinnedAt: null,
    privacy: "ai_assisted",
    archivedAt: null,
    deletedAt: null,
    tagIds: [],
    links: [],
    createdAt: NOW,
    updatedAt: NOW
  };
  return {
    note,
    revision: {
      ...note,
      id: `rev_${String(revision).padStart(26, "0")}`,
      noteId: NOTE_ID,
      revision,
      source: "manual",
      contentHash: "0".repeat(64),
      actor: "user:manual-update",
      createdAt: NOW
    },
    mutationId: `mut_${String(revision).padStart(26, "0")}`,
    replayed,
    undo: { eligible: revision > 1, expiresAt: null }
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function configure(): void {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Supabase manual-note repository", () => {
  it("fails closed instead of inventing typed semantics for legacy failed Review items", () => {
    const legacy = {
      id: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      capture_id: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      note_id: null,
      type: "failed_job",
      choices: ["retry"],
      state: "open",
      resolution: null,
      created_at: NOW,
      resolved_at: null
    };

    expect(() => mapReviewItem(legacy)).toThrow(/invalid review item/u);
    expect(() =>
      mapReviewItem({
        ...legacy,
        type: "structure_conflict",
        state: "resolved",
        resolution: { type: "keep_inbox" },
        resolved_at: NOW
      })
    ).toThrow(/invalid legacy review item/u);
    expect(
      mapReviewItem({
        ...legacy,
        proposal: { type: "failed_job", errorCode: "provider_unavailable" }
      })
    ).toMatchObject({
      type: "failed_job",
      proposal: { type: "failed_job", errorCode: "provider_unavailable" }
    });
  });

  it("returns the RPC-stored snapshot when an old mutation key is replayed after a later edit", async () => {
    configure();
    const responses = [
      storedMutation(2, "first save"),
      storedMutation(3, "later save"),
      storedMutation(2, "first save", true)
    ];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(responses.shift())));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpManualNotesRepository();

    const first = await repository.updateNote(
      context,
      NOTE_ID,
      { expectedRevision: 1, bodyMarkdown: "first save" },
      "save-key-first"
    );
    await repository.updateNote(
      context,
      NOTE_ID,
      { expectedRevision: 2, bodyMarkdown: "later save" },
      "save-key-later"
    );
    const replay = await repository.updateNote(
      context,
      NOTE_ID,
      { expectedRevision: 1, bodyMarkdown: "first save" },
      "save-key-first"
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(replay.note).toEqual(first.note);
    expect(replay.revision).toEqual(first.revision);
    expect(replay.mutation.id).toBe(first.mutation.id);
    expect(replay.mutation.replayed).toBe(true);
    expect(replay.note.currentRevision).toBe(2);
    expect(replay.note.bodyMarkdown).toBe("first save");
  });

  it("maps create-time tags, links, and caller sort keys to the exact RPC parameters", async () => {
    configure();
    const space = {
      id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      parentId: null,
      name: "Health",
      path: "Health",
      slug: "health",
      sortKey: "r000042",
      currentRevision: 1,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW
    };
    const responses = [storedMutation(1, "Body"), { space, replayed: false }];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(responses.shift())));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpManualNotesRepository();

    await repository.createNote(
      context,
      {
        title: "Created with relations",
        type: "generic",
        bodyMarkdown: "Body",
        privacy: "ai_assisted",
        spaceId: null,
        tagIds: [TAG_ID],
        links: [{ toNoteId: TARGET_ID, linkType: "related" }]
      },
      "create-note-relations"
    );
    await repository.createSpace(
      context,
      { name: "Health", parentId: null, sortKey: "r000042" },
      "create-space-ranked"
    );

    const noteCall = fetchMock.mock.calls.at(0);
    const spaceCall = fetchMock.mock.calls.at(1);
    if (noteCall?.[1] === undefined || spaceCall?.[1] === undefined) {
      throw new TypeError("Expected fetch request options");
    }
    const noteInit = noteCall[1];
    const spaceInit = spaceCall[1];
    if (typeof noteInit.body !== "string" || typeof spaceInit.body !== "string") {
      throw new TypeError("Expected JSON request bodies");
    }
    const noteParameters = JSON.parse(noteInit.body) as Record<string, unknown>;
    const spaceParameters = JSON.parse(spaceInit.body) as Record<string, unknown>;
    expect(noteParameters.p_tag_ids).toEqual([TAG_ID]);
    expect(noteParameters.p_links).toEqual([{ toNoteId: TARGET_ID, linkType: "related" }]);
    expect(spaceParameters.p_sort_key).toBe("r000042");
  });

  it("translates a committed structure-review envelope into a stable conflict", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json({
            errorCode: "structure_conflict",
            reviewItemId: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            replayed: false
          })
        )
      )
    );
    const repository = new SupabaseHttpManualNotesRepository();

    await expect(
      repository.updateNote(
        context,
        NOTE_ID,
        { expectedRevision: 1, bodyMarkdown: "ambiguous structure" },
        "structure-review-key"
      )
    ).rejects.toMatchObject({ status: 409, code: "structure_conflict" });
  });

  it("derives relation helper operations from the immutable expected revision on retry", async () => {
    configure();
    const revision = {
      ...storedMutation(1, "Body").revision,
      tagIds: []
    };
    const responses = [
      [revision],
      storedMutation(2, "Body"),
      [revision],
      storedMutation(2, "Body", true)
    ];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(responses.shift())));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpManualNotesRepository();

    await repository.linkTag(context, NOTE_ID, TAG_ID, {
      expectedRevision: 1,
      idempotencyKey: "relation-retry-key"
    });
    await repository.linkTag(context, NOTE_ID, TAG_ID, {
      expectedRevision: 1,
      idempotencyKey: "relation-retry-key"
    });

    const firstRpc = fetchMock.mock.calls[1]?.[1];
    const replayRpc = fetchMock.mock.calls[3]?.[1];
    if (typeof firstRpc?.body !== "string" || typeof replayRpc?.body !== "string") {
      throw new TypeError("Expected relation RPC bodies");
    }
    expect(JSON.parse(replayRpc.body)).toEqual(JSON.parse(firstRpc.body));
  });

  it("joins owner-visible target titles and safely labels unavailable link targets", async () => {
    configure();
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        json([
          {
            id: LINK_ID,
            from_note_id: NOTE_ID,
            to_note_id: TARGET_ID,
            link_type: "related",
            target: { title: "Roosevelt method" }
          },
          {
            id: "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
            from_note_id: NOTE_ID,
            to_note_id: OTHER_TARGET_ID,
            link_type: "reference",
            target: null
          }
        ])
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpManualNotesRepository();

    const links = await repository.listLinks(context, NOTE_ID);

    expect(links.map((link) => link.targetTitle)).toEqual(["Roosevelt method", "Unavailable note"]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "target:notes!note_links_to_note_id_fkey(title)"
    );
  });

  it("rejects a path link whose stored tuple does not match the delete request", async () => {
    configure();
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        json([
          {
            id: LINK_ID,
            from_note_id: NOTE_ID,
            to_note_id: OTHER_TARGET_ID,
            link_type: "related"
          }
        ])
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpManualNotesRepository();

    await expect(
      repository.deleteLink(context, NOTE_ID, LINK_ID, {
        expectedRevision: 1,
        idempotencyKey: "delete-wrong-tuple",
        linkType: "related",
        toNoteId: TARGET_ID
      })
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`id=eq.${LINK_ID}`);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`from_note_id=eq.${NOTE_ID}`);
  });

  it("does not let a nonexistent path link delete an existing tuple", async () => {
    configure();
    const responses = [[], [{ current_revision: 1 }]];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(responses.shift())));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpManualNotesRepository();

    await expect(
      repository.deleteLink(context, NOTE_ID, LINK_ID, {
        expectedRevision: 1,
        idempotencyKey: "delete-missing-link",
        linkType: "related",
        toNoteId: TARGET_ID
      })
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(([url]) => typeof url === "string" && url.includes("rpc/"))
    ).toBe(false);
  });

  it("allows a committed link deletion to reach the database idempotency replay", async () => {
    configure();
    const revision = {
      ...storedMutation(1, "Body").revision,
      links: [{ toNoteId: TARGET_ID, linkType: "related" }]
    };
    const link = {
      id: LINK_ID,
      from_note_id: NOTE_ID,
      to_note_id: TARGET_ID,
      link_type: "related"
    };
    const responses = [
      [link],
      [revision],
      storedMutation(2, "Body"),
      [],
      [{ current_revision: 2 }],
      [revision],
      storedMutation(2, "Body", true)
    ];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(responses.shift())));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpManualNotesRepository();
    const input = {
      expectedRevision: 1,
      idempotencyKey: "delete-link-replay",
      linkType: "related" as const,
      toNoteId: TARGET_ID
    };

    const first = await repository.deleteLink(context, NOTE_ID, LINK_ID, input);
    const replay = await repository.deleteLink(context, NOTE_ID, LINK_ID, input);

    expect(replay.note).toEqual(first.note);
    expect(replay.revision).toEqual(first.revision);
    expect(replay.mutation).toMatchObject({ id: first.mutation.id, replayed: true });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("hydrates lexical display fields and score from the current owner-authorized note", async () => {
    configure();
    const staleCanary = "STALE SEARCH ROW MUST NOT ESCAPE";
    const currentNote = {
      ...storedMutation(3, "Fresh current body for alpha").note,
      title: "Current alpha",
      spacePath: "Current / Space"
    };
    const responses = [
      [
        {
          note_id: NOTE_ID,
          rank: 999,
          snippet: staleCanary,
          space_path: staleCanary
        }
      ],
      [currentNote],
      [],
      []
    ];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(responses.shift())));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpManualNotesRepository();

    const result = await repository.search(context, "current alpha", {
      archived: "exclude",
      limit: 10,
      offset: 0
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      note: {
        id: NOTE_ID,
        spacePath: "Current / Space",
        title: "Current alpha"
      },
      score: 1,
      snippet: "Fresh current body for alpha"
    });
    expect(JSON.stringify(result)).not.toContain(staleCanary);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
