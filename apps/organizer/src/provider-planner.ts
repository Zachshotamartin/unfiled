import {
  OrganizerPlannerReviewError,
  OrganizerProviderError,
  OrganizerUnavailableError
} from "./errors.js";
import {
  ORGANIZER_MODEL_REGISTRY_VERSION,
  modelIdBelongsToProvider,
  resolveOrganizerModelId,
  type OrganizerModelId,
  type OrganizerProvider,
  type OrganizerRoutingEffort
} from "./model-registry.js";
import {
  finalizeProviderPlan,
  prepareProviderDisclosure,
  type PreparedProviderDisclosure
} from "./planner-disclosure.js";
import {
  resolveDeterministicDestination,
  type OrganizerPlanner,
  type PlannerInput
} from "./planner.js";
import { ORGANIZER_PROMPT_VERSION, ORGANIZER_SCHEMA_VERSION } from "./prompt.js";
import type { OrganizerProviderCredential } from "./provider-credential.js";
import {
  assertProviderApiKey,
  fetchProviderWithAbort,
  providerFailureRetryable,
  providerNetworkFailure,
  providerResponseFailure,
  readProviderErrorIdentity,
  readBoundedProviderJson,
  type ProviderRequestHeaders
} from "./provider-transport.js";

/** Transport and retry policy shared by every provider adapter. */
export const PROVIDER_ROUTING_PROFILE = Object.freeze({
  deadlineMs: 20_000,
  maxRetries: 1,
  promptVersion: ORGANIZER_PROMPT_VERSION,
  registryVersion: ORGANIZER_MODEL_REGISTRY_VERSION,
  schemaVersion: ORGANIZER_SCHEMA_VERSION
} as const);

export type OrganizerProviderRequest = Readonly<{
  body: string;
  endpoint: string;
  headers(apiKey: string): ProviderRequestHeaders;
}>;

/**
 * A provider adapter owns exactly its wire format: how a bounded disclosure
 * becomes a request for one exact model/effort and how a raw response becomes
 * an unvalidated plan record. Everything else is shared and provider-neutral.
 */
export type OrganizerProviderAdapter = Readonly<{
  buildRequest(
    input: Readonly<{
      modelId: OrganizerModelId;
      routingEffort: OrganizerRoutingEffort;
      serializedInput: string;
    }>
  ): OrganizerProviderRequest;
  parseResponse(value: unknown): unknown;
  provider: OrganizerProvider;
}>;

export type OrganizerProviderPlannerOptions = Readonly<{
  /** Explicit-key mode for evaluation tooling only; production uses lease-bound credentials. */
  apiKey?: string;
  fetchImplementation?: typeof fetch;
  /** Exact model for explicit-key mode; defaults to the Automatic mapping for the effort. */
  modelId?: OrganizerModelId;
}>;

function adapterFor(
  adapters: readonly OrganizerProviderAdapter[],
  provider: OrganizerProvider
): OrganizerProviderAdapter {
  const adapter = adapters.find((candidate) => candidate.provider === provider);
  // A credential for a provider this planner cannot serve must never be sent anywhere.
  if (adapter === undefined) throw new OrganizerProviderError("provider_unavailable", false);
  return adapter;
}

function explicitModelId(
  adapter: OrganizerProviderAdapter,
  options: OrganizerProviderPlannerOptions,
  routingEffort: OrganizerRoutingEffort
): OrganizerModelId {
  const modelId =
    options.modelId ?? resolveOrganizerModelId(adapter.provider, "auto", routingEffort);
  if (modelId === null || !modelIdBelongsToProvider(adapter.provider, modelId)) {
    throw new OrganizerProviderError("validation_failed", false);
  }
  return modelId;
}

async function executeProviderRequest(
  adapter: OrganizerProviderAdapter,
  fetchImplementation: typeof fetch,
  disclosure: PreparedProviderDisclosure,
  binding: Readonly<{ modelId: OrganizerModelId; routingEffort: OrganizerRoutingEffort }>,
  apiKey: string,
  signal: AbortSignal
): Promise<unknown> {
  assertProviderApiKey(apiKey);
  if (!modelIdBelongsToProvider(adapter.provider, binding.modelId)) {
    throw new OrganizerProviderError("validation_failed", false);
  }
  const request = adapter.buildRequest({
    modelId: binding.modelId,
    routingEffort: binding.routingEffort,
    serializedInput: disclosure.serialized
  });
  const response = await fetchProviderWithAbort(
    fetchImplementation,
    request.endpoint,
    request.headers(apiKey),
    request.body,
    signal
  );
  if (!response.ok) {
    throw providerResponseFailure(
      response.status,
      await readProviderErrorIdentity(response, signal)
    );
  }
  const parsed = adapter.parseResponse(await readBoundedProviderJson(response, signal));
  if (signal.aborted) throw new OrganizerProviderError("provider_unavailable", true);
  return finalizeProviderPlan(parsed, disclosure);
}

/**
 * Builds a planner over one or more provider adapters. A lease-bound credential
 * selects the adapter, exact model, and effort for each attempt; the credential
 * is re-resolved on every attempt so a replacement key can be used by a fresh
 * attempt while one live lease never switches source or revision.
 */
export function createProviderRegistryPlanner(
  adapters: readonly OrganizerProviderAdapter[],
  options: OrganizerProviderPlannerOptions = {}
): OrganizerPlanner {
  if (adapters.length === 0) throw new OrganizerUnavailableError();
  if (options.apiKey !== undefined) {
    if (adapters.length !== 1) throw new OrganizerUnavailableError();
    assertProviderApiKey(options.apiKey);
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Object.freeze({
    async plan(input: PlannerInput): Promise<unknown> {
      if (input.controls.explicitDestinationNoteId === null && input.controls.ruleMatch !== null) {
        throw new OrganizerPlannerReviewError("input_bounds");
      }
      const deterministicDestination = resolveDeterministicDestination({
        candidates: input.candidates,
        capture: input.capture
      });
      const disclosure = prepareProviderDisclosure(input, deterministicDestination);
      const routingEffort = input.routingEffort ?? "standard";
      const deadline = AbortSignal.timeout(PROVIDER_ROUTING_PROFILE.deadlineMs);
      const signal = AbortSignal.any([input.signal, deadline]);
      const executeWithCredential = (credential: OrganizerProviderCredential): Promise<unknown> => {
        const adapter = adapterFor(adapters, credential.provider);
        // A live credential that disagrees with the immutable job input is drift, not a transient fault.
        if (
          credential.routingEffort !== routingEffort ||
          !modelIdBelongsToProvider(adapter.provider, credential.modelId)
        ) {
          throw new OrganizerProviderError("provider_unavailable", false);
        }
        return credential.withApiKey((apiKey) =>
          executeProviderRequest(
            adapter,
            fetchImplementation,
            disclosure,
            { modelId: credential.modelId, routingEffort: credential.routingEffort },
            apiKey,
            signal
          )
        );
      };
      let attempt = 0;
      for (;;) {
        try {
          if (input.providerCredential !== undefined) {
            return await input.providerCredential.use(executeWithCredential);
          }
          const explicitAdapter = adapters[0];
          if (options.apiKey === undefined || explicitAdapter === undefined)
            throw new OrganizerProviderError("provider_unavailable", true);
          return await executeProviderRequest(
            explicitAdapter,
            fetchImplementation,
            disclosure,
            {
              modelId: explicitModelId(explicitAdapter, options, routingEffort),
              routingEffort
            },
            options.apiKey,
            signal
          );
        } catch (error: unknown) {
          const safe = providerNetworkFailure(error);
          if (!providerFailureRetryable(safe, attempt, PROVIDER_ROUTING_PROFILE.maxRetries, signal))
            throw safe;
          attempt += 1;
        }
      }
    }
  });
}
