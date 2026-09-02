import {
  authorizeAggregateOwner,
  type EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";
import type { EntityId } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  EncryptedCaptureRpcAdapter,
  EncryptedGeneratedBlockRead
} from "@/server/encryption/encrypted-capture-rpc-adapter";
import type {
  EncryptedLibraryObject,
  EncryptedLibraryPage,
  EncryptedLibraryRpcStore
} from "@/server/encryption/encrypted-library-rpc-store";
import { ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";

import { EncryptedGeneratedBlockReader } from "./encrypted-generated-block-reader";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const BLOCK_A = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const BLOCK_B = "blk_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const DECISION = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const REVIEW = "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOW = "2026-09-01T12:00:00.000Z";

function row(
  blockId: EntityId<"blk">,
  noteId: EntityId<"note">
): EncryptedLibraryObject<"generated_block"> {
  return {
    surface: "generated_block",
    ownerId: OWNER,
    resourceId: blockId,
    recordVersion: 1,
    operational: {
      noteId,
      decisionId: DECISION,
      reviewItemId: REVIEW,
      kind: "suggestion",
      state: "proposed",
      stateRevision: 1,
      modelId: "gpt-test",
      promptVersion: "organizer-v1",
      resolvedAt: null,
      createdAt: NOW
    },
    encrypted: { blockId } as never,
    contentMac: null
  };
}

function reader(
  input: Readonly<{
    rows: readonly EncryptedLibraryObject<"generated_block">[];
    nextCursor?: string | null;
    resolutionRows?: readonly EncryptedGeneratedBlockRead[];
  }>
) {
  const openGeneratedBlock = vi.fn((_access, _encrypted, expected: { blockId: string }) =>
    Promise.resolve({ schemaVersion: 1 as const, content: `content:${expected.blockId}` })
  );
  const listEncryptedGeneratedBlocksForNote = vi.fn<
    () => Promise<EncryptedLibraryPage<"generated_block">>
  >(() =>
    Promise.resolve({
      surface: "generated_block" as const,
      items: input.rows,
      nextCursor: input.nextCursor ?? null
    })
  );
  const generated = row(BLOCK_A, NOTE_A);
  const source: EncryptedGeneratedBlockRead = {
    blockId: BLOCK_A,
    recordVersion: 1,
    noteId: NOTE_A,
    decisionId: DECISION,
    reviewItemId: REVIEW,
    kind: generated.operational.kind,
    state: generated.operational.state,
    stateRevision: generated.operational.stateRevision,
    modelId: generated.operational.modelId,
    promptVersion: generated.operational.promptVersion,
    resolvedAt: generated.operational.resolvedAt,
    createdAt: generated.operational.createdAt,
    contentCipher: generated.encrypted
  };
  const getGeneratedBlocks = vi.fn(() =>
    Promise.resolve(input.resolutionRows ?? Object.freeze([source]))
  );
  const instance = new EncryptedGeneratedBlockReader({
    ownerId: OWNER,
    access: authorizeAggregateOwner({
      authenticatedOwnerId: OWNER,
      resourceOwnerId: OWNER
    }),
    aggregate: { openGeneratedBlock } as unknown as EncryptedAggregateService,
    captureAdapter: {
      getGeneratedBlocks
    } as unknown as EncryptedCaptureRpcAdapter,
    store: { listEncryptedGeneratedBlocksForNote } as unknown as EncryptedLibraryRpcStore
  });
  return { instance, getGeneratedBlocks, listEncryptedGeneratedBlocksForNote, openGeneratedBlock };
}

describe("encrypted generated-block reader", () => {
  it("reads and opens only one owner-and-note-scoped page", async () => {
    const harness = reader({ rows: [row(BLOCK_A, NOTE_A)] });

    await expect(harness.instance.listForNote(NOTE_A)).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: BLOCK_A,
          noteId: NOTE_A,
          content: `content:${BLOCK_A}`,
          state: "proposed",
          stateRevision: 1
        })
      ],
      pageInfo: { hasMore: false, nextCursor: null }
    });
    expect(harness.openGeneratedBlock).toHaveBeenCalledOnce();
    expect(harness.listEncryptedGeneratedBlocksForNote).toHaveBeenCalledWith({
      ownerId: OWNER,
      noteId: NOTE_A,
      afterBlockId: null
    });
  });

  it("fails closed if the scoped database projection substitutes another note", async () => {
    const harness = reader({ rows: [row(BLOCK_B, NOTE_B)] });
    await expect(harness.instance.listForNote(NOTE_A)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    expect(harness.openGeneratedBlock).not.toHaveBeenCalled();

    const proposed = row(BLOCK_A, NOTE_A);
    const rejected: EncryptedLibraryObject<"generated_block"> = {
      ...proposed,
      operational: {
        ...proposed.operational,
        state: "rejected",
        stateRevision: 2,
        resolvedAt: NOW
      }
    };
    const retained = reader({ rows: [rejected] });
    await expect(retained.instance.listForNote(NOTE_A)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    expect(retained.openGeneratedBlock).not.toHaveBeenCalled();
  });

  it("rejects duplicate block identities instead of returning an ambiguous collection", async () => {
    const duplicate = row(BLOCK_A, NOTE_A);
    const harness = reader({ rows: [duplicate, duplicate] });

    await expect(harness.instance.listForNote(NOTE_A)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
  });

  it("returns an exact progressing cursor without opening the lookahead row", async () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      row(`blk_${String(index + 1).padStart(26, "0")}`, NOTE_A)
    );
    const nextCursor = rows.at(-1)?.resourceId ?? null;
    const harness = reader({ rows, nextCursor });

    const page = await harness.instance.listForNote(NOTE_A);
    expect(page.items).toHaveLength(50);
    expect(page.pageInfo).toEqual({ hasMore: true, nextCursor });
    expect(harness.openGeneratedBlock).toHaveBeenCalledTimes(50);
    expect(harness.listEncryptedGeneratedBlocksForNote).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-progressing or partial-page continuation cursor", async () => {
    const partial = reader({ rows: [row(BLOCK_A, NOTE_A)], nextCursor: BLOCK_A });
    await expect(partial.instance.listForNote(NOTE_A)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });

    const rows = Array.from({ length: 50 }, (_, index) =>
      row(`blk_${String(index + 1).padStart(26, "0")}`, NOTE_A)
    );
    const stale = reader({ rows, nextCursor: rows.at(-1)?.resourceId ?? null });
    await expect(stale.instance.listForNote(NOTE_A, `blk_${"Z".repeat(26)}`)).rejects.toMatchObject(
      { code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE }
    );
  });

  it("loads one exact block with its Review binding for atomic resolution", async () => {
    const harness = reader({ rows: [] });

    await expect(harness.instance.get(BLOCK_A)).resolves.toMatchObject({
      block: { id: BLOCK_A, noteId: NOTE_A, stateRevision: 1 },
      source: { blockId: BLOCK_A, reviewItemId: REVIEW },
      payload: { content: `content:${BLOCK_A}` }
    });
  });

  it("finds an optional exact block without scanning note pages", async () => {
    const found = reader({ rows: [] });
    await expect(found.instance.find(BLOCK_A)).resolves.toMatchObject({
      block: { id: BLOCK_A, noteId: NOTE_A }
    });
    expect(found.listEncryptedGeneratedBlocksForNote).not.toHaveBeenCalled();

    const missing = reader({ rows: [], resolutionRows: [] });
    await expect(missing.instance.find(BLOCK_A)).resolves.toBeNull();
    await expect(missing.instance.get(BLOCK_A)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
  });

  it("fails closed on duplicate or substituted exact-block rows", async () => {
    const base = reader({ rows: [] });
    const source = (await base.instance.find(BLOCK_A))?.source;
    expect(source).toBeDefined();
    if (source === undefined) throw new TypeError("missing fixture source");

    const duplicate = reader({ rows: [], resolutionRows: [source, source] });
    await expect(duplicate.instance.find(BLOCK_A)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    const substituted = reader({
      rows: [],
      resolutionRows: [{ ...source, blockId: BLOCK_B }]
    });
    await expect(substituted.instance.find(BLOCK_A)).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });

    const retained = reader({
      rows: [],
      resolutionRows: [{ ...source, state: "rejected", stateRevision: 2, resolvedAt: NOW }]
    });
    await expect(retained.instance.find(BLOCK_A)).resolves.toMatchObject({
      block: { id: BLOCK_A, state: "rejected", stateRevision: 2 }
    });
  });
});
