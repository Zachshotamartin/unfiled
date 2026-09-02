import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_ORGANIZATION_PLAN_SCHEMA,
  ANTHROPIC_ORGANIZATION_TOOL_NAME,
  anthropicStrictSchemaViolations
} from "../src/anthropic-schema.js";
import {
  OPENAI_ORGANIZATION_PLAN_SCHEMA,
  OPENAI_ORGANIZATION_PLAN_SCHEMA_NAME
} from "../src/openai-schema.js";

type Schema = Readonly<Record<string, unknown>>;

function properties(schema: unknown): Schema {
  const record = schema as Schema;
  return record.properties as Schema;
}

function collectEnums(value: unknown, sink: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectEnums(entry, sink);
    return sink;
  }
  if (value === null || typeof value !== "object") return sink;
  const record = value as Schema;
  if (Array.isArray(record.enum)) sink.push(JSON.stringify(record.enum));
  if (record.const !== undefined) sink.push(`const:${JSON.stringify(record.const)}`);
  for (const child of Object.values(record)) collectEnums(child, sink);
  return sink;
}

describe("Claude strict tool schema", () => {
  it("uses only the strict-mode JSON Schema dialect Anthropic documents", () => {
    expect(anthropicStrictSchemaViolations(ANTHROPIC_ORGANIZATION_PLAN_SCHEMA)).toEqual([]);
    expect(anthropicStrictSchemaViolations(OPENAI_ORGANIZATION_PLAN_SCHEMA)).not.toEqual([]);
    expect(JSON.stringify(ANTHROPIC_ORGANIZATION_PLAN_SCHEMA)).not.toMatch(
      /"(?:pattern|minLength|maxLength|maxItems)"/u
    );
    expect(ANTHROPIC_ORGANIZATION_TOOL_NAME).toBe(OPENAI_ORGANIZATION_PLAN_SCHEMA_NAME);
  });

  it("keeps the same properties, required keys, enums, and constants as the OpenAI schema", () => {
    expect(Object.keys(properties(ANTHROPIC_ORGANIZATION_PLAN_SCHEMA))).toEqual(
      Object.keys(properties(OPENAI_ORGANIZATION_PLAN_SCHEMA))
    );
    expect(ANTHROPIC_ORGANIZATION_PLAN_SCHEMA.required).toEqual(
      OPENAI_ORGANIZATION_PLAN_SCHEMA.required
    );
    expect(collectEnums(ANTHROPIC_ORGANIZATION_PLAN_SCHEMA).sort()).toEqual(
      collectEnums(OPENAI_ORGANIZATION_PLAN_SCHEMA).sort()
    );
    expect(ANTHROPIC_ORGANIZATION_PLAN_SCHEMA.additionalProperties).toBe(false);
  });

  it("rewrites nullable type arrays into anyOf unions", () => {
    const destination = properties(ANTHROPIC_ORGANIZATION_PLAN_SCHEMA).destination as Schema;
    const candidateId = properties(destination).candidateId as Schema;
    expect(candidateId).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    const openAiCandidateId = properties(properties(OPENAI_ORGANIZATION_PLAN_SCHEMA).destination)
      .candidateId as Schema;
    expect(openAiCandidateId.type).toEqual(["string", "null"]);
  });
});
