import { describe, expect, it } from "vitest";
import { OPENAI_ORGANIZATION_PLAN_SCHEMA } from "../src/openai-schema.js";

/**
 * OpenAI Structured Outputs (strict: true) accepts only a subset of JSON Schema and answers
 * 400 to anything else. Supported per the Structured Outputs guide: the core structural
 * keywords, `enum`, `const`, `anyOf`, `$defs`/`$ref`, string `pattern`/`format`, the numeric
 * bounds, and array `minItems`/`maxItems`. String length keywords are not supported.
 */
const STRICT_MODE_KEYWORDS: ReadonlySet<string> = new Set([
  "$defs",
  "$ref",
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maximum",
  "minItems",
  "minimum",
  "multipleOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type"
]);

const SCHEMA_CONTAINERS: ReadonlySet<string> = new Set(["$defs", "properties"]);

function collectKeywords(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectKeywords(item, `${path}[${index}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!STRICT_MODE_KEYWORDS.has(key)) out.push(`${path}.${key}`);
    if (SCHEMA_CONTAINERS.has(key) && value !== null && typeof value === "object") {
      for (const [name, child] of Object.entries(value as Record<string, unknown>))
        collectKeywords(child, `${path}.${key}.${name}`, out);
      continue;
    }
    if (key === "properties" || key === "$defs") continue;
    collectKeywords(value, `${path}.${key}`, out);
  }
}

function assertStrictObjects(node: unknown, path: string, problems: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertStrictObjects(item, `${path}[${index}]`, problems));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "object") {
    const properties = Object.keys(
      (record.properties as Record<string, unknown> | undefined) ?? {}
    );
    const required = (record.required as string[] | undefined) ?? [];
    if (record.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
    if (properties.some((name) => !required.includes(name))) problems.push(`${path}: required`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (SCHEMA_CONTAINERS.has(key) && value !== null && typeof value === "object") {
      for (const [name, child] of Object.entries(value as Record<string, unknown>))
        assertStrictObjects(child, `${path}.${key}.${name}`, problems);
      continue;
    }
    assertStrictObjects(value, `${path}.${key}`, problems);
  }
}

describe("OPENAI_ORGANIZATION_PLAN_SCHEMA", () => {
  it("uses only keywords OpenAI strict mode accepts", () => {
    const unsupported: string[] = [];
    collectKeywords(OPENAI_ORGANIZATION_PLAN_SCHEMA, "$", unsupported);
    expect(unsupported).toEqual([]);
  });

  it("closes every object and requires every property", () => {
    const problems: string[] = [];
    assertStrictObjects(OPENAI_ORGANIZATION_PLAN_SCHEMA, "$", problems);
    expect(problems).toEqual([]);
  });

  it("gives every schema node a type, a union, or a reference", () => {
    const untyped: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (!("type" in record) && !("anyOf" in record) && !("$ref" in record)) untyped.push(path);
      for (const [key, value] of Object.entries(record)) {
        if (SCHEMA_CONTAINERS.has(key) && value !== null && typeof value === "object") {
          for (const [name, child] of Object.entries(value as Record<string, unknown>))
            visit(child, `${path}.${key}.${name}`);
          continue;
        }
        if (key === "items" || key === "anyOf") visit(value, `${path}.${key}`);
      }
    };
    visit(OPENAI_ORGANIZATION_PLAN_SCHEMA, "$");
    expect(untyped).toEqual([]);
  });

  it("does not nest anyOf at the root", () => {
    expect(OPENAI_ORGANIZATION_PLAN_SCHEMA.type).toBe("object");
    expect("anyOf" in OPENAI_ORGANIZATION_PLAN_SCHEMA).toBe(false);
  });
});
