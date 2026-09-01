import { describe, expect, it, vi } from "vitest";

import { manualNoteFixtures } from "@unfiled/contracts";

import { createApiClient } from "../src/index.js";

const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const DECISION_ID = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const REVIEW_ID = "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const RULE_ID = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const BLOCK_ID = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_A = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_B = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const NOW = "2026-09-01T18:30:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function makeClient(fetcher: typeof fetch) {
  return createApiClient({
    baseUrl: "https://example.test/",
    fetch: fetcher,
    getAccessToken: () => Promise.resolve("access-token")
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestJsonBody(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number): unknown {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new TypeError("Expected a JSON request body");
  return JSON.parse(body) as unknown;
}

describe("Milestone E/F API client", () => {
  it("sends atomic correction and typed Review resolution requests", async () => {
    const correction = {
      outcome: "applied",
      decisionId: DECISION_ID,
      source: { noteId: NOTE_A, currentRevision: 5, mutationId: MUTATION_A },
      destination: {
        type: "existing_note",
        noteId: NOTE_B,
        currentRevision: 3,
        mutationId: MUTATION_B
      },
      replayed: false
    } as const;
    const reviewItem = {
      id: REVIEW_ID,
      captureId: null,
      noteId: NOTE_A,
      type: "structure_conflict",
      proposal: { type: "conflict", reason: "structure" },
      state: "resolved",
      resolution: { type: "route", noteId: NOTE_B, expectedRevision: 2 },
      createdAt: NOW,
      resolvedAt: NOW
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(correction))
      .mockResolvedValueOnce(jsonResponse({ reviewItem, replayed: false }));
    const client = makeClient(fetcher);

    const correctionInput = {
      idempotencyKey: "correct-01",
      source: { noteId: NOTE_A, expectedRevision: 4 },
      destination: { type: "existing_note", noteId: NOTE_B, expectedRevision: 2 }
    } as const;
    await expect(client.correctDecision(DECISION_ID, correctionInput)).resolves.toEqual(correction);
    await expect(
      client.resolveReviewItem(REVIEW_ID, {
        idempotencyKey: "review-01",
        resolution: { type: "route", noteId: NOTE_B, expectedRevision: 2 }
      })
    ).resolves.toEqual({ reviewItem, replayed: false });

    expect(fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method])).toEqual([
      [`https://example.test/api/v1/decisions/${DECISION_ID}/correct`, "POST"],
      [`https://example.test/api/v1/review-items/${REVIEW_ID}/resolve`, "POST"]
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(correctionInput));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "idempotency-key": "correct-01"
    });
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it("decodes correction review outcomes and sends typed private batch undo", async () => {
    const needsReview = {
      outcome: "needs_review",
      decisionId: DECISION_ID,
      reviewItemId: REVIEW_ID,
      reasonCode: "exact_inverse_unavailable",
      replayed: false
    } as const;
    const mutation = manualNoteFixtures.mutationResult;
    const member = {
      note: mutation.note,
      revision: mutation.revision,
      mutationId: mutation.mutationId,
      undo: { eligible: false, expiresAt: null }
    };
    const batch = { members: [member], replayed: false } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(needsReview))
      .mockResolvedValueOnce(jsonResponse(batch));
    const client = makeClient(fetcher);

    await expect(
      client.correctDecision(DECISION_ID, {
        idempotencyKey: "correct-review-01",
        source: { noteId: NOTE_A, expectedRevision: 4 },
        destination: { type: "existing_note", noteId: NOTE_B, expectedRevision: 2 }
      })
    ).resolves.toEqual(needsReview);
    await expect(
      client.undoMutationBatch(MUTATION_A, {
        expectedRevision: 5,
        idempotencyKey: "batch-undo-01"
      })
    ).resolves.toEqual(batch);

    expect(fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method])).toEqual([
      [`https://example.test/api/v1/decisions/${DECISION_ID}/correct`, "POST"],
      [`https://example.test/api/v1/mutation-batches/${MUTATION_A}/undo`, "POST"]
    ]);
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      "idempotency-key": "batch-undo-01"
    });
  });

  it("covers routing-rule CRUD and generated-block resolution with CAS", async () => {
    const rule = {
      id: RULE_ID,
      revision: 1,
      enabled: true,
      ruleType: "phrase",
      condition: "groceries",
      normalizedCondition: "groceries",
      aliases: [],
      destination: { type: "note", noteId: NOTE_A },
      priority: 100,
      source: "explicit",
      lastFiredAt: null,
      createdAt: NOW,
      updatedAt: NOW
    } as const;
    const block = {
      id: BLOCK_ID,
      noteId: NOTE_A,
      decisionId: DECISION_ID,
      kind: "suggestion",
      content: "A useful expansion",
      state: "accepted",
      stateRevision: 2,
      modelId: "gpt-5.4-mini-2026-03-17",
      promptVersion: "organizer-v1",
      createdAt: NOW,
      resolvedAt: NOW
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [rule] }))
      .mockResolvedValueOnce(jsonResponse({ rule, replayed: false }, 201))
      .mockResolvedValueOnce(jsonResponse({ rule: { ...rule, revision: 2 }, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ ruleId: RULE_ID, deleted: true, replayed: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ ...block, state: "proposed", stateRevision: 1, resolvedAt: null }]
        })
      )
      .mockResolvedValueOnce(jsonResponse({ block, replayed: false }));
    const client = makeClient(fetcher);

    await client.listRoutingRules();
    await client.createRoutingRule({
      idempotencyKey: "rule-create-01",
      enabled: true,
      ruleType: "phrase",
      condition: "groceries",
      destination: { type: "note", noteId: NOTE_A },
      priority: 100
    });
    await client.updateRoutingRule(RULE_ID, {
      expectedRevision: 1,
      idempotencyKey: "rule-update-01",
      priority: 110
    });
    await client.deleteRoutingRule(RULE_ID, {
      expectedRevision: 2,
      idempotencyKey: "rule-delete-01"
    });
    await client.listGeneratedBlocks(NOTE_A);
    await client.resolveGeneratedBlock(BLOCK_ID, {
      expectedStateRevision: 1,
      idempotencyKey: "block-resolve-01",
      resolution: "accept"
    });

    expect(fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method])).toEqual([
      ["https://example.test/api/v1/routing-rules", "GET"],
      ["https://example.test/api/v1/routing-rules", "POST"],
      [`https://example.test/api/v1/routing-rules/${RULE_ID}`, "PATCH"],
      [`https://example.test/api/v1/routing-rules/${RULE_ID}`, "DELETE"],
      [`https://example.test/api/v1/notes/${NOTE_A}/generated-blocks`, "GET"],
      [`https://example.test/api/v1/generated-blocks/${BLOCK_ID}/resolve`, "POST"]
    ]);
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it("updates settings and keeps provider secrets out of decoded metadata", async () => {
    const settings = {
      settingsRevision: 3,
      organizationMode: "balanced",
      providerMode: "byok",
      byokProvider: "openai",
      byokFallbackToApp: false,
      routingEffort: "standard",
      expansionStyle: "brief",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      updatedAt: NOW
    } as const;
    const providerKey = {
      provider: "openai",
      lastFour: "1234",
      status: "active",
      credentialRevision: 1,
      validatedAt: NOW,
      updatedAt: NOW
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ settings }))
      .mockResolvedValueOnce(
        jsonResponse({ settings: { ...settings, settingsRevision: 4 }, replayed: false })
      )
      .mockResolvedValueOnce(jsonResponse({ providerKey: null }))
      .mockResolvedValueOnce(jsonResponse({ providerKey, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ provider: "openai", deleted: true, replayed: false }));
    const client = makeClient(fetcher);

    await client.getUserSettings();
    await client.updateUserSettings({
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-update-01",
      routingEffort: "thorough"
    });
    await client.getProviderKeyMetadata();
    await expect(
      client.putProviderKey({
        idempotencyKey: "provider-put-01",
        provider: "openai",
        apiKey: "sk-example-not-a-real-key-1234"
      })
    ).resolves.toEqual({ providerKey, replayed: false });
    await client.deleteProviderKey({ idempotencyKey: "provider-delete-01", provider: "openai" });

    expect(fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method])).toEqual([
      ["https://example.test/api/v1/me/settings", "GET"],
      ["https://example.test/api/v1/me/settings", "PATCH"],
      ["https://example.test/api/v1/me/provider-key", "GET"],
      ["https://example.test/api/v1/me/provider-key", "PUT"],
      ["https://example.test/api/v1/me/provider-key", "DELETE"]
    ]);
    expect(requestJsonBody(fetcher, 3)).toHaveProperty("apiKey");
    expect(providerKey).not.toHaveProperty("apiKey");
  });

  it("serializes note-context pagination and sends search filters only in JSON", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ items: [], pageInfo: { hasMore: false, nextCursor: null } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [], pageInfo: { hasMore: false, nextCursor: null } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [], pageInfo: { hasMore: false, nextCursor: null } })
      );
    const client = makeClient(fetcher);

    await client.listNoteSources(NOTE_A, { cursor: "source-page", limit: 20 });
    await client.listNoteBacklinks(NOTE_A, { cursor: "backlink-page", limit: 10 });
    await client.searchNotes({
      query: "roosevelt",
      type: "principle",
      spaceId: null,
      tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"],
      updatedFrom: "2026-08-01T00:00:00.000Z",
      updatedTo: "2026-09-01T00:00:00.000Z",
      privacy: "ai_assisted"
    });

    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(
      `https://example.test/api/v1/notes/${NOTE_A}/sources?limit=20&cursor=source-page`
    );
    expect(requestUrl(fetcher.mock.calls[1]?.[0] ?? "")).toBe(
      `https://example.test/api/v1/notes/${NOTE_A}/backlinks?limit=10&cursor=backlink-page`
    );
    expect(requestUrl(fetcher.mock.calls[2]?.[0] ?? "")).toBe("https://example.test/api/v1/search");
    expect(requestJsonBody(fetcher, 2)).toMatchObject({
      query: "roosevelt",
      spaceId: null,
      type: "principle"
    });
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it("rejects malformed IDs and secret metadata responses at the client boundary", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        providerKey: {
          provider: "openai",
          lastFour: "1234",
          status: "active",
          credentialRevision: 1,
          validatedAt: NOW,
          updatedAt: NOW,
          apiKey: "must-not-cross-the-response-boundary"
        }
      })
    );
    const client = makeClient(fetcher);

    expect(() => client.listGeneratedBlocks("note_bad")).toThrow();
    await expect(client.getProviderKeyMetadata()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
