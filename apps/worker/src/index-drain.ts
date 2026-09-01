import {
  EncryptedAggregateError,
  EncryptedAggregateErrorCode,
  type SealedEncryptedAggregateRecord
} from "@unfiled/encrypted-aggregate";
import { KeyManagementError, KeyManagementErrorCode } from "@unfiled/key-management";
import {
  buildPrivateRagIndexDocument,
  createPrivateRagPayloadCodec,
  PrivateRagValidationError
} from "@unfiled/search";

import type { WorkerDrainPort } from "./drain.js";
import type { EmbeddingProvider, EmbeddingProviderErrorCode } from "./embedding-provider.js";
import { EmbeddingProviderError } from "./embedding-provider.js";
import type { IndexCryptoFactory } from "./index-crypto.js";
import type {
  ClaimedNoteIndexJob,
  CommitNoteRagIndexInput,
  NoteIndexRepository,
  SafeErrorCode
} from "./index-database.js";
import { prepareIndexText } from "./index-text.js";
import type { AiAssistedKeyAuthority } from "./key-management-adapter.js";
import { WorkerUnavailableError } from "./errors.js";

type JobOutcome = "abandoned" | "completed" | "failed" | "retryScheduled";

export type NoteIndexDrainOptions = Readonly<{
  claimLimit: number;
  concurrency: number;
  cryptoForAuthority(authority: AiAssistedKeyAuthority): IndexCryptoFactory;
  embedding: EmbeddingProvider;
  embeddingDimensions: number;
  embeddingMaxInputBytes: number;
  embeddingModelId: string;
  leaseSeconds: number;
  recoveryLimit: number;
  repository: NoteIndexRepository;
  workerId: string;
}>;

type SafeFailure = Readonly<{
  errorCode: SafeErrorCode;
  retryable: boolean;
}>;

const EMBEDDING_ERROR_CODES = new Set<EmbeddingProviderErrorCode>([
  "provider_key_invalid",
  "provider_unavailable",
  "rate_limited",
  "validation_failed"
]);

function signalActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof EmbeddingProviderError && EMBEDDING_ERROR_CODES.has(error.safeCode)) {
    return { errorCode: error.safeCode, retryable: error.retryable };
  }
  if (error instanceof KeyManagementError) {
    const retryable =
      error.code === KeyManagementErrorCode.KMS_UNAVAILABLE ||
      error.code === KeyManagementErrorCode.KEY_NOT_FOUND;
    return {
      errorCode: retryable ? "provider_unavailable" : "validation_failed",
      retryable
    };
  }
  if (error instanceof EncryptedAggregateError) {
    const retryable =
      error.code === EncryptedAggregateErrorCode.KEY_UNAVAILABLE ||
      error.code === EncryptedAggregateErrorCode.ENCRYPTION_FAILED ||
      error.code === EncryptedAggregateErrorCode.UNSUPPORTED_RUNTIME;
    return {
      errorCode: retryable ? "provider_unavailable" : "validation_failed",
      retryable
    };
  }
  if (error instanceof PrivateRagValidationError) {
    return { errorCode: "validation_failed", retryable: false };
  }
  return { errorCode: "provider_unavailable", retryable: true };
}

function retryDelaySeconds(attempt: number): number {
  return [5, 30, 120, 600, 600][Math.max(0, Math.min(4, attempt - 1))] ?? 600;
}

function ciphertextBytes(record: SealedEncryptedAggregateRecord<"note_rag_index">): number {
  const encoded = record.envelope.payload.ciphertext;
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Encrypted index payload is invalid.");
  }
  const bytes = Buffer.from(encoded, "base64url");
  try {
    if (
      bytes.toString("base64url") !== encoded ||
      bytes.byteLength < 16 ||
      bytes.byteLength > 262_160
    ) {
      throw new Error("Encrypted index payload is invalid.");
    }
    return bytes.byteLength;
  } finally {
    bytes.fill(0);
  }
}

async function exactRetryOnce<Result>(
  operation: () => Promise<Result>,
  signal: AbortSignal
): Promise<Result> {
  try {
    return await operation();
  } catch (firstError: unknown) {
    if (isAbort(firstError, signal)) throw firstError;
    signalActive(signal);
    return operation();
  }
}

async function transitionFailure(
  repository: NoteIndexRepository,
  job: ClaimedNoteIndexJob,
  failure: SafeFailure,
  signal: AbortSignal
): Promise<JobOutcome> {
  if (signal.aborted) return "abandoned";
  const input = Object.freeze({
    errorCode: failure.errorCode,
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    retryable: failure.retryable,
    retryDelaySeconds: retryDelaySeconds(job.attempt),
    signal
  });
  try {
    const result = await exactRetryOnce(() => repository.fail(input), signal);
    return result.state === "queued" ? "retryScheduled" : "failed";
  } catch {
    return "abandoned";
  }
}

async function processJob(
  input: Readonly<{
    crypto: IndexCryptoFactory;
    job: ClaimedNoteIndexJob;
    options: NoteIndexDrainOptions;
    signal: AbortSignal;
  }>
): Promise<JobOutcome> {
  const { job, options, signal } = input;
  let embedding: Float32Array | undefined;
  let phase:
    "opening" | "heartbeat_disclosure" | "provider" | "sealing" | "heartbeat_commit" | "commit" =
    "opening";
  try {
    signalActive(signal);
    if (
      job.embeddingModelId !== options.embeddingModelId ||
      job.embeddingDimensions !== options.embeddingDimensions
    ) {
      throw new EmbeddingProviderError("validation_failed", false);
    }
    const crypto = input.crypto.forJob(job);
    const note = await crypto.openNote();
    signalActive(signal);
    const text = prepareIndexText(note, options.embeddingMaxInputBytes);

    // ADR-0009 disclosure linearization point: no provider input exists before
    // this current-note/key/lease authorization succeeds.
    phase = "heartbeat_disclosure";
    await options.repository.heartbeat({
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      leaseSeconds: options.leaseSeconds,
      signal
    });
    signalActive(signal);
    phase = "provider";
    embedding = await options.embedding.embed({
      dimensions: job.embeddingDimensions,
      modelId: job.embeddingModelId,
      signal,
      text: text.providerText
    });
    signalActive(signal);
    if (embedding.length !== job.embeddingDimensions) {
      throw new EmbeddingProviderError("provider_unavailable", true);
    }
    for (const component of embedding) {
      if (!Number.isFinite(component)) {
        throw new EmbeddingProviderError("provider_unavailable", true);
      }
    }

    const payload = buildPrivateRagIndexDocument({
      embedding,
      headings: text.headings,
      indexedRevision: job.targetRevision,
      isOpen: job.isOpen,
      latestSnippet: text.latestSnippet,
      modelId: job.embeddingModelId,
      noteId: job.noteId,
      noteType: job.noteType,
      pinned: job.pinnedAt !== null,
      searchableText: text.searchableText,
      spaceId: job.spaceId,
      title: note.title,
      updatedAt: job.updatedAt
    });
    const codec = createPrivateRagPayloadCodec({
      dimensions: job.embeddingDimensions,
      indexedRevision: job.targetRevision,
      modelId: job.embeddingModelId,
      noteId: job.noteId
    });
    phase = "sealing";
    const sealed = await crypto.sealIndex(payload, codec);
    signalActive(signal);
    if (
      sealed.envelope.context.kind !== "note_rag_index" ||
      sealed.ownerId !== job.userId ||
      sealed.resourceId !== job.indexResourceId ||
      sealed.recordVersion !== job.targetRevision ||
      sealed.keyClass !== "ai_assisted" ||
      (sealed as Readonly<{ keyPurpose: string }>).keyPurpose !== "object_wrap" ||
      sealed.keyId !== job.reservation.keyId ||
      sealed.keyVersion !== job.reservation.keyVersion ||
      sealed.reservationId !== job.reservation.reservationId
    ) {
      throw new Error("Encrypted index context is invalid.");
    }
    const commitInput: CommitNoteRagIndexInput = Object.freeze({
      encryptedByteLength: ciphertextBytes(sealed),
      indexEnvelope: sealed.envelope as CommitNoteRagIndexInput["indexEnvelope"],
      indexId: sealed.resourceId,
      indexKeyClass: "ai_assisted",
      indexKeyId: sealed.keyId,
      indexKeyPurpose: "object_wrap",
      indexKeyVersion: sealed.keyVersion,
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      reservationId: sealed.reservationId,
      signal
    });

    // Revalidate after provider/KMS work and immediately before publication.
    phase = "heartbeat_commit";
    await options.repository.heartbeat({
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      leaseSeconds: options.leaseSeconds,
      signal
    });
    phase = "commit";
    signalActive(signal);
    const result = await exactRetryOnce(() => options.repository.commit(commitInput), signal);
    return result.committed ? "completed" : "failed";
  } catch (error: unknown) {
    if (isAbort(error, signal) || phase === "commit") return "abandoned";
    // A denied/ambiguous heartbeat must never be converted into a second state
    // transition; lease recovery is the sole owner of that uncertainty.
    if (phase === "heartbeat_disclosure" || phase === "heartbeat_commit") {
      return "abandoned";
    }
    return await transitionFailure(options.repository, job, safeFailure(error), signal);
  } finally {
    embedding?.fill(0);
  }
}

async function boundedOutcomes(
  jobs: readonly ClaimedNoteIndexJob[],
  concurrency: number,
  work: (job: ClaimedNoteIndexJob) => Promise<JobOutcome>
): Promise<readonly JobOutcome[]> {
  const outcomes = new Array<JobOutcome>(jobs.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (job !== undefined) outcomes[index] = await work(job);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, runner));
  return Object.freeze(outcomes);
}

export function createNoteIndexDrain(options: NoteIndexDrainOptions): WorkerDrainPort {
  let active = false;
  return Object.freeze({
    async drain({ authority, signal }): Promise<
      Readonly<{
        claimed: number;
        completed: number;
        failed: number;
        retryScheduled: number;
      }>
    > {
      if (active) throw new WorkerUnavailableError();
      active = true;
      try {
        signalActive(signal);
        await options.repository.preflight(signal);
        await options.repository.recoverStale(options.recoveryLimit, signal);
        const claim = await options.repository.claim({
          limit: options.claimLimit,
          leaseSeconds: options.leaseSeconds,
          signal,
          workerId: options.workerId
        });
        if (claim.jobs.length === 0) {
          return { claimed: 0, completed: 0, failed: 0, retryScheduled: 0 };
        }
        const crypto = options.cryptoForAuthority(authority);
        const outcomes = await boundedOutcomes(claim.jobs, options.concurrency, (job) =>
          processJob({ crypto, job, options, signal })
        );
        return Object.freeze({
          claimed: claim.jobs.length,
          completed: outcomes.filter((outcome) => outcome === "completed").length,
          failed: outcomes.filter((outcome) => outcome === "failed").length,
          retryScheduled: outcomes.filter((outcome) => outcome === "retryScheduled").length
        });
      } finally {
        active = false;
      }
    }
  });
}
