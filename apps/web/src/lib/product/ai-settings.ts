import type {
  AiModelSelection,
  ExpansionStyle,
  OrganizationMode,
  ProviderKeyMetadata,
  ProviderKeyPutRequest,
  PublicByokProvider,
  RoutingEffort,
  UserSettingsDto,
  UserSettingsResponse,
  UserSettingsUpdateRequest
} from "@unfiled/contracts";
import { AI_MODEL_CATALOG, isAiModelSelectionForProvider } from "@unfiled/contracts";

export type AiSettingsDraft = Readonly<{
  settingsRevision: number;
  organizationMode: OrganizationMode;
  providerMode: "app_default" | "byok";
  byokProvider: PublicByokProvider | null;
  modelSelection: AiModelSelection;
  byokFallbackToApp: boolean;
  routingEffort: RoutingEffort;
  expansionStyle: ExpansionStyle;
  timezone: string;
  locale: string;
}>;

export type ProviderKeyRetryAttempt = Readonly<{
  provider: PublicByokProvider;
  expectedCredentialRevision: number | null;
  idempotencyKey: string;
}>;

export type AiSettingsRetryReconciliation = Readonly<{
  ambiguousAttempt: null;
  current: UserSettingsResponse;
  dirty: false;
  draft: AiSettingsDraft;
}>;

export type AiSettingsRequestOptions = Readonly<{
  /** True only when this deployment provides an app-funded provider credential. */
  managedFallbackAvailable: boolean;
}>;

export type ProviderKeyDisplayState = "active" | "invalid" | "missing" | "revoked";

export const ORGANIZATION_MODE_OPTIONS = Object.freeze([
  {
    value: "cautious",
    label: "Cautious",
    detail: "Ask before more uncertain filing and organization changes."
  },
  {
    value: "balanced",
    label: "Balanced",
    detail: "File clear matches automatically and bring ambiguous jots to Review."
  },
  {
    value: "automatic",
    label: "Automatic",
    detail: "Apply more high-confidence organization without interrupting your capture flow."
  }
] as const satisfies readonly Readonly<{
  value: OrganizationMode;
  label: string;
  detail: string;
}>[]);

export const ROUTING_EFFORT_OPTIONS = Object.freeze([
  {
    value: "economical",
    label: "Efficient",
    detail: "Lowest BYOK cost. Best for short, familiar jots."
  },
  {
    value: "standard",
    label: "Balanced",
    detail: "A practical balance of reasoning time, latency, and BYOK cost."
  },
  {
    value: "thorough",
    label: "Thorough",
    detail: "More reasoning for difficult jots, with higher latency and BYOK cost."
  }
] as const satisfies readonly Readonly<{
  value: RoutingEffort;
  label: string;
  detail: string;
}>[]);

export const AI_PROVIDER_OPTIONS = Object.freeze([
  {
    value: "openai",
    label: "OpenAI",
    detail: "Use your own OpenAI API key and choose a GPT-5.6 model."
  },
  {
    value: "anthropic",
    label: "Claude",
    detail: "Use your own Anthropic API key and choose a Claude 5 model."
  }
] as const satisfies readonly Readonly<{
  value: PublicByokProvider;
  label: string;
  detail: string;
}>[]);

export const EXPANSION_STYLE_OPTIONS = Object.freeze([
  { value: "off", label: "Off", detail: "Keep organized notes to what you wrote." },
  {
    value: "brief",
    label: "Brief",
    detail: "Offer a small, separate expansion when it is useful."
  },
  {
    value: "detailed",
    label: "Detailed",
    detail: "Offer a fuller separate expansion for review."
  }
] as const satisfies readonly Readonly<{
  value: ExpansionStyle;
  label: string;
  detail: string;
}>[]);

export function aiProviderLabel(provider: PublicByokProvider): string {
  return provider === "openai" ? "OpenAI" : "Claude";
}

function catalogEntry(provider: PublicByokProvider) {
  const entry = AI_MODEL_CATALOG.providers.find((candidate) => candidate.provider === provider);
  if (entry === undefined) throw new TypeError("Unsupported AI provider");
  return entry;
}

export function aiModelOptionsFor(provider: PublicByokProvider) {
  return catalogEntry(provider).models;
}

/** The exact model Automatic resolves to for a provider at the given effort. */
export function autoModelFor(
  provider: PublicByokProvider,
  effort: RoutingEffort
): AiModelSelection {
  return catalogEntry(provider).autoByEffort[effort];
}

export function aiModelLabel(provider: PublicByokProvider, model: AiModelSelection): string {
  const option = catalogEntry(provider).models.find((candidate) => candidate.value === model);
  return option?.label ?? model;
}

/**
 * Whether an exact model costs more than the model Automatic would choose at this effort.
 * Catalog order within a provider runs from the most economical to the most capable model.
 */
export function isHigherCostThanAuto(
  provider: PublicByokProvider,
  effort: RoutingEffort,
  model: AiModelSelection
): boolean {
  if (model === "auto") return false;
  const order = catalogEntry(provider).models.map((candidate) => candidate.value);
  return order.indexOf(model) > order.indexOf(autoModelFor(provider, effort));
}

export function providerKeyDisplayState(
  providerKey: ProviderKeyMetadata | null
): ProviderKeyDisplayState {
  return providerKey === null ? "missing" : providerKey.status;
}

export function aiSettingsDraftFor(settings: UserSettingsDto): AiSettingsDraft {
  return Object.freeze({
    settingsRevision: settings.settingsRevision,
    organizationMode: settings.organizationMode,
    providerMode: settings.providerMode,
    byokProvider: settings.byokProvider,
    modelSelection: settings.modelSelection,
    byokFallbackToApp: settings.byokFallbackToApp,
    routingEffort: settings.routingEffort,
    expansionStyle: settings.expansionStyle,
    timezone: settings.timezone,
    locale: settings.locale
  });
}

/**
 * Switches the BYOK provider in a draft. An exact model that the new provider cannot run resets
 * to Automatic; a compatible choice (including Automatic) is preserved. Keys are never touched.
 */
export function aiSettingsDraftForProvider(
  draft: AiSettingsDraft,
  provider: PublicByokProvider
): AiSettingsDraft {
  return Object.freeze({
    ...draft,
    providerMode: "byok",
    byokProvider: provider,
    modelSelection: isAiModelSelectionForProvider(provider, draft.modelSelection)
      ? draft.modelSelection
      : "auto"
  });
}

export function aiSettingsRequestFor(
  draft: AiSettingsDraft,
  idempotencyKey: string,
  options: AiSettingsRequestOptions = { managedFallbackAvailable: false }
): UserSettingsUpdateRequest {
  const appDefault = draft.providerMode === "app_default";
  const fallbackOffered = !appDefault && options.managedFallbackAvailable;
  return {
    expectedSettingsRevision: draft.settingsRevision,
    idempotencyKey,
    organizationMode: draft.organizationMode,
    providerMode: draft.providerMode,
    byokProvider: appDefault ? null : draft.byokProvider,
    modelSelection: appDefault ? "auto" : draft.modelSelection,
    byokFallbackToApp: fallbackOffered ? draft.byokFallbackToApp : false,
    routingEffort: draft.routingEffort,
    expansionStyle: draft.expansionStyle,
    timezone: draft.timezone,
    locale: draft.locale
  };
}

export function isSettingsDraftLocked(
  pending: boolean,
  ambiguousAttempt: UserSettingsUpdateRequest | null
): boolean {
  return pending || ambiguousAttempt !== null;
}

export function isSettingsDraftSubmittable(draft: AiSettingsDraft): boolean {
  if (draft.timezone.trim().length === 0 || draft.locale.trim().length < 2) return false;
  if (draft.providerMode === "byok") {
    return (
      draft.byokProvider !== null &&
      isAiModelSelectionForProvider(draft.byokProvider, draft.modelSelection)
    );
  }
  return draft.modelSelection === "auto";
}

export async function reconcileAiSettingsRetry(
  attempt: UserSettingsUpdateRequest,
  load: () => Promise<UserSettingsResponse>
): Promise<AiSettingsRetryReconciliation> {
  const current = await load();
  if (current.settings.settingsRevision < attempt.expectedSettingsRevision) {
    throw new Error("Authoritative settings revision moved backward.");
  }
  return Object.freeze({
    ambiguousAttempt: null,
    current,
    dirty: false,
    draft: aiSettingsDraftFor(current.settings)
  });
}

export function isProviderKeyUsable(
  providerKey: ProviderKeyMetadata | null,
  provider?: PublicByokProvider
): boolean {
  return (
    providerKey?.status === "active" &&
    (provider === undefined || providerKey.provider === provider)
  );
}

export function providerKeyRetryAttempt(
  provider: PublicByokProvider,
  expectedCredentialRevision: number | null,
  idempotencyKey: string
): ProviderKeyRetryAttempt {
  return Object.freeze({ provider, expectedCredentialRevision, idempotencyKey });
}

export function providerKeyPutRequestFor(
  attempt: ProviderKeyRetryAttempt,
  apiKey: string
): ProviderKeyPutRequest {
  return {
    idempotencyKey: attempt.idempotencyKey,
    provider: attempt.provider,
    expectedCredentialRevision: attempt.expectedCredentialRevision,
    apiKey
  };
}
