import { describe, expect, it, vi } from "vitest";

import { OrganizerProviderError, OrganizerUnavailableError } from "../src/errors.js";
import {
  createOrganizerProviderCredential,
  createOrganizerProviderCredentialAccess,
  materializeLeaseBoundProviderCredential,
  sameOrganizerProviderRouteBinding,
  type LeaseBoundOrganizerProviderRoute
} from "../src/provider-credential.js";

const APP_KEY = "sk-app-abcdefghijklmnopqrstuvwxyz0123456789";
const BYOK_KEY = "sk-byok-abcdefghijklmnopqrstuvwxyz0123456789";
const CLAUDE_KEY = "sk-ant-byok-abcdefghijklmnopqrstuvwxyz0123456789";

const openAiByok: LeaseBoundOrganizerProviderRoute = Object.freeze({
  adapterRegistryVersion: "organization-model-registry-v2",
  credential: BYOK_KEY,
  credentialRevision: 7,
  expansionStyle: "detailed",
  modelId: "gpt-5.6-sol",
  modelSelection: "auto",
  provider: "openai",
  routingEffort: "thorough",
  settingsRevision: 3,
  source: "byok"
});
const anthropicByok: LeaseBoundOrganizerProviderRoute = Object.freeze({
  ...openAiByok,
  credential: CLAUDE_KEY,
  credentialRevision: 2,
  modelId: "claude-opus-5",
  modelSelection: "claude-opus-5",
  provider: "anthropic"
});
const openAiAppDefault: LeaseBoundOrganizerProviderRoute = Object.freeze({
  adapterRegistryVersion: "organization-model-registry-v2",
  credential: null,
  credentialRevision: null,
  expansionStyle: "brief",
  modelId: "gpt-5.6-terra",
  modelSelection: "auto",
  provider: "openai",
  routingEffort: "standard",
  settingsRevision: 1,
  source: "app_default"
});

describe("lease-bound organizer provider credentials", () => {
  it("resolves BYOK per use for either provider, exposes only metadata, and closes the handle", async () => {
    for (const [route, expectedKey] of [
      [openAiByok, BYOK_KEY],
      [anthropicByok, CLAUDE_KEY]
    ] as const) {
      const resolve = vi.fn().mockResolvedValue(route);
      const access = createOrganizerProviderCredentialAccess({
        appDefaultApiKeys: { openai: APP_KEY },
        resolve
      });
      let retained: Parameters<Parameters<typeof access.use>[0]>[0] | undefined;
      await expect(
        access.use(async (credential) => {
          retained = credential;
          expect(JSON.stringify(credential)).not.toContain(expectedKey);
          expect(JSON.stringify(credential)).not.toContain(APP_KEY);
          expect(credential).toMatchObject({
            adapterRegistryVersion: "organization-model-registry-v2",
            credentialRevision: route.credentialRevision,
            expansionStyle: "detailed",
            modelId: route.modelId,
            modelSelection: route.modelSelection,
            provider: route.provider,
            routingEffort: "thorough",
            settingsRevision: 3,
            source: "byok"
          });
          return credential.withApiKey((apiKey) => Promise.resolve(apiKey === expectedKey));
        })
      ).resolves.toBe(true);
      expect(resolve).toHaveBeenCalledOnce();
      expect(access.lastSelection()).toEqual({
        credentialRevision: route.credentialRevision,
        modelId: route.modelId,
        provider: route.provider,
        source: "byok"
      });
      if (retained === undefined) throw new Error("Expected retained credential metadata handle.");
      await expect(retained.withApiKey(() => Promise.resolve(true))).rejects.toBeInstanceOf(
        OrganizerUnavailableError
      );
      retained.close();
    }
  });

  it("uses the dedicated OpenAI app key only for an exact secret-free app-default route", async () => {
    const access = createOrganizerProviderCredentialAccess({
      appDefaultApiKeys: { openai: APP_KEY },
      resolve: vi.fn().mockResolvedValue(openAiAppDefault)
    });
    await expect(
      access.use((credential) =>
        credential.withApiKey((apiKey) => Promise.resolve(apiKey === APP_KEY))
      )
    ).resolves.toBe(true);
    expect(access.lastSelection()).toEqual({
      credentialRevision: null,
      modelId: "gpt-5.6-terra",
      provider: "openai",
      source: "app_default"
    });
  });

  it("fails closed and non-retryably for app-default routes in a BYOK-only deployment", async () => {
    const access = createOrganizerProviderCredentialAccess({
      appDefaultApiKeys: {},
      resolve: vi.fn().mockResolvedValue(openAiAppDefault)
    });
    const operation = vi.fn();
    let caught: unknown;
    try {
      await access.use(operation);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrganizerProviderError);
    expect(caught).toMatchObject({ retryable: false, safeCode: "provider_unavailable" });
    expect(operation).not.toHaveBeenCalled();
    expect(access.lastSelection()).toBeNull();

    // There is no app-funded Claude credential even when an OpenAI app key exists.
    expect(() =>
      materializeLeaseBoundProviderCredential(
        { ...openAiAppDefault, modelId: "claude-sonnet-5", provider: "anthropic" },
        { openai: APP_KEY }
      )
    ).toThrow(OrganizerProviderError);
  });

  it("rejects widened route shapes, mismatched bindings, malformed keys, and close-during-use", async () => {
    for (const malformed of [
      { ...openAiAppDefault, credential: BYOK_KEY },
      { ...openAiByok, credentialRevision: null },
      { ...openAiByok, modelId: "claude-sonnet-5" },
      { ...openAiByok, modelId: "gpt-5.6-terra" },
      { ...openAiByok, modelSelection: "claude-opus-5" },
      { ...anthropicByok, modelId: "gpt-5.6-sol" },
      { ...anthropicByok, modelSelection: "claude-sonnet-5" },
      { ...openAiByok, adapterRegistryVersion: "organization-model-registry-v1" },
      { ...openAiByok, settingsRevision: 0 },
      { ...openAiByok, routingEffort: "unsafe" },
      { ...openAiByok, expansionStyle: "verbose" },
      { ...openAiByok, provider: "google" }
    ] as const) {
      expect(() =>
        materializeLeaseBoundProviderCredential(
          malformed as unknown as LeaseBoundOrganizerProviderRoute,
          { openai: APP_KEY }
        )
      ).toThrow(OrganizerUnavailableError);
    }
    expect(() =>
      createOrganizerProviderCredential({
        ...openAiByok,
        apiKey: "too-short",
        credentialRevision: 1
      })
    ).toThrow(OrganizerProviderError);

    const credential = createOrganizerProviderCredential({
      ...openAiByok,
      apiKey: BYOK_KEY,
      credentialRevision: 1
    });
    let finish!: () => void;
    const pending = credential.withApiKey(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    expect(() => credential.close()).toThrow(OrganizerUnavailableError);
    finish();
    await pending;
    credential.close();
  });

  it("compares immutable route bindings field by field", () => {
    expect(sameOrganizerProviderRouteBinding(openAiByok, { ...openAiByok })).toBe(true);
    for (const changed of [
      { ...openAiByok, settingsRevision: 4 },
      { ...openAiByok, expansionStyle: "brief" as const },
      { ...openAiByok, modelId: "gpt-5.6-terra" as const },
      { ...openAiByok, modelSelection: "gpt-5.6-sol" as const },
      { ...openAiByok, provider: "anthropic" as const },
      { ...openAiByok, routingEffort: "standard" as const }
    ]) {
      expect(sameOrganizerProviderRouteBinding(openAiByok, changed)).toBe(false);
    }
  });
});
