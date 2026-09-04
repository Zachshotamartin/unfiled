import { parseCaptureDescriptor } from "./descriptor.js";
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
  prepareDescriptorDisclosure,
  prepareProviderDisclosure,
  type DisclosedImage,
  type PreparedProviderDisclosure
} from "./planner-disclosure.js";
import {
  resolveDeterministicDestination,
  type CaptureDescriptorInput,
  type OrganizerPlanner,
  type PlannerInput
} from "./planner.js";
import { ORGANIZER_PROMPT_VERSION, ORGANIZER_SCHEMA_VERSION } from "./prompt.js";
import type {
  OrganizerProviderCredential,
  OrganizerProviderCredentialAccess
} from "./provider-credential.js";
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
  /** Photos add provider latency; a capture that carries one gets a longer window. */
  imageDeadlineMs: 30_000,
  /**
   * The descriptor pass answers with one sentence and runs before routing, so both calls have
   * to fit inside the job's own deadline. It gets the smaller half.
   */
  descriptorDeadlineMs: 15_000,
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
 * What the organizer is asking the provider for. `route` files the capture among the disclosed
 * candidates; `describe` reads the capture's photos into one factual sentence, which is what
 * retrieval and the capture kind are computed from when the owner typed nothing.
 */
export type OrganizerProviderTask = "route" | "describe";

/**
 * A provider adapter owns exactly its wire format: how a bounded disclosure
 * becomes a request for one exact model/effort and how a raw response becomes
 * an unvalidated record. Everything else is shared and provider-neutral.
 */
export type OrganizerProviderAdapter = Readonly<{
  buildRequest(
    input: Readonly<{
      images: readonly DisclosedImage[];
      modelId: OrganizerModelId;
      routingEffort: OrganizerRoutingEffort;
      serializedInput: string;
      task: OrganizerProviderTask;
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
  binding: Readonly<{
    modelId: OrganizerModelId;
    routingEffort: OrganizerRoutingEffort;
    task: OrganizerProviderTask;
  }>,
  apiKey: string,
  signal: AbortSignal
): Promise<unknown> {
  assertProviderApiKey(apiKey);
  if (!modelIdBelongsToProvider(adapter.provider, binding.modelId)) {
    throw new OrganizerProviderError("validation_failed", false);
  }
  const request = adapter.buildRequest({
    images: disclosure.images,
    modelId: binding.modelId,
    routingEffort: binding.routingEffort,
    serializedInput: disclosure.serialized,
    task: binding.task
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
  return binding.task === "describe" ? parsed : finalizeProviderPlan(parsed, disclosure);
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

  /** One bounded disclosure, sent under the job's credential with the shared retry policy. */
  async function runTask(
    task: OrganizerProviderTask,
    disclosure: PreparedProviderDisclosure,
    context: Readonly<{
      deadlineMs: number;
      providerCredential?: OrganizerProviderCredentialAccess;
      routingEffort: OrganizerRoutingEffort;
      signal: AbortSignal;
    }>
  ): Promise<unknown> {
    const deadline = AbortSignal.timeout(context.deadlineMs);
    const signal = AbortSignal.any([context.signal, deadline]);
    const executeWithCredential = (credential: OrganizerProviderCredential): Promise<unknown> => {
      const adapter = adapterFor(adapters, credential.provider);
      // A live credential that disagrees with the immutable job input is drift, not a transient fault.
      if (
        credential.routingEffort !== context.routingEffort ||
        !modelIdBelongsToProvider(adapter.provider, credential.modelId)
      ) {
        throw new OrganizerProviderError("provider_unavailable", false);
      }
      return credential.withApiKey((apiKey) =>
        executeProviderRequest(
          adapter,
          fetchImplementation,
          disclosure,
          { modelId: credential.modelId, routingEffort: credential.routingEffort, task },
          apiKey,
          signal
        )
      );
    };
    let attempt = 0;
    for (;;) {
      try {
        if (context.providerCredential !== undefined) {
          return await context.providerCredential.use(executeWithCredential);
        }
        const explicitAdapter = adapters[0];
        if (options.apiKey === undefined || explicitAdapter === undefined)
          throw new OrganizerProviderError("provider_unavailable", true);
        return await executeProviderRequest(
          explicitAdapter,
          fetchImplementation,
          disclosure,
          {
            modelId: explicitModelId(explicitAdapter, options, context.routingEffort),
            routingEffort: context.routingEffort,
            task
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

  return Object.freeze({
    async describe(input: CaptureDescriptorInput): Promise<string> {
      const disclosure = prepareDescriptorDisclosure({
        capture: input.capture,
        captureId: input.captureId,
        promptVersion: input.promptVersion,
        schemaVersion: input.schemaVersion,
        signal: input.signal
      });
      return parseCaptureDescriptor(
        await runTask("describe", disclosure, {
          deadlineMs: PROVIDER_ROUTING_PROFILE.descriptorDeadlineMs,
          ...(input.providerCredential === undefined
            ? {}
            : { providerCredential: input.providerCredential }),
          routingEffort: input.routingEffort ?? "standard",
          signal: input.signal
        })
      );
    },
    async plan(input: PlannerInput): Promise<unknown> {
      if (input.controls.explicitDestinationNoteId === null && input.controls.ruleMatch !== null) {
        throw new OrganizerPlannerReviewError("input_bounds");
      }
      const deterministicDestination = resolveDeterministicDestination({
        candidates: input.candidates,
        capture: input.capture
      });
      const disclosure = prepareProviderDisclosure(input, deterministicDestination);
      return runTask("route", disclosure, {
        deadlineMs:
          disclosure.images.length > 0
            ? PROVIDER_ROUTING_PROFILE.imageDeadlineMs
            : PROVIDER_ROUTING_PROFILE.deadlineMs,
        ...(input.providerCredential === undefined
          ? {}
          : { providerCredential: input.providerCredential }),
        routingEffort: input.routingEffort ?? "standard",
        signal: input.signal
      });
    }
  });
}
