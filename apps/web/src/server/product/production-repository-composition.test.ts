import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryManualNotesRepository } from "./in-memory-repository";
import {
  createProductionManualNotesComposition,
  productionManualNotesUnavailableEncryptedMethods
} from "./production-repository-composition";
import { createProductionRepository } from "./supabase-http-repository";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CONTEXT = Object.freeze({ accessToken: "owner-access-token", userId: OWNER_ID });
const ENVIRONMENT = Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: "https://unfiled.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-at-least-twenty-characters"
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body");
  return JSON.parse(init.body) as unknown;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function completeProjection(state: "dual_write" | "encrypted_only" | "contracted") {
  return {
    found: true,
    state,
    writeMode: "encrypted",
    readMode: state === "dual_write" ? "legacy" : "encrypted",
    backfill: {
      cursor: null,
      complete: true,
      encryptedObjectCount: 0,
      verifiedObjectCount: 0
    },
    plaintextScrub:
      state === "dual_write"
        ? null
        : {
            scrubId: "22222222-2222-4222-8222-222222222222",
            version: 1,
            startedAt: "2026-08-30T12:00:00.000Z",
            cursor: null,
            completedAt: "2026-08-30T12:01:00.000Z",
            scrubbedRowCount: 0,
            deletedChunkCount: 0,
            deletedIdempotencyCount: 0,
            attestationDigest: "a".repeat(64),
            lastRequestDigest: "b".repeat(64),
            lastResultDigest: "c".repeat(64)
          },
    readiness: {
      readyForEncryptedRead: true,
      requiredObjectCount: 0,
      exactVerifiedObjectCount: 0,
      missingObjectCount: 0,
      missingBySurface: {},
      activeKeySlots: 4,
      taxonomyEpochReady: true,
      backfillComplete: true
    }
  };
}

function absentProjection() {
  return {
    found: false,
    state: "expanded",
    writeMode: "legacy",
    readMode: "legacy",
    backfill: null,
    plaintextScrub: null,
    readiness: {
      readyForEncryptedRead: false,
      requiredObjectCount: 0,
      exactVerifiedObjectCount: 0,
      missingObjectCount: 0,
      missingBySurface: {},
      activeKeySlots: 0,
      taxonomyEpochReady: false,
      backfillComplete: false
    }
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const globalRepository = globalThis as typeof globalThis & {
    __unfiledDevelopmentRepository?: InMemoryManualNotesRepository;
  };
  delete globalRepository.__unfiledDevelopmentRepository;
});

describe("production manual-note repository composition", () => {
  it("marks every manual-note method ready on the encrypted repository", () => {
    expect(productionManualNotesUnavailableEncryptedMethods).toEqual([]);
  });

  it("looks up the authenticated owner for every expanded request and preserves legacy behavior", async () => {
    const legacy = new InMemoryManualNotesRepository(false);
    const encrypted = new InMemoryManualNotesRepository(false);
    const legacyList = vi.spyOn(legacy, "listNotes");
    const encryptedList = vi.spyOn(encrypted, "listNotes");
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(json(absentProjection())));
    const repository = createProductionManualNotesComposition({
      legacy,
      encrypted,
      environment: ENVIRONMENT,
      fetch: fetcher,
      signal: controller.signal
    });

    await repository.listNotes(CONTEXT, {});
    await repository.listNotes(CONTEXT, {});

    expect(legacyList).toHaveBeenCalledTimes(2);
    expect(encryptedList).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("https://unfiled.test/rest/v1/rpc/get_content_encryption_rollout");
      expect(init?.method).toBe("POST");
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBe(controller.signal);
      expect(requestBody(init)).toEqual({ p_owner_id: OWNER_ID });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${ENVIRONMENT.SUPABASE_SERVICE_ROLE_KEY}`
      );
    }
  });

  it("never falls back to legacy after dual-write selects the encrypted repository", async () => {
    const legacy = new InMemoryManualNotesRepository(false);
    const encrypted = new InMemoryManualNotesRepository(false);
    const legacyCreate = vi.spyOn(legacy, "createNote");
    const encryptedFailure = new Error("kms unavailable");
    vi.spyOn(encrypted, "createNote").mockRejectedValue(encryptedFailure);
    const repository = createProductionManualNotesComposition({
      legacy,
      encrypted,
      environment: ENVIRONMENT,
      fetch: () => Promise.resolve(json(completeProjection("dual_write")))
    });

    await expect(
      repository.createNote(
        CONTEXT,
        {
          bodyMarkdown: "encrypted body",
          links: [],
          privacy: "private_manual",
          spaceId: null,
          tagIds: [],
          title: "Encrypted title",
          type: "generic"
        },
        "request_key_000000000000000000000001"
      )
    ).rejects.toBe(encryptedFailure);
    expect(legacyCreate).not.toHaveBeenCalled();
  });

  it.each(["encrypted_only", "contracted"] as const)(
    "routes %s reads only through the complete encrypted repository",
    async (state) => {
      const legacy = new InMemoryManualNotesRepository(false);
      const encrypted = new InMemoryManualNotesRepository(false);
      const legacyList = vi.spyOn(legacy, "listNotes");
      const encryptedList = vi.spyOn(encrypted, "listNotes");
      const repository = createProductionManualNotesComposition({
        legacy,
        encrypted,
        environment: ENVIRONMENT,
        fetch: () => Promise.resolve(json(completeProjection(state)))
      });

      await expect(repository.listNotes(CONTEXT, {})).resolves.toEqual([]);
      expect(legacyList).not.toHaveBeenCalled();
      expect(encryptedList).toHaveBeenCalledTimes(1);
    }
  );

  it("wires the public factory to rollout lookup and forwards the request signal", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("UNFILED_WEB_DATA_ADAPTER", "supabase");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://unfiled.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ENVIRONMENT.SUPABASE_SERVICE_ROLE_KEY);
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/rest/v1/rpc/get_content_encryption_rollout")) {
        return Promise.resolve(json(absentProjection()));
      }
      if (url.includes("/rest/v1/notes?")) return Promise.resolve(json([]));
      return Promise.resolve(json({ message: "unexpected" }, 500));
    });
    vi.stubGlobal("fetch", fetcher);
    const request = new Request("https://unfiled.test/api/v1/notes");

    await expect(createProductionRepository(request).listNotes(CONTEXT, {})).resolves.toEqual([]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const rolloutCall = fetcher.mock.calls[0];
    expect(rolloutCall?.[0]).toBe(
      "https://unfiled.test/rest/v1/rpc/get_content_encryption_rollout"
    );
    expect(rolloutCall?.[1]?.signal).toBe(request.signal);
    expect(requestBody(rolloutCall?.[1])).toEqual({ p_owner_id: OWNER_ID });
    const legacyCall = fetcher.mock.calls[1];
    expect(requestUrl(legacyCall?.[0] ?? "")).toContain("https://unfiled.test/rest/v1/notes?");
    const legacyHeaders = new Headers(legacyCall?.[1]?.headers);
    expect(legacyHeaders.get("apikey")).toBe("anon-key");
    expect(legacyHeaders.get("authorization")).toBe(`Bearer ${CONTEXT.accessToken}`);
  });

  it("keeps the memory adapter development-only and singleton-scoped", () => {
    vi.stubEnv("UNFILED_WEB_DATA_ADAPTER", "memory");
    vi.stubEnv("NODE_ENV", "development");
    const first = createProductionRepository();
    expect(createProductionRepository()).toBe(first);

    vi.stubEnv("NODE_ENV", "production");
    expect(() => createProductionRepository()).toThrow(
      "Unfiled is not connected to its data service yet. Try again later."
    );
  });
});
