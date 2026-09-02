"use client";

import { CheckCircleIcon, KeyIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type {
  ProviderKeyDeleteRequest,
  ProviderKeyMetadata,
  PublicByokProvider
} from "@unfiled/contracts";
import type { SyntheticEvent } from "react";

import {
  AI_PROVIDER_OPTIONS,
  aiProviderLabel,
  isProviderKeyUsable,
  providerKeyDisplayState,
  type ProviderKeyRetryAttempt
} from "@/lib/product/ai-settings";

import { AiSettingsSkeleton, SettingsNotice } from "./ai-settings-controls";
import { ResourceError } from "./resource-states";

export const PROVIDER_KEY_MIN_LENGTH = 20;
export const PROVIDER_KEY_MAX_LENGTH = 500;

export type ProviderKeyLoadFailure = Readonly<{ message: string; offline: boolean }>;

export type ProviderKeyTabsProps = Readonly<{
  locked: boolean;
  onSelect: (provider: PublicByokProvider) => void;
  providerKeys: Readonly<Record<PublicByokProvider, ProviderKeyMetadata | null>>;
  selected: PublicByokProvider;
}>;

export type ProviderKeyPanelProps = Readonly<{
  apiKey: string;
  attempt: ProviderKeyRetryAttempt | null;
  confirmingDelete: boolean;
  deleteAttempt: ProviderKeyDeleteRequest | null;
  error: string | null;
  loadFailure: ProviderKeyLoadFailure | null;
  loading: boolean;
  onApiKeyChange: (value: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onRequestDelete: () => void;
  onRetryLoad: () => void;
  onStartOver: () => void;
  onSubmit: () => void;
  pending: boolean;
  provider: PublicByokProvider;
  providerKey: ProviderKeyMetadata | null;
}>;

function timestamp(value: string | null): string {
  if (value === null) return "Not yet validated";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function keyHeadline(provider: PublicByokProvider, providerKey: ProviderKeyMetadata | null) {
  if (providerKey === null) return `No ${aiProviderLabel(provider)} key stored`;
  const masked = `•••• ${providerKey.lastFour}`;
  if (providerKey.status === "active") return `Active key ${masked}`;
  return `${providerKey.status === "invalid" ? "Invalid" : "Revoked"} key ${masked}`;
}

function submitLabel(props: ProviderKeyPanelProps): string {
  if (props.pending) return "Validating…";
  if (props.attempt !== null) return "Retry same key";
  return props.providerKey === null ? "Validate and store" : "Validate and replace";
}

export function ProviderKeyTabs({
  locked,
  onSelect,
  providerKeys,
  selected
}: ProviderKeyTabsProps) {
  return (
    <div className="provider-key-tabs" role="tablist" aria-label="Provider key">
      {AI_PROVIDER_OPTIONS.map((option) => {
        const state = providerKeyDisplayState(providerKeys[option.value]);
        return (
          <button
            key={option.value}
            id={`provider-key-tab-${option.value}`}
            type="button"
            role="tab"
            aria-selected={selected === option.value}
            aria-controls={`provider-key-panel-${option.value}`}
            data-selected={selected === option.value}
            data-key-state={state}
            disabled={locked}
            onClick={() => onSelect(option.value)}
          >
            <span>{option.label}</span>
            <small>
              {state === "active"
                ? "Active key"
                : state === "missing"
                  ? "No key stored"
                  : `${state === "invalid" ? "Invalid" : "Revoked"} key`}
            </small>
          </button>
        );
      })}
    </div>
  );
}

function ProviderKeyStatus({
  provider,
  providerKey
}: Readonly<{ provider: PublicByokProvider; providerKey: ProviderKeyMetadata | null }>) {
  const usable = isProviderKeyUsable(providerKey, provider);
  return (
    <div className="provider-key-status" data-status={providerKeyDisplayState(providerKey)}>
      <div className="provider-key-state-line">
        {usable ? (
          <CheckCircleIcon size={19} weight="fill" aria-hidden="true" />
        ) : (
          <KeyIcon size={19} aria-hidden="true" />
        )}
        <strong>{keyHeadline(provider, providerKey)}</strong>
      </div>
      {providerKey === null ? (
        <p>Add your {aiProviderLabel(provider)} API key to make this provider available.</p>
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
  );
}

function ProviderKeyForm(props: ProviderKeyPanelProps) {
  const { apiKey, attempt, error, pending, provider, providerKey } = props;
  const name = aiProviderLabel(provider);
  const fieldId = `${provider}-provider-key`;

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending || apiKey.length < PROVIDER_KEY_MIN_LENGTH) return;
    props.onSubmit();
  }

  return (
    <form className="provider-key-form" onSubmit={submit} aria-describedby={`${fieldId}-help`}>
      <div className="provider-key-field">
        <label className="field-label" htmlFor={fieldId}>
          {providerKey === null ? `${name} API key` : `Replacement ${name} API key`}
        </label>
        <input
          id={fieldId}
          name={`unfiled-${provider}-provider-key`}
          className="editor-control mt-2"
          type="password"
          value={apiKey}
          minLength={PROVIDER_KEY_MIN_LENGTH}
          maxLength={PROVIDER_KEY_MAX_LENGTH}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          disabled={pending}
          aria-describedby={`${fieldId}-help`}
          onChange={(event) => props.onApiKeyChange(event.target.value)}
        />
        <p className="ai-settings-inline-note" id={`${fieldId}-help`}>
          {attempt === null
            ? "This field is cleared after every attempt and is never saved as a draft."
            : "Paste the exact same key to retry the pending request, or start over."}
        </p>
      </div>

      {error === null ? null : <SettingsNotice tone="alert" message={error} />}

      <div className="provider-key-actions">
        <button
          type="submit"
          className="button-primary"
          disabled={pending || apiKey.length < PROVIDER_KEY_MIN_LENGTH}
        >
          <KeyIcon size={17} weight="bold" aria-hidden="true" />
          {submitLabel(props)}
        </button>
        {attempt === null ? null : (
          <button
            type="button"
            className="quiet-button"
            disabled={pending}
            onClick={props.onStartOver}
          >
            Start over
          </button>
        )}
      </div>
    </form>
  );
}

function ProviderKeyDeleteZone(props: ProviderKeyPanelProps) {
  const { confirmingDelete, deleteAttempt, pending } = props;
  if (props.providerKey === null) return null;
  return (
    <div className="provider-key-delete-zone">
      {confirmingDelete || deleteAttempt !== null ? (
        <div className="provider-key-delete-confirm" role="group" aria-label="Confirm key removal">
          <p>
            Remove this Vault key? New BYOK jobs cannot use it. A provider request that already
            began cannot be recalled.
          </p>
          <div>
            <button
              type="button"
              className="routing-rule-danger-button"
              disabled={pending}
              onClick={props.onConfirmDelete}
            >
              <TrashIcon size={17} aria-hidden="true" />
              {pending
                ? "Removing…"
                : deleteAttempt === null
                  ? "Yes, remove key"
                  : "Retry exact removal"}
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={pending}
              onClick={props.onCancelDelete}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="provider-key-remove"
          disabled={pending}
          onClick={props.onRequestDelete}
        >
          <TrashIcon size={16} aria-hidden="true" /> Remove stored key
        </button>
      )}
    </div>
  );
}

export function ProviderKeyPanel(props: ProviderKeyPanelProps) {
  const { loadFailure, loading, provider, providerKey } = props;
  const name = aiProviderLabel(provider);
  return (
    <div
      className="provider-key-panel"
      id={`provider-key-panel-${provider}`}
      role="tabpanel"
      aria-labelledby={`provider-key-tab-${provider}`}
      data-provider={provider}
    >
      {loading ? (
        <AiSettingsSkeleton label={`Loading ${name} key status`} />
      ) : loadFailure !== null ? (
        <ResourceError
          message={loadFailure.message}
          offline={loadFailure.offline}
          retry={props.onRetryLoad}
        />
      ) : (
        <>
          {providerKey?.status === "invalid" ? (
            <div className="provider-key-invalid" role="alert">
              <WarningCircleIcon size={19} aria-hidden="true" />
              <div>
                <strong>{name} rejected this key.</strong>
                <p>
                  BYOK organization is paused unless an eligible job explicitly allows managed
                  fallback. Replace or remove the key.
                </p>
              </div>
            </div>
          ) : null}
          <ProviderKeyStatus provider={provider} providerKey={providerKey} />
          <ProviderKeyForm {...props} />
          <ProviderKeyDeleteZone {...props} />
        </>
      )}
    </div>
  );
}
