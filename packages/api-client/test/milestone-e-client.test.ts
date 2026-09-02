import { describe, expect, it, vi } from "vitest";

import {
  GeneratedBlockDtoSchema,
  MAX_PROVIDER_KEY_RESPONSE_BYTES,
  manualNoteFixtures,
  type GeneratedBlockDto
} from "@unfiled/contracts";

import { ApiClientMalformedResponseError, createApiClient } from "../src/index.js";

const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const DECISION_ID = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const DECISION_OTHER = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const REVIEW_ID = "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const RULE_ID = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const BLOCK_ID = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const BLOCK_OTHER = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const MUTATION_A = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_B = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const NOW = "2026-09-01T18:30:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
      pragma: "no-cache"
    },
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

function oversizedStreamResponse(status: number, onCancel: () => void): Response {
  const chunk = new Uint8Array(1024 * 1024);
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel: onCancel,
      start(controller) {
        for (let index = 0; index < 9; index += 1) controller.enqueue(chunk);
      }
    }),
    { status }
  );
}

function generatedBlock(overrides: Readonly<Partial<GeneratedBlockDto>> = {}): GeneratedBlockDto {
  return GeneratedBlockDtoSchema.parse({
    id: BLOCK_ID,
    noteId: NOTE_A,
    decisionId: DECISION_ID,
    kind: "suggestion",
    content: "A useful expansion",
    state: "proposed",
    stateRevision: 1,
    modelId: "gpt-test",
    promptVersion: "organizer-v1",
    createdAt: NOW,
    resolvedAt: null,
    ...overrides
  });
}

async function expectRoutingRuleMutationsToBoundStreamedResponse(status: number): Promise<void> {
  const fetcher = vi.fn<typeof fetch>();
  const client = makeClient(fetcher);
  const mutations = [
    () =>
      client.createRoutingRule({
        idempotencyKey: "rule-create-bound-01",
        enabled: true,
        ruleType: "phrase",
        condition: "groceries",
        destination: { type: "note", noteId: NOTE_A },
        priority: 100
      }),
    () =>
      client.updateRoutingRule(RULE_ID, {
        expectedRevision: 1,
        idempotencyKey: "rule-update-bound-01",
        priority: 110
      }),
    () =>
      client.deleteRoutingRule(RULE_ID, {
        expectedRevision: 2,
        idempotencyKey: "rule-delete-bound-01"
      })
  ];

  for (const mutate of mutations) {
    const cancellation = vi.fn();
    fetcher.mockResolvedValueOnce(oversizedStreamResponse(status, cancellation));
    await expect(mutate()).rejects.toMatchObject({
      name: "ApiClientMalformedResponseError",
      status
    });
    expect(cancellation).toHaveBeenCalledOnce();
  }
}

describe("Milestone E/F API client", () => {
  it("retries an ambiguous correction with the exact idempotency key and body", async () => {
    const correctionInput = {
      idempotencyKey: "correct-observation-retry-01",
      source: { noteId: NOTE_A, expectedRevision: 4 },
      destination: { type: "existing_note", noteId: NOTE_B, expectedRevision: 2 }
    } as const;
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
      replayed: true
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "provider_unavailable",
            message: "Unfiled could not complete that request. Try again.",
            requestId: "request-observation-retry"
          },
          503
        )
      )
      .mockResolvedValueOnce(jsonResponse(correction));
    const client = makeClient(fetcher);

    await expect(client.correctDecision(DECISION_ID, correctionInput)).rejects.toMatchObject({
      status: 503,
      error: {
        code: "provider_unavailable",
        requestId: "request-observation-retry"
      }
    });
    await expect(client.correctDecision(DECISION_ID, correctionInput)).resolves.toEqual(correction);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestJsonBody(fetcher, 0)).toEqual(correctionInput);
    expect(requestJsonBody(fetcher, 1)).toEqual(correctionInput);
    expect(fetcher.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "idempotency-key": correctionInput.idempotencyKey }),
      expect.objectContaining({ "idempotency-key": correctionInput.idempotencyKey })
    ]);
  });

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
      destinationStatus: "active",
      priority: 100,
      source: "explicit",
      proposalState: null,
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
      modelId: "gpt-5.6-terra",
      promptVersion: "organizer-v1",
      createdAt: NOW,
      resolvedAt: NOW
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ items: [rule], pageInfo: { hasMore: false, nextCursor: null } })
      )
      .mockResolvedValueOnce(jsonResponse({ rule, replayed: false }, 201))
      .mockResolvedValueOnce(jsonResponse({ rule: { ...rule, revision: 2 }, replayed: false }))
      .mockResolvedValueOnce(jsonResponse({ ruleId: RULE_ID, deleted: true, replayed: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ ...block, state: "proposed", stateRevision: 1, resolvedAt: null }],
          pageInfo: { hasMore: false, nextCursor: null }
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
    await client.resolveGeneratedBlock(generatedBlock({ modelId: block.modelId }), {
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

  it("retries an ambiguous generated-block resolution with the exact body and key", async () => {
    const input = {
      expectedStateRevision: 1,
      idempotencyKey: "block-retry-01",
      resolution: "accept" as const
    };
    const accepted = generatedBlock({ state: "accepted", stateRevision: 2, resolvedAt: NOW });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "provider_unavailable",
            message: "Unfiled could not complete that request. Try again.",
            requestId: "request-block-retry"
          },
          503
        )
      )
      .mockResolvedValueOnce(jsonResponse({ block: accepted, replayed: true }));
    const client = makeClient(fetcher);

    await expect(client.resolveGeneratedBlock(generatedBlock(), input)).rejects.toMatchObject({
      status: 503
    });
    await expect(client.resolveGeneratedBlock(generatedBlock(), input)).resolves.toEqual({
      block: accepted,
      replayed: true
    });
    expect(requestJsonBody(fetcher, 0)).toEqual(input);
    expect(requestJsonBody(fetcher, 1)).toEqual(input);
    expect(fetcher.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "idempotency-key": input.idempotencyKey }),
      expect.objectContaining({ "idempotency-key": input.idempotencyKey })
    ]);
  });

  it("rejects duplicate, cross-note, and mismatched generated-block responses", async () => {
    const otherNoteBlock = generatedBlock({ noteId: NOTE_B });
    const proposed = generatedBlock();
    const wrongTerminal = generatedBlock({
      state: "accepted",
      stateRevision: 3,
      resolvedAt: NOW
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ items: [otherNoteBlock], pageInfo: { hasMore: false, nextCursor: null } })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [proposed, proposed],
          pageInfo: { hasMore: false, nextCursor: null }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ block: wrongTerminal, replayed: false }));
    const client = makeClient(fetcher);

    await expect(client.listGeneratedBlocks(NOTE_A)).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
    await expect(client.listGeneratedBlocks(NOTE_A)).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
    await expect(
      client.resolveGeneratedBlock(proposed, {
        expectedStateRevision: 1,
        idempotencyKey: "block-mismatch-01",
        resolution: "accept"
      })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
  });

  it("threads generated-block cursors and binds exact reads to both block and note", async () => {
    const next = generatedBlock({ id: BLOCK_OTHER });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ items: [next], pageInfo: { hasMore: false, nextCursor: null } })
      )
      .mockResolvedValueOnce(jsonResponse({ block: next }))
      .mockResolvedValueOnce(jsonResponse({ block: generatedBlock({ noteId: NOTE_B }) }))
      .mockResolvedValueOnce(jsonResponse({ block: next }));
    const client = makeClient(fetcher);

    await expect(client.listGeneratedBlocks(NOTE_A, { cursor: BLOCK_ID })).resolves.toEqual({
      items: [next],
      pageInfo: { hasMore: false, nextCursor: null }
    });
    await expect(client.getGeneratedBlock(BLOCK_OTHER, NOTE_A)).resolves.toEqual({ block: next });
    await expect(client.getGeneratedBlock(BLOCK_ID, NOTE_A)).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
    await expect(client.getGeneratedBlock(BLOCK_ID, NOTE_A)).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );

    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? "")).toBe(
      `https://example.test/api/v1/notes/${NOTE_A}/generated-blocks?cursor=${BLOCK_ID}`
    );
    expect(requestUrl(fetcher.mock.calls[1]?.[0] ?? "")).toBe(
      `https://example.test/api/v1/generated-blocks/${BLOCK_OTHER}`
    );
  });

  it("rejects retained rejected content from public generated-block reads", async () => {
    const rejected = generatedBlock({
      state: "rejected",
      stateRevision: 2,
      resolvedAt: NOW
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ items: [rejected], pageInfo: { hasMore: false, nextCursor: null } })
      )
      .mockResolvedValueOnce(jsonResponse({ block: rejected }))
      .mockResolvedValueOnce(jsonResponse({ block: rejected, replayed: true }));
    const client = makeClient(fetcher);

    await expect(client.listGeneratedBlocks(NOTE_A)).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
    await expect(client.getGeneratedBlock(BLOCK_ID, NOTE_A)).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
    await expect(
      client.resolveGeneratedBlock(generatedBlock(), {
        expectedStateRevision: 1,
        idempotencyKey: "block-rejected-replay-01",
        resolution: "reject"
      })
    ).resolves.toEqual({ block: rejected, replayed: true });
  });

  it("binds every immutable generated-block field before trusting a resolution", async () => {
    const source = generatedBlock();
    const substitutions: readonly Readonly<Partial<GeneratedBlockDto>>[] = [
      { id: BLOCK_OTHER },
      { noteId: NOTE_B },
      { decisionId: DECISION_OTHER },
      { kind: "summary" },
      { content: "Substituted generated content" },
      { modelId: "substituted-model" },
      { promptVersion: "substituted-prompt" },
      { createdAt: "2026-09-01T18:29:00.000Z" }
    ];

    for (const [index, substitution] of substitutions.entries()) {
      const responseBlock = generatedBlock({
        state: "accepted",
        stateRevision: 2,
        resolvedAt: NOW,
        ...substitution
      });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ block: responseBlock, replayed: false }));
      const client = makeClient(fetcher);

      await expect(
        client.resolveGeneratedBlock(source, {
          expectedStateRevision: 1,
          idempotencyKey: `block-substitution-${index}`,
          resolution: "accept"
        })
      ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
    }
  });

  it("cancels oversized generated-block list and resolution responses", async () => {
    const listCancellation = vi.fn();
    const resolutionCancellation = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oversizedStreamResponse(200, listCancellation))
      .mockResolvedValueOnce(oversizedStreamResponse(200, resolutionCancellation));
    const client = makeClient(fetcher);

    await expect(client.listGeneratedBlocks(NOTE_A)).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
    await expect(
      client.resolveGeneratedBlock(generatedBlock(), {
        expectedStateRevision: 1,
        idempotencyKey: "block-bound-01",
        resolution: "reject"
      })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
    expect(listCancellation).toHaveBeenCalledOnce();
    expect(resolutionCancellation).toHaveBeenCalledOnce();
  });

  it("aggregates every bounded routing-rule page without losing retained rules", async () => {
    const rule = (index: number) => {
      const id = `rule_${String(index).padStart(26, "0")}`;
      return {
        id,
        revision: 1,
        enabled: false,
        ruleType: "phrase",
        condition: `rule ${index}`,
        normalizedCondition: `rule ${index}`,
        aliases: [],
        destination: { type: "note", noteId: NOTE_A },
        destinationStatus: "active",
        priority: 100,
        source: "explicit",
        proposalState: null,
        lastFiredAt: null,
        createdAt: NOW,
        updatedAt: NOW
      } as const;
    };
    const first = Array.from({ length: 50 }, (_, index) => rule(index));
    const second = [rule(50)];
    const cursor = first.at(-1)?.id;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ items: first, pageInfo: { hasMore: true, nextCursor: cursor } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: second, pageInfo: { hasMore: false, nextCursor: null } })
      );

    const response = await makeClient(fetcher).listAllRoutingRules();
    expect(response.items).toHaveLength(51);
    expect(response.items[0]).toEqual(first[0]);
    expect(response.items[50]).toEqual(second[0]);
    expect(requestUrl(fetcher.mock.calls[1]?.[0] ?? "")).toBe(
      `https://example.test/api/v1/routing-rules?cursor=${cursor}`
    );
  });

  it("exports a sanitized ambiguous error for malformed successes and error envelopes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: "secret malformed success" }))
      .mockResolvedValueOnce(
        new Response("<html>secret gateway body</html>", {
          headers: { "content-type": "text/html" },
          status: 503
        })
      );
    const client = makeClient(fetcher);

    for (const expectedStatus of [200, 503]) {
      try {
        await client.listRoutingRules();
        expect.unreachable("Expected malformed response rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiClientMalformedResponseError);
        expect(error).toMatchObject({ status: expectedStatus });
        expect(String(error)).not.toContain("secret");
      }
    }
  });

  it("cuts off declared and chunked routing pages above the eight-MiB wire bound", async () => {
    const oversized = 8 * 1024 * 1024 + 1;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("{}", { headers: { "content-length": String(oversized) } })
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(oversized));
              controller.close();
            }
          })
        )
      );
    const client = makeClient(fetcher);

    await expect(client.listRoutingRules()).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
    await expect(client.listRoutingRules()).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
  });

  it("cuts off streamed routing-rule mutation successes above eight MiB", async () => {
    await expectRoutingRuleMutationsToBoundStreamedResponse(200);
  });

  it("cuts off streamed routing-rule mutation errors above eight MiB", async () => {
    await expectRoutingRuleMutationsToBoundStreamedResponse(500);
  });

  it("updates settings and keeps provider secrets out of decoded metadata", async () => {
    const settings = {
      settingsRevision: 3,
      organizationMode: "balanced",
      providerMode: "byok",
      byokProvider: "openai",
      modelSelection: "auto",
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
        jsonResponse({
          settings: { ...settings, settingsRevision: 4, routingEffort: "thorough" },
          replayed: false
        })
      )
      .mockResolvedValueOnce(jsonResponse({ providerKey: null }))
      .mockResolvedValueOnce(jsonResponse({ providerKey, replayed: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          provider: "openai",
          deleted: true,
          deletedCredentialRevision: 1,
          replayed: false
        })
      );
    const client = makeClient(fetcher);

    await client.getUserSettings();
    await client.updateUserSettings({
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-update-01",
      routingEffort: "thorough"
    });
    await client.getProviderKeyMetadata("openai");
    await expect(
      client.putProviderKey({
        idempotencyKey: "provider-put-01",
        provider: "openai",
        expectedCredentialRevision: null,
        apiKey: "sk-example-not-a-real-key-1234"
      })
    ).resolves.toEqual({ providerKey, replayed: false });
    await client.deleteProviderKey({
      idempotencyKey: "provider-delete-01",
      provider: "openai",
      expectedCredentialRevision: 1
    });

    expect(fetcher.mock.calls.map(([url, init]) => [requestUrl(url), init?.method])).toEqual([
      ["https://example.test/api/v1/me/settings", "GET"],
      ["https://example.test/api/v1/me/settings", "PATCH"],
      ["https://example.test/api/v1/me/provider-key?provider=openai", "GET"],
      ["https://example.test/api/v1/me/provider-key", "PUT"],
      ["https://example.test/api/v1/me/provider-key", "DELETE"]
    ]);
    expect(requestJsonBody(fetcher, 3)).toHaveProperty("apiKey");
    expect(providerKey).not.toHaveProperty("apiKey");
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
    expect(
      fetcher.mock.calls.every(([, init]) => {
        const headers = new Headers(init?.headers);
        return headers.get("cache-control") === "no-store" && headers.get("pragma") === "no-cache";
      })
    ).toBe(true);
  });

  it("rejects hidden providers and response substitution before settings or key state is trusted", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          providerKey: {
            provider: "openai",
            lastFour: "1234",
            status: "active",
            credentialRevision: 8,
            validatedAt: NOW,
            updatedAt: NOW
          },
          replayed: false
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          providerKey: {
            provider: "openai",
            lastFour: "0000",
            status: "active",
            credentialRevision: 6,
            validatedAt: NOW,
            updatedAt: NOW
          },
          replayed: true
        })
      );
    const client = makeClient(fetcher);

    await expect(
      client.putProviderKey({
        idempotencyKey: "provider-hidden-01",
        // @ts-expect-error The runtime boundary must reject unsupported callers too.
        provider: "unsupported",
        expectedCredentialRevision: null,
        apiKey: "sk-ant-example-not-a-real-key-1234"
      })
    ).rejects.toThrow();
    await expect(
      client.putProviderKey({
        idempotencyKey: "provider-stale-response-01",
        provider: "openai",
        expectedCredentialRevision: 5,
        apiKey: "sk-example-not-a-real-key-1234"
      })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
    await expect(
      client.putProviderKey({
        idempotencyKey: "provider-secret-substitution-01",
        provider: "openai",
        expectedCredentialRevision: 5,
        apiKey: "sk-example-not-a-real-key-1234"
      })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
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
    await expect(client.getProviderKeyMetadata("openai")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires private transport headers and caps provider metadata responses", async () => {
    const missingPrivateHeaders = makeClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ providerKey: null }), {
          headers: { "content-type": "application/json" }
        })
      )
    );
    await expect(missingPrivateHeaders.getProviderKeyMetadata("anthropic")).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );

    const cancellation = vi.fn();
    const oversized = makeClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: cancellation,
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_PROVIDER_KEY_RESPONSE_BYTES + 1));
            }
          }),
          { headers: { "cache-control": "private, no-store", pragma: "no-cache" } }
        )
      )
    );
    await expect(oversized.getProviderKeyMetadata("openai")).rejects.toBeInstanceOf(
      ApiClientMalformedResponseError
    );
    expect(cancellation).toHaveBeenCalledOnce();
  });
});
