import { getVercelOidcToken } from "@vercel/oidc";

import {
  EncryptedUserSearchInvocationSchema,
  EncryptedUserSearchResultSchema,
  type EncryptedUserSearchInvocation,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";

import { ConfigurationError } from "@/server/api/errors";

import { encryptedUserSearchFailure, EncryptedUserSearchError } from "./errors";

const QUERY_PATH = "/internal/query";
export const ENCRYPTED_USER_SEARCH_MAX_REQUEST_BYTES = 4_096;
export const ENCRYPTED_USER_SEARCH_MAX_RESPONSE_BYTES = 16_384;
export const ENCRYPTED_USER_SEARCH_DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 25_000;
const VERCEL_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/u;
const OIDC_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const VERCEL_PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9]{6,100}$/u;

export type EncryptedUserSearchClient = Readonly<{
  query(
    invocation: EncryptedUserSearchInvocation,
    signal?: AbortSignal
  ): Promise<EncryptedUserSearchResult>;
}>;

export type EncryptedUserSearchClientEnvironment = Readonly<Record<string, string | undefined>>;

function queryUrl(originValue: string): URL {
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new ConfigurationError();
  }
  if (
    origin.protocol !== "https:" ||
    origin.port !== "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    originValue !== origin.origin ||
    !VERCEL_HOST_PATTERN.test(origin.hostname)
  ) {
    throw new ConfigurationError();
  }
  return new URL(QUERY_PATH, origin);
}

function timeoutMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigurationError();
  }
  return value;
}

function abortable<Result>(operation: () => Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => finish(() => reject(new EncryptedUserSearchError()));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: Promise<Result>;
    try {
      pending = Promise.resolve(operation());
    } catch {
      finish(() => reject(new EncryptedUserSearchError()));
      return;
    }
    void pending.then(
      (value) => {
        if (signal.aborted) onAbort();
        else finish(() => resolve(value));
      },
      () => finish(() => reject(new EncryptedUserSearchError()))
    );
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const declared = response.headers.get("content-length");
  if (
    response.status !== 200 ||
    contentType !== "application/json" ||
    (declared !== null &&
      (!/^\d{1,10}$/u.test(declared) ||
        Number(declared) > ENCRYPTED_USER_SEARCH_MAX_RESPONSE_BYTES)) ||
    response.body === null
  ) {
    if (response.body !== null) void response.body.cancel().catch(() => undefined);
    return encryptedUserSearchFailure();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes: Uint8Array | undefined;
  let total = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const part = await abortable(() => reader.read(), signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > ENCRYPTED_USER_SEARCH_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return encryptedUserSearchFailure();
      }
      chunks.push(part.value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    if (error instanceof EncryptedUserSearchError) throw error;
    return encryptedUserSearchFailure();
  } finally {
    signal.removeEventListener("abort", cancel);
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    try {
      reader.releaseLock();
    } catch {
      // Cleanup failure cannot replace the redacted transport result.
    }
  }
}

function parsedInvocation(value: EncryptedUserSearchInvocation): Readonly<{
  body: string;
  invocation: EncryptedUserSearchInvocation;
}> {
  const parsed = EncryptedUserSearchInvocationSchema.safeParse(value);
  if (!parsed.success) return encryptedUserSearchFailure();
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, "utf8") > ENCRYPTED_USER_SEARCH_MAX_REQUEST_BYTES) {
    return encryptedUserSearchFailure();
  }
  return Object.freeze({ body, invocation: parsed.data });
}

function parsedResult(
  value: unknown,
  invocation: EncryptedUserSearchInvocation
): EncryptedUserSearchResult {
  const parsed = EncryptedUserSearchResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.searchId !== invocation.searchId) {
    return encryptedUserSearchFailure();
  }
  for (const item of parsed.data.items) Object.freeze(item);
  Object.freeze(parsed.data.items);
  return Object.freeze(parsed.data);
}

export function createEncryptedUserSearchClient(
  input: Readonly<{
    fetchImplementation?: typeof fetch;
    getOidcToken?: () => Promise<string>;
    origin: string;
    timeoutMs?: number;
  }>
): EncryptedUserSearchClient {
  const url = queryUrl(input.origin);
  const timeoutMs = timeoutMilliseconds(
    input.timeoutMs ?? ENCRYPTED_USER_SEARCH_DEFAULT_TIMEOUT_MS
  );
  const request = input.fetchImplementation ?? fetch;
  const token = input.getOidcToken ?? getVercelOidcToken;
  return Object.freeze({
    async query(invocation, externalSignal): Promise<EncryptedUserSearchResult> {
      const requestPayload = parsedInvocation(invocation);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal =
        externalSignal === undefined ? timeout : AbortSignal.any([externalSignal, timeout]);
      let response: Response;
      try {
        if (signal.aborted) return encryptedUserSearchFailure();
        const oidcToken = await abortable(token, signal);
        if (
          oidcToken.length < 32 ||
          oidcToken.length > 16_384 ||
          !OIDC_TOKEN_PATTERN.test(oidcToken)
        ) {
          return encryptedUserSearchFailure();
        }
        response = await abortable(
          () =>
            request(url, {
              body: requestPayload.body,
              cache: "no-store",
              credentials: "omit",
              headers: {
                "content-type": "application/json",
                "x-unfiled-trusted-oidc-idp-token": oidcToken
              },
              method: "POST",
              redirect: "error",
              referrerPolicy: "no-referrer",
              signal
            }),
          signal
        );
      } catch (error: unknown) {
        if (error instanceof EncryptedUserSearchError) throw error;
        return encryptedUserSearchFailure();
      }
      return parsedResult(await boundedJson(response, signal), requestPayload.invocation);
    }
  });
}

export function createEnvironmentEncryptedUserSearchClient(
  environment: EncryptedUserSearchClientEnvironment = process.env,
  dependencies: Readonly<{
    fetchImplementation?: typeof fetch;
    getOidcToken?: () => Promise<string>;
  }> = {}
): EncryptedUserSearchClient {
  const origin = environment.UNFILED_SEARCH_ORIGIN?.trim();
  const sourceProjectId = environment.VERCEL_PROJECT_ID?.trim();
  const runtime = environment.VERCEL_ENV?.trim();
  const targetRuntime = environment.UNFILED_SEARCH_ENV?.trim();
  if (
    environment.VERCEL !== "1" ||
    (runtime !== "preview" && runtime !== "production") ||
    targetRuntime !== runtime ||
    origin === undefined ||
    sourceProjectId === undefined ||
    !VERCEL_PROJECT_ID_PATTERN.test(sourceProjectId)
  ) {
    throw new ConfigurationError();
  }
  return createEncryptedUserSearchClient({ ...dependencies, origin });
}

export const environmentEncryptedUserSearchClient: EncryptedUserSearchClient = Object.freeze({
  query(invocation, signal) {
    return createEnvironmentEncryptedUserSearchClient().query(invocation, signal);
  }
});
