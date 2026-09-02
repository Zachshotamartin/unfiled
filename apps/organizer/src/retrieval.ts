import { AsyncLocalStorage } from "node:async_hooks";

import type { RoutingSignalFeatures } from "@unfiled/ai-routing";
import {
  createPrivateRagRetriever,
  DEFAULT_PRIVATE_RAG_CACHE_BYTE_BUDGET,
  DEFAULT_PRIVATE_RAG_PAGE_BYTE_BUDGET,
  DEFAULT_PRIVATE_RAG_PAGE_SIZE,
  normalizePrivateRagText,
  PRIVATE_RAG_CACHE_TTL_MS,
  type PrivateRagGenerationSnapshot,
  type PrivateRagMatch,
  type PrivateRagPageReadResult,
  type PrivateRagPayloadOpener
} from "@unfiled/search";

import type {
  ClaimedOrganizerJob,
  EncryptedCandidate,
  OrganizerCandidatePage,
  OrganizerCandidateRetrievalPort,
  OrganizerRagRecord,
  OrganizerRepository,
  OrganizerRoutingPolicyContext
} from "./drain.js";
import type { OrganizerEmbeddingProvider } from "./embedding-provider.js";
import { OrganizerProviderError, OrganizerUnavailableError } from "./errors.js";
import type { OrganizerKeyAuthority } from "./key-management.js";
import { organizerLocalDate } from "./local-date.js";
import {
  inferOrganizerCaptureKind,
  resolveDeterministicDestination,
  type DecryptedCapture
} from "./planner.js";
import { createOrganizerRagPayloadOpener } from "./rag-crypto.js";

const CANDIDATE_LIMIT = 8;
const ECONOMICAL_CANDIDATE_LIMIT = 6;
const MAX_TRACKED_CACHE_OWNERS = 512;
const MINIMUM_SEMANTIC_MATCH = 0.8;
const MINIMUM_TRIGRAM_MATCH = 0.5;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "from",
  "have",
  "into",
  "note",
  "that",
  "the",
  "then",
  "this",
  "with"
]);
const ZERO_FEATURES: RoutingSignalFeatures = Object.freeze({
  destinationRecency: 0,
  duplicateTitleSuspicion: 0,
  explicitDestinationMention: 0,
  margin: 0,
  openSameDayTypeMatch: 0,
  priorAccepted: 0,
  reasonCodeConsistency: 0,
  ruleOrAliasNearMatch: 0,
  semanticSimilarity: 0,
  typeCompatibility: 0
});

interface ActiveRetrieval {
  active: boolean;
  expectedSnapshot: PrivateRagGenerationSnapshot;
  first: PrivateRagPageReadResult<OrganizerRagRecord> | undefined;
  jobId: string;
  leaseToken: string;
  ownerId: string;
  payloads: PrivateRagPayloadOpener<OrganizerRagRecord> | undefined;
  signal: AbortSignal;
}

export type OrganizerCandidateRetrieval = OrganizerCandidateRetrievalPort &
  Readonly<{
    cacheStats(): Readonly<{ bytes: number; entries: number; maxBytes: number }>;
    clearCache(): void;
    close(): void;
  }>;

function sameSnapshot(
  left: PrivateRagGenerationSnapshot,
  right: PrivateRagGenerationSnapshot
): boolean {
  return (
    left.dimensions === right.dimensions &&
    left.expectedNoteCount === right.expectedNoteCount &&
    left.generationId === right.generationId &&
    left.indexedNoteCount === right.indexedNoteCount &&
    left.modelId === right.modelId &&
    left.revisionToken === right.revisionToken
  );
}

function compatibleType(
  capture: DecryptedCapture,
  noteType: EncryptedCandidate["noteType"]
): number {
  const kind = inferOrganizerCaptureKind(capture.rawContent);
  if (kind === "list_items") return noteType === "list" ? 1 : 0;
  if (kind === "log_entry") return noteType === "log" ? 1 : 0;
  if (kind === "project_update") return noteType === "project" ? 1 : 0;
  if (kind === "principle") return noteType === "principle" ? 1 : 0;
  return noteType === "generic" ? 1 : 0.25;
}

function candidateLimit(job: ClaimedOrganizerJob): number {
  return job.routingEffort === "economical" ? ECONOMICAL_CANDIDATE_LIMIT : CANDIDATE_LIMIT;
}

function meaningfulTokens(value: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const match of normalizePrivateRagText(value).matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (token.length >= 4 && !STOP_WORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

function titleAliasSignal(captureText: string, title: string): number {
  const captureTokens = meaningfulTokens(captureText);
  if (captureTokens.size === 0) return 0;
  const titleTokens = meaningfulTokens(title);
  for (const token of titleTokens) if (captureTokens.has(token)) return 1;
  return 0;
}

function featureFor(
  candidate: EncryptedCandidate,
  match: PrivateRagMatch,
  allMatches: readonly PrivateRagMatch[],
  capture: DecryptedCapture,
  job: ClaimedOrganizerJob,
  deterministicDestinationCandidateId: `note_${string}` | null
): RoutingSignalFeatures {
  const isDeterministicDestination = candidate.candidateId === deterministicDestinationCandidateId;
  const typeCompatibility = compatibleType(capture, candidate.noteType);
  const occurredDate = organizerLocalDate(job.occurredAt, job.clientTimezone);
  const sameDay = occurredDate !== null && candidate.dailyDate === occurredDate;
  const sameTitleCount = allMatches.filter(
    ({ title }) => normalizePrivateRagText(title) === normalizePrivateRagText(match.title)
  ).length;
  const best = allMatches[0];
  const runnerUp = allMatches[1];
  const margin = isDeterministicDestination
    ? 1
    : best?.noteId === match.noteId
      ? Math.max(0, Math.min(1, best.score - (runnerUp?.score ?? 0)))
      : 0;
  return Object.freeze({
    destinationRecency: match.signals.recency,
    duplicateTitleSuspicion: sameTitleCount > 1 ? 1 : 0,
    explicitDestinationMention: isDeterministicDestination ? 1 : 0,
    margin,
    openSameDayTypeMatch: candidate.isOpen && sameDay && typeCompatibility === 1 ? 1 : 0,
    priorAccepted: 0,
    reasonCodeConsistency: isDeterministicDestination ? 1 : 0,
    ruleOrAliasNearMatch: isDeterministicDestination
      ? 1
      : Math.max(
          match.signals.fullText,
          match.signals.titleExact,
          match.signals.trigram,
          titleAliasSignal(capture.rawContent, match.title)
        ),
    semanticSimilarity: match.signals.vector ?? 0,
    typeCompatibility
  });
}

function explicitFallbackFeatures(
  candidate: EncryptedCandidate,
  capture: DecryptedCapture,
  job: ClaimedOrganizerJob
): RoutingSignalFeatures {
  if (capture.controls.explicitDestinationNoteId !== candidate.noteId) return ZERO_FEATURES;
  const typeCompatibility = compatibleType(capture, candidate.noteType);
  const occurredDate = organizerLocalDate(job.occurredAt, job.clientTimezone);
  return Object.freeze({
    destinationRecency: 1,
    duplicateTitleSuspicion: 0,
    explicitDestinationMention: 1,
    margin: 1,
    openSameDayTypeMatch:
      candidate.isOpen &&
      occurredDate !== null &&
      candidate.dailyDate === occurredDate &&
      typeCompatibility === 1
        ? 1
        : 0,
    priorAccepted: 0,
    reasonCodeConsistency: 1,
    ruleOrAliasNearMatch: 1,
    semanticSimilarity: 0,
    typeCompatibility
  });
}

function context(
  job: ClaimedOrganizerJob,
  candidates: readonly EncryptedCandidate[],
  capture: DecryptedCapture,
  matches: readonly PrivateRagMatch[] | null
): OrganizerRoutingPolicyContext {
  const deterministicDestination = resolveDeterministicDestination({
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      isOpen: candidate.isOpen,
      noteId: candidate.noteId,
      title: matches?.find(({ noteId }) => noteId === candidate.noteId)?.title ?? ""
    })),
    capture
  });
  const candidateFeatures = Object.freeze(
    candidates.map((candidate) => {
      const match = matches?.find(({ noteId }) => noteId === candidate.noteId);
      return Object.freeze({
        candidateId: candidate.candidateId,
        features:
          match === undefined
            ? explicitFallbackFeatures(candidate, capture, job)
            : featureFor(
                candidate,
                match,
                matches ?? [],
                capture,
                job,
                deterministicDestination?.candidateId ?? null
              )
      });
    })
  );
  const selectedFeatures =
    deterministicDestination === null
      ? undefined
      : candidateFeatures.find(
          ({ candidateId }) => candidateId === deterministicDestination.candidateId
        )?.features;
  return Object.freeze({
    accountCaptureOrdinal: job.accountCaptureOrdinal,
    candidateFeatures,
    deterministicRuleMatch:
      (capture.controls.explicitDestinationNoteId === null &&
        capture.controls.ruleMatch !== null) ||
      deterministicDestination !== null,
    features: selectedFeatures ?? candidateFeatures[0]?.features ?? ZERO_FEATURES,
    mode: job.routingMode,
    retrievalAutoEligible: matches !== null
  });
}

function hasUsableRetrievalEvidence(match: PrivateRagMatch): boolean {
  return (
    match.isOpen &&
    (match.signals.titleExact === 1 ||
      match.signals.fullText > 0 ||
      match.signals.trigram >= MINIMUM_TRIGRAM_MATCH ||
      (match.signals.vector ?? 0) >= MINIMUM_SEMANTIC_MATCH)
  );
}

function assertSelectedBindings(
  candidates: readonly EncryptedCandidate[],
  matches: readonly PrivateRagMatch[]
): void {
  if (
    candidates.length !== matches.length ||
    candidates.some((candidate, index) => {
      const match = matches[index];
      return (
        candidate.noteId !== match?.noteId ||
        candidate.revision !== match.indexedRevision ||
        candidate.noteType !== match.noteType ||
        candidate.isOpen !== match.isOpen ||
        candidate.spaceId !== match.spaceId ||
        candidate.updatedAt !== match.updatedAt ||
        (candidate.pinnedAt !== null) !== match.pinned
      );
    })
  ) {
    throw new OrganizerUnavailableError();
  }
}

export function createOrganizerCandidateRetrieval(
  options: Readonly<{
    embeddingProvider: OrganizerEmbeddingProvider;
    payloadsForAuthority?: (
      authority: OrganizerKeyAuthority
    ) => PrivateRagPayloadOpener<OrganizerRagRecord>;
    repository: OrganizerRepository;
  }>
): OrganizerCandidateRetrieval {
  const activeRetrieval = new AsyncLocalStorage<ActiveRetrieval>();
  let closed = false;
  const active = (): ActiveRetrieval => {
    const current = activeRetrieval.getStore();
    if (current === undefined || !current.active || current.signal.aborted) {
      throw new OrganizerUnavailableError();
    }
    return current;
  };
  const pages = {
    async readPage(
      pageInput: Readonly<{
        cursor: string | null;
        expectedSnapshot: Readonly<{ generationId: string; revisionToken: string }> | null;
        limit: number;
        maxBytes: number;
        ownerId: string;
        signal?: AbortSignal;
      }>
    ) {
      const current = active();
      if (pageInput.ownerId !== current.ownerId) throw new OrganizerUnavailableError();
      if (
        (pageInput.cursor === null && pageInput.expectedSnapshot !== null) ||
        (pageInput.cursor !== null &&
          (pageInput.expectedSnapshot?.generationId !== current.expectedSnapshot.generationId ||
            pageInput.expectedSnapshot.revisionToken !== current.expectedSnapshot.revisionToken))
      ) {
        throw new OrganizerUnavailableError();
      }
      if (pageInput.cursor === null && current.first !== undefined) {
        const result = current.first;
        current.first = undefined;
        return result;
      }
      return options.repository.ragPage({
        cursor: pageInput.cursor,
        jobId: current.jobId,
        leaseToken: current.leaseToken,
        limit: pageInput.limit,
        maxBytes: pageInput.maxBytes,
        signal: pageInput.signal ?? current.signal
      });
    },
    async verifySnapshot(
      snapshotInput: Readonly<{
        ownerId: string;
        signal?: AbortSignal;
        snapshot: PrivateRagGenerationSnapshot;
      }>
    ) {
      const current = active();
      if (
        snapshotInput.ownerId !== current.ownerId ||
        !sameSnapshot(snapshotInput.snapshot, current.expectedSnapshot)
      ) {
        return false;
      }
      const verified = await options.repository.ragPage({
        cursor: null,
        jobId: current.jobId,
        leaseToken: current.leaseToken,
        limit: DEFAULT_PRIVATE_RAG_PAGE_SIZE,
        maxBytes: DEFAULT_PRIVATE_RAG_PAGE_BYTE_BUDGET,
        signal: snapshotInput.signal ?? current.signal
      });
      return (
        verified.status === "page" &&
        verified.page.coverage.status === "complete" &&
        sameSnapshot(verified.page.snapshot, snapshotInput.snapshot)
      );
    }
  };
  const payloads: PrivateRagPayloadOpener<OrganizerRagRecord> = {
    async openPayload(payloadInput) {
      const current = active();
      if (
        payloadInput.ownerId !== current.ownerId ||
        !sameSnapshot(payloadInput.snapshot, current.expectedSnapshot) ||
        current.payloads === undefined
      ) {
        throw new OrganizerUnavailableError();
      }
      return current.payloads.openPayload(payloadInput);
    }
  };
  const retriever = createPrivateRagRetriever<OrganizerRagRecord>({
    cacheMaxBytes: DEFAULT_PRIVATE_RAG_CACHE_BYTE_BUDGET,
    cacheTtlMs: PRIVATE_RAG_CACHE_TTL_MS,
    pages,
    payloads,
    topK: CANDIDATE_LIMIT
  });
  const uncachedRetriever = createPrivateRagRetriever<OrganizerRagRecord>({
    cacheMaxBytes: 0,
    pages,
    payloads,
    topK: CANDIDATE_LIMIT
  });
  const ownerSnapshots = new Map<string, string>();
  const now = Date.now;
  let cacheDeadline = now() + PRIVATE_RAG_CACHE_TTL_MS;

  function invalidateOwner(ownerId: string): void {
    ownerSnapshots.delete(ownerId);
    retriever.invalidateOwner(ownerId);
  }

  function clearCachedCorpora(): void {
    retriever.clearCache();
    ownerSnapshots.clear();
    cacheDeadline = now() + PRIVATE_RAG_CACHE_TTL_MS;
  }

  function expireCacheIfNeeded(): void {
    if (now() >= cacheDeadline) clearCachedCorpora();
  }

  function snapshotFingerprint(snapshot: PrivateRagGenerationSnapshot): string {
    return JSON.stringify([
      snapshot.generationId,
      snapshot.modelId,
      snapshot.dimensions,
      snapshot.revisionToken,
      snapshot.expectedNoteCount,
      snapshot.indexedNoteCount
    ]);
  }

  function observeSnapshot(ownerId: string, snapshot: PrivateRagGenerationSnapshot): void {
    const fingerprint = snapshotFingerprint(snapshot);
    const previous = ownerSnapshots.get(ownerId);
    if (previous !== undefined && previous !== fingerprint) retriever.invalidateOwner(ownerId);
    ownerSnapshots.delete(ownerId);
    ownerSnapshots.set(ownerId, fingerprint);
    while (ownerSnapshots.size > MAX_TRACKED_CACHE_OWNERS) {
      const oldestOwner = ownerSnapshots.keys().next().value;
      if (oldestOwner === undefined) break;
      ownerSnapshots.delete(oldestOwner);
      retriever.invalidateOwner(oldestOwner);
    }
  }

  const cacheTimer = setInterval(clearCachedCorpora, PRIVATE_RAG_CACHE_TTL_MS);
  cacheTimer.unref();

  async function fallback(
    input: Parameters<OrganizerCandidateRetrievalPort["retrieve"]>[0]
  ): Promise<
    OrganizerCandidatePage & Readonly<{ routingPolicyContext: OrganizerRoutingPolicyContext }>
  > {
    const page = await options.repository.candidates({
      jobId: input.job.jobId,
      leaseToken: input.job.leaseToken,
      limit: candidateLimit(input.job),
      signal: input.signal
    });
    const currentCapture = Object.freeze({
      controls: page.controls,
      rawContent: input.capture.rawContent
    });
    return Object.freeze({
      ...page,
      ragGenerationId: null,
      routingPolicyContext: context(input.job, page.candidates, currentCapture, null)
    });
  }

  async function completeNoMatch(
    input: Parameters<OrganizerCandidateRetrievalPort["retrieve"]>[0],
    generationId: string
  ): Promise<
    OrganizerCandidatePage & Readonly<{ routingPolicyContext: OrganizerRoutingPolicyContext }>
  > {
    // The bounded candidate RPC is the only lease-bound source of current
    // capture controls. Its encrypted candidates are deliberately discarded:
    // a verified complete scan established that none are usable destinations.
    const page = await options.repository.candidates({
      jobId: input.job.jobId,
      leaseToken: input.job.leaseToken,
      limit: candidateLimit(input.job),
      signal: input.signal
    });
    const currentCapture = Object.freeze({
      controls: page.controls,
      rawContent: input.capture.rawContent
    });
    if (page.controls.explicitDestinationNoteId !== null || page.controls.ruleMatch !== null) {
      return Object.freeze({
        ...page,
        ragGenerationId: null,
        routingPolicyContext: context(input.job, page.candidates, currentCapture, null)
      });
    }
    return Object.freeze({
      candidates: Object.freeze([]),
      controls: page.controls,
      ragGenerationId: generationId,
      routingPolicyContext: context(input.job, [], currentCapture, [])
    });
  }

  return Object.freeze({
    cacheStats() {
      return retriever.cacheStats();
    },
    clearCache() {
      clearCachedCorpora();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(cacheTimer);
      clearCachedCorpora();
      uncachedRetriever.clearCache();
      activeRetrieval.disable();
    },
    async retrieve(input) {
      if (closed) throw new OrganizerUnavailableError();
      expireCacheIfNeeded();
      if (
        input.capture.controls.explicitDestinationNoteId !== null ||
        input.capture.controls.ruleMatch !== null
      ) {
        return fallback(input);
      }
      let probe: PrivateRagPageReadResult<OrganizerRagRecord>;
      try {
        probe = await options.repository.ragPage({
          cursor: null,
          jobId: input.job.jobId,
          leaseToken: input.job.leaseToken,
          limit: DEFAULT_PRIVATE_RAG_PAGE_SIZE,
          maxBytes: DEFAULT_PRIVATE_RAG_PAGE_BYTE_BUDGET,
          signal: input.signal
        });
      } catch {
        invalidateOwner(input.job.ownerId);
        return fallback(input);
      }
      if (probe.status !== "page" || probe.page.coverage.status !== "complete") {
        invalidateOwner(input.job.ownerId);
        return fallback(input);
      }
      const cacheable = probe.page.snapshot.expectedNoteCount > 0;
      if (cacheable) observeSnapshot(input.job.ownerId, probe.page.snapshot);
      else invalidateOwner(input.job.ownerId);

      let queryEmbedding: Float32Array;
      try {
        queryEmbedding = await options.embeddingProvider.embed({
          dimensions: probe.page.snapshot.dimensions,
          modelId: probe.page.snapshot.modelId,
          ...(input.providerCredential === undefined
            ? {}
            : { providerCredential: input.providerCredential }),
          signal: input.signal,
          text: input.capture.rawContent
        });
      } catch (error: unknown) {
        if (error instanceof OrganizerProviderError && error.safeCode === "provider_key_invalid")
          throw error;
        return fallback(input);
      }

      try {
        const payloads =
          options.payloadsForAuthority?.(input.authority) ??
          createOrganizerRagPayloadOpener(input.authority);
        const activeContext: ActiveRetrieval = {
          active: true,
          expectedSnapshot: probe.page.snapshot,
          first: probe,
          jobId: input.job.jobId,
          leaseToken: input.job.leaseToken,
          ownerId: input.job.ownerId,
          payloads,
          signal: input.signal
        };
        const result = await activeRetrieval.run(activeContext, async () => {
          try {
            return await (cacheable ? retriever : uncachedRetriever).retrieve({
              ownerId: input.job.ownerId,
              query: {
                embedding: queryEmbedding,
                modelId: probe.page.snapshot.modelId,
                text: input.capture.rawContent
              },
              signal: input.signal
            });
          } finally {
            activeContext.active = false;
            activeContext.first = undefined;
            activeContext.payloads = undefined;
          }
        });
        if (result.status !== "complete") {
          invalidateOwner(input.job.ownerId);
          return await fallback(input);
        }
        const usableMatches = result.matches
          .filter(hasUsableRetrievalEvidence)
          .slice(0, candidateLimit(input.job));
        if (usableMatches.length === 0) {
          return await completeNoMatch(input, result.snapshot.generationId);
        }
        const selected = await options.repository.selectCandidates({
          jobId: input.job.jobId,
          leaseToken: input.job.leaseToken,
          selection: Object.freeze({
            candidates: Object.freeze(
              usableMatches.map(({ indexedRevision, noteId }) =>
                Object.freeze({ indexedRevision, noteId: noteId as `note_${string}` })
              )
            ),
            snapshot: result.snapshot
          }),
          signal: input.signal
        });
        if (!sameSnapshot(selected.snapshot, result.snapshot)) {
          throw new OrganizerUnavailableError();
        }
        assertSelectedBindings(selected.candidates, usableMatches);
        if (
          selected.controls.explicitDestinationNoteId !== null ||
          selected.controls.ruleMatch !== null
        )
          return await fallback(input);
        const currentCapture = Object.freeze({
          controls: selected.controls,
          rawContent: input.capture.rawContent
        });
        return Object.freeze({
          candidates: selected.candidates,
          controls: selected.controls,
          ragGenerationId: result.snapshot.generationId,
          routingPolicyContext: context(
            input.job,
            selected.candidates,
            currentCapture,
            usableMatches
          )
        });
      } catch {
        invalidateOwner(input.job.ownerId);
        return await fallback(input);
      } finally {
        queryEmbedding.fill(0);
      }
    }
  });
}
