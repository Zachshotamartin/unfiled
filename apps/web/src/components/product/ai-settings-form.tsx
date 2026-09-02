"use client";

import { ArrowClockwiseIcon, FloppyDiskIcon } from "@phosphor-icons/react";
import type {
  AiModelSelection,
  ProviderKeyMetadata,
  PublicByokProvider,
  UserSettingsUpdateRequest
} from "@unfiled/contracts";
import type { SyntheticEvent } from "react";

import {
  AI_PROVIDER_OPTIONS,
  aiModelLabel,
  aiModelOptionsFor,
  aiProviderLabel,
  autoModelFor,
  EXPANSION_STYLE_OPTIONS,
  isHigherCostThanAuto,
  isProviderKeyUsable,
  isSettingsDraftLocked,
  isSettingsDraftSubmittable,
  ORGANIZATION_MODE_OPTIONS,
  ROUTING_EFFORT_OPTIONS,
  type AiSettingsDraft
} from "@/lib/product/ai-settings";

import { SettingsChoice, SettingsNotice } from "./ai-settings-controls";

export type AiSettingsFormProps = Readonly<{
  attempt: UserSettingsUpdateRequest | null;
  dirty: boolean;
  draft: AiSettingsDraft;
  error: string | null;
  managedFallbackAvailable: boolean;
  onChange: (patch: Partial<AiSettingsDraft>) => void;
  onDiscardRetry: () => void;
  onRetry: () => void;
  onSelectProvider: (provider: PublicByokProvider) => void;
  onSubmit: () => void;
  pending: boolean;
  providerKeys: Readonly<Record<PublicByokProvider, ProviderKeyMetadata | null>>;
  refreshError: string | null;
}>;

function ProviderModeGroup({
  draft,
  locked,
  managedFallbackAvailable,
  onChange
}: Readonly<{
  draft: AiSettingsDraft;
  locked: boolean;
  managedFallbackAvailable: boolean;
  onChange: AiSettingsFormProps["onChange"];
}>) {
  const managedSelectable = managedFallbackAvailable || draft.providerMode === "app_default";
  return (
    <fieldset className="ai-settings-group" disabled={locked}>
      <legend>AI access</legend>
      <p className="ai-settings-help">
        Use your own provider account. Managed access appears only on deployments that provide an
        app-funded provider.
      </p>
      <div className="ai-choice-grid ai-choice-grid-two">
        <SettingsChoice
          group="provider-mode"
          value="byok"
          label="My API key"
          detail="Usage is billed directly to your selected provider account."
          checked={draft.providerMode === "byok"}
          disabled={locked}
          onChange={() =>
            onChange({
              providerMode: "byok",
              byokProvider: draft.byokProvider ?? "openai",
              modelSelection: "auto"
            })
          }
        />
        <SettingsChoice
          group="provider-mode"
          value="app_default"
          label="Unfiled managed"
          detail={
            managedFallbackAvailable
              ? "This deployment provides app-funded AI access."
              : "Not offered on this deployment. No app-funded inference is promised."
          }
          checked={draft.providerMode === "app_default"}
          disabled={locked || !managedSelectable}
          onChange={() =>
            onChange({
              providerMode: "app_default",
              byokProvider: null,
              modelSelection: "auto",
              byokFallbackToApp: false
            })
          }
        />
      </div>
    </fieldset>
  );
}

function ProviderGroup({
  draft,
  locked,
  managedFallbackAvailable,
  onChange,
  onSelectProvider,
  providerKeys
}: Readonly<{
  draft: AiSettingsDraft;
  locked: boolean;
  managedFallbackAvailable: boolean;
  onChange: AiSettingsFormProps["onChange"];
  onSelectProvider: AiSettingsFormProps["onSelectProvider"];
  providerKeys: AiSettingsFormProps["providerKeys"];
}>) {
  const provider = draft.byokProvider;
  const keyReady = provider !== null && isProviderKeyUsable(providerKeys[provider], provider);
  return (
    <fieldset className="ai-settings-group" disabled={locked} data-step="provider">
      <legend>Provider</legend>
      <p className="ai-settings-help">
        Step 1 of 3. Choose which saved key and model family Unfiled uses for new captures.
        Switching provider keeps both keys; an incompatible exact model resets to Automatic.
      </p>
      <div className="ai-choice-grid ai-choice-grid-two">
        {AI_PROVIDER_OPTIONS.map((option) => (
          <SettingsChoice
            key={option.value}
            group="byok-provider"
            {...option}
            checked={provider === option.value}
            disabled={locked}
            onChange={onSelectProvider}
          />
        ))}
      </div>
      {provider !== null && !keyReady ? (
        <p className="ai-settings-inline-note" data-role="missing-key-note">
          Add an active {aiProviderLabel(provider)} key in Provider keys below. Until then, new jots
          remain safely queued.
        </p>
      ) : null}
      {managedFallbackAvailable ? (
        <label className="ai-settings-checkbox">
          <input
            type="checkbox"
            checked={draft.byokFallbackToApp}
            disabled={locked}
            onChange={(event) => onChange({ byokFallbackToApp: event.target.checked })}
          />
          <span>
            <strong>Allow managed fallback</strong>
            <small>
              Off by default. A fallback can run only when the queued job snapshot permits it and
              this deployment still provides app-funded AI.
            </small>
          </span>
        </label>
      ) : null}
    </fieldset>
  );
}

function ModelGroup({
  draft,
  locked,
  onChange,
  provider
}: Readonly<{
  draft: AiSettingsDraft;
  locked: boolean;
  onChange: AiSettingsFormProps["onChange"];
  provider: PublicByokProvider;
}>) {
  const resolved = autoModelFor(provider, draft.routingEffort);
  return (
    <fieldset className="ai-settings-group" disabled={locked} data-step="model">
      <legend>Model</legend>
      <p className="ai-settings-help">
        Step 2 of 3. Automatic follows your effort setting and currently resolves to{" "}
        <code>{resolved}</code>. An exact model stays selected until you change it.
      </p>
      <div className="ai-choice-grid ai-choice-grid-four">
        {aiModelOptionsFor(provider).map((option) => (
          <SettingsChoice<AiModelSelection>
            key={option.value}
            group="model-selection"
            value={option.value}
            label={option.value === "auto" ? "Automatic" : option.label}
            detail={
              option.value === "auto"
                ? option.detail
                : `${option.detail} Exact ID: ${option.value}.`
            }
            checked={draft.modelSelection === option.value}
            disabled={locked}
            onChange={(modelSelection) => onChange({ modelSelection })}
            {...(isHigherCostThanAuto(provider, draft.routingEffort, option.value)
              ? { tag: "Higher cost" }
              : {})}
          />
        ))}
      </div>
    </fieldset>
  );
}

function effortHelp(provider: PublicByokProvider | null, modelSelection: AiModelSelection) {
  if (provider !== null && modelSelection !== "auto") {
    return `Step 3 of 3. Sets how much reasoning ${aiModelLabel(provider, modelSelection)} spends on each jot. BYOK cost usually rises with effort.`;
  }
  const step = provider === null ? "" : "Step 3 of 3. ";
  return `${step}A preference and budget profile, not a provider or model promise. BYOK cost usually rises with effort.`;
}

function EffortGroup({
  draft,
  locked,
  onChange
}: Readonly<{
  draft: AiSettingsDraft;
  locked: boolean;
  onChange: AiSettingsFormProps["onChange"];
}>) {
  const provider = draft.providerMode === "byok" ? draft.byokProvider : null;
  return (
    <fieldset className="ai-settings-group" disabled={locked} data-step="effort">
      <legend>Effort</legend>
      <p className="ai-settings-help">{effortHelp(provider, draft.modelSelection)}</p>
      <div className="ai-choice-grid">
        {ROUTING_EFFORT_OPTIONS.map((option) => (
          <SettingsChoice
            key={option.value}
            group="routing-effort"
            value={option.value}
            label={option.label}
            detail={
              provider === null || draft.modelSelection !== "auto"
                ? option.detail
                : `${option.detail} Automatic uses ${aiModelLabel(provider, autoModelFor(provider, option.value))}.`
            }
            checked={draft.routingEffort === option.value}
            disabled={locked}
            onChange={(routingEffort) => onChange({ routingEffort })}
          />
        ))}
      </div>
    </fieldset>
  );
}

function RegionalGroup({
  draft,
  locked,
  onChange
}: Readonly<{
  draft: AiSettingsDraft;
  locked: boolean;
  onChange: AiSettingsFormProps["onChange"];
}>) {
  return (
    <fieldset className="ai-settings-group" disabled={locked}>
      <legend>Regional defaults</legend>
      <p className="ai-settings-help">Used for daily-note dates and language-aware organization.</p>
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
            onChange={(event) => onChange({ timezone: event.target.value })}
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
            onChange={(event) => onChange({ locale: event.target.value })}
          />
        </div>
      </div>
    </fieldset>
  );
}

function SettingsActions({
  attempt,
  dirty,
  draft,
  onDiscardRetry,
  onRetry,
  pending
}: Readonly<{
  attempt: UserSettingsUpdateRequest | null;
  dirty: boolean;
  draft: AiSettingsDraft;
  onDiscardRetry: () => void;
  onRetry: () => void;
  pending: boolean;
}>) {
  return (
    <footer className="ai-settings-actions">
      <p aria-live="polite">
        {attempt !== null
          ? "Last save result unknown"
          : dirty
            ? "Unsaved preference changes"
            : "Preferences are up to date"}
      </p>
      {attempt === null ? (
        <button
          type="submit"
          className="button-primary"
          disabled={!dirty || pending || !isSettingsDraftSubmittable(draft)}
        >
          <FloppyDiskIcon size={17} weight="bold" aria-hidden="true" />
          {pending ? "Saving…" : "Save preferences"}
        </button>
      ) : (
        <div className="ai-settings-retry-actions">
          <button type="button" className="button-secondary" disabled={pending} onClick={onRetry}>
            <ArrowClockwiseIcon size={17} aria-hidden="true" /> Retry exact save
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={pending}
            onClick={onDiscardRetry}
          >
            Discard retry
          </button>
        </div>
      )}
    </footer>
  );
}

export function AiSettingsForm(props: AiSettingsFormProps) {
  const { attempt, dirty, draft, error, pending, refreshError } = props;
  const locked = isSettingsDraftLocked(pending, attempt);
  const byokProvider = draft.providerMode === "byok" ? draft.byokProvider : null;

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!dirty || attempt !== null) return;
    props.onSubmit();
  }

  return (
    <form className="ai-settings-form" onSubmit={submit} data-locked={locked}>
      <fieldset className="ai-settings-group" disabled={locked}>
        <legend>Organization behavior</legend>
        <p className="ai-settings-help">How readily Unfiled files clear matches for you.</p>
        <div className="ai-choice-grid">
          {ORGANIZATION_MODE_OPTIONS.map((option) => (
            <SettingsChoice
              key={option.value}
              group="organization-mode"
              {...option}
              checked={draft.organizationMode === option.value}
              disabled={locked}
              onChange={(organizationMode) => props.onChange({ organizationMode })}
            />
          ))}
        </div>
      </fieldset>

      <ProviderModeGroup
        draft={draft}
        locked={locked}
        managedFallbackAvailable={props.managedFallbackAvailable}
        onChange={props.onChange}
      />

      {draft.providerMode === "byok" ? (
        <ProviderGroup
          draft={draft}
          locked={locked}
          managedFallbackAvailable={props.managedFallbackAvailable}
          onChange={props.onChange}
          onSelectProvider={props.onSelectProvider}
          providerKeys={props.providerKeys}
        />
      ) : null}

      {byokProvider !== null ? (
        <ModelGroup
          draft={draft}
          locked={locked}
          onChange={props.onChange}
          provider={byokProvider}
        />
      ) : null}

      <EffortGroup draft={draft} locked={locked} onChange={props.onChange} />

      <fieldset className="ai-settings-group" disabled={locked}>
        <legend>Expansion</legend>
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
              disabled={locked}
              onChange={(expansionStyle) => props.onChange({ expansionStyle })}
            />
          ))}
        </div>
      </fieldset>

      <RegionalGroup draft={draft} locked={locked} onChange={props.onChange} />

      {error === null ? null : <SettingsNotice tone="alert" message={error} />}
      {refreshError === null ? null : <SettingsNotice tone="status" message={refreshError} />}

      <SettingsActions
        attempt={attempt}
        dirty={dirty}
        draft={draft}
        onDiscardRetry={props.onDiscardRetry}
        onRetry={props.onRetry}
        pending={pending}
      />
    </form>
  );
}
