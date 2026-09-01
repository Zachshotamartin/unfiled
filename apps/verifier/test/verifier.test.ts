import { describe, expect, it, vi } from "vitest";

import {
  RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS,
  RAG_GENERATION_VERIFICATION_NOTE_CAPACITY
} from "@unfiled/contracts";

import type {
  BuildingGeneration,
  BuildingGenerationPage,
  BuildingIndexItem,
  GenerationVerificationRepository,
  VerifierDatabaseIdentityProof
} from "../src/database";
import {
  RAG_VERIFICATION_MAX_PAGES,
  RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET,
  RAG_VERIFICATION_PAGE_LIMIT
} from "../src/capacity";
import { createGenerationVerifier } from "../src/verifier";
import {
  GENERATION_ID,
  OWNER_ID,
  buildingItem,
  buildingPage,
  generation,
  verification,
  verifiedGeneration
} from "./fixtures";

const keys = { keyFor: () => Promise.reject(new Error("unused by mocked opener")) };
const signal = new AbortController().signal;
const target = { ownerId: OWNER_ID, generationId: GENERATION_ID, revisionToken: "4" } as const;
const identityProof = Object.freeze({}) as VerifierDatabaseIdentityProof;

function repositoryFor(pages: readonly BuildingGenerationPage[]): {
  attest: ReturnType<typeof vi.fn<GenerationVerificationRepository["attest"]>>;
  preflight: ReturnType<typeof vi.fn<GenerationVerificationRepository["preflight"]>>;
  read: ReturnType<typeof vi.fn<GenerationVerificationRepository["readBuildingPage"]>>;
  release: ReturnType<typeof vi.fn<GenerationVerificationRepository["release"]>>;
  repository: GenerationVerificationRepository;
} {
  let index = 0;
  const read = vi.fn<GenerationVerificationRepository["readBuildingPage"]>(() => {
    const page = pages[index];
    index += 1;
    return page === undefined
      ? Promise.reject(new Error("unexpected page read"))
      : Promise.resolve(page);
  });
  const attest = vi.fn<GenerationVerificationRepository["attest"]>(() =>
    Promise.resolve(verifiedGeneration())
  );
  const preflight = vi.fn<GenerationVerificationRepository["preflight"]>(() =>
    Promise.resolve(identityProof)
  );
  const release = vi.fn<GenerationVerificationRepository["release"]>();
  return {
    attest,
    preflight,
    read,
    release,
    repository: {
      preflight,
      readBuildingPage: read,
      attest,
      release
    }
  };
}

function configured(
  repository: GenerationVerificationRepository,
  overrides: Partial<Parameters<typeof createGenerationVerifier>[0]> = {}
) {
  return createGenerationVerifier({
    decryptConcurrency: 2,
    opener: {
      validate: () => Promise.resolve()
    },
    repository,
    ...overrides
  });
}

describe("generation verifier", () => {
  it("strictly opens every row before submitting the DB attestation", async () => {
    const page = await buildingPage();
    const { repository, attest, preflight, read, release } = repositoryFor([page]);
    const result = await configured(repository).verify(target, keys, signal);
    expect(result).toEqual({
      generationId: GENERATION_ID,
      revisionToken: "4",
      verified: true,
      verifiedNoteCount: 1
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith(signal);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[1]).toBe(identityProof);
    expect(attest).toHaveBeenCalledWith({ ...target, signal, verification }, identityProof);
    expect(release).toHaveBeenCalledWith(identityProof);
  });

  it("pages one stable generation and preserves deterministic ordering across pages", async () => {
    const firstItem = await buildingItem();
    const secondItem: BuildingIndexItem = {
      ...firstItem,
      indexId: "irw_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
    };
    const twoGeneration: BuildingGeneration = {
      ...generation,
      expectedNoteCount: 2,
      indexedNoteCount: 2
    };
    const pages: BuildingGenerationPage[] = [
      {
        generation: twoGeneration,
        items: [firstItem],
        ownerId: OWNER_ID,
        page: {
          ciphertextByteBudget: 8_388_608,
          ciphertextBytes: firstItem.encryptedByteLength,
          hasMore: true,
          limit: 50,
          nextCursor: {
            generationId: GENERATION_ID,
            revisionToken: "4",
            afterIndexId: firstItem.indexId
          },
          returnedCount: 1
        },
        verification: null
      },
      {
        generation: twoGeneration,
        items: [secondItem],
        ownerId: OWNER_ID,
        page: {
          ciphertextByteBudget: 8_388_608,
          ciphertextBytes: secondItem.encryptedByteLength,
          hasMore: false,
          limit: 50,
          nextCursor: null,
          returnedCount: 1
        },
        verification
      }
    ];
    const { repository, read, attest } = repositoryFor(pages);
    attest.mockResolvedValue({ ...verifiedGeneration(), verifiedNoteCount: 2 });
    await expect(configured(repository).verify(target, keys, signal)).resolves.toMatchObject({
      verifiedNoteCount: 2
    });
    expect(read.mock.calls[1]?.[0].cursor).toEqual(pages[0]?.page.nextCursor);
  });

  it("bounds decrypt concurrency and settles the full active batch before failing", async () => {
    const base = await buildingItem();
    const items = Array.from({ length: 4 }, (_, index) => ({
      ...base,
      indexId: `irw_${String(index).padStart(26, "0")}`,
      noteId: `note_${String(index).padStart(26, "0")}`
    }));
    const page: BuildingGenerationPage = {
      generation: { ...generation, expectedNoteCount: 4, indexedNoteCount: 4 },
      items,
      ownerId: OWNER_ID,
      page: {
        ciphertextByteBudget: 8_388_608,
        ciphertextBytes: items.reduce((sum, item) => sum + item.encryptedByteLength, 0),
        hasMore: false,
        limit: 50,
        nextCursor: null,
        returnedCount: 4
      },
      verification
    };
    const { repository, attest, release } = repositoryFor([page]);
    let active = 0;
    let maximum = 0;
    let settled = 0;
    const opener = {
      async validate(_owner: string, _generation: unknown, item: BuildingIndexItem) {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        settled += 1;
        if (item === items[1]) throw new Error("invalid-row");
      }
    };
    await expect(configured(repository, { opener }).verify(target, keys, signal)).rejects.toThrow(
      "invalid-row"
    );
    expect(maximum).toBe(2);
    expect(settled).toBe(2);
    expect(attest).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(identityProof);
  });

  it("accepts four distinct key records and rejects a fifth before opening the page", async () => {
    const base = await buildingItem();
    const makeItems = (count: number): BuildingIndexItem[] =>
      Array.from({ length: count }, (_value, index) => {
        const suffix = String(index + 1).padStart(26, "0");
        const keyId = `key-${String(index + 1)}`;
        return {
          ...base,
          cipher: { ...base.cipher, keyId },
          indexId: `irw_${suffix}`,
          keyRecord: { ...base.keyRecord, keyId },
          noteId: `note_${suffix}`
        };
      });
    const pageFor = (items: readonly BuildingIndexItem[]): BuildingGenerationPage => ({
      generation: {
        ...generation,
        expectedNoteCount: items.length,
        indexedNoteCount: items.length
      },
      items,
      ownerId: OWNER_ID,
      page: {
        ciphertextByteBudget: 8_388_608,
        ciphertextBytes: items.reduce((sum, item) => sum + item.encryptedByteLength, 0),
        hasMore: false,
        limit: 50,
        nextCursor: null,
        returnedCount: items.length
      },
      verification
    });
    const atLimitItems = makeItems(RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS);
    const atLimit = repositoryFor([pageFor(atLimitItems)]);
    atLimit.attest.mockResolvedValue({
      ...verifiedGeneration(),
      verifiedNoteCount: atLimitItems.length
    });
    const validateAtLimit = vi.fn(() => Promise.resolve());
    await expect(
      configured(atLimit.repository, { opener: { validate: validateAtLimit } }).verify(
        target,
        keys,
        signal
      )
    ).resolves.toMatchObject({ verifiedNoteCount: atLimitItems.length });
    expect(validateAtLimit).toHaveBeenCalledTimes(RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS);

    const overLimitItems = makeItems(RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS + 1);
    const overLimit = repositoryFor([pageFor(overLimitItems)]);
    const validateOverLimit = vi.fn(() => Promise.resolve());
    await expect(
      configured(overLimit.repository, { opener: { validate: validateOverLimit } }).verify(
        target,
        keys,
        signal
      )
    ).rejects.toMatchObject({ code: "generation_invalid" });
    expect(validateOverLimit).not.toHaveBeenCalled();
    expect(overLimit.attest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "incomplete counts",
      (page: BuildingGenerationPage) => ({
        ...page,
        generation: { ...page.generation, indexedNoteCount: 0 }
      })
    ],
    [
      "over capacity",
      (page: BuildingGenerationPage) => ({
        ...page,
        generation: { ...page.generation, expectedNoteCount: 1_601, indexedNoteCount: 1_601 }
      })
    ],
    [
      "duplicate note",
      (page: BuildingGenerationPage) => {
        const item = page.items[0];
        if (item === undefined) throw new Error("expected fixture item");
        return {
          ...page,
          items: [item, { ...item, indexId: "irw_01J6M9Q7G4BMKB33GSG3NJ6D1Y" }],
          generation: { ...page.generation, expectedNoteCount: 2, indexedNoteCount: 2 }
        };
      }
    ],
    [
      "excess row",
      (page: BuildingGenerationPage) => ({
        ...page,
        generation: { ...page.generation, expectedNoteCount: 0, indexedNoteCount: 0 }
      })
    ]
  ])("does not attest %s", async (_label, mutate) => {
    const page = mutate(await buildingPage());
    const { repository, attest } = repositoryFor([page]);
    await expect(configured(repository).verify(target, keys, signal)).rejects.toMatchObject({
      code: "generation_invalid"
    });
    expect(attest).not.toHaveBeenCalled();
  });

  it("rejects generation/attestation drift, page overflow, and malformed attestation result", async () => {
    const first = await buildingPage();
    const firstItem = first.items[0];
    if (firstItem === undefined) throw new Error("expected fixture item");
    const continued: BuildingGenerationPage = {
      ...first,
      verification: null,
      page: {
        ...first.page,
        hasMore: true,
        nextCursor: {
          generationId: GENERATION_ID,
          revisionToken: "4",
          afterIndexId: firstItem.indexId
        }
      }
    };
    for (const pages of [
      [continued, { ...first, generation: { ...first.generation, embeddingModelId: "changed" } }],
      [{ ...continued, verification }, first],
      [{ ...first, verification: null }]
    ]) {
      const { repository, attest } = repositoryFor(pages);
      await expect(configured(repository).verify(target, keys, signal)).rejects.toMatchObject({
        code: "generation_invalid"
      });
      expect(attest).not.toHaveBeenCalled();
    }

    const overflow = repositoryFor(
      Array.from({ length: RAG_VERIFICATION_MAX_PAGES }, () => ({
        ...continued,
        items: []
      }))
    );
    await expect(
      configured(overflow.repository).verify(target, keys, signal)
    ).rejects.toMatchObject({ code: "generation_invalid" });

    const mismatched = repositoryFor([first]);
    mismatched.attest.mockResolvedValue({ ...verifiedGeneration(), embeddingDimensions: 4 });
    await expect(
      configured(mismatched.repository).verify(target, keys, signal)
    ).rejects.toMatchObject({ code: "generation_invalid" });
  });

  it("fails closed before work on invalid options or an aborted request", async () => {
    const { repository } = repositoryFor([await buildingPage()]);
    expect(() => configured(repository, { decryptConcurrency: 0 })).toThrow();
    expect(
      RAG_VERIFICATION_MAX_PAGES *
        Math.floor(RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET / 262_160)
    ).toBeGreaterThanOrEqual(RAG_GENERATION_VERIFICATION_NOTE_CAPACITY);
    expect(RAG_VERIFICATION_MAX_PAGES).toBe(33);
    expect(RAG_GENERATION_VERIFICATION_NOTE_CAPACITY).toBe(1_000);
    expect(RAG_VERIFICATION_PAGE_LIMIT).toBe(50);
    const controller = new AbortController();
    controller.abort();
    await expect(
      configured(repository).verify(target, keys, controller.signal)
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});
