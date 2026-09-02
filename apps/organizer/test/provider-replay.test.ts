import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ANTHROPIC_PROVIDER_ADAPTER } from "../src/anthropic-planner.js";
import { OrganizerPlannerReviewError, OrganizerProviderError } from "../src/errors.js";
import { OPENAI_PROVIDER_ADAPTER } from "../src/openai-planner.js";
import type { PlannerInput } from "../src/planner.js";
import { createOrganizerProviderCredentialAccess } from "../src/provider-credential.js";
import { createOrganizerProviderPlanner } from "../src/provider-multiplexer.js";

type Fixture = Readonly<Record<string, unknown>>;

function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/provider-responses/${name}.json`, import.meta.url)),
      "utf8"
    )
  ) as Fixture;
}

const openAi = fixture("openai-responses");
const anthropic = fixture("anthropic-messages");
const candidateId = "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const;
const noteId = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const;
const controls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: null
});

function plannerInput(): PlannerInput {
  return {
    capture: { controls, rawContent: "- milk\n- bread" },
    candidates: [
      {
        bodyMarkdown: "# Shopping\n- eggs",
        candidateId,
        isOpen: true,
        noteId,
        noteType: "list",
        revision: 2,
        structuredData: { items: [], schemaVersion: 1 },
        title: "Shopping"
      }
    ],
    captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    controls,
    promptVersion: "routing-v1",
    schemaVersion: 1,
    signal: new AbortController().signal
  };
}

/** Rewrites the fixture's placeholder alias to the alias disclosed in this request. */
function withAlias(value: unknown, alias: string): unknown {
  return JSON.parse(
    JSON.stringify(value).replaceAll("candidate_00000000000000000000000000000001", alias)
  ) as unknown;
}

function disclosedAlias(init: RequestInit | undefined, provider: "openai" | "anthropic"): string {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON body.");
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const text =
    provider === "openai"
      ? (body.input as { content: { text: string }[] }[])[0]?.content[0]?.text
      : (body.messages as { content: { text: string }[] }[])[0]?.content[0]?.text;
  if (text === undefined) throw new Error("Expected disclosed input.");
  const alias = (JSON.parse(text) as { candidates: { candidateId: string }[] }).candidates[0]
    ?.candidateId;
  if (alias === undefined) throw new Error("Expected a candidate alias.");
  return alias;
}

function route(provider: "openai" | "anthropic") {
  return {
    adapterRegistryVersion: "organization-model-registry-v2" as const,
    credential: `sk-replay-${provider}-abcdefghijklmnopqrstuvwxyz0123456789`,
    credentialRevision: 1,
    expansionStyle: "brief" as const,
    modelId: provider === "openai" ? ("gpt-5.6-terra" as const) : ("claude-sonnet-5" as const),
    modelSelection: "auto" as const,
    provider,
    routingEffort: "standard" as const,
    settingsRevision: 1,
    source: "byok" as const
  };
}

describe("recorded provider response replay", () => {
  it("parses each provider's documented success shape into the same unvalidated plan record", () => {
    const fromOpenAi = OPENAI_PROVIDER_ADAPTER.parseResponse(openAi.success);
    const fromAnthropic = ANTHROPIC_PROVIDER_ADAPTER.parseResponse(anthropic.success);
    expect(fromOpenAi).toEqual(fromAnthropic);
    expect(fromOpenAi).toMatchObject({ decision: "append_to_note", schemaVersion: 1 });
  });

  it.each([
    ["openai", "refusal", "refusal"],
    ["openai", "incomplete", "incomplete"],
    ["openai", "twoMessages", "invalid_output"],
    ["anthropic", "refusal", "refusal"],
    ["anthropic", "maxTokens", "incomplete"],
    ["anthropic", "textOnly", "invalid_output"]
  ] as const)("defers the recorded %s %s shape to Review as %s", (provider, name, reason) => {
    const adapter = provider === "openai" ? OPENAI_PROVIDER_ADAPTER : ANTHROPIC_PROVIDER_ADAPTER;
    const body = provider === "openai" ? openAi[name] : anthropic[name];
    let caught: unknown;
    try {
      adapter.parseResponse(body);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrganizerPlannerReviewError);
    expect(caught).toMatchObject({ reason });
    expect(String(caught)).not.toContain("CANARY");
  });

  it("treats the recorded Claude error envelope as a transient provider failure", () => {
    let caught: unknown;
    try {
      ANTHROPIC_PROVIDER_ADAPTER.parseResponse(anthropic.errorEnvelope);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrganizerProviderError);
    expect(caught).toMatchObject({ retryable: true, safeCode: "provider_unavailable" });
    expect(String(caught)).not.toContain("CANARY");
  });

  it.each(["openai", "anthropic"] as const)(
    "replays the recorded %s success through the full lease-bound planner",
    async (provider) => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockImplementation((_url, init) =>
          Promise.resolve(
            Response.json(
              withAlias(
                provider === "openai" ? openAi.success : anthropic.success,
                disclosedAlias(init, provider)
              )
            )
          )
        );
      const providerCredential = createOrganizerProviderCredentialAccess({
        appDefaultApiKeys: {},
        resolve: vi.fn().mockResolvedValue(route(provider))
      });
      await expect(
        createOrganizerProviderPlanner({ fetchImplementation }).plan({
          ...plannerInput(),
          providerCredential
        })
      ).resolves.toMatchObject({
        captureKind: "list_items",
        decision: "append_to_note",
        destination: { candidateId, newNote: null },
        operations: [{ items: ["milk", "bread"], section: null, type: "append_list_items" }]
      });
      expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
        provider === "openai"
          ? "https://api.openai.com/v1/responses"
          : "https://api.anthropic.com/v1/messages"
      );
    }
  );
});
