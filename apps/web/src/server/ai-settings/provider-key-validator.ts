import {
  ApiErrorCode,
  PublicByokProviderSchema,
  type PublicByokProvider
} from "@unfiled/contracts";

import { HttpError } from "@/server/api/errors";

/** The Automatic/Balanced OpenAI model from organization-model-registry-v2. */
export const OPENAI_KEY_VALIDATION_MODEL = "gpt-5.6-terra" as const;
/** One body-free model lookup proves an OpenAI key without spending tokens. */
export const OPENAI_KEY_VALIDATION_URL =
  `https://api.openai.com/v1/models/${encodeURIComponent(OPENAI_KEY_VALIDATION_MODEL)}` as const;
/** One bounded model listing proves an Anthropic key without spending tokens. */
export const ANTHROPIC_KEY_VALIDATION_URL = "https://api.anthropic.com/v1/models?limit=1" as const;
export const ANTHROPIC_API_VERSION = "2023-06-01" as const;
const TEST_VALIDATION_OPT_IN_VARIABLE = "UNFILED_ALLOW_TEST_PROVIDER_VALIDATION_OVERRIDE";

const providerConfiguration = Object.freeze({
  openai: Object.freeze({
    environmentVariable: "UNFILED_TEST_OPENAI_VALIDATION_URL",
    productionUrl: OPENAI_KEY_VALIDATION_URL
  }),
  anthropic: Object.freeze({
    environmentVariable: "UNFILED_TEST_ANTHROPIC_VALIDATION_URL",
    productionUrl: ANTHROPIC_KEY_VALIDATION_URL
  })
});

export interface ProviderKeyValidator {
  validate(provider: PublicByokProvider, apiKey: string, signal: AbortSignal): Promise<void>;
}

export type ProviderKeyValidatorOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
}>;

function providerLabel(provider: PublicByokProvider): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

function unavailable(provider: PublicByokProvider): HttpError {
  return new HttpError(
    503,
    ApiErrorCode.PROVIDER_UNAVAILABLE,
    `${providerLabel(provider)} could not validate that key right now. Try again.`
  );
}

function validationUrl(
  provider: PublicByokProvider,
  environment: Readonly<Record<string, string | undefined>>
): string {
  const configuration = providerConfiguration[provider];
  const override = environment[configuration.environmentVariable];
  if (override === undefined) return configuration.productionUrl;

  const hasVercelMarker = Object.entries(environment).some(
    ([name, value]) => value !== undefined && (name === "VERCEL" || name.startsWith("VERCEL_"))
  );
  if (
    environment.NODE_ENV !== "test" ||
    environment.CI !== "true" ||
    environment[TEST_VALIDATION_OPT_IN_VARIABLE] !== "1" ||
    hasVercelMarker
  ) {
    throw unavailable(provider);
  }

  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(override);
    expected = new URL(configuration.productionUrl);
  } catch {
    throw unavailable(provider);
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== expected.pathname ||
    parsed.search !== expected.search
  ) {
    throw unavailable(provider);
  }
  return parsed.href;
}

function validationHeaders(provider: PublicByokProvider, apiKey: string): HeadersInit {
  const shared = {
    accept: "application/json",
    "cache-control": "no-store",
    pragma: "no-cache"
  };
  return provider === "openai"
    ? { ...shared, authorization: `Bearer ${apiKey}` }
    : {
        ...shared,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "x-api-key": apiKey
      };
}

export function createProviderKeyValidator(
  options: ProviderKeyValidatorOptions = {}
): ProviderKeyValidator {
  const request = options.fetch ?? globalThis.fetch;
  const environment = options.environment ?? process.env;
  return Object.freeze({
    async validate(
      provider: PublicByokProvider,
      apiKey: string,
      signal: AbortSignal
    ): Promise<void> {
      if (!PublicByokProviderSchema.safeParse(provider).success) {
        throw new HttpError(
          400,
          ApiErrorCode.VALIDATION_FAILED,
          "That AI provider is not available."
        );
      }
      let response: Response;
      try {
        response = await request(validationUrl(provider, environment), {
          cache: "no-store",
          credentials: "omit",
          headers: validationHeaders(provider, apiKey),
          method: "GET",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal
        });
      } catch {
        throw unavailable(provider);
      }
      try {
        if (response.status === 200) return;
        if (response.status === 401 || response.status === 403) {
          throw new HttpError(
            400,
            ApiErrorCode.PROVIDER_KEY_INVALID,
            `${providerLabel(provider)} did not accept that key. Check it and try again.`
          );
        }
        if (response.status === 429) {
          throw new HttpError(
            429,
            ApiErrorCode.RATE_LIMITED,
            `${providerLabel(provider)} is temporarily rate limiting key validation. Try again.`
          );
        }
        throw unavailable(provider);
      } finally {
        try {
          await response.body?.cancel();
        } catch {
          // The status-derived, content-free result remains authoritative.
        }
      }
    }
  });
}

/** Backward-compatible constructor for callers that validate only OpenAI keys. */
export function createOpenAiProviderKeyValidator(
  options: ProviderKeyValidatorOptions = {}
): ProviderKeyValidator {
  return createProviderKeyValidator(options);
}
