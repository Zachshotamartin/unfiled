import { describe, expect, it, vi } from "vitest";

import { OrganizerProviderError, OrganizerUnavailableError } from "../src/errors.js";
import {
  createOrganizerProviderCredential,
  createOrganizerProviderCredentialAccess,
  materializeLeaseBoundProviderCredential
} from "../src/provider-credential.js";

const APP_KEY = "sk-app-abcdefghijklmnopqrstuvwxyz0123456789";
const BYOK_KEY = "sk-byok-abcdefghijklmnopqrstuvwxyz0123456789";

describe("lease-bound organizer provider credentials", () => {
  it("resolves BYOK per use, exposes only metadata, and closes the erasable handle", async () => {
    const resolve = vi.fn().mockResolvedValue({
      credential: BYOK_KEY,
      credentialRevision: 7,
      expansionStyle: "detailed",
      provider: "openai",
      routingEffort: "thorough",
      source: "byok"
    });
    const access = createOrganizerProviderCredentialAccess({
      appDefaultApiKey: APP_KEY,
      resolve
    });
    let retained: ReturnType<typeof materializeLeaseBoundProviderCredential> | undefined;
    await expect(
      access.use(async (credential) => {
        retained = credential;
        expect(JSON.stringify(credential)).not.toContain(BYOK_KEY);
        expect(credential).toMatchObject({
          credentialRevision: 7,
          expansionStyle: "detailed",
          provider: "openai",
          routingEffort: "thorough",
          source: "byok"
        });
        return credential.withApiKey((apiKey) => Promise.resolve(apiKey === BYOK_KEY));
      })
    ).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledOnce();
    expect(access.lastSelection()).toEqual({
      credentialRevision: 7,
      provider: "openai",
      source: "byok"
    });
    if (retained === undefined) throw new Error("Expected retained credential metadata handle.");
    await expect(retained.withApiKey(() => Promise.resolve(true))).rejects.toBeInstanceOf(
      OrganizerUnavailableError
    );
    retained.close();
  });

  it("uses the dedicated app key only for an exact secret-free app-default route", async () => {
    const access = createOrganizerProviderCredentialAccess({
      appDefaultApiKey: APP_KEY,
      resolve: vi.fn().mockResolvedValue({
        credential: null,
        credentialRevision: null,
        expansionStyle: "brief",
        provider: "openai",
        routingEffort: "standard",
        source: "app_default"
      })
    });
    await expect(
      access.use((credential) =>
        credential.withApiKey((apiKey) => Promise.resolve(apiKey === APP_KEY))
      )
    ).resolves.toBe(true);
    expect(access.lastSelection()).toEqual({
      credentialRevision: null,
      provider: "openai",
      source: "app_default"
    });
  });

  it("rejects widened route shapes, malformed keys, and close-during-use", async () => {
    expect(() =>
      materializeLeaseBoundProviderCredential(
        {
          credential: BYOK_KEY,
          credentialRevision: null,
          expansionStyle: "brief",
          provider: "openai",
          routingEffort: "standard",
          source: "app_default"
        },
        APP_KEY
      )
    ).toThrow(OrganizerUnavailableError);
    expect(() =>
      createOrganizerProviderCredential({
        apiKey: "too-short",
        credentialRevision: 1,
        expansionStyle: "brief",
        provider: "openai",
        routingEffort: "standard",
        source: "byok"
      })
    ).toThrow(OrganizerProviderError);

    const credential = createOrganizerProviderCredential({
      apiKey: BYOK_KEY,
      credentialRevision: 1,
      expansionStyle: "brief",
      provider: "openai",
      routingEffort: "standard",
      source: "byok"
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
});
