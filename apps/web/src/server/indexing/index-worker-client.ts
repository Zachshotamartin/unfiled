import { getVercelOidcToken } from "@vercel/oidc";

import { ConfigurationError } from "@/server/api/errors";

const DRAIN_PATH = "/internal/drain";
const MAX_RESPONSE_BYTES = 4_096;
const DEFAULT_TIMEOUT_MS = 50_000;
const VERCEL_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/u;

export type IndexDrainTrigger = "manual" | "recovery" | "schedule";

export type IndexDrainResult = Readonly<{
  claimed: number;
  completed: number;
  failed: number;
  retryScheduled: number;
}>;

export type IndexWorkerClient = Readonly<{
  drain(trigger: IndexDrainTrigger, signal?: AbortSignal): Promise<IndexDrainResult>;
}>;

export type IndexWorkerEnvironment = Readonly<Record<string, string | undefined>>;

export class IndexWorkerInvocationError extends Error {
  public constructor() {
    super("The encrypted index worker is unavailable.");
    this.name = "IndexWorkerInvocationError";
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 4;
}

function parseDrainResult(value: unknown): IndexDrainResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value as Readonly<Record<string, unknown>>, [
      "claimed",
      "completed",
      "failed",
      "retryScheduled"
    ])
  ) {
    throw new IndexWorkerInvocationError();
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !boundedCount(record.claimed) ||
    !boundedCount(record.completed) ||
    !boundedCount(record.failed) ||
    !boundedCount(record.retryScheduled) ||
    record.completed + record.failed + record.retryScheduled > record.claimed
  ) {
    throw new IndexWorkerInvocationError();
  }
  return Object.freeze({
    claimed: record.claimed,
    completed: record.completed,
    failed: record.failed,
    retryScheduled: record.retryScheduled
  });
}

function workerUrl(originValue: string): URL {
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
  return new URL(DRAIN_PATH, origin);
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 50_000) {
    throw new ConfigurationError();
  }
  return value;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const declared = response.headers.get("content-length");
  if (
    !response.ok ||
    contentType !== "application/json" ||
    (declared !== null &&
      (!/^\d{1,10}$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) ||
    response.body === null
  ) {
    void response.body?.cancel();
    throw new IndexWorkerInvocationError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (): void => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let part = await reader.read();
    while (!part.done) {
      total += part.value.byteLength;
      if (signal.aborted || total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new IndexWorkerInvocationError();
      }
      chunks.push(part.value);
      part = await reader.read();
    }
    const bytes = new Uint8Array(total);
    try {
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error: unknown) {
      if (error instanceof IndexWorkerInvocationError) throw error;
      throw new IndexWorkerInvocationError();
    } finally {
      bytes.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createIndexWorkerClient(
  input: Readonly<{
    fetchImplementation?: typeof fetch;
    getOidcToken?: () => Promise<string>;
    origin: string;
    timeoutMs?: number;
  }>
): IndexWorkerClient {
  const url = workerUrl(input.origin);
  const timeoutMs = positiveTimeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const request = input.fetchImplementation ?? fetch;
  const token = input.getOidcToken ?? getVercelOidcToken;
  return Object.freeze({
    async drain(trigger, externalSignal): Promise<IndexDrainResult> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal =
        externalSignal === undefined ? timeout : AbortSignal.any([externalSignal, timeout]);
      let response: Response;
      try {
        if (signal.aborted) throw new IndexWorkerInvocationError();
        const oidcToken = await token();
        if (
          oidcToken.length < 32 ||
          oidcToken.length > 16_384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(oidcToken)
        ) {
          throw new IndexWorkerInvocationError();
        }
        response = await request(url, {
          body: JSON.stringify({ trigger }),
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
        if (error instanceof IndexWorkerInvocationError) throw error;
        throw new IndexWorkerInvocationError();
      }
      return parseDrainResult(await boundedJson(response, signal));
    }
  });
}

export function createEnvironmentIndexWorkerClient(
  environment: IndexWorkerEnvironment = process.env,
  dependencies: Readonly<{
    fetchImplementation?: typeof fetch;
    getOidcToken?: () => Promise<string>;
  }> = {}
): IndexWorkerClient {
  const origin = environment.UNFILED_INDEX_WORKER_ORIGIN?.trim();
  const sourceProjectId = environment.VERCEL_PROJECT_ID?.trim();
  if (
    environment.VERCEL !== "1" ||
    environment.VERCEL_ENV !== "production" ||
    origin === undefined ||
    sourceProjectId === undefined ||
    !/^prj_[A-Za-z0-9]{6,100}$/u.test(sourceProjectId)
  ) {
    throw new ConfigurationError();
  }
  return createIndexWorkerClient({
    ...dependencies,
    origin
  });
}

export const environmentIndexWorkerClient: IndexWorkerClient = Object.freeze({
  drain(trigger, signal) {
    return createEnvironmentIndexWorkerClient().drain(trigger, signal);
  }
});
