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
  type OrganizerRepository
} from "../src/drain.js";
import { OrganizerUnavailableError } from "../src/errors.js";
import type { OrganizerKeyAuthority } from "../src/key-management.js";
import type { OrganizerPlanner } from "../src/planner.js";

const signal = new AbortController().signal;
const authority = {} as OrganizerKeyAuthority;
const controls = Object.freeze({ expansionDisabled: false, explicitDestinationNoteId: null });
const job: ClaimedOrganizerJob = Object.freeze({
  attempt: 1,
  captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  controls,
  jobId: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  leaseExpiresAt: "2026-08-31T20:00:00.000Z",
  leaseToken: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  promptVersion: "organization-v1",
  replanCount: 0,
  schemaVersion: 1,
  source: {
    resourceId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    recordVersion: 1,
    cipher: {},
    key: {}
  }
});
const candidate = Object.freeze({
  candidateId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB" as const,
  isOpen: true,
  noteId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const,
  noteType: "list" as const,
  revision: 2,
  source: {
    resourceId: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    recordVersion: 2,
    cipher: {},
    key: {}
  }
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
            title: "Shopping"
          })
      ),
    sealCommand: vi
      .fn()
      .mockImplementation(({ plan, reviewReason }: Parameters<OrganizerCipher["sealCommand"]>[0]) =>
        Promise.resolve({
          decision: { sealed: true },
          noteWrite: plan.kind === "review" ? null : { sealed: true },
          outcome:
            plan.kind === "append" ? "appended" : plan.kind === "create" ? "created" : "review",
          receipt: { sealed: true },
          review: { sealed: true },
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

function drain(repo: OrganizerRepository, planner = appendPlanner, crypto = cipher()) {
  return createOrganizerDrain({
    cipher: crypto,
    claimLimit: 2,
    concurrency: 2,
    leaseSeconds: 120,
    planner,
    recoveryLimit: 50,
    repository: repo,
    workerId: "organizer-test"
  });
}

describe("organizer drain", () => {
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
    expect(
      (
        await drain(createRepo, createPlanner).drain({
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
      explicitDestinationNoteId: null
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
    expect(heartbeatInput?.candidateManifest.controls).toEqual(currentControls);
  });

  it("never decrypts or discloses a closed explicit target and commits Review", async () => {
    const explicitControls = Object.freeze({
      expansionDisabled: false,
      explicitDestinationNoteId: candidate.noteId
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

  it.each([
    ["malformed", { unexpected: true }, "planner_ambiguity"],
    [
      "enabled expansion",
      { ...appendPlan, generatedExpansion: { kind: "suggestion", text: "Try oat milk" } },
      "expansion_pending"
    ],
    [
      "disabled expansion",
      { ...appendPlan, generatedExpansion: { kind: "suggestion", text: "Try oat milk" } },
      "planner_ambiguity"
    ]
  ])("routes %s planner output to encrypted Review", async (_label, planned, expectedReason) => {
    const selectedControls =
      _label === "disabled expansion"
        ? Object.freeze({ expansionDisabled: true, explicitDestinationNoteId: null })
        : controls;
    const crypto = cipher();
    const repo = repository({
      candidates: vi
        .fn()
        .mockResolvedValue({ candidates: [candidate], controls: selectedControls }),
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
      plan: { kind: "review" },
      reviewReason: expectedReason
    });
    expect(repo.prepareAppend).not.toHaveBeenCalled();
  });

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
