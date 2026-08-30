import {
  ApiErrorCode,
  ListStructuredDataSchema,
  type ListItem,
  type ListStructuredData
} from "@unfiled/contracts";

import { DomainError } from "../errors.js";
import type { EntityIdFactory } from "../id-factory.js";

function normalizedIdentity(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function sortedItems(items: readonly ListItem[]): ListItem[] {
  return [...items].sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id)
  );
}

function renderGroup(items: readonly ListItem[]): string[] {
  const chunks: string[] = [];
  let currentSection: string | null | undefined;
  for (const item of items) {
    if (item.section !== currentSection) {
      if (chunks.length > 0) chunks.push("");
      if (item.section !== null) chunks.push(`## ${item.section}`, "");
      currentSection = item.section;
    }
    chunks.push(`- [${item.checked ? "x" : " "}] ${item.text}`);
  }
  return chunks;
}

export function listView(data: ListStructuredData): {
  openItems: readonly ListItem[];
  completedItems: readonly ListItem[];
  remainingCount: number;
} {
  const parsed = ListStructuredDataSchema.parse(data);
  const ordered = sortedItems(parsed.items);
  const openItems = ordered.filter(({ checked }) => !checked);
  const completedItems = ordered.filter(({ checked }) => checked);
  return Object.freeze({
    openItems: Object.freeze(openItems),
    completedItems: Object.freeze(completedItems),
    remainingCount: openItems.length
  });
}

export function renderListMarkdown(data: ListStructuredData): string {
  const { openItems, completedItems } = listView(data);
  const chunks = renderGroup(openItems);
  if (completedItems.length > 0) {
    if (chunks.length > 0) chunks.push("");
    chunks.push("## Completed", "", ...renderGroup(completedItems));
  }
  return chunks.join("\n");
}

interface ParsedListItem {
  checked: boolean;
  section: string | null;
  text: string;
}

function parseListMarkdown(markdown: string): ParsedListItem[] {
  const parsed: ParsedListItem[] = [];
  let section: string | null = null;
  for (const line of markdown.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const heading = /^\s*#{2,6}\s+(.+?)\s*$/u.exec(line);
    if (heading?.[1]) {
      section = /^completed$/iu.test(heading[1].trim()) ? null : heading[1].trim();
      continue;
    }
    const item = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/u.exec(line);
    if (!item?.[2]) {
      throw new DomainError(
        ApiErrorCode.STRUCTURE_CONFLICT,
        "List Markdown contains a non-list line"
      );
    }
    parsed.push({
      checked: item[1]?.toLocaleLowerCase("en-US") === "x",
      section,
      text: item[2].trim()
    });
  }
  if (markdown.trim().length > 0 && parsed.length === 0) {
    throw new DomainError(
      ApiErrorCode.STRUCTURE_CONFLICT,
      "List Markdown must contain unambiguous bullet or checklist items"
    );
  }
  return parsed;
}

function assertUniqueText(items: readonly { text: string }[]): void {
  const seen = new Set<string>();
  for (const { text } of items) {
    const identity = normalizedIdentity(text);
    if (seen.has(identity)) {
      throw new DomainError(
        ApiErrorCode.STRUCTURE_CONFLICT,
        "Duplicate list text makes stable item identity ambiguous"
      );
    }
    seen.add(identity);
  }
}

export function reconcileListMarkdown(
  previous: ListStructuredData,
  markdown: string,
  idFactory: EntityIdFactory
): ListStructuredData {
  const prior = ListStructuredDataSchema.parse(previous);
  const parsed = parseListMarkdown(markdown);
  assertUniqueText(prior.items);
  assertUniqueText(parsed);

  const priorByText = new Map(
    prior.items.map((item) => [normalizedIdentity(item.text), item] as const)
  );
  const usedIds = new Set<string>();
  const items = parsed.map((item, ordinal) => {
    const exact = priorByText.get(normalizedIdentity(item.text));
    const ordinalMatch = prior.items.find(
      (candidate) => candidate.ordinal === ordinal && !usedIds.has(candidate.id)
    );
    const previousItem = exact && !usedIds.has(exact.id) ? exact : ordinalMatch;
    const id = previousItem?.id ?? idFactory("itm");
    usedIds.add(id);
    return { ...item, id, ordinal };
  });
  return ListStructuredDataSchema.parse({ schemaVersion: 1, items });
}
