import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownPreview } from "./markdown-preview";

describe("MarkdownPreview", () => {
  it("shows a placed photo instead of the word Photo", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        markdown={[
          "Whiteboard from the kitchen",
          "",
          "![Photo](unfiled-attachment:att_01ARZ3NDEKTSV4RRFFQ69G5FAZ)",
          "[Recording](unfiled-attachment:att_01ARZ3NDEKTSV4RRFFQ69G5FAY)"
        ].join("\n")}
      />
    );

    // The server serves the decrypted bytes with their real content type under the owner's own
    // session, so the web can show the picture rather than a placeholder word.
    expect(html).toContain('src="/api/v1/captures/attachments/att_01ARZ3NDEKTSV4RRFFQ69G5FAZ"');
    expect(html).toContain('alt="Photo on this capture"');
    // A recording is not an image, so it stays a labelled row rather than a broken picture.
    expect(html).toContain('class="attachment-recording"');
    expect(html).not.toContain('src="/api/v1/captures/attachments/att_01ARZ3NDEKTSV4RRFFQ69G5FAY"');
    expect(html).not.toContain("unfiled-attachment:");
  });

  it("renders Markdown as React nodes without executable HTML or unsafe URLs", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        markdown={
          '# Safe\n<script>alert("x")</script>\n[bad](javascript:alert(1))\n[good](https://example.com)'
        }
      />
    );

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("preserves checklist semantics in a read-only preview", () => {
    const html = renderToStaticMarkup(<MarkdownPreview markdown={"- [x] packed\n- [ ] charger"} />);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain('aria-label="charger"');
  });

  it("renders the supported writing shapes with semantic lists and styled relations", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        markdown={[
          "# Training",
          "A plain paragraph with [source](https://example.com/read).",
          "- warm up",
          "- cool down",
          "1. prepare",
          "2. begin",
          "> Consistency compounds.",
          "Review #fitness and [[Weekly plan]]."
        ].join("\n")}
      />
    );

    expect(html).toContain("<h2>Training</h2>");
    expect(html).toContain("<p>A plain paragraph");
    expect(html).toContain('<ul class="markdown-list">');
    expect(html).toContain('<ol class="markdown-list">');
    expect(html).toContain("<blockquote>Consistency compounds.</blockquote>");
    expect(html).toContain('href="https://example.com/read"');
    expect(html).toContain('class="markdown-tag"');
    expect(html).toContain('class="markdown-note-link"');
    expect(html).toContain('data-private-search-query="Weekly plan"');
    expect(html).not.toContain("/app/search?");
  });
});
