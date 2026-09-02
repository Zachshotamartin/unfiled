import { readFile } from "node:fs/promises";

import {
  ApiClientMalformedResponseError,
  createApiClient
} from "../../packages/api-client/src/index.js";
import type {
  EntityId,
  EntityKind,
  NoteDto,
  NoteSummary,
  Space,
  Tag
} from "../../packages/contracts/src/index.js";
import {
  createInitialNote,
  patchNote,
  type EntityIdFactory,
  type Note
} from "../../packages/domain/src/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  PORTFOLIO_NOTES,
  PORTFOLIO_PLANNED_WRITES,
  PORTFOLIO_SETTINGS,
  PORTFOLIO_SPACES,
  PORTFOLIO_TAGS,
  WORKOUT_LOG_BODY
} from "./manifest.js";
import {
  DemoSeedError,
  createStrictDemoFetch,
  dedicatedAccountConfirmation,
  executeSeed,
  executionConfig,
  parseCliOptions,
  productionConfirmation,
  runSeedCli,
  type DemoApiClient,
  type ExecutionConfig
} from "./seed-core.js";

const ORIGIN = "https://unfiled-preview.example.test";
const PRODUCTION_ORIGIN = "https://unfiled.example.test";
const ACCESS_TOKEN = "synthetic-test-token";
const ACCOUNT_EMAIL = "unfiled-demo@example.com";
const OTHER_EMAIL = "not-the-demo-owner@example.com";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-09-02T19:20:21.000Z";

function expectSeedCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DemoSeedError);
    expect((error as DemoSeedError).code).toBe(code);
    return;
  }
  throw new Error(`Expected DemoSeedError(${code})`);
}

function previewEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {}
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    UNFILED_DEMO_ACCESS_TOKEN: ACCESS_TOKEN,
    UNFILED_DEMO_ALLOWED_ACCOUNT_EMAILS: ACCOUNT_EMAIL,
    UNFILED_DEMO_ALLOWED_ORIGINS: ORIGIN,
    UNFILED_DEMO_BASE_URL: ORIGIN,
    UNFILED_DEMO_DEDICATED_ACCOUNT_CONFIRMATION: dedicatedAccountConfirmation("portfolio"),
    UNFILED_DEMO_TARGET_ENVIRONMENT: "preview",
    ...overrides
  });
}

function previewConfig(profile: "fresh" | "portfolio" = "portfolio"): ExecutionConfig {
  return Object.freeze({
    accessToken: ACCESS_TOKEN,
    allowedEmails: new Set([ACCOUNT_EMAIL]),
    environment: "preview",
    origin: ORIGIN,
    profile
  });
}

function emptyPage<T>(items: readonly T[] = []): {
  items: readonly T[];
  pageInfo: { hasMore: false; nextCursor: null };
} {
  return { items, pageInfo: { hasMore: false, nextCursor: null } };
}

function makeIdFactory(): EntityIdFactory {
  let sequence = 0;
  return <K extends EntityKind>(kind: K): EntityId<K> => {
    sequence += 1;
    return `${kind}_${String(sequence).padStart(26, "0")}` as EntityId<K>;
  };
}

function noteDto(note: Note): NoteDto {
  const { userId, ...dto } = note;
  void userId;
  return dto;
}

function noteSummary(note: NoteDto): NoteSummary {
  return {
    archivedAt: note.archivedAt,
    currentRevision: note.currentRevision,
    deletedAt: note.deletedAt,
    id: note.id,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    spaceId: note.spaceId,
    title: note.title,
    type: note.type,
    updatedAt: note.updatedAt
  };
}

type StatefulDemoClient = Readonly<{
  client: DemoApiClient;
  writes: ReturnType<typeof vi.fn>;
}>;

function statefulDemoClient(): StatefulDemoClient {
  const idFactory = makeIdFactory();
  const spaces = new Map<string, Space>();
  const tags = new Map<string, Tag>();
  const notes = new Map<string, NoteDto>();
  let settings = {
    byokFallbackToApp: false,
    byokProvider: null,
    expansionStyle: "brief" as const,
    locale: "en-US",
    modelSelection: "auto" as const,
    organizationMode: "balanced" as const,
    providerMode: "app_default" as const,
    routingEffort: "standard" as const,
    settingsRevision: 1,
    timezone: "UTC",
    updatedAt: NOW
  };
  const writes = vi.fn();

  const client = {
    createNote: vi.fn(async (input: Parameters<DemoApiClient["createNote"]>[0]) => {
      writes("create_note", input.title);
      const created = createInitialNote({
        bodyMarkdown: input.bodyMarkdown ?? "",
        id: idFactory("note"),
        idFactory,
        links: (input.links ?? []) as readonly Readonly<{
          linkType: "reference" | "related";
          toNoteId: EntityId<"note">;
        }>[],
        now: NOW,
        privacy: input.privacy ?? "ai_assisted",
        spaceId: (input.spaceId ?? null) as EntityId<"spc"> | null,
        tagIds: (input.tagIds ?? []) as readonly EntityId<"tag">[],
        title: input.title,
        type: input.type,
        userId: USER_ID
      });
      const dto = noteDto(created.note);
      notes.set(dto.id, dto);
      return {
        mutationId: idFactory("mut"),
        note: dto,
        replayed: false,
        revision: created.revision,
        undo: { eligible: true, expiresAt: "2026-09-02T19:30:21.000Z" }
      };
    }),
    createSpace: vi.fn(async (input: Parameters<DemoApiClient["createSpace"]>[0]) => {
      writes("create_space");
      const space: Space = {
        archivedAt: null,
        createdAt: NOW,
        currentRevision: 1,
        id: idFactory("spc"),
        name: input.name,
        parentId: (input.parentId ?? null) as EntityId<"spc"> | null,
        slug: input.name.toLowerCase().replaceAll(" ", "-"),
        sortKey: input.sortKey ?? input.name,
        updatedAt: NOW
      };
      spaces.set(space.id, space);
      return { replayed: false, space };
    }),
    createTag: vi.fn(async (input: Parameters<DemoApiClient["createTag"]>[0]) => {
      writes("create_tag");
      const tag: Tag = {
        createdAt: NOW,
        currentRevision: 1,
        id: idFactory("tag"),
        name: input.name
      };
      tags.set(tag.id, tag);
      return { replayed: false, tag };
    }),
    getAuthSession: vi.fn(async () => ({ user: { email: ACCOUNT_EMAIL, id: USER_ID } })),
    getNote: vi.fn(async (id: Parameters<DemoApiClient["getNote"]>[0]) => {
      const note = notes.get(id);
      if (note === undefined) throw new Error("missing synthetic fixture");
      return { note };
    }),
    getProviderKeyMetadata: vi.fn(async () => ({ providerKey: null })),
    getUserSettings: vi.fn(async () => ({ settings })),
    listAllRoutingRules: vi.fn(async () => ({ items: [] })),
    listCaptures: vi.fn(async () => emptyPage()),
    listNotes: vi.fn(async (input: Parameters<DemoApiClient["listNotes"]>[0]) =>
      emptyPage(input?.deleted === "only" ? [] : [...notes.values()].map(noteSummary))
    ),
    listReviewItems: vi.fn(async () => emptyPage()),
    listSpaces: vi.fn(async () => emptyPage([...spaces.values()])),
    listTags: vi.fn(async () => emptyPage([...tags.values()])),
    updateNote: vi.fn(
      async (
        id: Parameters<DemoApiClient["updateNote"]>[0],
        input: Parameters<DemoApiClient["updateNote"]>[1]
      ) => {
        writes("update_note");
        const current = notes.get(id);
        if (current === undefined) throw new Error("missing synthetic fixture");
        if (input.bodyMarkdown === undefined) throw new Error("missing synthetic update body");
        const updated = patchNote(
          { ...current, userId: USER_ID },
          {
            bodyMarkdown: input.bodyMarkdown,
            expectedRevision: input.expectedRevision,
            idFactory,
            now: NOW
          }
        );
        const dto = noteDto(updated.note);
        notes.set(dto.id, dto);
        return {
          mutationId: updated.mutation.id,
          note: dto,
          replayed: false,
          revision: updated.revision,
          undo: { eligible: true, expiresAt: "2026-09-02T19:30:21.000Z" }
        };
      }
    ),
    updateUserSettings: vi.fn(async (input: Parameters<DemoApiClient["updateUserSettings"]>[0]) => {
      writes("update_settings");
      settings = {
        ...settings,
        locale: input.locale ?? settings.locale,
        settingsRevision: settings.settingsRevision + 1,
        timezone: input.timezone ?? settings.timezone,
        updatedAt: NOW
      };
      return { replayed: false, settings };
    })
  } as unknown as DemoApiClient;

  return { client, writes };
}

describe("demo seed command boundary", () => {
  it("defaults to a Preview portfolio dry run", () => {
    expect(parseCliOptions([])).toEqual({
      environment: "preview",
      environmentWasExplicit: false,
      help: false,
      mode: "dry-run",
      productionConfirmation: null,
      profile: "portfolio"
    });
    expect(parseCliOptions(["--", "--profile", "fresh"])).toMatchObject({
      mode: "dry-run",
      profile: "fresh"
    });
  });

  it.each([
    [["--token", "secret"], "unknown_argument"],
    [["--email", ACCOUNT_EMAIL], "unknown_argument"],
    [["--base-url", ORIGIN], "unknown_argument"],
    [["portfolio"], "unknown_argument"],
    [["--execute", "--dry-run"], "duplicate_argument"],
    [["--profile", "portfolio", "--profile", "fresh"], "duplicate_argument"],
    [["--environment", "staging"], "invalid_environment"],
    [["--profile", "unknown"], "invalid_profile"]
  ] as const)("rejects unsafe or unknown argv %j", (argv, code) => {
    expectSeedCode(() => parseCliOptions(argv), code);
  });

  it("performs a zero-network, zero-client Preview dry run", async () => {
    const createClient = vi.fn();
    const output: string[] = [];
    const status = await runSeedCli([], {
      createClient,
      environment: {
        UNFILED_DEMO_ACCESS_TOKEN: "token-canary",
        UNFILED_DEMO_ALLOWED_ACCOUNT_EMAILS: "email-canary@example.com"
      },
      writeOutput: (line) => output.push(line)
    });

    expect(status).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(output).toEqual([
      `demo_seed mode=dry-run environment=preview profile=portfolio planned_writes=${PORTFOLIO_PLANNED_WRITES} network_requests=0`
    ]);
    expect(output.join("\n")).not.toContain("canary");
  });

  it("requires a separately declared matching target environment", () => {
    const options = parseCliOptions(["--execute"]);
    expectSeedCode(
      () =>
        executionConfig(
          options,
          previewEnvironment({ UNFILED_DEMO_TARGET_ENVIRONMENT: undefined })
        ),
      "missing_or_invalid_target_environment"
    );
    expectSeedCode(
      () =>
        executionConfig(
          options,
          previewEnvironment({ UNFILED_DEMO_TARGET_ENVIRONMENT: "production" })
        ),
      "target_environment_mismatch"
    );
  });

  it("requires exact origin, owner, and dedicated-account allowlists", () => {
    const options = parseCliOptions(["--execute"]);
    expect(executionConfig(options, previewEnvironment())).toEqual(previewConfig());
    expectSeedCode(
      () =>
        executionConfig(
          options,
          previewEnvironment({ UNFILED_DEMO_ALLOWED_ACCOUNT_EMAILS: "Unfiled-Demo@example.com" })
        ),
      "invalid_account_allowlist"
    );
    expectSeedCode(
      () =>
        executionConfig(
          options,
          previewEnvironment({
            UNFILED_DEMO_DEDICATED_ACCOUNT_CONFIRMATION: "I_CONFIRM_THIS_IS_A_DEDICATED_ACCOUNT"
          })
        ),
      "dedicated_account_not_confirmed"
    );
    expectSeedCode(
      () => executionConfig(options, previewEnvironment({ UNFILED_DEMO_ALLOWED_ORIGINS: "" })),
      "missing_origin_allowlist"
    );
  });

  it("hard-fails Production without the exact origin-bound confirmation", () => {
    const missing = parseCliOptions(["--execute", "--environment", "production"]);
    const baseEnvironment = previewEnvironment({
      UNFILED_DEMO_ALLOWED_ORIGINS: PRODUCTION_ORIGIN,
      UNFILED_DEMO_BASE_URL: PRODUCTION_ORIGIN,
      UNFILED_DEMO_TARGET_ENVIRONMENT: "production"
    });
    expectSeedCode(
      () => executionConfig(missing, baseEnvironment),
      "production_confirmation_required"
    );

    const exact = productionConfirmation("portfolio", PRODUCTION_ORIGIN);
    const confirmed = parseCliOptions([
      "--execute",
      "--environment",
      "production",
      "--confirm-production",
      exact
    ]);
    expect(executionConfig(confirmed, baseEnvironment)).toMatchObject({
      environment: "production",
      origin: PRODUCTION_ORIGIN,
      profile: "portfolio"
    });
  });
});

describe("owner-authenticated HTTP boundary", () => {
  it("permits only the reviewed API route, exact owner bearer, status, and JSON response", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ user: { email: ACCOUNT_EMAIL, id: USER_ID } }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    });
    const strictFetch = createStrictDemoFetch(ORIGIN, ACCESS_TOKEN, fetcher);
    const response = await strictFetch(`${ORIGIN}/api/v1/auth/session`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` }
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it.each([
    ["https://other.example.test/api/v1/auth/session", "api_origin_mismatch"],
    [`${ORIGIN}/rest/v1/notes`, "unexpected_api_route"]
  ] as const)("rejects unowned or non-product route %s", async (url, code) => {
    const strictFetch = createStrictDemoFetch(
      ORIGIN,
      ACCESS_TOKEN,
      vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }))
    );
    await expect(
      strictFetch(url, { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } })
    ).rejects.toMatchObject({ code });
  });

  it("rejects missing owner auth and authority-bearing request bodies before transmission", async () => {
    const fetcher = vi.fn();
    const strictFetch = createStrictDemoFetch(ORIGIN, ACCESS_TOKEN, fetcher);
    await expect(strictFetch(`${ORIGIN}/api/v1/auth/session`)).rejects.toMatchObject({
      code: "owner_authentication_missing"
    });
    await expect(
      strictFetch(`${ORIGIN}/api/v1/notes`, {
        body: JSON.stringify({ ownerId: USER_ID }),
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
        method: "POST"
      })
    ).rejects.toMatchObject({ code: "request_contains_authority_field" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [202, "application/json", "unexpected_api_status"],
    [200, "text/plain", "invalid_response_media_type"]
  ] as const)("rejects unexpected status/media %s %s", async (status, mediaType, code) => {
    const strictFetch = createStrictDemoFetch(
      ORIGIN,
      ACCESS_TOKEN,
      vi.fn(async () => new Response("{}", { headers: { "content-type": mediaType }, status }))
    );
    await expect(
      strictFetch(`${ORIGIN}/api/v1/auth/session`, {
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` }
      })
    ).rejects.toMatchObject({ code });
  });

  it("rejects oversized and unknown-schema responses", async () => {
    const tooLarge = createStrictDemoFetch(
      ORIGIN,
      ACCESS_TOKEN,
      vi.fn(
        async () =>
          new Response("{}", {
            headers: {
              "content-length": String(2 * 1_024 * 1_024 + 1),
              "content-type": "application/json"
            },
            status: 200
          })
      )
    );
    await expect(
      tooLarge(`${ORIGIN}/api/v1/auth/session`, {
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` }
      })
    ).rejects.toMatchObject({ code: "response_too_large" });

    const malformedClient = createApiClient({
      baseUrl: ORIGIN,
      fetch: createStrictDemoFetch(
        ORIGIN,
        ACCESS_TOKEN,
        vi.fn(
          async () =>
            new Response(JSON.stringify({ extra: true }), {
              headers: { "content-type": "application/json" },
              status: 200
            })
        )
      ),
      getAccessToken: () => Promise.resolve(ACCESS_TOKEN)
    });
    await expect(malformedClient.getAuthSession()).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
  });
});

describe("dedicated account and fixture behavior", () => {
  it("checks the authenticated email before any inventory call or write", async () => {
    const inventoryCall = vi.fn();
    const write = vi.fn();
    const client = {
      createNote: write,
      createSpace: write,
      createTag: write,
      getAuthSession: vi.fn(async () => ({ user: { email: OTHER_EMAIL, id: USER_ID } })),
      getProviderKeyMetadata: inventoryCall,
      getUserSettings: inventoryCall,
      listAllRoutingRules: inventoryCall,
      listCaptures: inventoryCall,
      listNotes: inventoryCall,
      listReviewItems: inventoryCall,
      listSpaces: inventoryCall,
      listTags: inventoryCall,
      updateNote: write,
      updateUserSettings: write
    } as unknown as DemoApiClient;

    await expect(executeSeed(client, previewConfig())).rejects.toMatchObject({
      code: "account_not_allowlisted"
    });
    expect(inventoryCall).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects non-empty fresh accounts without writing", async () => {
    const stateful = statefulDemoClient();
    const client = {
      ...stateful.client,
      listSpaces: vi.fn(async () =>
        emptyPage([
          {
            archivedAt: null,
            createdAt: NOW,
            currentRevision: 1,
            id: "spc_00000000000000000000000001",
            name: "Personal",
            parentId: null,
            slug: "personal",
            sortKey: "personal",
            updatedAt: NOW
          }
        ])
      )
    } as unknown as DemoApiClient;
    await expect(executeSeed(client, previewConfig("fresh"))).rejects.toMatchObject({
      code: "fresh_account_not_empty"
    });
    expect(stateful.writes).not.toHaveBeenCalled();
  });

  it("inventories both provider keys and treats any stored key as non-pristine", async () => {
    const stateful = statefulDemoClient();
    const getProviderKeyMetadata = vi.fn(async (provider: "anthropic" | "openai") => ({
      providerKey:
        provider === "anthropic"
          ? {
              credentialRevision: 1,
              lastFour: "wxyz",
              provider: "anthropic" as const,
              status: "active" as const,
              updatedAt: NOW,
              validatedAt: NOW
            }
          : null
    }));
    const client = { ...stateful.client, getProviderKeyMetadata } as unknown as DemoApiClient;

    await expect(executeSeed(client, previewConfig("fresh"))).rejects.toMatchObject({
      code: "fresh_account_not_empty"
    });
    expect(getProviderKeyMetadata.mock.calls.map(([provider]) => provider).sort()).toEqual([
      "anthropic",
      "openai"
    ]);
    expect(stateful.writes).not.toHaveBeenCalled();
  });

  it("seeds the deterministic portfolio once and skips every operation on rerun", async () => {
    const stateful = statefulDemoClient();
    const first = await executeSeed(stateful.client, previewConfig());
    expect(first).toEqual({
      attemptedWrites: PORTFOLIO_PLANNED_WRITES,
      profile: "portfolio",
      replayedWrites: 0,
      skippedWrites: 0
    });
    expect(stateful.writes).toHaveBeenCalledTimes(PORTFOLIO_PLANNED_WRITES);
    expect(stateful.writes.mock.calls[0]).toEqual(["create_note", "Synthetic demo data"]);

    stateful.writes.mockClear();
    const second = await executeSeed(stateful.client, previewConfig());
    expect(second).toEqual({
      attemptedWrites: 0,
      profile: "portfolio",
      replayedWrites: 0,
      skippedWrites: PORTFOLIO_PLANNED_WRITES
    });
    expect(stateful.writes).not.toHaveBeenCalled();
  });

  it("recovers idempotently when the first marker response is lost after commit", async () => {
    const stateful = statefulDemoClient();
    const committedCreateNote = stateful.client.createNote;
    let dropMarkerResponse = true;
    const client = {
      ...stateful.client,
      createNote: vi.fn(async (input: Parameters<DemoApiClient["createNote"]>[0]) => {
        const response = await committedCreateNote(input);
        if (dropMarkerResponse) {
          dropMarkerResponse = false;
          throw new Error("simulated transport loss after commit");
        }
        return response;
      })
    } as unknown as DemoApiClient;

    await expect(executeSeed(client, previewConfig())).rejects.toThrow(
      "simulated transport loss after commit"
    );
    expect(stateful.writes).toHaveBeenCalledTimes(1);
    expect(stateful.writes.mock.calls[0]).toEqual(["create_note", "Synthetic demo data"]);

    const resumed = await executeSeed(client, previewConfig());
    expect(resumed).toEqual({
      attemptedWrites: PORTFOLIO_PLANNED_WRITES - 1,
      profile: "portfolio",
      replayedWrites: 0,
      skippedWrites: 1
    });
    expect(stateful.writes).toHaveBeenCalledTimes(PORTFOLIO_PLANNED_WRITES);
  });

  it("rejects a schema-valid mutation response bound to the wrong note", async () => {
    const stateful = statefulDemoClient();
    const committedCreateNote = stateful.client.createNote;
    const client = {
      ...stateful.client,
      createNote: vi.fn(async (input: Parameters<DemoApiClient["createNote"]>[0]) => {
        const response = await committedCreateNote(input);
        return {
          ...response,
          revision: {
            ...response.revision,
            noteId: "note_00000000000000000000000000" as EntityId<"note">
          }
        };
      })
    } as unknown as DemoApiClient;

    await expect(executeSeed(client, previewConfig())).rejects.toMatchObject({
      code: "response_identity_mismatch"
    });
    expect(stateful.writes).toHaveBeenCalledTimes(1);
  });

  it("re-censuses authoritative state and refuses success after postflight drift", async () => {
    const stateful = statefulDemoClient();
    const listTags = stateful.client.listTags;
    let listCalls = 0;
    const client = {
      ...stateful.client,
      listTags: vi.fn(async (input: Parameters<DemoApiClient["listTags"]>[0]) => {
        const page = await listTags(input);
        listCalls += 1;
        if (listCalls === 1) return page;
        return {
          ...page,
          items: [
            ...page.items,
            {
              createdAt: NOW,
              currentRevision: 1,
              id: "tag_00000000000000000000000000" as EntityId<"tag">,
              name: "unexpected-personal-tag"
            }
          ]
        };
      })
    } as unknown as DemoApiClient;

    await expect(executeSeed(client, previewConfig())).rejects.toMatchObject({
      code: "unexpected_account_data"
    });
    expect(stateful.writes).toHaveBeenCalledTimes(PORTFOLIO_PLANNED_WRITES);
  });

  it("prints no remote error, token, email, content, or entity ID", async () => {
    const canaries = [
      ACCESS_TOKEN,
      ACCOUNT_EMAIL,
      "plaintext-note-canary",
      "note_00000000000000000000000001"
    ];
    const errors: string[] = [];
    const status = await runSeedCli(["--execute"], {
      createClient: () => {
        throw new Error(canaries.join(" "));
      },
      environment: previewEnvironment(),
      writeError: (line) => errors.push(line)
    });
    expect(status).toBe(1);
    expect(errors).toEqual(["demo_seed failed code=unexpected_failure"]);
    for (const canary of canaries) expect(errors.join("\n")).not.toContain(canary);
  });
});

describe("synthetic manifest and implementation boundary", () => {
  it("keeps globally unique idempotency keys and the documented synthetic profiles", () => {
    const keys = [
      ...PORTFOLIO_SPACES.map(({ idempotencyKey }) => idempotencyKey),
      ...PORTFOLIO_TAGS.map(({ idempotencyKey }) => idempotencyKey),
      PORTFOLIO_SETTINGS.idempotencyKey,
      ...PORTFOLIO_NOTES.flatMap(({ idempotencyKey, updateIdempotencyKey }) =>
        updateIdempotencyKey === undefined
          ? [idempotencyKey]
          : [idempotencyKey, updateIdempotencyKey]
      )
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.length <= 80)).toBe(true);
    expect(PORTFOLIO_PLANNED_WRITES).toBe(16);
    expect(
      PORTFOLIO_NOTES.filter(({ key }) => key !== "account-label").every(({ tags }) =>
        tags.includes("synthetic")
      )
    ).toBe(true);
    expect(PORTFOLIO_NOTES.find(({ key }) => key === "shopping")?.bodyMarkdown).toContain(
      "- [ ] bananas"
    );
    expect(PORTFOLIO_NOTES.find(({ key }) => key === "mindset")?.bodyMarkdown).toContain(
      "Generated interpretation (synthetic fixture)"
    );
    expect(PORTFOLIO_NOTES.find(({ key }) => key === "mindset")?.bodyMarkdown).toContain(
      "not evidence of a model-generated block"
    );
    expect(WORKOUT_LOG_BODY).toContain("- set_3_weight_lb: 155");
  });

  it("contains no database, Supabase, service-role, filesystem-write, or process-spawn path", async () => {
    const sources = await Promise.all(
      ["manifest.ts", "seed-core.ts", "seed.ts"].map((file) =>
        readFile(new URL(file, import.meta.url), "utf8")
      )
    );
    const implementation = sources.join("\n");
    expect(implementation).not.toMatch(/from\s+["']node:(?:child_process|fs|fs\/promises|sqlite)/u);
    expect(implementation).not.toMatch(
      /from\s+["'][^"']*(?:supabase|postgres|database)[^"']*["']/iu
    );
    expect(implementation).not.toMatch(/\b(?:insert|update|delete)\s+into\b/iu);
    expect(implementation).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
