import {
  RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS,
  RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
} from "@unfiled/contracts";

import {
  RAG_VERIFICATION_MAX_PAGES,
  RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET,
  RAG_VERIFICATION_PAGE_LIMIT
} from "./capacity.js";
import type {
  BuildingGeneration,
  BuildingGenerationCursor,
  BuildingIndexItem,
  GenerationTarget,
  GenerationVerificationAttestation,
  GenerationVerificationRepository
} from "./database.js";
import { GenerationVerificationError, VerifierUnavailableError } from "./errors.js";
import { createStrictIndexDocumentOpener, type StrictIndexDocumentOpener } from "./index-crypto.js";
import type { VerifierKeySession } from "./kms.js";

export type VerifyGenerationResult = Readonly<{
  generationId: string;
  revisionToken: string;
  verified: true;
  verifiedNoteCount: number;
}>;

export type GenerationVerifier = Readonly<{
  verify(
    target: GenerationTarget,
    keys: VerifierKeySession,
    signal: AbortSignal
  ): Promise<VerifyGenerationResult>;
}>;

export type GenerationVerifierOptions = Readonly<{
  decryptConcurrency: number;
  opener?: StrictIndexDocumentOpener;
  repository: GenerationVerificationRepository;
}>;

function sameGeneration(left: BuildingGeneration, right: BuildingGeneration): boolean {
  return (
    left.generationId === right.generationId &&
    left.embeddingModelId === right.embeddingModelId &&
    left.embeddingDimensions === right.embeddingDimensions &&
    left.expectedNoteCount === right.expectedNoteCount &&
    left.indexedNoteCount === right.indexedNoteCount &&
    left.revisionToken === right.revisionToken
  );
}

async function openBatch(
  batch: readonly BuildingIndexItem[],
  input: Readonly<{
    generation: BuildingGeneration;
    keys: VerifierKeySession;
    opener: StrictIndexDocumentOpener;
    ownerId: string;
    signal: AbortSignal;
  }>
): Promise<void> {
  const settled = await Promise.allSettled(
    batch.map((item) =>
      input.opener.validate(input.ownerId, input.generation, item, input.keys, input.signal)
    )
  );
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure !== undefined) {
    throw failure.reason;
  }
}

export function createGenerationVerifier(options: GenerationVerifierOptions): GenerationVerifier {
  const opener = options.opener ?? createStrictIndexDocumentOpener();
  if (
    !Number.isSafeInteger(options.decryptConcurrency) ||
    options.decryptConcurrency < 1 ||
    options.decryptConcurrency > 8
  ) {
    throw new GenerationVerificationError();
  }

  return Object.freeze({
    async verify(target, keys, signal): Promise<VerifyGenerationResult> {
      if (signal.aborted) throw new VerifierUnavailableError();
      const identityProof = await options.repository.preflight(signal);
      try {
        let cursor: BuildingGenerationCursor | null = null;
        let generation: BuildingGeneration | undefined;
        let attestation: GenerationVerificationAttestation | undefined;
        let verifiedCount = 0;
        let lastIndexId: string | undefined;
        const noteIds = new Set<string>();
        const keyRecords = new Set<string>();

        for (let pageNumber = 0; pageNumber < RAG_VERIFICATION_MAX_PAGES; pageNumber += 1) {
          const page = await options.repository.readBuildingPage(
            {
              ...target,
              cursor,
              limit: RAG_VERIFICATION_PAGE_LIMIT,
              ciphertextByteBudget: RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET,
              signal
            },
            identityProof
          );
          if (generation === undefined) {
            generation = page.generation;
            if (
              generation.expectedNoteCount !== generation.indexedNoteCount ||
              generation.expectedNoteCount > RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
            ) {
              throw new GenerationVerificationError();
            }
          } else if (!sameGeneration(generation, page.generation)) {
            throw new GenerationVerificationError();
          }

          if (
            page.page.hasMore !== (page.page.nextCursor !== null) ||
            (page.page.hasMore && page.verification !== null) ||
            (!page.page.hasMore && page.verification === null)
          ) {
            throw new GenerationVerificationError();
          }
          if (page.verification !== null) attestation = page.verification;

          for (const item of page.items) {
            if (
              (lastIndexId !== undefined && item.indexId <= lastIndexId) ||
              noteIds.has(item.noteId)
            ) {
              throw new GenerationVerificationError();
            }
            lastIndexId = item.indexId;
            noteIds.add(item.noteId);
            keyRecords.add(`${item.keyRecord.keyId}:${item.keyRecord.keyVersion}`);
            if (keyRecords.size > RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS) {
              throw new GenerationVerificationError();
            }
          }
          for (let offset = 0; offset < page.items.length; offset += options.decryptConcurrency) {
            await openBatch(page.items.slice(offset, offset + options.decryptConcurrency), {
              generation,
              keys,
              opener,
              ownerId: target.ownerId,
              signal
            });
          }
          verifiedCount += page.items.length;
          if (verifiedCount > generation.expectedNoteCount) {
            throw new GenerationVerificationError();
          }
          cursor = page.page.nextCursor;
          if (cursor === null) break;
          if (pageNumber === RAG_VERIFICATION_MAX_PAGES - 1) {
            throw new GenerationVerificationError();
          }
        }

        if (generation === undefined || attestation === undefined) {
          throw new GenerationVerificationError();
        }
        if (verifiedCount !== generation.expectedNoteCount || noteIds.size !== verifiedCount) {
          throw new GenerationVerificationError();
        }
        const verified = await options.repository.attest(
          {
            ...target,
            signal,
            verification: attestation
          },
          identityProof
        );
        if (
          verified.generationId !== generation.generationId ||
          verified.revisionToken !== generation.revisionToken ||
          verified.verifiedNoteCount !== verifiedCount ||
          verified.attestationDigest !== attestation.attestationDigest ||
          verified.embeddingModelId !== generation.embeddingModelId ||
          verified.embeddingDimensions !== generation.embeddingDimensions
        ) {
          throw new GenerationVerificationError();
        }
        return Object.freeze({
          generationId: verified.generationId,
          revisionToken: verified.revisionToken,
          verified: true,
          verifiedNoteCount: verified.verifiedNoteCount
        });
      } finally {
        options.repository.release(identityProof);
      }
    }
  });
}
