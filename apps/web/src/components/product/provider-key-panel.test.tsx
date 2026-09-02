import type { ProviderKeyMetadata } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_KEY_MAX_LENGTH,
  PROVIDER_KEY_MIN_LENGTH,
  ProviderKeyPanel,
  ProviderKeyTabs,
  type ProviderKeyPanelProps
} from "./provider-key-panel";

const NOW = "2026-09-02T18:30:00.000Z";
const OPENAI_KEY = "sk-test-example-not-a-real-key-1234";

const openAiKey: ProviderKeyMetadata = {
  provider: "openai",
  lastFour: "1234",
  status: "active",
  credentialRevision: 1,
  validatedAt: NOW,
  updatedAt: NOW
};

const anthropicKey: ProviderKeyMetadata = {
  provider: "anthropic",
  lastFour: "wxyz",
  status: "active",
  credentialRevision: 2,
  validatedAt: NOW,
  updatedAt: NOW
};

const baseProps: ProviderKeyPanelProps = {
  apiKey: "",
  attempt: null,
  confirmingDelete: false,
  deleteAttempt: null,
  error: null,
  loadFailure: null,
  loading: false,
  onApiKeyChange: vi.fn(),
  onCancelDelete: vi.fn(),
  onConfirmDelete: vi.fn(),
  onRequestDelete: vi.fn(),
  onRetryLoad: vi.fn(),
  onStartOver: vi.fn(),
  onSubmit: vi.fn(),
  pending: false,
  provider: "openai",
  providerKey: null
};

function render(overrides: Partial<ProviderKeyPanelProps> = {}): string {
  return renderToStaticMarkup(<ProviderKeyPanel {...baseProps} {...overrides} />);
}

describe("ProviderKeyTabs", () => {
  it("offers one tab per provider with independent key status", () => {
    const html = renderToStaticMarkup(
      <ProviderKeyTabs
        locked={false}
        onSelect={vi.fn()}
        providerKeys={{ openai: openAiKey, anthropic: null }}
        selected="anthropic"
      />
    );

    expect(html).toContain('role="tablist"');
    expect(html).toMatch(
      /id="provider-key-tab-openai"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="provider-key-panel-openai"[^>]*data-key-state="active"/u
    );
    expect(html).toMatch(
      /id="provider-key-tab-anthropic"[^>]*aria-selected="true"[^>]*data-key-state="missing"/u
    );
    expect(html).toContain("OpenAI");
    expect(html).toContain("Claude");
    expect(html).toContain("Active key");
    expect(html).toContain("No key stored");
    expect(html).not.toContain("disabled");
  });

  it("names invalid and revoked keys and locks tabs during ambiguous work", () => {
    const html = renderToStaticMarkup(
      <ProviderKeyTabs
        locked
        onSelect={vi.fn()}
        providerKeys={{
          openai: { ...openAiKey, status: "invalid", validatedAt: null },
          anthropic: { ...anthropicKey, status: "revoked", validatedAt: null }
        }}
        selected="openai"
      />
    );

    expect(html).toContain("Invalid key");
    expect(html).toContain("Revoked key");
    expect(html.split('disabled=""').length - 1).toBe(2);
  });
});

describe("ProviderKeyPanel states", () => {
  it("renders the loading state without a form", () => {
    const html = render({ loading: true });

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading OpenAI key status");
    expect(html).not.toContain("<form");
    expect(html).toMatch(/role="tabpanel"[^>]*aria-labelledby="provider-key-tab-openai"/u);
  });

  it("renders a retryable load failure and an offline variant", () => {
    const failed = render({ loadFailure: { message: "Could not load.", offline: false } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Could not load.");
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("<form");

    const offline = render({ loadFailure: { message: "Reconnect.", offline: true } });
    expect(offline).toContain("offline");
  });

  it("renders the empty state with a store action separated from the field", () => {
    const html = render();

    expect(html).toContain('data-status="missing"');
    expect(html).toContain("No OpenAI key stored");
    expect(html).toContain('for="openai-provider-key"');
    expect(html).toContain(">OpenAI API key<");
    expect(html).toContain("Validate and store");
    expect(html).not.toContain("Remove stored key");
    expect(html).not.toContain("Replacement");
    expect(html).toMatch(/<button type="submit" class="button-primary" disabled=""/u);

    const label = html.indexOf('for="openai-provider-key"');
    const input = html.indexOf('id="openai-provider-key"');
    const help = html.indexOf('id="openai-provider-key-help"');
    const actions = html.indexOf('class="provider-key-actions"');
    expect(input).toBeGreaterThan(label);
    expect(help).toBeGreaterThan(input);
    expect(actions).toBeGreaterThan(help);
    expect(html).not.toMatch(/<input[^>]*\/?>\s*<button/u);
    const field = /<input\b[^>]*id="openai-provider-key"[^>]*>/u.exec(html)?.[0] ?? "";
    expect(field).toMatch(new RegExp(`minlength="${PROVIDER_KEY_MIN_LENGTH}"`, "iu"));
    expect(field).toMatch(new RegExp(`maxlength="${PROVIDER_KEY_MAX_LENGTH}"`, "iu"));
    expect(field).toMatch(/type="password"/u);
    expect(field).toMatch(/autocomplete="off"/iu);
    expect(field).toMatch(/spellcheck="false"/iu);
    expect(html).toContain('data-1p-ignore="true"');
  });

  it("enables the store action once a plausible key is pasted and never echoes it", () => {
    const html = render({ apiKey: OPENAI_KEY });

    expect(html).toMatch(/<button type="submit" class="button-primary"(?![^>]*disabled)/u);
    expect(html).toContain(`value="${OPENAI_KEY}"`);
    expect(html.split(OPENAI_KEY).length - 1).toBe(1);
    expect(render({ apiKey: "sk-short" })).toMatch(
      /<button type="submit" class="button-primary" disabled=""/u
    );
  });

  it("renders the success state with metadata only and a separate destructive zone", () => {
    const html = render({ providerKey: openAiKey });

    expect(html).toContain('data-status="active"');
    expect(html).toContain("Active key •••• 1234");
    expect(html).toContain("Credential revision");
    expect(html).toContain(">1<");
    expect(html).toContain("Replacement OpenAI API key");
    expect(html).toContain("Validate and replace");
    expect(html).toContain("Remove stored key");
    expect(html).toContain('class="provider-key-delete-zone"');
    expect(html.indexOf('class="provider-key-delete-zone"')).toBeGreaterThan(
      html.indexOf("</form>")
    );
    expect(html).not.toContain("Yes, remove key");
    expect(html).not.toContain("apiKey");
    expect(html).not.toContain("secret");
  });

  it("renders the Claude panel with its own field identity", () => {
    const html = render({ provider: "anthropic", providerKey: anthropicKey });

    expect(html).toContain('data-provider="anthropic"');
    expect(html).toContain('id="anthropic-provider-key"');
    expect(html).toContain('name="unfiled-anthropic-provider-key"');
    expect(html).toContain("Replacement Claude API key");
    expect(html).toContain("Active key •••• wxyz");
    expect(html).not.toContain("OpenAI");
  });

  it("renders the invalid-key state with an alert and both recovery paths", () => {
    const html = render({
      providerKey: { ...openAiKey, status: "invalid", validatedAt: null }
    });

    expect(html).toContain('data-status="invalid"');
    expect(html).toContain('class="provider-key-invalid" role="alert"');
    expect(html).toContain("OpenAI rejected this key.");
    expect(html).toContain("Invalid key •••• 1234");
    expect(html).toContain("Not yet validated");
    expect(html).toContain("Validate and replace");
    expect(html).toContain("Remove stored key");
  });

  it("renders the revoked state without the invalid alert", () => {
    const html = render({
      providerKey: { ...openAiKey, status: "revoked", validatedAt: null }
    });

    expect(html).toContain('data-status="revoked"');
    expect(html).toContain("Revoked key •••• 1234");
    expect(html).not.toContain("rejected this key");
  });

  it("shows a stale-revision or validation error below the field and above the actions", () => {
    const html = render({
      providerKey: openAiKey,
      error: "This key changed on another device. Its current status is shown."
    });

    const field = html.indexOf('id="openai-provider-key"');
    const alert = html.indexOf('role="alert"');
    const actions = html.indexOf('class="provider-key-actions"');
    expect(alert).toBeGreaterThan(field);
    expect(alert).toBeLessThan(actions);
    expect(html).toContain("changed on another device");
  });

  it("renders the ambiguous retry state asking for the same key with a start-over escape", () => {
    const html = render({
      attempt: { provider: "openai", expectedCredentialRevision: 1, idempotencyKey: "web_1" },
      apiKey: OPENAI_KEY,
      error: "The storage result is unknown. Paste the exact same key to retry this request."
    });

    expect(html).toContain("Retry same key");
    expect(html).toContain("Start over");
    expect(html).toContain("Paste the exact same key to retry the pending request");
    expect(html).not.toContain("web_1");
  });

  it("renders the validating state with every action disabled", () => {
    const html = render({ apiKey: OPENAI_KEY, pending: true, providerKey: openAiKey });

    expect(html).toContain("Validating…");
    expect(html).toMatch(/<input[^>]*id="openai-provider-key"[^>]*disabled=""/u);
    expect(html).toMatch(/<button type="submit" class="button-primary" disabled=""/u);
    expect(html).toMatch(/<button type="button" class="provider-key-remove" disabled=""/u);
  });

  it("renders deletion confirmation with distinct destructive and secondary actions", () => {
    const html = render({ providerKey: openAiKey, confirmingDelete: true });

    expect(html).toContain('aria-label="Confirm key removal"');
    expect(html).toContain("Yes, remove key");
    expect(html).toContain("Cancel");
    expect(html).toContain('class="routing-rule-danger-button"');
    expect(html).toContain('class="button-secondary"');
    expect(html).not.toContain("Remove stored key");
    expect(html.indexOf('class="routing-rule-danger-button"')).toBeLessThan(
      html.indexOf('class="button-secondary"')
    );
  });

  it("renders the ambiguous deletion retry and the removing state", () => {
    const retry = render({
      providerKey: openAiKey,
      deleteAttempt: { idempotencyKey: "web_2", provider: "openai", expectedCredentialRevision: 1 }
    });
    expect(retry).toContain("Retry exact removal");
    expect(retry).not.toContain("web_2");

    const removing = render({ providerKey: openAiKey, confirmingDelete: true, pending: true });
    expect(removing).toContain("Removing…");
    expect(removing).toMatch(
      /<button type="button" class="routing-rule-danger-button" disabled=""/u
    );
  });

  it("never offers deletion when no key is stored", () => {
    expect(render({ confirmingDelete: true })).not.toContain("Yes, remove key");
  });
});
