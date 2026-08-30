import { timingSafeEqual } from "node:crypto";

import { ApiErrorCode } from "@unfiled/contracts";

import { errorResponse, HttpError, jsonResponse } from "@/server/api/errors";

import {
  runNoteRetentionBatch,
  type NoteRetentionRequest,
  type NoteRetentionResult
} from "./note-retention";

const BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 20;

type RetentionRunner = (input: NoteRetentionRequest) => Promise<NoteRetentionResult>;

export type NoteRetentionHandlerDependencies = Readonly<{
  executionEnabled?: () => boolean;
  getSecret?: () => string | undefined;
  now?: () => Date;
  runBatch?: RetentionRunner;
}>;

function authorized(request: Request, secret: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const providedBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export function createNoteRetentionHandler(
  dependencies: NoteRetentionHandlerDependencies = {}
): (request: Request) => Promise<Response> {
  const executionEnabled =
    dependencies.executionEnabled ??
    (() => process.env.NOTE_RETENTION_EXECUTION_ENABLED === "true");
  const getSecret = dependencies.getSecret ?? (() => process.env.CRON_SECRET);
  const now = dependencies.now ?? (() => new Date());
  const runBatch = dependencies.runBatch ?? ((input) => runNoteRetentionBatch(input));

  return async (request: Request): Promise<Response> => {
    try {
      const secret = getSecret();
      if (secret === undefined || secret.length < 32) {
        throw new HttpError(
          503,
          ApiErrorCode.PROVIDER_UNAVAILABLE,
          "The retention schedule is not configured."
        );
      }
      if (!authorized(request, secret)) {
        throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "This scheduled request is not valid.");
      }

      const runAt = now();
      const inspectOnly = new URL(request.url).searchParams.get("dryRun") === "true";
      const execute = executionEnabled() && !inspectOnly;
      let batches = 0;
      let eligibleCount = 0;
      let purgedCount = 0;
      let batchLimitReached = false;

      do {
        const result = await runBatch({
          batchSize: BATCH_SIZE,
          execute,
          now: runAt,
          ownerId: null
        });
        if (result.executed !== execute) {
          throw new HttpError(
            503,
            ApiErrorCode.PROVIDER_UNAVAILABLE,
            "The retention service did not honor the requested mode."
          );
        }
        batches += 1;
        eligibleCount += result.eligibleCount;
        purgedCount += result.purgedCount;

        if (!execute || result.purgedCount < BATCH_SIZE) break;
        batchLimitReached = batches >= MAX_BATCHES_PER_RUN;
      } while (!batchLimitReached);

      return jsonResponse(
        {
          batchLimitReached,
          batches,
          dryRun: !execute,
          eligibleCount,
          executionEnabled: execute,
          purgedCount,
          runAt: runAt.toISOString()
        },
        { status: 200, headers: { "cache-control": "no-store" } }
      );
    } catch (error) {
      return errorResponse(error, request);
    }
  };
}

export const noteRetentionHandler = createNoteRetentionHandler();
