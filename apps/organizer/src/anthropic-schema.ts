import { OPENAI_ORGANIZATION_PLAN_SCHEMA } from "./openai-schema.js";

/**
 * Claude strict tool schemas accept a narrower JSON Schema dialect than the
 * OpenAI strict Structured Outputs schema: no `pattern`, `minLength`,
 * `maxLength`, `maxItems`, `minItems` above 1, or nullable type arrays. This
 * module derives the Claude tool schema from the single reviewed OpenAI schema
 * so both providers disclose the same properties, enums, and required keys.
 * The removed bounds are re-enforced after the response by the domain
 * `OrganizationPlanSchema`, which remains the authority for every provider.
 */
type JsonSchema = Readonly<Record<string, unknown>>;

export const ANTHROPIC_ORGANIZATION_TOOL_NAME = "unfiled_organization_plan_v1" as const;
export const ANTHROPIC_ORGANIZATION_TOOL_DESCRIPTION =
  "Files exactly one untrusted capture among the supplied candidate notes, creates a note, or defers it for review. Every value is validated again by the application." as const;

const UNSUPPORTED_STRICT_KEYWORDS: readonly string[] = Object.freeze([
  "maxItems",
  "maxLength",
  "minLength",
  "pattern"
]);

function isRecord(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableTypeArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  const types = value as readonly string[];
  return types.includes("null") ? types : null;
}

function toStrictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(toStrictSchema));
  if (!isRecord(value)) return value;
  const types = nullableTypeArray(value.type);
  if (types !== null) {
    const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "type"));
    const nonNull = types.filter((entry) => entry !== "null");
    return Object.freeze({
      anyOf: Object.freeze([
        ...nonNull.map((entry) => toStrictSchema({ ...rest, type: entry })),
        Object.freeze({ type: "null" })
      ])
    });
  }
  const entries = Object.entries(value)
    .filter(([key]) => !UNSUPPORTED_STRICT_KEYWORDS.includes(key))
    .filter(([key, entry]) => !(key === "minItems" && typeof entry === "number" && entry > 1))
    .map(([key, entry]) => [key, toStrictSchema(entry)] as const);
  return Object.freeze(Object.fromEntries(entries));
}

/** Provider-only strict subset shared with the OpenAI schema by construction. */
export const ANTHROPIC_ORGANIZATION_PLAN_SCHEMA: JsonSchema = toStrictSchema(
  OPENAI_ORGANIZATION_PLAN_SCHEMA
) as JsonSchema;

export function anthropicStrictSchemaViolations(schema: unknown, path = "$"): readonly string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      anthropicStrictSchemaViolations(entry, `${path}[${index}]`)
    );
  }
  if (!isRecord(schema)) return [];
  const violations: string[] = [];
  for (const keyword of UNSUPPORTED_STRICT_KEYWORDS) {
    if (keyword in schema) violations.push(`${path}.${keyword}`);
  }
  if (typeof schema.minItems === "number" && schema.minItems > 1)
    violations.push(`${path}.minItems`);
  if (Array.isArray(schema.type)) violations.push(`${path}.type[]`);
  if (schema.type === "object" && schema.additionalProperties !== false)
    violations.push(`${path}.additionalProperties`);
  for (const [key, entry] of Object.entries(schema)) {
    if (key === "type" || key === "required" || key === "enum") continue;
    violations.push(...anthropicStrictSchemaViolations(entry, `${path}.${key}`));
  }
  return violations;
}
