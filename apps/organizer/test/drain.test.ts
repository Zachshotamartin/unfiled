import { describe, expect, it, vi } from "vitest";

import {
  createOrganizerDrain,
  isOrganizerDrainResult,
  unavailableOrganizerCipher,
  unconfiguredDrainPort,
  type ClaimedOrganizerJob,
  type EncryptedCandidate,
  type OrganizerCipher,
  type OrganizerPreparation,
  type OrganizerRepository,
  type OrganizerRoutingPolicyContext
} from "../src/drain.js";
import {
  OrganizerPlannerReviewError,
  OrganizerProviderError,
  OrganizerUnavailableError
} from "../src/errors.js";
import type { OrganizerKeyAuthority } from "../src/key-management.js";
import type { OrganizerPlanner } from "../src/planner.js";
import type { OrganizerAppDefaultApiKeys } from "../src/provider-credential.js";

const signal = new AbortController().signal;
const authority = {} as OrganizerKeyAuthority;
const controls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: null
});
const automaticPolicyContext: OrganizerRoutingPolicyContext = Object.freeze({
  accountCaptureOrdinal: 6,
  deterministicRuleMatch: true,
  features: Object.freeze({
    destinationRecency: 1,
    duplicateTitleSuspicion: 0,
    explicitDestinationMention: 1,
    margin: 1,
    openSameDayTypeMatch: 1,
    priorAccepted: 1,
    reasonCodeConsistency: 1,
    ruleOrAliasNearMatch: 1,
    semanticSimilarity: 1,
    typeCompatibility: 1
  }),
  mode: "balanced",
  retrievalAutoEligible: true
});
const zeroPolicyFeatures: OrganizerRoutingPolicyContext["features"] = Object.freeze({
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
  ownerId: "22222222-2222-4222-8222-222222222222",
  promptVersion: "routing-v1",
  replanCount: 0,
  routingEffort: "standard",
  routingMode: "balanced",
  schemaVersion: 1,
  source: {
    resourceId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    recordVersion: 1,
    cipher: {},
    key: {}
  },
  expansionStyle: "brief",
  commandProjection: "encrypted_only"
});
const candidate = Object.freeze({
  archivedAt: null,
  candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const,
  dailyDate: "2026-08-31",
  deletedAt: null,
  isOpen: true,
  links: Object.freeze([]),
  noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const,
  noteType: "list" as const,
  pinnedAt: null,
  revision: 2,
  spaceId: null,
  source: {
    resourceId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    recordVersion: 2,
    cipher: {},
    key: {}
  },
  tagIds: Object.freeze([]),
  updatedAt: "2026-08-31T19:00:00.000Z"
});

function candidateAt(revision: number, values: Partial<EncryptedCandidate> = {}) {
  const noteId = values.noteId ?? candidate.noteId;
  return Object.freeze({
    ...candidate,
    ...values,
    revision,
    source: { ...candidate.source, recordVersion: revision, resourceId: noteId }
  });
}

function prepared(mode: "append" | "create", revision: number | null): OrganizerPreparation {
  return Object.freeze({
    expectedRevision: revision,
    ids: {
      decisionId: "dec_01ARZ3NDEKTSV4RRFFQ69G5FAC",
      generatedBlockId: "blk_01ARZ3NDEKTSV4RRFFQ69G5FAJ",
      mutationId: "mut_01ARZ3NDEKTSV4RRFFQ69G5FAD",
      reviewItemId: "rvw_01ARZ3NDEKTSV4RRFFQ69G5FAE",
      revisionId: "rev_01ARZ3NDEKTSV4RRFFQ69G5FAF"
    },
    jobId: job.jobId,
    keys: { contentMac: {}, objectWrap: {} },
    mode,
    noteId: mode === "append" ? candidate.noteId : "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    replanCount: 0,
    replayed: false,
    reservations: {
      decision: { operationCount: 1, reservationId: "22222222-2222-4222-8222-222222222221" },
      generatedBlock: {
        operationCount: 1,
        reservationId: "22222222-2222-4222-8222-222222222225"
      },
      noteWrite: { operationCount: 4, reservationId: "22222222-2222-4222-8222-222222222222" },
      receipt: { operationCount: 1, reservationId: "22222222-2222-4222-8222-222222222223" },
      review: { operationCount: 1, reservationId: "22222222-2222-4222-8222-222222222224" }
    },
    targetRevision: (revision ?? 0) + 1
  } as const);
}

function repository(overrides: Partial<OrganizerRepository> = {}): OrganizerRepository {
  return {
    release: vi.fn(),
    preflight: vi.fn().mockResolvedValue(undefined),
    recoverStale: vi
      .fn()
      .mockResolvedValue({ deadLetteredCount: 0, recoveredCount: 0, requeuedCount: 0 }),
    claim: vi.fn().mockResolvedValue([job]),
    providerRoute: vi.fn().mockResolvedValue({
      adapterRegistryVersion: "organization-model-registry-v2",
      credential: null,
      credentialRevision: null,
      expansionStyle: "brief",
      modelId: "gpt-5.6-terra",
      modelSelection: "auto",
      provider: "openai",
      routingEffort: "standard",
      settingsRevision: 1,
      source: "app_default"
    }),
    heartbeat: vi.fn().mockResolvedValue({
      candidateCount: 1,
      currentRevision: 1,
      disclosureAuthorized: true,
      jobId: job.jobId,
      leaseExpiresAt: job.leaseExpiresAt,
      outcome: "authorized",
      replanCount: 0
    }),
    candidates: vi.fn().mockResolvedValue({ candidates: [candidate], controls }),
    attachments: vi.fn().mockResolvedValue([]),
    ragPage: vi.fn().mockResolvedValue({ status: "no_active_generation" }),
    selectCandidates: vi.fn().mockRejectedValue(new Error("not used by this test")),
    prepareCreate: vi.fn().mockResolvedValue(prepared("create", null)),
    prepareAppend: vi
      .fn()
      .mockResolvedValue({ outcome: "prepared", preparation: prepared("append", 2) }),
    commit: vi.fn().mockResolvedValue({
      jobId: job.jobId,
      noteId: candidate.noteId,
      outcome: "appended",
      replayed: false,
      revision: 3,
      replanCount: 0
    }),
    fail: vi.fn().mockResolvedValue({ state: "failed" }),
    ...overrides
  };
}

function cipher(): OrganizerCipher {
  return {
    openCapture: vi.fn().mockResolvedValue({ controls, rawContent: "Shopping: milk" }),
    openCaptureAttachments: vi.fn().mockResolvedValue([]),
    openCandidate: vi
      .fn()
      .mockImplementation(
        ({ candidate: encrypted }: Parameters<OrganizerCipher["openCandidate"]>[0]) =>
          Promise.resolve({
            bodyMarkdown: "- bread",
            candidateId: encrypted.candidateId,
            isOpen: encrypted.isOpen,
            noteId: encrypted.noteId,
            noteType: encrypted.noteType,
            revision: encrypted.revision,
            structuredData: { items: [], schemaVersion: 1 },
            title: "Shopping"
          })
      ),
    sealCommand: vi
      .fn()
      .mockImplementation(({ plan, reviewReason }: Parameters<OrganizerCipher["sealCommand"]>[0]) =>
        Promise.resolve({
          decision: { sealed: true },
          generatedBlock: plan.generatedBlock === null ? null : { sealed: true },
          noteWrite: plan.kind === "review" ? null : { sealed: true },
          outcome:
            plan.kind === "append" ? "appended" : plan.kind === "create" ? "created" : "review",
          receipt: { sealed: true },
          review: plan.kind === "review" || plan.generatedBlock !== null ? { sealed: true } : null,
          reviewReason
        })
      )
  };
}

const appendPlan = Object.freeze({
  schemaVersion: 1,
  captureKind: "list_items",
  decision: "append_to_note",
  destination: { candidateId: candidate.candidateId, newNote: null },
  operations: [{ type: "append_list_items", section: "Open items", items: ["milk"] }],
  generatedExpansion: null,
  alternatives: [],
  reasonCodes: ["explicit_shopping_intent", "type_match"]
});
const createPlan = Object.freeze({
  schemaVersion: 1,
  captureKind: "freeform",
  decision: "create_note",
  destination: {
    candidateId: null,
    newNote: { title: "Thought", noteType: "generic", spaceCandidateId: null }
  },
  operations: [{ type: "append_raw", content: "A thought" }],
  generatedExpansion: null,
  alternatives: [],
  reasonCodes: ["no_candidate_fit"]
});
const reviewPlan = Object.freeze({
  schemaVersion: 1,
  captureKind: "freeform",
  decision: "needs_review",
  destination: { candidateId: null, newNote: null },
  operations: [],
  generatedExpansion: null,
  alternatives: [candidate.candidateId],
  reasonCodes: ["ambiguous_intent"]
});
const appendPlanner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(appendPlan) };

function authorized(candidateCount = 1, replanCount: 0 | 1 = 0) {
  return {
    candidateCount,
    currentRevision: 1,
    disclosureAuthorized: true as const,
    jobId: job.jobId,
    leaseExpiresAt: job.leaseExpiresAt,
    outcome: "authorized" as const,
    replanCount
  };
}

function drain(
  repo: OrganizerRepository,
  planner = appendPlanner,
  crypto = cipher(),
  routingPolicyContext: OrganizerRoutingPolicyContext | null = automaticPolicyContext,
  appDefaultProviderApiKeys?: OrganizerAppDefaultApiKeys
) {
  return createOrganizerDrain({
    ...(appDefaultProviderApiKeys === undefined ? {} : { appDefaultProviderApiKeys }),
    cipher: crypto,
    claimLimit: 2,
    concurrency: 2,
    leaseSeconds: 120,
    planner,
    recoveryLimit: 50,
    repository: repo,
    ...(routingPolicyContext === null ? {} : { routingPolicyContext }),
    workerId: "organizer-test"
  });
}

describe("organizer drain", () => {
  it("executes matched-note and zero-candidate matched-space routes without the planner", async () => {
    const ruleId = "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE" as const;
    const noteRuleControls = Object.freeze({
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      ruleMatch: Object.freeze({
        destinationId: candidate.noteId,
        destinationKind: "note" as const,
        matched: true as const,
        priority: 900,
        ruleId,
        ruleRevision: 5
      })
    });
    const noteRuleJob = Object.freeze({
      ...job,
      controls: noteRuleControls,
      routingMode: "cautious" as const
    });
    const noteRepo = repository({
      claim: vi.fn().mockResolvedValue([noteRuleJob]),
      candidates: vi.fn().mockResolvedValue({ candidates: [candidate], controls: noteRuleControls })
    });
    const noteCipher = cipher();
    vi.mocked(noteCipher.openCapture).mockResolvedValue({
      controls: noteRuleControls,
      rawContent: "Shopping: milk"
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockRejectedValue(new Error("rule path must not call the planner"))
    };

    await expect(
      drain(noteRepo, planner, noteCipher).drain({
        authority,
        requestId: "note-rule",
        signal,
        trigger: "manual"
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(noteRepo.prepareAppend).toHaveBeenCalledOnce();
    expect(vi.mocked(noteCipher.sealCommand).mock.calls[0]?.[0]).toMatchObject({
      plan: {
        kind: "append",
        validatedPlan: { reasonCodes: ["routing_rule_match"] }
      },
      routingDecision: { autoApply: true, band: "auto" }
    });

    const spaceId = "spc_01ARZ3NDEKTSV4RRFFQ69G5FAF" as const;
    const spaceRuleControls = Object.freeze({
      ...noteRuleControls,
      ruleMatch: Object.freeze({
        ...noteRuleControls.ruleMatch,
        destinationId: spaceId,
        destinationKind: "space" as const
      })
    });
    const spaceRuleJob = Object.freeze({ ...job, controls: spaceRuleControls });
    const spaceRepo = repository({
      claim: vi.fn().mockResolvedValue([spaceRuleJob]),
      candidates: vi.fn().mockResolvedValue({ candidates: [], controls: spaceRuleControls }),
      heartbeat: vi.fn().mockResolvedValue(authorized(0)),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        outcome: "created",
        replayed: false,
        revision: 1,
        replanCount: 0
      })
    });
    const spaceCipher = cipher();
    vi.mocked(spaceCipher.openCapture).mockResolvedValue({
      controls: spaceRuleControls,
      rawContent: "add milk and eggs"
    });

    await expect(
      drain(spaceRepo, planner, spaceCipher).drain({
        authority,
        requestId: "space-rule",
        signal,
        trigger: "manual"
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(spaceRepo.prepareCreate).toHaveBeenCalledOnce();
    expect(spaceCipher.openCandidate).not.toHaveBeenCalled();
    expect(vi.mocked(spaceCipher.sealCommand).mock.calls[0]?.[0]).toMatchObject({
      plan: {
        kind: "create",
        spaceId,
        title: "Daily list / 2026-08-31",
        validatedPlan: { reasonCodes: ["routing_rule_match"] }
      }
    });
  });

  it("applies the long-capture hard override to a matched existing-note rule", async () => {
    const ruleControls = Object.freeze({
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      ruleMatch: Object.freeze({
        destinationId: candidate.noteId,
        destinationKind: "note" as const,
        matched: true as const,
        priority: 900,
        ruleId: "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE" as const,
        ruleRevision: 5
      })
    });
    const genericCandidate = candidateAt(2, { noteType: "generic" });
    const repo = repository({
      claim: vi.fn().mockResolvedValue([{ ...job, controls: ruleControls }]),
      candidates: vi
        .fn()
        .mockResolvedValue({ candidates: [genericCandidate], controls: ruleControls }),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockResolvedValue({
      controls: ruleControls,
      rawContent: "x".repeat(2_001)
    });

    await expect(
      drain(repo, { plan: vi.fn() }, crypto).drain({
        authority,
        requestId: "long-rule-capture",
        signal,
        trigger: "manual"
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(repo.prepareAppend).not.toHaveBeenCalled();
    expect(repo.prepareCreate).toHaveBeenCalledOnce();
    const sealed = vi.mocked(crypto.sealCommand).mock.calls.at(-1)?.[0];
    expect(sealed).toMatchObject({
      plan: { kind: "review" },
      reviewReason: "planner_ambiguity",
      routingDecision: {
        autoApply: false,
        band: "review"
      }
    });
    expect(sealed?.routingDecision?.reasons).toContain("long_capture");
  });

  it("sends a multiple-candidate matched-space route to Review without disclosure", async () => {
    const spaceId = "spc_01ARZ3NDEKTSV4RRFFQ69G5FAF" as const;
    const ruleControls = Object.freeze({
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      ruleMatch: Object.freeze({
        destinationId: spaceId,
        destinationKind: "space" as const,
        matched: true as const,
        priority: 900,
        ruleId: "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE" as const,
        ruleRevision: 5
      })
    });
    const first = Object.freeze({ ...candidate, spaceId });
    const second = candidateAt(2, {
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAD",
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAC",
      spaceId
    });
    const repo = repository({
      claim: vi.fn().mockResolvedValue([{ ...job, controls: ruleControls }]),
      candidates: vi
        .fn()
        .mockResolvedValue({ candidates: [first, second], controls: ruleControls }),
      heartbeat: vi.fn().mockResolvedValue(authorized(2)),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockResolvedValue({
      controls: ruleControls,
      rawContent: "add milk and eggs"
    });
    const planner: OrganizerPlanner = { plan: vi.fn() };

    await expect(
      drain(repo, planner, crypto).drain({
        authority,
        requestId: "ambiguous-space-rule",
        signal,
        trigger: "manual"
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(crypto.openCandidate).not.toHaveBeenCalled();
    expect(repo.prepareAppend).not.toHaveBeenCalled();
    expect(vi.mocked(crypto.sealCommand).mock.calls[0]?.[0]).toMatchObject({
      plan: {
        kind: "review",
        validatedPlan: {
          reasonCodes: ["ambiguous_intent", "routing_rule_match"]
        }
      },
      reviewReason: "planner_ambiguity"
    });
  });

  it("reseals Review at the database replan generation when a rule target invalidates at commit", async () => {
    const ruleControls = Object.freeze({
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      ruleMatch: Object.freeze({
        destinationId: candidate.noteId,
        destinationKind: "note" as const,
        matched: true as const,
        priority: 900,
        ruleId: "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE" as const,
        ruleRevision: 5
      })
    });
    const reviewPreparation = Object.freeze({
      ...prepared("create", null),
      replanCount: 1 as const
    });
    const repo = repository({
      claim: vi.fn().mockResolvedValue([{ ...job, controls: ruleControls }]),
      candidates: vi.fn().mockResolvedValue({ candidates: [candidate], controls: ruleControls }),
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce(authorized(1, 0))
        .mockResolvedValueOnce(authorized(1, 0))
        .mockResolvedValueOnce(authorized(1, 1))
        .mockResolvedValueOnce(authorized(1, 1)),
      prepareCreate: vi.fn().mockResolvedValue(reviewPreparation),
      commit: vi
        .fn()
        .mockResolvedValueOnce({
          conflictReason: "candidate_eligibility",
          jobId: job.jobId,
          noteId: null,
          outcome: "review_required",
          replayed: false,
          revision: null,
          replanCount: 1
        })
        .mockResolvedValueOnce({
          jobId: job.jobId,
          noteId: null,
          outcome: "review",
          replayed: false,
          revision: null,
          replanCount: 1
        })
    });
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockResolvedValue({
      controls: ruleControls,
      rawContent: "Shopping: milk"
    });
    const planner: OrganizerPlanner = { plan: vi.fn() };

    await expect(
      drain(repo, planner, crypto).drain({
        authority,
        requestId: "rule-target-invalidated",
        signal,
        trigger: "manual"
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(repo.prepareAppend).toHaveBeenCalledOnce();
    expect(repo.prepareCreate).toHaveBeenCalledOnce();
    expect(repo.commit).toHaveBeenCalledTimes(2);
    expect(repo.heartbeat).toHaveBeenCalledTimes(4);
    expect(vi.mocked(crypto.sealCommand).mock.calls[1]?.[0]).toMatchObject({
      activeReplanCount: 1,
      plan: {
        kind: "review",
        validatedPlan: {
          reasonCodes: ["ambiguous_intent", "routing_rule_match"]
        }
      },
      preparation: { replanCount: 1 },
      reviewReason: "planner_ambiguity"
    });
  });

  it("authorizes, prepares, seals, revalidates, and atomically commits append", async () => {
    const repo = repository();
    await expect(
      drain(repo).drain({ authority, requestId: "request", signal, trigger: "schedule" })
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(repo.heartbeat).toHaveBeenCalledTimes(2);
    expect(repo.prepareAppend).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2, noteId: candidate.noteId })
    );
    expect(repo.commit).toHaveBeenCalledTimes(1);
  });

  it("performs exactly one bounded replan with the same prepared target", async () => {
    const repo = repository({
      commit: vi
        .fn()
        .mockResolvedValueOnce({
          conflictReason: "revision",
          jobId: job.jobId,
          noteId: candidate.noteId,
          outcome: "replan",
          replayed: false,
          revision: 2,
          replanCount: 1
        })
        .mockResolvedValueOnce({
          jobId: job.jobId,
          noteId: candidate.noteId,
          outcome: "appended",
          replayed: false,
          revision: 3,
          replanCount: 1
        })
    });
    const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(appendPlan) };
    const result = await drain(repo, planner).drain({
      authority,
      requestId: "request",
      signal,
      trigger: "manual"
    });
    expect(result.completed).toBe(1);
    expect(planner.plan).toHaveBeenCalledTimes(2);
    expect(repo.commit).toHaveBeenCalledTimes(2);
    expect(repo.heartbeat).toHaveBeenCalledTimes(4);
    const reservationIds = vi
      .mocked(repo.prepareAppend)
      .mock.calls.map(([input]) => input.reservationId);
    expect(new Set(reservationIds).size).toBe(2);
  });

  it("fails closed if a second replan violates the database contract", async () => {
    const repo = repository({
      commit: vi.fn().mockResolvedValue({
        conflictReason: "revision",
        jobId: job.jobId,
        noteId: candidate.noteId,
        outcome: "replan",
        replayed: false,
        revision: 2,
        replanCount: 1
      })
    });
    const result = await drain(repo).drain({
      authority,
      requestId: "request",
      signal,
      trigger: "schedule"
    });
    expect(result.failed).toBe(1);
    expect(repo.commit).toHaveBeenCalledTimes(2);
  });

  it("schedules a safe retry when a dependency is unavailable", async () => {
    const repo = repository({ fail: vi.fn().mockResolvedValue({ state: "awaiting_retry" }) });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockRejectedValue(new Error("secret capture leaked?"))
    };
    await expect(
      drain(repo, planner).drain({ authority, requestId: "request", signal, trigger: "schedule" })
    ).resolves.toEqual({ claimed: 1, completed: 0, failed: 0, retryScheduled: 1 });
    expect(repo.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_unavailable", retryable: true })
    );
  });

  it("does not let failure-reporting errors escape", async () => {
    const repo = repository({ fail: vi.fn().mockRejectedValue(new Error("db detail")) });
    const planner: OrganizerPlanner = { plan: vi.fn().mockRejectedValue(new Error("capture")) };
    await expect(
      drain(repo, planner).drain({ authority, requestId: "request", signal, trigger: "schedule" })
    ).resolves.toMatchObject({ failed: 1 });
  });

  it("releases local ciphertext state even when abort prevents failure reporting", async () => {
    const controller = new AbortController();
    const repo = repository({
      fail: vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"))
    });
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new OrganizerUnavailableError());
    });

    const result = await drain(repo, appendPlanner, crypto).drain({
      authority,
      requestId: "r",
      signal: controller.signal,
      trigger: "manual"
    });

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1, retryScheduled: 0 });
    expect(repo.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(repo.release).toHaveBeenCalledOnce();
    expect(repo.release).toHaveBeenCalledWith(job.jobId);
  });

  it("runs bounded recovery only for the recovery trigger", async () => {
    const repo = repository({ claim: vi.fn().mockResolvedValue([]) });
    await drain(repo).drain({ authority, requestId: "request", signal, trigger: "recovery" });
    expect(repo.recoverStale).toHaveBeenCalledWith(50, signal);
  });

  it("prepares create and Review through the database before materialization", async () => {
    const createRepo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [], controls }),
      heartbeat: vi.fn().mockResolvedValue({
        candidateCount: 0,
        currentRevision: 1,
        disclosureAuthorized: true,
        jobId: job.jobId,
        leaseExpiresAt: job.leaseExpiresAt,
        outcome: "authorized",
        replanCount: 0
      }),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        outcome: "created",
        replayed: false,
        revision: 1,
        replanCount: 0
      })
    });
    const createPlanner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(createPlan) };
    const createCrypto = cipher();
    vi.mocked(createCrypto.openCapture).mockResolvedValueOnce({
      controls,
      rawContent: "A thought"
    });
    expect(
      (
        await drain(createRepo, createPlanner, createCrypto).drain({
          authority,
          requestId: "r",
          signal,
          trigger: "manual"
        })
      ).completed
    ).toBe(1);
    expect(createRepo.prepareCreate).toHaveBeenCalled();

    const reviewRepo = repository({
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    const reviewPlanner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(reviewPlan) };
    expect(
      (
        await drain(reviewRepo, reviewPlanner).drain({
          authority,
          requestId: "r",
          signal,
          trigger: "manual"
        })
      ).completed
    ).toBe(1);
    expect(reviewRepo.prepareCreate).toHaveBeenCalled();
    expect(reviewRepo.prepareAppend).not.toHaveBeenCalled();
  });

  it("routes Inbox disposition to encrypted Review until the later routing milestone", async () => {
    const repo = repository({
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockResolvedValue({ ...reviewPlan, decision: "add_to_inbox", alternatives: [] })
    };
    const result = await drain(repo, planner).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "manual"
    });
    expect(result.completed).toBe(1);
    expect(repo.prepareCreate).toHaveBeenCalledOnce();
  });

  it("does not call the planner or publish when privacy changes before disclosure revalidation", async () => {
    const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(appendPlan) };
    const repo = repository({
      heartbeat: vi.fn().mockRejectedValue(new Error("candidate became private"))
    });
    const result = await drain(repo, planner).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "manual"
    });
    expect(result.failed).toBe(1);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(repo.prepareAppend).not.toHaveBeenCalled();
    expect(repo.commit).not.toHaveBeenCalled();
  });

  it("replans once when the target is edited during planning and uses a fresh reservation", async () => {
    const revisionThree = candidateAt(3);
    const repo = repository({
      candidates: vi
        .fn()
        .mockResolvedValueOnce({ candidates: [candidate], controls })
        .mockResolvedValueOnce({ candidates: [revisionThree], controls }),
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce(authorized(1, 0))
        .mockResolvedValueOnce(authorized(1, 1))
        .mockResolvedValueOnce(authorized(1, 1)),
      prepareAppend: vi
        .fn()
        .mockResolvedValueOnce({
          conflictReason: "revision",
          jobId: job.jobId,
          noteId: candidate.noteId,
          outcome: "replan",
          replayed: false,
          revision: 3,
          replanCount: 1
        })
        .mockResolvedValueOnce({ outcome: "prepared", preparation: prepared("append", 3) })
    });
    const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(appendPlan) };
    const result = await drain(repo, planner).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "manual"
    });
    expect(result.completed).toBe(1);
    expect(planner.plan).toHaveBeenCalledTimes(2);
    const reservations = vi
      .mocked(repo.prepareAppend)
      .mock.calls.map(([input]) => input.reservationId);
    expect(new Set(reservations).size).toBe(2);
    expect(vi.mocked(repo.prepareAppend).mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 3 });
  });

  it("replans after the seal-time heartbeat and can switch to a different target", async () => {
    const second = candidateAt(4, {
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FBA" as const,
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FBB" as const
    });
    const secondPlan = {
      ...appendPlan,
      destination: { candidateId: second.candidateId, newNote: null }
    };
    const repo = repository({
      candidates: vi
        .fn()
        .mockResolvedValueOnce({ candidates: [candidate], controls })
        .mockResolvedValueOnce({ candidates: [second], controls }),
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce(authorized(1, 0))
        .mockResolvedValueOnce({
          conflictReason: "revision",
          jobId: job.jobId,
          noteId: candidate.noteId,
          outcome: "replan",
          replayed: false,
          revision: 3,
          replanCount: 1
        })
        .mockResolvedValueOnce(authorized(1, 1))
        .mockResolvedValueOnce(authorized(1, 1)),
      prepareAppend: vi
        .fn()
        .mockResolvedValueOnce({ outcome: "prepared", preparation: prepared("append", 2) })
        .mockResolvedValueOnce({
          outcome: "prepared",
          preparation: { ...prepared("append", 4), noteId: second.noteId }
        })
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockResolvedValueOnce(appendPlan).mockResolvedValueOnce(secondPlan)
    };
    expect(
      (await drain(repo, planner).drain({ authority, requestId: "r", signal, trigger: "manual" }))
        .completed
    ).toBe(1);
    expect(vi.mocked(repo.prepareAppend).mock.calls[1]?.[0]).toMatchObject({
      noteId: second.noteId,
      expectedRevision: 4
    });
    expect(repo.commit).toHaveBeenCalledOnce();
  });

  it("reseals a real Review after a second pre-commit conflict", async () => {
    const revisionThree = candidateAt(3);
    const revisionFour = candidateAt(4);
    const crypto = cipher();
    const repo = repository({
      candidates: vi
        .fn()
        .mockResolvedValueOnce({ candidates: [candidate], controls })
        .mockResolvedValueOnce({ candidates: [revisionThree], controls })
        .mockResolvedValueOnce({ candidates: [revisionFour], controls }),
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce(authorized(1, 0))
        .mockResolvedValueOnce({
          conflictReason: "revision",
          jobId: job.jobId,
          noteId: candidate.noteId,
          outcome: "replan",
          replayed: false,
          revision: 3,
          replanCount: 1
        })
        .mockResolvedValueOnce(authorized(1, 1))
        .mockResolvedValueOnce({
          conflictReason: "revision",
          jobId: job.jobId,
          noteId: candidate.noteId,
          outcome: "review",
          replayed: false,
          revision: 4,
          replanCount: 1
        })
        .mockResolvedValueOnce(authorized(1, 1))
        .mockResolvedValueOnce(authorized(1, 1)),
      prepareAppend: vi
        .fn()
        .mockResolvedValueOnce({ outcome: "prepared", preparation: prepared("append", 2) })
        .mockResolvedValueOnce({ outcome: "prepared", preparation: prepared("append", 3) }),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 1
      })
    });
    const result = await drain(repo, appendPlanner, crypto).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "manual"
    });
    expect(result.completed).toBe(1);
    expect(crypto.sealCommand).toHaveBeenCalledTimes(3);
    expect(vi.mocked(crypto.sealCommand).mock.calls[2]?.[0]).toMatchObject({
      plan: { kind: "review" },
      reviewReason: "revision_conflict"
    });
    expect(vi.mocked(repo.commit).mock.calls[0]?.[0].command).toMatchObject({
      outcome: "review",
      reviewReason: "revision_conflict"
    });
    const routeReservations = vi
      .mocked(repo.prepareAppend)
      .mock.calls.map(([input]) => input.reservationId);
    const reviewReservation = vi.mocked(repo.prepareCreate).mock.calls[0]?.[0].reservationId;
    if (reviewReservation === undefined) throw new Error("Expected a Review reservation");
    expect(new Set([...routeReservations, reviewReservation]).size).toBe(3);
  });

  it("refreshes the candidate page when Review publication returns SQL review", async () => {
    const revisionThree = candidateAt(3);
    const crypto = cipher();
    const repo = repository({
      claim: vi.fn().mockResolvedValue([{ ...job, replanCount: 1 }]),
      candidates: vi
        .fn()
        .mockResolvedValueOnce({ candidates: [candidate], controls })
        .mockResolvedValueOnce({ candidates: [candidate], controls })
        .mockResolvedValueOnce({ candidates: [revisionThree], controls }),
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce(authorized(1, 1))
        .mockResolvedValueOnce(authorized(1, 1))
        .mockResolvedValueOnce({
          conflictReason: "revision",
          jobId: job.jobId,
          noteId: candidate.noteId,
          outcome: "review",
          replayed: false,
          revision: 3,
          replanCount: 1
        })
        .mockResolvedValueOnce(authorized(1, 1))
        .mockResolvedValueOnce(authorized(1, 1)),
      prepareCreate: vi.fn().mockResolvedValue({ ...prepared("create", null), replanCount: 1 }),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 1
      })
    });
    const malformedPlanner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue({}) };

    const result = await drain(repo, malformedPlanner, crypto).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "manual"
    });

    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(repo.candidates).toHaveBeenCalledTimes(3);
    expect(repo.prepareCreate).toHaveBeenCalledTimes(2);
    expect(repo.commit).toHaveBeenCalledOnce();
    const reservations = vi
      .mocked(repo.prepareCreate)
      .mock.calls.map(([input]) => input.reservationId);
    expect(new Set(reservations).size).toBe(2);
    expect(vi.mocked(repo.commit).mock.calls[0]?.[0].command).toMatchObject({
      outcome: "review",
      reviewReason: "revision_conflict"
    });
  });

  it("adopts authoritative controls changed after claim and prevents expansion", async () => {
    const currentControls = Object.freeze({
      expansionDisabled: true,
      explicitDestinationNoteId: null,
      ruleMatch: null
    });
    const repo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [candidate], controls: currentControls }),
      heartbeat: vi.fn().mockResolvedValue({ ...authorized(), replanCount: 0 }),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: candidate.noteId,
        outcome: "appended",
        replayed: false,
        revision: 3,
        replanCount: 0
      })
    });
    const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(appendPlan) };
    expect(
      (await drain(repo, planner).drain({ authority, requestId: "r", signal, trigger: "manual" }))
        .completed
    ).toBe(1);
    const plannerInput = vi.mocked(planner.plan).mock.calls[0]?.[0];
    const heartbeatInput = vi.mocked(repo.heartbeat).mock.calls[0]?.[0];
    expect(plannerInput?.controls).toEqual(currentControls);
    expect(plannerInput?.capture.controls).toEqual(currentControls);
    expect(plannerInput).toMatchObject({ promptVersion: "routing-v1", schemaVersion: 1 });
    expect(heartbeatInput?.candidateManifest.controls).toEqual(currentControls);
  });

  it.each([
    [new OrganizerProviderError("provider_key_invalid", false, 401), "provider_key_invalid", false],
    [new OrganizerProviderError("rate_limited", true, 429), "rate_limited", true],
    [new OrganizerProviderError("validation_failed", false, 422), "validation_failed", false],
    [new OrganizerProviderError("provider_unavailable", true, 503), "provider_unavailable", true]
  ] as const)("preserves typed planner failure mapping %#", async (failure, code, retryable) => {
    const repo = repository({
      fail: vi.fn().mockResolvedValue({ state: retryable ? "awaiting_retry" : "failed" })
    });
    const planner: OrganizerPlanner = { plan: vi.fn().mockRejectedValue(failure) };
    await drain(repo, planner).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "schedule"
    });
    expect(repo.fail).toHaveBeenCalledWith(expect.objectContaining({ errorCode: code, retryable }));
    expect(repo.commit).not.toHaveBeenCalled();
  });

  it("binds a BYOK 401 failure to the exact lease-resolved credential revision", async () => {
    const byok = "sk-byok-abcdefghijklmnopqrstuvwxyz0123456789";
    const providerRoute = vi.fn().mockResolvedValue({
      adapterRegistryVersion: job.adapterRegistryVersion,
      credential: byok,
      credentialRevision: 14,
      expansionStyle: job.expansionStyle,
      modelId: job.modelId,
      modelSelection: job.modelSelection,
      provider: job.selectedProvider,
      routingEffort: job.routingEffort,
      settingsRevision: job.settingsRevision,
      source: "byok"
    });
    const repo = repository({
      fail: vi.fn().mockResolvedValue({ state: "failed" }),
      providerRoute
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockImplementation((input: Parameters<OrganizerPlanner["plan"]>[0]) => {
        if (input.providerCredential === undefined) throw new Error("missing credential access");
        return input.providerCredential.use((credential) =>
          credential.withApiKey((apiKey) => {
            expect(apiKey).toBe(byok);
            return Promise.reject(new OrganizerProviderError("provider_key_invalid", false, 401));
          })
        );
      })
    };
    const result = await drain(repo, planner, cipher(), automaticPolicyContext, {
      openai: "sk-app-abcdefghijklmnopqrstuvwxyz0123456789"
    }).drain({ authority, requestId: "byok-401", signal, trigger: "schedule" });
    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1, retryScheduled: 0 });
    expect(providerRoute).toHaveBeenCalledWith({
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      signal
    });
    expect(repo.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "provider_key_invalid",
        providerCredentialRevision: 14,
        providerSource: "byok",
        retryable: false
      })
    );
    expect(repo.commit).not.toHaveBeenCalled();
  });

  it("turns a provider refusal into Review instead of a failed job", async () => {
    const repo = repository({
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockRejectedValue(new OrganizerPlannerReviewError("refusal"))
    };
    const result = await drain(repo, planner).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "schedule"
    });
    expect(result.completed).toBe(1);
    expect(repo.fail).not.toHaveBeenCalled();
    expect(repo.commit).toHaveBeenCalledOnce();
    expect(vi.mocked(repo.commit).mock.calls[0]?.[0].command.outcome).toBe("review");
  });

  it("applies deterministic list extraction before preparation and records the override", async () => {
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockResolvedValueOnce({
      controls,
      rawContent: "- milk\n- bread"
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockResolvedValue({
        ...appendPlan,
        operations: [{ type: "append_list_items", section: "Open items", items: ["eggs"] }]
      })
    };
    const repo = repository();
    const result = await drain(repo, planner, crypto).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "schedule"
    });
    expect(result.completed).toBe(1);
    expect(repo.prepareAppend).toHaveBeenCalledOnce();
    const sealedPlan = vi.mocked(crypto.sealCommand).mock.calls[0]?.[0].plan;
    expect(sealedPlan?.validatedPlan.operations).toEqual([
      { type: "append_list_items", section: "Open items", items: ["milk", "bread"] }
    ]);
    expect(sealedPlan?.validatedPlan.reasonCodes).toContain("parser_override");
  });

  it("routes a source-changing freeform plan to Review before append preparation", async () => {
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockResolvedValueOnce({
      controls,
      rawContent: "Keep this exact private sentence"
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockResolvedValue({
        ...appendPlan,
        captureKind: "freeform",
        operations: [{ type: "append_raw", content: "A rewritten sentence" }]
      })
    };
    const repo = repository({
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    const result = await drain(repo, planner, crypto).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "schedule"
    });
    expect(result.completed).toBe(1);
    expect(repo.prepareAppend).not.toHaveBeenCalled();
    expect(repo.prepareCreate).toHaveBeenCalledOnce();
    expect(vi.mocked(repo.commit).mock.calls[0]?.[0].command.outcome).toBe("review");
  });

  it.each([
    [
      "retrieval degradation",
      { ...automaticPolicyContext, deterministicRuleMatch: false, retrievalAutoEligible: false }
    ],
    [
      "score below threshold",
      {
        ...automaticPolicyContext,
        features: zeroPolicyFeatures
      }
    ]
  ] as const)("routes %s to Review before preparation", async (_label, policyContext) => {
    const crypto = cipher();
    const repo = repository({
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    const result = await drain(repo, appendPlanner, crypto, policyContext).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "schedule"
    });
    expect(result.completed).toBe(1);
    expect(repo.prepareAppend).not.toHaveBeenCalled();
    expect(vi.mocked(repo.commit).mock.calls[0]?.[0].command.outcome).toBe("review");
    const reviewed = vi.mocked(crypto.sealCommand).mock.calls.at(-1)?.[0].plan;
    const routingDecision = vi.mocked(crypto.sealCommand).mock.calls.at(-1)?.[0].routingDecision;
    if (reviewed?.kind !== "review") throw new Error("Expected a materialized review");
    expect(reviewed.alternatives).toHaveLength(1);
    expect(reviewed.alternatives[0]?.candidateId).toBe(candidate.candidateId);
    expect(reviewed.alternatives[0]?.noteId).toBe(candidate.noteId);
    expect(reviewed.validatedPlan.alternatives).toEqual([candidate.candidateId]);
    expect(reviewed.validatedPlan.captureKind).toBe("list_items");
    expect(routingDecision?.autoApply).toBe(false);
    expect(routingDecision?.band).toBe(_label === "score below threshold" ? "inbox" : "review");
  });

  it("auto-applies a high-confidence aphorism after principle syntax inference", async () => {
    const principleCandidate = candidateAt(2, { noteType: "principle" });
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockResolvedValueOnce({
      controls,
      rawContent: "Simplicity compounds"
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockResolvedValue({
        ...appendPlan,
        captureKind: "principle",
        operations: [{ type: "append_raw", content: "Simplicity compounds" }]
      })
    };
    const repo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [principleCandidate], controls }),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: principleCandidate.noteId,
        outcome: "appended",
        replayed: false,
        revision: 3,
        replanCount: 0
      })
    });
    const result = await drain(repo, planner, crypto).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "schedule"
    });
    expect(result.completed).toBe(1);
    expect(repo.prepareAppend).toHaveBeenCalledOnce();
    expect(vi.mocked(repo.commit).mock.calls[0]?.[0].command.outcome).toBe("appended");
  });

  it("never publishes after cancellation wins while the planner is returning", async () => {
    const controller = new AbortController();
    const repo = repository({
      fail: vi.fn().mockResolvedValue({ state: "awaiting_retry" })
    });
    const planner: OrganizerPlanner = {
      plan: vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.resolve(appendPlan);
      })
    };
    const result = await drain(repo, planner).drain({
      authority,
      requestId: "r",
      signal: controller.signal,
      trigger: "schedule"
    });
    expect(result.retryScheduled).toBe(1);
    expect(repo.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_unavailable", retryable: true })
    );
    expect(repo.prepareAppend).not.toHaveBeenCalled();
    expect(repo.commit).not.toHaveBeenCalled();
  });

  it("never decrypts or discloses a closed explicit target and commits Review", async () => {
    const explicitControls = Object.freeze({
      expansionDisabled: false,
      explicitDestinationNoteId: candidate.noteId,
      ruleMatch: null
    });
    const closed = Object.freeze({ ...candidate, isOpen: false });
    const crypto = cipher();
    const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(appendPlan) };
    const repo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [closed], controls: explicitControls }),
      heartbeat: vi.fn().mockResolvedValue(authorized()),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    expect(
      (
        await drain(repo, planner, crypto).drain({
          authority,
          requestId: "r",
          signal,
          trigger: "manual"
        })
      ).completed
    ).toBe(1);
    expect(crypto.openCandidate).not.toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
    expect(vi.mocked(crypto.sealCommand).mock.calls[0]?.[0]).toMatchObject({
      reviewReason: "explicit_destination_unavailable"
    });
  });

  it("publishes duplicate suspicion only as a two-note non-destructive Review", async () => {
    const second = candidateAt(5, {
      candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAK",
      noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAM"
    });
    const planned = {
      ...appendPlan,
      alternatives: [second.candidateId],
      reasonCodes: [...appendPlan.reasonCodes, "duplicate_suspected"]
    };
    const crypto = cipher();
    const repo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [candidate, second], controls }),
      heartbeat: vi.fn().mockResolvedValue(authorized(2)),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: null,
        outcome: "review",
        replayed: false,
        revision: null,
        replanCount: 0
      })
    });
    const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(planned) };

    await expect(
      drain(repo, planner, crypto).drain({
        authority,
        requestId: "duplicate-review",
        signal,
        trigger: "manual"
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 });
    expect(repo.prepareAppend).not.toHaveBeenCalled();
    expect(repo.prepareCreate).toHaveBeenCalledOnce();
    expect(vi.mocked(crypto.sealCommand).mock.calls[0]?.[0]).toMatchObject({
      plan: {
        kind: "review",
        validatedPlan: {
          alternatives: [candidate.candidateId, second.candidateId]
        }
      },
      reviewReason: "duplicate_suggestion"
    });
    expect(vi.mocked(repo.commit).mock.calls[0]?.[0].command).toMatchObject({
      generatedBlock: null,
      noteWrite: null,
      outcome: "review",
      reviewReason: "duplicate_suggestion"
    });
  });

  it.each([
    ["malformed", { unexpected: true }, "planner_ambiguity", "review"],
    [
      "enabled expansion",
      { ...appendPlan, generatedExpansion: { kind: "suggestion", text: "Try oat milk" } },
      "expansion_pending",
      "append"
    ],
    [
      "disabled expansion",
      { ...appendPlan, generatedExpansion: { kind: "suggestion", text: "Try oat milk" } },
      "planner_ambiguity",
      "review"
    ]
  ])(
    "publishes %s planner output with the required encrypted boundary",
    async (_label, planned, expectedReason, expectedKind) => {
      const selectedControls =
        _label === "disabled expansion"
          ? Object.freeze({
              expansionDisabled: true,
              explicitDestinationNoteId: null,
              ruleMatch: null
            })
          : controls;
      const crypto = cipher();
      const repo = repository({
        candidates: vi
          .fn()
          .mockResolvedValue({ candidates: [candidate], controls: selectedControls }),
        heartbeat: vi.fn().mockResolvedValue(authorized()),
        commit: vi.fn().mockResolvedValue(
          expectedKind === "append"
            ? {
                jobId: job.jobId,
                noteId: candidate.noteId,
                outcome: "appended",
                replayed: false,
                revision: candidate.revision + 1,
                replanCount: 0
              }
            : {
                jobId: job.jobId,
                noteId: null,
                outcome: "review",
                replayed: false,
                revision: null,
                replanCount: 0
              }
        )
      });
      const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(planned) };
      expect(
        (
          await drain(repo, planner, crypto).drain({
            authority,
            requestId: "r",
            signal,
            trigger: "manual"
          })
        ).completed
      ).toBe(1);
      expect(vi.mocked(crypto.sealCommand).mock.calls.at(-1)?.[0]).toMatchObject({
        plan: { kind: expectedKind },
        reviewReason: expectedReason
      });
      if (expectedKind === "append") expect(repo.prepareAppend).toHaveBeenCalledOnce();
      else expect(repo.prepareAppend).not.toHaveBeenCalled();
    }
  );

  it("derives a fresh reservation after a durable retry attempt", async () => {
    const reservations: string[] = [];
    for (const attempt of [1, 2]) {
      const retryJob = Object.freeze({ ...job, attempt });
      const repo = repository({
        claim: vi.fn().mockResolvedValue([retryJob]),
        prepareAppend: vi
          .fn()
          .mockImplementation((input: Parameters<OrganizerRepository["prepareAppend"]>[0]) => {
            reservations.push(input.reservationId);
            return Promise.resolve({ outcome: "prepared", preparation: prepared("append", 2) });
          })
      });
      expect(
        (
          await drain(repo).drain({
            authority,
            requestId: `r-${attempt}`,
            signal,
            trigger: "manual"
          })
        ).completed
      ).toBe(1);
    }
    expect(reservations).toHaveLength(2);
    expect(reservations[0]).not.toBe(reservations[1]);
  });
});

describe("closed ports and result validation", () => {
  it("rejects unavailable ports", async () => {
    await expect(
      unconfiguredDrainPort.drain({ authority, requestId: "r", signal, trigger: "manual" })
    ).rejects.toThrow("not ready");
    await expect(
      unavailableOrganizerCipher.openCapture({ authority, job, signal })
    ).rejects.toThrow("not ready");
    await expect(
      unavailableOrganizerCipher.openCandidate({
        authority,
        candidate,
        ownerId: job.ownerId,
        signal
      })
    ).rejects.toThrow("not ready");
    await expect(unavailableOrganizerCipher.sealCommand({} as never)).rejects.toThrow("not ready");
  });

  it.each([
    [{ claimed: 1, completed: 1, failed: 0, retryScheduled: 0 }, true],
    [{ claimed: 1, completed: 1, failed: 1, retryScheduled: 0 }, false],
    [{ claimed: -1, completed: 0, failed: 0, retryScheduled: 0 }, false],
    [{ claimed: 1, completed: 1, failed: 0 }, false],
    [null, false]
  ])("validates result %#", (value, expected) =>
    expect(isOrganizerDrainResult(value)).toBe(expected)
  );
});

describe("organizer drain with photos", () => {
  const encryptedPhoto = Object.freeze({
    attachmentId: "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ" as const,
    kind: "image" as const,
    mediaType: "image/jpeg" as const,
    byteLength: 6,
    width: 4,
    height: 3,
    durationMs: null,
    source: { resourceId: "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ", recordVersion: 1, cipher: {}, key: {} }
  });
  const decryptedPhoto = Object.freeze({
    attachmentId: "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ" as const,
    kind: "image" as const,
    mediaType: "image/jpeg" as const,
    dataBase64: "/9j/AAAA",
    byteLength: 6,
    width: 4,
    height: 3,
    durationMs: null
  });

  it("reads the leased capture's photos, shows them to the planner, and files them by reference", async () => {
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockResolvedValueOnce({ controls, rawContent: "A thought" });
    vi.mocked(crypto.openCaptureAttachments).mockResolvedValueOnce([decryptedPhoto]);
    const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(createPlan) };
    const repo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [], controls }),
      heartbeat: vi.fn().mockResolvedValue({
        candidateCount: 0,
        currentRevision: 1,
        disclosureAuthorized: true,
        jobId: job.jobId,
        leaseExpiresAt: job.leaseExpiresAt,
        outcome: "authorized",
        replanCount: 0
      }),
      attachments: vi.fn().mockResolvedValue([encryptedPhoto]),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        outcome: "created",
        replayed: false,
        revision: 1,
        replanCount: 0
      })
    });

    const result = await drain(repo, planner, crypto).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "schedule"
    });

    expect(result.completed).toBe(1);
    expect(repo.attachments).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.jobId, leaseToken: job.leaseToken })
    );
    expect(crypto.openCaptureAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [encryptedPhoto], job })
    );
    const plannerInput = vi.mocked(planner.plan).mock.calls[0]?.[0];
    expect(plannerInput?.capture.attachments).toEqual([decryptedPhoto]);
    // The sealed plan carries the model's operations and nothing else. The organizer's own
    // photo reference is placed by the application layer, so the plan the model authored is
    // still validated as the model's: smuggling the reference in here failed source
    // preservation for every capture with a photo, and pushed a five-operation plan past the
    // operation cap.
    const sealedPlan = vi.mocked(crypto.sealCommand).mock.calls[0]?.[0].plan;
    const modelOperations = [{ type: "append_raw", content: "A thought" }];
    expect(sealedPlan?.kind).toBe("create");
    expect(sealedPlan?.kind === "create" ? sealedPlan.operations : []).toEqual(modelOperations);
    expect(sealedPlan?.validatedPlan.operations).toEqual(modelOperations);
    const sealedCapture = vi.mocked(crypto.sealCommand).mock.calls[0]?.[0].capture;
    expect(sealedCapture?.attachments).toEqual([decryptedPhoto]);
  });

  it("does not open or reference anything when the capture has no attachments", async () => {
    const crypto = cipher();
    vi.mocked(crypto.openCapture).mockResolvedValueOnce({ controls, rawContent: "A thought" });
    const planner: OrganizerPlanner = { plan: vi.fn().mockResolvedValue(createPlan) };
    const repo = repository({
      candidates: vi.fn().mockResolvedValue({ candidates: [], controls }),
      heartbeat: vi.fn().mockResolvedValue({
        candidateCount: 0,
        currentRevision: 1,
        disclosureAuthorized: true,
        jobId: job.jobId,
        leaseExpiresAt: job.leaseExpiresAt,
        outcome: "authorized",
        replanCount: 0
      }),
      commit: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        outcome: "created",
        replayed: false,
        revision: 1,
        replanCount: 0
      })
    });

    const result = await drain(repo, planner, crypto).drain({
      authority,
      requestId: "r",
      signal,
      trigger: "schedule"
    });

    expect(result.completed).toBe(1);
    expect(crypto.openCaptureAttachments).not.toHaveBeenCalled();
    const sealedPlan = vi.mocked(crypto.sealCommand).mock.calls[0]?.[0].plan;
    expect(sealedPlan?.validatedPlan.operations).toEqual([
      { type: "append_raw", content: "A thought" }
    ]);
  });
});
