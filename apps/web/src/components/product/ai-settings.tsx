"use client";

import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  FloppyDiskIcon,
  KeyIcon,
  TrashIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type {
  ProviderKeyDeleteRequest,
  ProviderKeyResponse,
  UserSettingsResponse,
  UserSettingsUpdateRequest
} from "@unfiled/contracts";
import { type SyntheticEvent, useEffect, useState } from "react";

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
  ROUTING_EFFORT_OPTIONS,
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

import { ResourceError } from "./resource-states";

function loadAiSettings(): Promise<UserSettingsResponse> {
  return browserApi.getUserSettings();
}

function loadProviderKey(): Promise<ProviderKeyResponse> {
  return browserApi.getProviderKeyMetadata();
}

function timestamp(value: string | null): string {
  if (value === null) return "Not yet validated";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function SettingsChoice<Value extends string>({
  checked,
  detail,
  disabled,
  group,
  label,
  onChange,
  value
}: Readonly<{
  checked: boolean;
  detail: string;
  disabled: boolean;
  group: string;
  label: string;
  onChange: (value: Value) => void;
  value: Value;
}>) {
  return (
    <label className="ai-choice" data-selected={checked} data-disabled={disabled}>
      <input
        type="radio"
        name={group}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function AiSettingsSkeleton() {
  return (
    <div className="ai-settings-skeleton" aria-busy="true" aria-label="Loading AI settings">
      <div className="skeleton-block h-4 w-28" />
      <div className="skeleton-block mt-4 h-8 w-72 max-w-[80%]" />
      <div className="ai-settings-skeleton-grid">
        {[0, 1, 2].map((row) => (
          <div className="skeleton-block h-24" key={row} aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}

export function AiSettings() {
  const settingsResource = useLiveResource<UserSettingsResponse>(
    "/api/v1/me/settings",
    loadAiSettings
  );
  const providerResource = useLiveResource<ProviderKeyResponse>(
    "/api/v1/me/provider-key",
    loadProviderKey
  );
  const [draft, setDraft] = useState<AiSettingsDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsAttempt, setSettingsAttempt] = useState<UserSettingsUpdateRequest | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [providerPending, setProviderPending] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerAttempt, setProviderAttempt] = useState<ProviderKeyRetryAttempt | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteAttempt, setDeleteAttempt] = useState<ProviderKeyDeleteRequest | null>(null);

  const authoritativeSettings = settingsResource.data?.settings ?? null;
  const providerKey = providerResource.data?.providerKey ?? null;
  const keyUsable = isProviderKeyUsable(providerKey);
  const providerStateInvalid = providerKey?.status === "invalid";

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

  async function submitSettings(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (draft === null || !dirty || settingsAttempt !== null) return;
    await saveSettings(aiSettingsRequestFor(draft, createIdempotencyKey()));
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

  async function storeProviderKey(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (providerPending || apiKey.length === 0) return;
    const attempt =
      providerAttempt ??
      providerKeyRetryAttempt(providerKey?.credentialRevision ?? null, createIdempotencyKey());
    setProviderPending(true);
    setProviderError(null);
    try {
      const result = await browserApi.putProviderKey(providerKeyPutRequestFor(attempt, apiKey));
      const current = result.replayed
        ? await loadProviderKey()
        : { providerKey: result.providerKey };
      providerResource.setData(current);
      setProviderAttempt(null);
      setConfirmingDelete(false);
      announceProductChange("provider-key:openai");
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
        setProviderError(productErrorMessage(reason, "The OpenAI key could not be stored."));
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
        provider: "openai",
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
      announceProductChange("provider-key:openai:deleted");
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
        setProviderError(productErrorMessage(reason, "The OpenAI key could not be removed."));
      }
    } finally {
      setProviderPending(false);
    }
  }

  const settingsUnavailable = settingsResource.error !== null && settingsResource.data === null;
  const providerUnavailable = providerResource.error !== null && providerResource.data === null;
  const switchingToUnavailableByok =
    draft?.providerMode === "byok" && authoritativeSettings?.providerMode !== "byok" && !keyUsable;
  const settingsLocked = isSettingsDraftLocked(settingsPending, settingsAttempt);

  return (
    <>
      <section className="settings-row settings-ai-row" aria-labelledby="ai-settings-heading">
        <header className="ai-settings-header">
          <div>
            <p className="section-label">Organization behavior</p>
            <h2 id="ai-settings-heading">AI &amp; filing</h2>
            <p>
              Choose how Unfiled organizes and expands what you capture. These profiles never weaken
              routing safety or Review thresholds.
            </p>
          </div>
          {authoritativeSettings === null ? null : (
            <span className="ai-settings-revision">
              Revision {authoritativeSettings.settingsRevision}
            </span>
          )}
        </header>

        {settingsResource.loading && draft === null ? (
          <AiSettingsSkeleton />
        ) : settingsUnavailable ? (
          <ResourceError
            message={settingsResource.error}
            offline={settingsResource.offline}
            retry={() => void settingsResource.refresh()}
          />
        ) : draft === null ? null : (
          <form className="ai-settings-form" onSubmit={(event) => void submitSettings(event)}>
            <fieldset className="ai-settings-group" disabled={settingsLocked}>
              <legend>Organization mode</legend>
              <p className="ai-settings-help">How readily Unfiled files clear matches for you.</p>
              <div className="ai-choice-grid">
                {ORGANIZATION_MODE_OPTIONS.map((option) => (
                  <SettingsChoice
                    key={option.value}
                    group="organization-mode"
                    {...option}
                    checked={draft.organizationMode === option.value}
                    disabled={settingsLocked}
                    onChange={(organizationMode) => updateDraft({ organizationMode })}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="ai-settings-group" disabled={settingsLocked}>
              <legend>AI provider</legend>
              <p className="ai-settings-help">
                Use Unfiled’s managed provider, or use the OpenAI key in your private Vault.
              </p>
              <div className="ai-choice-grid ai-choice-grid-two">
                <SettingsChoice
                  group="provider-mode"
                  value="app_default"
                  label="Unfiled managed"
                  detail="Uses the app-managed provider within Unfiled’s service limits."
                  checked={draft.providerMode === "app_default"}
                  disabled={settingsLocked}
                  onChange={() =>
                    updateDraft({
                      providerMode: "app_default",
                      byokProvider: null,
                      byokFallbackToApp: false
                    })
                  }
                />
                <SettingsChoice
                  group="provider-mode"
                  value="byok"
                  label="My OpenAI key"
                  detail="Provider usage is billed directly to your OpenAI account."
                  checked={draft.providerMode === "byok"}
                  disabled={settingsLocked || (!keyUsable && draft.providerMode !== "byok")}
                  onChange={() => updateDraft({ providerMode: "byok", byokProvider: "openai" })}
                />
              </div>
              {!keyUsable && draft.providerMode !== "byok" ? (
                <p className="ai-settings-inline-note">Store an active OpenAI key below first.</p>
              ) : null}
              {draft.providerMode === "byok" ? (
                <label className="ai-settings-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.byokFallbackToApp}
                    onChange={(event) => updateDraft({ byokFallbackToApp: event.target.checked })}
                  />
                  <span>
                    <strong>Allow app-managed fallback</strong>
                    <small>
                      Off by default. When enabled, a queued jot may use Unfiled’s key only when
                      your immutable job snapshot permits it.
                    </small>
                  </span>
                </label>
              ) : null}
            </fieldset>

            <fieldset className="ai-settings-group" disabled={settingsLocked}>
              <legend>Routing effort</legend>
              <p className="ai-settings-help">
                A preference and budget profile, not a provider or model promise. BYOK cost usually
                rises with effort.
              </p>
              <div className="ai-choice-grid">
                {ROUTING_EFFORT_OPTIONS.map((option) => (
                  <SettingsChoice
                    key={option.value}
                    group="routing-effort"
                    {...option}
                    checked={draft.routingEffort === option.value}
                    disabled={settingsLocked}
                    onChange={(routingEffort) => updateDraft({ routingEffort })}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="ai-settings-group" disabled={settingsLocked}>
              <legend>Expansion style</legend>
              <p className="ai-settings-help">
                Expansions remain separate proposals until you accept or reject them.
              </p>
              <div className="ai-choice-grid">
                {EXPANSION_STYLE_OPTIONS.map((option) => (
                  <SettingsChoice
                    key={option.value}
                    group="expansion-style"
                    {...option}
                    checked={draft.expansionStyle === option.value}
                    disabled={settingsLocked}
                    onChange={(expansionStyle) => updateDraft({ expansionStyle })}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="ai-settings-group" disabled={settingsLocked}>
              <legend>Regional defaults</legend>
              <p className="ai-settings-help">
                Used for daily-note dates and language-aware organization.
              </p>
              <div className="ai-regional-grid">
                <div>
                  <label className="field-label" htmlFor="ai-settings-timezone">
                    Time zone
                  </label>
                  <input
                    id="ai-settings-timezone"
                    className="editor-control mt-2"
                    value={draft.timezone}
                    maxLength={100}
                    autoComplete="off"
                    onChange={(event) => updateDraft({ timezone: event.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="ai-settings-locale">
                    Locale
                  </label>
                  <input
                    id="ai-settings-locale"
                    className="editor-control mt-2"
                    value={draft.locale}
                    maxLength={35}
                    autoComplete="off"
                    onChange={(event) => updateDraft({ locale: event.target.value })}
                  />
                </div>
              </div>
            </fieldset>

            {settingsError === null ? null : (
              <div className="ai-settings-notice" role="alert">
                <WarningCircleIcon size={18} aria-hidden="true" />
                <span>{settingsError}</span>
              </div>
            )}
            {settingsResource.error !== null && settingsResource.data !== null ? (
              <div className="ai-settings-notice" role="status">
                <WarningCircleIcon size={18} aria-hidden="true" />
                <span>{settingsResource.error}</span>
              </div>
            ) : null}

            <footer className="ai-settings-actions">
              <p aria-live="polite">
                {dirty ? "Unsaved preference changes" : "Preferences are up to date"}
              </p>
              {settingsAttempt === null ? (
                <button
                  type="submit"
                  className="button-primary"
                  disabled={
                    !dirty ||
                    settingsPending ||
                    switchingToUnavailableByok ||
                    draft.timezone.trim().length === 0 ||
                    draft.locale.trim().length < 2
                  }
                >
                  <FloppyDiskIcon size={17} weight="bold" aria-hidden="true" />
                  {settingsPending ? "Saving…" : "Save preferences"}
                </button>
              ) : (
                <div className="ai-settings-retry-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={settingsPending}
                    onClick={() => void saveSettings(settingsAttempt)}
                  >
                    <ArrowClockwiseIcon size={17} aria-hidden="true" /> Retry exact save
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={settingsPending}
                    onClick={() => void discardSettingsRetry()}
                  >
                    Discard retry
                  </button>
                </div>
              )}
            </footer>
          </form>
        )}
      </section>

      <section
        className="settings-row settings-provider-row"
        aria-labelledby="provider-key-heading"
      >
        <header className="ai-settings-header">
          <div>
            <p className="section-label">Vault-held credential</p>
            <h2 id="provider-key-heading">OpenAI key</h2>
            <p>
              The key is validated in bounded server memory, then stored only in Supabase Vault.
              Unfiled never returns it after this form is submitted.
            </p>
          </div>
          <KeyIcon size={25} className="text-action" aria-hidden="true" />
        </header>

        {providerResource.loading && providerResource.data === null ? (
          <AiSettingsSkeleton />
        ) : providerUnavailable ? (
          <ResourceError
            message={providerResource.error}
            offline={providerResource.offline}
            retry={() => void providerResource.refresh()}
          />
        ) : (
          <>
            {providerStateInvalid ? (
              <div className="provider-key-invalid" role="alert">
                <WarningCircleIcon size={19} aria-hidden="true" />
                <div>
                  <strong>OpenAI rejected this key.</strong>
                  <p>
                    BYOK organization is paused unless an eligible job explicitly allows app-managed
                    fallback. Replace or remove the key.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="provider-key-status" data-status={providerKey?.status ?? "missing"}>
              <div className="provider-key-state-line">
                {keyUsable ? (
                  <CheckCircleIcon size={19} weight="fill" aria-hidden="true" />
                ) : (
                  <KeyIcon size={19} aria-hidden="true" />
                )}
                <strong>
                  {providerKey === null
                    ? "No key stored"
                    : providerKey.status === "active"
                      ? `Active key •••• ${providerKey.lastFour}`
                      : `${providerKey.status === "invalid" ? "Invalid" : "Revoked"} key •••• ${providerKey.lastFour}`}
                </strong>
              </div>
              {providerKey === null ? (
                <p>Add an OpenAI key to make BYOK available.</p>
              ) : (
                <dl>
                  <div>
                    <dt>Validated</dt>
                    <dd>{timestamp(providerKey.validatedAt)}</dd>
                  </div>
                  <div>
                    <dt>Credential revision</dt>
                    <dd>{providerKey.credentialRevision}</dd>
                  </div>
                </dl>
              )}
            </div>

            <form className="provider-key-form" onSubmit={(event) => void storeProviderKey(event)}>
              <div>
                <label className="field-label" htmlFor="openai-provider-key">
                  {providerKey === null ? "OpenAI API key" : "Replacement OpenAI API key"}
                </label>
                <input
                  id="openai-provider-key"
                  name="unfiled-openai-provider-key"
                  className="editor-control mt-2"
                  type="password"
                  value={apiKey}
                  minLength={20}
                  maxLength={500}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  disabled={providerPending}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <p className="ai-settings-inline-note">
                  This field is cleared after every attempt and is never saved as a draft.
                </p>
              </div>

              {providerError === null ? null : (
                <div className="ai-settings-notice" role="alert">
                  <WarningCircleIcon size={18} aria-hidden="true" />
                  <span>{providerError}</span>
                </div>
              )}

              <div className="provider-key-actions">
                <button
                  type="submit"
                  className="button-primary"
                  disabled={providerPending || apiKey.length < 20}
                >
                  <KeyIcon size={17} weight="bold" aria-hidden="true" />
                  {providerPending
                    ? "Validating…"
                    : providerAttempt === null
                      ? providerKey === null
                        ? "Validate and store"
                        : "Validate and replace"
                      : "Retry same key"}
                </button>
                {providerAttempt === null ? null : (
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={providerPending}
                    onClick={() => {
                      setProviderAttempt(null);
                      setProviderError(null);
                      setApiKey("");
                    }}
                  >
                    Start over
                  </button>
                )}
              </div>
            </form>

            {providerKey === null ? null : (
              <div className="provider-key-delete-zone">
                {confirmingDelete || deleteAttempt !== null ? (
                  <div className="provider-key-delete-confirm">
                    <p>
                      Remove this Vault key? New BYOK jobs cannot use it. A provider request that
                      already began cannot be recalled.
                    </p>
                    <div>
                      <button
                        type="button"
                        className="routing-rule-danger-button"
                        disabled={providerPending}
                        onClick={() => void deleteProviderKey()}
                      >
                        <TrashIcon size={17} aria-hidden="true" />
                        {providerPending
                          ? "Removing…"
                          : deleteAttempt === null
                            ? "Yes, remove key"
                            : "Retry exact removal"}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={providerPending}
                        onClick={() => {
                          setConfirmingDelete(false);
                          setDeleteAttempt(null);
                          setProviderError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="provider-key-remove"
                    disabled={providerPending}
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <TrashIcon size={16} aria-hidden="true" /> Remove stored key
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
