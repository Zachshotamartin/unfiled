import type { UserSettingsDto } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  AI_PROVIDER_OPTIONS,
  aiModelLabel,
  aiModelOptionsFor,
  aiProviderLabel,
  aiSettingsDraftFor,
  aiSettingsDraftForProvider,
  aiSettingsRequestFor,
  autoModelFor,
  EXPANSION_STYLE_OPTIONS,
  isHigherCostThanAuto,
  isProviderKeyUsable,
  isSettingsDraftLocked,
  isSettingsDraftSubmittable,
  ORGANIZATION_MODE_OPTIONS,
  providerKeyDisplayState,
  providerKeyPutRequestFor,
  providerKeyRetryAttempt,
  reconcileAiSettingsRetry,
  ROUTING_EFFORT_OPTIONS
} from "./ai-settings";

const NOW = "2026-09-01T18:30:00.000Z";

const appDefaultSettings: UserSettingsDto = {
  settingsRevision: 3,
  organizationMode: "balanced",
  providerMode: "app_default",
  byokProvider: null,
  modelSelection: "auto",
  byokFallbackToApp: false,
  routingEffort: "standard",
  expansionStyle: "brief",
  timezone: "America/Los_Angeles",
  locale: "en-US",
  updatedAt: NOW
};

const byokDraft = aiSettingsDraftFor({
  ...appDefaultSettings,
  providerMode: "byok",
  byokProvider: "openai",
  modelSelection: "gpt-5.6-terra"
});

describe("AI settings view model", () => {
  it("exposes both providers and only their curated model choices", () => {
    expect(ORGANIZATION_MODE_OPTIONS.map(({ value }) => value)).toEqual([
      "cautious",
      "balanced",
      "automatic"
    ]);
    expect(ROUTING_EFFORT_OPTIONS.map(({ value }) => value)).toEqual([
      "economical",
      "standard",
      "thorough"
    ]);
    expect(ROUTING_EFFORT_OPTIONS.map(({ label }) => label)).toEqual([
      "Efficient",
      "Balanced",
      "Thorough"
    ]);
    expect(EXPANSION_STYLE_OPTIONS.map(({ value }) => value)).toEqual(["off", "brief", "detailed"]);
    expect(AI_PROVIDER_OPTIONS.map(({ value }) => value)).toEqual(["openai", "anthropic"]);
    expect(AI_PROVIDER_OPTIONS.map(({ label }) => label)).toEqual(["OpenAI", "Claude"]);
    expect(aiProviderLabel("openai")).toBe("OpenAI");
    expect(aiProviderLabel("anthropic")).toBe("Claude");
    expect(aiModelOptionsFor("openai").map(({ value }) => value)).toEqual([
      "auto",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol"
    ]);
    expect(aiModelOptionsFor("anthropic").map(({ value }) => value)).toEqual([
      "auto",
      "claude-sonnet-5",
      "claude-opus-5"
    ]);
    expect(() => aiModelOptionsFor("google" as never)).toThrow(TypeError);
  });

  it("resolves Automatic and labels exactly as ADR-0015 decides", () => {
    expect(autoModelFor("openai", "economical")).toBe("gpt-5.6-luna");
    expect(autoModelFor("openai", "standard")).toBe("gpt-5.6-terra");
    expect(autoModelFor("openai", "thorough")).toBe("gpt-5.6-sol");
    expect(autoModelFor("anthropic", "economical")).toBe("claude-sonnet-5");
    expect(autoModelFor("anthropic", "standard")).toBe("claude-sonnet-5");
    expect(autoModelFor("anthropic", "thorough")).toBe("claude-opus-5");
    expect(aiModelLabel("openai", "gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(aiModelLabel("anthropic", "claude-opus-5")).toBe("Claude Opus 5");
    expect(aiModelLabel("anthropic", "gpt-5.6-terra")).toBe("gpt-5.6-terra");
  });

  it("flags only exact models that cost more than Automatic at the chosen effort", () => {
    expect(isHigherCostThanAuto("openai", "standard", "auto")).toBe(false);
    expect(isHigherCostThanAuto("openai", "standard", "gpt-5.6-luna")).toBe(false);
    expect(isHigherCostThanAuto("openai", "standard", "gpt-5.6-terra")).toBe(false);
    expect(isHigherCostThanAuto("openai", "standard", "gpt-5.6-sol")).toBe(true);
    expect(isHigherCostThanAuto("openai", "economical", "gpt-5.6-terra")).toBe(true);
    expect(isHigherCostThanAuto("openai", "thorough", "gpt-5.6-sol")).toBe(false);
    expect(isHigherCostThanAuto("anthropic", "standard", "claude-opus-5")).toBe(true);
    expect(isHigherCostThanAuto("anthropic", "thorough", "claude-opus-5")).toBe(false);
    expect(isHigherCostThanAuto("anthropic", "economical", "claude-sonnet-5")).toBe(false);
  });

  it("switches provider while keeping compatible models and resetting incompatible ones", () => {
    const toClaude = aiSettingsDraftForProvider(byokDraft, "anthropic");
    expect(toClaude).toMatchObject({
      providerMode: "byok",
      byokProvider: "anthropic",
      modelSelection: "auto"
    });
    expect(byokDraft.modelSelection).toBe("gpt-5.6-terra");
    expect(Object.isFrozen(toClaude)).toBe(true);

    const opus = aiSettingsDraftForProvider(
      { ...toClaude, modelSelection: "claude-opus-5" },
      "anthropic"
    );
    expect(opus.modelSelection).toBe("claude-opus-5");
    expect(aiSettingsDraftForProvider(opus, "openai").modelSelection).toBe("auto");
    expect(
      aiSettingsDraftForProvider({ ...byokDraft, modelSelection: "auto" }, "anthropic")
        .modelSelection
    ).toBe("auto");
    expect(
      aiSettingsDraftForProvider(
        { ...byokDraft, providerMode: "app_default", byokProvider: null, modelSelection: "auto" },
        "openai"
      )
    ).toMatchObject({ providerMode: "byok", byokProvider: "openai", modelSelection: "auto" });
  });

  it("builds a complete CAS settings request and clears BYOK state in app-default mode", () => {
    const draft = aiSettingsDraftFor(appDefaultSettings);

    expect(
      aiSettingsRequestFor(
        {
          ...draft,
          byokProvider: "openai",
          modelSelection: "gpt-5.6-sol",
          byokFallbackToApp: true
        },
        "settings-update-01"
      )
    ).toEqual({
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-update-01",
      organizationMode: "balanced",
      providerMode: "app_default",
      byokProvider: null,
      modelSelection: "auto",
      byokFallbackToApp: false,
      routingEffort: "standard",
      expansionStyle: "brief",
      timezone: "America/Los_Angeles",
      locale: "en-US"
    });
  });

  it("sends the exact provider and model for BYOK drafts", () => {
    expect(aiSettingsRequestFor(byokDraft, "settings-update-02")).toMatchObject({
      providerMode: "byok",
      byokProvider: "openai",
      modelSelection: "gpt-5.6-terra",
      byokFallbackToApp: false
    });
    expect(
      aiSettingsRequestFor(
        aiSettingsDraftForProvider({ ...byokDraft, modelSelection: "auto" }, "anthropic"),
        "settings-update-03"
      )
    ).toMatchObject({ byokProvider: "anthropic", modelSelection: "auto" });
  });

  it("never promises managed fallback unless the deployment offers it", () => {
    const wantsFallback = { ...byokDraft, byokFallbackToApp: true };

    expect(aiSettingsRequestFor(wantsFallback, "settings-fallback-01")).toMatchObject({
      byokFallbackToApp: false
    });
    expect(
      aiSettingsRequestFor(wantsFallback, "settings-fallback-02", {
        managedFallbackAvailable: false
      })
    ).toMatchObject({ byokFallbackToApp: false });
    expect(
      aiSettingsRequestFor(wantsFallback, "settings-fallback-03", {
        managedFallbackAvailable: true
      })
    ).toMatchObject({ byokFallbackToApp: true });
    expect(
      aiSettingsRequestFor(byokDraft, "settings-fallback-04", { managedFallbackAvailable: true })
    ).toMatchObject({ byokFallbackToApp: false });
  });

  it("only submits drafts whose provider, model, and regional fields are coherent", () => {
    expect(isSettingsDraftSubmittable(byokDraft)).toBe(true);
    expect(isSettingsDraftSubmittable(aiSettingsDraftFor(appDefaultSettings))).toBe(true);
    expect(isSettingsDraftSubmittable({ ...byokDraft, byokProvider: null })).toBe(false);
    expect(isSettingsDraftSubmittable({ ...byokDraft, modelSelection: "claude-sonnet-5" })).toBe(
      false
    );
    expect(
      isSettingsDraftSubmittable({
        ...byokDraft,
        providerMode: "app_default",
        byokProvider: null,
        modelSelection: "gpt-5.6-terra"
      })
    ).toBe(false);
    expect(isSettingsDraftSubmittable({ ...byokDraft, timezone: "  " })).toBe(false);
    expect(isSettingsDraftSubmittable({ ...byokDraft, locale: "e" })).toBe(false);
  });

  it("retains only non-secret coordinates for an exact provider-key retry", () => {
    const attempt = providerKeyRetryAttempt("anthropic", 4, "provider-put-01");
    expect(attempt).toEqual({
      provider: "anthropic",
      expectedCredentialRevision: 4,
      idempotencyKey: "provider-put-01"
    });
    expect(attempt).not.toHaveProperty("apiKey");
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(providerKeyPutRequestFor(attempt, "sk-ant-test-example-not-a-real-key-wxyz")).toEqual({
      idempotencyKey: "provider-put-01",
      provider: "anthropic",
      expectedCredentialRevision: 4,
      apiKey: "sk-ant-test-example-not-a-real-key-wxyz"
    });
  });

  it("treats active metadata as usable only for its provider", () => {
    const metadata = {
      provider: "openai" as const,
      lastFour: "1234",
      status: "active" as const,
      credentialRevision: 1,
      validatedAt: NOW,
      updatedAt: NOW
    };
    expect(isProviderKeyUsable(metadata)).toBe(true);
    expect(isProviderKeyUsable(metadata, "openai")).toBe(true);
    expect(isProviderKeyUsable(metadata, "anthropic")).toBe(false);
    expect(isProviderKeyUsable({ ...metadata, provider: "anthropic" }, "anthropic")).toBe(true);
    expect(isProviderKeyUsable({ ...metadata, status: "invalid" })).toBe(false);
    expect(isProviderKeyUsable({ ...metadata, status: "revoked" }, "openai")).toBe(false);
    expect(isProviderKeyUsable(null)).toBe(false);
    expect(providerKeyDisplayState(null)).toBe("missing");
    expect(providerKeyDisplayState(metadata)).toBe("active");
    expect(providerKeyDisplayState({ ...metadata, status: "invalid" })).toBe("invalid");
    expect(providerKeyDisplayState({ ...metadata, status: "revoked" })).toBe("revoked");
  });

  it("locks the settings draft while a save is pending or its result is ambiguous", () => {
    const attempt = {
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-ambiguous-01",
      routingEffort: "thorough" as const
    };

    expect(isSettingsDraftLocked(false, null)).toBe(false);
    expect(isSettingsDraftLocked(true, null)).toBe(true);
    expect(isSettingsDraftLocked(false, attempt)).toBe(true);
  });

  it("reconciles an ambiguous committed save before discarding the retry and unlocking", async () => {
    const committed = {
      settings: {
        ...appDefaultSettings,
        settingsRevision: 4,
        organizationMode: "automatic" as const,
        routingEffort: "thorough" as const,
        expansionStyle: "detailed" as const
      }
    };

    const attempt = {
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-ambiguous-02",
      routingEffort: "thorough" as const
    };
    const reconciled = await reconcileAiSettingsRetry(attempt, () => Promise.resolve(committed));

    expect(reconciled.current).toBe(committed);
    expect(reconciled.draft).toMatchObject({
      settingsRevision: 4,
      organizationMode: "automatic",
      routingEffort: "thorough",
      modelSelection: "auto"
    });
    expect(reconciled.dirty).toBe(false);
    expect(reconciled.ambiguousAttempt).toBeNull();
    expect(isSettingsDraftLocked(false, reconciled.ambiguousAttempt)).toBe(false);
  });

  it("cannot produce an unlocked retry state when authoritative reconciliation fails", async () => {
    const attempt = {
      expectedSettingsRevision: 4,
      idempotencyKey: "settings-ambiguous-03",
      routingEffort: "thorough" as const
    };

    await expect(
      reconcileAiSettingsRetry(attempt, () => Promise.reject(new TypeError("offline")))
    ).rejects.toThrow("offline");
    expect(isSettingsDraftLocked(false, attempt)).toBe(true);
  });

  it("rejects an authoritative revision rollback and leaves the retry locked", async () => {
    const attempt = {
      expectedSettingsRevision: 4,
      idempotencyKey: "settings-ambiguous-04",
      routingEffort: "thorough" as const
    };

    await expect(
      reconcileAiSettingsRetry(attempt, () => Promise.resolve({ settings: appDefaultSettings }))
    ).rejects.toThrow("moved backward");
    expect(isSettingsDraftLocked(false, attempt)).toBe(true);
  });
});
