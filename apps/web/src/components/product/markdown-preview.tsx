import type { ReactNode } from "react";

type ListItem = Readonly<{ checked?: boolean; text: string }>;
type Block =
  | Readonly<{ attachment: "image" | "recording"; kind: "attachment" }>
  | Readonly<{ kind: "code"; lines: readonly string[] }>
  | Readonly<{ kind: "heading"; level: number; text: string }>
  | Readonly<{ items: readonly ListItem[]; kind: "list"; ordered: boolean }>
  | Readonly<{ kind: "quote"; text: string }>
  | Readonly<{ kind: "rule" }>
  | Readonly<{ kind: "text"; text: string }>;

function blocks(markdown: string): readonly Block[] {
  const output: Block[] = [];
  let code: string[] | null = null;

  function appendList(ordered: boolean, item: ListItem): void {
    const previous = output.at(-1);
    if (previous?.kind === "list" && previous.ordered === ordered) {
      output[output.length - 1] = { ...previous, items: [...previous.items, item] };
    } else {
      output.push({ kind: "list", ordered, items: [item] });
    }
  }

  for (const line of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (code === null) code = [];
      else {
        output.push({ kind: "code", lines: code });
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      output.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const checkbox = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/u.exec(line);
    if (checkbox?.[1] !== undefined && checkbox[2] !== undefined) {
      appendList(false, {
        checked: checkbox[1].toLowerCase() === "x",
        text: checkbox[2]
      });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (bullet?.[1] !== undefined) {
      appendList(false, { text: bullet[1] });
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (numbered?.[1] !== undefined) {
      appendList(true, { text: numbered[1] });
      continue;
    }
    if (/^\s*---+\s*$/u.test(line)) {
      output.push({ kind: "rule" });
      continue;
    }
    // A photo or recording the organizer placed here. The bytes are read through the
    // owner's session on the phone; the web preview names what sits at this spot.
    const attachment =
      /^\s*(!?)\[(?:Photo|Recording)\]\(unfiled-attachment:att_[0-9A-HJKMNP-TV-Z]{26}\)\s*$/u.exec(
        line
      );
    if (attachment !== null) {
      output.push({
        kind: "attachment",
        attachment: attachment[1] === "!" ? "image" : "recording"
      });
      continue;
    }
    if (line.startsWith("> ")) {
      output.push({ kind: "quote", text: line.slice(2) });
      continue;
    }
    output.push({ kind: "text", text: line });
  }
  if (code !== null) output.push({ kind: "code", lines: code });
  return output;
}

function safeHref(value: string): string | null {
  if (value.startsWith("mailto:")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function inline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const expression =
    /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\[\[([^\]\n]+)\]\]|(^|[\s(])(#[\p{L}\p{N}_-]+)/gu;
  let cursor = 0;
  for (const match of text.matchAll(expression)) {
    const index = match.index;
    if (index > cursor) parts.push(text.slice(cursor, index));
    const href = match[2] === undefined ? null : safeHref(match[2]);
    if (match[1] !== undefined && href !== null) {
      parts.push(
        <a key={index} href={href} rel="noreferrer" target="_blank">
          {match[1]}
        </a>
      );
    } else if (match[3] !== undefined) {
      parts.push(<code key={index}>{match[3]}</code>);
    } else if (match[4] !== undefined) {
      parts.push(<strong key={index}>{match[4]}</strong>);
    } else if (match[5] !== undefined) {
      const noteTitle = match[5].trim();
      parts.push(
        <button
          key={index}
          type="button"
          className="markdown-note-link"
          data-private-search-query={noteTitle}
        >
          {noteTitle}
        </button>
      );
    } else if (match[7] !== undefined) {
      parts.push(match[6] ?? "");
      parts.push(
        <button
          key={`${index}-tag`}
          type="button"
          className="markdown-tag"
          data-private-search-query={match[7]}
        >
          {match[7]}
        </button>
      );
    } else {
      parts.push(match[0]);
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function MarkdownPreview({ markdown }: Readonly<{ markdown: string }>) {
  if (markdown.trim().length === 0) {
    return <p className="text-muted-content">Nothing to preview yet.</p>;
  }
  return (
    <div className="markdown-preview">
      {blocks(markdown).map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "code") {
          return (
            <pre key={key}>
              <code>{block.lines.join("\n")}</code>
            </pre>
          );
        }
        if (block.kind === "rule") return <hr key={key} />;
        if (block.kind === "attachment") {
          return (
            <p key={key} className="markdown-attachment">
              {block.attachment === "image" ? "Photo" : "Recording"}
            </p>
          );
        }
        if (block.kind === "quote") return <blockquote key={key}>{inline(block.text)}</blockquote>;
        if (block.kind === "heading") {
          if (block.level === 1) return <h2 key={key}>{inline(block.text)}</h2>;
          if (block.level === 2) return <h3 key={key}>{inline(block.text)}</h3>;
          return <h4 key={key}>{inline(block.text)}</h4>;
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={key} className="markdown-list">
              {block.items.map((item, itemIndex) => (
                <li
                  key={`${key}-${itemIndex}`}
                  className={item.checked === undefined ? undefined : "markdown-check-item"}
                >
                  {item.checked === undefined ? null : (
                    <input type="checkbox" checked={item.checked} readOnly aria-label={item.text} />
                  )}
                  <span>{inline(item.text)}</span>
                </li>
              ))}
            </List>
          );
        }
        return block.text.length === 0 ? (
          <div key={key} className="h-4" />
        ) : (
          <p key={key}>{inline(block.text)}</p>
        );
      })}
    </div>
  );
}
