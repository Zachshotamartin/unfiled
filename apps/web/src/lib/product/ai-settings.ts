import type {
  ExpansionStyle,
  OrganizationMode,
  ProviderKeyMetadata,
  ProviderKeyPutRequest,
  RoutingEffort,
  UserSettingsDto,
  UserSettingsResponse,
  UserSettingsUpdateRequest
} from "@unfiled/contracts";

export type AiSettingsDraft = Readonly<{
  settingsRevision: number;
  organizationMode: OrganizationMode;
  providerMode: "app_default" | "byok";
  byokProvider: "openai" | null;
  byokFallbackToApp: boolean;
  routingEffort: RoutingEffort;
  expansionStyle: ExpansionStyle;
  timezone: string;
  locale: string;
}>;

export type ProviderKeyRetryAttempt = Readonly<{
  expectedCredentialRevision: number | null;
  idempotencyKey: string;
}>;

export type AiSettingsRetryReconciliation = Readonly<{
  ambiguousAttempt: null;
  current: UserSettingsResponse;
  dirty: false;
  draft: AiSettingsDraft;
}>;

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
    label: "Economical",
    detail: "Lowest BYOK cost. Best for short, familiar jots."
  },
  {
    value: "standard",
    label: "Standard",
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

export function aiSettingsDraftFor(settings: UserSettingsDto): AiSettingsDraft {
  return Object.freeze({
    settingsRevision: settings.settingsRevision,
    organizationMode: settings.organizationMode,
    providerMode: settings.providerMode,
    byokProvider: settings.byokProvider,
    byokFallbackToApp: settings.byokFallbackToApp,
    routingEffort: settings.routingEffort,
    expansionStyle: settings.expansionStyle,
    timezone: settings.timezone,
    locale: settings.locale
  });
}

export function aiSettingsRequestFor(
  draft: AiSettingsDraft,
  idempotencyKey: string
): UserSettingsUpdateRequest {
  const appDefault = draft.providerMode === "app_default";
  return {
    expectedSettingsRevision: draft.settingsRevision,
    idempotencyKey,
    organizationMode: draft.organizationMode,
    providerMode: draft.providerMode,
    byokProvider: appDefault ? null : "openai",
    byokFallbackToApp: appDefault ? false : draft.byokFallbackToApp,
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

export function isProviderKeyUsable(providerKey: ProviderKeyMetadata | null): boolean {
  return providerKey?.provider === "openai" && providerKey.status === "active";
}

export function providerKeyRetryAttempt(
  expectedCredentialRevision: number | null,
  idempotencyKey: string
): ProviderKeyRetryAttempt {
  return Object.freeze({ expectedCredentialRevision, idempotencyKey });
}

export function providerKeyPutRequestFor(
  attempt: ProviderKeyRetryAttempt,
  apiKey: string
): ProviderKeyPutRequest {
  return {
    idempotencyKey: attempt.idempotencyKey,
    provider: "openai",
    expectedCredentialRevision: attempt.expectedCredentialRevision,
    apiKey
  };
}
