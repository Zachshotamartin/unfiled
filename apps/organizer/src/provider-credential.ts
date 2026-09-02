import { OrganizerProviderError, OrganizerUnavailableError } from "./errors.js";
import {
  ORGANIZER_MODEL_REGISTRY_VERSION,
  isOrganizerModelId,
  isOrganizerModelSelection,
  isOrganizerProvider,
  isOrganizerRoutingEffort,
  modelIdBelongsToProvider,
  resolveOrganizerModelId,
  type OrganizerModelId,
  type OrganizerModelSelection,
  type OrganizerProvider,
  type OrganizerRoutingEffort
} from "./model-registry.js";

export type { OrganizerProvider, OrganizerRoutingEffort } from "./model-registry.js";
export type OrganizerProviderSource = "app_default" | "byok";
export type OrganizerExpansionStyle = "off" | "brief" | "detailed";

/** Immutable job settings that every provider request must be bound to. */
export type OrganizerProviderRouteBinding = Readonly<{
  adapterRegistryVersion: typeof ORGANIZER_MODEL_REGISTRY_VERSION;
  expansionStyle: OrganizerExpansionStyle;
  modelId: OrganizerModelId;
  modelSelection: OrganizerModelSelection;
  provider: OrganizerProvider;
  routingEffort: OrganizerRoutingEffort;
  settingsRevision: number;
}>;

export type OrganizerProviderCredential = OrganizerProviderRouteBinding &
  Readonly<{
    credentialRevision: number | null;
    source: OrganizerProviderSource;
    close(): void;
    withApiKey<T>(operation: (apiKey: string) => Promise<T>): Promise<T>;
  }>;

export type LeaseBoundOrganizerProviderRoute = OrganizerProviderRouteBinding &
  Readonly<{
    credential: string | null;
    credentialRevision: number | null;
    source: OrganizerProviderSource;
  }>;

export type OrganizerProviderSelection = Readonly<{
  credentialRevision: number | null;
  modelId: OrganizerModelId;
  provider: OrganizerProvider;
  source: OrganizerProviderSource;
}>;

export type OrganizerProviderCredentialAccess = Readonly<{
  lastSelection(): OrganizerProviderSelection | null;
  use<T>(operation: (credential: OrganizerProviderCredential) => Promise<T>): Promise<T>;
}>;

/**
 * Operator-funded app-default credentials. The database snapshots app-default
 * jobs as OpenAI only, so the free BYOK-only beta runs with an empty record.
 */
export type OrganizerAppDefaultApiKeys = Readonly<{ openai?: string }>;

function assertApiKey(value: string): void {
  let hasUnsafeCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) hasUnsafeCharacter = true;
  }
  if (value.length < 20 || value.length > 512 || value.trim() !== value || hasUnsafeCharacter) {
    throw new OrganizerProviderError("provider_key_invalid", false);
  }
}

/** Rejects any binding whose provider, model, effort, and registry pin disagree. */
export function assertOrganizerProviderRouteBinding(binding: OrganizerProviderRouteBinding): void {
  // Re-validate as untrusted data: the static type does not prove what a database row or
  // test double actually contained.
  const raw: Readonly<Record<string, unknown>> = binding;
  if (
    !isOrganizerProvider(raw.provider) ||
    !isOrganizerModelId(raw.modelId) ||
    !isOrganizerModelSelection(raw.modelSelection) ||
    !isOrganizerRoutingEffort(raw.routingEffort) ||
    (raw.expansionStyle !== "off" &&
      raw.expansionStyle !== "brief" &&
      raw.expansionStyle !== "detailed") ||
    raw.adapterRegistryVersion !== ORGANIZER_MODEL_REGISTRY_VERSION ||
    !Number.isSafeInteger(raw.settingsRevision) ||
    Number(raw.settingsRevision) < 1 ||
    !modelIdBelongsToProvider(raw.provider, raw.modelId) ||
    resolveOrganizerModelId(raw.provider, raw.modelSelection, raw.routingEffort) !== raw.modelId
  ) {
    throw new OrganizerUnavailableError();
  }
}

export function sameOrganizerProviderRouteBinding(
  left: OrganizerProviderRouteBinding,
  right: OrganizerProviderRouteBinding
): boolean {
  const leftRegistry: string = left.adapterRegistryVersion;
  return (
    leftRegistry === right.adapterRegistryVersion &&
    left.expansionStyle === right.expansionStyle &&
    left.modelId === right.modelId &&
    left.modelSelection === right.modelSelection &&
    left.provider === right.provider &&
    left.routingEffort === right.routingEffort &&
    left.settingsRevision === right.settingsRevision
  );
}

function routeBinding(input: OrganizerProviderRouteBinding): OrganizerProviderRouteBinding {
  return Object.freeze({
    adapterRegistryVersion: input.adapterRegistryVersion,
    expansionStyle: input.expansionStyle,
    modelId: input.modelId,
    modelSelection: input.modelSelection,
    provider: input.provider,
    routingEffort: input.routingEffort,
    settingsRevision: input.settingsRevision
  });
}

/**
 * Holds provider material in an erasable byte buffer and only decodes it at the
 * outbound request boundary. JavaScript strings cannot be zeroed, so callers
 * must not retain, log, cache, or return the callback value.
 */
export function createOrganizerProviderCredential(
  input: OrganizerProviderRouteBinding &
    Readonly<{
      apiKey: string;
      credentialRevision: number | null;
      source: OrganizerProviderSource;
    }>
): OrganizerProviderCredential {
  assertApiKey(input.apiKey);
  assertOrganizerProviderRouteBinding(input);
  if (
    (input.source === "byok" && input.credentialRevision === null) ||
    (input.source === "app_default" && input.credentialRevision !== null)
  ) {
    throw new OrganizerUnavailableError();
  }
  const bytes = new TextEncoder().encode(input.apiKey);
  let closed = false;
  let active = 0;
  return Object.freeze({
    ...routeBinding(input),
    credentialRevision: input.credentialRevision,
    source: input.source,
    close() {
      if (closed) return;
      if (active !== 0) throw new OrganizerUnavailableError();
      closed = true;
      bytes.fill(0);
    },
    async withApiKey<T>(operation: (apiKey: string) => Promise<T>): Promise<T> {
      if (closed) throw new OrganizerUnavailableError();
      active += 1;
      try {
        const apiKey = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return await operation(apiKey);
      } finally {
        active -= 1;
      }
    }
  });
}

/**
 * A BYOK route carries the user's live Vault credential. An app-default route
 * carries no secret and may be served only by the operator key for exactly that
 * provider; a BYOK-only deployment without one fails closed and non-retryably.
 */
export function materializeLeaseBoundProviderCredential(
  route: LeaseBoundOrganizerProviderRoute,
  appDefaultApiKeys: OrganizerAppDefaultApiKeys
): OrganizerProviderCredential {
  assertOrganizerProviderRouteBinding(route);
  if (
    (route.source === "byok" && (route.credential === null || route.credentialRevision === null)) ||
    (route.source === "app_default" &&
      (route.credential !== null || route.credentialRevision !== null))
  ) {
    throw new OrganizerUnavailableError();
  }
  const apiKey =
    route.source === "byok"
      ? route.credential
      : route.provider === "openai"
        ? (appDefaultApiKeys.openai ?? null)
        : null;
  if (apiKey === null) throw new OrganizerProviderError("provider_unavailable", false);
  return createOrganizerProviderCredential({
    ...routeBinding(route),
    apiKey,
    credentialRevision: route.credentialRevision,
    source: route.source
  });
}

export function createOrganizerProviderCredentialAccess(
  input: Readonly<{
    appDefaultApiKeys: OrganizerAppDefaultApiKeys;
    resolve(): Promise<LeaseBoundOrganizerProviderRoute>;
  }>
): OrganizerProviderCredentialAccess {
  let lastSelection: OrganizerProviderSelection | null = null;
  return Object.freeze({
    lastSelection() {
      return lastSelection;
    },
    async use<T>(operation: (credential: OrganizerProviderCredential) => Promise<T>): Promise<T> {
      const route = await input.resolve();
      const credential = materializeLeaseBoundProviderCredential(route, input.appDefaultApiKeys);
      lastSelection = Object.freeze({
        credentialRevision: credential.credentialRevision,
        modelId: credential.modelId,
        provider: credential.provider,
        source: credential.source
      });
      try {
        return await operation(credential);
      } finally {
        credential.close();
      }
    }
  });
}
