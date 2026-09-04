/**
 * The name the owner gave a list inside a capture, and the text that remains once it is taken as
 * the title: "todo list, x, y, z" is a list called "Todo list". The same rule as the organizer's
 * `parseListLabel` in @unfiled/ai-routing and the phone's `CaptureTitle.listLabel`, carried here
 * on its own because the routing package's index pulls its evaluation corpus into a browser
 * bundle, which no page should pay for.
 */
const LABEL_DELIMITER = /:(?=\s|$)|,|\n/u;
const LABEL_WORD_LIMIT = 5;
const LABEL_CHARACTER_LIMIT = 60;
const LABEL_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} '’&-]*$/u;
const BULLET_PREFIX = /^\s*(?:[-*•]|\d{1,3}[.)]|\[[ xX]\])\s*/u;
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

function namesAKindOfList(head: string): boolean {
  const lowered = head.toLocaleLowerCase("und");
  return LIST_KIND_WORDS.has(lowered) || /\blists?$/u.test(lowered);
}

function holdsSeveralItems(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length >= 2 || lines.some((line) => BULLET_PREFIX.test(line))) return true;
  return text.split(/\s*(?:[,;]|\band\b)\s*/iu).filter((item) => item.length > 0).length >= 2;
}

function sentenceCased(value: string): string {
  const [first = "", ...rest] = Array.from(value);
  return `${first.toLocaleUpperCase("und")}${rest.join("")}`;
}

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
