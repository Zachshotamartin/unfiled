import {
  OrganizationPlanSchema,
  type CaptureKind,
  type ModelOperation,
  type OrganizationPlan
} from "@unfiled/contracts";

const CONTENT_OPERATION_TYPES = new Set<ModelOperation["type"]>([
  "append_raw",
  "append_paragraphs",
  "append_list_items",
  "append_log_entry",
  "update_structured_data"
]);

const LIST_PREFIX =
  /^\s*(?:(?:please\s+)?(?:add|append|put|save)\s+|(?:shopping|grocery|groceries)(?:\s+list)?\s*:\s*)/iu;
const LIST_DESTINATION_TAIL =
  /\s+(?:to|in)\s+(?:my\s+|the\s+)?[\p{L}\p{N}][\p{L}\p{N} '\u2019-]{0,59}$/iu;
const BULLET_PREFIX = /^\s*(?:[-*•]|\d{1,3}[.)]|\[[ xX]\])\s*/u;
const LOG_SYNTAX =
  /(?:\b\d+(?:[.,]\d+)?\s*(?:x|×)\s*\d+\b|\b\d+(?:[.,]\d+)?\s*(?:kg|kgs|lb|lbs|mi|km|mins?|minutes?|secs?|seconds?|reps?|sets?)\b)/iu;

export type DeterministicExtraction =
  | Readonly<{ kind: "list_items"; operation: ModelOperation }>
  | Readonly<{ kind: "log_entry"; operation: ModelOperation }>;

export type DeterministicExtractionOverride = Readonly<{
  applied: boolean;
  extraction: DeterministicExtraction | null;
  plan: OrganizationPlan;
}>;

function cleanedItem(value: string): string {
  return value.replace(BULLET_PREFIX, "").trim();
}

function boundedItems(values: readonly string[]): string[] | null {
  const items = values.map(cleanedItem).filter(Boolean);
  if (
    items.length === 0 ||
    items.length > 50 ||
    items.some((item) => item.length > 500 || /[\r\n]/u.test(item))
  ) {
    return null;
  }
  return items;
}

export function parseDeterministicListCapture(captureText: string): string[] | null {
  const normalized = captureText.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) return null;
  const hasPrefix = LIST_PREFIX.test(normalized);
  const withoutPrefix = normalized.replace(LIST_PREFIX, "").trim();
  const body = (
    hasPrefix ? withoutPrefix.replace(LIST_DESTINATION_TAIL, "") : withoutPrefix
  ).trim();
  if (body.length === 0) return null;

  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length >= 2 || lines.some((line) => BULLET_PREFIX.test(line))) {
    return boundedItems(lines);
  }

  const delimited = body.split(/\s*(?:[,;]|\band\b)\s*/iu);
  if (delimited.length >= 2) return boundedItems(delimited);
  return hasPrefix ? boundedItems([body]) : null;
}

export function parseDeterministicLogCapture(
  captureText: string
): Readonly<Record<string, unknown>> | null {
  const normalized = captureText.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || normalized.length > 10_000 || !LOG_SYNTAX.test(normalized)) {
    return null;
  }
  return Object.freeze({ raw: normalized });
}

export function parseDeterministicExtraction(
  captureText: string,
  inferredKind: CaptureKind
): DeterministicExtraction | null {
  if (inferredKind === "list_items") {
    const items = parseDeterministicListCapture(captureText);
    return items === null
      ? null
      : Object.freeze({
          kind: "list_items" as const,
          operation: Object.freeze({
            type: "append_list_items" as const,
            section: null,
            items
          })
        });
  }
  if (inferredKind === "log_entry") {
    const entry = parseDeterministicLogCapture(captureText);
    return entry === null
      ? null
      : Object.freeze({
          kind: "log_entry" as const,
          operation: Object.freeze({ type: "append_log_entry" as const, entry })
        });
  }
  return null;
}

function contentOperations(plan: OrganizationPlan): readonly ModelOperation[] {
  return plan.operations.filter((operation) => CONTENT_OPERATION_TYPES.has(operation.type));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withRecordedOverride(plan: OrganizationPlan, operation: ModelOperation): OrganizationPlan {
  const metadataOperations = plan.operations.filter(
    (candidate) => !CONTENT_OPERATION_TYPES.has(candidate.type)
  );
  const reasonCodes = [
    ...plan.reasonCodes.filter((reasonCode) => reasonCode !== "parser_override").slice(0, 4),
    "parser_override" as const
  ];
  return OrganizationPlanSchema.parse({
    ...plan,
    operations: [operation, ...metadataOperations].slice(0, 5),
    reasonCodes
  });
}

function extractionOperationWithModelMetadata(
  plan: OrganizationPlan,
  extraction: DeterministicExtraction
): ModelOperation {
  if (extraction.operation.type !== "append_list_items") return extraction.operation;
  const modelList = plan.operations.find(
    (operation): operation is Extract<ModelOperation, { type: "append_list_items" }> =>
      operation.type === "append_list_items"
  );
  return {
    ...extraction.operation,
    section: modelList?.section ?? null
  };
}

export function applyDeterministicExtractionOverride(
  input: Readonly<{
    captureText: string;
    inferredKind: CaptureKind;
    plan: OrganizationPlan;
  }>
): DeterministicExtractionOverride {
  const extraction = parseDeterministicExtraction(input.captureText, input.inferredKind);
  if (
    extraction === null ||
    (input.plan.decision !== "append_to_note" && input.plan.decision !== "create_note")
  ) {
    return Object.freeze({ applied: false, extraction, plan: input.plan });
  }

  const authoritativeOperation = extractionOperationWithModelMetadata(input.plan, extraction);
  const operations = contentOperations(input.plan);
  if (
    operations.length === 1 &&
    canonicalJson(operations[0]) === canonicalJson(authoritativeOperation)
  ) {
    return Object.freeze({ applied: false, extraction, plan: input.plan });
  }
  return Object.freeze({
    applied: true,
    extraction,
    plan: withRecordedOverride(input.plan, authoritativeOperation)
  });
}
