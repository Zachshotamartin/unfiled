import { buildPrivateRagPayloadValue, type PrivateRagPageReadResult } from "@unfiled/search";
import { describe, expect, it, vi } from "vitest";

import { OrganizerDatabaseContractError } from "../src/database.js";
import {
  createOrganizerDrain,
  type ClaimedOrganizerJob,
  type EncryptedCandidate,
  type OrganizerCipher,
  type OrganizerRagRecord,
  type OrganizerRepository
} from "../src/drain.js";
import type { OrganizerEmbeddingProvider } from "../src/embedding-provider.js";
import { OrganizerProviderError } from "../src/errors.js";
import type { OrganizerKeyAuthority } from "../src/key-management.js";
import { createOrganizerCandidateRetrieval } from "../src/retrieval.js";
import { ORGANIZER_PROMPT_VERSION } from "../src/prompt.js";

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const;
const INDEX_ID = "irw_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const GENERATION_ID = "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const MODEL_ID = "text-embedding-3-small";
const signal = new AbortController().signal;
const authority = {} as OrganizerKeyAuthority;
const controls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: null
});
const capture = Object.freeze({ controls, rawContent: "add milk to Shopping" });
const job: ClaimedOrganizerJob = Object.freeze({
  accountCaptureOrdinal: 6,
  attempt: 1,
  captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  clientTimezone: "America/Los_Angeles",
  controls,
  jobId: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  leaseExpiresAt: "2026-08-31T20:00:00.000Z",
  leaseToken: "11111111-1111-4111-8111-111111111111",
  modelId: "gpt-5.6-terra",
  modelSelection: "auto",
  selectedProvider: "openai",
  adapterRegistryVersion: "organization-model-registry-v2",
  settingsRevision: 1,
  occurredAt: "2026-08-31T19:58:00.000Z",
  ownerId: OWNER_ID,
  promptVersion: ORGANIZER_PROMPT_VERSION,
  replanCount: 0,
  routingEffort: "standard",
  routingMode: "balanced",
  schemaVersion: 1,
  source: {
    cipher: {},
    key: {},
    recordVersion: 1,
    resourceId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV"
  },
  expansionStyle: "brief",
  commandProjection: "encrypted_only"
});
const candidate: EncryptedCandidate = Object.freeze({
  archivedAt: null,
  candidateId: NOTE_ID,
  dailyDate: "2026-08-31",
  deletedAt: null,
  isOpen: true,
  links: Object.freeze([]),
  noteId: NOTE_ID,
  noteType: "list",
  pinnedAt: null,
  revision: 2,
  source: { cipher: {}, key: {}, recordVersion: 2, resourceId: NOTE_ID },
  spaceId: null,
  tagIds: Object.freeze([]),
  updatedAt: "2026-08-31T19:00:00.000Z"
});
const snapshot = Object.freeze({
  dimensions: 2,
  expectedNoteCount: 1,
  generationId: GENERATION_ID,
  indexedNoteCount: 1,
  modelId: MODEL_ID,
  revisionToken: "7"
});
const document = buildPrivateRagPayloadValue({
  embedding: new Float32Array([1, 0]),
  headings: ["Open items"],
  indexedRevision: 2,
  isOpen: true,
  latestSnippet: "milk",
  modelId: MODEL_ID,
  noteId: NOTE_ID,
  noteType: "list",
  pinned: false,
  searchableText: "shopping groceries milk",
  spaceId: null,
  title: "Shopping",
  updatedAt: candidate.updatedAt
});
const completePage: PrivateRagPageReadResult<OrganizerRagRecord> = Object.freeze({
  status: "page",
  page: Object.freeze({
    coverage: Object.freeze({
      missingOrStaleCount: 0,
      repairCandidates: Object.freeze([]),
      repairOverflow: false,
      status: "complete"
    }),
    items: Object.freeze([
      Object.freeze({
        ciphertextBytes: 100,
        indexId: INDEX_ID,
        indexedRevision: 2,
        noteId: NOTE_ID,
        record: Object.freeze({
          cipher: {},
          key: {},
          recordVersion: 2,
          resourceId: INDEX_ID
        })
      })
    ]),
    nextCursor: null,
    snapshot
  })
});

function repository(overrides: Partial<OrganizerRepository> = {}): OrganizerRepository {
  return {
    candidates: vi.fn().mockResolvedValue({ candidates: [candidate], controls }),
    attachments: vi.fn().mockResolvedValue([]),
    claim: vi.fn().mockResolvedValue([]),
    providerRoute: vi.fn().mockRejectedValue(new Error("not used")),
    commit: vi.fn().mockRejectedValue(new Error("not used")),
    fail: vi.fn().mockRejectedValue(new Error("not used")),
    heartbeat: vi.fn().mockRejectedValue(new Error("not used")),
    preflight: vi.fn().mockResolvedValue(undefined),
    prepareAppend: vi.fn().mockRejectedValue(new Error("not used")),
    prepareCreate: vi.fn().mockRejectedValue(new Error("not used")),
    ragPage: vi.fn().mockResolvedValue(completePage),
    recoverStale: vi
      .fn()
      .mockResolvedValue({ deadLetteredCount: 0, recoveredCount: 0, requeuedCount: 0 }),
    release: vi.fn(),
    selectCandidates: vi.fn().mockResolvedValue({ candidates: [candidate], controls, snapshot }),
    ...overrides
  };
}

function embeddingProvider(vector: Float32Array): OrganizerEmbeddingProvider {
  return Object.freeze({ embed: vi.fn().mockResolvedValue(vector) });
}

function payloads() {
  return Object.freeze({
    openPayload: vi.fn().mockResolvedValue({
      plaintextBytes: new TextEncoder().encode(JSON.stringify(document)).byteLength,
      value: document
    })
  });
}

describe("organizer encrypted RAG retrieval", () => {
  it("pins, verifies, selects exact revisions, derives trusted features, and wipes the query", async () => {
    const repo = repository();
    const vector = new Float32Array([1, 0]);
    const opener = payloads();
    const retrieval = createOrganizerCandidateRetrieval({
      embeddingProvider: embeddingProvider(vector),
      payloadsForAuthority: () => opener,
      repository: repo
    });

    const result = await retrieval.retrieve({ authority, capture, job, signal });

    expect(result.candidates).toEqual([candidate]);
    expect(result.routingPolicyContext).toMatchObject({
      accountCaptureOrdinal: 6,
      deterministicRuleMatch: true,
      mode: "balanced",
      retrievalAutoEligible: true
    });
    expect(result.routingPolicyContext.candidateFeatures?.[0]?.features).toMatchObject({
      explicitDestinationMention: 1,
      openSameDayTypeMatch: 1,
      ruleOrAliasNearMatch: 1,
      semanticSimilarity: 1,
      typeCompatibility: 1
    });
    expect(repo.ragPage).toHaveBeenCalledTimes(2);
    expect(repo.selectCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: {
          candidates: [{ indexedRevision: 2, noteId: NOTE_ID }],
          snapshot
        }
      })
    );
    expect(opener.openPayload).toHaveBeenCalledTimes(1);
    expect([...vector]).toEqual([0, 0]);
  });

  it("uses the bounded database fallback and disables automatic routing without a generation", async () => {
    const repo = repository({
      ragPage: vi.fn().mockResolvedValue({ status: "no_active_generation" })
    });
    const embed = vi.fn();
    const result = await createOrganizerCandidateRetrieval({
      embeddingProvider: { embed },
      payloadsForAuthority: () => payloads(),
      repository: repo
    }).retrieve({ authority, capture, job, signal });

    expect(embed).not.toHaveBeenCalled();
    expect(repo.candidates).toHaveBeenCalledTimes(1);
    expect(repo.candidates).toHaveBeenCalledWith(expect.objectContaining({ limit: 8 }));
    expect(repo.selectCandidates).not.toHaveBeenCalled();
    expect(result.routingPolicyContext.retrievalAutoEligible).toBe(false);
    expect(result.routingPolicyContext.deterministicRuleMatch).toBe(false);

    const economicalRepository = repository({
      ragPage: vi.fn().mockResolvedValue({ status: "no_active_generation" })
    });
    await createOrganizerCandidateRetrieval({
      embeddingProvider: { embed },
      payloadsForAuthority: () => payloads(),
      repository: economicalRepository
    }).retrieve({
      authority,
      capture,
      job: Object.freeze({ ...job, routingEffort: "economical" }),
      signal
    });
    expect(economicalRepository.candidates).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 6 })
    );
  });

  it("bypasses RAG, embeddings, and payload decryption for a frozen rule snapshot", async () => {
    const ruleControls = Object.freeze({
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      ruleMatch: Object.freeze({
        destinationId: NOTE_ID,
        destinationKind: "note" as const,
        matched: true as const,
        priority: 800,
        ruleId: "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE" as const,
        ruleRevision: 2
      })
    });
    const ruleCapture = Object.freeze({ ...capture, controls: ruleControls });
    const ruleJob = Object.freeze({ ...job, controls: ruleControls });
    const repo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [candidate], controls: ruleControls })
    });
    const embed = vi.fn();
    const opener = payloads();

    const result = await createOrganizerCandidateRetrieval({
      embeddingProvider: { embed },
      payloadsForAuthority: () => opener,
      repository: repo
    }).retrieve({ authority, capture: ruleCapture, job: ruleJob, signal });

    expect(result.candidates).toEqual([candidate]);
    expect(result.routingPolicyContext).toMatchObject({
      deterministicRuleMatch: true,
      retrievalAutoEligible: false
    });
    expect(repo.candidates).toHaveBeenCalledTimes(1);
    expect(repo.ragPage).not.toHaveBeenCalled();
    expect(repo.selectCandidates).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(opener.openPayload).not.toHaveBeenCalled();
  });

  it("keeps a verified complete empty library eligible for safe creation", async () => {
    const emptySnapshot = Object.freeze({
      ...snapshot,
      expectedNoteCount: 0,
      indexedNoteCount: 0
    });
    const emptyPage: PrivateRagPageReadResult<OrganizerRagRecord> = Object.freeze({
      status: "page",
      page: Object.freeze({
        ...completePage.page,
        items: Object.freeze([]),
        snapshot: emptySnapshot
      })
    });
    const repo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [], controls }),
      ragPage: vi.fn().mockResolvedValue(emptyPage)
    });
    const vector = new Float32Array([1, 0]);
    const opener = payloads();

    const retrieval = createOrganizerCandidateRetrieval({
      embeddingProvider: embeddingProvider(vector),
      payloadsForAuthority: () => opener,
      repository: repo
    });
    const result = await retrieval.retrieve({ authority, capture, job, signal });

    expect(result.candidates).toEqual([]);
    expect(result.ragGenerationId).toBe(GENERATION_ID);
    expect(result.routingPolicyContext).toMatchObject({
      deterministicRuleMatch: false,
      retrievalAutoEligible: true
    });
    expect(repo.candidates).toHaveBeenCalledTimes(1);
    expect(repo.selectCandidates).not.toHaveBeenCalled();
    expect(opener.openPayload).not.toHaveBeenCalled();
    expect(retrieval.cacheStats().entries).toBe(0);
    expect([...vector]).toEqual([0, 0]);
    retrieval.close();
  });

  it("discloses an open note the capture shares no word with, and says so in the features", async () => {
    // "Eggs for the weekend" beside a Groceries list is the ordinary case: the model is the one
    // that can tell they belong together, and it can only do that if it sees the note. The scan
    // still says what it found -- nothing -- so the policy judges the model's choice on the
    // note's type, not on evidence that was never going to exist.
    const repo = repository();
    const vector = new Float32Array([0, 1]);
    const opener = payloads();
    const unrelatedCapture = Object.freeze({
      controls,
      rawContent: "zxqv unrelated thought"
    });

    const result = await createOrganizerCandidateRetrieval({
      embeddingProvider: embeddingProvider(vector),
      payloadsForAuthority: () => opener,
      repository: repo
    }).retrieve({ authority, capture: unrelatedCapture, job, signal });

    expect(result.candidates).toEqual([candidate]);
    expect(result.ragGenerationId).toBe(GENERATION_ID);
    expect(result.routingPolicyContext).toMatchObject({
      deterministicRuleMatch: false,
      retrievalAutoEligible: true
    });
    expect(result.routingPolicyContext.candidateFeatures?.[0]?.features).toMatchObject({
      ruleOrAliasNearMatch: 0,
      explicitDestinationMention: 0
    });
    expect(repo.selectCandidates).toHaveBeenCalledTimes(1);
    expect(repo.candidates).not.toHaveBeenCalled();
    expect(opener.openPayload).toHaveBeenCalledTimes(1);
    expect([...vector]).toEqual([0, 0]);
    expect(result.revalidationCandidates).toEqual([candidate]);
  });

  it("matches candidates on the model's reading of a capture the owner never typed", async () => {
    // The stored text of a photo-only capture is the client's "Photo" placeholder, which
    // matches nothing in any library. The reading of the photos is the only route to a note.
    const repo = repository();
    const opener = payloads();
    const embed = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
    const retrieval = createOrganizerCandidateRetrieval({
      embeddingProvider: Object.freeze({ embed }),
      payloadsForAuthority: () => opener,
      repository: repo
    });

    const photoCapture = Object.freeze({
      attachments: [
        {
          attachmentId: "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ" as const,
          kind: "image" as const,
          mediaType: "image/jpeg" as const,
          dataBase64: "/9j/AAAA",
          byteLength: 6,
          width: 4,
          height: 3,
          durationMs: null
        }
      ],
      controls,
      rawContent: "Photo",
      visualDescriptor: "shopping: milk and bread"
    });
    const result = await retrieval.retrieve({ authority, capture: photoCapture, job, signal });

    const embedded = vi.mocked(embed).mock.calls[0]?.[0] as Readonly<{ text: string }> | undefined;
    expect(embedded?.text).toBe("shopping: milk and bread");
    expect(result.candidates).toEqual([candidate]);
    expect(result.routingPolicyContext.candidateFeatures?.[0]?.features).toMatchObject({
      ruleOrAliasNearMatch: 1,
      typeCompatibility: 1
    });
    retrieval.close();
  });

  it("fails closed to fallback for incomplete coverage before embedding or decryption", async () => {
    const incomplete = Object.freeze({
      status: "page" as const,
      page: Object.freeze({
        ...completePage.page,
        coverage: Object.freeze({
          missingOrStaleCount: 1,
          repairCandidates: Object.freeze([{ currentRevision: 2, noteId: NOTE_ID }]),
          repairOverflow: false,
          status: "incomplete" as const
        })
      })
    });
    const repo = repository({ ragPage: vi.fn().mockResolvedValue(incomplete) });
    const embed = vi.fn();
    const opener = payloads();
    const result = await createOrganizerCandidateRetrieval({
      embeddingProvider: { embed },
      payloadsForAuthority: () => opener,
      repository: repo
    }).retrieve({ authority, capture, job, signal });

    expect(embed).not.toHaveBeenCalled();
    expect(opener.openPayload).not.toHaveBeenCalled();
    expect(result.routingPolicyContext.retrievalAutoEligible).toBe(false);
  });

  it("fails closed to fallback when embedding is unavailable", async () => {
    const repo = repository();
    const result = await createOrganizerCandidateRetrieval({
      embeddingProvider: {
        embed: vi.fn().mockRejectedValue(new OrganizerProviderError("rate_limited", true, 429))
      },
      payloadsForAuthority: () => payloads(),
      repository: repo
    }).retrieve({ authority, capture, job, signal });

    expect(repo.candidates).toHaveBeenCalledTimes(1);
    expect(repo.selectCandidates).not.toHaveBeenCalled();
    expect(result.routingPolicyContext.retrievalAutoEligible).toBe(false);
  });

  it("surfaces an invalid provider credential instead of hiding the exact-revision failure", async () => {
    const repo = repository();
    await expect(
      createOrganizerCandidateRetrieval({
        embeddingProvider: {
          embed: vi
            .fn()
            .mockRejectedValue(new OrganizerProviderError("provider_key_invalid", false, 401))
        },
        payloadsForAuthority: () => payloads(),
        repository: repo
      }).retrieve({ authority, capture, job, signal })
    ).rejects.toMatchObject({ safeCode: "provider_key_invalid", retryable: false });
    expect(repo.candidates).not.toHaveBeenCalled();
    expect(repo.selectCandidates).not.toHaveBeenCalled();
  });

  it("rejects a changed terminal snapshot, wipes the vector, and falls back", async () => {
    const changed = Object.freeze({
      status: "page" as const,
      page: Object.freeze({
        ...completePage.page,
        snapshot: Object.freeze({ ...snapshot, revisionToken: "8" })
      })
    });
    const ragPage = vi.fn().mockResolvedValueOnce(completePage).mockResolvedValueOnce(changed);
    const repo = repository({ ragPage });
    const vector = new Float32Array([1, 0]);
    const result = await createOrganizerCandidateRetrieval({
      embeddingProvider: embeddingProvider(vector),
      payloadsForAuthority: () => payloads(),
      repository: repo
    }).retrieve({ authority, capture, job, signal });

    expect(repo.selectCandidates).not.toHaveBeenCalled();
    expect(repo.candidates).toHaveBeenCalledTimes(1);
    expect(result.routingPolicyContext.retrievalAutoEligible).toBe(false);
    expect([...vector]).toEqual([0, 0]);
  });

  it("rejects metadata drift after exact selection and overwrites the candidate fence", async () => {
    const mismatched = Object.freeze({ ...candidate, noteType: "generic" as const });
    const repo = repository({
      selectCandidates: vi.fn().mockResolvedValue({ candidates: [mismatched], controls, snapshot })
    });
    const vector = new Float32Array([1, 0]);
    const result = await createOrganizerCandidateRetrieval({
      embeddingProvider: embeddingProvider(vector),
      payloadsForAuthority: () => payloads(),
      repository: repo
    }).retrieve({ authority, capture, job, signal });

    expect(repo.selectCandidates).toHaveBeenCalledTimes(1);
    expect(repo.candidates).toHaveBeenCalledTimes(1);
    expect(result.routingPolicyContext.retrievalAutoEligible).toBe(false);
    expect([...vector]).toEqual([0, 0]);
  });

  it("warms only within an owner and generation and zeroizes every corpus on clear", async () => {
    const secondOwner = "33333333-3333-4333-8333-333333333333";
    const warmAuthority = {} as OrganizerKeyAuthority;
    const warmJob = Object.freeze({
      ...job,
      jobId: "job_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      leaseToken: "22222222-2222-4222-8222-222222222222"
    });
    const secondOwnerJob = Object.freeze({
      ...job,
      jobId: "job_01ARZ3NDEKTSV4RRFFQ69G5FAX",
      leaseToken: "33333333-3333-4333-8333-333333333333",
      ownerId: secondOwner
    });
    const secondGeneration = Object.freeze({
      ...snapshot,
      generationId: "igen_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      revisionToken: "8"
    });
    let currentPage = completePage;
    const repo = repository({
      ragPage: vi.fn(() => Promise.resolve(currentPage)),
      selectCandidates: vi.fn(() =>
        Promise.resolve({
          candidates: [candidate],
          controls,
          snapshot: currentPage.page.snapshot
        })
      )
    });
    const opener = payloads();
    const payloadsForAuthority = vi.fn(() => opener);
    const retrieval = createOrganizerCandidateRetrieval({
      embeddingProvider: {
        embed: vi.fn(() => Promise.resolve(new Float32Array([1, 0])))
      },
      payloadsForAuthority,
      repository: repo
    });

    await retrieval.retrieve({ authority, capture, job, signal });
    await retrieval.retrieve({ authority: warmAuthority, capture, job: warmJob, signal });
    expect(opener.openPayload).toHaveBeenCalledTimes(1);
    expect(payloadsForAuthority).toHaveBeenCalledTimes(2);
    expect(retrieval.cacheStats().entries).toBe(1);
    expect(repo.ragPage).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: warmJob.jobId, leaseToken: warmJob.leaseToken })
    );
    expect(repo.selectCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: warmJob.jobId, leaseToken: warmJob.leaseToken })
    );

    await retrieval.retrieve({
      authority,
      capture,
      job: secondOwnerJob,
      signal
    });
    expect(opener.openPayload).toHaveBeenCalledTimes(2);
    expect(payloadsForAuthority).toHaveBeenCalledTimes(3);
    expect(retrieval.cacheStats().entries).toBe(2);

    currentPage = Object.freeze({
      status: "page",
      page: Object.freeze({ ...completePage.page, snapshot: secondGeneration })
    });
    const generationResult = await retrieval.retrieve({ authority, capture, job, signal });
    expect(generationResult.ragGenerationId).toBe(secondGeneration.generationId);
    expect(opener.openPayload).toHaveBeenCalledTimes(3);
    expect(payloadsForAuthority).toHaveBeenCalledTimes(4);
    expect(retrieval.cacheStats()).toMatchObject({ entries: 2, maxBytes: 64 * 1024 * 1024 });

    const fill = vi.spyOn(Float32Array.prototype, "fill");
    retrieval.close();
    expect(fill).toHaveBeenCalledTimes(2);
    expect(fill).toHaveBeenCalledWith(0);
    expect(retrieval.cacheStats()).toMatchObject({ bytes: 0, entries: 0 });
    fill.mockRestore();
  });

  it("expires and zeroizes a warm corpus after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T19:58:00.000Z"));
    try {
      const repo = repository();
      const opener = payloads();
      const retrieval = createOrganizerCandidateRetrieval({
        embeddingProvider: {
          embed: vi.fn(() => Promise.resolve(new Float32Array([1, 0])))
        },
        payloadsForAuthority: () => opener,
        repository: repo
      });

      await retrieval.retrieve({ authority, capture, job, signal });
      await retrieval.retrieve({ authority, capture, job, signal });
      expect(opener.openPayload).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(retrieval.cacheStats().entries).toBe(0);
      await retrieval.retrieve({ authority, capture, job, signal });
      expect(opener.openPayload).toHaveBeenCalledTimes(2);
      expect(retrieval.cacheStats().entries).toBe(1);
      retrieval.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("drain over the real retrieval port", () => {
  /**
   * A repository double that holds the recorded-candidate invariant the way the production RPC
   * does: the revalidation manifest must mirror, exactly and in order, the last candidate page
   * this lease listed. Every heartbeat test below the drain mirrors the page it was handed, so
   * the mismatch that killed a real capture could not be reproduced there.
   */
  function invariantRepository(): OrganizerRepository {
    let recorded: readonly EncryptedCandidate[] = [];
    return repository({
      candidates: vi.fn().mockImplementation(() => {
        recorded = [candidate];
        return Promise.resolve({ candidates: [candidate], controls });
      }),
      claim: vi.fn().mockResolvedValue([job]),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        outcome: "created",
        replayed: false,
        revision: 1,
        replanCount: 0
      }),
      heartbeat: vi.fn().mockImplementation((input: { candidateManifest: unknown }) => {
        const manifest = input.candidateManifest as {
          candidates: readonly Readonly<{ noteId: string; revision: number }>[];
        };
        if (
          manifest.candidates.length !== recorded.length ||
          manifest.candidates.some((entry, index) => {
            const expected = recorded[index];
            return expected === undefined
              ? true
              : entry.noteId !== expected.noteId || entry.revision !== expected.revision;
          })
        ) {
          return Promise.reject(new OrganizerDatabaseContractError("contract_violation"));
        }
        return Promise.resolve({
          candidateCount: manifest.candidates.length,
          currentRevision: 1,
          disclosureAuthorized: true,
          jobId: job.jobId,
          leaseExpiresAt: job.leaseExpiresAt,
          outcome: "authorized",
          replanCount: 0
        });
      }),
      prepareCreate: vi.fn().mockResolvedValue({
        expectedRevision: null,
        ids: {
          decisionId: "dec_01ARZ3NDEKTSV4RRFFQ69G5FAC",
          generatedBlockId: "blk_01ARZ3NDEKTSV4RRFFQ69G5FAJ",
          mutationId: "mut_01ARZ3NDEKTSV4RRFFQ69G5FAD",
          reviewItemId: "rvw_01ARZ3NDEKTSV4RRFFQ69G5FAE",
          revisionId: "rev_01ARZ3NDEKTSV4RRFFQ69G5FAF"
        },
        jobId: job.jobId,
        keys: { contentMac: {}, objectWrap: {} },
        mode: "create",
        noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        replanCount: 0,
        replayed: false,
        reservations: {
          decision: { operationCount: 1, reservationId: "r-decision" },
          generatedBlock: { operationCount: 1, reservationId: "r-block" },
          noteWrite: { operationCount: 4, reservationId: "r-write" },
          receipt: { operationCount: 1, reservationId: "r-receipt" },
          review: { operationCount: 1, reservationId: "r-review" }
        },
        targetRevision: 1
      }),
      selectCandidates: vi.fn().mockImplementation(() => {
        recorded = [candidate];
        return Promise.resolve({ candidates: [candidate], controls, snapshot });
      })
    });
  }

  function cipherDouble(): OrganizerCipher {
    return {
      openCapture: vi.fn().mockResolvedValue({ controls, rawContent: "zxqv unrelated thought" }),
      openCaptureAttachments: vi.fn().mockResolvedValue([]),
      openCandidate: vi
        .fn()
        .mockImplementation(({ candidate: disclosed }: { candidate: EncryptedCandidate }) =>
          Promise.resolve({
            bodyMarkdown: "- [ ] milk",
            candidateId: disclosed.candidateId,
            isOpen: disclosed.isOpen,
            noteId: disclosed.noteId,
            noteType: disclosed.noteType,
            revision: disclosed.revision,
            structuredData: { items: [], schemaVersion: 1 },
            title: "Groceries"
          })
        ),
      sealCommand: vi
        .fn()
        .mockImplementation(
          ({ plan, reviewReason }: Parameters<OrganizerCipher["sealCommand"]>[0]) =>
            Promise.resolve({
              decision: { sealed: true },
              generatedBlock: null,
              noteWrite: plan.kind === "review" ? null : { sealed: true },
              outcome:
                plan.kind === "append" ? "appended" : plan.kind === "create" ? "created" : "review",
              receipt: { sealed: true },
              review: plan.kind === "review" ? { sealed: true } : null,
              reviewReason
            })
        )
    };
  }

  it("keeps the revalidation manifest on the page the repository recorded", async () => {
    // A verified complete scan discloses the open note even when the capture shares no word
    // with it, and the revalidation manifest has to mirror exactly the page the repository
    // recorded for that disclosure. A manifest that drifted from the page made the heartbeat
    // reject it, and an owner writing a thought unrelated to all their notes lost the capture to
    // a permanent validation_failed.
    const repo = invariantRepository();
    const retrieval = createOrganizerCandidateRetrieval({
      embeddingProvider: embeddingProvider(new Float32Array([0, 1])),
      payloadsForAuthority: () => payloads(),
      repository: repo
    });

    const result = await createOrganizerDrain({
      cipher: cipherDouble(),
      claimLimit: 1,
      concurrency: 1,
      leaseSeconds: 120,
      planner: {
        describe: vi.fn().mockRejectedValue(new Error("this capture carries no photos")),
        plan: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          captureKind: "freeform",
          decision: "create_note",
          destination: {
            candidateId: null,
            newNote: { title: "A thought", noteType: "generic", spaceCandidateId: null }
          },
          operations: [{ type: "append_raw", content: "zxqv unrelated thought" }],
          generatedExpansion: null,
          alternatives: [],
          reasonCodes: ["no_candidate_fit"]
        })
      },
      recoveryLimit: 10,
      repository: repo,
      retrieval,
      workerId: "organizer-test"
    }).drain({ authority, requestId: "r", signal, trigger: "schedule" });

    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    const manifestSizes = vi
      .mocked(repo.heartbeat)
      .mock.calls.map(([input]) => input.candidateManifest.candidates.length);
    expect(manifestSizes.length).toBeGreaterThan(0);
    expect(new Set(manifestSizes)).toEqual(new Set([1]));
    retrieval.close();
  });
});
