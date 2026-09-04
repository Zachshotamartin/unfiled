import { describe, expect, it, vi } from "vitest";

import { ANTHROPIC_ORGANIZATION_TOOL_NAME } from "../src/anthropic-schema.js";
import { OrganizerUnavailableError } from "../src/errors.js";
import type { PlannerInput } from "../src/planner.js";
import {
  createOrganizerProviderCredentialAccess,
  type LeaseBoundOrganizerProviderRoute
} from "../src/provider-credential.js";
import { createOrganizerProviderPlanner } from "../src/provider-multiplexer.js";
import { createProviderRegistryPlanner } from "../src/provider-planner.js";
import { ORGANIZER_PROMPT_VERSION } from "../src/prompt.js";

const OPENAI_KEY = "sk-byok-openai-abcdefghijklmnopqrstuvwxyz0123456789";
const CLAUDE_KEY = "sk-ant-byok-claude-abcdefghijklmnopqrstuvwxyz0123456789";
const candidateId = "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const;
const noteId = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const;
const controls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: noteId,
  ruleMatch: null
});
const plan = Object.freeze({
  alternatives: [],
  captureKind: "freeform",
  decision: "append_to_note",
  destination: { candidateId, newNote: null },
  generatedExpansion: null,
  operations: [{ content: "Remember milk", type: "append_raw" }],
  reasonCodes: ["explicit_destination"],
  schemaVersion: 1
});

function plannerInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    capture: { controls, rawContent: "Remember milk" },
    candidates: [
      {
        bodyMarkdown: "# Shopping\nlatest bounded snippet",
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
    promptVersion: ORGANIZER_PROMPT_VERSION,
    schemaVersion: 1,
    signal: new AbortController().signal,
    ...overrides
  };
}

function openAiRoute(): LeaseBoundOrganizerProviderRoute {
  return {
    adapterRegistryVersion: "organization-model-registry-v2",
    credential: OPENAI_KEY,
    credentialRevision: 1,
    expansionStyle: "brief",
    modelId: "gpt-5.6-terra",
    modelSelection: "auto",
    provider: "openai",
    routingEffort: "standard",
    settingsRevision: 1,
    source: "byok"
  };
}

function claudeRoute(): LeaseBoundOrganizerProviderRoute {
  return {
    ...openAiRoute(),
    credential: CLAUDE_KEY,
    modelId: "claude-sonnet-5",
    provider: "anthropic"
  };
}

function disclosedCandidateId(init: RequestInit | undefined, provider: "openai" | "anthropic") {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON body.");
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const text =
    provider === "openai"
      ? (body.input as { content: { text: string }[] }[])[0]?.content[0]?.text
      : (body.messages as { content: { text: string }[] }[])[0]?.content[0]?.text;
  if (text === undefined) throw new Error("Expected disclosed input.");
  const disclosed = JSON.parse(text) as { candidates: { candidateId: string }[] };
  const alias = disclosed.candidates[0]?.candidateId;
  if (alias === undefined) throw new Error("Expected a candidate alias.");
  return alias;
}

function providerFetch() {
  return vi.fn<typeof fetch>().mockImplementation((url, init) => {
    if (url === "https://api.openai.com/v1/responses") {
      const alias = disclosedCandidateId(init, "openai");
      return Promise.resolve(
        Response.json({
          output: [
            {
              content: [
                {
                  text: JSON.stringify({
                    ...plan,
                    destination: { candidateId: alias, newNote: null }
                  }),
                  type: "output_text"
                }
              ],
              role: "assistant",
              type: "message"
            }
          ],
          status: "completed"
        })
      );
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      const alias = disclosedCandidateId(init, "anthropic");
      return Promise.resolve(
        Response.json({
          content: [
            {
              id: "toolu_1",
              input: { ...plan, destination: { candidateId: alias, newNote: null } },
              name: ANTHROPIC_ORGANIZATION_TOOL_NAME,
              type: "tool_use"
            }
          ],
          id: "msg_1",
          model: "claude-sonnet-5",
          role: "assistant",
          stop_reason: "tool_use",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      );
    }
    return Promise.reject(
      new Error(`unexpected endpoint ${typeof url === "string" ? url : "object"}`)
    );
  });
}

describe("lease-bound provider multiplexer", () => {
  it("routes each credential to exactly its own provider endpoint and header scheme", async () => {
    const fetchImplementation = providerFetch();
    const planner = createOrganizerProviderPlanner({ fetchImplementation });

    const openAi = createOrganizerProviderCredentialAccess({
      appDefaultApiKeys: {},
      resolve: vi.fn().mockResolvedValue(openAiRoute())
    });
    await expect(planner.plan(plannerInput({ providerCredential: openAi }))).resolves.toEqual(plan);
    const claude = createOrganizerProviderCredentialAccess({
      appDefaultApiKeys: {},
      resolve: vi.fn().mockResolvedValue(claudeRoute())
    });
    await expect(planner.plan(plannerInput({ providerCredential: claude }))).resolves.toEqual(plan);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [openAiUrl, openAiInit] = fetchImplementation.mock.calls[0] ?? [];
    const [claudeUrl, claudeInit] = fetchImplementation.mock.calls[1] ?? [];
    expect(openAiUrl).toBe("https://api.openai.com/v1/responses");
    expect(openAiInit?.headers).toMatchObject({ authorization: `Bearer ${OPENAI_KEY}` });
    expect(openAiInit?.headers).not.toHaveProperty("x-api-key");
    expect(claudeUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(claudeInit?.headers).toMatchObject({ "x-api-key": CLAUDE_KEY });
    expect(claudeInit?.headers).not.toHaveProperty("authorization");
    const serialized = JSON.stringify(fetchImplementation.mock.calls);
    expect(serialized.indexOf(CLAUDE_KEY)).toBe(serialized.lastIndexOf(CLAUDE_KEY));
    expect(serialized.indexOf(OPENAI_KEY)).toBe(serialized.lastIndexOf(OPENAI_KEY));
    expect(JSON.stringify(openAiInit)).not.toContain(CLAUDE_KEY);
    expect(JSON.stringify(claudeInit)).not.toContain(OPENAI_KEY);
    expect(openAi.lastSelection()).toMatchObject({ modelId: "gpt-5.6-terra", provider: "openai" });
    expect(claude.lastSelection()).toMatchObject({
      modelId: "claude-sonnet-5",
      provider: "anthropic"
    });
  });

  it("requires a lease-bound credential and never falls back to an explicit key", async () => {
    const fetchImplementation = providerFetch();
    await expect(
      createOrganizerProviderPlanner({ fetchImplementation }).plan(plannerInput())
    ).rejects.toMatchObject({ retryable: true, safeCode: "provider_unavailable" });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(() => createProviderRegistryPlanner([], {})).toThrow(OrganizerUnavailableError);
  });

  it("fails closed when the live credential disagrees with the snapshotted effort", async () => {
    const fetchImplementation = providerFetch();
    const claude = createOrganizerProviderCredentialAccess({
      appDefaultApiKeys: {},
      resolve: vi.fn().mockResolvedValue({
        ...claudeRoute(),
        modelId: "claude-opus-5",
        routingEffort: "thorough"
      })
    });
    await expect(
      createOrganizerProviderPlanner({ fetchImplementation }).plan(
        plannerInput({ providerCredential: claude, routingEffort: "standard" })
      )
    ).rejects.toMatchObject({ retryable: false, safeCode: "provider_unavailable" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
