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
  /\s+(?:to|in)\s+(?:my\s+|the\s+)?[\p{L}\p{N}][\p{L}\p{N} '’-]{0,59}$/iu;
const BULLET_PREFIX = /^\s*(?:[-*•]|\d{1,3}[.)]|\[[ xX]\])\s*/u;
const LOG_SYNTAX =
  /(?:\b\d+(?:[.,]\d+)?\s*(?:x|×)\s*\d+\b|\b\d+(?:[.,]\d+)?\s*(?:kg|kgs|lb|lbs|mi|km|mins?|minutes?|secs?|seconds?|reps?|sets?)\b)/iu;

// A label is the owner's own name for a list, written before its items. Before a colon it may be
// any short phrase ("weekend plans: hike, brunch"). Before a comma or a line break it has to name
// a kind of list ("todo list, x, y"; "groceries" above "milk"), or the first item of a plain list
// would be mistaken for its name. A colon counts only when whitespace or the end follows it, so a
// URL or a time is never split.
const LABEL_DELIMITER = /:(?=\s|$)|,|\n/u;
const LABEL_WORD_LIMIT = 5;
const LABEL_CHARACTER_LIMIT = 60;
const LABEL_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} '’&-]*$/u;
// Words that label a capture without naming anything: "note: milk, eggs" is a list the model
// should name, not a list called "Note".
const GENERIC_LABEL_WORDS = new Set([
  "capture",
  "fyi",
  "idea",
  "list",
  "lists",
  "misc",
  "note",
  "notes",
  "ps",
  "quick",
  "random",
  "re",
  "reminder",
  "thought",
  "thoughts"
]);
const LIST_KIND_WORDS = new Set([
  "agenda",
  "backlog",
  "checklist",
  "chores",
  "errands",
  "groceries",
  "grocery",
  "ideas",
  "packing",
  "reading",
  "reminders",
  "shopping",
  "task",
  "tasks",
  "to do",
  "to dos",
  "to-do",
  "to-dos",
  "todo",
  "todos",
  "watchlist",
  "wishlist"
]);

export type ListLabel = Readonly<{ title: string; remainder: string }>;

export type DeterministicExtraction =
  | Readonly<{ kind: "list_items"; operation: ModelOperation; title: string | null }>
  | Readonly<{ kind: "log_entry"; operation: ModelOperation }>;

export type DeterministicExtractionOverride = Readonly<{
  applied: boolean;
  extraction: DeterministicExtraction | null;
  plan: OrganizationPlan;
}>;

// Several items after the name, so "project update: shipped the sync tests" -- one sentence
// behind a colon -- is never read as a one-item list called "Project update".
function holdsSeveralItems(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length >= 2 || lines.some((line) => BULLET_PREFIX.test(line))) return true;
  return text.split(/\s*(?:[,;]|\band\b)\s*/iu).filter((item) => item.length > 0).length >= 2;
}

function namesAKindOfList(head: string): boolean {
  const lowered = head.toLocaleLowerCase("und");
  return LIST_KIND_WORDS.has(lowered) || /\blists?$/u.test(lowered);
}

function sentenceCased(value: string): string {
  const [first = "", ...rest] = Array.from(value);
  return `${first.toLocaleUpperCase("und")}${rest.join("")}`;
}

/**
 * The name the owner gave a list inside the capture, and the text that remains once it is taken
 * as the title: "todo list, x, y, z" is a list called "Todo list" holding x, y and z, not a list
 * whose first item is "todo list". Null when the capture opens with no such name.
 */
export function parseListLabel(captureText: string): ListLabel | null {
  const normalized = captureText.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  const delimiter = LABEL_DELIMITER.exec(normalized);
  if (delimiter === null || delimiter.index === 0) return null;
  const head = normalized.slice(0, delimiter.index).trim();
  const remainder = normalized.slice(delimiter.index + delimiter[0].length).trim();
  if (
    head.length === 0 ||
    remainder.length === 0 ||
    head.length > LABEL_CHARACTER_LIMIT ||
    head.split(/\s+/u).length > LABEL_WORD_LIMIT ||
    !LABEL_SHAPE.test(head)
  ) {
    return null;
  }
  if (GENERIC_LABEL_WORDS.has(head.toLocaleLowerCase("und"))) return null;
  if (!namesAKindOfList(head) && (delimiter[0] !== ":" || !holdsSeveralItems(remainder))) {
    return null;
  }
  return Object.freeze({ title: sentenceCased(head), remainder });
}

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
  const label = parseListLabel(normalized);
  const hasPrefix = label === null && LIST_PREFIX.test(normalized);
  const withoutPrefix =
    label === null ? normalized.replace(LIST_PREFIX, "").trim() : label.remainder;
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
  return hasPrefix || label !== null ? boundedItems([body]) : null;
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
          }),
          title: parseListLabel(captureText)?.title ?? null
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

function withRecordedOverride(
  plan: OrganizationPlan,
  operation: ModelOperation,
  title: string | null
): OrganizationPlan {
  const metadataOperations = plan.operations.filter(
    (candidate) => !CONTENT_OPERATION_TYPES.has(candidate.type)
  );
  const reasonCodes = [
    ...plan.reasonCodes.filter((reasonCode) => reasonCode !== "parser_override").slice(0, 4),
    "parser_override" as const
  ];
  const destination =
    title === null || plan.destination.newNote === null
      ? plan.destination
      : { ...plan.destination, newNote: { ...plan.destination.newNote, title } };
  return OrganizationPlanSchema.parse({
    ...plan,
    destination,
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

/**
 * The title a new list note takes when the owner named the list in the capture. The model's
 * title is kept in every other case: for an append there is no new note, and without a label
 * nothing deterministic knows the note better than the model does.
 */
function labelledTitle(plan: OrganizationPlan, extraction: DeterministicExtraction): string | null {
  if (extraction.kind !== "list_items" || extraction.title === null) return null;
  if (plan.decision !== "create_note" || plan.destination.newNote === null) return null;
  return extraction.title;
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
  const operationsMatch =
    operations.length === 1 &&
    canonicalJson(operations[0]) === canonicalJson(authoritativeOperation);
  const title = labelledTitle(input.plan, extraction);
  const titleMatches = title === null || input.plan.destination.newNote?.title === title;
  if (operationsMatch && titleMatches) {
    return Object.freeze({ applied: false, extraction, plan: input.plan });
  }
  return Object.freeze({
    applied: true,
    extraction,
    plan: withRecordedOverride(input.plan, authoritativeOperation, title)
  });
}
