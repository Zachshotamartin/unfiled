const EPHEMERAL_CANDIDATE_ID_PATTERN = "^candidate_[0-9a-f]{32}$";

type JsonSchema = Readonly<Record<string, unknown>>;

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = Object.keys(properties)
): JsonSchema {
  return {
    additionalProperties: false,
    properties,
    required,
    type: "object"
  };
}

/**
 * Strict mode accepts only `pattern` and `format` on strings, so lengths are not expressed
 * here; OrganizationPlanSchema enforces every bound after the response returns.
 */
const nullableString: JsonSchema = Object.freeze({ type: ["string", "null"] });

const oneLine = Object.freeze({
  pattern: "^[^\\r\\n]+$",
  type: "string"
});

const appendRaw = objectSchema({
  content: { type: "string" },
  type: { const: "append_raw" }
});
const appendParagraphs = objectSchema({
  paragraphs: { items: oneLine, maxItems: 20, minItems: 1, type: "array" },
  type: { const: "append_paragraphs" }
});
const appendListItems = objectSchema({
  items: { items: oneLine, maxItems: 50, minItems: 1, type: "array" },
  section: nullableString,
  type: { const: "append_list_items" }
});
const addRelation = objectSchema({
  linkType: { enum: ["reference", "related"], type: "string" },
  toCandidateId: { pattern: EPHEMERAL_CANDIDATE_ID_PATTERN, type: "string" },
  type: { const: "add_relation" }
});

/**
 * Provider-only strict subset of OrganizationPlanSchema.
 *
 * The domain schema remains the authority after the response returns. Dynamic
 * record operations are intentionally absent because their arbitrary keys
 * cannot be represented by OpenAI strict Structured Outputs without weakening
 * `additionalProperties: false`.
 */
export const OPENAI_ORGANIZATION_PLAN_SCHEMA: JsonSchema = Object.freeze({
  $defs: {
    operation: {
      anyOf: [appendRaw, appendParagraphs, appendListItems, addRelation]
    }
  },
  ...objectSchema({
    alternatives: {
      items: { pattern: EPHEMERAL_CANDIDATE_ID_PATTERN, type: "string" },
      maxItems: 2,
      type: "array"
    },
    captureKind: {
      enum: ["list_items", "log_entry", "principle", "project_update", "freeform"],
      type: "string"
    },
    decision: {
      enum: ["append_to_note", "create_note", "add_to_inbox", "needs_review"],
      type: "string"
    },
    destination: objectSchema({
      candidateId: { pattern: EPHEMERAL_CANDIDATE_ID_PATTERN, type: ["string", "null"] },
      newNote: {
        anyOf: [
          objectSchema({
            noteType: {
              enum: ["generic", "list", "log", "principle", "project"],
              type: "string"
            },
            spaceCandidateId: { type: "null" },
            title: { type: "string" }
          }),
          { type: "null" }
        ]
      }
    }),
    generatedExpansion: {
      anyOf: [
        objectSchema({
          kind: {
            enum: ["summary", "interpretation", "suggestion", "label"],
            type: "string"
          },
          text: { type: "string" }
        }),
        { type: "null" }
      ]
    },
    operations: {
      items: { $ref: "#/$defs/operation" },
      maxItems: 5,
      type: "array"
    },
    reasonCodes: {
      items: {
        enum: [
          "explicit_shopping_intent",
          "explicit_destination",
          "open_daily_list",
          "same_day_log",
          "alias_match",
          "semantic_match",
          "recent_destination",
          "type_match",
          "no_candidate_fit",
          "ambiguous_intent",
          "duplicate_suspected",
          "low_information",
          "parser_override"
        ],
        type: "string"
      },
      maxItems: 5,
      type: "array"
    },
    schemaVersion: { const: 1 }
  })
});

export const OPENAI_ORGANIZATION_PLAN_SCHEMA_NAME = "unfiled_organization_plan_v1" as const;
