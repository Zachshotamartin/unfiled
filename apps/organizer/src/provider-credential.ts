import { OrganizerProviderError, OrganizerUnavailableError } from "./errors.js";

export type OrganizerProvider = "openai";
export type OrganizerProviderSource = "app_default" | "byok";
export type OrganizerRoutingEffort = "economical" | "standard" | "thorough";
export type OrganizerExpansionStyle = "off" | "brief" | "detailed";

export type OrganizerProviderCredential = Readonly<{
  credentialRevision: number | null;
  expansionStyle: OrganizerExpansionStyle;
  provider: OrganizerProvider;
  routingEffort: OrganizerRoutingEffort;
  source: OrganizerProviderSource;
  close(): void;
  withApiKey<T>(operation: (apiKey: string) => Promise<T>): Promise<T>;
}>;

export type LeaseBoundOrganizerProviderRoute = Readonly<{
  credential: string | null;
  credentialRevision: number | null;
  expansionStyle: OrganizerExpansionStyle;
  provider: OrganizerProvider;
  routingEffort: OrganizerRoutingEffort;
  source: OrganizerProviderSource;
}>;

export type OrganizerProviderSelection = Readonly<{
  credentialRevision: number | null;
  provider: OrganizerProvider;
  source: OrganizerProviderSource;
}>;

export type OrganizerProviderCredentialAccess = Readonly<{
  lastSelection(): OrganizerProviderSelection | null;
  use<T>(operation: (credential: OrganizerProviderCredential) => Promise<T>): Promise<T>;
}>;

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

/**
 * Holds provider material in an erasable byte buffer and only decodes it at the
 * outbound request boundary. JavaScript strings cannot be zeroed, so callers
 * must not retain, log, cache, or return the callback value.
 */
export function createOrganizerProviderCredential(
  input: Readonly<{
    apiKey: string;
    credentialRevision: number | null;
    expansionStyle: OrganizerExpansionStyle;
    provider: OrganizerProvider;
    routingEffort: OrganizerRoutingEffort;
    source: OrganizerProviderSource;
  }>
): OrganizerProviderCredential {
  assertApiKey(input.apiKey);
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
    credentialRevision: input.credentialRevision,
    expansionStyle: input.expansionStyle,
    provider: input.provider,
    routingEffort: input.routingEffort,
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

export function materializeLeaseBoundProviderCredential(
  route: LeaseBoundOrganizerProviderRoute,
  appDefaultApiKey: string
): OrganizerProviderCredential {
  const apiKey = route.source === "byok" ? route.credential : appDefaultApiKey;
  if (
    apiKey === null ||
    (route.source === "byok" && route.credentialRevision === null) ||
    (route.source === "app_default" &&
      (route.credential !== null || route.credentialRevision !== null))
  ) {
    throw new OrganizerUnavailableError();
  }
  return createOrganizerProviderCredential({
    apiKey,
    credentialRevision: route.credentialRevision,
    expansionStyle: route.expansionStyle,
    provider: route.provider,
    routingEffort: route.routingEffort,
    source: route.source
  });
}

export function createOrganizerProviderCredentialAccess(
  input: Readonly<{
    appDefaultApiKey: string;
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
      const credential = materializeLeaseBoundProviderCredential(route, input.appDefaultApiKey);
      lastSelection = Object.freeze({
        credentialRevision: credential.credentialRevision,
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
