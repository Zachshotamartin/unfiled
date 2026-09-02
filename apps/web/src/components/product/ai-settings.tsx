"use client";

import { KeyIcon } from "@phosphor-icons/react";
import type {
  ProviderKeyDeleteRequest,
  ProviderKeyResponse,
  PublicByokProvider,
  UserSettingsResponse,
  UserSettingsUpdateRequest
} from "@unfiled/contracts";
import { useEffect, useState } from "react";

import {
  aiProviderLabel,
  aiSettingsDraftFor,
  aiSettingsDraftForProvider,
  aiSettingsRequestFor,
  isSettingsDraftLocked,
  providerKeyPutRequestFor,
  providerKeyRetryAttempt,
  reconcileAiSettingsRetry,
  type AiSettingsDraft,
  type ProviderKeyRetryAttempt
} from "@/lib/product/ai-settings";
import {
  browserApi,
  isAmbiguousProductMutationFailure,
  isStaleRevision,
  productErrorMessage
} from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { useLiveResource } from "@/lib/product/use-live-resource";

import { AiSettingsSkeleton } from "./ai-settings-controls";
import { AiSettingsForm } from "./ai-settings-form";
import { ProviderKeyPanel, ProviderKeyTabs } from "./provider-key-panel";
import { ResourceError } from "./resource-states";

export type AiSettingsProps = Readonly<{
  /** True only when this deployment provides an app-funded provider credential. */
  managedFallbackAvailable?: boolean;
}>;

function loadAiSettings(): Promise<UserSettingsResponse> {
  return browserApi.getUserSettings();
}

function loadOpenAiProviderKey(): Promise<ProviderKeyResponse> {
  return browserApi.getProviderKeyMetadata("openai");
}

function loadAnthropicProviderKey(): Promise<ProviderKeyResponse> {
  return browserApi.getProviderKeyMetadata("anthropic");
}

export function AiSettings({ managedFallbackAvailable = false }: AiSettingsProps = {}) {
  const settingsResource = useLiveResource<UserSettingsResponse>(
    "/api/v1/me/settings",
    loadAiSettings
  );
  const openAiProviderResource = useLiveResource<ProviderKeyResponse>(
    "/api/v1/me/provider-key?provider=openai",
    loadOpenAiProviderKey
  );
  const anthropicProviderResource = useLiveResource<ProviderKeyResponse>(
    "/api/v1/me/provider-key?provider=anthropic",
    loadAnthropicProviderKey
  );
  const [draft, setDraft] = useState<AiSettingsDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsAttempt, setSettingsAttempt] = useState<UserSettingsUpdateRequest | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [credentialProvider, setCredentialProvider] = useState<PublicByokProvider>("openai");
  const [providerPending, setProviderPending] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerAttempt, setProviderAttempt] = useState<ProviderKeyRetryAttempt | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteAttempt, setDeleteAttempt] = useState<ProviderKeyDeleteRequest | null>(null);

  const authoritativeSettings = settingsResource.data?.settings ?? null;
  const providerResource =
    credentialProvider === "openai" ? openAiProviderResource : anthropicProviderResource;
  const providerKey = providerResource.data?.providerKey ?? null;
  const providerName = aiProviderLabel(credentialProvider);
  const providerKeys = {
    openai: openAiProviderResource.data?.providerKey ?? null,
    anthropic: anthropicProviderResource.data?.providerKey ?? null
  } as const;

  useEffect(() => {
    if (authoritativeSettings === null) return;
    setDraft((current) => {
      if (
        current === null ||
        (!dirty && current.settingsRevision !== authoritativeSettings.settingsRevision)
      ) {
        return aiSettingsDraftFor(authoritativeSettings);
      }
      return current;
    });
  }, [authoritativeSettings, dirty]);

  function updateDraft(patch: Partial<AiSettingsDraft>): void {
    if (isSettingsDraftLocked(settingsPending, settingsAttempt)) return;
    setDraft((current) => (current === null ? null : Object.freeze({ ...current, ...patch })));
    setDirty(true);
    setSettingsError(null);
  }

  function selectProvider(provider: PublicByokProvider): void {
    if (isSettingsDraftLocked(settingsPending, settingsAttempt)) return;
    setDraft((current) =>
      current === null ? null : aiSettingsDraftForProvider(current, provider)
    );
    setDirty(true);
    setSettingsError(null);
  }

  async function refreshSettingsAfterConflict(): Promise<void> {
    try {
      const current = await loadAiSettings();
      settingsResource.setData(current);
      setDraft(aiSettingsDraftFor(current.settings));
      setDirty(false);
    } catch {
      await settingsResource.refresh();
    }
  }

  async function saveSettings(request: UserSettingsUpdateRequest): Promise<void> {
    if (settingsPending) return;
    setSettingsPending(true);
    setSettingsError(null);
    try {
      const result = await browserApi.updateUserSettings(request);
      const current = result.replayed ? await loadAiSettings() : { settings: result.settings };
      settingsResource.setData(current);
      setDraft(aiSettingsDraftFor(current.settings));
      setDirty(false);
      setSettingsAttempt(null);
      announceProductChange("ai-settings");
    } catch (reason: unknown) {
      if (isStaleRevision(reason)) {
        setSettingsAttempt(null);
        setSettingsError("These settings changed on another device. The latest version is shown.");
        await refreshSettingsAfterConflict();
      } else if (isAmbiguousProductMutationFailure(reason)) {
        setSettingsAttempt(request);
        setSettingsError(
          "The save result is unknown. Retry the exact request or discard it before making another change."
        );
      } else {
        setSettingsAttempt(null);
        setSettingsError(productErrorMessage(reason, "These settings could not be saved."));
      }
    } finally {
      setSettingsPending(false);
    }
  }

  function submitSettings(): void {
    if (draft === null || !dirty || settingsAttempt !== null) return;
    void saveSettings(
      aiSettingsRequestFor(draft, createIdempotencyKey(), { managedFallbackAvailable })
    );
  }

  async function discardSettingsRetry(): Promise<void> {
    if (settingsPending || settingsAttempt === null) return;
    setSettingsPending(true);
    setSettingsError("Checking the settings currently saved to your account…");
    try {
      const reconciled = await reconcileAiSettingsRetry(settingsAttempt, loadAiSettings);
      settingsResource.setData(reconciled.current);
      setDraft(reconciled.draft);
      setDirty(reconciled.dirty);
      setSettingsAttempt(reconciled.ambiguousAttempt);
      setSettingsError(null);
    } catch (reason: unknown) {
      setSettingsError(
        productErrorMessage(
          reason,
          "Current settings could not be confirmed. The exact retry is still available; try discarding again when you are online."
        )
      );
    } finally {
      setSettingsPending(false);
    }
  }

  async function storeProviderKey(): Promise<void> {
    if (providerPending || apiKey.length === 0) return;
    const attempt =
      providerAttempt ??
      providerKeyRetryAttempt(
        credentialProvider,
        providerKey?.credentialRevision ?? null,
        createIdempotencyKey()
      );
    setProviderPending(true);
    setProviderError(null);
    try {
      const result = await browserApi.putProviderKey(providerKeyPutRequestFor(attempt, apiKey));
      const current = result.replayed
        ? await browserApi.getProviderKeyMetadata(attempt.provider)
        : { providerKey: result.providerKey };
      providerResource.setData(current);
      setProviderAttempt(null);
      setConfirmingDelete(false);
      announceProductChange(`provider-key:${attempt.provider}`);
    } catch (reason: unknown) {
      if (isStaleRevision(reason)) {
        setProviderAttempt(null);
        setProviderError("This key changed on another device. Its current status is shown.");
        await providerResource.refresh();
      } else if (isAmbiguousProductMutationFailure(reason)) {
        setProviderAttempt(attempt);
        setProviderError(
          "The storage result is unknown. Paste the exact same key to retry this request, or start over."
        );
      } else {
        setProviderAttempt(null);
        setProviderError(
          productErrorMessage(reason, `The ${providerName} key could not be stored.`)
        );
      }
    } finally {
      setApiKey("");
      setProviderPending(false);
    }
  }

  async function deleteProviderKey(): Promise<void> {
    if (providerPending || providerKey === null) return;
    const request =
      deleteAttempt ??
      ({
        idempotencyKey: createIdempotencyKey(),
        provider: credentialProvider,
        expectedCredentialRevision: providerKey.credentialRevision
      } satisfies ProviderKeyDeleteRequest);
    setProviderPending(true);
    setProviderError(null);
    try {
      const result = await browserApi.deleteProviderKey(request);
      if (result.replayed) await providerResource.refresh();
      else providerResource.setData({ providerKey: null });
      setDeleteAttempt(null);
      setConfirmingDelete(false);
      announceProductChange(`provider-key:${request.provider}:deleted`);
    } catch (reason: unknown) {
      if (isStaleRevision(reason)) {
        setDeleteAttempt(null);
        setConfirmingDelete(false);
        setProviderError("This key changed on another device. Its current status is shown.");
        await providerResource.refresh();
      } else if (isAmbiguousProductMutationFailure(reason)) {
        setDeleteAttempt(request);
        setProviderError("The deletion result is unknown. Retry the exact deletion request.");
      } else {
        setDeleteAttempt(null);
        setProviderError(
          productErrorMessage(reason, `The ${providerName} key could not be removed.`)
        );
      }
    } finally {
      setProviderPending(false);
    }
  }

  function switchCredentialProvider(provider: PublicByokProvider): void {
    if (providerPending || providerAttempt !== null || deleteAttempt !== null) return;
    setCredentialProvider(provider);
    setApiKey("");
    setProviderError(null);
    setConfirmingDelete(false);
  }

  const settingsUnavailable = settingsResource.error !== null && settingsResource.data === null;
  const providerLoadFailure =
    providerResource.error !== null && providerResource.data === null
      ? { message: providerResource.error, offline: providerResource.offline }
      : null;

  return (
    <>
      <section className="settings-row settings-ai-row" aria-labelledby="ai-settings-heading">
        <header className="ai-settings-header">
          <div>
            <p className="section-label">Organization behavior</p>
            <h2 id="ai-settings-heading">AI &amp; filing</h2>
            <p>
              Choose the provider, model, and effort that organize what you capture. These profiles
              never weaken routing safety or Review thresholds.
            </p>
          </div>
          {authoritativeSettings === null ? null : (
            <span className="ai-settings-revision">
              Revision {authoritativeSettings.settingsRevision}
            </span>
          )}
        </header>

        {settingsResource.loading && draft === null ? (
          <AiSettingsSkeleton label="Loading AI settings" />
        ) : settingsUnavailable ? (
          <ResourceError
            message={settingsResource.error}
            offline={settingsResource.offline}
            retry={() => void settingsResource.refresh()}
          />
        ) : draft === null ? null : (
          <AiSettingsForm
            attempt={settingsAttempt}
            dirty={dirty}
            draft={draft}
            error={settingsError}
            managedFallbackAvailable={managedFallbackAvailable}
            onChange={updateDraft}
            onDiscardRetry={() => void discardSettingsRetry()}
            onRetry={() => {
              if (settingsAttempt !== null) void saveSettings(settingsAttempt);
            }}
            onSelectProvider={selectProvider}
            onSubmit={submitSettings}
            pending={settingsPending}
            providerKeys={providerKeys}
            refreshError={
              settingsResource.error !== null && settingsResource.data !== null
                ? settingsResource.error
                : null
            }
          />
        )}
      </section>

      <section
        className="settings-row settings-provider-row"
        aria-labelledby="provider-key-heading"
      >
        <header className="ai-settings-header">
          <div>
            <p className="section-label">Vault-held credentials</p>
            <h2 id="provider-key-heading">Provider keys</h2>
            <p>
              OpenAI and Claude keys are saved independently. Each is validated in bounded server
              memory, then stored only in Supabase Vault. Unfiled never returns a key after
              submission.
            </p>
          </div>
          <KeyIcon size={25} className="text-action" aria-hidden="true" />
        </header>

        <ProviderKeyTabs
          locked={providerPending || providerAttempt !== null || deleteAttempt !== null}
          onSelect={switchCredentialProvider}
          providerKeys={providerKeys}
          selected={credentialProvider}
        />

        <ProviderKeyPanel
          apiKey={apiKey}
          attempt={providerAttempt}
          confirmingDelete={confirmingDelete}
          deleteAttempt={deleteAttempt}
          error={providerError}
          loadFailure={providerLoadFailure}
          loading={providerResource.loading && providerResource.data === null}
          onApiKeyChange={setApiKey}
          onCancelDelete={() => {
            setConfirmingDelete(false);
            setDeleteAttempt(null);
            setProviderError(null);
          }}
          onConfirmDelete={() => void deleteProviderKey()}
          onRequestDelete={() => setConfirmingDelete(true)}
          onRetryLoad={() => void providerResource.refresh()}
          onStartOver={() => {
            setProviderAttempt(null);
            setProviderError(null);
            setApiKey("");
          }}
          onSubmit={() => void storeProviderKey()}
          pending={providerPending}
          provider={credentialProvider}
          providerKey={providerKey}
        />
      </section>
    </>
  );
}
