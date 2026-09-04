import type { ProviderKeyMetadata } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AiSettingsDraft } from "@/lib/product/ai-settings";

import { AiSettingsForm, type AiSettingsFormProps } from "./ai-settings-form";

const NOW = "2026-09-02T18:30:00.000Z";

const openAiKey: ProviderKeyMetadata = {
  provider: "openai",
  lastFour: "1234",
  status: "active",
  credentialRevision: 1,
  validatedAt: NOW,
  updatedAt: NOW
};

const byokDraft: AiSettingsDraft = Object.freeze({
  settingsRevision: 3,
  organizationMode: "balanced",
  providerMode: "byok",
  byokProvider: "openai",
  modelSelection: "auto",
  byokFallbackToApp: false,
  routingEffort: "standard",
  expansionStyle: "brief",
  timezone: "America/Los_Angeles",
  locale: "en-US"
});

const baseProps: AiSettingsFormProps = {
  attempt: null,
  dirty: false,
  draft: byokDraft,
  error: null,
  managedFallbackAvailable: false,
  onChange: vi.fn(),
  onDiscardRetry: vi.fn(),
  onRetry: vi.fn(),
  onSelectProvider: vi.fn(),
  onSubmit: vi.fn(),
  pending: false,
  providerKeys: { openai: openAiKey, anthropic: null },
  refreshError: null
};

function render(overrides: Partial<AiSettingsFormProps> = {}): string {
  return renderToStaticMarkup(<AiSettingsForm {...baseProps} {...overrides} />);
}

function attribute(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag)?.[1] ?? null;
}

function radios(html: string, group: string): readonly string[] {
  return [...html.matchAll(/<input\b[^>]*>/gu)]
    .map((match) => match[0])
    .filter((tag) => attribute(tag, "type") === "radio" && attribute(tag, "name") === group);
}

function radio(html: string, group: string, value: string): string {
  const tag = radios(html, group).find((candidate) => attribute(candidate, "value") === value);
  if (tag === undefined) throw new Error(`Missing radio ${group}=${value}`);
  return tag;
}

function radioValues(html: string, group: string): readonly string[] {
  return radios(html, group).map((tag) => attribute(tag, "value") ?? "");
}

function checkedValues(html: string, group: string): readonly string[] {
  return radios(html, group)
    .filter((tag) => /\bchecked=""/u.test(tag))
    .map((tag) => attribute(tag, "value") ?? "");
}

describe("AiSettingsForm hierarchy", () => {
  it("orders Provider, then Model, then Effort with labels above choices", () => {
    const html = render();

    const provider = html.indexOf('data-step="provider"');
    const model = html.indexOf('data-step="model"');
    const effort = html.indexOf('data-step="effort"');
    expect(provider).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(provider);
    expect(effort).toBeGreaterThan(model);
    expect(html).toContain("Step 1 of 3");
    expect(html).toContain("Step 2 of 3");
    expect(html).toContain("Step 3 of 3");
    expect(html.indexOf("<legend>Provider</legend>")).toBeLessThan(
      html.indexOf('name="byok-provider"')
    );
    expect(html.indexOf("<legend>Model</legend>")).toBeLessThan(
      html.indexOf('name="model-selection"')
    );
    expect(html.indexOf("<legend>Effort</legend>")).toBeLessThan(
      html.indexOf('name="routing-effort"')
    );
  });

  it("filters model options by the selected provider", () => {
    expect(radioValues(render(), "model-selection")).toEqual([
      "auto",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol"
    ]);
    expect(
      radioValues(render({ draft: { ...byokDraft, byokProvider: "anthropic" } }), "model-selection")
    ).toEqual(["auto", "claude-sonnet-5", "claude-opus-5"]);
    expect(radioValues(render(), "byok-provider")).toEqual(["openai", "anthropic"]);
  });

  it("shows Automatic resolution, exact IDs, and higher-cost tags in secondary copy", () => {
    const html = render();

    expect(html).toContain("currently resolves to");
    expect(html).toContain("<code>gpt-5.6-terra</code>");
    expect(html).toContain("Exact ID: gpt-5.6-sol.");
    expect(html.split("Higher cost").length - 1).toBe(1);
    expect(html.indexOf('value="gpt-5.6-sol"')).toBeLessThan(html.indexOf("Higher cost"));
    expect(html).toContain("Automatic uses GPT-5.6 Luna");
    expect(html).toContain("Automatic uses GPT-5.6 Sol");

    const thorough = render({ draft: { ...byokDraft, routingEffort: "thorough" } });
    expect(thorough).toContain("<code>gpt-5.6-sol</code>");
    expect(thorough).not.toContain("Higher cost");

    const claude = render({
      draft: { ...byokDraft, byokProvider: "anthropic", modelSelection: "claude-opus-5" }
    });
    expect(claude).toContain("<code>claude-sonnet-5</code>");
    expect(claude).toContain("Higher cost");
    expect(claude).toContain("Claude Opus 5 spends");
  });

  it("uses the Efficient, Balanced, and Thorough labels for the wire effort values", () => {
    const html = render();

    expect(radioValues(html, "routing-effort")).toEqual(["economical", "standard", "thorough"]);
    for (const label of ["Efficient", "Balanced", "Thorough"]) expect(html).toContain(label);
    expect(checkedValues(html, "routing-effort")).toEqual(["standard"]);
    expect(radioValues(html, "expansion-style")).toEqual(["off", "brief", "detailed"]);
    expect(radioValues(html, "organization-mode")).toEqual(["cautious", "balanced", "automatic"]);
  });

  it("hides Model when no BYOK provider is selected", () => {
    const html = render({
      draft: { ...byokDraft, providerMode: "app_default", byokProvider: null }
    });

    expect(html).not.toContain('data-step="model"');
    expect(html).not.toContain('data-step="provider"');
    expect(html).toContain('data-step="effort"');
    expect(html).not.toContain("Step 3 of 3");
    expect(checkedValues(html, "provider-mode")).toEqual(["app_default"]);
  });
});

describe("AiSettingsForm provider keys and managed fallback", () => {
  it("prompts for a missing key only for the selected provider", () => {
    expect(render()).not.toContain('data-role="missing-key-note"');
    const claude = render({ draft: { ...byokDraft, byokProvider: "anthropic" } });
    expect(claude).toContain('data-role="missing-key-note"');
    expect(claude).toContain("Add an active Claude key");
    expect(
      render({ providerKeys: { openai: { ...openAiKey, status: "invalid" }, anthropic: null } })
    ).toContain("Add an active OpenAI key");
  });

  it("states the outcome a missing key actually produces instead of promising a queue", () => {
    const html = render({ draft: { ...byokDraft, byokProvider: "anthropic" } });

    // With no usable key the beta funds no provider request: the capture is saved and readable
    // but marked failed with provider_unavailable, and the owner retries after saving a key.
    expect(html).toContain("marked failed with provider_unavailable");
    expect(html).toContain("retry it once a key is saved");
    expect(html).not.toContain("safely queued");
  });

  it("hides managed fallback unless the deployment provides app-funded access", () => {
    // A deployment that cannot fund managed access shows no AI access choice at all, as the
    // phone does (ADR-0019, decision 6).
    const withoutFallback = render();
    expect(withoutFallback).not.toContain("Allow managed fallback");
    expect(withoutFallback).not.toContain('type="checkbox"');
    expect(withoutFallback).not.toContain("Not offered on this deployment");
    expect(radioValues(withoutFallback, "provider-mode")).toEqual([]);

    const withFallback = render({ managedFallbackAvailable: true });
    expect(withFallback).toContain("Allow managed fallback");
    expect(withFallback).toContain("Off by default");
    expect(withFallback).toMatch(/<input type="checkbox"(?![^>]*checked)/u);
    expect(radio(withFallback, "provider-mode", "app_default")).not.toMatch(/\bdisabled=""/u);
    expect(
      render({ managedFallbackAvailable: true, draft: { ...byokDraft, byokFallbackToApp: true } })
    ).toMatch(/<input type="checkbox"[^>]*checked=""/u);
  });

  it("keeps an existing managed selection visible even when the deployment no longer offers it", () => {
    const html = render({
      draft: { ...byokDraft, providerMode: "app_default", byokProvider: null }
    });

    expect(radio(html, "provider-mode", "app_default")).toMatch(/\bchecked=""/u);
    expect(radio(html, "provider-mode", "app_default")).not.toMatch(/\bdisabled=""/u);
  });
});

describe("AiSettingsForm state matrix", () => {
  it("renders the clean state with a disabled save action in its own footer", () => {
    const html = render();

    expect(html).toContain("Preferences are up to date");
    expect(html).toMatch(/<button type="submit" class="button-primary" disabled=""/u);
    expect(html.indexOf('<footer class="ai-settings-actions">')).toBeGreaterThan(
      html.lastIndexOf("</fieldset>")
    );
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Retry exact save");
    expect(html).toContain('data-locked="false"');
  });

  it("enables save only for a dirty, coherent draft", () => {
    expect(render({ dirty: true })).toMatch(
      /<button type="submit" class="button-primary"(?![^>]*disabled)/u
    );
    expect(render({ dirty: true, draft: { ...byokDraft, timezone: " " } })).toMatch(
      /<button type="submit" class="button-primary" disabled=""/u
    );
    expect(
      render({ dirty: true, draft: { ...byokDraft, modelSelection: "claude-opus-5" } })
    ).toMatch(/<button type="submit" class="button-primary" disabled=""/u);
    expect(render({ dirty: true })).toContain("Unsaved preference changes");
  });

  it("locks every group while saving and shows progress on the primary action", () => {
    const html = render({ dirty: true, pending: true });

    expect(html).toContain("Saving…");
    expect(html).toContain('data-locked="true"');
    expect(html.split('<fieldset class="ai-settings-group" disabled=""').length - 1).toBe(
      html.split('<fieldset class="ai-settings-group"').length - 1
    );
  });

  it("shows a validation or invalid-key error below the fields and above the actions", () => {
    const html = render({ dirty: true, error: "These settings could not be saved." });

    const error = html.indexOf('role="alert"');
    expect(error).toBeGreaterThan(html.lastIndexOf("</fieldset>"));
    expect(error).toBeLessThan(html.indexOf('<footer class="ai-settings-actions">'));
    expect(html).toContain("These settings could not be saved.");
  });

  it("shows the stale-revision notice with the refreshed draft still editable", () => {
    const html = render({
      error: "These settings changed on another device. The latest version is shown."
    });

    expect(html).toContain("changed on another device");
    expect(html).toContain('data-locked="false"');
    expect(html).not.toContain("Retry exact save");
  });

  it("locks the draft and offers exact retry or discard while a save is ambiguous", () => {
    const attempt = {
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-ambiguous-01",
      routingEffort: "thorough" as const
    };
    const html = render({
      attempt,
      error: "The save result is unknown. Retry the exact request or discard it."
    });

    expect(html).toContain('data-locked="true"');
    expect(html).toContain("Last save result unknown");
    expect(html).toContain("Retry exact save");
    expect(html).toContain("Discard retry");
    expect(html).not.toContain('type="submit"');
    expect(html).toMatch(/<button type="button" class="button-secondary"(?![^>]*disabled)/u);
    expect(html).toMatch(/<button type="button" class="quiet-button"(?![^>]*disabled)/u);
  });

  it("disables retry and discard while the retry itself is in flight", () => {
    const html = render({
      attempt: { expectedSettingsRevision: 3, idempotencyKey: "settings-ambiguous-02" },
      pending: true
    });

    expect(html).toMatch(/<button type="button" class="button-secondary" disabled=""/u);
    expect(html).toMatch(/<button type="button" class="quiet-button" disabled=""/u);
  });

  it("surfaces a background refresh problem as a status, not an alert", () => {
    const html = render({ refreshError: "Reconnecting…" });

    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });
});
