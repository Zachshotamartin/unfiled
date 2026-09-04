import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsSections } from "./settings-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() })
}));

function render(): string {
  return renderToStaticMarkup(
    <SettingsSections
      email="owner@example.com"
      managedFallbackAvailable={false}
      onSignOut={vi.fn()}
    />
  );
}

describe("SettingsView", () => {
  it("names the account, AI access, routing rules, data controls and sync", () => {
    const html = render();

    expect(html).toContain("owner@example.com");
    expect(html).toContain("Sign out");
    expect(html).toContain("Sync");
  });

  it("teaches no private manual note mode, because the product has none", () => {
    const html = render();

    // ADR-0021: "there is no such thing as manual notes… this is not a manual note taking
    // platform." The section it replaced was copy only — it named a mode, gave it a heading, and
    // pointed at an editor control that no longer exists.
    expect(html).not.toContain("Private manual notes");
    expect(html).not.toContain("Choose “Private manual” in an editor");
    expect(html).not.toContain("outside AI-assisted organization");
  });
});
