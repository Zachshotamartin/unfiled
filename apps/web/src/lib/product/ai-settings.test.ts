import { describe, expect, it } from "vitest";

import {
  aiSettingsDraftFor,
  aiSettingsRequestFor,
  EXPANSION_STYLE_OPTIONS,
  isProviderKeyUsable,
  isSettingsDraftLocked,
  ORGANIZATION_MODE_OPTIONS,
  providerKeyPutRequestFor,
  providerKeyRetryAttempt,
  reconcileAiSettingsRetry,
  ROUTING_EFFORT_OPTIONS
} from "./ai-settings";

const NOW = "2026-09-01T18:30:00.000Z";

describe("AI settings view model", () => {
  it("exposes all required preference profiles without exposing an unsupported provider", () => {
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
    expect(EXPANSION_STYLE_OPTIONS.map(({ value }) => value)).toEqual(["off", "brief", "detailed"]);
    expect(JSON.stringify(ROUTING_EFFORT_OPTIONS)).not.toContain("anthropic");
  });

  it("builds a complete CAS settings request and clears BYOK state in app-default mode", () => {
    const draft = aiSettingsDraftFor({
      settingsRevision: 3,
      organizationMode: "balanced",
      providerMode: "app_default",
      byokProvider: null,
      byokFallbackToApp: false,
      routingEffort: "standard",
      expansionStyle: "brief",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      updatedAt: NOW
    });

    expect(
      aiSettingsRequestFor(
        { ...draft, byokProvider: "openai", byokFallbackToApp: true },
        "settings-update-01"
      )
    ).toMatchObject({
      expectedSettingsRevision: 3,
      idempotencyKey: "settings-update-01",
      providerMode: "app_default",
      byokProvider: null,
      byokFallbackToApp: false
    });
  });

  it("retains only non-secret coordinates for an exact provider-key retry", () => {
    const attempt = providerKeyRetryAttempt(4, "provider-put-01");
    expect(attempt).toEqual({ expectedCredentialRevision: 4, idempotencyKey: "provider-put-01" });
    expect(attempt).not.toHaveProperty("apiKey");
    expect(providerKeyPutRequestFor(attempt, "sk-example-not-a-real-key-1234")).toEqual({
      idempotencyKey: "provider-put-01",
      provider: "openai",
      expectedCredentialRevision: 4,
      apiKey: "sk-example-not-a-real-key-1234"
    });
  });

  it("treats only active OpenAI metadata as usable", () => {
    const metadata = {
      provider: "openai" as const,
      lastFour: "1234",
      status: "active" as const,
      credentialRevision: 1,
      validatedAt: NOW,
      updatedAt: NOW
    };
    expect(isProviderKeyUsable(metadata)).toBe(true);
    expect(isProviderKeyUsable({ ...metadata, status: "invalid" })).toBe(false);
    expect(isProviderKeyUsable(null)).toBe(false);
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
        settingsRevision: 4,
        organizationMode: "automatic" as const,
        providerMode: "app_default" as const,
        byokProvider: null,
        byokFallbackToApp: false,
        routingEffort: "thorough" as const,
        expansionStyle: "detailed" as const,
        timezone: "America/Los_Angeles",
        locale: "en-US",
        updatedAt: NOW
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
      routingEffort: "thorough"
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
    const stale = {
      settings: {
        settingsRevision: 3,
        organizationMode: "balanced" as const,
        providerMode: "app_default" as const,
        byokProvider: null,
        byokFallbackToApp: false,
        routingEffort: "standard" as const,
        expansionStyle: "brief" as const,
        timezone: "America/Los_Angeles",
        locale: "en-US",
        updatedAt: NOW
      }
    };

    await expect(reconcileAiSettingsRetry(attempt, () => Promise.resolve(stale))).rejects.toThrow(
      "moved backward"
    );
    expect(isSettingsDraftLocked(false, attempt)).toBe(true);
  });
});
