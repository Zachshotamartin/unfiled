import {
  DecisionCorrectionResponseSchema,
  GeneratedBlockDetailResponseSchema,
  GeneratedBlockListResponseSchema,
  GeneratedBlockResolveResponseSchema,
  MutationBatchUndoResponseSchema,
  ReviewResolveResponseSchema,
  VisibleGeneratedBlockDtoSchema,
  manualNoteFixtures,
  type DecisionCorrectionRequest,
  type DecisionCorrectionResponse,
  type GeneratedBlockResolveRequest,
  type GeneratedBlockResolveResponse,
  type MutationBatchUndoResponse,
  type MutationUndoRequest,
  type ReviewResolveRequest,
  type ReviewResolveResponse
} from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequest } from "@/server/auth/session";
import { HttpError } from "@/server/api/errors";
import type { OwnerInteractionRepository } from "@/server/owner-interactions/repository";

import { createOwnerInteractionHandlers } from "./owner-interaction-handlers";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const DECISION_ID = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const REVIEW_ID = "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const BLOCK_ID = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_A = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_B = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const NOW = "2026-09-01T18:30:00.000Z";

const correctionRequest: DecisionCorrectionRequest = {
  idempotencyKey: "corr-01",
  source: { noteId: NOTE_A, expectedRevision: 4 },
  destination: { type: "existing_note", noteId: NOTE_B, expectedRevision: 2 }
};

const correctionResponse: DecisionCorrectionResponse = {
  outcome: "applied",
  decisionId: DECISION_ID,
  source: { noteId: NOTE_A, currentRevision: 5, mutationId: MUTATION_A },
  destination: {
    type: "existing_note",
    noteId: NOTE_B,
    currentRevision: 3,
    mutationId: MUTATION_B
  },
  replayed: false
};

const reviewRequest: ReviewResolveRequest = {
  idempotencyKey: "resolve-01",
  resolution: { type: "route", noteId: NOTE_B, expectedRevision: 2 }
};

const reviewResponse: ReviewResolveResponse = {
  reviewItem: {
    id: REVIEW_ID,
    captureId: null,
    noteId: NOTE_A,
    type: "structure_conflict",
    proposal: { type: "conflict", reason: "structure" },
    state: "resolved",
    resolution: reviewRequest.resolution,
    createdAt: NOW,
    resolvedAt: NOW
  },
  replayed: false
};

const mutation = manualNoteFixtures.mutationResult;
const batchRequest: MutationUndoRequest = {
  expectedRevision: mutation.note.currentRevision,
  idempotencyKey: "undo-01"
};
const batchResponse: MutationBatchUndoResponse = {
  members: [
    {
      note: mutation.note,
      revision: mutation.revision,
      mutationId: mutation.mutationId,
      undo: { eligible: false, expiresAt: null }
    }
  ],
  replayed: false
};

const proposedBlock = VisibleGeneratedBlockDtoSchema.parse({
  id: BLOCK_ID,
  noteId: NOTE_A,
  decisionId: DECISION_ID,
  kind: "suggestion" as const,
  content: "A separate encrypted suggestion",
  state: "proposed" as const,
  stateRevision: 1,
  modelId: "gpt-test",
  promptVersion: "organizer-v1",
  createdAt: NOW,
  resolvedAt: null
});

const blockResolveRequest: GeneratedBlockResolveRequest = {
  expectedStateRevision: 1,
  idempotencyKey: "block-resolve-01",
  resolution: "accept" as const
};

const blockResolveResponse: GeneratedBlockResolveResponse = {
  block: { ...proposedBlock, state: "accepted" as const, stateRevision: 2, resolvedAt: NOW },
  replayed: false
};

function authenticated(): Promise<AuthenticatedRequest> {
  return Promise.resolve({
    accessToken: "test-access-token",
    cookies: ["refreshed=true; HttpOnly"],
    user: { id: USER_ID, email: "person@example.com" }
  });
}

function request(
  path: string,
  body: Readonly<Record<string, unknown>>,
  headerKey = body.idempotencyKey
): Request {
  return new Request(`https://unfiled.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(typeof headerKey === "string" ? { "idempotency-key": headerKey } : {})
    }
  });
}

type RepositoryOverrides = Partial<{
  [Key in keyof OwnerInteractionRepository]: OwnerInteractionRepository[Key];
}>;

function repository(overrides: RepositoryOverrides = {}) {
  return {
    listGeneratedBlocks: vi.fn<OwnerInteractionRepository["listGeneratedBlocks"]>(
      overrides.listGeneratedBlocks ??
        (() => Promise.resolve({ items: [], pageInfo: { hasMore: false, nextCursor: null } }))
    ),
    getGeneratedBlock: vi.fn<OwnerInteractionRepository["getGeneratedBlock"]>(
      overrides.getGeneratedBlock ?? (() => Promise.resolve({ block: proposedBlock }))
    ),
    resolveGeneratedBlock: vi.fn<OwnerInteractionRepository["resolveGeneratedBlock"]>(
      overrides.resolveGeneratedBlock ?? (() => Promise.resolve(blockResolveResponse))
    ),
    correctDecision: vi.fn<OwnerInteractionRepository["correctDecision"]>(
      overrides.correctDecision ?? (() => Promise.resolve(correctionResponse))
    ),
    resolveReviewItem: vi.fn<OwnerInteractionRepository["resolveReviewItem"]>(
      overrides.resolveReviewItem ?? (() => Promise.resolve(reviewResponse))
    ),
    undoMutationBatch: vi.fn<OwnerInteractionRepository["undoMutationBatch"]>(
      overrides.undoMutationBatch ?? (() => Promise.resolve(batchResponse))
    )
  };
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

describe("owner interaction route handlers", () => {
  it("corrects a decision through the authenticated owner repository", async () => {
    const ownerRepository = repository();
    const scheduleIndexDrain = vi.fn();
    const handlers = createOwnerInteractionHandlers({
      authenticate: authenticated,
      repository: ownerRepository,
      scheduleIndexDrain
    });
    const response = await handlers.correctDecision(
      request(`/api/v1/decisions/${DECISION_ID}/correct`, correctionRequest),
      { decisionId: DECISION_ID }
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(DecisionCorrectionResponseSchema.safeParse(body).success).toBe(true);
    expect(ownerRepository.correctDecision).toHaveBeenCalledWith(
      { accessToken: "test-access-token", userId: USER_ID },
      DECISION_ID,
      correctionRequest
    );
    expect(scheduleIndexDrain).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toContain("refreshed=true");
    expectPrivate(response);
  });

  it("resolves Review and undoes the complete server-derived batch", async () => {
    const ownerRepository = repository();
    const handlers = createOwnerInteractionHandlers({
      authenticate: authenticated,
      repository: ownerRepository,
      scheduleIndexDrain: vi.fn()
    });
    const resolved = await handlers.resolveReviewItem(
      request(`/api/v1/review-items/${REVIEW_ID}/resolve`, reviewRequest),
      { reviewItemId: REVIEW_ID }
    );
    const undone = await handlers.undoMutationBatch(
      request(`/api/v1/mutation-batches/${MUTATION_A}/undo`, batchRequest),
      { mutationId: MUTATION_A }
    );
    const resolvedBody: unknown = await resolved.json();
    const undoneBody: unknown = await undone.json();

    expect(ReviewResolveResponseSchema.safeParse(resolvedBody).success).toBe(true);
    expect(MutationBatchUndoResponseSchema.safeParse(undoneBody).success).toBe(true);
    expect(ownerRepository.resolveReviewItem).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      REVIEW_ID,
      reviewRequest
    );
    expect(ownerRepository.undoMutationBatch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      MUTATION_A,
      batchRequest
    );
    expectPrivate(resolved);
    expectPrivate(undone);
  });

  it("lists and atomically resolves generated blocks without scheduling note indexing", async () => {
    const ownerRepository = repository({
      listGeneratedBlocks: vi.fn(() =>
        Promise.resolve({
          items: [proposedBlock],
          pageInfo: { hasMore: false, nextCursor: null }
        })
      )
    });
    const scheduleIndexDrain = vi.fn();
    const handlers = createOwnerInteractionHandlers({
      authenticate: authenticated,
      repository: ownerRepository,
      scheduleIndexDrain
    });
    const listed = await handlers.listGeneratedBlocks(
      new Request(
        `https://unfiled.test/api/v1/notes/${NOTE_A}/generated-blocks?cursor=${BLOCK_ID}`
      ),
      { noteId: NOTE_A }
    );
    const loaded = await handlers.getGeneratedBlock(
      new Request(`https://unfiled.test/api/v1/generated-blocks/${BLOCK_ID}`),
      { blockId: BLOCK_ID }
    );
    const resolved = await handlers.resolveGeneratedBlock(
      request(`/api/v1/generated-blocks/${BLOCK_ID}/resolve`, blockResolveRequest),
      { blockId: BLOCK_ID }
    );

    expect(GeneratedBlockListResponseSchema.safeParse(await listed.json()).success).toBe(true);
    expect(GeneratedBlockDetailResponseSchema.safeParse(await loaded.json()).success).toBe(true);
    expect(GeneratedBlockResolveResponseSchema.safeParse(await resolved.json()).success).toBe(true);
    expect(ownerRepository.listGeneratedBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      NOTE_A,
      { cursor: BLOCK_ID }
    );
    expect(ownerRepository.getGeneratedBlock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      BLOCK_ID
    );
    expect(ownerRepository.resolveGeneratedBlock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      BLOCK_ID,
      blockResolveRequest
    );
    expect(scheduleIndexDrain).not.toHaveBeenCalled();
    expectPrivate(listed);
    expectPrivate(loaded);
    expectPrivate(resolved);
  });

  it("rejects unknown, duplicate, and malformed generated-block cursors before storage", async () => {
    const ownerRepository = repository();
    const handlers = createOwnerInteractionHandlers({
      authenticate: authenticated,
      repository: ownerRepository
    });
    const requests = [
      `https://unfiled.test/api/v1/notes/${NOTE_A}/generated-blocks?limit=50`,
      `https://unfiled.test/api/v1/notes/${NOTE_A}/generated-blocks?cursor=${BLOCK_ID}&cursor=${BLOCK_ID}`,
      `https://unfiled.test/api/v1/notes/${NOTE_A}/generated-blocks?cursor=nope`
    ];

    for (const url of requests) {
      const response = await handlers.listGeneratedBlocks(new Request(url), { noteId: NOTE_A });
      expect(response.status).toBe(400);
      expectPrivate(response);
    }
    expect(ownerRepository.listGeneratedBlocks).not.toHaveBeenCalled();
  });

  it("rejects malformed identifiers and mismatched idempotency before storage", async () => {
    const ownerRepository = repository();
    const handlers = createOwnerInteractionHandlers({
      authenticate: authenticated,
      repository: ownerRepository
    });
    const malformed = await handlers.correctDecision(
      request("/api/v1/decisions/nope/correct", correctionRequest),
      { decisionId: "nope" }
    );
    const mismatch = await handlers.resolveReviewItem(
      request(`/api/v1/review-items/${REVIEW_ID}/resolve`, reviewRequest, "different-key-01"),
      { reviewItemId: REVIEW_ID }
    );

    expect(malformed.status).toBe(400);
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      code: "invalid_idempotency_key"
    });
    expect(ownerRepository.correctDecision).not.toHaveBeenCalled();
    expect(ownerRepository.resolveReviewItem).not.toHaveBeenCalled();
    expectPrivate(malformed);
    expectPrivate(mismatch);
  });

  it("keeps persisted conflict errors private and does not schedule note indexing", async () => {
    const ownerRepository = repository({
      undoMutationBatch: vi
        .fn()
        .mockRejectedValue(
          new HttpError(
            409,
            "conflict_requires_review",
            "Review this change before editing the note."
          )
        )
    });
    const scheduleIndexDrain = vi.fn();
    const handlers = createOwnerInteractionHandlers({
      authenticate: authenticated,
      repository: ownerRepository,
      scheduleIndexDrain
    });
    const response = await handlers.undoMutationBatch(
      request(`/api/v1/mutation-batches/${MUTATION_A}/undo`, batchRequest),
      { mutationId: MUTATION_A }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "conflict_requires_review"
    });
    expect(scheduleIndexDrain).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it("uses a request-scoped production-style repository factory", async () => {
    const ownerRepository = repository();
    const factory = vi.fn(() => ownerRepository);
    const handlers = createOwnerInteractionHandlers({
      authenticate: authenticated,
      repository: factory,
      scheduleIndexDrain: vi.fn()
    });
    const incoming = request(`/api/v1/decisions/${DECISION_ID}/correct`, correctionRequest);

    await handlers.correctDecision(incoming, { decisionId: DECISION_ID });

    expect(factory).toHaveBeenCalledWith(incoming);
  });

  it("keeps unsupported-method responses private and bodyless", async () => {
    const response = createOwnerInteractionHandlers({
      authenticate: authenticated,
      repository: repository()
    }).methodNotAllowed("POST");

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("content-type")).toBeNull();
    expectPrivate(response);
    await expect(response.text()).resolves.toBe("");
  });
});
