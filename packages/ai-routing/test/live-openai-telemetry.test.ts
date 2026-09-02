import { describe, expect, it } from "vitest";

import {
  LiveOpenAIEvaluationConfigurationError,
  createOpenAIEvaluationInstrumentation,
  evaluationSha256,
  requireExplicitLiveOpenAIEvaluationKey,
  summarizeOpenAIEvaluationTelemetry
} from "../src/index.js";

const MODEL = "gpt-5.6-terra";

function requestBody(): string {
  return JSON.stringify({
    input: [
      {
        content: [
          {
            text: JSON.stringify({
              candidates: [{ candidateId: "note_secret", title: "sensitive title" }],
              capture: { text: "sensitive capture" }
            }),
            type: "input_text"
          }
        ],
        role: "user"
      }
    ],
    instructions: "Private routing prompt",
    model: MODEL,
    text: {
      format: {
        name: "organization_plan",
        schema: { properties: { decision: { type: "string" } }, type: "object" },
        strict: true,
        type: "json_schema"
      }
    }
  });
}

describe("live OpenAI evaluation telemetry", () => {
  it("requires the dedicated explicit evaluation key and never falls back implicitly", () => {
    expect(() => requireExplicitLiveOpenAIEvaluationKey(undefined)).toThrow(
      LiveOpenAIEvaluationConfigurationError
    );
    expect(() => requireExplicitLiveOpenAIEvaluationKey("test-key")).toThrow(
      "invalid_explicit_openai_api_key"
    );
    const syntheticKey = "a".repeat(32);
    expect(requireExplicitLiveOpenAIEvaluationKey(syntheticKey)).toBe(syntheticKey);
  });

  it("records hashes, latency, usage, and configured-model cost without retaining note text", async () => {
    const clock = [100, 112];
    const instrumentation = createOpenAIEvaluationInstrumentation({
      candidateAlgorithmVersion: "private-rag.1.1.1",
      candidateFixtureVersion: "synthetic-frozen-routing-fixtures.v1",
      fetchImplementation: () =>
        Promise.resolve(
          Response.json({
            model: MODEL,
            status: "completed",
            usage: {
              input_tokens: 1_000,
              input_tokens_details: { cached_tokens: 200 },
              output_tokens: 100,
              total_tokens: 1_100
            }
          })
        ),
      now: () => clock.shift() ?? 112,
      promptVersion: "routing-v1",
      schemaVersion: 1
    });

    const response = await instrumentation.fetchImplementation(
      "https://api.openai.com/v1/responses",
      {
        body: requestBody(),
        method: "POST"
      }
    );
    expect(await response.json()).toMatchObject({ status: "completed" });

    const attempts = instrumentation.drain();
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];
    if (attempt === undefined) throw new Error("Missing telemetry attempt");
    expect(attempt).toMatchObject({
      estimatedCostUsd: 0.0032,
      httpStatus: 200,
      latencyMs: 12,
      pricingModelMatched: true,
      requestCompleted: true,
      usage: {
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 100,
        totalTokens: 1_100
      },
      versions: {
        candidateAlgorithm: "private-rag.1.1.1",
        candidateFixtures: "synthetic-frozen-routing-fixtures.v1",
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
    expect(instrumentation.snapshot()).toEqual([]);
  });

  it("records network failures safely and does not estimate cost for an unpriced model", async () => {
    const failed = createOpenAIEvaluationInstrumentation({
      candidateAlgorithmVersion: "private-rag.1.1.1",
      candidateFixtureVersion: "synthetic-frozen-routing-fixtures.v1",
      fetchImplementation: () => Promise.reject(new Error("secret provider detail")),
      now: (() => {
        let value = 0;
        return () => {
          value += 5;
          return value;
        };
      })(),
      promptVersion: "routing-v1",
      schemaVersion: 1
    });
    await expect(
      failed.fetchImplementation("https://api.openai.com/v1/responses", {
        body: requestBody(),
        method: "POST"
      })
    ).rejects.toThrow("secret provider detail");
    expect(failed.drain()[0]).toMatchObject({
      estimatedCostUsd: 0,
      httpStatus: null,
      requestCompleted: false
    });

    const unpriced = createOpenAIEvaluationInstrumentation({
      candidateAlgorithmVersion: "private-rag.1.1.1",
      candidateFixtureVersion: "synthetic-frozen-routing-fixtures.v1",
      fetchImplementation: () =>
        Promise.resolve(
          Response.json({
            model: "different-model",
            usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 }
          })
        ),
      promptVersion: "routing-v1",
      schemaVersion: 1
    });
    await unpriced.fetchImplementation("https://api.openai.com/v1/responses", {
      body: requestBody(),
      method: "POST"
    });
    expect(unpriced.drain()[0]).toMatchObject({
      estimatedCostUsd: 0,
      pricingModelMatched: false
    });
  });

  it("summarizes token, cost, and latency totals and hashes canonically", () => {
    expect(evaluationSha256({ b: 2, a: 1 })).toBe(evaluationSha256({ a: 1, b: 2 }));
    const base = {
      hashes: {
        candidateAlgorithmVersionSha256: "a".repeat(64),
        candidateFixtureVersionSha256: "b".repeat(64),
        modelVersionSha256: "c".repeat(64),
        promptContentSha256: "d".repeat(64),
        promptVersionSha256: "e".repeat(64),
        schemaContentSha256: "f".repeat(64),
        schemaVersionSha256: "0".repeat(64)
      },
      httpStatus: 200,
      pricingModelMatched: true,
      requestCompleted: true,
      versions: {
        candidateAlgorithm: "private-rag.1.1.1",
        candidateFixtures: "synthetic-frozen-routing-fixtures.v1",
        model: MODEL,
        prompt: "routing-v1",
        schema: 1
      }
    } as const;
    const summary = summarizeOpenAIEvaluationTelemetry([
      {
        ...base,
        attempt: 1,
        estimatedCostUsd: 0.001,
        latencyMs: 10,
        usage: { cachedInputTokens: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 }
      },
      {
        ...base,
        attempt: 2,
        estimatedCostUsd: 0.002,
        latencyMs: 30,
        usage: { cachedInputTokens: 2, inputTokens: 20, outputTokens: 4, totalTokens: 24 }
      },
      {
        ...base,
        attempt: 3,
        estimatedCostUsd: 0.003,
        latencyMs: 20,
        usage: { cachedInputTokens: 3, inputTokens: 30, outputTokens: 6, totalTokens: 36 }
      }
    ]);
    expect(summary).toEqual({
      attempts: 3,
      estimatedCostUsd: 0.006,
      latencyMs: { max: 30, p50: 20, p95: 30 },
      usage: { cachedInputTokens: 6, inputTokens: 60, outputTokens: 12, totalTokens: 72 }
    });
  });
});
