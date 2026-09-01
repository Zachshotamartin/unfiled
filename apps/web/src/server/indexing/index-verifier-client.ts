import { getVercelOidcToken } from "@vercel/oidc";

import { ConfigurationError } from "@/server/api/errors";

const VERIFY_PATH = "/internal/verify";
const MAX_RESPONSE_BYTES = 4_096;
export const INDEX_VERIFIER_SERVER_TIMEOUT_MS = 49_000;
export const INDEX_VERIFIER_CLIENT_MIN_TIMEOUT_MS = INDEX_VERIFIER_SERVER_TIMEOUT_MS + 1;
export const INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS = 54_000;
export const INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS = 54_000;
const VERCEL_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/u;
const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION_ID_PATTERN = /^igen_[0-9A-HJKMNP-TV-Z]{26}$/u;
const REVISION_TOKEN_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const MAX_INT64 = 9_223_372_036_854_775_807n;

export type IndexVerificationTarget = Readonly<{
  ownerId: string;
  generationId: string;
  revisionToken: string;
}>;

export type IndexVerificationResult = Readonly<{
  generationId: string;
  revisionToken: string;
  verifiedNoteCount: number;
  verified: true;
}>;

export type IndexVerifierClient = Readonly<{
  verify(target: IndexVerificationTarget, signal?: AbortSignal): Promise<IndexVerificationResult>;
}>;

export type IndexVerifierEnvironment = Readonly<Record<string, string | undefined>>;

export class IndexVerifierInvocationError extends Error {
  public constructor() {
    super("The encrypted index verifier is unavailable.");
    this.name = "IndexVerifierInvocationError";
  }
}

export class IndexVerifierGenerationInvalidError extends Error {
  public constructor() {
    super("The encrypted index generation is invalid.");
    this.name = "IndexVerifierGenerationInvalidError";
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function verifierUrl(originValue: string): URL {
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
    !VERCEL_HOST_PATTERN.test(origin.hostname)
  ) {
    throw new ConfigurationError();
  }
  return new URL(VERIFY_PATH, origin);
}

function positiveTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < INDEX_VERIFIER_CLIENT_MIN_TIMEOUT_MS ||
    value > INDEX_VERIFIER_CLIENT_MAX_TIMEOUT_MS
  ) {
    throw new ConfigurationError();
  }
  return value;
}

function validTarget(value: IndexVerificationTarget): boolean {
  if (
    !OWNER_ID_PATTERN.test(value.ownerId) ||
    !GENERATION_ID_PATTERN.test(value.generationId) ||
    !REVISION_TOKEN_PATTERN.test(value.revisionToken)
  ) {
    return false;
  }
  try {
    return BigInt(value.revisionToken) <= MAX_INT64;
  } catch {
    return false;
  }
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(new IndexVerifierInvocationError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error: unknown) {
      rejectOnce(error instanceof Error ? error : new IndexVerifierInvocationError());
      return;
    }
    void pending.then(resolveOnce, (error: unknown) => {
      rejectOnce(error instanceof Error ? error : new IndexVerifierInvocationError());
    });
  });
}

function parseResult(value: unknown, target: IndexVerificationTarget): IndexVerificationResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value as Readonly<Record<string, unknown>>, [
      "generationId",
      "revisionToken",
      "verifiedNoteCount",
      "verified"
    ])
  ) {
    throw new IndexVerifierInvocationError();
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.generationId !== target.generationId ||
    record.revisionToken !== target.revisionToken ||
    typeof record.verifiedNoteCount !== "number" ||
    !Number.isSafeInteger(record.verifiedNoteCount) ||
    record.verifiedNoteCount < 0 ||
    record.verifiedNoteCount > 2_147_483_647 ||
    record.verified !== true
  ) {
    throw new IndexVerifierInvocationError();
  }
  return Object.freeze({
    generationId: target.generationId,
    revisionToken: target.revisionToken,
    verifiedNoteCount: record.verifiedNoteCount,
    verified: true
  });
}

function parseGenerationInvalid(value: unknown, response: Response): never {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value as Readonly<Record<string, unknown>>, ["code", "message", "requestId"])
  ) {
    throw new IndexVerifierInvocationError();
  }
  const record = value as Readonly<Record<string, unknown>>;
  const responseRequestId = response.headers.get("x-request-id");
  if (
    record.code !== "generation_invalid" ||
    record.message !== "That encrypted generation could not be verified." ||
    typeof record.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(record.requestId) ||
    responseRequestId !== record.requestId ||
    response.headers.has("retry-after")
  ) {
    throw new IndexVerifierInvocationError();
  }
  throw new IndexVerifierGenerationInvalidError();
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
  expectedStatus: 200 | 409
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const declared = response.headers.get("content-length");
  if (
    response.status !== expectedStatus ||
    contentType !== "application/json" ||
    (declared !== null &&
      (!/^\d{1,10}$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) ||
    response.body === null
  ) {
    if (response.body !== null) void response.body.cancel().catch(() => undefined);
    throw new IndexVerifierInvocationError();
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
    let part = await reader.read();
    while (!part.done) {
      total += part.value.byteLength;
      if (signal.aborted || total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new IndexVerifierInvocationError();
      }
      chunks.push(part.value);
      part = await reader.read();
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    if (error instanceof IndexVerifierInvocationError) throw error;
    throw new IndexVerifierInvocationError();
  } finally {
    signal.removeEventListener("abort", cancel);
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    try {
      reader.releaseLock();
    } catch {
      // Cleanup failure must not expose transport details or replace the redacted result.
    }
  }
}

export function createIndexVerifierClient(
  input: Readonly<{
    fetchImplementation?: typeof fetch;
    getOidcToken?: () => Promise<string>;
    origin: string;
    timeoutMs?: number;
  }>
): IndexVerifierClient {
  const url = verifierUrl(input.origin);
  const timeoutMs = positiveTimeout(input.timeoutMs ?? INDEX_VERIFIER_CLIENT_DEFAULT_TIMEOUT_MS);
  const request = input.fetchImplementation ?? fetch;
  const token = input.getOidcToken ?? getVercelOidcToken;
  return Object.freeze({
    async verify(target, externalSignal): Promise<IndexVerificationResult> {
      if (!validTarget(target)) throw new IndexVerifierInvocationError();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal =
        externalSignal === undefined ? timeout : AbortSignal.any([externalSignal, timeout]);
      let response: Response;
      try {
        if (signal.aborted) throw new IndexVerifierInvocationError();
        const oidcToken = await abortable(token, signal);
        if (
          oidcToken.length < 32 ||
          oidcToken.length > 16_384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(oidcToken)
        ) {
          throw new IndexVerifierInvocationError();
        }
        response = await request(url, {
          body: JSON.stringify(target),
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-vercel-trusted-oidc-idp-token": oidcToken
          },
          method: "POST",
          redirect: "error",
          signal
        });
      } catch (error: unknown) {
        if (error instanceof IndexVerifierInvocationError) throw error;
        throw new IndexVerifierInvocationError();
      }
      if (response.status === 409) {
        return parseGenerationInvalid(await boundedJson(response, signal, 409), response);
      }
      return parseResult(await boundedJson(response, signal, 200), target);
    }
  });
}

export function createEnvironmentIndexVerifierClient(
  environment: IndexVerifierEnvironment = process.env,
  dependencies: Readonly<{
    fetchImplementation?: typeof fetch;
    getOidcToken?: () => Promise<string>;
  }> = {}
): IndexVerifierClient {
  const origin = environment.UNFILED_RAG_VERIFIER_ORIGIN?.trim();
  const workerOrigin = environment.UNFILED_INDEX_WORKER_ORIGIN?.trim();
  const sourceProjectId = environment.VERCEL_PROJECT_ID?.trim();
  if (
    environment.VERCEL !== "1" ||
    environment.VERCEL_ENV !== "production" ||
    origin === undefined ||
    origin === workerOrigin ||
    sourceProjectId === undefined ||
    !/^prj_[A-Za-z0-9]{6,100}$/u.test(sourceProjectId)
  ) {
    throw new ConfigurationError();
  }
  return createIndexVerifierClient({
    ...dependencies,
    origin
  });
}

export const environmentIndexVerifierClient: IndexVerifierClient = Object.freeze({
  verify(target, signal) {
    return createEnvironmentIndexVerifierClient().verify(target, signal);
  }
});
