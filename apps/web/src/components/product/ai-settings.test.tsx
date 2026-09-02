import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiSettings } from "./ai-settings";

describe("AiSettings container", () => {
  it("renders both sections in their loading state before any data arrives", () => {
    const html = renderToStaticMarkup(<AiSettings />);

    expect(html).toContain('aria-labelledby="ai-settings-heading"');
    expect(html).toContain('aria-labelledby="provider-key-heading"');
    expect(html).toContain("AI &amp; filing");
    expect(html).toContain("Provider keys");
    expect(html).toContain('aria-label="Loading AI settings"');
    expect(html).toContain('aria-label="Loading OpenAI key status"');
    expect(html).not.toContain("Revision ");
    expect(html).not.toContain('<form class="ai-settings-form"');
    expect(html).not.toContain('<form class="provider-key-form"');
  });

  it("offers independent OpenAI and Claude key tabs with OpenAI selected first", () => {
    const html = renderToStaticMarkup(<AiSettings managedFallbackAvailable />);

    expect(html).toMatch(/id="provider-key-tab-openai"[^>]*aria-selected="true"/u);
    expect(html).toMatch(/id="provider-key-tab-anthropic"[^>]*aria-selected="false"/u);
    expect(html).toContain("OpenAI and Claude keys are saved independently");
    expect(html).toContain('data-provider="openai"');
    expect(html).not.toContain("sk-");
  });
});
