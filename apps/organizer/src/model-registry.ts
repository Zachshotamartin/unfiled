import {
  AI_MODEL_CATALOG,
  AI_MODEL_CATALOG_VERSION,
  type AiModelSelection,
  type PublicByokProvider
} from "@unfiled/contracts";

/**
 * Organizer-side projection of the shared `organization-model-registry-v2`
 * catalog. The database resolves Automatic when a job is created and snapshots
 * the exact model; this module only revalidates that snapshot and maps the
 * routing effort to each provider's native reasoning setting.
 */
export const ORGANIZER_MODEL_REGISTRY_VERSION: typeof AI_MODEL_CATALOG_VERSION =
  AI_MODEL_CATALOG_VERSION;

export type OrganizerProvider = PublicByokProvider;
export type OrganizerModelSelection = AiModelSelection;
export type OrganizerModelId = Exclude<AiModelSelection, "auto">;
export type OrganizerRoutingEffort = "economical" | "standard" | "thorough";
export type OrganizerProviderNativeEffort = "low" | "medium" | "high";

const PROVIDERS: readonly OrganizerProvider[] = Object.freeze(["openai", "anthropic"]);
const ROUTING_EFFORTS: readonly OrganizerRoutingEffort[] = Object.freeze([
  "economical",
  "standard",
  "thorough"
]);

function catalogFor(provider: OrganizerProvider) {
  const entry = AI_MODEL_CATALOG.providers.find((candidate) => candidate.provider === provider);
  if (entry === undefined) throw new Error(`organizer_model_registry_missing_provider:${provider}`);
  return entry;
}

function exactModelIds(provider: OrganizerProvider): readonly OrganizerModelId[] {
  return Object.freeze(
    catalogFor(provider)
      .models.map(({ value }) => value)
      .filter((value): value is OrganizerModelId => value !== "auto")
  );
}

export const OPENAI_MODEL_IDS: readonly OrganizerModelId[] = exactModelIds("openai");
export const ANTHROPIC_MODEL_IDS: readonly OrganizerModelId[] = exactModelIds("anthropic");
export const ORGANIZER_MODEL_IDS: readonly OrganizerModelId[] = Object.freeze([
  ...OPENAI_MODEL_IDS,
  ...ANTHROPIC_MODEL_IDS
]);
export const ORGANIZER_MODEL_SELECTIONS: readonly OrganizerModelSelection[] = Object.freeze([
  "auto",
  ...ORGANIZER_MODEL_IDS
]);

export function isOrganizerProvider(value: unknown): value is OrganizerProvider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export function isOrganizerRoutingEffort(value: unknown): value is OrganizerRoutingEffort {
  return typeof value === "string" && (ROUTING_EFFORTS as readonly string[]).includes(value);
}

export function isOrganizerModelSelection(value: unknown): value is OrganizerModelSelection {
  return (
    typeof value === "string" && (ORGANIZER_MODEL_SELECTIONS as readonly string[]).includes(value)
  );
}

export function isOrganizerModelId(value: unknown): value is OrganizerModelId {
  return typeof value === "string" && (ORGANIZER_MODEL_IDS as readonly string[]).includes(value);
}

export function modelIdsForProvider(provider: OrganizerProvider): readonly OrganizerModelId[] {
  return provider === "openai" ? OPENAI_MODEL_IDS : ANTHROPIC_MODEL_IDS;
}

export function modelIdBelongsToProvider(
  provider: OrganizerProvider,
  modelId: string
): modelId is OrganizerModelId {
  return (modelIdsForProvider(provider) as readonly string[]).includes(modelId);
}

export function modelSelectionMatchesProvider(
  provider: OrganizerProvider,
  modelSelection: OrganizerModelSelection
): boolean {
  return modelSelection === "auto" || modelIdBelongsToProvider(provider, modelSelection);
}

/** Mirrors `private.resolve_organization_model_id`; `null` means the pair is unsupported. */
export function resolveOrganizerModelId(
  provider: OrganizerProvider,
  modelSelection: OrganizerModelSelection,
  routingEffort: OrganizerRoutingEffort
): OrganizerModelId | null {
  if (!modelSelectionMatchesProvider(provider, modelSelection)) return null;
  if (modelSelection !== "auto") return modelSelection;
  return catalogFor(provider).autoByEffort[routingEffort];
}

/** Maps the stable wire effort to the provider-native reasoning effort. */
export function providerNativeEffort(
  routingEffort: OrganizerRoutingEffort
): OrganizerProviderNativeEffort {
  return AI_MODEL_CATALOG.effortMapping[routingEffort];
}
