import { ApiErrorCode } from "@unfiled/contracts";

import { ConfigurationError, HttpError } from "@/server/api/errors";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

export type NoteRetentionResult = Readonly<{
  cutoff: string;
  eligibleCount: number;
  executed: boolean;
  purgedCount: number;
  runAt: string;
}>;

export type NoteRetentionRequest = Readonly<{
  batchSize?: number;
  execute?: boolean;
  now?: Date;
  ownerId?: string | null;
}>;

type RetentionConfiguration = Readonly<{
  serviceRoleKey: string;
  url: string;
}>;

function configuration(): RetentionConfiguration {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url === undefined || serviceRoleKey === undefined) throw new ConfigurationError();
  return { serviceRoleKey, url: url.replace(/\/$/u, "") };
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function retentionResult(value: unknown): NoteRetentionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The retention service returned an invalid response."
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.cutoff !== "string" ||
    typeof record.runAt !== "string" ||
    typeof record.executed !== "boolean" ||
    !nonNegativeInteger(record.eligibleCount) ||
    !nonNegativeInteger(record.purgedCount) ||
    Number.isNaN(Date.parse(record.cutoff)) ||
    Number.isNaN(Date.parse(record.runAt))
  ) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The retention service returned an invalid response."
    );
  }
  return {
    cutoff: record.cutoff,
    eligibleCount: record.eligibleCount,
    executed: record.executed,
    purgedCount: record.purgedCount,
    runAt: record.runAt
  };
}

/**
 * Runs one bounded retention batch. It is deliberately dry-run by default;
 * a scheduler must opt into the destructive path on every invocation.
 */
export async function runNoteRetentionBatch(
  input: NoteRetentionRequest = {},
  fetcher: typeof fetch = fetch
): Promise<NoteRetentionResult> {
  const config = configuration();
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = input.now ?? new Date();
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_BATCH_SIZE ||
    Number.isNaN(now.getTime())
  ) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "The retention batch configuration is invalid."
    );
  }

  const response = await fetcher(`${config.url}/rest/v1/rpc/purge_expired_deleted_notes`, {
    method: "POST",
    cache: "no-store",
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      p_batch_size: batchSize,
      p_execute: input.execute === true,
      p_now: now.toISOString(),
      p_owner_id: input.ownerId ?? null
    })
  });
  if (!response.ok) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The retention service could not complete this batch."
    );
  }
  return retentionResult(await response.json().catch(() => null));
}
