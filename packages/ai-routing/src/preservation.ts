import { isCaptureAttachmentReference, type ModelOperation } from "@unfiled/contracts";

const NON_INFORMATIONAL_CONNECTORS = new Set(["and", "or"]);
const ROUTING_PREFIX =
  /^(?:(?:please\s+)?(?:add|append|put|save|record|log)\s+|(?:shopping|grocery|groceries|workout)(?:\s+list)?\s*:\s*)/iu;
const DESTINATION_TAIL =
  /\s+(?:to|in)\s+(?:my\s+|the\s+)?[\p{L}\p{N}][\p{L}\p{N} '\u2019-]{0,59}$/iu;

export type SourcePreservationMethod =
  "append_raw" | "append_paragraphs" | "ordered_extraction" | "no_source" | "none";

export type SourcePreservationResult = Readonly<{
  preserved: boolean;
  method: SourcePreservationMethod;
  captureTokenCount: number;
  operationTokenCount: number;
  matchedCaptureTokenCount: number;
  novelOperationTokenCount: number;
  coverage: number;
}>;

export class SourcePreservationError extends Error {
  public readonly code = "source_preservation_failed" as const;

  public constructor() {
    super("Organization operations do not preserve the capture source");
    this.name = "SourcePreservationError";
  }
}

function canonicalText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("und");
}

function tokens(value: string): readonly string[] {
  const matched = canonicalText(value).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  return matched.filter((token) => !NON_INFORMATIONAL_CONNECTORS.has(token));
}

function captureContentTokens(value: string): readonly string[] {
  const canonical = canonicalText(value);
  const hadRoutingPrefix = ROUTING_PREFIX.test(canonical);
  const withoutPrefix = canonical.replace(ROUTING_PREFIX, "");
  return tokens(hadRoutingPrefix ? withoutPrefix.replace(DESTINATION_TAIL, "") : withoutPrefix);
}

function scalarLeafValues(value: unknown, output: string[], depth = 0): void {
  if (depth > 16 || value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) scalarLeafValues(child, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) scalarLeafValues(child, output, depth + 1);
  }
}

function operationSourceText(operation: ModelOperation): readonly string[] {
  switch (operation.type) {
    case "append_raw":
      return [operation.content];
    case "append_paragraphs":
      // A paragraph that is only an attachment reference is placement, not words: a fixed label
      // and an opaque identifier that whoever authorized the plan appended after the model's
      // text was already checked. Counting it as source would make every capture that carries a
      // photo fail preservation and lose the photo at the moment it is filed.
      return operation.paragraphs.filter((paragraph) => !isCaptureAttachmentReference(paragraph));
    case "append_list_items":
      return operation.items;
    case "append_log_entry": {
      const values: string[] = [];
      scalarLeafValues(operation.entry, values);
      return values;
    }
    case "update_structured_data": {
      const values: string[] = [];
      scalarLeafValues(operation.patch, values);
      return values;
    }
    case "add_relation":
    case "add_tags":
      return [];
  }
}

function matchingPrefixLength(left: readonly string[], right: readonly string[]): number {
  const maximum = Math.min(left.length, right.length);
  let matched = 0;
  while (matched < maximum && left[matched] === right[matched]) matched += 1;
  return matched;
}

export function inspectSourcePreservation(
  captureText: string,
  operations: readonly ModelOperation[]
): SourcePreservationResult {
  // A capture whose only content is what the owner uploaded has no words to keep. The model
  // must then write nothing at all: there is no source to preserve, and text it invented in
  // place of the missing source is exactly what this check exists to refuse.
  if (captureText.length === 0) {
    const writtenTokenCount = operations.flatMap((operation) =>
      operationSourceText(operation).flatMap(tokens)
    ).length;
    const wroteNothing = operations.length === 0;
    return Object.freeze({
      preserved: wroteNothing,
      method: wroteNothing ? "no_source" : "none",
      captureTokenCount: 0,
      operationTokenCount: writtenTokenCount,
      matchedCaptureTokenCount: 0,
      novelOperationTokenCount: writtenTokenCount,
      coverage: wroteNothing ? 1 : 0
    });
  }
  const exactRaw = operations.some(
    (operation) => operation.type === "append_raw" && operation.content === captureText
  );
  const exactParagraphs = operations.some(
    (operation) =>
      operation.type === "append_paragraphs" && operation.paragraphs.join("\n\n") === captureText
  );
  const captureTokens = captureContentTokens(captureText);
  const fullCaptureTokens = tokens(captureText);
  const operationTokens = operations.flatMap((operation) =>
    operationSourceText(operation).flatMap(tokens)
  );
  const requiredTokens = exactRaw || exactParagraphs ? fullCaptureTokens : captureTokens;
  const matchedCaptureTokenCount = matchingPrefixLength(requiredTokens, operationTokens);
  const novelOperationTokenCount = Math.max(0, operationTokens.length - matchedCaptureTokenCount);
  const coverage =
    requiredTokens.length === 0
      ? exactRaw || exactParagraphs
        ? 1
        : 0
      : matchedCaptureTokenCount / requiredTokens.length;
  const exactSequence =
    requiredTokens.length > 0 &&
    requiredTokens.length === operationTokens.length &&
    matchedCaptureTokenCount === requiredTokens.length;
  const rawPreserved = exactRaw && exactSequence;
  const paragraphsPreserved = exactParagraphs && exactSequence;
  const structuredExtraction = operations.some(
    ({ type }) =>
      type === "append_list_items" ||
      type === "append_log_entry" ||
      type === "update_structured_data"
  );
  const orderedExtractionPreserved =
    !exactRaw && !exactParagraphs && structuredExtraction && exactSequence;

  return Object.freeze({
    preserved: rawPreserved || paragraphsPreserved || orderedExtractionPreserved,
    method: rawPreserved
      ? "append_raw"
      : paragraphsPreserved
        ? "append_paragraphs"
        : orderedExtractionPreserved
          ? "ordered_extraction"
          : "none",
    captureTokenCount: requiredTokens.length,
    operationTokenCount: operationTokens.length,
    matchedCaptureTokenCount,
    novelOperationTokenCount,
    coverage
  });
}

export function inspectPlanSourcePreservation(
  captureText: string,
  plan: Readonly<{ operations: readonly ModelOperation[] }>
): SourcePreservationResult {
  return inspectSourcePreservation(captureText, plan.operations);
}

export function assertPlanSourcePreserved(
  captureText: string,
  plan: Readonly<{ operations: readonly ModelOperation[] }>
): void {
  if (!inspectPlanSourcePreservation(captureText, plan).preserved) {
    throw new SourcePreservationError();
  }
}
