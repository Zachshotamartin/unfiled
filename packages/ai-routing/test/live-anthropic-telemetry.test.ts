import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_ROUTING_EVALUATION_PRICING,
  LiveEvaluationConfigurationError,
  OPENAI_ROUTING_EVALUATION_PRICING,
  anthropicEvaluationPricingForModel,
  createAnthropicEvaluationInstrumentation,
  openAiEvaluationPricingForModel,
  requireExplicitLiveAnthropicEvaluationKey,
  summarizeAnthropicEvaluationTelemetry
} from "../src/index.js";

const MODEL = "claude-sonnet-5";

function requestBody(): string {
  return JSON.stringify({
    max_tokens: 12_288,
    messages: [
      {
        content: [
          {
            text: JSON.stringify({
              candidates: [{ candidateId: "note_secret", title: "sensitive title" }],
              capture: { text: "sensitive capture" }
            }),
            type: "text"
          }
        ],
        role: "user"
      }
    ],
    model: MODEL,
    output_config: { effort: "medium" },
    system: "Private routing prompt",
    tool_choice: { name: "unfiled_organization_plan_v1", type: "tool" },
    tools: [
      {
        input_schema: { properties: { decision: { type: "string" } }, type: "object" },
        name: "unfiled_organization_plan_v1",
        strict: true
      }
    ]
  });
}

describe("live Claude evaluation telemetry", () => {
  it("pins list prices for exactly the registry-v2 models of both providers", () => {
    expect(Object.keys(ANTHROPIC_ROUTING_EVALUATION_PRICING).sort()).toEqual([
      "claude-opus-5",
      "claude-sonnet-5"
    ]);
    expect(Object.keys(OPENAI_ROUTING_EVALUATION_PRICING).sort()).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra"
    ]);
    expect(anthropicEvaluationPricingForModel("claude-opus-5")).toMatchObject({
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25
    });
    expect(anthropicEvaluationPricingForModel("gpt-5.6-terra")).toBeNull();
    expect(openAiEvaluationPricingForModel("claude-sonnet-5")).toBeNull();
    expect(openAiEvaluationPricingForModel("gpt-5.4-mini-2026-03-17")).toBeNull();
  });

  it("requires the dedicated explicit Claude evaluation key and never falls back implicitly", () => {
    expect(() => requireExplicitLiveAnthropicEvaluationKey(undefined)).toThrow(
      LiveEvaluationConfigurationError
    );
    expect(() => requireExplicitLiveAnthropicEvaluationKey(undefined)).toThrow(
      "missing_explicit_anthropic_api_key"
    );
    expect(() => requireExplicitLiveAnthropicEvaluationKey("test-key")).toThrow(
      "invalid_explicit_anthropic_api_key"
    );
    const syntheticKey = "a".repeat(32);
    expect(requireExplicitLiveAnthropicEvaluationKey(syntheticKey)).toBe(syntheticKey);
  });

  it("records hashes, latency, cache-aware usage, and cost without retaining note text", async () => {
    const clock = [100, 112];
    const instrumentation = createAnthropicEvaluationInstrumentation({
      candidateAlgorithmVersion: "private-rag.1.1.1",
      candidateFixtureVersion: "synthetic-frozen-routing-fixtures.v2",
      fetchImplementation: () =>
        Promise.resolve(
          Response.json({
            content: [],
            model: MODEL,
            role: "assistant",
            stop_reason: "tool_use",
            type: "message",
            usage: {
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 200,
              input_tokens: 700,
              output_tokens: 100
            }
          })
        ),
      now: () => clock.shift() ?? 112,
      promptVersion: "routing-v1",
      schemaVersion: 1
    });

    const response = await instrumentation.fetchImplementation(
      "https://api.anthropic.com/v1/messages",
      { body: requestBody(), method: "POST" }
    );
    expect(await response.json()).toMatchObject({ stop_reason: "tool_use" });

    const attempts = instrumentation.drain();
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];
    if (attempt === undefined) throw new Error("Missing telemetry attempt");
    // 800 uncached-equivalent input (700 + 100 cache write) at $2 + 200 cache reads at $0.20
    // + 100 output at $10 = 0.0016 + 0.00004 + 0.001 = 0.00264 USD.
    expect(attempt).toMatchObject({
      estimatedCostUsd: 0.00264,
      httpStatus: 200,
      latencyMs: 12,
      pricingModelMatched: true,
      requestCompleted: true,
      usage: { cachedInputTokens: 200, inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
      versions: {
        candidateAlgorithm: "private-rag.1.1.1",
        candidateFixtures: "synthetic-frozen-routing-fixtures.v2",
        model: MODEL,
        prompt: "routing-v1",
        schema: 1
      }
    });
    for (const hash of Object.values(attempt.hashes)) expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(attempts);
    expect(serialized).not.toContain("sensitive title");
    expect(serialized).not.toContain("sensitive capture");
    expect(serialized).not.toContain("Private routing prompt");
    expect(serialized).not.toContain("decision");
    expect(instrumentation.snapshot()).toEqual([]);
  });

  it("records failures safely and does not estimate cost for an unpriced model", async () => {
    const failed = createAnthropicEvaluationInstrumentation({
      candidateAlgorithmVersion: "private-rag.1.1.1",
      candidateFixtureVersion: "synthetic-frozen-routing-fixtures.v2",
      fetchImplementation: () => Promise.reject(new Error("secret provider detail")),
      promptVersion: "routing-v1",
      schemaVersion: 1
    });
    await expect(
      failed.fetchImplementation("https://api.anthropic.com/v1/messages", {
        body: requestBody(),
        method: "POST"
      })
    ).rejects.toThrow("secret provider detail");
    expect(failed.drain()[0]).toMatchObject({
      estimatedCostUsd: 0,
      httpStatus: null,
      pricingModelMatched: true,
      requestCompleted: false
    });

    const unpriced = createAnthropicEvaluationInstrumentation({
      candidateAlgorithmVersion: "private-rag.1.1.1",
      candidateFixtureVersion: "synthetic-frozen-routing-fixtures.v2",
      fetchImplementation: () =>
        Promise.resolve(
          Response.json({ model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 5 } })
        ),
      promptVersion: "routing-v1",
      schemaVersion: 1
    });
    await unpriced.fetchImplementation("https://api.anthropic.com/v1/messages", {
      body: requestBody(),
      method: "POST"
    });
    expect(unpriced.drain()[0]).toMatchObject({ estimatedCostUsd: 0, pricingModelMatched: false });
    expect(summarizeAnthropicEvaluationTelemetry([])).toEqual({
      attempts: 0,
      estimatedCostUsd: 0,
      latencyMs: { max: 0, p50: 0, p95: 0 },
      usage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    });
  });
});
