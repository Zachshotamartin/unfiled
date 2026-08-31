import type { NoteContentPayload } from "@unfiled/encrypted-aggregate";

const MAX_HEADINGS = 64;
const MAX_HEADING_CHARACTERS = 200;
const MAX_SNIPPET_CHARACTERS = 200;
const SEARCHABLE_TEXT_BYTE_BUDGET = 190_000;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}[\t ]+(.+?)\s*#*\s*$/u;

export type PreparedIndexText = Readonly<{
  headings: readonly string[];
  latestSnippet: string;
  providerText: string;
  searchableText: string;
}>;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function replaceAsciiControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    output +=
      codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
  }
  return output;
}

function displayText(value: string, maximum: number): string {
  return collapseWhitespace(replaceAsciiControlCharacters(value)).slice(0, maximum).trim();
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (used + bytes > maximumBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

function headingsFromMarkdown(bodyMarkdown: string): readonly string[] {
  const headings: string[] = [];
  for (const line of bodyMarkdown.split(/\r?\n/u)) {
    const candidate = MARKDOWN_HEADING.exec(line)?.[1];
    if (candidate === undefined) continue;
    const heading = displayText(candidate, MAX_HEADING_CHARACTERS);
    if (heading.length > 0) headings.push(heading);
    if (headings.length === MAX_HEADINGS) break;
  }
  return Object.freeze(headings);
}

export function prepareIndexText(
  note: NoteContentPayload,
  providerByteBudget: number
): PreparedIndexText {
  if (
    !Number.isSafeInteger(providerByteBudget) ||
    providerByteBudget < 1 ||
    providerByteBudget > SEARCHABLE_TEXT_BYTE_BUDGET
  ) {
    throw new Error("Index text budget is invalid.");
  }
  const headings = headingsFromMarkdown(note.bodyMarkdown);
  const collapsedBody = collapseWhitespace(note.bodyMarkdown);
  const latestSnippet = displayText(collapsedBody, MAX_SNIPPET_CHARACTERS);
  const semanticText = [note.title, ...headings, note.bodyMarkdown].join("\n").trim();
  const searchableText = truncateUtf8(semanticText, SEARCHABLE_TEXT_BYTE_BUDGET).trim();
  const providerText = truncateUtf8(searchableText, providerByteBudget).trim();
  if (searchableText.length === 0 || providerText.length === 0) {
    throw new Error("Index text is empty.");
  }
  return Object.freeze({ headings, latestSnippet, providerText, searchableText });
}
