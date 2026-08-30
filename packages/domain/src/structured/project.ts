import {
  ApiErrorCode,
  ProjectChecklistItemSchema,
  type ProjectChecklistItem
} from "@unfiled/contracts";

import { DomainError } from "../errors.js";
import type { EntityIdFactory } from "../id-factory.js";

function identity(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function parsedChecklist(markdown: string): Omit<ProjectChecklistItem, "id">[] {
  const items: Omit<ProjectChecklistItem, "id">[] = [];
  markdown.split(/\r?\n/u).forEach((line, lineIndex) => {
    const match = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/u.exec(line);
    if (!match?.[2]) return;
    items.push({
      text: match[2].trim(),
      checked: match[1]?.toLocaleLowerCase("en-US") === "x",
      ordinal: items.length,
      lineIndex
    });
  });
  return items;
}

function assertUnambiguous(items: readonly { text: string }[]): void {
  const identities = items.map(({ text }) => identity(text));
  if (new Set(identities).size !== identities.length) {
    throw new DomainError(
      ApiErrorCode.STRUCTURE_CONFLICT,
      "Duplicate project checklist text makes stable identity ambiguous"
    );
  }
}

export function reconcileProjectChecklist(
  previous: readonly ProjectChecklistItem[],
  markdown: string,
  idFactory: EntityIdFactory
): readonly ProjectChecklistItem[] {
  const prior = previous.map((item) => ProjectChecklistItemSchema.parse(item));
  const parsed = parsedChecklist(markdown);
  assertUnambiguous(prior);
  assertUnambiguous(parsed);

  const priorByText = new Map(prior.map((item) => [identity(item.text), item] as const));
  const usedIds = new Set<string>();
  return Object.freeze(
    parsed.map((item) => {
      const exact = priorByText.get(identity(item.text));
      const lineMatch = prior.find(
        (candidate) => candidate.lineIndex === item.lineIndex && !usedIds.has(candidate.id)
      );
      const match = exact && !usedIds.has(exact.id) ? exact : lineMatch;
      const result = ProjectChecklistItemSchema.parse({
        ...item,
        id: match?.id ?? idFactory("itm")
      });
      usedIds.add(result.id);
      return Object.freeze(result);
    })
  );
}

export function updateProjectChecklistLine(
  markdown: string,
  item: ProjectChecklistItem,
  next: Readonly<{ checked?: boolean; remove?: boolean; text?: string }>
): string {
  const lines = markdown.split(/\r?\n/u);
  const line = lines[item.lineIndex];
  const match =
    line === undefined ? null : /^(\s*[-*+]\s+\[)([ xX])(\])(\s+)(\S(?:.*\S)?)(\s*)$/u.exec(line);
  if (
    !match?.[1] ||
    !match[3] ||
    !match[4] ||
    !match[5] ||
    identity(match[5]) !== identity(item.text)
  ) {
    throw new DomainError(
      ApiErrorCode.STRUCTURE_CONFLICT,
      "Project checklist changed outside the stable item index"
    );
  }
  if (next.remove) lines.splice(item.lineIndex, 1);
  else {
    const marker = next.checked === undefined ? match[2] : next.checked ? "x" : " ";
    const text = next.text ?? match[5];
    const trailing = next.text === undefined ? (match[6] ?? "") : "";
    lines[item.lineIndex] = `${match[1]}${marker}${match[3]}${match[4]}${text}${trailing}`;
  }
  return lines.join("\n");
}
