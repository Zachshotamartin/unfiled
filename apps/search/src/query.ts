import {
  EncryptedUserSearchMatchSchema,
  EncryptedUserSearchResultSchema,
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  encryptedUserSearchGenerationBindingDigest,
  encryptedUserSearchResultDigest,
  type EncryptedUserSearchInvocation,
  type EncryptedUserSearchMatch,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";
import {
  createPrivateRagRetriever,
  DEFAULT_PRIVATE_RAG_PAGE_BYTE_BUDGET,
  DEFAULT_PRIVATE_RAG_PAGE_SIZE,
  type PrivateRagGenerationSnapshot,
  type PrivateRagPageReadResult,
  type PrivateRagPayloadOpener
} from "@unfiled/search";

import type {
  ClaimedEncryptedUserSearch,
  EncryptedUserSearchRepository,
  SearchCandidateBinding,
  SearchFailureCode,
  SearchRagMetadata,
  SearchRagRecord
} from "./database.js";
import type { SearchEmbeddingProvider } from "./embedding-provider.js";
import { unavailable } from "./errors.js";
import type { SearchKeyAuthority } from "./key-management.js";
import { createSearchRagPayloadOpener, type SearchRagPayloadOpener } from "./rag-crypto.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GENERATION_ID_PREFIX_LENGTH = "igen_".length;
const ULID_TIMESTAMP_LENGTH = 10;
const MAX_ULID_TIMESTAMP = 2 ** 48 - 1;

type BoundIndex = Readonly<{
  candidate: SearchCandidateBinding;
  metadata: SearchRagMetadata;
}>;

type SearchQueryPayloadOpener = PrivateRagPayloadOpener<SearchRagRecord> &
  Partial<Pick<SearchRagPayloadOpener, "release">>;

export type SearchQueryPort = Readonly<{
  query(
    input: Readonly<{
      authority: SearchKeyAuthority;
      invocation: EncryptedUserSearchInvocation;
      signal: AbortSignal;
    }>
  ): Promise<EncryptedUserSearchResult>;
}>;

function sameSnapshot(
  left: PrivateRagGenerationSnapshot,
  right: PrivateRagGenerationSnapshot
): boolean {
  return (
    left.generationId === right.generationId &&
    left.revisionToken === right.revisionToken &&
    left.modelId === right.modelId &&
    left.dimensions === right.dimensions &&
    left.expectedNoteCount === right.expectedNoteCount &&
    left.indexedNoteCount === right.indexedNoteCount
  );
}

function metadataMatchesFilter(
  metadata: SearchRagMetadata,
  filters: EncryptedUserSearchInvocation["material"]["filters"]
): boolean {
  const archived = metadata.archivedAt !== null;
  if (
    (filters.archive === "exclude" && archived) ||
    (filters.archive === "only" && !archived) ||
    (filters.type !== null && metadata.type !== filters.type) ||
    (filters.space.mode === "root" && metadata.spaceId !== null) ||
    (filters.space.mode === "exact" && metadata.spaceId !== filters.space.id) ||
    (filters.updatedFrom !== null &&
      Date.parse(metadata.updatedAt) < Date.parse(filters.updatedFrom)) ||
    (filters.updatedTo !== null &&
      Date.parse(metadata.updatedAt) >= Date.parse(filters.updatedTo)) ||
    filters.tagIds.some((tagId) => !metadata.tagIds.includes(tagId))
  ) {
    return false;
  }
  return true;
}

function claimSnapshot(
  claim: ClaimedEncryptedUserSearch,
  page: PrivateRagGenerationSnapshot
): boolean {
  return (
    page.generationId === claim.generation.generationId &&
    page.revisionToken === claim.generation.revisionToken &&
    page.modelId === claim.generation.embeddingModelId &&
    page.dimensions === claim.generation.embeddingDimensions
  );
}

function sameSemanticBoundary(
  left: EncryptedUserSearchMatch | null,
  right: EncryptedUserSearchMatch | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.noteId === right.noteId &&
    left.indexedRevision === right.indexedRevision &&
    left.score === right.score
  );
}

function generationRankingTime(generationId: string): number {
  const timestamp = generationId.slice(
    GENERATION_ID_PREFIX_LENGTH,
    GENERATION_ID_PREFIX_LENGTH + ULID_TIMESTAMP_LENGTH
  );
  if (timestamp.length !== ULID_TIMESTAMP_LENGTH) throw new TypeError("invalid generation time");
  let value = 0;
  for (const character of timestamp) {
    const digit = CROCKFORD_BASE32.indexOf(character);
    if (digit < 0) throw new TypeError("invalid generation time");
    value = value * 32 + digit;
  }
  if (!Number.isSafeInteger(value) || value > MAX_ULID_TIMESTAMP) {
    throw new TypeError("invalid generation time");
  }
  return value;
}

function failureCode(error: unknown): SearchFailureCode {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "rate_limited" || error.code === "validation_failed")
  ) {
    return error.code;
  }
  return "provider_unavailable";
}

async function bestEffortFail(
  repository: EncryptedUserSearchRepository,
  claim: ClaimedEncryptedUserSearch,
  error: unknown
): Promise<void> {
  try {
    await repository.fail({
      claim,
      failureCode: failureCode(error),
      signal: AbortSignal.timeout(1_500)
    });
  } catch {
    // The original redacted failure is retained; cleanup cannot widen it.
  }
}

export function createEncryptedUserSearchQuery(
  input: Readonly<{
    embeddingProvider: SearchEmbeddingProvider;
    payloadsForAuthority?: (authority: SearchKeyAuthority) => SearchQueryPayloadOpener;
    repository: EncryptedUserSearchRepository;
  }>
): SearchQueryPort {
  return Object.freeze({
    async query(request): Promise<EncryptedUserSearchResult> {
      const { invocation, signal } = request;
      let claim: ClaimedEncryptedUserSearch | undefined;
      let completed = false;
      let queryEmbedding: Float32Array | undefined;
      let retriever: ReturnType<typeof createPrivateRagRetriever<SearchRagRecord>> | undefined;
      let payloads: SearchQueryPayloadOpener | undefined;
      try {
        claim = await input.repository.claim({
          searchId: invocation.searchId,
          claimSecret: invocation.claimSecret,
          requestDigest: invocation.requestDigest,
          signal
        });
        const activeClaim = claim;
        if (signal.aborted || Date.parse(activeClaim.leaseExpiresAt) <= Date.now()) {
          return unavailable();
        }

        queryEmbedding = await input.embeddingProvider.embed({
          signal,
          text: invocation.material.query
        });
        const boundIndexes = new Map<string, BoundIndex>();
        payloads =
          input.payloadsForAuthority?.(request.authority) ??
          createSearchRagPayloadOpener(request.authority);

        const pages = Object.freeze({
          async readPage(
            pageInput: Readonly<{
              cursor: string | null;
              expectedSnapshot: Readonly<{
                generationId: string;
                revisionToken: string;
              }> | null;
              limit: number;
              maxBytes: number;
              ownerId: string;
              signal?: AbortSignal;
            }>
          ): Promise<PrivateRagPageReadResult<SearchRagRecord>> {
            if (
              pageInput.ownerId !== activeClaim.ownerId ||
              (pageInput.cursor === null && pageInput.expectedSnapshot !== null) ||
              (pageInput.cursor !== null &&
                (pageInput.expectedSnapshot?.generationId !== activeClaim.generation.generationId ||
                  pageInput.expectedSnapshot.revisionToken !==
                    activeClaim.generation.revisionToken))
            ) {
              return unavailable();
            }
            const result = await input.repository.page({
              claim: activeClaim,
              filterManifest: invocation.material.filters,
              cursor: pageInput.cursor,
              limit: pageInput.limit,
              maxBytes: pageInput.maxBytes,
              signal: pageInput.signal ?? signal
            });
            if (result.status !== "page" || !claimSnapshot(activeClaim, result.page.snapshot)) {
              return unavailable();
            }
            for (const item of result.page.items) {
              if (boundIndexes.has(item.noteId)) return unavailable();
              boundIndexes.set(
                item.noteId,
                Object.freeze({
                  candidate: Object.freeze({
                    indexId: item.indexId,
                    noteId: item.noteId,
                    indexedRevision: item.indexedRevision
                  }),
                  metadata: item.record.metadata
                })
              );
            }
            return result;
          },
          async verifySnapshot(
            snapshotInput: Readonly<{
              ownerId: string;
              signal?: AbortSignal;
              snapshot: PrivateRagGenerationSnapshot;
            }>
          ): Promise<boolean> {
            if (
              snapshotInput.ownerId !== activeClaim.ownerId ||
              !claimSnapshot(activeClaim, snapshotInput.snapshot)
            ) {
              return false;
            }
            try {
              const current = await input.repository.page({
                claim: activeClaim,
                filterManifest: invocation.material.filters,
                cursor: null,
                limit: DEFAULT_PRIVATE_RAG_PAGE_SIZE,
                maxBytes: DEFAULT_PRIVATE_RAG_PAGE_BYTE_BUDGET,
                signal: snapshotInput.signal ?? signal
              });
              return (
                current.status === "page" &&
                current.page.coverage.status === "complete" &&
                sameSnapshot(current.page.snapshot, snapshotInput.snapshot)
              );
            } catch {
              return false;
            }
          }
        });

        retriever = createPrivateRagRetriever<SearchRagRecord>({
          cacheMaxBytes: 0,
          pages,
          payloads,
          topK: invocation.material.maxResults,
          now: () => generationRankingTime(activeClaim.generation.generationId)
        });
        const retrieval = await retriever.retrieve({
          ownerId: activeClaim.ownerId,
          query: {
            embedding: queryEmbedding,
            modelId: activeClaim.generation.embeddingModelId,
            text: invocation.material.query
          },
          signal
        });
        if (retrieval.status !== "complete" || !claimSnapshot(activeClaim, retrieval.snapshot)) {
          return unavailable();
        }

        const candidates: SearchCandidateBinding[] = [];
        const items = retrieval.matches.map((match) => {
          const bound = boundIndexes.get(match.noteId);
          if (bound === undefined) return unavailable();
          if (
            bound.candidate.indexedRevision !== match.indexedRevision ||
            bound.metadata.type !== match.noteType ||
            bound.metadata.spaceId !== match.spaceId ||
            bound.metadata.updatedAt !== match.updatedAt ||
            (bound.metadata.pinnedAt !== null) !== match.pinned ||
            !metadataMatchesFilter(bound.metadata, invocation.material.filters)
          ) {
            return unavailable();
          }
          candidates.push(bound.candidate);
          return Object.freeze(
            EncryptedUserSearchMatchSchema.parse({
              noteId: match.noteId,
              indexedRevision: match.indexedRevision,
              score: match.score
            })
          );
        });
        const generationBindingDigest = await encryptedUserSearchGenerationBindingDigest({
          generationId: activeClaim.generation.generationId,
          generationRevisionToken: activeClaim.generation.revisionToken,
          generationAttestationDigest: activeClaim.generation.attestationDigest
        });
        const resultDigest = await encryptedUserSearchResultDigest({
          generationBindingDigest,
          rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
          items
        });
        const continuation = invocation.material.continuation;
        const boundary = items.at(-1) ?? null;
        const continuationRankingVersion: unknown = continuation?.rankingVersion;
        if (
          continuation !== null &&
          (continuation.generationBindingDigest !== generationBindingDigest ||
            continuationRankingVersion !== USER_SEMANTIC_SEARCH_RANKING_VERSION ||
            continuation.resultDigest !== resultDigest ||
            !sameSemanticBoundary(continuation.boundary, boundary))
        ) {
          return unavailable();
        }
        const verified = await input.repository.verify({
          claim: activeClaim,
          filterManifest: invocation.material.filters,
          candidates: Object.freeze(candidates),
          signal
        });
        if (verified.verifiedCandidateCount !== candidates.length) return unavailable();
        const result = EncryptedUserSearchResultSchema.parse({
          searchId: activeClaim.searchId,
          generationId: activeClaim.generation.generationId,
          generationAttestationDigest: activeClaim.generation.attestationDigest,
          generationRevisionToken: activeClaim.generation.revisionToken,
          rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
          items,
          scannedNoteCount: retrieval.scannedNoteCount
        });
        await input.repository.complete({
          claim: activeClaim,
          candidateDigest: verified.candidateDigest,
          signal
        });
        completed = true;
        return result;
      } catch (error: unknown) {
        if (claim !== undefined && !completed) await bestEffortFail(input.repository, claim, error);
        return unavailable();
      } finally {
        queryEmbedding?.fill(0);
        retriever?.clearCache();
        payloads?.release?.();
      }
    }
  });
}
