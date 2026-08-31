import { ApiClientError } from "@unfiled/api-client";
import type { CaptureDeleteRequest, CaptureDeleteResponse } from "@unfiled/contracts";

import type { CaptureDeleteIntent } from "./captureActionIntents";

const MAXIMUM_DELETE_BATCH_SIZE = 10;

export type CaptureDeleteExecution =
  "cancelled" | "completed" | "retry_later" | "waiting_for_sign_in";

export interface CaptureDeleteIntentStore {
  cancel: (intent: CaptureDeleteIntent) => Promise<void>;
  complete: (intent: CaptureDeleteIntent) => Promise<void>;
  list: (profileId: string) => Promise<readonly CaptureDeleteIntent[]>;
}

export interface ExecuteCaptureDeleteIntentOptions {
  intent: CaptureDeleteIntent;
  send: (captureId: string, request: CaptureDeleteRequest) => Promise<CaptureDeleteResponse>;
  store: CaptureDeleteIntentStore;
}

function retryable(error: ApiClientError): boolean {
  return (
    error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
  );
}

export async function executeCaptureDeleteIntent({
  intent,
  send,
  store
}: ExecuteCaptureDeleteIntentOptions): Promise<CaptureDeleteExecution> {
  try {
    await send(intent.captureId, intent.request);
    await store.complete(intent);
    return "completed";
  } catch (error) {
    if (!(error instanceof ApiClientError)) return "retry_later";
    if (error.status === 401) return "waiting_for_sign_in";
    if (error.status === 404) {
      // The user requested removal and the authoritative source is already absent.
      // This also closes the safe recovery path after an idempotency record expires.
      await store.complete(intent);
      return "completed";
    }
    if (retryable(error)) return "retry_later";
    await store.cancel(intent);
    return "cancelled";
  }
}

export async function drainCaptureDeleteIntents(options: {
  maximumBatchSize?: number;
  profileId: string;
  send: (captureId: string, request: CaptureDeleteRequest) => Promise<CaptureDeleteResponse>;
  store: CaptureDeleteIntentStore;
}): Promise<Readonly<{ completed: number; retained: number }>> {
  const intents = await options.store.list(options.profileId);
  let completed = 0;
  let retained = 0;
  for (const intent of intents.slice(0, options.maximumBatchSize ?? MAXIMUM_DELETE_BATCH_SIZE)) {
    const result = await executeCaptureDeleteIntent({
      intent,
      send: options.send,
      store: options.store
    });
    if (result === "completed") completed += 1;
    else retained += 1;
    if (result === "waiting_for_sign_in") break;
  }
  return { completed, retained };
}
