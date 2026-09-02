import type { EntityId } from "@unfiled/contracts";
import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import { describe, expect, it, vi } from "vitest";

import { ServiceRpcErrorCode, type ServiceRpcClient } from "@/server/encryption/service-rpc-client";

import { createNoteContextRpcAdapter } from "./note-context-rpc-adapter";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"note">;
const SOURCE_NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as EntityId<"note">;
const CAPTURE_A = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as EntityId<"cap">;
const CAPTURE_B = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"cap">;
const MUTATION_A = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as EntityId<"mut">;
const MUTATION_B = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"mut">;
const LINK = "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"lnk">;

type TestKeyClass = "ai_assisted" | "private_manual";

function keyId(keyClass: TestKeyClass, purpose: "content_mac" | "object_wrap"): string {
  return `key_${keyClass}_${purpose}_v1`;
}

function cipher(
  kind: "capture" | "note_content",
  resourceId: string,
  recordVersion: number,
  keyClass: TestKeyClass,
  ownerId = OWNER
) {
  const envelope: ContentEnvelopeV1 = {
    version: 1,
    suite: "A256GCM",
    keyId: keyId(keyClass, "object_wrap"),
    context: { tenantId: ownerId, resourceId, recordVersion, kind },
    wrappedDataKey: { nonce: "A".repeat(16), ciphertext: "A".repeat(64) },
    payload: { nonce: "A".repeat(16), ciphertext: "A".repeat(22) }
  };
  return {
    envelope,
    keyId: keyId(keyClass, "object_wrap"),
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion: 1
  };
}

function mac(keyClass: TestKeyClass) {
  return {
    mac: "a".repeat(64),
    keyId: keyId(keyClass, "content_mac"),
    keyClass,
    keyPurpose: "content_mac",
    keyVersion: 1
  };
}

function sourceRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    captureId: CAPTURE_A,
    mutationId: MUTATION_A,
    relation: "routed",
    insertedItemIds: ["itm_01J6M9Q7G4BMKB33GSG3NJ6D1X"],
    createdAt: "2026-09-01T20:00:00+00:00",
    source: "web",
    clientCreatedAt: "2026-09-01T19:59:00+00:00",
    contentLength: 4,
    privacy: "ai_assisted",
    contentCipher: cipher("capture", CAPTURE_A, 1, "ai_assisted"),
    contentMac: mac("ai_assisted"),
    ...overrides
  };
}

function backlinkRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    linkId: LINK,
    fromNoteId: SOURCE_NOTE,
    fromNoteRevision: 3,
    linkType: "reference",
    createdAt: "2026-09-01T20:00:00+00:00",
    fromPrivacy: "private_manual",
    fromContentCipher: cipher("note_content", SOURCE_NOTE, 3, "private_manual"),
    ...overrides
  };
}

describe("note-context RPC adapter", () => {
  it("sends the exact owner, target revision, keyset, and bounded source request", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>().mockResolvedValue({
      noteId: NOTE,
      currentRevision: 7,
      items: [sourceRow()]
    });
    const adapter = createNoteContextRpcAdapter({ rpc });
    const result = await adapter.listSources({
      ownerId: OWNER.toUpperCase(),
      noteId: NOTE,
      expectedNoteRevision: 7,
      after: {
        createdAt: "2026-09-01T21:00:00.000Z",
        captureId: CAPTURE_B,
        mutationId: MUTATION_B
      },
      limit: 31
    });

    expect(result.items[0]).toMatchObject({
      captureId: CAPTURE_A,
      relation: "routed",
      createdAt: "2026-09-01T20:00:00.000Z"
    });
    expect(rpc).toHaveBeenCalledWith("list_encrypted_note_sources", {
      p_owner_id: OWNER,
      p_note_id: NOTE,
      p_expected_note_revision: 7,
      p_after_created_at: "2026-09-01T21:00:00.000Z",
      p_after_capture_id: CAPTURE_B,
      p_after_mutation_id: MUTATION_B,
      p_limit: 31
    });
  });

  it("parses current backlink metadata without accepting a cross-target page", async () => {
    const rpc = vi
      .fn<ServiceRpcClient["rpc"]>()
      .mockResolvedValueOnce({ noteId: NOTE, currentRevision: 2, items: [backlinkRow()] })
      .mockResolvedValueOnce({ noteId: SOURCE_NOTE, currentRevision: 2, items: [] });
    const adapter = createNoteContextRpcAdapter({ rpc });

    await expect(
      adapter.listBacklinks({ ownerId: OWNER, noteId: NOTE, limit: 2 })
    ).resolves.toMatchObject({
      noteId: NOTE,
      currentRevision: 2,
      items: [{ fromNoteId: SOURCE_NOTE, fromNoteRevision: 3 }]
    });
    await expect(
      adapter.listBacklinks({ ownerId: OWNER, noteId: NOTE, limit: 2 })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("fails closed on unordered, duplicate, oversized, or ambiguous projections", async () => {
    const older = sourceRow({
      captureId: CAPTURE_B,
      mutationId: MUTATION_B,
      createdAt: "2026-09-01T19:00:00.000Z"
    });
    const malformed = [
      { noteId: NOTE, currentRevision: 1, items: [older, sourceRow()] },
      { noteId: NOTE, currentRevision: 1, items: [sourceRow(), sourceRow()] },
      {
        noteId: NOTE,
        currentRevision: 1,
        items: [sourceRow({ insertedItemIds: Array(501).fill("itm_01J6M9Q7G4BMKB33GSG3NJ6D1X") })]
      },
      { noteId: NOTE, currentRevision: 1, items: [sourceRow({ unexpected: true })] }
    ];
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const adapter = createNoteContextRpcAdapter({ rpc });

    for (const response of malformed) {
      rpc.mockResolvedValueOnce(response);
      await expect(
        adapter.listSources({ ownerId: OWNER, noteId: NOTE, limit: 2 })
      ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    }
  });

  it("rehydrates only owner-, resource-, revision-, and privacy-bound ciphertext", async () => {
    const malformed = [
      sourceRow({
        contentCipher: cipher(
          "capture",
          CAPTURE_A,
          1,
          "ai_assisted",
          "22222222-2222-4222-8222-222222222222"
        )
      }),
      sourceRow({ contentCipher: cipher("capture", CAPTURE_B, 1, "ai_assisted") }),
      sourceRow({ contentCipher: cipher("capture", CAPTURE_A, 2, "ai_assisted") }),
      sourceRow({ contentMac: mac("private_manual") }),
      backlinkRow({
        fromContentCipher: cipher("note_content", SOURCE_NOTE, 2, "private_manual")
      })
    ];
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const adapter = createNoteContextRpcAdapter({ rpc });

    for (const row of malformed.slice(0, 4)) {
      rpc.mockResolvedValueOnce({ noteId: NOTE, currentRevision: 1, items: [row] });
      await expect(
        adapter.listSources({ ownerId: OWNER, noteId: NOTE, limit: 1 })
      ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
    }
    rpc.mockResolvedValueOnce({ noteId: NOTE, currentRevision: 1, items: [malformed[4]] });
    await expect(
      adapter.listBacklinks({ ownerId: OWNER, noteId: NOTE, limit: 1 })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("rejects malformed owners, incomplete keysets, and cursors without a revision before RPC", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const adapter = createNoteContextRpcAdapter({ rpc });

    await expect(
      adapter.listSources({ ownerId: "not-an-owner", noteId: NOTE, limit: 1 })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    await expect(
      adapter.listSources({
        ownerId: OWNER,
        noteId: NOTE,
        limit: 1,
        after: {
          captureId: CAPTURE_A,
          mutationId: MUTATION_A,
          createdAt: "2026-09-01T20:00:00.000Z"
        }
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    expect(rpc).not.toHaveBeenCalled();
  });
});
