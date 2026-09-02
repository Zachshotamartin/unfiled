import { ApiErrorCode } from "@unfiled/contracts";

import { HttpError } from "@/server/api/errors";

const OPENAI_VALIDATION_MODEL = "gpt-5.4-mini-2026-03-17";
const OPENAI_VALIDATION_URL = `https://api.openai.com/v1/models/${encodeURIComponent(
  OPENAI_VALIDATION_MODEL
)}`;
const TEST_VALIDATION_URL_VARIABLE = "UNFILED_TEST_OPENAI_VALIDATION_URL";
const TEST_VALIDATION_OPT_IN_VARIABLE = "UNFILED_ALLOW_TEST_PROVIDER_VALIDATION_OVERRIDE";

export interface ProviderKeyValidator {
  validate(provider: string, apiKey: string, signal: AbortSignal): Promise<void>;
}

export type OpenAiProviderKeyValidatorOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
}>;

function unavailable(): HttpError {
  return new HttpError(
    503,
    ApiErrorCode.PROVIDER_UNAVAILABLE,
    "OpenAI could not validate that key right now. Try again."
  );
}

function validationUrl(environment: Readonly<Record<string, string | undefined>>): string {
  const override = environment[TEST_VALIDATION_URL_VARIABLE];
  if (override === undefined) return OPENAI_VALIDATION_URL;

  const hasVercelMarker = Object.entries(environment).some(
    ([name, value]) => value !== undefined && (name === "VERCEL" || name.startsWith("VERCEL_"))
  );
  if (
    environment.NODE_ENV !== "test" ||
    environment.CI !== "true" ||
    environment[TEST_VALIDATION_OPT_IN_VARIABLE] !== "1" ||
    hasVercelMarker
  ) {
    throw unavailable();
  }

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw unavailable();
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== `/v1/models/${encodeURIComponent(OPENAI_VALIDATION_MODEL)}`
  ) {
    throw unavailable();
  }
  return parsed.href;
}

export function createOpenAiProviderKeyValidator(
  options: OpenAiProviderKeyValidatorOptions = {}
): ProviderKeyValidator {
  const request = options.fetch ?? globalThis.fetch;
  const environment = options.environment ?? process.env;
  return Object.freeze({
    async validate(provider: string, apiKey: string, signal: AbortSignal): Promise<void> {
      if (provider !== "openai") {
        throw new HttpError(
          400,
          ApiErrorCode.VALIDATION_FAILED,
          "That AI provider is not available."
        );
      }
      let response: Response;
      try {
        response = await request(validationUrl(environment), {
          cache: "no-store",
          credentials: "omit",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
            "cache-control": "no-store",
            pragma: "no-cache"
          },
          method: "GET",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal
        });
      } catch {
        throw unavailable();
      }
      try {
        if (response.status === 200) return;
        if (response.status === 401 || response.status === 403) {
          throw new HttpError(
            400,
            ApiErrorCode.PROVIDER_KEY_INVALID,
            "OpenAI did not accept that key. Check it and try again."
          );
        }
        if (response.status === 429) {
          throw new HttpError(
            429,
            ApiErrorCode.RATE_LIMITED,
            "OpenAI is temporarily rate limiting key validation. Try again."
          );
        }
        throw unavailable();
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
