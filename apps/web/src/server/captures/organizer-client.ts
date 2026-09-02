import { getVercelOidcToken } from "@vercel/oidc";

import { ConfigurationError } from "@/server/api/errors";

const DRAIN_PATH = "/internal/drain";
const MAX_RESPONSE_BYTES = 4_096;
const DEFAULT_TIMEOUT_MS = 54_000;
const VERCEL_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/u;

export type OrganizerDrainTrigger = "manual" | "recovery" | "schedule";

export type OrganizerDrainResult = Readonly<{
  claimed: number;
  completed: number;
  failed: number;
  retryScheduled: number;
}>;

export type OrganizerClient = Readonly<{
  drain(trigger: OrganizerDrainTrigger, signal?: AbortSignal): Promise<OrganizerDrainResult>;
}>;

export type OrganizerClientEnvironment = Readonly<Record<string, string | undefined>>;

export class OrganizerInvocationError extends Error {
  public constructor() {
    super("The encrypted organizer is unavailable.");
    this.name = "OrganizerInvocationError";
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

function parseDrainResult(value: unknown): OrganizerDrainResult {
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
    throw new OrganizerInvocationError();
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !boundedCount(record.claimed) ||
    !boundedCount(record.completed) ||
    !boundedCount(record.failed) ||
    !boundedCount(record.retryScheduled) ||
    record.completed + record.failed + record.retryScheduled > record.claimed
  ) {
    throw new OrganizerInvocationError();
  }
  return Object.freeze({
    claimed: record.claimed,
    completed: record.completed,
    failed: record.failed,
    retryScheduled: record.retryScheduled
  });
}

function organizerUrl(originValue: string): URL {
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

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OrganizerInvocationError());
    };
    const onAbort = (): void => rejectOnce();

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch {
      rejectOnce();
      return;
    }
    void pending.then(resolveOnce, rejectOnce);
  });
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
    if (response.body !== null) void response.body.cancel().catch(() => undefined);
    throw new OrganizerInvocationError();
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
        throw new OrganizerInvocationError();
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
    if (error instanceof OrganizerInvocationError) throw error;
    throw new OrganizerInvocationError();
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

export function createOrganizerClient(
  input: Readonly<{
    fetchImplementation?: typeof fetch;
    getOidcToken?: () => Promise<string>;
    origin: string;
    timeoutMs?: number;
  }>
): OrganizerClient {
  const url = organizerUrl(input.origin);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 55_000) {
    throw new ConfigurationError();
  }
  const request = input.fetchImplementation ?? fetch;
  const token = input.getOidcToken ?? getVercelOidcToken;

  return Object.freeze({
    async drain(trigger, externalSignal): Promise<OrganizerDrainResult> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal =
        externalSignal === undefined ? timeout : AbortSignal.any([externalSignal, timeout]);
      let response: Response;
      try {
        if (signal.aborted) throw new OrganizerInvocationError();
        const oidcToken = await abortable(token, signal);
        if (
          oidcToken.length < 32 ||
          oidcToken.length > 16_384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(oidcToken)
        ) {
          throw new OrganizerInvocationError();
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
        if (error instanceof OrganizerInvocationError) throw error;
        throw new OrganizerInvocationError();
      }
      return parseDrainResult(await boundedJson(response, signal));
    }
  });
}

export function createEnvironmentOrganizerClient(
  environment: OrganizerClientEnvironment = process.env,
  dependencies: Readonly<{
    fetchImplementation?: typeof fetch;
    getOidcToken?: () => Promise<string>;
  }> = {}
): OrganizerClient {
  const origin = environment.UNFILED_ORGANIZER_ORIGIN?.trim();
  const sourceProjectId = environment.VERCEL_PROJECT_ID?.trim();
  const runtime = environment.VERCEL_ENV?.trim();
  const targetRuntime = environment.UNFILED_ORGANIZER_ENV?.trim();
  if (
    environment.VERCEL !== "1" ||
    (runtime !== "preview" && runtime !== "production") ||
    targetRuntime !== runtime ||
    origin === undefined ||
    sourceProjectId === undefined ||
    !/^prj_[A-Za-z0-9]{6,100}$/u.test(sourceProjectId)
  ) {
    throw new ConfigurationError();
  }
  return createOrganizerClient({ ...dependencies, origin });
}

export const environmentOrganizerClient: OrganizerClient = Object.freeze({
  drain(trigger, signal) {
    return createEnvironmentOrganizerClient().drain(trigger, signal);
  }
});
